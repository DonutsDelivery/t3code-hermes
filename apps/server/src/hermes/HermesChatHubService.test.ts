// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { HERMES_STATE_DDL, insertHermesGatewaySession } from "./hermesRunFixtures.ts";
import * as HermesChatHubService from "./HermesChatHubService.ts";

const HUB_THREAD = ThreadId.make("thread-hub");
const OTHER_THREAD = ThreadId.make("thread-other");

/** A hub as the settings carry it, in channel `111` by default. */
function hubSettings(overrides: Record<string, unknown> = {}) {
  return {
    id: "gaming",
    name: "Gaming",
    threadId: HUB_THREAD,
    channels: ["111"],
    autoLink: true,
    autoLinkCap: 5,
    ...overrides,
  };
}

/**
 * A Hermes home whose default profile owns one gateway conversation per
 * channel, plus the links file the gateway appends to.
 */
function makeHermesHome() {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-hubs-"));
  const dbPath = NodePath.join(home, "state.db");
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    db.exec(HERMES_STATE_DDL);
  } finally {
    db.close();
  }
  const withDb = (write: (db: NodeSqlite.DatabaseSync) => void) => {
    const handle = new NodeSqlite.DatabaseSync(dbPath);
    try {
      write(handle);
    } finally {
      handle.close();
    }
  };
  return {
    home,
    withDb,
    /** A keyed gateway session whose origin names the given platform channels. */
    conversation: (
      sessionKey: string,
      options: {
        readonly channelIds?: readonly string[];
        readonly startedAt: number;
        readonly lastActivityAt?: number;
        readonly title?: string;
      },
    ) =>
      withDb((db) =>
        insertHermesGatewaySession(db, {
          id: sessionKey,
          sessionKey,
          startedAt: options.startedAt,
          lastActivityAt: options.lastActivityAt ?? null,
          title: options.title ?? null,
          originJson: JSON.stringify({
            platform: "discord",
            chat_type: "thread",
            chat_id: options.channelIds?.[0] ?? null,
            user_name: "Yato",
          }),
        }),
      ),
    /** Bumps a conversation's newest activity, as a new message would. */
    touch: (sessionKey: string, at: number) =>
      withDb((db) =>
        db
          .prepare("UPDATE sessions SET last_activity_at = ? WHERE session_key = ?")
          .run(at, sessionKey),
      ),
    appendLink: (line: Record<string, unknown>) =>
      NodeFS.appendFileSync(NodePath.join(home, "t3-hub-links.jsonl"), `${JSON.stringify(line)}\n`),
    cleanup: () => NodeFS.rmSync(home, { recursive: true, force: true }),
  };
}

function makeLayer(
  home: string,
  options: {
    readonly hermesEnabled?: boolean;
    readonly hubs?: ReadonlyArray<Record<string, unknown>>;
    /** Items the threads already hold, as the projection would return them. */
    readonly existingItems?: ReadonlyArray<OrchestrationV2TurnItem>;
    /** Fails every mark-unread, as a hub thread with no completed run would. */
    readonly rejectMarkUnread?: boolean;
  } = {},
) {
  const dispatched: OrchestrationV2ServerCommand[] = [];
  const written: OrchestrationV2DomainEvent[] = [];
  const items = new Map((options.existingItems ?? []).map((item) => [item.id, item]));
  let ordinal = 0;
  const dependencies = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        Effect.suspend(() => {
          if (command.type === "thread.mark-unread" && (options.rejectMarkUnread ?? false)) {
            return Effect.fail(
              new Orchestrator.OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause: `Thread ${command.threadId} has no completed run to mark unread.`,
              }),
            );
          }
          dispatched.push(command);
          return Effect.succeed({ sequence: dispatched.length, storedEvents: [] });
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: (threadId: string) =>
        Effect.sync(
          () =>
            ({
              thread: null,
              turnItems: [...items.values()].filter((item) => item.threadId === threadId),
            }) as never,
        ),
    }),
    Layer.mock(EventSink.EventSinkV2)({
      write: ({ events }) =>
        Effect.sync(() => {
          for (const event of events) {
            written.push(event);
            if (event.type === "turn-item.updated") items.set(event.payload.id, event.payload);
          }
          return [];
        }),
    }),
    Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
      normalize: (item) => Effect.sync(() => ({ ...item, ordinal: (ordinal += 1) })),
    }),
    ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make("hermes")]: {
          driver: ProviderDriverKind.make("hermes"),
          enabled: options.hermesEnabled ?? true,
          environment: [{ name: "HERMES_HOME", value: home, sensitive: false }],
        },
      },
      integrations: { hermesHubs: options.hubs ?? [hubSettings()] },
    }),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-hermes-hubs-" }),
  );
  return {
    dispatched,
    written,
    itemEvents: () =>
      written.flatMap((event) => (event.type === "turn-item.updated" ? [event.payload] : [])),
    /** Written hub cards, narrowed to the notification items they always are. */
    cardEvents: () =>
      written.flatMap((event) =>
        event.type === "turn-item.updated" && event.payload.type === "notification"
          ? [event.payload]
          : [],
      ),
    layer: HermesChatHubService.layer.pipe(
      Layer.provide(dependencies),
      Layer.provide(NodeServices.layer),
    ),
  };
}

const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => millis / 1000);

describe("HermesChatHubService", () => {
  it.live("turns a links-file line into a hub link and a card that follows activity", () => {
    const hermes = makeHermesHome();
    const KEY = "agent:main:discord:thread:111:111";
    const { layer, dispatched, itemEvents } = makeLayer(hermes.home);
    return Effect.gen(function* () {
      const service = yield* HermesChatHubService.HermesChatHubService;
      const startedAt = (yield* nowSeconds) - 60;
      hermes.conversation(KEY, { channelIds: ["111"], startedAt, title: "Fix my lag" });
      hermes.appendLink({ sessionKey: KEY, hub: "Gaming", at: "2026-10-01T00:00:00Z" });

      yield* service.sync;
      const [card] = itemEvents();
      expect(card).toMatchObject({
        id: `${HUB_THREAD}:hermes-chat:${KEY}`,
        threadId: HUB_THREAD,
        runId: null,
        type: "notification",
        source: { kind: "hermes_chat", sessionKey: KEY },
        outcome: "updated",
        // A Discord thread's card takes the thread's own name, as the panel does.
        summary: "help",
      });
      // A conversation with no messages carries no detail, and no detail key.
      expect(card).not.toHaveProperty("detail");
      expect(dispatched).toMatchObject([{ type: "thread.mark-unread", threadId: HUB_THREAD }]);

      // Nothing moved: the next pass writes and dispatches nothing.
      dispatched.length = 0;
      yield* service.sync;
      expect(itemEvents()).toHaveLength(1);
      expect(dispatched).toEqual([]);

      // The conversation moved: the same card is edited in place and the
      // thread is marked unread again.
      hermes.touch(KEY, startedAt + 30);
      dispatched.length = 0;
      yield* service.sync;
      expect(itemEvents().map((item) => item.id)).toEqual([
        `${HUB_THREAD}:hermes-chat:${KEY}`,
        `${HUB_THREAD}:hermes-chat:${KEY}`,
      ]);
      expect(itemEvents()[1]).toMatchObject({ summary: "help" });
      expect(dispatched).toMatchObject([{ type: "thread.mark-unread", threadId: HUB_THREAD }]);
    }).pipe(
      Effect.provide(layer),
      // The home only goes away once the effect settles: a plain try/finally
      // in the callback would delete it before vitest even runs the effect.
      Effect.ensuring(Effect.sync(() => hermes.cleanup())),
    );
  });

  it.live("ignores link lines whose conversation is outside the hub or window", () => {
    const hermes = makeHermesHome();
    const IN_HUB = "agent:main:discord:thread:111:111";
    const OTHER_CHANNEL = "agent:main:discord:thread:555:555";
    const { layer, dispatched, itemEvents } = makeLayer(hermes.home, {
      hubs: [hubSettings({ autoLink: false })],
    });
    return Effect.gen(function* () {
      const service = yield* HermesChatHubService.HermesChatHubService;
      const startedAt = (yield* nowSeconds) - 60;
      hermes.conversation(IN_HUB, { channelIds: ["111"], startedAt });
      hermes.conversation(OTHER_CHANNEL, { channelIds: ["555"], startedAt });
      // A conversation whose channel the hub does not name.
      hermes.appendLink({ sessionKey: OTHER_CHANNEL, hub: "gaming" });
      // A conversation the window never saw at all.
      hermes.appendLink({ sessionKey: "agent:main:discord:dm:999", hub: "gaming" });
      // A hub no settings define.
      hermes.appendLink({ sessionKey: IN_HUB, hub: "no-such-hub" });

      yield* service.sync;
      expect(itemEvents()).toEqual([]);
      expect(dispatched).toEqual([]);
      const listed = yield* service.listHubs;
      expect(listed.hubs).toMatchObject([{ id: "gaming", linkedCount: 0 }]);

      // The same guards must not stop a valid line read later.
      hermes.appendLink({ sessionKey: IN_HUB, hub: "gaming" });
      yield* service.sync;
      expect(itemEvents()).toHaveLength(1);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => hermes.cleanup())));
  });

  it.live("auto-links a hub's newest conversations up to its cap, once each", () => {
    const hermes = makeHermesHome();
    const A = "agent:main:discord:group:111:a";
    const B = "agent:main:discord:group:111:b";
    const C = "agent:main:discord:group:111:c";
    const { layer, dispatched, itemEvents } = makeLayer(hermes.home, {
      hubs: [hubSettings({ autoLinkCap: 2 })],
    });
    return Effect.gen(function* () {
      const service = yield* HermesChatHubService.HermesChatHubService;
      const startedAt = (yield* nowSeconds) - 3_600;
      hermes.conversation(A, { channelIds: ["111"], startedAt, lastActivityAt: startedAt + 10 });
      hermes.conversation(B, { channelIds: ["111"], startedAt, lastActivityAt: startedAt + 20 });
      hermes.conversation(C, { channelIds: ["111"], startedAt, lastActivityAt: startedAt + 30 });

      yield* service.sync;
      // Only the two newest conversations fit under the cap.
      expect(itemEvents().map((item) => item.id)).toEqual([
        `${HUB_THREAD}:hermes-chat:${C}`,
        `${HUB_THREAD}:hermes-chat:${B}`,
      ]);
      const listed = yield* service.listHubs;
      expect(listed.hubs).toMatchObject([{ id: "gaming", linkedCount: 2 }]);

      // The next pass is quiet: same activity, same cards.
      dispatched.length = 0;
      yield* service.sync;
      expect(itemEvents()).toHaveLength(2);
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => hermes.cleanup())));
  });

  it.live("seeds cards the hub thread already holds after a restart", () => {
    const hermes = makeHermesHome();
    const KEY = "agent:main:discord:group:111:a";
    const first = makeLayer(hermes.home);
    return Effect.gen(function* () {
      const service = yield* HermesChatHubService.HermesChatHubService;
      const startedAt = (yield* nowSeconds) - 600;
      hermes.conversation(KEY, { channelIds: ["111"], startedAt, lastActivityAt: startedAt });
      yield* service.sync;
      const seeded = first.itemEvents();
      expect(seeded).toHaveLength(1);

      // A fresh process: the projection already returns the card, so the
      // restart must not rewrite it.
      const restarted = makeLayer(hermes.home, { existingItems: seeded });
      const again = yield* HermesChatHubService.HermesChatHubService.pipe(
        Effect.provide(restarted.layer),
      );
      yield* again.sync;
      expect(restarted.itemEvents()).toEqual([]);
      expect(restarted.dispatched).toEqual([]);
    }).pipe(Effect.provide(first.layer), Effect.ensuring(Effect.sync(() => hermes.cleanup())));
  });

  it.live("logs and survives a mark-unread a hub thread without runs rejects", () => {
    const hermes = makeHermesHome();
    const KEY = "agent:main:discord:group:111:a";
    const { layer, itemEvents } = makeLayer(hermes.home, { rejectMarkUnread: true });
    return Effect.gen(function* () {
      const service = yield* HermesChatHubService.HermesChatHubService;
      const startedAt = (yield* nowSeconds) - 600;
      hermes.conversation(KEY, { channelIds: ["111"], startedAt, lastActivityAt: startedAt });
      yield* service.sync;
      // The rejection is logged, not surfaced: the card still landed.
      expect(itemEvents()).toHaveLength(1);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => hermes.cleanup())));
  });

  it.live("links and unlinks manually, detaching every thread at once", () => {
    const hermes = makeHermesHome();
    const KEY = "agent:main:discord:group:111:a";
    const { layer, itemEvents, cardEvents } = makeLayer(hermes.home, {
      hubs: [hubSettings({ autoLink: false })],
    });
    return Effect.gen(function* () {
      const service = yield* HermesChatHubService.HermesChatHubService;
      const startedAt = (yield* nowSeconds) - 600;
      hermes.conversation(KEY, { channelIds: ["111"], startedAt, lastActivityAt: startedAt });

      const linked = yield* service.link({ sessionKey: KEY, threadId: OTHER_THREAD });
      expect(linked.links).toMatchObject([
        { sessionKey: KEY, threadId: OTHER_THREAD, source: "manual" },
      ]);
      expect(linked.links[0]?.linkedAt).toEqual(expect.any(String));
      yield* service.sync;
      expect(itemEvents().map((item) => item.threadId)).toEqual([OTHER_THREAD]);

      // A links-file link adds the hub thread's own manual link; an unlink
      // line removes exactly that link and takes its card down.
      hermes.appendLink({ sessionKey: KEY, hub: "gaming" });
      yield* service.sync;
      expect(itemEvents()).toHaveLength(2);
      hermes.appendLink({ sessionKey: KEY, hub: "gaming", action: "unlink" });
      yield* service.sync;
      const effective = yield* service.effectiveLinkedConversations;
      expect(effective).toEqual([
        {
          threadId: OTHER_THREAD,
          sessionKey: KEY,
          source: "manual",
          activityAt: expect.any(Number),
        },
      ]);
      expect(cardEvents().map((item) => [item.threadId, item.outcome])).toEqual([
        [OTHER_THREAD, "updated"],
        [HUB_THREAD, "updated"],
        [HUB_THREAD, "cancelled"],
      ]);

      // Unlinking without a thread detaches every thread at once.
      const detached = yield* service.unlink({ sessionKey: KEY });
      expect(detached.links).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => hermes.cleanup())));
  });

  it.live("detaching a hub card takes it down, keeps it out, and a re-link brings it back", () => {
    const hermes = makeHermesHome();
    const KEY = "agent:main:discord:thread:111:a";
    const { layer, itemEvents, cardEvents } = makeLayer(hermes.home, {
      hubs: [hubSettings({ autoLinkCap: 1 })],
    });
    return Effect.gen(function* () {
      const service = yield* HermesChatHubService.HermesChatHubService;
      const startedAt = (yield* nowSeconds) - 600;
      hermes.conversation(KEY, { channelIds: ["111"], startedAt, lastActivityAt: startedAt });
      hermes.conversation("older", { channelIds: ["111"], startedAt: startedAt - 60 });
      yield* service.sync;
      expect(cardEvents().map((item) => [item.id, item.outcome])).toEqual([
        [`${HUB_THREAD}:hermes-chat:${KEY}`, "updated"],
      ]);

      // Detach: the card is rewritten as cancelled, and the cap's next
      // newest conversation fills the slot instead.
      const detached = yield* service.unlink({ sessionKey: KEY, threadId: HUB_THREAD });
      expect(detached.links.map((link) => link.sessionKey)).toEqual(["older"]);
      yield* service.sync;
      expect(
        cardEvents()
          .slice(1)
          .map((item) => [item.id, item.outcome]),
      ).toEqual([
        [`${HUB_THREAD}:hermes-chat:older`, "updated"],
        [`${HUB_THREAD}:hermes-chat:${KEY}`, "cancelled"],
      ]);

      // New activity does not bring a detached conversation back.
      hermes.touch(KEY, startedAt + 30);
      yield* service.sync;
      expect(itemEvents()).toHaveLength(3);

      // Linking it again does, as a live card.
      yield* service.link({ sessionKey: KEY, threadId: HUB_THREAD });
      yield* service.sync;
      expect(cardEvents().at(-1)).toMatchObject({
        id: `${HUB_THREAD}:hermes-chat:${KEY}`,
        outcome: "updated",
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => hermes.cleanup())));
  });

  it.live("names a card by its Discord thread rather than Hermes's placeholder title", () => {
    const hermes = makeHermesHome();
    const KEY = "agent:main:discord:thread:111:b";
    const { layer, itemEvents, cardEvents } = makeLayer(hermes.home);
    return Effect.gen(function* () {
      const service = yield* HermesChatHubService.HermesChatHubService;
      const startedAt = (yield* nowSeconds) - 60;
      hermes.conversation(KEY, {
        channelIds: ["111"],
        startedAt,
        title: "[Triggering message id: `1`] hey",
      });
      hermes.withDb((db) =>
        db
          .prepare("UPDATE sessions SET display_name = ?, chat_type = ? WHERE session_key = ?")
          .run("Guild / #general / get nick a girlfriend", "thread", KEY),
      );
      yield* service.sync;
      expect(cardEvents()[0]?.summary).toBe("get nick a girlfriend");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => hermes.cleanup())));
  });
});
