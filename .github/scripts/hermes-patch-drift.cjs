#!/usr/bin/env node
// Checks the carried Hermes patches (infra/hermes/patches.json) against a
// checkout of Hermes main, for .github/workflows/hermes-patches.yml.
//
//   check  --hermes <dir> --state <file> [--manifest <file>]
//          Newest version of each patch: applies, reverse-applies (obsolete),
//          and stacks in manifest order (a patch may build on earlier ones,
//          so applying on the stack is enough). Leaves the checkout untouched.
//   test   --hermes <dir> --state <file> --python <bin>
//          Runs the patch-relevant test files on the clean checkout, applies
//          the stack to it, and runs them again. Only failures absent from the
//          unpatched baseline count.
//   report --state <file> --body <file> [--run-url <url>]
//          Writes the drift issue body and the `drift` step output.
//
// The maintainer's resolver automation parses the issue body; keep
// `Hermes main:` and the `- \`<id>\`: \`<status>\`` lines stable.
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STATUSES = ["ok", "doesNotApply", "obsolete", "stackConflict", "testsFailed"];
// Run for every patch: the ACP adapter suite and the webhook close test cover
// the code paths T3 Code relies on even where a patch adds no test of its own.
const EXTRA_TEST_DIRS = ["tests/acp_adapter"];
const EXTRA_TEST_FILES = ["tests/gateway/test_webhook_session_close.py"];
const TEST_TIMEOUT_MS = 600_000;
const WHOLE_FILE = "(whole file: crashed or timed out)";

/** The newest version of each patch, in manifest (stack) order. */
function newestVersions(manifest, manifestDir) {
  if (!Array.isArray(manifest?.patches) || manifest.patches.length === 0) {
    throw new Error("patches.json has no patches");
  }
  return manifest.patches.map((patch) => {
    const newest = patch.versions?.[0];
    if (!newest?.file || !/^[0-9a-f]{40}$/.test(newest.hermesCommit ?? "")) {
      throw new Error(`${patch.id}: newest version needs a file and a 40-hex hermesCommit`);
    }
    return {
      id: patch.id,
      file: newest.file,
      path: path.resolve(manifestDir, newest.file),
      hermesCommit: newest.hermesCommit,
    };
  });
}

/** Test files a patch touches (`b/` side of each `diff --git` header). */
function patchTestFiles(patchText) {
  const files = [];
  for (const match of patchText.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)) {
    const file = match[1];
    if (/^tests\/(?:.+\/)?test_[^/]+\.py$/.test(file)) files.push(file);
  }
  return [...new Set(files)];
}

/** Every test file to run: each patch's own, plus the fixed extras present in the checkout. */
function allTestFiles(patches, hermesDir) {
  const files = new Set(patches.flatMap((patch) => patch.testFiles));
  for (const dir of EXTRA_TEST_DIRS) {
    const full = path.join(hermesDir, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (/^test_.*\.py$/.test(name)) files.add(`${dir}/${name}`);
    }
  }
  for (const file of EXTRA_TEST_FILES) files.add(file);
  return [...files].sort();
}

/**
 * Patches a failing test file is charged to: those that touch it, else those
 * touching a test in the same directory, else every patch (the stack ran as one).
 */
function ownersOfTestFile(file, patches) {
  const direct = patches.filter((patch) => patch.testFiles.includes(file));
  if (direct.length > 0) return direct.map((patch) => patch.id);
  const dir = path.posix.dirname(file);
  const sibling = patches.filter((patch) =>
    patch.testFiles.some((own) => path.posix.dirname(own) === dir),
  );
  return (sibling.length > 0 ? sibling : patches).map((patch) => patch.id);
}

/**
 * Failed and errored node ids from `pytest -rfE` output. A parametrized id's
 * brackets may hold spaces and ` - `, so they run to the `]` that ends the id:
 * the one followed by pytest's ` - ` message separator or the end of the line.
 */
function parsePytestFailures(output) {
  const ids = new Set();
  const line = /^(?:FAILED|ERROR) ([^\s[]+(?:\[.*?\](?= - |$))?)(?: - .*)?$/gm;
  for (const match of output.matchAll(line)) {
    ids.add(match[1]);
  }
  return [...ids].sort();
}

/**
 * One file's result: exit 0 passed, 1 tests failed, 5 nothing collected.
 * Anything else (a crash, a collection error, a timeout) fails the whole file.
 */
function fileResult({ status, output, missing = false }) {
  if (missing) return { missing: true, crashed: false, failures: [] };
  if (status === 0 || status === 5) return { missing: false, crashed: false, failures: [] };
  const failures = parsePytestFailures(output);
  if (status === 1 && failures.length > 0) return { missing: false, crashed: false, failures };
  return { missing: false, crashed: true, failures: [] };
}

/**
 * Failures the patches introduced in one file. A baseline crash hides the
 * file; a rerun, when present, keeps only failures that repeat (flakes drop out).
 */
function newFailures(baseline, patched, rerun) {
  if (!patched || baseline?.crashed) return [];
  const fresh = (result) => {
    if (result.crashed) return [WHOLE_FILE];
    const known = new Set(baseline?.failures ?? []);
    return result.failures.filter((id) => !known.has(id));
  };
  const first = fresh(patched);
  if (first.length === 0 || !rerun) return first;
  const again = fresh(rerun);
  // A file that broke in both runs stays broken, even when one run crashed
  // and the other named its failures: report the named ones.
  if (again.includes(WHOLE_FILE)) return first;
  if (first.includes(WHOLE_FILE)) return again;
  return first.filter((id) => again.includes(id));
}

/** Per-patch statuses from a state file written by `check` and `test`. */
function decide(state) {
  const failing = new Map(state.patches.map((patch) => [patch.id, []]));
  if (state.tests) {
    for (const file of state.testFiles) {
      const fresh = newFailures(
        state.tests.baseline[file],
        state.tests.patched[file],
        state.tests.rerun?.[file],
      );
      if (fresh.length === 0) continue;
      for (const id of ownersOfTestFile(file, state.patches)) failing.get(id).push(file);
    }
  }
  return state.patches.map((patch) => {
    let status = "ok";
    if (patch.reverse) status = "obsolete";
    // Applying on the patches before it is enough: it may build on them.
    else if (!patch.apply && !patch.stack) status = "doesNotApply";
    else if (patch.stack === false) status = "stackConflict";
    else if (failing.get(patch.id).length > 0) status = "testsFailed";
    return {
      id: patch.id,
      file: patch.file,
      status,
      behind: patch.behind,
      onMain: patch.onMain,
      failingTests: status === "testsFailed" ? failing.get(patch.id) : [],
    };
  });
}

/** The issue body. The maintainer's resolver automation parses it. */
function formatReport({ hermesSha, results, runUrl }) {
  const lines = [
    "The Hermes patches this fork carries no longer fit Hermes `main`.",
    "",
    `Hermes main: \`${hermesSha}\``,
    "",
    "Patch status:",
    "",
  ];
  for (const result of results) {
    const where = result.onMain
      ? `${result.behind} commits behind main`
      : "its commit is not on main";
    lines.push(
      `- \`${result.id}\`: \`${result.status}\` (newest version \`${result.file}\`, ${where})`,
    );
    for (const file of result.failingTests) lines.push(`  - \`${file}\``);
  }
  lines.push(
    "",
    "`doesNotApply`: the newest version applies neither alone nor on top of the patches listed",
    "before it. `obsolete`: it reverse-applies, so Hermes main already carries the change.",
    "`stackConflict`: it applies alone but not on top of the patches listed before it.",
    "`testsFailed`: the listed test files fail with every patch applied but not on unpatched main.",
    "",
    "Add a rebased version (see `infra/hermes/README.md`), or delete an obsolete patch.",
  );
  if (runUrl) lines.push("", `[Run log](${runUrl})`);
  return `${lines.join("\n")}\n`;
}

// I/O below; the pure functions above are covered by hermes-patch-drift.test.cjs.

function git(cwd, args, env = {}) {
  return childProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

function check({ hermes, state: statePath, manifest: manifestPath }) {
  const manifestFile = path.resolve(
    manifestPath ?? path.join(__dirname, "../../infra/hermes/patches.json"),
  );
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const hermesSha = git(hermes, ["rev-parse", "HEAD"]).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(hermesSha)) throw new Error(`${hermes} is not a git checkout`);
  const status = git(hermes, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim();
  if (status) throw new Error(`${hermes} has local changes; check needs a clean checkout`);

  const patches = newestVersions(manifest, path.dirname(manifestFile)).map((patch) => {
    const apply = git(hermes, ["apply", "--check", patch.path]);
    const reverse = git(hermes, ["apply", "--check", "-R", patch.path]);
    const onMain =
      git(hermes, ["merge-base", "--is-ancestor", patch.hermesCommit, "HEAD"]).status === 0;
    const behind = onMain
      ? Number(git(hermes, ["rev-list", "--count", `${patch.hermesCommit}..HEAD`]).stdout.trim())
      : null;
    console.log(
      `${patch.id}: apply=${apply.status === 0} reverse=${reverse.status === 0} onMain=${onMain} behind=${behind}`,
    );
    if (apply.status !== 0) console.log(apply.stderr.trim());
    return {
      ...patch,
      apply: apply.status === 0,
      reverse: reverse.status === 0,
      onMain,
      behind,
      stack: null,
      testFiles: patchTestFiles(fs.readFileSync(patch.path, "utf8")),
    };
  });

  // Stack in manifest order on a throwaway index, so the checkout stays clean
  // for the baseline test run. A patch that does not apply alone is stacked
  // too: it may build on the patches before it, such as one that edits a file
  // an earlier patch creates.
  const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-stack-")), "index");
  const env = { GIT_INDEX_FILE: index };
  if (git(hermes, ["read-tree", "HEAD"], env).status !== 0) throw new Error("git read-tree failed");
  for (const patch of patches) {
    if (patch.reverse) continue;
    const stacked = git(hermes, ["apply", "--cached", patch.path], env);
    patch.stack = stacked.status === 0;
    console.log(`${patch.id}: stack=${patch.stack}`);
    if (!patch.stack) console.log(stacked.stderr.trim());
  }
  fs.rmSync(path.dirname(index), { recursive: true, force: true });

  const applies = patches.every((patch) => !patch.reverse && patch.stack);
  const state = {
    hermesSha,
    patches,
    testFiles: allTestFiles(patches, hermes),
    tests: null,
  };
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  setOutput("hermes_sha", hermesSha);
  setOutput("applies", applies);
}

function runPytest(hermes, python, file) {
  return new Promise((resolve) => {
    if (!fs.existsSync(path.join(hermes, file))) {
      resolve(fileResult({ missing: true }));
      return;
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-"));
    const child = childProcess.spawn(
      python,
      ["-m", "pytest", "-q", "-p", "no:cacheprovider", "--no-header", "-rfE", file],
      {
        cwd: hermes,
        env: {
          ...process.env,
          HERMES_HOME: home,
          PYTHONDONTWRITEBYTECODE: "1",
          OPENROUTER_API_KEY: "",
          OPENAI_API_KEY: "",
          NOUS_API_KEY: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: TEST_TIMEOUT_MS,
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (status) => {
      fs.rmSync(home, { recursive: true, force: true });
      const result = fileResult({ status, output });
      const summary = output.trim().split("\n").at(-1) ?? "";
      console.log(`  ${file}: exit ${status} ${summary}`);
      if (result.crashed) console.log(output.slice(-4000));
      resolve(result);
    });
  });
}

async function runAll(hermes, python, files) {
  const results = {};
  const queue = [...files];
  const workers = Array.from({ length: Math.max(1, os.availableParallelism()) }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      results[file] = await runPytest(hermes, python, file);
    }
  });
  await Promise.all(workers);
  return results;
}

async function test({ hermes, state: statePath, python }) {
  // Hermes's tests/conftest.py fails any test touching a path below ~/.hermes,
  // which would read as drift. Refuse instead of reporting spurious failures.
  const realHome = path.join(os.homedir(), ".hermes") + path.sep;
  for (const [label, dir] of [
    ["--hermes", hermes],
    ["TMPDIR", os.tmpdir()],
  ]) {
    if ((path.resolve(dir) + path.sep).startsWith(realHome)) {
      throw new Error(`${label} (${dir}) is under ${realHome}; Hermes's tests refuse to run there`);
    }
  }
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  console.log("Baseline: unpatched Hermes main");
  const baseline = await runAll(hermes, python, state.testFiles);
  for (const patch of state.patches) {
    const applied = git(hermes, ["apply", patch.path]);
    if (applied.status !== 0) throw new Error(`${patch.id} did not apply: ${applied.stderr}`);
  }
  console.log("Patched: every newest version applied in manifest order");
  const patched = await runAll(hermes, python, state.testFiles);
  const suspects = state.testFiles.filter(
    (file) => newFailures(baseline[file], patched[file]).length > 0,
  );
  let rerun = {};
  if (suspects.length > 0) {
    console.log("Rerun: files with new failures, to drop flakes");
    rerun = await runAll(hermes, python, suspects);
  }
  state.tests = { baseline, patched, rerun };
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function report({ state: statePath, body, "run-url": runUrl }) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const results = decide(state);
  for (const result of results) console.log(`${result.id}: ${result.status}`);
  const drift = results.some((result) => result.status !== "ok");
  fs.writeFileSync(body, formatReport({ hermesSha: state.hermesSha, results, runUrl }));
  setOutput("drift", drift);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`bad argument ${argv[index]}`);
    }
    options[argv[index].slice(2)] = argv[index + 1];
  }
  return options;
}

if (require.main === module) {
  const [command, ...rest] = process.argv.slice(2);
  const commands = { check, test, report };
  if (!commands[command]) {
    console.error("usage: hermes-patch-drift.cjs check|test|report --option value ...");
    process.exit(2);
  }
  Promise.resolve(commands[command](parseArgs(rest))).catch((error) => {
    console.error(error.stack ?? error);
    process.exit(1);
  });
}

module.exports = {
  STATUSES,
  WHOLE_FILE,
  newestVersions,
  patchTestFiles,
  allTestFiles,
  ownersOfTestFile,
  parsePytestFailures,
  fileResult,
  newFailures,
  decide,
  formatReport,
};
