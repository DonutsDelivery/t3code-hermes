// The fork's release path may only ask for GitHub-hosted runners. A job that
// requests a label nothing here serves (upstream's Blacksmith pools) never
// fails: it queues for a day while release.yml's `queue: max` concurrency
// holds every later nightly behind it. Upstream moves jobs onto Blacksmith in
// merges that apply cleanly, so nothing else notices before a release hangs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const RELEASE_WORKFLOWS = [
  "release.yml",
  "release-desktop.yml",
  "mobile-ipa.yml",
  "mobile-apk.yml",
];
const HOSTED =
  /^(ubuntu-(latest|\d+\.\d+)(-arm)?|windows-(latest|\d{4}|11-arm)|macos-(latest|\d+))$/;
const UPSTREAM_ONLY = "github.repository == 'pingdotgg/t3code'";

/** `job: label` for each literal runner label a job the fork runs asks for. */
function forkRunnerLabels(workflow) {
  const jobs = workflow
    .slice(workflow.search(/^jobs:\s*$/m))
    .split(/^(?=  [\w-]+:\s*$)/m)
    .slice(1);
  return jobs.flatMap((block) => {
    const job = block.match(/^  ([\w-]+):/)[1];
    // A job skipped by its `if:` is never queued, whatever runner it names.
    const jobIf = block.match(/^    if:(.*(?:\n {5,}.*)*)/m)?.[1] ?? "";
    if (jobIf.includes(UPSTREAM_ONLY)) return [];
    return (
      [...block.matchAll(/^ +(?:runs-on|runner|verify_runner):(.*)$/gm)]
        .map((match) =>
          match[1]
            .replace(/\s+#.*$/, "")
            .trim()
            .replace(/^(["'])(.*)\1$/, "$2"),
        )
        // Expressions forward an input; the caller passing it is checked instead.
        .filter((label) => !label.includes("${{"))
        // An empty value is a block-form list or runner group, which is not hosted.
        .map((label) => `${job}: ${label || "(not a single label)"}`)
    );
  });
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
    runs-on: blacksmith-4vcpu-ubuntu-2404
  announce:
    if: |
      !cancelled() &&
      github.repository == 'pingdotgg/t3code'
    runs-on: blacksmith-2vcpu-ubuntu-2404
  bundle:
    if: \${{ !cancelled() }}
    runs-on: ubuntu-24.04-arm
    env:
      CHANNEL: \${{ github.repository == 'pingdotgg/t3code' && 'nightly' || 'dev' }}
  mac:
    runs-on: [self-hosted, macOS]
  grouped:
    runs-on:
      group: larger-runners
  reusable:
    runs-on: \${{ inputs.runner }}
`;
  assert.deepEqual(notHosted(forkRunnerLabels(workflow)), [
    "build: blacksmith-8vcpu-ubuntu-2404",
    "desktop: blacksmith-12vcpu-macos-26",
    "mac: [self-hosted, macOS]",
    "grouped: (not a single label)",
  ]);
});

test("release workflows only ask for GitHub-hosted runners", () => {
  const labels = RELEASE_WORKFLOWS.flatMap((file) =>
    forkRunnerLabels(fs.readFileSync(path.join(__dirname, "../workflows", file), "utf8")).map(
      (entry) => `${file} ${entry}`,
    ),
  );
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
