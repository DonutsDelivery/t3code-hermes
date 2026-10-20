// @effect-diagnostics nodeBuiltinImport:off - builds fixture git repos synchronously.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HermesPatchId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import { providerUpdateLock } from "../provider/providerMaintenanceCommandCoordinator.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  HERMES_UPDATE_LOCK_KEY,
  type HermesPatchDefinition,
  type HermesPatchVersion,
} from "./hermesPatches.ts";
import { HermesPatchService, makeWith } from "./HermesPatchService.ts";

const IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@t"];

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });

const commit = (root: string, message: string, date: string) => {
  git(root, "add", ".");
  NodeChildProcess.execFileSync("git", [...IDENTITY, "commit", "--quiet", "-m", message], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return git(root, "rev-parse", "HEAD").trim();
};

/** The diff that rewrites `file` to `content` at the current HEAD, leaving the tree clean. */
const versionAt = (
  root: string,
  file: string,
  content: string,
  hermesCommit: string,
  date: string,
) => {
  const path = NodePath.join(root, file);
  const original = NodeFS.readFileSync(path, "utf8");
  NodeFS.writeFileSync(path, content);
  const version: HermesPatchVersion = {
    hermesCommit,
    hermesCommitDate: date,
    content: git(root, "diff"),
  };
  NodeFS.writeFileSync(path, original);
  return version;
};

const OLDER_DATE = "2026-09-01T00:00:00Z";
const NEWER_DATE = "2026-09-15T00:00:00Z";
const NEWEST_DATE = "2026-09-30T00:00:00Z";

/**
 * A Hermes stand-in: an upstream bare repo with two commits (upstream rewrote
 * the line next to the patched one in between), and a checkout cloned from it
 * sitting at the older commit. Its `venv/bin/hermes` handles `update` with a
 * `git pull --rebase`, which carries any local commit along as `hermes update`
 * does. `newerVersion` is the patch
 * version made for the newer commit, `olderVersion` the one for the older.
 */
const CURRENT_UPDATE_HELP =
  "usage: hermes update [-h] [--yes] [--keep-stash] [--no-gateway-restart]";

const makeHermesWith = (options: { readonly updateHelp: string }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-update-" });
    const seed = NodePath.join(base, "seed");
    const upstream = NodePath.join(base, "upstream.git");
    const root = NodePath.join(base, "hermes-agent");
    NodeFS.mkdirSync(seed);
    git(seed, "init", "--quiet", "--initial-branch=main");
    NodeFS.writeFileSync(NodePath.join(seed, ".gitignore"), "venv/\n");
    NodeFS.writeFileSync(NodePath.join(seed, "session.py"), "backend = local\nremote_cwd = None\n");
    NodeFS.writeFileSync(NodePath.join(seed, "notes.txt"), "notes\n");
    const older = commit(seed, "older", OLDER_DATE);
    const olderVersion = versionAt(
      seed,
      "session.py",
      "backend = local\nremote_cwd = configured()\n",
      older,
      OLDER_DATE,
    );
    NodeFS.writeFileSync(
      NodePath.join(seed, "session.py"),
      "backend = resolve()\nremote_cwd = None\n",
    );
    const newer = commit(seed, "newer", NEWER_DATE);
    const newerVersion = versionAt(
      seed,
      "session.py",
      "backend = resolve()\nremote_cwd = configured()\n",
      newer,
      NEWER_DATE,
    );
    git(base, "clone", "--quiet", "--bare", seed, upstream);
    git(base, "clone", "--quiet", upstream, root);
    git(root, "reset", "--quiet", "--hard", older);

    const binaryPath = NodePath.join(root, "venv", "bin", "hermes");
    NodeFS.mkdirSync(NodePath.dirname(binaryPath), { recursive: true });
    const log = NodePath.join(base, "hermes.log");
    NodeFS.writeFileSync(
      binaryPath,
      [
        "#!/bin/sh",
        `if [ "$2" = "--help" ] && [ -f "${NodePath.join(base, "help-hangs")}" ]; then exec sleep 60; fi`,
        `if [ "$2" = "--help" ]; then echo "${options.updateHelp}"; exit 0; fi`,
        `echo "$@" >> "${log}"`,
        // Signals through a FIFO that the update is underway, then hangs.
        `if [ -p "${NodePath.join(base, "started")}" ]; then echo started > "${NodePath.join(base, "started")}"; exec sleep 60; fi`,
        `if [ -f "${NodePath.join(base, "noisy")}" ]; then yes "resolving dependency" | head -c 2000000 >&2; fi`,
        `if [ -f "${NodePath.join(base, "fail")}" ]; then echo "network unreachable" >&2; exit 1; fi`,
        // A release channel lands detached at the release commit.
        `if [ -f "${NodePath.join(base, "release")}" ]; then cd "${root}" && git fetch --quiet && exec git checkout --quiet --detach origin/main; fi`,
        // Rebases, as a local commit on top of Hermes would be carried along.
        `cd "${root}" && git -c user.name=t -c user.email=t@t pull --quiet --rebase`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const patch = (versions: ReadonlyArray<HermesPatchVersion>): HermesPatchDefinition => ({
      id: HermesPatchId.make("remote-cwd"),
      title: "Remote cwd",
      neededFor: "Tests.",
      versions,
    });
    return {
      base,
      seed,
      upstream,
      root,
      binaryPath,
      log,
      older,
      newer,
      olderVersion,
      newerVersion,
      patch,
      read: () => NodeFS.readFileSync(NodePath.join(root, "session.py"), "utf8"),
      head: () => git(root, "rev-parse", "HEAD").trim(),
      /** Pushes a third upstream commit that rewrites the patched line itself. */
      pushNewest: () => {
        git(seed, "reset", "--quiet", "--hard", newer);
        NodeFS.writeFileSync(
          NodePath.join(seed, "session.py"),
          "backend = resolve()\nremote_cwd = from_profile()\n",
        );
        commit(seed, "newest", NEWEST_DATE);
        git(seed, "push", "--quiet", upstream, "main");
      },
    };
  });

const makeHermes = makeHermesWith({ updateHelp: CURRENT_UPDATE_HELP });

const withService = (
  binaryPath: string,
  patches: ReadonlyArray<HermesPatchDefinition>,
  options: { readonly updateTimeout?: Duration.Input } = {},
) =>
  Effect.provide(
    Layer.effect(HermesPatchService, makeWith({ patches, ...options })).pipe(
      Layer.provide(
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("hermes")]: {
              driver: ProviderDriverKind.make("hermes"),
              enabled: true,
              config: { binaryPath },
            },
          },
        }),
      ),
      Layer.provideMerge(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );

const stateOf = (service: HermesPatchService["Service"]) =>
  service.list.pipe(Effect.map((snapshot) => snapshot.patches[0]));

describe("HermesPatchService.updateHermes", () => {
  it.effect("removes the patch, updates Hermes, and reapplies the version for the new HEAD", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: patch.id });
        assert.strictEqual(hermes.read(), "backend = local\nremote_cwd = configured()\n");

        const before = yield* service.list;
        assert.isTrue(before.canUpdateHermes);
        assert.strictEqual(
          before.headCommit,
          git(hermes.root, "rev-parse", "--short", "HEAD").trim(),
        );

        const result = yield* service.updateHermes;
        assert.isFalse(result.updateFailed);
        assert.deepStrictEqual(result.reapplied, [patch.id]);
        assert.deepStrictEqual(result.awaitingPatchUpdate, []);
        assert.strictEqual(hermes.head(), hermes.newer);
        assert.strictEqual(hermes.read(), "backend = resolve()\nremote_cwd = configured()\n");
        assert.strictEqual(result.snapshot.patches[0]?.state, "applied");
        assert.notStrictEqual(result.previousHeadCommit, result.snapshot.headCommit);
        assert.strictEqual(
          NodeFS.readFileSync(hermes.log, "utf8").trim(),
          "update --yes --keep-stash --no-gateway-restart",
        );
        // Nothing parked: the patch was off the tree while Hermes updated.
        assert.strictEqual(git(hermes.root, "stash", "list"), "");
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("updates past a patch whose change is already committed", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      // Another patch, committed to the checkout by hand; nothing removes it.
      const committed: HermesPatchDefinition = {
        id: HermesPatchId.make("committed"),
        title: "Committed",
        neededFor: "Tests.",
        versions: [
          versionAt(hermes.root, "notes.txt", "notes, patched\n", hermes.older, OLDER_DATE),
        ],
      };
      NodeFS.writeFileSync(NodePath.join(hermes.root, "notes.txt"), "notes, patched\n");
      commit(hermes.root, "carry the patch", OLDER_DATE);
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: patch.id });
        const result = yield* service.updateHermes;
        assert.isFalse(result.updateFailed);
        assert.deepStrictEqual(result.reapplied, [patch.id]);
        assert.strictEqual(hermes.read(), "backend = resolve()\nremote_cwd = configured()\n");
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(hermes.root, "notes.txt"), "utf8"),
          "notes, patched\n",
        );
      }).pipe(withService(hermes.binaryPath, [committed, patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves out update flags an older Hermes does not know", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermesWith({ updateHelp: "usage: hermes update [-h] [--yes]" });
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: patch.id });
        const result = yield* service.updateHermes;
        assert.isFalse(result.updateFailed);
        assert.deepStrictEqual(result.reapplied, [patch.id]);
        assert.strictEqual(NodeFS.readFileSync(hermes.log, "utf8").trim(), "update --yes");
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a patch no version fits after the update as awaiting a T3 Code update", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      hermes.pushNewest();
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: patch.id });

        const result = yield* service.updateHermes;
        assert.isFalse(result.updateFailed);
        assert.deepStrictEqual(result.reapplied, []);
        assert.deepStrictEqual(result.awaitingPatchUpdate, [patch.id]);
        assert.strictEqual(hermes.read(), "backend = resolve()\nremote_cwd = from_profile()\n");
        assert.strictEqual(result.snapshot.patches[0]?.state, "doesNotApply");
        assert.strictEqual(result.snapshot.patches[0]?.reason, "awaitingPatchUpdate");
        assert.strictEqual(git(hermes.root, "status", "--porcelain"), "");
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses while the checkout has edits of the user's own, and changes nothing", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: patch.id });
        NodeFS.writeFileSync(NodePath.join(hermes.root, "notes.txt"), "my notes\n");

        const error = yield* Effect.flip(service.updateHermes);
        assert.strictEqual(error.reason, "wrongState");
        assert.include(error.detail, "notes.txt");
        assert.isFalse(NodeFS.existsSync(hermes.log));
        assert.strictEqual(hermes.head(), hermes.older);
        assert.strictEqual(hermes.read(), "backend = local\nremote_cwd = configured()\n");
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(hermes.root, "notes.txt"), "utf8"),
          "my notes\n",
        );
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses on a user's own edit inside a patched file, and puts the patch back", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: patch.id });
        const edited = "backend = local\nremote_cwd = configured()\n# mine\n";
        NodeFS.writeFileSync(NodePath.join(hermes.root, "session.py"), edited);

        const error = yield* Effect.flip(service.updateHermes);
        assert.strictEqual(error.reason, "wrongState");
        assert.isFalse(NodeFS.existsSync(hermes.log));
        assert.strictEqual(hermes.read(), edited);
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("waits for a provider update from Settings, which holds the same lock", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        const settingsUpdate = yield* Deferred.make<void>();
        const held = yield* Deferred.make<void>();
        // Stands in for ProviderMaintenanceRunner holding the lock mid-update.
        const holder = yield* providerUpdateLock(HERMES_UPDATE_LOCK_KEY)
          .withPermits(1)(
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(settingsUpdate))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(held);
        const apply = yield* service.apply({ patchId: patch.id }).pipe(Effect.forkChild);
        // The apply's own git reads happen inside the lock, so nothing it does
        // can land before the holder lets go.
        yield* Effect.yieldNow;
        assert.isUndefined(apply.pollUnsafe());
        assert.strictEqual(hermes.read(), "backend = local\nremote_cwd = None\n");

        yield* Deferred.succeed(settingsUpdate, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(apply);
        assert.strictEqual(hermes.read(), "backend = local\nremote_cwd = configured()\n");
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("restores the patches when the update fails, and reports the failure", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      NodeFS.writeFileSync(NodePath.join(hermes.base, "fail"), "");
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: patch.id });

        const result = yield* service.updateHermes;
        assert.isTrue(result.updateFailed);
        assert.include(result.failureOutput ?? "", "network unreachable");
        assert.deepStrictEqual(result.reapplied, [patch.id]);
        assert.strictEqual(hermes.head(), hermes.older);
        assert.strictEqual(hermes.read(), "backend = local\nremote_cwd = configured()\n");
        assert.strictEqual(result.snapshot.patches[0]?.state, "applied");
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps only the end of a long failed update's output", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      NodeFS.writeFileSync(NodePath.join(hermes.base, "noisy"), "");
      NodeFS.writeFileSync(NodePath.join(hermes.base, "fail"), "");
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        const result = yield* service.updateHermes;
        assert.isTrue(result.updateFailed);
        const output = result.failureOutput ?? "";
        assert.isTrue(output.trimEnd().endsWith("network unreachable"));
        assert.isBelow(output.length, 4_000);
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("puts the patches back when the request is interrupted mid-update", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      const started = NodePath.join(hermes.base, "started");
      NodeChildProcess.execFileSync("mkfifo", [started]);
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: patch.id });
        const patched = hermes.read();

        // Provider snapshots re-probe on this stream, even after an interrupt.
        const changed = yield* service.changes.pipe(
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild,
        );
        const update = yield* service.updateHermes.pipe(Effect.forkChild);
        // Resolves once the fake `hermes update` is running, patches off.
        yield* Effect.promise(() => NodeFSP.readFile(started, "utf8"));
        assert.strictEqual(hermes.read(), "backend = local\nremote_cwd = None\n");
        yield* Fiber.interrupt(update);

        assert.strictEqual(hermes.read(), patched);
        assert.strictEqual(hermes.head(), hermes.older);
        yield* Fiber.join(changed);
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("gives up on an update whose help probe hangs, and puts the patches back", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      NodeFS.writeFileSync(NodePath.join(hermes.base, "help-hangs"), "");
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: patch.id });
        const patched = hermes.read();
        const result = yield* service.updateHermes;
        assert.isTrue(result.updateFailed);
        assert.include(result.failureOutput ?? "", "did not finish in time");
        assert.strictEqual(hermes.read(), patched);
        assert.isFalse(NodeFS.existsSync(hermes.log));
      }).pipe(withService(hermes.binaryPath, [patch], { updateTimeout: "1 second" }));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("updates a detached HEAD, which hermes update moves itself", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      git(hermes.root, "checkout", "--quiet", "--detach");
      NodeFS.writeFileSync(NodePath.join(hermes.base, "release"), "");
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: patch.id });
        const before = yield* service.list;
        assert.isTrue(before.canUpdateHermes);
        assert.isFalse(before.detachedHead);

        const result = yield* service.updateHermes;
        assert.isFalse(result.updateFailed);
        assert.deepStrictEqual(result.reapplied, [patch.id]);
        assert.strictEqual(hermes.head(), hermes.newer);
        assert.strictEqual(hermes.read(), "backend = resolve()\nremote_cwd = configured()\n");
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("why a Hermes patch does not apply", () => {
  it.effect("says Hermes is too old when HEAD is an ancestor of the newest version's commit", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      // Only the newer version ships, so the older checkout cannot take it.
      const patch = hermes.patch([hermes.newerVersion]);
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        const status = yield* stateOf(service);
        assert.strictEqual(status?.state, "doesNotApply");
        assert.strictEqual(status?.reason, "hermesTooOld");
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("says Hermes is too old under a newer local commit on an older base", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion]);
      // A local commit, dated after the version's, on the older upstream base.
      NodeFS.writeFileSync(NodePath.join(hermes.root, "notes.txt"), "mine\n");
      commit(hermes.root, "local", "2026-10-01T00:00:00Z");
      yield* Effect.gen(function* () {
        const status = yield* stateOf(yield* HermesPatchService);
        assert.strictEqual(status?.state, "doesNotApply");
        assert.strictEqual(status?.reason, "hermesTooOld");
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to commit dates when the version's commit was never fetched", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const unfetched = (date: string): HermesPatchVersion => ({
        ...hermes.newerVersion,
        hermesCommit: "0123456789abcdef0123456789abcdef01234567",
        hermesCommitDate: date,
      });
      // The newer version's content does not fit the older checkout.
      const later = hermes.patch([unfetched("2026-09-20T00:00:00Z")]);
      const earlier = hermes.patch([unfetched("2026-08-01T00:00:00Z")]);
      yield* Effect.gen(function* () {
        assert.strictEqual((yield* stateOf(yield* HermesPatchService))?.reason, "hermesTooOld");
      }).pipe(withService(hermes.binaryPath, [later]));
      yield* Effect.gen(function* () {
        assert.strictEqual(
          (yield* stateOf(yield* HermesPatchService))?.reason,
          "awaitingPatchUpdate",
        );
      }).pipe(withService(hermes.binaryPath, [earlier]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("says a T3 Code update is needed once Hermes has moved past every version", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      hermes.pushNewest();
      git(hermes.root, "pull", "--quiet", "--ff-only");
      yield* Effect.gen(function* () {
        const status = yield* stateOf(yield* HermesPatchService);
        assert.strictEqual(status?.state, "doesNotApply");
        assert.strictEqual(status?.reason, "awaitingPatchUpdate");
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("blames local edits in the patched files before either update", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion]);
      NodeFS.writeFileSync(
        NodePath.join(hermes.root, "session.py"),
        "backend = mine\nremote_cwd = None\n",
      );
      yield* Effect.gen(function* () {
        const status = yield* stateOf(yield* HermesPatchService);
        assert.strictEqual(status?.state, "doesNotApply");
        assert.strictEqual(status?.reason, "localChanges");
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("blames the user's own edit in a file an applied patch also changed", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      // A file long enough that the two patches' hunks do not share context:
      // the other patch rewrites the first line, ours the last, and the user
      // edits the line just above ours.
      const lines = Array.from({ length: 12 }, (_, index) => `line_${index} = ${index}`);
      const file = NodePath.join(hermes.root, "config.py");
      NodeFS.writeFileSync(file, `${lines.join("\n")}\n`);
      const head = commit(hermes.root, "config", NEWER_DATE);
      const withLine = (index: number, text: string, from = lines) =>
        `${from.map((line, at) => (at === index ? text : line)).join("\n")}\n`;
      const version = (content: string) =>
        versionAt(hermes.root, "config.py", content, head, NEWER_DATE);
      const other: HermesPatchDefinition = {
        id: HermesPatchId.make("other"),
        title: "Other",
        neededFor: "Tests.",
        versions: [version(withLine(0, "line_0 = patched"))],
      };
      const ours: HermesPatchDefinition = {
        id: HermesPatchId.make("ours"),
        title: "Ours",
        neededFor: "Tests.",
        versions: [version(withLine(11, "line_11 = patched"))],
      };
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: other.id });
        const applied = NodeFS.readFileSync(file, "utf8").trimEnd().split("\n");
        NodeFS.writeFileSync(file, withLine(10, "line_10 = mine", applied));

        const snapshot = yield* service.list;
        assert.strictEqual(snapshot.patches[0]?.state, "applied");
        assert.strictEqual(snapshot.patches[1]?.state, "doesNotApply");
        assert.strictEqual(snapshot.patches[1]?.reason, "localChanges");
      }).pipe(withService(hermes.binaryPath, [other, ours]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("blames the user's own edit beside a patch committed to HEAD", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      // As above, but the other patch's change is committed rather than
      // applied in the working tree.
      const lines = Array.from({ length: 12 }, (_, index) => `line_${index} = ${index}`);
      const file = NodePath.join(hermes.root, "config.py");
      NodeFS.writeFileSync(file, `${lines.join("\n")}\n`);
      const head = commit(hermes.root, "config", NEWER_DATE);
      const withLine = (index: number, text: string, from = lines) =>
        `${from.map((line, at) => (at === index ? text : line)).join("\n")}\n`;
      const version = (content: string) =>
        versionAt(hermes.root, "config.py", content, head, NEWER_DATE);
      const other: HermesPatchDefinition = {
        id: HermesPatchId.make("other"),
        title: "Other",
        neededFor: "Tests.",
        versions: [version(withLine(0, "line_0 = patched"))],
      };
      const ours: HermesPatchDefinition = {
        id: HermesPatchId.make("ours"),
        title: "Ours",
        neededFor: "Tests.",
        versions: [version(withLine(11, "line_11 = patched"))],
      };
      const committed = withLine(0, "line_0 = patched");
      NodeFS.writeFileSync(file, committed);
      commit(hermes.root, "carry the other patch", NEWER_DATE);
      NodeFS.writeFileSync(file, withLine(10, "line_10 = mine", committed.trimEnd().split("\n")));
      yield* Effect.gen(function* () {
        const snapshot = yield* (yield* HermesPatchService).list;
        assert.strictEqual(snapshot.patches[1]?.state, "doesNotApply");
        assert.strictEqual(snapshot.patches[1]?.reason, "localChanges");
      }).pipe(withService(hermes.binaryPath, [other, ours]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not blame edits another applied patch made to the same file", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      // Another patch adds a line to session.py; ours only fits the newer commit.
      const other: HermesPatchDefinition = {
        id: HermesPatchId.make("other"),
        title: "Other",
        neededFor: "Tests.",
        versions: [
          versionAt(
            hermes.root,
            "session.py",
            "backend = local\nremote_cwd = None\nextra = True\n",
            hermes.older,
            OLDER_DATE,
          ),
        ],
      };
      const patch = hermes.patch([hermes.newerVersion]);
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: other.id });
        const snapshot = yield* service.list;
        const status = snapshot.patches.find((candidate) => candidate.id === patch.id);
        assert.strictEqual(status?.state, "doesNotApply");
        assert.strictEqual(status?.reason, "hermesTooOld");
      }).pipe(withService(hermes.binaryPath, [other, patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
