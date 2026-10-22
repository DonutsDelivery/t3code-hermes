// The fork's release path may only ask for GitHub-hosted runners. A job that
// requests a label nothing here serves (upstream's Blacksmith pools) never
// fails: it queues for a day while release.yml's `queue: max` concurrency
// holds every later nightly behind it. Upstream moves jobs onto Blacksmith in
// merges that apply cleanly, so nothing else notices before a release hangs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const HOSTED =
  /^(ubuntu-(latest|\d+\.\d+)(-arm)?|windows-(latest|\d{4}|11-arm)|macos-(latest|\d+))$/;
const UPSTREAM_ONLY = "github.repository == 'pingdotgg/t3code'";
const FORWARDED_INPUT = /^\$\{\{\s*inputs\.[\w-]+\s*\}\}$/;

/** Runner labels (`job: label`) and local reusable workflows of the jobs the fork runs. */
function forkJobs(workflow) {
  const blocks = workflow
    .slice(workflow.search(/^jobs:\s*$/m))
    .split(/^(?=  [\w-]+:\s*$)/m)
    .slice(1);
  const labels = [];
  const calls = [];
  for (const block of blocks) {
    const job = block.match(/^  ([\w-]+):/)[1];
    // A job its `if:` keeps off the fork is never queued, whatever runner it
    // names. Anything looser than a conjunction might still let the fork in.
    const jobIf = block.match(/^    if:(.*(?:\n {5,}.*)*)/m)?.[1] ?? "";
    if (jobIf.includes(UPSTREAM_ONLY) && !jobIf.includes("||")) continue;
    for (const [, value] of block.matchAll(/^ +(?:runs-on|runner|verify_runner):(.*)$/gm)) {
      const label = value
        .replace(/\s+#.*$/, "")
        .trim()
        .replace(/^(["'])(.*)\1$/, "$2");
      // Checked where the caller passes it. Any other expression fails below.
      if (FORWARDED_INPUT.test(label)) continue;
      // An empty value is a block-form list or runner group, which is not hosted.
      labels.push(`${job}: ${label || "(not a single label)"}`);
    }
    for (const [, file] of block.matchAll(/^    uses: \.\/\.github\/workflows\/([\w.-]+)\s*$/gm)) {
      calls.push(file);
    }
  }
  return { labels, calls };
}

/** Every workflow release.yml reaches on the fork, with its jobs' runner labels. */
function releasePath(read) {
  const files = [];
  const labels = [];
  const visit = (file) => {
    if (files.includes(file)) return;
    files.push(file);
    const jobs = forkJobs(read(file));
    labels.push(...jobs.labels.map((entry) => `${file} ${entry}`));
    jobs.calls.forEach(visit);
  };
  visit("release.yml");
  return { files, labels };
}

const notHosted = (labels) => labels.filter((entry) => !HOSTED.test(entry.split(": ")[1]));

test("flags runner labels the fork cannot serve, except in upstream-only jobs", () => {
  const workflow = `
on:
  workflow_call:
    inputs:
      runner:
        type: string
jobs:
  build:
    runs-on: blacksmith-8vcpu-ubuntu-2404
  publish:
    runs-on: ubuntu-24.04 # blacksmith-8vcpu-ubuntu-2404
  desktop:
    uses: ./.github/workflows/release-desktop.yml
    with:
      runner: blacksmith-12vcpu-macos-26
      verify_runner: windows-11-arm
  marketing:
    if: \${{ !cancelled() && github.repository == 'pingdotgg/t3code' }}
    uses: ./.github/workflows/publish-aur.yml
  announce:
    if: |
      !cancelled() &&
      github.repository == 'pingdotgg/t3code'
    runs-on: blacksmith-2vcpu-ubuntu-2404
  either:
    if: github.repository == 'pingdotgg/t3code' || inputs.force
    runs-on: blacksmith-4vcpu-ubuntu-2404
  bundle:
    if: \${{ !cancelled() }}
    runs-on: ubuntu-24.04-arm
    env:
      CHANNEL: \${{ github.repository == 'pingdotgg/t3code' && 'nightly' || 'dev' }}
  matrix:
    runs-on: \${{ matrix.os }}
  mac:
    runs-on: [self-hosted, macOS]
  grouped:
    runs-on:
      group: larger-runners
  reusable:
    runs-on: \${{ inputs.runner }}
`;
  const jobs = forkJobs(workflow);
  assert.deepEqual(notHosted(jobs.labels), [
    "build: blacksmith-8vcpu-ubuntu-2404",
    "desktop: blacksmith-12vcpu-macos-26",
    "either: blacksmith-4vcpu-ubuntu-2404",
    "matrix: ${{ matrix.os }}",
    "mac: [self-hosted, macOS]",
    "grouped: (not a single label)",
  ]);
  assert.deepEqual(jobs.calls, ["release-desktop.yml"]);
});

test("the release path only asks for GitHub-hosted runners", () => {
  const { files, labels } = releasePath((file) =>
    fs.readFileSync(path.join(__dirname, "../workflows", file), "utf8"),
  );
  for (const file of ["release-desktop.yml", "mobile-ipa.yml", "mobile-apk.yml"]) {
    assert.ok(files.includes(file), `release.yml no longer reaches ${file}; found ${files}`);
  }
  assert.ok(
    labels.length > 10,
    `expected the release path's runner labels, found ${labels.length}`,
  );
  assert.deepEqual(
    notHosted(labels),
    [],
    "Use a GitHub-hosted label (for example ubuntu-24.04) or guard the job to pingdotgg/t3code.",
  );
});
