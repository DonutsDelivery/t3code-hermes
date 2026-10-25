/**
 * Read-only views of Hermes gateway conversations, read on demand from the default profile's
 * `state.db`. Nothing is cached, nothing can post or start a Hermes turn, and reads never fail: an
 * unavailable store comes back as `availability`.
 */
import {
  HERMES_CHAT_LIST_MAX,
  HERMES_CHAT_TRANSCRIPT_MAX,
  type HermesChatConversation,
  type HermesChatListInput,
  type HermesChatListResult,
  type HermesChatMessage,
  type HermesChatTranscript,
  type HermesChatTranscriptInput,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerSettings from "../serverSettings.ts";
import {
  readHermesChatConversations,
  readHermesChatTranscript,
  type HermesChatConversationRow,
  type HermesChatMessageRow,
} from "./hermesChatState.ts";
import { resolveEnabledHermesInstance, resolveHermesHome } from "./hermesCronState.ts";
import { isoFromSeconds } from "./hermesRunTranscript.ts";

const DEFAULT_LIST_LIMIT = 30;
const DEFAULT_SINCE_DAYS = 30;

export class HermesChatService extends Context.Service<
  HermesChatService,
  {
    /** Gateway conversations active recently, newest first. */
    readonly list: (input: HermesChatListInput) => Effect.Effect<HermesChatListResult>;
    /** One conversation's newest messages across all its Hermes sessions. */
    readonly transcript: (input: HermesChatTranscriptInput) => Effect.Effect<HermesChatTranscript>;
  }
>()("t3-hermes/hermes/HermesChatService") {}

function conversationFrom(row: HermesChatConversationRow): HermesChatConversation {
  return { ...row, lastActivityAt: isoFromSeconds(row.lastActivityAt) };
}

function messageFrom(row: HermesChatMessageRow): HermesChatMessage {
  return { ...row, timestamp: isoFromSeconds(row.timestamp) };
}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;

  // Gateway conversations live in the default profile: other profiles run their own gateways
  // only when the user starts them, and their keys would collide with the default's.
  const stateDbPath = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    const instance = settings === null ? null : resolveEnabledHermesInstance(settings);
    if (instance === null) return null;
    const environment = yield* mergeProviderInstanceEnvironment(instance.environment);
    return path.join(resolveHermesHome(environment), "state.db");
  });

  const list: HermesChatService["Service"]["list"] = Effect.fn("HermesChatService.list")(
    function* (input) {
      const dbPath = yield* stateDbPath;
      if (dbPath === null) return { availability: "hermes-off" as const, conversations: [] };
      const nowSeconds = (yield* Clock.currentTimeMillis) / 1000;
      const rows = yield* Effect.sync(() =>
        readHermesChatConversations(dbPath, {
          sinceSeconds: nowSeconds - (input.sinceDays ?? DEFAULT_SINCE_DAYS) * 86_400,
          limit: Math.min(input.limit ?? DEFAULT_LIST_LIMIT, HERMES_CHAT_LIST_MAX),
        }),
      );
      if (rows === null) return { availability: "unavailable" as const, conversations: [] };
      return { availability: "ready" as const, conversations: rows.map(conversationFrom) };
    },
  );

  const transcript: HermesChatService["Service"]["transcript"] = Effect.fn(
    "HermesChatService.transcript",
  )(function* (input) {
    const empty = { conversation: null, messages: [], truncated: false };
    const dbPath = yield* stateDbPath;
    if (dbPath === null) return { availability: "hermes-off" as const, ...empty };
    const limit = Math.min(input.limit ?? HERMES_CHAT_TRANSCRIPT_MAX, HERMES_CHAT_TRANSCRIPT_MAX);
    const read = yield* Effect.sync(() =>
      readHermesChatTranscript(dbPath, input.sessionKey, limit),
    );
    if (read === null) return { availability: "unavailable" as const, ...empty };
    return {
      availability: "ready" as const,
      conversation: read.conversation === null ? null : conversationFrom(read.conversation),
      messages: read.messages.map(messageFrom),
      truncated: read.truncated,
    };
  });

  return HermesChatService.of({ list, transcript });
});

export const layer = Layer.effect(HermesChatService, make);
