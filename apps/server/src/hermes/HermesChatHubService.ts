/**
 * Thread hubs for Hermes gateway conversations: cards in a pinned thread, linked from the gateway's
 * links file, auto-linking caps, or the client. Cards are written to the event sink (never
 * `message.dispatch`) and rewritten only when activity moves. Manual links persist atomically; hub
 * links are derived. Polls every 30s idle, 5s after a change.
 */
import {
  CommandId,
  EventId,
  ThreadId,
  TurnItemId,
  type HermesChatHubsResult,
  type HermesChatLinkInput,
  type HermesChatLinksResult,
  type HermesChatUnlinkInput,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveEnabledHermesInstance, resolveHermesHome } from "./hermesCronState.ts";
import {
  readHermesChatChannels,
  readHermesChatTranscript,
  type HermesChatChannelsRow,
} from "./hermesChatState.ts";
import {
  conversationInHub,
  effectiveLinkedConversations,
  fnv1a,
  makeHermesHubLinksTailer,
  type EffectiveHermesChatLink,
  type HermesHubLinksTailer,
} from "./hermesChatHubs.ts";

const STATE_FILENAME = "hermes-chat-links.json";
/** File the gateway appends link requests to, under the Hermes home. */
const LINKS_FILENAME = "t3-hub-links.jsonl";
const IDLE_INTERVAL = Duration.seconds(30);
const AFTER_CHANGE_INTERVAL = Duration.seconds(5);
/** Conversations older than this leave the hub window, like the chat list. */
const HUB_WINDOW_SECONDS = 30 * 24 * 60 * 60;
/** Longest card summary or detail line. */
const CARD_TEXT_MAX = 200;
/** Id prefix every hub card turn item carries, so restarts recognize their own. */
const CARD_ID_PREFIX = ":hermes-chat:";

const PersistedLink = Schema.Struct({
  threadId: Schema.String,
  sessionKey: Schema.String,
  linkedAt: Schema.String,
});
const PersistedDetached = Schema.Struct({
  threadId: Schema.String,
  sessionKey: Schema.String,
});
const PersistedState = Schema.Struct({
  version: Schema.Literal(1),
  links: Schema.Array(PersistedLink),
  detached: Schema.optional(Schema.Array(PersistedDetached)),
});
const PersistedStateJson = Schema.fromJsonString(PersistedState);
const decodePersistedState = Schema.decodeUnknownEffect(PersistedStateJson);
const encodePersistedState = Schema.encodeEffect(PersistedStateJson);

interface ManualLink {
  readonly threadId: ThreadId;
  readonly sessionKey: string;
  /** ISO. */
  readonly linkedAt: string;
}

function linkKey(threadId: ThreadId, sessionKey: string): string {
  return `${threadId}\u0000${sessionKey}`;
}

function clip(value: string): string {
  return value.length <= CARD_TEXT_MAX ? value : `${value.slice(0, CARD_TEXT_MAX - 1).trimEnd()}…`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The hub a links-file line names, by id first, then by name, case-insensitively. */
function resolveHub<T extends { id: string; name: string }>(
  hubs: readonly T[],
  named: string,
): T | null {
  const key = named.trim().toLowerCase();
  if (!key) return null;
  return (
    hubs.find((hub) => hub.id.toLowerCase() === key) ??
    hubs.find((hub) => hub.name.toLowerCase() === key) ??
    null
  );
}

// Hermes titles a fresh conversation from its trigger until it names it.
const PLACEHOLDER_TITLE = /^\[Triggering message id:/;

/**
 * A card's title, as the conversation panel names the same conversation
 * (client-runtime hermesChatConversationTitle): a Discord thread by its own
 * name, otherwise Hermes's title, otherwise the channel and who it is with.
 */
function cardTitle(conversation: {
  readonly title: string | null;
  readonly displayName: string | null;
  readonly userName: string | null;
  readonly chatType: string | null;
}): string | null {
  const title =
    conversation.title !== null && !PLACEHOLDER_TITLE.test(conversation.title)
      ? conversation.title
      : null;
  const place = conversation.displayName?.split(" / ").at(-1)?.trim() || null;
  if (conversation.chatType === "dm") return conversation.userName ?? title;
  if (conversation.chatType === "thread" && place) return place;
  if (title) return title;
  if (place && conversation.userName) return `${place} · ${conversation.userName}`;
  return place ?? conversation.userName;
}

/** Activity key of a card the thread already holds, from its updatedAt. */
function activityKeyFromUpdatedAt(updatedAt: DateTime.DateTime): string {
  return (DateTime.toEpochMillis(updatedAt) / 1000).toFixed(3);
}

/**
 * Written-state marker for a card that was taken down. Turn items cannot be
 * deleted, so a detached card is rewritten with outcome `cancelled` and clients
 * leave it out of the timeline.
 */
const DETACHED_CARD = "detached";
/** Written-state marker for a card whose text predates the current title rule. */
const STALE_CARD = "stale";

export class HermesChatHubService extends Context.Service<
  HermesChatHubService,
  {
    /** Every configured hub, with how many conversations currently sit in its thread. */
    readonly listHubs: Effect.Effect<HermesChatHubsResult>;
    /** Links a gateway conversation's card into a thread. */
    readonly link: (input: HermesChatLinkInput) => Effect.Effect<HermesChatLinksResult>;
    /** Detaches a conversation's card; every thread's when threadId is omitted. */
    readonly unlink: (input: HermesChatUnlinkInput) => Effect.Effect<HermesChatLinksResult>;
    /** Every link that currently holds, manual and hub-derived. */
    readonly links: Effect.Effect<HermesChatLinksResult>;
    /** The links that currently hold: manual plus hub-derived, newest activity first. */
    readonly effectiveLinkedConversations: Effect.Effect<ReadonlyArray<EffectiveHermesChatLink>>;
    /** One watcher pass: tail the links file, then write cards that moved. */
    readonly sync: Effect.Effect<void>;
    /** Starts the watcher loop. Called once from the orchestration reactor. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3-hermes/hermes/HermesChatHubService") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;

  const statePath = path.join(config.stateDir, STATE_FILENAME);
  const stateMutex = yield* Semaphore.make(1);
  const wake = yield* Queue.sliding<void>(1);

  /** Manual links, keyed `${threadId}\u0000${sessionKey}`. Hub links are never stored. */
  const manualLinks = new Map<string, ManualLink>();
  /**
   * Hub derivations the user detached, same keys. Without this an auto-linking
   * hub would derive the conversation straight back on the next pass.
   */
  const detachedLinks = new Map<
    string,
    { readonly threadId: ThreadId; readonly sessionKey: string }
  >();
  /** Manual links removed since the last pass, whose cards still need taking down. */
  const unlinkedCards = new Map<
    string,
    { readonly threadId: ThreadId; readonly sessionKey: string }
  >();
  /** Cards each thread already holds: item id → activity key. Seeded from the projection. */
  const writtenCards = new Map<ThreadId, Map<string, string>>();
  let unreadCounter = 0;

  // A missing or unreadable file means no links, the quiet side.
  yield* Effect.gen(function* () {
    const raw = yield* fs.readFileString(statePath).pipe(Effect.orElseSucceed(() => ""));
    if (!raw.trim()) return;
    const decoded = yield* decodePersistedState(raw).pipe(Effect.option);
    if (Option.isNone(decoded)) return;
    for (const entry of decoded.value.links) {
      const threadId = entry.threadId.trim();
      const sessionKey = entry.sessionKey.trim();
      if (!threadId || !sessionKey || !entry.linkedAt.trim()) continue;
      const link = { threadId: ThreadId.make(threadId), sessionKey, linkedAt: entry.linkedAt };
      manualLinks.set(linkKey(link.threadId, link.sessionKey), link);
    }
    for (const entry of decoded.value.detached ?? []) {
      const threadId = entry.threadId.trim();
      const sessionKey = entry.sessionKey.trim();
      if (!threadId || !sessionKey) continue;
      const detached = { threadId: ThreadId.make(threadId), sessionKey };
      detachedLinks.set(linkKey(detached.threadId, sessionKey), detached);
    }
  });

  const saveState = stateMutex.withPermits(1)(
    Effect.gen(function* () {
      const links = [...manualLinks.values()].map((link) => ({
        threadId: link.threadId as string,
        sessionKey: link.sessionKey,
        linkedAt: link.linkedAt,
      }));
      const detached = [...detachedLinks.values()].map((link) => ({
        threadId: link.threadId as string,
        sessionKey: link.sessionKey,
      }));
      const contents = yield* encodePersistedState({ version: 1, links, detached });
      yield* writeFileStringAtomically({ filePath: statePath, contents: `${contents}\n` }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    }).pipe(
      // The in-memory links stay authoritative for this process; a failed save
      // only costs them across a restart, so it is logged, not surfaced.
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not save Hermes chat links").pipe(
          Effect.annotateLogs({ statePath, cause }),
        ),
      ),
    ),
  );

  // Settings plus the Hermes home they resolve to, or null when settings fail.
  // `home` is null when Hermes is off: hubs still list, but nothing links.
  const settingsContext = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings === null) return null;
    const instance = resolveEnabledHermesInstance(settings);
    if (instance === null) return { settings, home: null as string | null };
    const environment = yield* mergeProviderInstanceEnvironment(instance.environment);
    return { settings, home: resolveHermesHome(environment) as string | null };
  });

  const channelsWindow = Effect.fn("HermesChatHubService.channelsWindow")(function* (
    home: string,
  ): Effect.fn.Return<readonly HermesChatChannelsRow[]> {
    const nowSeconds = (yield* Clock.currentTimeMillis) / 1000;
    const rows = yield* Effect.sync(() =>
      readHermesChatChannels(path.join(home, "state.db"), {
        sinceSeconds: nowSeconds - HUB_WINDOW_SECONDS,
      }),
    );
    return rows ?? [];
  });

  /** Manual links only, for when Hermes is off and nothing can be derived. */
  const manualLinksAsEffective = (): ReadonlyArray<EffectiveHermesChatLink> =>
    [...manualLinks.values()].map((link) => ({
      threadId: link.threadId,
      sessionKey: link.sessionKey,
      source: "manual" as const,
      activityAt: 0,
    }));

  const effectiveLinks: HermesChatHubService["Service"]["effectiveLinkedConversations"] =
    Effect.gen(function* () {
      const context = yield* settingsContext;
      if (context === null || context.home === null) return manualLinksAsEffective();
      const rows = yield* channelsWindow(context.home);
      return effectiveLinkedConversations({
        hubs: context.settings.integrations.hermesHubs,
        manualLinks: [...manualLinks.values()],
        detached: [...detachedLinks.values()],
        conversations: rows,
      });
    });

  const linksResult = Effect.gen(function* () {
    const linkedAtByKey = new Map(
      [...manualLinks.values()].map((link) => [
        linkKey(link.threadId, link.sessionKey),
        link.linkedAt,
      ]),
    );
    const links = yield* effectiveLinks;
    return {
      links: links.map((link) => ({
        sessionKey: link.sessionKey,
        threadId: link.threadId,
        source: link.source,
        linkedAt:
          link.source === "manual"
            ? (linkedAtByKey.get(linkKey(link.threadId, link.sessionKey)) ?? null)
            : null,
      })),
    } satisfies HermesChatLinksResult;
  });

  const listHubs: HermesChatHubService["Service"]["listHubs"] = Effect.gen(function* () {
    const context = yield* settingsContext;
    if (context === null) return { hubs: [] };
    const hubSettings = context.settings.integrations.hermesHubs;
    if (context.home === null) {
      // Nothing can be linked while Hermes is off, so nothing is.
      return { hubs: hubSettings.map((hub) => ({ ...hub, linkedCount: 0 })) };
    }
    const rows = yield* channelsWindow(context.home);
    const links = effectiveLinkedConversations({
      hubs: hubSettings,
      manualLinks: [...manualLinks.values()],
      detached: [...detachedLinks.values()],
      conversations: rows,
    });
    return {
      hubs: hubSettings.map((hub) => ({
        ...hub,
        linkedCount:
          hub.threadId === null ? 0 : links.filter((link) => link.threadId === hub.threadId).length,
      })),
    } satisfies HermesChatHubsResult;
  });

  const link: HermesChatHubService["Service"]["link"] = Effect.fn("HermesChatHubService.link")(
    function* (input) {
      const linkedAt = DateTime.formatIso(yield* DateTime.now);
      detachedLinks.delete(linkKey(input.threadId, input.sessionKey));
      manualLinks.set(linkKey(input.threadId, input.sessionKey), {
        threadId: input.threadId,
        sessionKey: input.sessionKey,
        linkedAt,
      });
      yield* saveState;
      // The card appears on the next pass; wake it now rather than waiting.
      yield* Queue.offer(wake, undefined);
      return yield* linksResult;
    },
  );

  const unlink: HermesChatHubService["Service"]["unlink"] = Effect.fn(
    "HermesChatHubService.unlink",
  )(function* (input) {
    // Hub-derived links are recomputed every pass, so detaching one has to be
    // remembered, or the hub would link the conversation straight back.
    const current = yield* effectiveLinks;
    for (const link of current) {
      if (link.sessionKey !== input.sessionKey) continue;
      if (input.threadId !== undefined && link.threadId !== input.threadId) continue;
      if (link.source === "hub") {
        detachedLinks.set(linkKey(link.threadId, link.sessionKey), {
          threadId: link.threadId,
          sessionKey: link.sessionKey,
        });
      }
    }
    for (const [key, link] of manualLinks) {
      if (link.sessionKey !== input.sessionKey) continue;
      if (input.threadId !== undefined && link.threadId !== input.threadId) continue;
      manualLinks.delete(key);
      unlinkedCards.set(key, { threadId: link.threadId, sessionKey: link.sessionKey });
    }
    yield* saveState;
    // The card comes down on the next pass; wake it now rather than waiting.
    yield* Queue.offer(wake, undefined);
    return yield* linksResult;
  });

  // ── Watcher ────────────────────────────────────────────────────────────

  // The gateway rejects a mark-unread for a thread with no completed run; the
  // card is still there, so that rejection is expected and only logged.
  const dispatch = (command: OrchestrationV2ServerCommand) =>
    orchestrator.dispatch(command).pipe(
      Effect.catchTags({
        OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
        OrchestratorDispatchError: (error) =>
          Effect.logWarning("Hermes chat hub could not mark its thread unread").pipe(
            Effect.annotateLogs({ cause: error.cause }),
          ),
      }),
      Effect.asVoid,
    );

  // One tailer per links file, so a moved HERMES_HOME starts a fresh offset.
  let tailerState: { readonly filePath: string; readonly tailer: HermesHubLinksTailer } | null =
    null;
  const linksTailer = (home: string) => {
    const filePath = path.join(home, LINKS_FILENAME);
    if (tailerState?.filePath !== filePath) {
      tailerState = { filePath, tailer: makeHermesHubLinksTailer(filePath) };
    }
    return tailerState.tailer;
  };

  /**
   * Cards a thread already holds: item id → activity key, or DETACHED_CARD.
   * Seeded from the projection on first use, so a restart never rewrites a
   * card the thread already has.
   */
  const writtenFor = Effect.fn("HermesChatHubService.writtenFor")(function* (threadId: ThreadId) {
    const known = writtenCards.get(threadId);
    if (known !== undefined) return known;
    const records = yield* projections.getThreadRecords(threadId, ["turnItems"], {
      turnItemRunIds: [null],
    });
    const seeded = new Map(
      records.turnItems
        .filter((item) => item.id.startsWith(`${threadId}${CARD_ID_PREFIX}`))
        .map((item) => [
          item.id as string,
          item.type === "notification" && item.outcome === "cancelled"
            ? DETACHED_CARD
            : // Cards written before titles skipped Hermes's placeholder
              // get one rewrite to pick up the conversation's real name.
              item.type === "notification" && PLACEHOLDER_TITLE.test(item.summary)
              ? STALE_CARD
              : activityKeyFromUpdatedAt(item.updatedAt),
        ]),
    );
    writtenCards.set(threadId, seeded);
    return seeded;
  });

  /** One pass. Returns whether anything changed, which shortens the next tick. */
  const pass = Effect.gen(function* () {
    const context = yield* settingsContext;
    if (context === null) return false;
    const hubSettings = context.settings.integrations.hermesHubs;
    // With no hub configured there is nothing to link, tail, or write.
    if (hubSettings.length === 0 || context.home === null) return false;
    const home = context.home;

    let changed = false;
    let stateDirty = false;
    const rows = yield* channelsWindow(home);

    // Links-file lines become manual links to the named hub's thread. Guards:
    // the hub must exist and have a thread, and for links the conversation
    // must sit in the window with a channel the hub names.
    const tail = linksTailer(home).read();
    if (tail.skipped > 0) {
      yield* Effect.logWarning("Hermes hub links file had unreadable lines").pipe(
        Effect.annotateLogs({ filePath: path.join(home, LINKS_FILENAME), skipped: tail.skipped }),
      );
    }
    const ignore = (sessionKey: string, hub: string, reason: string) =>
      Effect.logWarning("Hermes hub link line ignored").pipe(
        Effect.annotateLogs({ sessionKey, hub, reason }),
      );
    for (const line of tail.lines) {
      const hub = resolveHub(hubSettings, line.hub);
      if (hub === null) {
        yield* ignore(line.sessionKey, line.hub, "unknownHub");
        continue;
      }
      if (hub.threadId === null) {
        yield* ignore(line.sessionKey, line.hub, "hubHasNoThread");
        continue;
      }
      if (line.action === "unlink") {
        const key = linkKey(hub.threadId, line.sessionKey);
        if (manualLinks.delete(key)) {
          unlinkedCards.set(key, { threadId: hub.threadId, sessionKey: line.sessionKey });
          stateDirty = true;
          changed = true;
        }
        continue;
      }
      const row = rows.find((entry) => entry.sessionKey === line.sessionKey);
      if (row === undefined) {
        yield* ignore(line.sessionKey, line.hub, "conversationNotInWindow");
        continue;
      }
      if (!conversationInHub(row, hub)) {
        yield* ignore(line.sessionKey, line.hub, "channelNotInHub");
        continue;
      }
      const linkedAt = line.at?.trim() || DateTime.formatIso(yield* DateTime.now);
      detachedLinks.delete(linkKey(hub.threadId, line.sessionKey));
      manualLinks.set(linkKey(hub.threadId, line.sessionKey), {
        threadId: hub.threadId,
        sessionKey: line.sessionKey,
        linkedAt,
      });
      stateDirty = true;
      changed = true;
    }
    if (stateDirty) yield* saveState;

    // Cards: one per effective link, written or edited only when its
    // conversation's activity moved since the thread last held it.
    const links = effectiveLinkedConversations({
      hubs: hubSettings,
      manualLinks: [...manualLinks.values()],
      detached: [...detachedLinks.values()],
      conversations: rows,
    });
    const dbPath = path.join(home, "state.db");
    const events: OrchestrationV2DomainEvent[] = [];
    const nowMillis = yield* Clock.currentTimeMillis;
    const pending: Array<{ readonly item: OrchestrationV2TurnItem; readonly activityKey: string }> =
      [];
    const unreadThreads = new Set<ThreadId>();
    for (const link of links) {
      const row = rows.find((entry) => entry.sessionKey === link.sessionKey);
      if (row === undefined) continue;
      const activityKey = row.lastActivityAt.toFixed(3);
      const itemId = TurnItemId.make(`${link.threadId}${CARD_ID_PREFIX}${link.sessionKey}`);
      const written = yield* writtenFor(link.threadId);
      const previous = written.get(itemId);
      if (previous === activityKey) continue;

      // The conversation's detail is only worth a read once it moved.
      const detail = yield* Effect.sync(() => readHermesChatTranscript(dbPath, link.sessionKey, 0));
      const conversation = detail?.conversation ?? null;
      if (conversation === null) continue;
      const summary = clip(oneLine(cardTitle(conversation) ?? link.sessionKey));
      const preview = conversation.latestMessagePreview;
      const at = DateTime.makeUnsafe(Math.round(row.lastActivityAt * 1000));
      const item: OrchestrationV2TurnItem = {
        id: itemId,
        threadId: link.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        // Placed by the turn item position store when the item is written.
        ordinal: 0,
        status: "completed",
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        type: "notification",
        source: { kind: "hermes_chat", sessionKey: link.sessionKey },
        outcome: "updated",
        summary,
        ...(preview === null ? {} : { detail: clip(oneLine(preview)) }),
      };
      const placed = yield* positions.normalize(item);
      events.push({
        // A re-link can land on the activity a card had before it was
        // detached, so its event id needs more than the content to be new.
        id: EventId.make(
          `${itemId}:${activityKey}:${fnv1a(`${summary}|${preview ?? ""}`)}${
            previous === DETACHED_CARD ? `:relinked:${nowMillis}` : ""
          }`,
        ),
        type: "turn-item.updated",
        threadId: link.threadId,
        occurredAt: placed.updatedAt,
        payload: placed,
      });
      pending.push({ item: placed, activityKey });
      unreadThreads.add(link.threadId);
    }
    // Detached and unlinked conversations: take their cards down. Turn items
    // cannot be deleted, so the card is rewritten as `cancelled`, which
    // clients leave out of the timeline.
    const holding = new Set(links.map((link) => linkKey(link.threadId, link.sessionKey)));
    const takedowns = new Map([...detachedLinks, ...unlinkedCards]);
    unlinkedCards.clear();
    for (const [key, target] of takedowns) {
      if (holding.has(key)) continue;
      const itemId = TurnItemId.make(`${target.threadId}${CARD_ID_PREFIX}${target.sessionKey}`);
      const written = yield* writtenFor(target.threadId);
      const previous = written.get(itemId);
      if (previous === undefined || previous === DETACHED_CARD) continue;
      const records = yield* projections.getThreadRecords(target.threadId, ["turnItems"], {
        turnItemRunIds: [null],
      });
      const card = records.turnItems.find((item) => item.id === itemId);
      if (card === undefined || card.type !== "notification") {
        written.delete(itemId);
        continue;
      }
      const at = DateTime.makeUnsafe(nowMillis);
      const placed = yield* positions.normalize({ ...card, outcome: "cancelled", updatedAt: at });
      events.push({
        id: EventId.make(`${itemId}:detached:${nowMillis}`),
        type: "turn-item.updated",
        threadId: target.threadId,
        occurredAt: at,
        payload: placed,
      });
      pending.push({ item: placed, activityKey: DETACHED_CARD });
    }

    if (events.length > 0) {
      // Only mark the cards written once the write took: a failed write must
      // be retried next pass exactly as it was.
      yield* eventSink.write({ events });
      for (const { item, activityKey } of pending) {
        const written = writtenCards.get(item.threadId);
        written?.set(item.id, activityKey);
      }
      for (const threadId of unreadThreads) {
        yield* dispatch({
          type: "thread.mark-unread",
          commandId: CommandId.make(`hermes-chat:unread:${threadId}:${(unreadCounter += 1)}`),
          threadId,
        });
      }
      changed = true;
    }
    return changed;
  });

  const passMutex = yield* Semaphore.make(1);
  const safePass = passMutex.withPermits(1)(
    pass.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Hermes chat hub watcher pass failed").pipe(
          Effect.annotateLogs({ cause }),
          Effect.as(false),
        ),
      ),
    ),
  );

  const start: HermesChatHubService["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        for (;;) {
          const changed = yield* safePass;
          yield* Effect.raceFirst(
            Queue.take(wake),
            Effect.sleep(changed ? AFTER_CHANGE_INTERVAL : IDLE_INTERVAL),
          );
        }
      }),
    );

  return HermesChatHubService.of({
    listHubs,
    link,
    unlink,
    links: linksResult,
    effectiveLinkedConversations: effectiveLinks,
    sync: Effect.asVoid(safePass),
    start,
  });
});

export const layer = Layer.effect(HermesChatHubService, make);
