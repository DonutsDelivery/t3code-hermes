// @effect-diagnostics nodeBuiltinImport:off - builds fixture git repos synchronously.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HermesPatchId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import { providerUpdateLock } from "../provider/providerMaintenanceCommandCoordinator.ts";
import * as ServerSettings from "../serverSettings.ts";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { startFakeGateway } from "./hermesGatewayFixtures.ts";
import { HERMES_PATCHES, HERMES_UPDATE_LOCK_KEY } from "./hermesPatches.ts";
import { HermesPatchService, make } from "./HermesPatchService.ts";

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });

const withService = (hermes: { readonly enabled: boolean; readonly binaryPath?: string }) =>
  Effect.provide(
    Layer.effect(HermesPatchService, make).pipe(
      Layer.provide(
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("hermes")]: {
              driver: ProviderDriverKind.make("hermes"),
              enabled: hermes.enabled,
              config: hermes,
            },
          },
        }),
      ),
      Layer.provideMerge(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );

/** A git checkout laid out like a source install, with a stand-in binary. */
const makeHermesCheckout = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-install-" });
  git(root, "init", "--quiet");
  NodeFS.writeFileSync(NodePath.join(root, "README.md"), "hermes\n");
  NodeFS.writeFileSync(NodePath.join(root, ".gitignore"), "venv/\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "base");
  const binaryPath = NodePath.join(root, "venv", "bin", "hermes");
  NodeFS.mkdirSync(NodePath.dirname(binaryPath), { recursive: true });
  NodeFS.writeFileSync(binaryPath, "#!/bin/sh\n", { mode: 0o755 });
  return { root, binaryPath };
});

/**
 * The enabled Hermes as a provider instance whose environment points
 * `HERMES_HOME` at `home`, the way the gateway restart has to find it.
 */
const withInstance = (binaryPath: string, home: string) =>
  Effect.provide(
    Layer.effect(HermesPatchService, make).pipe(
      Layer.provide(
        ServerSettings.layerTest({
          providerInstances: {
            hermes: {
              driver: "hermes",
              enabled: true,
              config: { binaryPath },
              environment: [{ name: "HERMES_HOME", value: home, sensitive: false }],
            },
          },
        } as never),
      ),
      Layer.provideMerge(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );

/**
 * A checkout whose `hermes` stands in for `hermes gateway restart`: it
 * replaces the gateway by writing a new pid, or fails with `exitCode`, first
 * taking the old gateway's socket down when `stopsGateway` is set.
 */
const makeRestartableCheckout = (restart: {
  readonly exitCode: number;
  readonly stopsGateway?: boolean;
  /** Exits 0 without writing a new pid, as a restart that did nothing. */
  readonly leavesGateway?: boolean;
}) =>
  Effect.gen(function* () {
    const { root, binaryPath } = yield* makeHermesCheckout;
    const fileSystem = yield* FileSystem.FileSystem;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-home-" });
    writeFakeCli({
      directory: NodePath.dirname(binaryPath),
      name: "hermes",
      source: [
        'import { rmSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'if (process.argv.slice(2).join(" ") !== "gateway restart") process.exit(64);',
        `if (${restart.stopsGateway === true}) rmSync(join(process.env.HERMES_HOME, "gateway.sock"));`,
        `if (${restart.exitCode} !== 0) {`,
        '  console.error("✗ Gateway service restart failed.");',
        `  process.exit(${restart.exitCode});`,
        "}",
        `if (${restart.leavesGateway === true}) process.exit(0);`,
        'writeFileSync(join(process.env.HERMES_HOME, "gateway.pid"), JSON.stringify({ pid: 5151 }));',
      ].join("\n"),
    });
    return { root, binaryPath, home };
  });

describe("HermesPatchService", () => {
  it.effect("says Hermes is disabled rather than failing", () =>
    Effect.gen(function* () {
      const service = yield* HermesPatchService;
      const snapshot = yield* service.list;
      assert.strictEqual(snapshot.availability, "providerDisabled");
      assert.deepStrictEqual(snapshot.patches, []);
      const error = yield* Effect.flip(service.apply({ patchId: HERMES_PATCHES[0]!.id }));
      assert.strictEqual(error.reason, "unavailable");
    }).pipe(withService({ enabled: false })),
  );

  it.effect("reads the enabled Hermes's checkout and refuses changes that do not fit", () =>
    Effect.gen(function* () {
      const { root, binaryPath } = yield* makeHermesCheckout;
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        const snapshot = yield* service.list;
        assert.strictEqual(snapshot.availability, "ready");
        assert.strictEqual(snapshot.checkoutPath, NodeFS.realpathSync(root));
        assert.isFalse(snapshot.detachedHead);
        // The shipped patches target Hermes source this fixture does not have.
        assert.deepStrictEqual(
          snapshot.patches.map((patch) => patch.state),
          HERMES_PATCHES.map(() => "doesNotApply"),
        );

        const unknown = yield* Effect.flip(
          service.apply({ patchId: HermesPatchId.make("not-shipped") }),
        );
        assert.strictEqual(unknown.reason, "unknownPatch");
        const misfit = yield* Effect.flip(service.apply({ patchId: HERMES_PATCHES[0]!.id }));
        assert.strictEqual(misfit.reason, "wrongState");
        assert.strictEqual(git(root, "status", "--porcelain"), "");
      }).pipe(withService({ enabled: true, binaryPath }));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("flags a gateway older than the patched files and restarts it", () =>
    Effect.gen(function* () {
      const { root, binaryPath, home } = yield* makeRestartableCheckout({ exitCode: 0 });
      const gateway = yield* Effect.acquireRelease(
        Effect.promise(() => startFakeGateway({ home, pid: 4242 })),
        (fake) => Effect.promise(fake.close),
      );
      // The gateway started before a patch rewrote a file it imports.
      NodeFS.utimesSync(gateway.pidFile, 1_000, 1_000);
      NodeFS.mkdirSync(NodePath.join(root, "gateway"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, "gateway", "run.py"), "");
      NodeFS.utimesSync(NodePath.join(root, "gateway", "run.py"), 2_000, 2_000);

      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        assert.deepStrictEqual((yield* service.list).gateway, {
          state: "outdated",
          canRestart: true,
        });

        const started = yield* service.restartGateway;
        assert.strictEqual(started.gateway?.state, "restarting");
        yield* service.awaitGatewayRestart;

        const after = yield* service.list;
        assert.deepStrictEqual(after.gateway, { state: "upToDate", canRestart: true });
        assert.isNull(after.gatewayRestartFailure);
      }).pipe(withInstance(binaryPath, home));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("holds a gateway restart until an update or patch change finishes", () =>
    Effect.gen(function* () {
      const { binaryPath, home } = yield* makeRestartableCheckout({ exitCode: 0 });
      yield* Effect.acquireRelease(
        Effect.promise(() => startFakeGateway({ home, pid: 4242 })),
        (fake) => Effect.promise(fake.close),
      );
      const pidFile = NodePath.join(home, "gateway.pid");
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        const release = yield* Deferred.make<void>();
        const held = yield* Deferred.make<void>();
        // Stands in for Update Hermes holding the lock with the patches off.
        const update = yield* providerUpdateLock(HERMES_UPDATE_LOCK_KEY)
          .withPermits(1)(
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(held);

        const started = yield* service.restartGateway;
        assert.strictEqual(started.gateway?.state, "restarting");
        yield* Effect.yieldNow;
        assert.include(NodeFS.readFileSync(pidFile, "utf8"), "4242");

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(update);
        yield* service.awaitGatewayRestart;
        assert.include(NodeFS.readFileSync(pidFile, "utf8"), "5151");
      }).pipe(withInstance(binaryPath, home));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Live clock: the service waits out its retries for a replacement.
  it.live("reports a restart failed when it leaves the gateway an update started", () =>
    Effect.gen(function* () {
      // The restart command "succeeds" but replaces nothing.
      const { binaryPath, home } = yield* makeRestartableCheckout({
        exitCode: 0,
        leavesGateway: true,
      });
      yield* Effect.acquireRelease(
        Effect.promise(() => startFakeGateway({ home, pid: 4242 })),
        (fake) => Effect.promise(fake.close),
      );
      const pidFile = NodePath.join(home, "gateway.pid");
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        const release = yield* Deferred.make<void>();
        const held = yield* Deferred.make<void>();
        const update = yield* providerUpdateLock(HERMES_UPDATE_LOCK_KEY)
          .withPermits(1)(
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(held);
        yield* service.restartGateway;
        // An older Hermes restarts its gateway during the update.
        NodeFS.writeFileSync(pidFile, `{"pid":6363}`);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(update);
        yield* service.awaitGatewayRestart;

        const after = yield* service.list;
        assert.isNotNull(after.gatewayRestartFailure);
      }).pipe(withInstance(binaryPath, home));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Live clock: the service really waits between reads of the socket.
  it.live("waits for the replacement gateway's socket to answer", () =>
    Effect.gen(function* () {
      const { binaryPath, home } = yield* makeRestartableCheckout({ exitCode: 0 });
      const gateway = yield* Effect.acquireRelease(
        Effect.promise(() => startFakeGateway({ home, pid: 4242 })),
        (fake) => Effect.promise(fake.close),
      );
      // The restart command returns while the old process still answers.
      gateway.answerPid(4242);
      yield* Effect.sleep("1500 millis").pipe(
        Effect.andThen(Effect.sync(() => gateway.answerPid(null))),
        Effect.forkScoped,
      );

      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.restartGateway;
        yield* service.awaitGatewayRestart;
        const after = yield* service.list;
        assert.isNull(after.gatewayRestartFailure);
        assert.strictEqual(after.gateway?.state, "upToDate");
      }).pipe(withInstance(binaryPath, home));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a restart that did not replace the gateway", () =>
    Effect.gen(function* () {
      const { binaryPath, home } = yield* makeRestartableCheckout({ exitCode: 1 });
      yield* Effect.acquireRelease(
        Effect.promise(() => startFakeGateway({ home, pid: 4242 })),
        (fake) => Effect.promise(fake.close),
      );

      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.restartGateway;
        yield* service.awaitGatewayRestart;
        const after = yield* service.list;
        assert.strictEqual(
          after.gatewayRestartFailure,
          "hermes gateway restart exited with code 1. ✗ Gateway service restart failed.",
        );
        assert.strictEqual(after.gateway?.state, "upToDate");
      }).pipe(withInstance(binaryPath, home));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a restart failure that left no gateway until another one answers", () =>
    Effect.gen(function* () {
      const { binaryPath, home } = yield* makeRestartableCheckout({
        exitCode: 1,
        stopsGateway: true,
      });
      const old = yield* Effect.promise(() => startFakeGateway({ home, pid: 4242 }));

      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.restartGateway;
        yield* service.awaitGatewayRestart;
        yield* Effect.promise(old.close);
        const down = yield* service.list;
        assert.isNull(down.gateway);
        assert.include(down.gatewayRestartFailure ?? "", "exited with code 1");

        // Started by hand on the host: the failure no longer describes anything.
        yield* Effect.acquireRelease(
          Effect.promise(() => startFakeGateway({ home, pid: 6161 })),
          (fake) => Effect.promise(fake.close),
        );
        const back = yield* service.list;
        assert.strictEqual(back.gateway?.state, "upToDate");
        assert.isNull(back.gatewayRestartFailure);
      }).pipe(withInstance(binaryPath, home));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a gateway started in a terminal, or a missing one, alone", () =>
    Effect.gen(function* () {
      const { binaryPath, home } = yield* makeRestartableCheckout({ exitCode: 0 });
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        assert.isNull((yield* service.list).gateway);
        const none = yield* Effect.flip(service.restartGateway);
        assert.strictEqual(none.reason, "wrongState");

        const gateway = yield* Effect.acquireRelease(
          Effect.promise(() => startFakeGateway({ home, pid: 4242, supervisor: "manual" })),
          (fake) => Effect.promise(fake.close),
        );
        assert.deepStrictEqual((yield* service.list).gateway, {
          state: "upToDate",
          canRestart: false,
        });
        const manual = yield* Effect.flip(service.restartGateway);
        assert.strictEqual(manual.reason, "wrongState");
        assert.include(NodeFS.readFileSync(gateway.pidFile, "utf8"), "4242");
      }).pipe(withInstance(binaryPath, home));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
