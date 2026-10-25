/**
 * Patch status and apply/remove against the enabled Hermes checkout, `hermes update` with patches
 * lifted off and restored, and gateway restarts. Nothing is cached because the checkout can change
 * between clicks; only the in-flight restart is kept.
 */
import {
  HermesPatchError,
  type HermesPatchChangeInput,
  type HermesGatewayStatus,
  type HermesPatchesAvailability,
  type HermesPatchesSnapshot,
  type HermesPatchId,
  type HermesPatchUpdateHermesResult,
} from "@t3tools/contracts";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { providerUpdateLock } from "../provider/providerMaintenanceCommandCoordinator.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as ServerSettings from "../serverSettings.ts";
import { resolveEnabledHermesInstance, resolveHermesHome } from "./hermesCronState.ts";
import {
  describeRestartOutput,
  latestModifiedMs,
  readRunningHermesGateway,
  type RunningHermesGateway,
} from "./hermesGateway.ts";
import {
  optInHermesFastModeEndpoints,
  optOutHermesFastModeEndpoints,
} from "./hermesFastModeConfig.ts";
import {
  changeHermesPatch,
  HERMES_FAST_MODE_PATCH_ID,
  HERMES_PATCHES,
  HERMES_UPDATE_LOCK_KEY,
  hermesPatchedSourceFiles,
  readHermesDirtyPaths,
  readHermesHeadCommit,
  readHermesPatches,
  readHermesPatchesInHead,
  readHermesUserEdits,
  resolveHermesGitCheckout,
  type HermesPatchDefinition,
} from "./hermesPatches.ts";

export class HermesPatchService extends Context.Service<
  HermesPatchService,
  {
    readonly list: Effect.Effect<HermesPatchesSnapshot, HermesPatchError>;
    readonly apply: (
      input: HermesPatchChangeInput,
    ) => Effect.Effect<HermesPatchesSnapshot, HermesPatchError>;
    readonly revert: (
      input: HermesPatchChangeInput,
    ) => Effect.Effect<HermesPatchesSnapshot, HermesPatchError>;
    readonly updateHermes: Effect.Effect<HermesPatchUpdateHermesResult, HermesPatchError>;
    /** Emits after a patch was applied or removed, so provider snapshots can re-probe. */
    readonly changes: Stream.Stream<void>;
    /**
     * Starts `hermes gateway restart` and returns at once. The gateway drains
     * its in-flight work first, which can take minutes; the snapshot reads
     * `restarting` until the command finishes.
     */
    readonly restartGateway: Effect.Effect<HermesPatchesSnapshot, HermesPatchError>;
    /** Waits for the restart `restartGateway` started, if one is running. */
    readonly awaitGatewayRestart: Effect.Effect<void>;
  }
>()("t3-hermes/hermes/HermesPatchService") {}

const unavailableSnapshot = (availability: HermesPatchesAvailability): HermesPatchesSnapshot => ({
  availability,
  checkoutPath: null,
  detachedHead: false,
  patches: [],
  gateway: null,
  gatewayRestartFailure: null,
});
/**
 * Supervisors that bring a gateway back after `hermes gateway restart` stops
 * it. A `manual` gateway was started in a terminal, and the CLI would run its
 * replacement in the foreground as a child of this server. Hermes Desktop
 * (`desktop`) and Windows gateways restart from their own controls.
 */
const RESTARTABLE_SUPERVISORS = new Set(["systemd", "launchd", "external"]);
const isRestartable = (gateway: RunningHermesGateway) =>
  RESTARTABLE_SUPERVISORS.has(gateway.supervisor);

/** How long to wait for a restarted gateway's control socket: 10 × 1s. */
const REPLACEMENT_ATTEMPTS = 10;
const REPLACEMENT_RETRY_DELAY = "1 second";

interface GatewayRestart {
  readonly running: boolean;
  /** Why the last restart failed, and the gateway pid it left answering (null: none). */
  readonly failure: { readonly detail: string; readonly gatewayPid: number | null } | null;
  readonly fiber: Fiber.Fiber<void> | null;
}

export interface HermesPatchServiceOptions {
  /** Patches to manage; the shipped ones by default. Tests pass fixtures. */
  readonly patches?: ReadonlyArray<HermesPatchDefinition>;
  /** How long `hermes update` may run before it is stopped. */
  readonly updateTimeout?: Duration.Input;
}

/** Per stream, kept from the end of `hermes update`'s output. */
const HERMES_OUTPUT_MAX_BYTES = 16_384;

/**
 * The last `maxBytes` of a byte stream as text, dropping older chunks as new
 * ones arrive so memory stays bounded however long the process runs.
 */
const collectTailText = <E>(stream: Stream.Stream<Uint8Array, E>, maxBytes: number) =>
  stream.pipe(
    Stream.runFold(
      () => ({ chunks: [] as Uint8Array[], bytes: 0 }),
      (state, chunk) => {
        state.chunks.push(chunk);
        let bytes = state.bytes + chunk.byteLength;
        while (state.chunks.length > 1 && bytes - state.chunks[0]!.byteLength >= maxBytes) {
          bytes -= state.chunks.shift()!.byteLength;
        }
        return { chunks: state.chunks, bytes };
      },
    ),
    Effect.map(({ chunks, bytes }) => {
      const joined = Buffer.concat(chunks, bytes);
      return joined.subarray(Math.max(0, joined.byteLength - maxBytes)).toString("utf8");
    }),
  );

/** Keeps the end of a long update log, where the failure usually is. */
const outputTail = (output: string, limit = 2_000) =>
  output.length <= limit ? output : `…${output.slice(output.length - limit)}`;

export const makeWith = Effect.fnUntraced(function* (options: HermesPatchServiceOptions = {}) {
  const shippedPatches = options.patches ?? HERMES_PATCHES;
  // The patched source files, read once: the patches never change at runtime.
  const patchedSourceFiles = hermesPatchedSourceFiles(shippedPatches);
  const updateTimeout = options.updateTimeout ?? "15 minutes";
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const changesPubSub = yield* PubSub.unbounded<void>();
  // Two clicks racing on one checkout would both pass the state check, and a
  // provider update from Settings changes the same checkout, so both share the
  // Hermes update lock.
  const changeLock = providerUpdateLock(HERMES_UPDATE_LOCK_KEY);
  const restartRef = yield* Ref.make<GatewayRestart>({
    running: false,
    failure: null,
    fiber: null,
  });
  // A restart outlives the request that started it, but not the server.
  const restartScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );

  const provide = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  /** The enabled Hermes's checkout, or why there is none. */
  const locateCheckout = provide(
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
      const instance = settings === null ? null : resolveEnabledHermesInstance(settings);
      if (instance === null) return { availability: "providerDisabled" } as const;
      const env = yield* mergeProviderInstanceEnvironment(instance.environment);
      const commandPath = yield* resolveCommandPath(instance.settings.binaryPath || "hermes", {
        env,
      }).pipe(Effect.orElseSucceed(() => null));
      if (commandPath === null) return { availability: "hermesNotFound" } as const;
      const realCommandPath = yield* fileSystem
        .realPath(commandPath)
        .pipe(Effect.orElseSucceed(() => null));
      const checkoutRoot =
        realCommandPath === null ? null : yield* resolveHermesGitCheckout(realCommandPath);
      if (checkoutRoot === null) return { availability: "notGitCheckout" } as const;
      return {
        availability: "ready",
        checkoutRoot,
        commandPath,
        binary: instance.settings.binaryPath || "hermes",
        env,
        hermesHome: resolveHermesHome(env),
      } as const;
    }),
  );
  type Checkout = Extract<Effect.Success<typeof locateCheckout>, { availability: "ready" }>;

  /** The running gateway, or null when none answers; never fails the read. */
  const readGateway = (hermesHome: string) =>
    Effect.promise(() => readRunningHermesGateway(hermesHome)).pipe(
      Effect.orElseSucceed(() => null),
    );

  const readGatewayStatus = Effect.fn("HermesPatchService.readGatewayStatus")(function* (
    checkout: Checkout,
  ) {
    const restart = yield* Ref.get(restartRef);
    const gateway = yield* readGateway(checkout.hermesHome);
    // A failure describes the gateway it left behind. Once another one
    // answers, say one started by hand, the failure is history.
    const failure =
      restart.failure !== null && restart.failure.gatewayPid === (gateway?.pid ?? null)
        ? restart.failure.detail
        : null;
    if (restart.running) {
      return { status: { state: "restarting", canRestart: true } as const, failure: null };
    }
    if (gateway === null) return { status: null, failure };
    const changedAtMs = yield* Effect.promise(() =>
      latestModifiedMs(checkout.checkoutRoot, patchedSourceFiles),
    ).pipe(Effect.orElseSucceed(() => null));
    const status: HermesGatewayStatus = {
      state: changedAtMs !== null && changedAtMs > gateway.startedAtMs ? "outdated" : "upToDate",
      canRestart: isRestartable(gateway),
    };
    return { status, failure };
  });

  const readSnapshot = (checkout: Checkout) =>
    provide(
      Effect.all({
        patches: readHermesPatches(checkout.checkoutRoot, shippedPatches),
        headCommit: readHermesHeadCommit(checkout.checkoutRoot),
        gateway: readGatewayStatus(checkout),
      }),
    ).pipe(
      Effect.map(({ patches, headCommit, gateway }): HermesPatchesSnapshot => ({
        availability: "ready",
        checkoutPath: checkout.checkoutRoot,
        detachedHead: false,
        ...(headCommit === null ? {} : { headCommit }),
        canUpdateHermes: true,
        patches,
        gateway: gateway.status,
        gatewayRestartFailure: gateway.failure,
      })),
      Effect.mapError(
        (cause) =>
          new HermesPatchError({
            reason: "commandFailed",
            detail: "Could not read the Hermes checkout with git.",
            cause,
          }),
      ),
    );

  const list = Effect.gen(function* () {
    const checkout = yield* locateCheckout;
    if (checkout.availability !== "ready") return unavailableSnapshot(checkout.availability);
    return yield* readSnapshot(checkout);
  });

  const change = Effect.fn("HermesPatchService.change")(function* (
    input: HermesPatchChangeInput,
    direction: "forward" | "reverse",
  ) {
    const patch = shippedPatches.find((candidate) => candidate.id === input.patchId);
    if (patch === undefined) {
      return yield* new HermesPatchError({
        reason: "unknownPatch",
        detail: "This environment does not ship that patch.",
      });
    }
    const checkout = yield* locateCheckout;
    if (checkout.availability !== "ready") {
      return yield* new HermesPatchError({
        reason: "unavailable",
        detail: "There is no Hermes git checkout to patch.",
      });
    }
    const before = yield* readSnapshot(checkout);
    const expected = direction === "forward" ? "notApplied" : "applied";
    if (before.patches.find((candidate) => candidate.id === patch.id)?.state !== expected) {
      return yield* new HermesPatchError({
        reason: "wrongState",
        detail:
          direction === "forward"
            ? "The patch does not apply to this Hermes checkout as it is now."
            : "The patch is not applied to this Hermes checkout.",
      });
    }
    const result = yield* provide(
      changeHermesPatch(checkout.checkoutRoot, patch, direction, shippedPatches),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new HermesPatchError({
            reason: "commandFailed",
            detail: "Could not run git in the Hermes checkout.",
            cause,
          }),
      ),
    );
    if (!result.ok) {
      yield* Effect.logWarning("git refused a Hermes patch change").pipe(
        Effect.annotateLogs({ patchId: patch.id, direction }),
      );
      return yield* new HermesPatchError({
        reason: "commandFailed",
        detail:
          direction === "forward"
            ? "git refused to apply the patch. The checkout was left unchanged."
            : "git refused to remove the patch. The checkout was left unchanged.",
      });
    }
    if (patch.id === HERMES_FAST_MODE_PATCH_ID) {
      const configFile = path.join(checkout.hermesHome, "config.yaml");
      yield* (
        direction === "forward"
          ? optInHermesFastModeEndpoints(configFile)
          : optOutHermesFastModeEndpoints(configFile)
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
    }
    yield* PubSub.publish(changesPubSub, undefined);
    return yield* readSnapshot(checkout);
  }, changeLock.withPermits(1));

  const gitFailed = (detail: string) => (cause: unknown) =>
    new HermesPatchError({ reason: "commandFailed", detail, cause });

  /**
   * Puts each patch back with whichever version fits the checkout now, and
   * sorts the ones that would not go back by why.
   */
  const reapply = Effect.fn("HermesPatchService.reapply")(function* (
    checkout: Checkout,
    patches: ReadonlyArray<HermesPatchDefinition>,
  ) {
    const { checkoutRoot } = checkout;
    const reapplied: HermesPatchId[] = [];
    const failed: HermesPatchId[] = [];
    for (const patch of patches) {
      const result = yield* provide(
        changeHermesPatch(checkoutRoot, patch, "forward", shippedPatches),
      ).pipe(Effect.orElseSucceed(() => ({ ok: false }) as const));
      (result.ok ? reapplied : failed).push(patch.id);
    }
    const snapshot = yield* readSnapshot(checkout);
    const reasonOf = (id: HermesPatchId) =>
      snapshot.patches.find((candidate) => candidate.id === id)?.reason;
    return {
      snapshot,
      reapplied,
      awaitingPatchUpdate: failed.filter((id) => reasonOf(id) === "awaitingPatchUpdate"),
      notReapplied: failed.filter((id) => reasonOf(id) !== "awaitingPatchUpdate"),
    };
  });

  /**
   * Runs Hermes in its checkout. Output is capped while it streams: a full
   * dependency install logs a lot, and only its end is ever shown.
   */
  const runHermes = Effect.fn("HermesPatchService.runHermes")(function* (
    checkout: {
      readonly checkoutRoot: string;
      readonly commandPath: string;
      readonly env: NodeJS.ProcessEnv;
    },
    args: ReadonlyArray<string>,
  ) {
    const spawn = yield* resolveSpawnCommand(checkout.commandPath, args, { env: checkout.env });
    const child = yield* spawner.spawn(
      ChildProcess.make(spawn.command, spawn.args, {
        cwd: checkout.checkoutRoot,
        env: checkout.env,
        shell: spawn.shell,
      }),
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        collectTailText(child.stdout, HERMES_OUTPUT_MAX_BYTES),
        collectTailText(child.stderr, HERMES_OUTPUT_MAX_BYTES),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, code };
  }, Effect.scoped);

  /**
   * Runs `hermes update` without prompts or stash restore, deferring the gateway restart until
   * patches are back on. Only flags `update --help` lists are passed, since older Hermes rejects
   * `--keep-stash`/`--no-gateway-restart`.
   */
  const runHermesUpdate = Effect.fn("HermesPatchService.runHermesUpdate")(
    function* (checkout: {
      readonly checkoutRoot: string;
      readonly commandPath: string;
      readonly env: NodeJS.ProcessEnv;
    }) {
      // Bounded with the update itself: by now the patches are off, so a
      // stalled probe must not leave the checkout unpatched indefinitely.
      const help = yield* runHermes(checkout, ["update", "--help"]).pipe(
        Effect.map((result) => `${result.stdout}${result.stderr}`),
        Effect.orElseSucceed(() => ""),
      );
      // `--yes` is as old as `update` itself; without it the update would wait
      // on a prompt, so it is passed even when the help cannot be read.
      const args = [
        "update",
        "--yes",
        ...["--keep-stash", "--no-gateway-restart"].filter((flag) =>
          new RegExp(`(^|[\\s\\[,])${flag}(?![\\w-])`, "m").test(help),
        ),
      ];
      const result = yield* runHermes(checkout, args);
      return { ok: result.code === 0, output: `${result.stdout}${result.stderr}` };
    },
    Effect.timeoutOption(updateTimeout),
    Effect.map((result) =>
      Option.getOrElse(result, () => ({
        ok: false,
        output: "hermes update did not finish in time and was stopped.",
      })),
    ),
    Effect.catch((cause) =>
      Effect.succeed({ ok: false, output: `Could not run hermes update: ${String(cause)}` }),
    ),
  );

  const updateHermes = Effect.gen(function* () {
    const checkout = yield* locateCheckout;
    if (checkout.availability !== "ready") {
      return yield* new HermesPatchError({
        reason: "unavailable",
        detail: "Hermes is not installed from a git checkout, so T3 Code cannot update it.",
      });
    }
    const { checkoutRoot } = checkout;
    const before = yield* readSnapshot(checkout);
    // A patch whose change HEAD already holds (committed, or now carried
    // upstream) stays put: `hermes update` moves HEAD, not the working tree.
    const inHead = yield* provide(readHermesPatchesInHead(checkoutRoot, shippedPatches)).pipe(
      Effect.mapError(gitFailed("Could not read the Hermes checkout with git.")),
    );
    const applied = shippedPatches.filter(
      (patch) =>
        !inHead.has(patch.id) &&
        before.patches.some((status) => status.id === patch.id && status.state === "applied"),
    );
    const refuseLocalChanges = (paths: ReadonlyArray<string>) =>
      new HermesPatchError({
        reason: "wrongState",
        detail: `The Hermes checkout has uncommitted changes of your own (${paths.length === 1 ? paths[0] : `${paths[0]} and ${paths.length - 1} more`}). Updating would park them in a git stash, so commit or discard them first.`,
      });
    // Refused before anything moves, whenever the user's edits can be told
    // apart from the applied patches' changes.
    const userEdits = yield* provide(readHermesUserEdits(checkoutRoot, shippedPatches)).pipe(
      Effect.mapError(gitFailed("Could not read the Hermes checkout with git.")),
    );
    if (userEdits.size > 0) return yield* refuseLocalChanges([...userEdits].sort());

    const removed: HermesPatchDefinition[] = [];
    // A dropped connection interrupts this request mid-update. Whatever was
    // lifted off by then goes back on; reapplying is a no-op for a patch that
    // already went back, so the normal path running it first is harmless.
    return yield* Effect.gen(function* () {
      for (const patch of applied) {
        const result = yield* provide(
          changeHermesPatch(checkoutRoot, patch, "reverse", shippedPatches),
        ).pipe(Effect.orElseSucceed(() => ({ ok: false }) as const));
        if (!result.ok) {
          yield* reapply(checkout, removed);
          return yield* new HermesPatchError({
            reason: "commandFailed",
            detail: `git refused to remove ${patch.title} before updating. Hermes was not updated.`,
          });
        }
        removed.push(patch);
      }
      // Whatever is still dirty is the user's own edit inside a patched file
      // that the check above could not attribute.
      const leftover = yield* provide(readHermesDirtyPaths(checkoutRoot)).pipe(
        Effect.orElseSucceed(() => new Set<string>()),
      );
      if (leftover.size > 0) {
        yield* reapply(checkout, removed);
        return yield* refuseLocalChanges([...leftover].sort());
      }

      const update = yield* runHermesUpdate(checkout);
      if (!update.ok) {
        yield* Effect.logWarning("hermes update failed").pipe(
          Effect.annotateLogs({ output: outputTail(update.output) }),
        );
      }
      const restored = yield* reapply(checkout, removed);
      // Hermes and its patches changed, so provider snapshots re-probe. The
      // fast mode config opt-in stays: the patch went back on, or comes back
      // once a T3 Code update brings a version that fits.
      yield* PubSub.publish(changesPubSub, undefined);
      return {
        ...restored,
        previousHeadCommit: before.headCommit ?? null,
        updateFailed: !update.ok,
        failureOutput: update.ok ? null : outputTail(update.output),
      } satisfies HermesPatchUpdateHermesResult;
    }).pipe(
      Effect.onInterrupt(() =>
        reapply(checkout, removed).pipe(
          Effect.ignore,
          // The update may already have moved HEAD, so provider snapshots
          // re-probe here too.
          Effect.andThen(PubSub.publish(changesPubSub, undefined)),
        ),
      ),
    );
  }).pipe(changeLock.withPermits(1));

  /** The gateway answering once one other than `previousPid` does, or the last read. */
  const awaitReplacement = Effect.fn("HermesPatchService.awaitReplacement")(function* (
    hermesHome: string,
    previousPid: number,
  ) {
    let gateway = yield* readGateway(hermesHome);
    for (let attempt = 1; attempt < REPLACEMENT_ATTEMPTS; attempt++) {
      if (gateway !== null && gateway.pid !== previousPid) break;
      yield* Effect.sleep(REPLACEMENT_RETRY_DELAY);
      gateway = yield* readGateway(hermesHome);
    }
    return gateway;
  });

  /**
   * Runs `hermes gateway restart` with the instance's environment, so its `HERMES_HOME` picks the
   * gateway. Hermes owns the how: it drains in-flight turns, then hands the restart to systemd,
   * launchd, or whatever supervises the gateway. Success means a different gateway answers
   * afterwards; the CLI exits 0 on some paths that leave the old one running.
   */
  const runRestart = Effect.fn("HermesPatchService.runRestart")(
    function* (checkout: Checkout, previousPid: number) {
      const args = ["gateway", "restart"];
      const spawnCommand = yield* resolveSpawnCommand(checkout.binary, args, { env: checkout.env });
      const result = yield* spawnAndCollect(
        checkout.binary,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: checkout.env,
          shell: spawnCommand.shell,
        }),
      );
      // The replacement can be alive before its control socket answers.
      const after =
        result.code === 0
          ? yield* awaitReplacement(checkout.hermesHome, previousPid)
          : yield* readGateway(checkout.hermesHome);
      if (result.code === 0 && after !== null && after.pid !== previousPid) return null;
      yield* Effect.logWarning("hermes gateway restart did not replace the gateway").pipe(
        Effect.annotateLogs({ exitCode: result.code, replaced: after?.pid !== previousPid }),
      );
      const gatewayPid = after?.pid ?? null;
      const output = describeRestartOutput(result.stdout, result.stderr);
      if (result.code !== 0) {
        return {
          detail: `hermes gateway restart exited with code ${result.code}.${output ? ` ${output}` : ""}`,
          gatewayPid,
        };
      }
      return {
        detail:
          after === null
            ? "The gateway stopped and did not come back. Start it with hermes gateway start."
            : "The gateway is still the one from before. Check hermes gateway status on the host.",
        gatewayPid,
      };
    },
    (effect, _checkout, previousPid) =>
      effect.pipe(
        Effect.catchCause(() =>
          Effect.succeed({
            detail: "Could not run hermes gateway restart.",
            gatewayPid: previousPid,
          }),
        ),
        Effect.flatMap((failure) =>
          Ref.update(restartRef, (current) => ({ ...current, running: false, failure })),
        ),
      ),
  );

  const restartGateway = Effect.gen(function* () {
    const checkout = yield* locateCheckout;
    if (checkout.availability !== "ready") {
      return yield* new HermesPatchError({
        reason: "unavailable",
        detail: "There is no Hermes git checkout here.",
      });
    }
    const gateway = yield* readGateway(checkout.hermesHome);
    // One step: an interrupt between marking `running` and forking would
    // leave the tab reading "restarting" until the server restarts.
    const started = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const claimed = yield* Ref.modify(restartRef, (current): [boolean, GatewayRestart] => {
          if (current.running) return [false, current];
          if (gateway === null || !isRestartable(gateway)) return [false, current];
          return [true, { running: true, failure: null, fiber: null }];
        });
        if (!claimed || gateway === null) return false;
        // Under the change lock, so a gateway never comes back up on code an Update Hermes or a
        // patch change is halfway through rewriting. The claim above is immediate, so the tab reads
        // "restarting" meanwhile. The gateway is read again once the lock is held: an update that
        // restarted it meanwhile left a different one, which is the one to replace.
        const restart = Effect.gen(function* () {
          const current = yield* readGateway(checkout.hermesHome);
          yield* runRestart(checkout, (current ?? gateway).pid);
        });
        const fiber = yield* provide(restart).pipe(
          changeLock.withPermits(1),
          Effect.forkIn(restartScope),
        );
        yield* Ref.update(restartRef, (current) => ({ ...current, fiber }));
        return true;
      }),
    );
    if (started) {
      // The answer to this request is "it started", however fast it finishes.
      const snapshot = yield* readSnapshot(checkout);
      return {
        ...snapshot,
        gateway: { state: "restarting", canRestart: true },
        gatewayRestartFailure: null,
      } satisfies HermesPatchesSnapshot;
    }
    if (!(yield* Ref.get(restartRef)).running) {
      return yield* new HermesPatchError({
        reason: "wrongState",
        detail:
          gateway === null
            ? "No Hermes gateway is running."
            : "This gateway does not run as a service. Restart it where it was started.",
      });
    }
    return yield* readSnapshot(checkout);
  });

  return HermesPatchService.of({
    list,
    apply: (input) => change(input, "forward"),
    revert: (input) => change(input, "reverse"),
    updateHermes,
    changes: Stream.fromPubSub(changesPubSub),
    restartGateway,
    awaitGatewayRestart: Ref.get(restartRef).pipe(
      Effect.flatMap(({ fiber }) => (fiber === null ? Effect.void : Fiber.await(fiber))),
      Effect.asVoid,
    ),
  });
});

export const make = makeWith();

export const layer = Layer.effect(HermesPatchService, make);
