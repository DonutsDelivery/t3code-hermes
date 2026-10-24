// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SourceControlProviderKind,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type ThreadHermesRun,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { HERMES_STATE_DDL, insertHermesMessage, insertHermesSession } from "./hermesRunFixtures.ts";
import * as HermesRunService from "./HermesRunService.ts";

const PROJECT_ID = ProjectId.make("project-fork");
const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "t3code-hermes",
  workspaceRoot: "/w/t3code-hermes",
  repositoryIdentity: {
    canonicalKey: "github.com/nateweav/t3code-hermes",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/NateWeav/t3code-hermes.git",
    },
    displayName: "NateWeav/t3code-hermes",
    provider: SourceControlProviderKind.make("github"),
    owner: "NateWeav",
    name: "t3code-hermes",
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const liveRun = (sessionId: string): ThreadHermesRun => ({
  profile: "upstream-sync",
  sourceKey: "webhook:upstream-sync",
  sourceLabel: "webhook/upstream-sync",
  sessionId,
  latestSessionId: sessionId,
  live: true,
});

const liveThread = (sessionId: string) =>
  ({
    id: ThreadId.make(`hermes-run:upstream-sync:${sessionId}`),
    projectId: PROJECT_ID,
    providerInstanceId: ProviderInstanceId.make("hermes"),
    deletedAt: null,
    hermesRun: liveRun(sessionId),
  }) as unknown as OrchestrationV2AppThread;

/** A Hermes home with the resolver's profile: its route, filter script, and state store. */
function makeHermesHome() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-home-"));
  const home = NodePath.join(root, "profiles", "upstream-sync");
  NodeFS.mkdirSync(NodePath.join(home, "scripts"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(home, "config.yaml"),
    `platforms:
  webhook:
    extra:
      routes:
        upstream-sync:
          events: [issues]
          prompt: "Resolve the upstream conflict"
          script: t3code-upstream-conflict.py
`,
  );
  NodeFS.writeFileSync(
    NodePath.join(home, "scripts", "t3code-upstream-conflict.py"),
    'REPOSITORY = "NateWeav/t3code-hermes"\n',
  );
  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "state.db"));
  db.exec(HERMES_STATE_DDL);
  db.close();
  const withDb = (write: (db: NodeSqlite.DatabaseSync) => void) => {
    const handle = new NodeSqlite.DatabaseSync(NodePath.join(home, "state.db"));
    try {
      write(handle);
    } finally {
      handle.close();
    }
  };
  return { root, home, withDb };
}

function makeLayer(
  root: string,
  options: {
    readonly hermesEnabled?: boolean;
    readonly liveThreads?: ReadonlyArray<OrchestrationV2AppThread>;
    /** Items the threads already hold, as the projection would return them. */
    readonly existingItems?: ReadonlyArray<OrchestrationV2TurnItem>;
    /** Fails the first event sink write, as a transient failure would. */
    readonly failFirstWrite?: boolean;
  } = {},
) {
  let failWrite = options.failFirstWrite ?? false;
  const dispatched: OrchestrationV2ServerCommand[] = [];
  const written: OrchestrationV2DomainEvent[] = [];
  const items = new Map((options.existingItems ?? []).map((item) => [item.id, item]));
  const threads = new Map<ThreadId, OrchestrationV2AppThread>(
    (options.liveThreads ?? []).map((thread) => [thread.id, thread]),
  );
  let ordinal = 0;
  const dependencies = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          if (command.type === "thread.create") {
            threads.set(command.threadId, {
              id: command.threadId,
              projectId: command.projectId,
              providerInstanceId: command.modelSelection.instanceId,
              deletedAt: null,
            } as unknown as OrchestrationV2AppThread);
          }
          if (command.type === "thread.hermes-run.set") {
            const thread = threads.get(command.threadId);
            if (thread) threads.set(command.threadId, { ...thread, hermesRun: command.hermesRun });
          }
          return { sequence: dispatched.length, storedEvents: [] };
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: (threadId) =>
        Effect.sync(
          () =>
            (threads.get(threadId) as unknown as OrchestrationV2ThreadShell | undefined) ?? null,
        ),
      getThread: (threadId) => {
        const thread = threads.get(threadId);
        return thread
          ? Effect.succeed(thread)
          : Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }));
      },
      getLiveHermesRunThreads: () =>
        Effect.sync(() => [...threads.values()].filter((thread) => thread.hermesRun?.live)),
      getThreadRecords: (threadId) =>
        Effect.sync(
          () =>
            ({
              thread: threads.get(threadId),
              turnItems: [...items.values()].filter((item) => item.threadId === threadId),
            }) as never,
        ),
    }),
    Layer.mock(EventSink.EventSinkV2)({
      write: ({ events }) =>
        Effect.suspend(() => {
          if (failWrite) {
            failWrite = false;
            return Effect.die(new Error("transient"));
          }
          for (const event of events) {
            written.push(event);
            if (event.type === "turn-item.updated") items.set(event.payload.id, event.payload);
          }
          return Effect.succeed([]);
        }),
    }),
    Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
      normalize: (item) => Effect.sync(() => ({ ...item, ordinal: (ordinal += 1) })),
    }),
    Layer.mock(ProjectService.ProjectService)({
      listShells: () => Effect.succeed([project]),
      getShell: (projectId) =>
        Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
    }),
    ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make("hermes")]: {
          driver: ProviderDriverKind.make("hermes"),
          enabled: options.hermesEnabled ?? true,
          environment: [{ name: "HERMES_HOME", value: root, sensitive: false }],
        },
      },
    }),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-hermes-runs-" }),
  );
  return {
    dispatched,
    written,
    itemEvents: () =>
      written.flatMap((event) => (event.type === "turn-item.updated" ? [event.payload] : [])),
    layer: HermesRunService.layer.pipe(
      Layer.provide(dependencies),
      Layer.provide(NodeServices.layer),
    ),
  };
}

const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => millis / 1000);

describe("HermesRunService", () => {
  it.live("discovers a profile's webhook route and suggests the repository it names", () => {
    const hermes = makeHermesHome();
    const { layer } = makeLayer(hermes.root);
    return Effect.gen(function* () {
      const service = yield* HermesRunService.HermesRunService;
      const listed = yield* service.listSources;
      expect(listed.hermesEnabled).toBe(true);
      expect(listed.sources).toMatchObject([
        {
          profile: "upstream-sync",
          sourceKey: "webhook:upstream-sync",
          kind: "webhook",
          label: "upstream-sync",
          detail: "issues",
          configured: true,
          projectId: null,
          suggestedProjectId: PROJECT_ID,
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("mirrors a switched-on source's run from start to finish, once", () => {
    const hermes = makeHermesHome();
    const { layer, dispatched, written, itemEvents } = makeLayer(hermes.root);
    return Effect.gen(function* () {
      const service = yield* HermesRunService.HermesRunService;
      const switchedOn = yield* service.setSource({
        profile: "upstream-sync",
        sourceKey: "webhook:upstream-sync",
        projectId: PROJECT_ID,
      });
      expect(switchedOn.sources[0]?.projectId).toBe(PROJECT_ID);

      const startedAt = (yield* nowSeconds) + 1;
      hermes.withDb((db) => {
        insertHermesSession(db, {
          id: "run-1",
          source: "webhook",
          route: "upstream-sync",
          startedAt,
          toolCallCount: 1,
          model: "gpt-5.6-sol",
          billingProvider: "openai-codex",
        });
        insertHermesMessage(db, {
          sessionId: "run-1",
          role: "user",
          content: "Resolve the upstream conflict",
          timestamp: startedAt,
        });
        insertHermesMessage(db, {
          sessionId: "run-1",
          role: "assistant",
          toolCalls: [{ id: "call-1", name: "terminal", args: { command: "gh pr create --fill" } }],
          timestamp: startedAt + 1,
        });
        insertHermesMessage(db, {
          sessionId: "run-1",
          role: "tool",
          toolCallId: "call-1",
          content: JSON.stringify({
            output: "https://github.com/NateWeav/t3code-hermes/pull/72",
            exit_code: 0,
          }),
          timestamp: startedAt + 2,
        });
      });

      yield* service.sync;
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.hermes-run.set",
        "thread.pull-request.link",
      ]);
      expect(dispatched[0]).toMatchObject({
        modelSelection: { model: "openai-codex:gpt-5.6-sol" },
        createdBy: "system",
      });
      expect(dispatched[1]).toMatchObject({
        hermesRun: { profile: "upstream-sync", sourceLabel: "webhook/upstream-sync", live: true },
      });
      expect(dispatched[2]).toMatchObject({ repository: "nateweav/t3code-hermes", number: 72 });
      expect(written.map((event) => event.type)).toEqual([
        "message.updated",
        "turn-item.updated",
        "turn-item.updated",
        "turn-item.updated",
      ]);
      expect(itemEvents().map((item) => [item.type, item.status, item.runId])).toEqual([
        ["user_message", "completed", null],
        ["command_execution", "running", null],
        ["command_execution", "completed", null],
      ]);

      hermes.withDb((db) => {
        insertHermesMessage(db, {
          sessionId: "run-1",
          role: "assistant",
          content: "Blocked: ChatComposer.tsx needs your call. PR left open.",
          timestamp: startedAt + 3,
        });
        db.prepare(
          "UPDATE sessions SET ended_at = ?, end_reason = 'webhook_complete' WHERE id = 'run-1'",
        ).run(startedAt + 4);
      });
      dispatched.length = 0;
      written.length = 0;
      yield* service.sync;
      expect(itemEvents().map((item) => item.type)).toEqual(["assistant_message"]);
      expect(dispatched).toMatchObject([
        { type: "thread.hermes-run.set", hermesRun: { live: false } },
      ]);

      dispatched.length = 0;
      written.length = 0;
      yield* service.sync;
      expect(dispatched).toEqual([]);
      expect(written).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("never creates a thread for a run that had nothing to report", () => {
    const hermes = makeHermesHome();
    const { layer, dispatched, written } = makeLayer(hermes.root);
    return Effect.gen(function* () {
      const service = yield* HermesRunService.HermesRunService;
      yield* service.setSource({
        profile: "upstream-sync",
        sourceKey: "webhook:upstream-sync",
        projectId: PROJECT_ID,
      });
      const startedAt = (yield* nowSeconds) + 1;
      hermes.withDb((db) => {
        insertHermesSession(db, {
          id: "run-quiet",
          source: "webhook",
          route: "upstream-sync",
          startedAt,
          endedAt: startedAt + 2,
          endReason: "webhook_complete",
          toolCallCount: 1,
        });
        insertHermesMessage(db, {
          sessionId: "run-quiet",
          role: "assistant",
          toolCalls: [{ id: "call-q", name: "terminal", args: { command: "git fetch" } }],
          timestamp: startedAt,
        });
        insertHermesMessage(db, {
          sessionId: "run-quiet",
          role: "assistant",
          content: "[SILENT]",
          timestamp: startedAt + 1,
        });
      });
      yield* service.sync;
      expect(dispatched).toEqual([]);
      expect(written).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("finishes a run that was live across a restart without rewriting its transcript", () => {
    const hermes = makeHermesHome();
    const thread = liveThread("run-restart");
    // The source is no longer switched on: the run must still finish.
    const { layer, dispatched, itemEvents } = makeLayer(hermes.root, {
      liveThreads: [thread],
      // The first message was mirrored before the restart.
      existingItems: [
        {
          id: `${thread.id}:m1`,
          threadId: thread.id,
          status: "completed",
        } as unknown as OrchestrationV2TurnItem,
      ],
    });
    return Effect.gen(function* () {
      const startedAt = (yield* nowSeconds) - 60;
      hermes.withDb((db) => {
        insertHermesSession(db, {
          id: "run-restart",
          source: "webhook",
          route: "upstream-sync",
          startedAt,
          endedAt: startedAt + 30,
          endReason: "webhook_complete",
          toolCallCount: 1,
        });
        insertHermesMessage(db, {
          sessionId: "run-restart",
          role: "assistant",
          content: "Looking at the conflict.",
          timestamp: startedAt + 10,
        });
        insertHermesMessage(db, {
          sessionId: "run-restart",
          role: "assistant",
          content: "Needs your call on the composer.",
          timestamp: startedAt + 20,
        });
      });
      const service = yield* HermesRunService.HermesRunService;
      yield* service.sync;
      expect(itemEvents().map((item) => item.id)).toEqual([`${thread.id}:m2`]);
      expect(dispatched).toMatchObject([
        { type: "thread.hermes-run.set", threadId: thread.id, hermesRun: { live: false } },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("refuses to switch on a route Hermes does not have", () => {
    const hermes = makeHermesHome();
    const { layer } = makeLayer(hermes.root);
    return Effect.gen(function* () {
      const service = yield* HermesRunService.HermesRunService;
      const error = yield* Effect.flip(
        service.setSource({
          profile: "upstream-sync",
          sourceKey: "webhook:no-such-route",
          projectId: PROJECT_ID,
        }),
      );
      expect(error.reason).toBe("unknownSource");
    }).pipe(Effect.provide(layer));
  });

  it.live("refuses to switch a source on while Hermes is off", () => {
    const hermes = makeHermesHome();
    const { layer } = makeLayer(hermes.root, { hermesEnabled: false });
    return Effect.gen(function* () {
      const service = yield* HermesRunService.HermesRunService;
      const error = yield* Effect.flip(
        service.setSource({
          profile: "upstream-sync",
          sourceKey: "webhook:upstream-sync",
          projectId: PROJECT_ID,
        }),
      );
      expect(error.reason).toBe("providerDisabled");
    }).pipe(Effect.provide(layer));
  });

  it.live("retries a run after a transient failure instead of dropping it", () => {
    const hermes = makeHermesHome();
    const { layer, dispatched, itemEvents } = makeLayer(hermes.root, { failFirstWrite: true });
    return Effect.gen(function* () {
      const service = yield* HermesRunService.HermesRunService;
      yield* service.setSource({
        profile: "upstream-sync",
        sourceKey: "webhook:upstream-sync",
        projectId: PROJECT_ID,
      });
      const startedAt = (yield* nowSeconds) + 1;
      hermes.withDb((db) => {
        insertHermesSession(db, {
          id: "run-flaky",
          source: "webhook",
          route: "upstream-sync",
          startedAt,
          endedAt: startedAt + 5,
          endReason: "webhook_complete",
          toolCallCount: 1,
        });
        insertHermesMessage(db, {
          sessionId: "run-flaky",
          role: "assistant",
          toolCalls: [{ id: "call-f", name: "terminal", args: { command: "git fetch" } }],
          timestamp: startedAt + 1,
        });
        insertHermesMessage(db, {
          sessionId: "run-flaky",
          role: "assistant",
          content: "Done.",
          timestamp: startedAt + 2,
        });
      });
      yield* service.sync;
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.hermes-run.set",
      ]);
      expect(itemEvents()).toEqual([]);
      yield* service.sync;
      expect(itemEvents().map((item) => item.type)).toEqual([
        "command_execution",
        "assistant_message",
      ]);
      expect(dispatched.at(-1)).toMatchObject({
        type: "thread.hermes-run.set",
        hermesRun: { live: false },
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("ends a live run once Hermes is turned off, so replies unlock", () => {
    const hermes = makeHermesHome();
    const { layer, dispatched, itemEvents } = makeLayer(hermes.root, {
      hermesEnabled: false,
      liveThreads: [liveThread("run-off")],
    });
    return Effect.gen(function* () {
      const service = yield* HermesRunService.HermesRunService;
      yield* service.sync;
      expect(itemEvents()).toMatchObject([
        { type: "system_notice", message: "Hermes was turned off before this run finished." },
      ]);
      expect(dispatched).toMatchObject([
        { type: "thread.hermes-run.set", hermesRun: { live: false } },
      ]);
      // Once per off period: later passes read nothing and dispatch nothing.
      dispatched.length = 0;
      yield* service.sync;
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("ends a run whose profile store disappears mid-run", () => {
    const hermes = makeHermesHome();
    const { layer, dispatched, itemEvents } = makeLayer(hermes.root);
    return Effect.gen(function* () {
      const service = yield* HermesRunService.HermesRunService;
      yield* service.setSource({
        profile: "upstream-sync",
        sourceKey: "webhook:upstream-sync",
        projectId: PROJECT_ID,
      });
      const startedAt = (yield* nowSeconds) + 1;
      hermes.withDb((db) => {
        insertHermesSession(db, {
          id: "run-gone",
          source: "webhook",
          route: "upstream-sync",
          startedAt,
          toolCallCount: 1,
        });
        insertHermesMessage(db, {
          sessionId: "run-gone",
          role: "assistant",
          toolCalls: [{ id: "call-g", name: "terminal", args: { command: "git fetch" } }],
          timestamp: startedAt,
        });
      });
      yield* service.sync;
      expect(dispatched.some((command) => command.type === "thread.create")).toBe(true);
      NodeFS.rmSync(NodePath.join(hermes.home, "state.db"));
      dispatched.length = 0;
      yield* service.sync;
      expect(itemEvents().at(-1)).toMatchObject({
        type: "system_notice",
        message: "Its Hermes profile no longer exists.",
      });
      expect(dispatched).toMatchObject([
        { type: "thread.hermes-run.set", hermesRun: { live: false } },
      ]);
    }).pipe(Effect.provide(layer));
  });
});
