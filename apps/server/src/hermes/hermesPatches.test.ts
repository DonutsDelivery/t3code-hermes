// @effect-diagnostics nodeBuiltinImport:off - builds fixture git repos synchronously.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HermesPatchId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { HERMES_PATCH_FILES } from "./hermesPatchFiles.generated.ts";
import {
  changeHermesPatch,
  HERMES_PATCHES,
  readHermesPatches,
  resolveHermesGitCheckout,
  type HermesPatchDefinition,
  type HermesPatchVersion,
} from "./hermesPatches.ts";

const INFRA_HERMES = NodePath.resolve(import.meta.dirname, "../../../../infra/hermes");

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });

const commit = (root: string, message: string) => {
  git(root, "add", ".");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD").trim();
};

/** The diff that rewrites `file` to `content` at the current HEAD, leaving the tree clean. */
const diffAt = (root: string, file: string, content: string, hermesCommit: string) => {
  const path = NodePath.join(root, file);
  const original = NodeFS.readFileSync(path, "utf8");
  NodeFS.writeFileSync(path, content);
  const version: HermesPatchVersion = {
    hermesCommit,
    hermesCommitDate: "2026-10-01T00:00:00Z",
    content: git(root, "diff"),
  };
  NodeFS.writeFileSync(path, original);
  return version;
};

const definition = (versions: ReadonlyArray<HermesPatchVersion>): HermesPatchDefinition => ({
  id: HermesPatchId.make("test-patch"),
  title: "Test",
  neededFor: "Tests.",
  versions,
});

/** A one-file repo on `main`, plus a patch that rewrites that file. */
const makeCheckout = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
  git(root, "init", "--quiet");
  NodeFS.writeFileSync(NodePath.join(root, "session.py"), "remote_cwd = None\n");
  const base = commit(root, "base");
  const patch = definition([diffAt(root, "session.py", "remote_cwd = configured()\n", base)]);
  return { root, patch };
});

/**
 * A repo with two Hermes commits that each need their own version of one
 * patch: upstream rewrote the line next to the patched one in between.
 */
const makeTwoVersionCheckout = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
  git(root, "init", "--quiet");
  const file = NodePath.join(root, "session.py");
  NodeFS.writeFileSync(file, "backend = local\nremote_cwd = None\n");
  const older = commit(root, "older");
  const olderVersion = diffAt(
    root,
    "session.py",
    "backend = local\nremote_cwd = configured()\n",
    older,
  );
  NodeFS.writeFileSync(file, "backend = resolve()\nremote_cwd = None\n");
  const newer = commit(root, "newer");
  const newerVersion = diffAt(
    root,
    "session.py",
    "backend = resolve()\nremote_cwd = configured()\n",
    newer,
  );
  return { root, file, older, newer, patch: definition([newerVersion, olderVersion]) };
});

const stateOf = (root: string, patch: HermesPatchDefinition) =>
  readHermesPatches(root, [patch]).pipe(Effect.map(([status]) => status?.state));

describe("hermes patches", () => {
  it("embeds every infra/hermes patch version the manifest lists, byte for byte", () => {
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(INFRA_HERMES, "patches.json"), "utf8"),
    ) as {
      patches: ReadonlyArray<{
        id: string;
        title: string;
        neededFor: string;
        versions: ReadonlyArray<{ hermesCommit: string; hermesCommitDate: string; file: string }>;
      }>;
    };
    const expected = manifest.patches.map((patch) => ({
      ...patch,
      versions: patch.versions.map((version) => ({
        ...version,
        content: NodeFS.readFileSync(NodePath.join(INFRA_HERMES, version.file), "utf8"),
      })),
    }));
    // Regenerate with `node scripts/generate-hermes-patches.ts`.
    assert.deepStrictEqual(HERMES_PATCH_FILES, expected);
    // A version saved under infra/hermes but left out of the manifest would
    // otherwise never ship, and nothing else in CI would say so.
    const onDisk = NodeFS.readdirSync(INFRA_HERMES, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".patch"))
      .map((file) => file.split(NodePath.sep).join("/"))
      .sort();
    assert.deepStrictEqual(
      onDisk,
      manifest.patches.flatMap((patch) => patch.versions.map((version) => version.file)).sort(),
    );
    assert.deepStrictEqual(
      HERMES_PATCHES.map((patch) => patch.id),
      manifest.patches.map((patch) => patch.id),
    );
  });

  it.effect("reads, applies, and removes a patch", () =>
    Effect.gen(function* () {
      const { root, patch } = yield* makeCheckout;

      assert.strictEqual(yield* stateOf(root, patch), "notApplied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "forward")).ok);
      assert.strictEqual(yield* stateOf(root, patch), "applied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(yield* stateOf(root, patch), "notApplied");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("applies the version made for the checkout's Hermes, older or newer", () =>
    Effect.gen(function* () {
      const { root, file, older, patch } = yield* makeTwoVersionCheckout;

      assert.strictEqual(yield* stateOf(root, patch), "notApplied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "forward")).ok);
      assert.strictEqual(
        NodeFS.readFileSync(file, "utf8"),
        "backend = resolve()\nremote_cwd = configured()\n",
      );
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);

      git(root, "checkout", "--quiet", older);
      assert.strictEqual(yield* stateOf(root, patch), "notApplied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "forward")).ok);
      assert.strictEqual(
        NodeFS.readFileSync(file, "utf8"),
        "backend = local\nremote_cwd = configured()\n",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads an applied older version as applied, and removes that version", () =>
    Effect.gen(function* () {
      const { root, file, older, patch } = yield* makeTwoVersionCheckout;
      git(root, "checkout", "--quiet", older);
      NodeFS.writeFileSync(file, "backend = local\nremote_cwd = configured()\n");

      assert.strictEqual(yield* stateOf(root, patch), "applied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), "backend = local\nremote_cwd = None\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the version applied when two versions patch to the same text", () =>
    Effect.gen(function* () {
      // Upstream rewrote the very line the patch replaces, so both versions
      // produce the same file and both reverse cleanly on either commit.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      NodeFS.writeFileSync(file, "a = 1\nremote_cwd = None\nb = 2\n");
      const older = commit(root, "older");
      const olderVersion = diffAt(
        root,
        "session.py",
        "a = 1\nremote_cwd = configured()\nb = 2\n",
        older,
      );
      NodeFS.writeFileSync(file, "a = 1\nremote_cwd = default()\nb = 2\n");
      const newer = commit(root, "newer");
      const newerVersion = diffAt(
        root,
        "session.py",
        "a = 1\nremote_cwd = configured()\nb = 2\n",
        newer,
      );
      const patch = definition([newerVersion, olderVersion]);

      git(root, "checkout", "--quiet", older);
      assert.isTrue((yield* changeHermesPatch(root, patch, "forward")).ok);
      assert.strictEqual(yield* stateOf(root, patch), "applied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), "a = 1\nremote_cwd = None\nb = 2\n");
      assert.strictEqual(git(root, "status", "--porcelain"), "");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the version applied when two fit HEAD at different places", () =>
    Effect.gen(function* () {
      // One block, three times over. The older version sets the first `v` to
      // 2, the newer one the second: once the older is applied both reverse
      // cleanly, and both apply to HEAD. Reversing the newer would turn the
      // first `v` into the second's original 3.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      const block = "k = 0\nk = 1\nk = 2\n";
      const lines = (first: string, second: string) =>
        `${block}v = ${first}\n${block}v = ${second}\n${block}`;
      NodeFS.writeFileSync(file, lines("1", "3"));
      const base = commit(root, "base");
      const olderVersion = diffAt(root, "session.py", lines("2", "3"), base);
      const newerVersion = diffAt(root, "session.py", lines("1", "2"), base);
      const patch = definition([newerVersion, olderVersion]);

      NodeFS.writeFileSync(file, lines("2", "3"));
      assert.strictEqual(yield* stateOf(root, patch), "applied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), lines("1", "3"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the applied version beside another patch in the same file", () =>
    Effect.gen(function* () {
      // As above, with a second patch applied further down the same file.
      // Its change is in the checkout but in no candidate's scratch tree, so
      // only once it is taken back out does the applied version match.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      const block = "k = 0\nk = 1\nk = 2\n";
      const padding = "p = 0\np = 1\np = 2\np = 3\n";
      const lines = (first: string, second: string, tail = "0") =>
        `${block}v = ${first}\n${block}v = ${second}\n${block}${padding}tail = ${tail}\n`;
      NodeFS.writeFileSync(file, lines("1", "3"));
      const base = commit(root, "base");
      const olderVersion = diffAt(root, "session.py", lines("2", "3"), base);
      const newerVersion = diffAt(root, "session.py", lines("1", "2"), base);
      const patch = definition([newerVersion, olderVersion]);
      const other: HermesPatchDefinition = {
        id: HermesPatchId.make("other-patch"),
        title: "Other",
        neededFor: "Tests.",
        versions: [diffAt(root, "session.py", lines("1", "3", "1"), base)],
      };

      NodeFS.writeFileSync(file, lines("2", "3", "1"));
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse", [patch, other])).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), lines("1", "3", "1"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the applied version beside another patch with versions of its own", () =>
    Effect.gen(function* () {
      // Both patches are built like the one above, in separate halves of one
      // file, and the older version of each is applied. Taking the other
      // patch out by its newer version would leave the wrong text behind.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      const half = (name: string, first: string, second: string) => {
        const block = `${name} = 0\n${name} = 1\n${name} = 2\n`;
        return `${block}${name}v = ${first}\n${block}${name}v = ${second}\n${block}`;
      };
      const padding = "p = 0\np = 1\np = 2\np = 3\n";
      const lines = (target: [string, string], other: [string, string]) =>
        `${half("k", ...target)}${padding}${half("q", ...other)}`;
      NodeFS.writeFileSync(file, lines(["1", "3"], ["1", "3"]));
      const base = commit(root, "base");
      const at = (target: [string, string], other: [string, string]) =>
        diffAt(root, "session.py", lines(target, other), base);
      const patch = definition([at(["1", "2"], ["1", "3"]), at(["2", "3"], ["1", "3"])]);
      const other: HermesPatchDefinition = {
        id: HermesPatchId.make("other-patch"),
        title: "Other",
        neededFor: "Tests.",
        versions: [at(["1", "3"], ["1", "2"]), at(["1", "3"], ["2", "3"])],
      };

      NodeFS.writeFileSync(file, lines(["2", "3"], ["2", "3"]));
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse", [patch, other])).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), lines(["1", "3"], ["2", "3"]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to remove when another patch could have made either change", () =>
    Effect.gen(function* () {
      // Two lines both changed. Each patch has one version per line, so
      // either patch could have made either change: nothing tells which
      // line is this patch's.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      const padding = Array.from({ length: 8 }, (_, index) => `p = ${index}\n`).join("");
      const lines = (x: string, y: string) => `x = ${x}\n${padding}y = ${y}\n`;
      NodeFS.writeFileSync(file, lines("0", "0"));
      const base = commit(root, "base");
      const onX = diffAt(root, "session.py", lines("1", "0"), base);
      const onY = diffAt(root, "session.py", lines("0", "1"), base);
      const patch = definition([onX, onY]);
      const other: HermesPatchDefinition = {
        id: HermesPatchId.make("other-patch"),
        title: "Other",
        neededFor: "Tests.",
        versions: [onY, onX],
      };

      NodeFS.writeFileSync(file, lines("1", "1"));
      assert.isFalse((yield* changeHermesPatch(root, patch, "reverse", [patch, other])).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), lines("1", "1"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores an edit in a file only another patch touches", () =>
    Effect.gen(function* () {
      // The two-places checkout again, plus another patch in its own file,
      // where the user has an unrelated edit.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      const elsewhere = NodePath.join(root, "gateway.py");
      const block = "k = 0\nk = 1\nk = 2\n";
      const lines = (first: string, second: string) =>
        `${block}v = ${first}\n${block}v = ${second}\n${block}`;
      NodeFS.writeFileSync(file, lines("1", "3"));
      NodeFS.writeFileSync(elsewhere, "gateway = 1\n");
      const base = commit(root, "base");
      const patch = definition([
        diffAt(root, "session.py", lines("1", "2"), base),
        diffAt(root, "session.py", lines("2", "3"), base),
      ]);
      const other: HermesPatchDefinition = {
        id: HermesPatchId.make("other-patch"),
        title: "Other",
        neededFor: "Tests.",
        versions: [diffAt(root, "gateway.py", "gateway = 2\n", base)],
      };

      NodeFS.writeFileSync(file, lines("2", "3"));
      NodeFS.writeFileSync(elsewhere, "gateway = mine\n");
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse", [patch, other])).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), lines("1", "3"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the applied version beside another patch upstream now carries", () =>
    Effect.gen(function* () {
      // The two-places checkout, with another patch in the same file whose
      // change is committed. It reverses too, but was never applied here.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      const block = "k = 0\nk = 1\nk = 2\n";
      const padding = "p = 0\np = 1\np = 2\np = 3\n";
      const lines = (first: string, second: string, tail = "0") =>
        `${block}v = ${first}\n${block}v = ${second}\n${block}${padding}tail = ${tail}\n`;
      NodeFS.writeFileSync(file, lines("1", "3"));
      const base = commit(root, "base");
      const other: HermesPatchDefinition = {
        id: HermesPatchId.make("other-patch"),
        title: "Other",
        neededFor: "Tests.",
        versions: [diffAt(root, "session.py", lines("1", "3", "1"), base)],
      };
      NodeFS.writeFileSync(file, lines("1", "3", "1"));
      const carried = commit(root, "upstream carries the other patch");
      const patch = definition([
        diffAt(root, "session.py", lines("1", "2", "1"), carried),
        diffAt(root, "session.py", lines("2", "3", "1"), carried),
      ]);

      NodeFS.writeFileSync(file, lines("2", "3", "1"));
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse", [patch, other])).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), lines("1", "3", "1"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores an edit in a file only another patch's unapplied version touches", () =>
    Effect.gen(function* () {
      // Another patch shares the file; its other version also touches a
      // second file, where the user has an unrelated edit.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      const elsewhere = NodePath.join(root, "gateway.py");
      const block = "k = 0\nk = 1\nk = 2\n";
      const padding = "p = 0\np = 1\np = 2\np = 3\n";
      const lines = (first: string, second: string, tail = "0") =>
        `${block}v = ${first}\n${block}v = ${second}\n${block}${padding}tail = ${tail}\n`;
      NodeFS.writeFileSync(file, lines("1", "3"));
      NodeFS.writeFileSync(elsewhere, "gateway = 1\n");
      const base = commit(root, "base");
      const patch = definition([
        diffAt(root, "session.py", lines("1", "2"), base),
        diffAt(root, "session.py", lines("2", "3"), base),
      ]);
      const onlyShared = diffAt(root, "session.py", lines("1", "3", "1"), base);
      NodeFS.writeFileSync(file, lines("1", "3", "1"));
      NodeFS.writeFileSync(elsewhere, "gateway = 2\n");
      const withGateway: HermesPatchVersion = { ...onlyShared, content: git(root, "diff") };
      git(root, "checkout", "--quiet", "--", ".");
      const other: HermesPatchDefinition = {
        id: HermesPatchId.make("other-patch"),
        title: "Other",
        neededFor: "Tests.",
        versions: [withGateway, onlyShared],
      };

      NodeFS.writeFileSync(file, lines("2", "3", "1"));
      NodeFS.writeFileSync(elsewhere, "gateway = mine\n");
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse", [patch, other])).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), lines("1", "3", "1"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes every file of the applied version when another touches fewer", () =>
    Effect.gen(function* () {
      // The older version changes two files, the newer only one of them the
      // same way: once the older is applied, both reverse cleanly.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const session = NodePath.join(root, "session.py");
      const config = NodePath.join(root, "config.py");
      NodeFS.writeFileSync(session, "remote_cwd = None\n");
      NodeFS.writeFileSync(config, "ssh = False\n");
      const base = commit(root, "base");
      NodeFS.writeFileSync(config, "ssh = True\n");
      const olderVersion = diffAt(root, "session.py", "remote_cwd = configured()\n", base);
      NodeFS.writeFileSync(config, "ssh = False\n");
      const newerVersion = diffAt(root, "session.py", "remote_cwd = configured()\n", base);
      const patch = definition([newerVersion, olderVersion]);

      NodeFS.writeFileSync(session, "remote_cwd = configured()\n");
      NodeFS.writeFileSync(config, "ssh = True\n");
      assert.strictEqual(yield* stateOf(root, patch), "applied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(git(root, "status", "--porcelain"), "");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("applies the version made for this checkout when an older one also fits", () =>
    Effect.gen(function* () {
      // Both versions apply to the older commit, at different `v`s; only the
      // older one was made for it.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      const block = "k = 0\nk = 1\nk = 2\n";
      const lines = (first: string, second: string) =>
        `${block}v = ${first}\n${block}v = ${second}\n${block}`;
      NodeFS.writeFileSync(file, lines("1", "3"));
      const older = commit(root, "older");
      const olderVersion = diffAt(root, "session.py", lines("2", "3"), older);
      NodeFS.writeFileSync(NodePath.join(root, "notes.txt"), "newer\n");
      const newer = commit(root, "newer");
      const newerVersion = diffAt(root, "session.py", lines("1", "2"), newer);
      const patch = definition([newerVersion, olderVersion]);

      git(root, "checkout", "--quiet", older);
      assert.strictEqual(yield* stateOf(root, patch), "notApplied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "forward")).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), lines("2", "3"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to guess which version to apply when nothing tells them apart", () =>
    Effect.gen(function* () {
      // Neither version's commit is in this history, and they change
      // different lines.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      const block = "k = 0\nk = 1\nk = 2\n";
      const lines = (first: string, second: string) =>
        `${block}v = ${first}\n${block}v = ${second}\n${block}`;
      NodeFS.writeFileSync(file, lines("1", "3"));
      const base = commit(root, "base");
      const unknown = (version: HermesPatchVersion): HermesPatchVersion => ({
        ...version,
        hermesCommit: "0123456789abcdef0123456789abcdef01234567",
      });
      const patch = definition([
        unknown(diffAt(root, "session.py", lines("1", "2"), base)),
        unknown(diffAt(root, "session.py", lines("2", "3"), base)),
      ]);

      assert.strictEqual(yield* stateOf(root, patch), "notApplied");
      assert.isFalse((yield* changeHermesPatch(root, patch, "forward")).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), lines("1", "3"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("restores the renamed file of the applied version", () =>
    Effect.gen(function* () {
      // Each version renames a different file to the same name, with the same
      // content: only the source path tells them apart.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      NodeFS.writeFileSync(NodePath.join(root, "old_a.py"), "same = 1\n");
      NodeFS.writeFileSync(NodePath.join(root, "old_b.py"), "same = 1\n");
      const base = commit(root, "base");
      const renameVersion = (from: string): HermesPatchVersion => {
        git(root, "mv", from, "session.py");
        const content = git(root, "diff", "--cached", "-M", "HEAD");
        git(root, "reset", "--quiet", "--hard", base);
        return { hermesCommit: base, hermesCommitDate: "2026-10-01T00:00:00Z", content };
      };
      const newerVersion = renameVersion("old_b.py");
      const olderVersion = renameVersion("old_a.py");
      const patch = definition([newerVersion, olderVersion]);

      git(root, "mv", "old_a.py", "session.py");
      git(root, "reset", "--quiet");
      assert.strictEqual(yield* stateOf(root, patch), "applied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.isTrue(NodeFS.existsSync(NodePath.join(root, "old_a.py")));
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, "session.py")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes a file the applied version added", () =>
    Effect.gen(function* () {
      // The older version also adds a file, which `git apply` leaves
      // untracked; the newer changes only the tracked one, the same way.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const session = NodePath.join(root, "session.py");
      const added = NodePath.join(root, "helper.py");
      NodeFS.writeFileSync(session, "remote_cwd = None\n");
      const base = commit(root, "base");
      const newerVersion = diffAt(root, "session.py", "remote_cwd = configured()\n", base);
      NodeFS.writeFileSync(added, "def helper(): pass\n");
      git(root, "add", "--intent-to-add", "helper.py");
      const olderVersion = diffAt(root, "session.py", "remote_cwd = configured()\n", base);
      git(root, "rm", "--quiet", "--cached", "helper.py");
      NodeFS.rmSync(added);
      const patch = definition([newerVersion, olderVersion]);

      NodeFS.writeFileSync(NodePath.join(root, "older.patch"), olderVersion.content);
      git(root, "apply", "older.patch");
      NodeFS.rmSync(NodePath.join(root, "older.patch"));
      assert.isTrue(NodeFS.existsSync(added));
      assert.strictEqual(yield* stateOf(root, patch), "applied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.isFalse(NodeFS.existsSync(added));
      assert.strictEqual(git(root, "status", "--porcelain"), "");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not remove from a clean checkout the patch fits both ways", () =>
    Effect.gen(function* () {
      // HEAD has the patch's before text in one block and its after text in
      // another, so it applies and reverses, though nothing was applied.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      // Lines in front keep the hunk off the start of the file, where git
      // would pin it.
      const lead = "a\nb\nc\nd\n";
      const block = "k = 0\nk = 1\nk = 2\n";
      const lines = (first: string, second: string) =>
        `${lead}${block}v = ${first}\n${block}v = ${second}\n${block}`;
      NodeFS.writeFileSync(file, lines("1", "1"));
      const base = commit(root, "base");
      const patch = definition([diffAt(root, "session.py", lines("2", "1"), base)]);
      NodeFS.writeFileSync(file, lines("1", "2"));
      commit(root, "upstream writes the after text elsewhere");

      assert.isFalse((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), lines("1", "2"));

      // An unrelated edit in the same file changes nothing.
      const edited = lines("1", "2").replace("a\n", "mine\n");
      NodeFS.writeFileSync(file, edited);
      assert.isFalse((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), edited);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes a lone version beside the user's own edit in the same file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      const padding = Array.from({ length: 8 }, (_, index) => `p = ${index}\n`).join("");
      const lines = (patched: string, mine: string) =>
        `remote_cwd = ${patched}\n${padding}user = ${mine}\n`;
      NodeFS.writeFileSync(file, lines("None", "0"));
      const base = commit(root, "base");
      const patch = definition([diffAt(root, "session.py", lines("configured()", "0"), base)]);

      NodeFS.writeFileSync(file, lines("configured()", "mine"));
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), lines("None", "mine"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not remove a change upstream now carries", () =>
    Effect.gen(function* () {
      const { root, patch } = yield* makeCheckout;
      const file = NodePath.join(root, "session.py");
      NodeFS.writeFileSync(file, "remote_cwd = configured()\n");
      commit(root, "upstream carries it");

      assert.isFalse((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), "remote_cwd = configured()\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to guess which version to remove once it is committed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      NodeFS.writeFileSync(file, "a = 1\nremote_cwd = None\nb = 2\n");
      const older = commit(root, "older");
      const patched = "a = 1\nremote_cwd = configured()\nb = 2\n";
      const olderVersion = diffAt(root, "session.py", patched, older);
      NodeFS.writeFileSync(file, "a = 1\nremote_cwd = default()\nb = 2\n");
      const newer = commit(root, "newer");
      const patch = definition([diffAt(root, "session.py", patched, newer), olderVersion]);

      git(root, "checkout", "--quiet", older);
      NodeFS.writeFileSync(file, patched);
      commit(root, "patched by hand");
      assert.strictEqual(yield* stateOf(root, patch), "applied");
      assert.isFalse((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), patched);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a checkout no version fits as not applying, and leaves it alone", () =>
    Effect.gen(function* () {
      const { root, file, patch } = yield* makeTwoVersionCheckout;
      NodeFS.writeFileSync(file, "backend = remote()\nremote_cwd = rewritten()\n");

      assert.strictEqual(yield* stateOf(root, patch), "doesNotApply");
      assert.isFalse((yield* changeHermesPatch(root, patch, "forward")).ok);
      assert.isFalse((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(
        NodeFS.readFileSync(file, "utf8"),
        "backend = remote()\nremote_cwd = rewritten()\n",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a patch the checkout has drifted away from as not applying", () =>
    Effect.gen(function* () {
      const { root, patch } = yield* makeCheckout;
      NodeFS.writeFileSync(NodePath.join(root, "session.py"), "remote_cwd = rewritten()\n");

      assert.strictEqual(yield* stateOf(root, patch), "doesNotApply");
      const refused = yield* changeHermesPatch(root, patch, "forward");
      assert.isFalse(refused.ok);
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(root, "session.py"), "utf8"),
        "remote_cwd = rewritten()\n",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the Hermes checkout even when git bindings point elsewhere", () =>
    Effect.gen(function* () {
      const { root, patch } = yield* makeCheckout;
      const decoy = yield* makeCheckout;
      // Already patched, so reading the decoy instead would say "applied".
      NodeFS.writeFileSync(NodePath.join(decoy.root, "session.py"), "remote_cwd = configured()\n");
      const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
      process.env.GIT_DIR = NodePath.join(decoy.root, ".git");
      process.env.GIT_WORK_TREE = decoy.root;
      const restore = Effect.sync(() => {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      });

      const [status] = yield* readHermesPatches(root, [patch]).pipe(Effect.ensuring(restore));
      assert.strictEqual(status?.state, "notApplied");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds the checkout only for a venv binary beside a .git", () =>
    Effect.gen(function* () {
      const { root } = yield* makeCheckout;
      const binary = NodePath.join(root, "venv", "bin", "hermes");
      assert.strictEqual(yield* resolveHermesGitCheckout(binary), root);
      assert.isNull(yield* resolveHermesGitCheckout("/usr/bin/hermes"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("follows the launcher the installer puts on PATH into the checkout", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { root } = yield* makeCheckout;
      const inner = NodePath.join(root, ".hermes", "bin", "hermes");
      NodeFS.mkdirSync(NodePath.dirname(inner), { recursive: true });
      NodeFS.writeFileSync(inner, "#!/bin/sh\nexec /usr/bin/python3 -I -c 'import x' \"$@\"\n");
      const bin = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-bin-" });
      const launcher = NodePath.join(bin, "local", "bin", "hermes");
      NodeFS.mkdirSync(NodePath.dirname(launcher), { recursive: true });
      NodeFS.writeFileSync(launcher, `#!/bin/sh\nexec ${inner} "$@"\n`);
      assert.strictEqual(yield* resolveHermesGitCheckout(launcher), NodeFS.realpathSync(root));

      // A pip console script imports Hermes from site-packages: no checkout.
      NodeFS.writeFileSync(launcher, "#!/usr/bin/python3\nfrom hermes_cli.main import main\n");
      assert.isNull(yield* resolveHermesGitCheckout(launcher));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
