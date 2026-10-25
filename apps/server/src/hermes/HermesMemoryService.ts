// @effect-diagnostics nodeBuiltinImport:off - fs.watch directory watches have no Effect platform equivalent.
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  HermesMemoryError,
  type HermesMemoryMutateInput,
  type HermesMemorySnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ServerSettings from "../serverSettings.ts";
import { resolveEnabledHermesInstance } from "./hermesCronState.ts";
import {
  mutateHermesMemory,
  readHermesMemoryFiles,
  resolveHermesMemoryPaths,
} from "./hermesMemoryStore.ts";

export class HermesMemoryService extends Context.Service<
  HermesMemoryService,
  {
    readonly read: Effect.Effect<HermesMemorySnapshot, HermesMemoryError>;
    readonly mutate: (
      input: HermesMemoryMutateInput,
    ) => Effect.Effect<HermesMemorySnapshot, HermesMemoryError>;
    readonly subscribe: Effect.Effect<
      Stream.Stream<HermesMemorySnapshot>,
      HermesMemoryError,
      Scope.Scope
    >;
  }
>()("t3-hermes/hermes/HermesMemoryService") {}

const isHermesMemoryError = Schema.is(HermesMemoryError);

const disabled: HermesMemorySnapshot = {
  availability: "providerDisabled",
  detail: "Enable the Hermes provider in this environment's Settings to see its memory.",
  files: [],
};
const unreadable: HermesMemorySnapshot = {
  availability: "unreadable",
  detail:
    "Hermes memory or config.yaml could not be read safely. Check its permissions, UTF-8 encoding, and memory character limits. Nothing has been changed.",
  files: [],
};

/** Directory watches survive Hermes's atomic renames. If the store has not been
 * created yet, watch its nearest existing ancestor without creating anything. */
function watchDirectories(home: string, directory: string, notify: () => void): () => void {
  const targets = new Map<string, Set<string>>();
  const watchers = new Map<string, NodeFS.FSWatcher>();
  const watchParent = (requested: string): void => {
    const parent = NodePath.dirname(requested);
    if (parent === requested) return;
    // Attach ancestors before inspecting descendants. Creation between the
    // inspection and attaching the child watch then always queues another read.
    watchParent(parent);
    const children = targets.get(parent) ?? new Set<string>();
    children.add(NodePath.basename(requested));
    targets.set(parent, children);
    if (watchers.has(parent)) return;
    try {
      const watcher = NodeFS.watch(parent, { persistent: false }, (_event, filename) => {
        if (filename === null || children.has(filename.toString())) notify();
      });
      watcher.on("error", notify);
      watchers.set(parent, watcher);
    } catch {
      // A missing or traverse-only ancestor must not prevent watching its
      // readable descendants. Its nearest watched ancestor handles creation.
    }
  };
  for (const file of [
    NodePath.join(home, "config.yaml"),
    NodePath.join(directory, "MEMORY.md"),
    NodePath.join(directory, "USER.md"),
  ]) {
    watchParent(NodePath.resolve(file));
  }

  return () => {
    for (const watcher of watchers.values()) watcher.close();
  };
}

/**
 * One watcher set per environment, only while a client is subscribed: no timers, no subprocess on
 * reads, no frames for unchanged snapshots.
 * @public
 */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const settings = yield* ServerSettings.ServerSettingsService;
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<{ seq: number; snapshot: HermesMemorySnapshot }>(),
    PubSub.shutdown,
  );
  const current = yield* Ref.make({ seq: 0, snapshot: disabled });
  const mutex = yield* Semaphore.make(1);
  const subscribers = yield* SynchronizedRef.make<{ count: number; scope: Scope.Closeable | null }>(
    { count: 0, scope: null },
  );
  const serviceScope = yield* Effect.scope;

  const instance = settings.getSettings.pipe(
    Effect.flatMap(
      Effect.fnUntraced(function* (settings) {
        const enabled = resolveEnabledHermesInstance(settings);
        return enabled === null
          ? null
          : {
              env: yield* mergeProviderInstanceEnvironment(enabled.environment),
              binary: enabled.settings.binaryPath || "hermes",
            };
      }),
    ),
    Effect.mapError(
      (cause) =>
        new HermesMemoryError({
          reason: "unreadable",
          detail: "Environment settings could not be read.",
          cause,
        }),
    ),
  );

  const refresh = mutex.withPermits(1)(
    Effect.gen(function* () {
      const selected = yield* instance.pipe(Effect.option);
      const snapshot =
        selected._tag === "None"
          ? unreadable
          : selected.value === null
            ? disabled
            : yield* Effect.tryPromise(() => readHermesMemoryFiles(selected.value!.env)).pipe(
                Effect.map(({ files }): HermesMemorySnapshot => ({
                  availability: "ready",
                  detail: null,
                  files,
                })),
                Effect.orElseSucceed(() => unreadable),
              );
      const previous = yield* Ref.get(current);
      if (NodeUtil.isDeepStrictEqual(previous.snapshot, snapshot)) return previous;
      const next = { seq: previous.seq + 1, snapshot };
      yield* Ref.set(current, next);
      yield* PubSub.publish(changes, next);
      return next;
    }),
  );

  const startWatching = Effect.gen(function* () {
    const wakeups = yield* Queue.sliding<void>(1);
    const ready = yield* Deferred.make<void>();
    let closeWatchers = () => {};
    yield* Effect.addFinalizer(() => Effect.sync(() => closeWatchers()));
    const settingsChanges = yield* settings.subscribeChanges;
    yield* Stream.runForEach(settingsChanges, () => Queue.offer(wakeups, undefined)).pipe(
      Effect.forkScoped,
    );
    const watchAndRead = Effect.gen(function* () {
      const selected = yield* instance.pipe(Effect.option);
      yield* Effect.sync(() => {
        closeWatchers();
        closeWatchers = () => {};
        if (selected._tag === "Some" && selected.value !== null) {
          const paths = resolveHermesMemoryPaths(selected.value.env);
          closeWatchers = watchDirectories(paths.home, paths.directory, () => {
            Queue.offerUnsafe(wakeups, undefined);
          });
        }
      });
      // Attach before reading so a write during the snapshot is queued for another read.
      yield* refresh;
      yield* Deferred.succeed(ready, undefined);
    });
    yield* Queue.offer(wakeups, undefined);
    yield* Stream.runForEach(Stream.fromQueue(wakeups), () => watchAndRead).pipe(Effect.forkScoped);
    yield* Deferred.await(ready);
  });

  const retain = SynchronizedRef.updateEffect(subscribers, (state) =>
    Effect.gen(function* () {
      if (state.scope !== null) return { ...state, count: state.count + 1 };
      const scope = yield* Scope.fork(serviceScope, "sequential");
      yield* startWatching.pipe(Scope.provide(scope));
      return { count: 1, scope };
    }),
  );
  const release = SynchronizedRef.updateEffect(subscribers, (state) =>
    Effect.gen(function* () {
      const count = Math.max(0, state.count - 1);
      if (count > 0 || state.scope === null) return { ...state, count };
      yield* Scope.close(state.scope, Exit.void);
      return { count: 0, scope: null };
    }),
  );

  const subscribe = Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(changes);
    yield* Effect.acquireRelease(retain, () => release);
    const latest = yield* refresh;
    return Stream.concat(
      Stream.make(latest.snapshot),
      Stream.fromSubscription(subscription).pipe(
        Stream.filter((update) => update.seq > latest.seq),
        Stream.map((update) => update.snapshot),
      ),
    );
  });

  const mutate = Effect.fn("HermesMemoryService.mutate")(function* (
    input: HermesMemoryMutateInput,
  ) {
    const selected = yield* instance;
    if (selected === null)
      return yield* new HermesMemoryError({ reason: "providerDisabled", detail: disabled.detail! });
    yield* Effect.tryPromise({
      try: (signal) => mutateHermesMemory(selected.env, selected.binary, input, platform, signal),
      catch: (error) =>
        isHermesMemoryError(error)
          ? error
          : new HermesMemoryError({
              reason: "unreadable",
              detail: unreadable.detail!,
              cause: error,
            }),
    }).pipe(Effect.onError(() => refresh));
    return (yield* refresh).snapshot;
  });

  return HermesMemoryService.of({
    read: Effect.map(refresh, (result) => result.snapshot),
    mutate,
    subscribe,
  });
});

export const layer = Layer.effect(HermesMemoryService, make);
