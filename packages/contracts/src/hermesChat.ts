/**
 * Hermes chat contract: read-only views of Hermes gateway conversations.
 *
 * Hermes's messaging gateway (Discord, Telegram, Slack, ...) keeps every
 * conversation in the profile's session store. A conversation is identified
 * by its gateway `sessionKey` (channel plus user, a thread, or a DM), which
 * outlives the Hermes sessions it spans: resets and compression rotate the
 * session id under the same key. Transcripts are read on demand and never
 * copied into T3 Code's own state.
 *
 * @module hermesChat
 */
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Most recent conversations one list returns. */
export const HERMES_CHAT_LIST_MAX = 100;
/** Newest messages one transcript read returns; older ones are dropped first. */
export const HERMES_CHAT_TRANSCRIPT_MAX = 500;

/** `hermes-off`: no Hermes provider is enabled. `unavailable`: its session store could not be read. */
export const HermesChatAvailability = Schema.Literals(["ready", "hermes-off", "unavailable"]);
export type HermesChatAvailability = typeof HermesChatAvailability.Type;

export const HermesChatConversation = Schema.Struct({
  /** Hermes's gateway session key, e.g. `agent:main:discord:thread:<id>:<id>`. */
  sessionKey: TrimmedNonEmptyString,
  /** The platform's name for the chat, e.g. `Server / #channel / thread`. */
  displayName: Schema.NullOr(Schema.String),
  /** Hermes's own title for the newest session. */
  title: Schema.NullOr(Schema.String),
  /** Who Hermes talks to, for channel and DM conversations. */
  userName: Schema.NullOr(Schema.String),
  /** Hermes session source, the platform: `discord`, `telegram`, ... */
  platform: TrimmedNonEmptyString,
  /** `group`, `thread`, `dm`, ... as the platform reports it. */
  chatType: Schema.NullOr(Schema.String),
  lastActivityAt: IsoDateTime,
  /** Stored user, assistant, and tool rows across every session, hidden ones included. */
  messageCount: NonNegativeInt,
  latestMessagePreview: Schema.NullOr(Schema.String),
});
export type HermesChatConversation = typeof HermesChatConversation.Type;

export const HermesChatListInput = Schema.Struct({
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: HERMES_CHAT_LIST_MAX })),
  ),
  /** Only conversations active in this many days; 30 when omitted. */
  sinceDays: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 }))),
});
export type HermesChatListInput = typeof HermesChatListInput.Type;

export const HermesChatListResult = Schema.Struct({
  availability: HermesChatAvailability,
  /** Newest activity first. */
  conversations: ForwardCompatibleArray(HermesChatConversation),
});
export type HermesChatListResult = typeof HermesChatListResult.Type;

export const HermesChatMessageRole = Schema.Literals(["user", "assistant", "tool"]);
export type HermesChatMessageRole = typeof HermesChatMessageRole.Type;

export const HermesChatMessage = Schema.Struct({
  /** Hermes's message row id, unique across sessions. */
  id: NonNegativeInt,
  /** The Hermes session the message belongs to. */
  sessionId: TrimmedNonEmptyString,
  role: HermesChatMessageRole,
  /**
   * The message as the person wrote it, without the reply and channel context
   * Hermes adds for the model. A `tool` message is a one-line summary.
   */
  text: Schema.String,
  /** The message it replies to, abridged, when the platform said so. */
  replyTo: Schema.NullOr(Schema.String),
  /** Tool names for a `tool` message. */
  toolName: Schema.NullOr(Schema.String),
  timestamp: IsoDateTime,
});
export type HermesChatMessage = typeof HermesChatMessage.Type;

export const HermesChatTranscriptInput = Schema.Struct({
  sessionKey: TrimmedNonEmptyString,
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: HERMES_CHAT_TRANSCRIPT_MAX })),
  ),
});
export type HermesChatTranscriptInput = typeof HermesChatTranscriptInput.Type;

export const HermesChatTranscript = Schema.Struct({
  availability: HermesChatAvailability,
  /** Null when no conversation has this key. */
  conversation: Schema.NullOr(HermesChatConversation),
  /** Oldest first. */
  messages: ForwardCompatibleArray(HermesChatMessage),
  /** Older messages exist beyond the limit. */
  truncated: Schema.Boolean,
});
export type HermesChatTranscript = typeof HermesChatTranscript.Type;
