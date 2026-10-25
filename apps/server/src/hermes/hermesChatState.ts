// Hermes's state.db is read with node:sqlite's synchronous read-only API, like the run readers.
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Readers for Hermes gateway conversations. A conversation is every session stamped with its
 * `session_key` plus their compression descendants, which carry only `parent_session_id`. Read-only
 * and defensive: a missing, locked, or older store reads as null. Verified against Hermes Agent
 * 0.21.0 (state schema 32).
 */
import type * as NodeSqlite from "node:sqlite";

import { withStateDb } from "./hermesRunState.ts";

/**
 * Session sources that are not a messaging platform: agent sessions T3 or the
 * CLI drive, background runs, and Hermes's own helpers. Everything else with a
 * session key came in through the gateway, plugin platforms included.
 */
const NON_GATEWAY_SOURCES = [
  "acp",
  "api_server",
  "cli",
  "cron",
  "local",
  "msgraph_webhook",
  "subagent",
  "tool",
  "webhook",
  "webui",
];
const NON_GATEWAY_SQL = NON_GATEWAY_SOURCES.map((source) => `'${source}'`).join(", ");

/** Longest user or assistant message text returned; the rest is cut with an ellipsis. */
export const HERMES_CHAT_MESSAGE_TEXT_MAX = 8_000;
const TOOL_LINE_MAX = 160;
const PREVIEW_MAX = 140;
const REPLY_TO_MAX = 160;

// A keyed gateway session, then each compression child that does not belong
// to another key. UNION (not UNION ALL) makes a hand-edited parent cycle end.
const conversationSessions = (rootFilter: string) => `
WITH RECURSIVE conversation(id, session_key) AS (
  SELECT s.id, s.session_key FROM sessions AS s
  WHERE s.session_key IS NOT NULL AND s.source NOT IN (${NON_GATEWAY_SQL}) ${rootFilter}
  UNION
  SELECT child.id, conversation.session_key FROM sessions AS child
  JOIN conversation ON child.parent_session_id = conversation.id
  JOIN sessions AS parent ON parent.id = conversation.id
  WHERE parent.end_reason = 'compression'
    AND (child.session_key IS NULL OR child.session_key = conversation.session_key)
)`;

const VISIBLE_ROLES = `('user', 'assistant', 'tool')`;

export interface HermesChatConversationRow {
  readonly sessionKey: string;
  readonly platform: string;
  readonly displayName: string | null;
  readonly title: string | null;
  readonly userName: string | null;
  readonly chatType: string | null;
  /** Seconds. */
  readonly lastActivityAt: number;
  readonly messageCount: number;
  readonly latestMessagePreview: string | null;
}

export interface HermesChatMessageRow {
  readonly id: number;
  readonly sessionId: string;
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  readonly replyTo: string | null;
  readonly toolName: string | null;
  /** Seconds. */
  readonly timestamp: number;
}

export interface HermesChatTranscriptRows {
  readonly conversation: HermesChatConversationRow | null;
  /** Oldest first. */
  readonly messages: readonly HermesChatMessageRow[];
  readonly truncated: boolean;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const REPLY_PREFIX = /^\[Replying to(?: your previous message)?: "([\s\S]*?)"\]\n\n/;
const NEW_MESSAGE_MARKER = "\n[New message]\n";

/**
 * What the person wrote, without the context the gateway adds for the model:
 * a `[Replying to: "…"]` pointer and, when the platform backfilled channel
 * history, everything before `[New message]`.
 */
export function cleanHermesGatewayUserText(raw: string): {
  readonly text: string;
  readonly replyTo: string | null;
} {
  let body = raw;
  let replyTo: string | null = null;
  const reply = REPLY_PREFIX.exec(body);
  if (reply) {
    replyTo = clip(oneLine(reply[1]!), REPLY_TO_MAX) || null;
    body = body.slice(reply[0].length);
  }
  const marker = body.lastIndexOf(NEW_MESSAGE_MARKER);
  if (marker >= 0) body = body.slice(marker + NEW_MESSAGE_MARKER.length);
  return { text: body.trim(), replyTo };
}

/** Names of the tools an assistant row asked for, from its OpenAI-shaped `tool_calls`. */
function hermesToolCallNames(toolCalls: string | null): readonly string[] {
  if (!toolCalls) return [];
  try {
    const parsed: unknown = JSON.parse(toolCalls);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((call) => {
      const fn =
        typeof call === "object" && call !== null
          ? (call as { function?: unknown }).function
          : null;
      const name = typeof fn === "object" && fn !== null ? (fn as { name?: unknown }).name : null;
      return typeof name === "string" && name.trim() ? [name.trim()] : [];
    });
  } catch {
    return [];
  }
}

/**
 * One stored message as the viewer shows it, or null for rows that are not
 * conversation: system prompts, session metadata, compression summaries, and
 * rows Hermes itself hides or rewound.
 */
function hermesChatMessageFrom(row: Record<string, unknown>): HermesChatMessageRow | null {
  const id = seconds(row["id"]);
  const timestamp = seconds(row["timestamp"]);
  const sessionId = text(row["session_id"]).trim();
  if (id === null || timestamp === null || !sessionId) return null;
  if (row["_compressed_summary"]) return null;
  if (row["active"] === 0) return null;
  if (text(row["display_kind"]) === "hidden") return null;
  const role = text(row["role"]);
  const content = text(row["content"]);
  const base = { id, sessionId, timestamp };
  if (role === "user") {
    const cleaned = cleanHermesGatewayUserText(content);
    if (!cleaned.text) return null;
    return {
      ...base,
      role,
      text: clip(cleaned.text, HERMES_CHAT_MESSAGE_TEXT_MAX),
      replyTo: cleaned.replyTo,
      toolName: null,
    };
  }
  if (role === "assistant") {
    if (content.trim()) {
      return {
        ...base,
        role,
        text: clip(content.trim(), HERMES_CHAT_MESSAGE_TEXT_MAX),
        replyTo: null,
        toolName: null,
      };
    }
    const names = hermesToolCallNames(text(row["tool_calls"]).trim() || null);
    if (names.length === 0) return null;
    const toolName = [...new Set(names)].join(", ");
    return {
      ...base,
      role: "tool",
      text: clip(`Called ${toolName}`, TOOL_LINE_MAX),
      replyTo: null,
      toolName,
    };
  }
  if (role === "tool") {
    const toolName = text(row["tool_name"]).trim() || null;
    const summary = oneLine(content);
    return {
      ...base,
      role,
      text: clip([toolName ?? "tool", summary].filter(Boolean).join(" → "), TOOL_LINE_MAX),
      replyTo: null,
      toolName,
    };
  }
  return null;
}

/** A user or assistant message as one short line, for a conversation list row. */
function previewOf(row: Record<string, unknown> | undefined): string | null {
  if (row === undefined) return null;
  const message = hermesChatMessageFrom(row);
  if (message === null || message.role === "tool") return null;
  return clip(oneLine(message.text), PREVIEW_MAX) || null;
}

function userNameOf(originJson: string): string | null {
  try {
    const origin: unknown = JSON.parse(originJson || "null");
    if (typeof origin !== "object" || origin === null) return null;
    return text((origin as { user_name?: unknown }).user_name).trim() || null;
  } catch {
    return null;
  }
}

interface ConversationAggregate {
  readonly sessionKey: string;
  readonly lastActivityAt: number;
}

function describeConversation(
  db: NodeSqlite.DatabaseSync,
  aggregate: ConversationAggregate,
): HermesChatConversationRow | null {
  const ids = (
    db
      .prepare(`${conversationSessions("AND s.session_key = ?")} SELECT id FROM conversation`)
      .all(aggregate.sessionKey) as unknown as ReadonlyArray<{ id: unknown }>
  )
    .map((row) => text(row.id))
    .filter(Boolean);
  if (ids.length === 0) return null;
  const placeholders = ids.map(() => "?").join(", ");
  // The newest keyed session names the chat; compression children carry no names.
  const newest = db
    .prepare(
      `SELECT source, display_name, title, chat_type, origin_json FROM sessions
       WHERE session_key = ? ORDER BY started_at DESC LIMIT 1`,
    )
    .get(aggregate.sessionKey) as Record<string, unknown> | undefined;
  const newestTitle = db
    .prepare(
      `SELECT title FROM sessions WHERE id IN (${placeholders}) AND TRIM(COALESCE(title, '')) != ''
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(...ids) as Record<string, unknown> | undefined;
  const count = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE session_id IN (${placeholders}) AND role IN ${VISIBLE_ROLES}`,
    )
    .get(...ids) as Record<string, unknown> | undefined;
  const latest = db
    .prepare(
      `SELECT * FROM messages WHERE session_id IN (${placeholders})
         AND role IN ('user', 'assistant') AND TRIM(COALESCE(content, '')) != ''
       ORDER BY timestamp DESC, id DESC LIMIT 5`,
    )
    .all(...ids) as unknown as ReadonlyArray<Record<string, unknown>>;
  const platform = text(newest?.["source"]).trim();
  if (!platform) return null;
  return {
    sessionKey: aggregate.sessionKey,
    platform,
    displayName: text(newest?.["display_name"]).trim() || null,
    title: text(newestTitle?.["title"]).trim() || null,
    userName: userNameOf(text(newest?.["origin_json"])),
    chatType: text(newest?.["chat_type"]).trim() || null,
    lastActivityAt: aggregate.lastActivityAt,
    messageCount: seconds(count?.["n"]) ?? 0,
    latestMessagePreview: latest.map(previewOf).find((preview) => preview !== null) ?? null,
  };
}

/** Gateway conversations active at or after `sinceSeconds`, newest first. */
export function readHermesChatConversations(
  dbPath: string,
  options: { readonly sinceSeconds: number; readonly limit: number },
): readonly HermesChatConversationRow[] | null {
  return withStateDb(dbPath, (db) => {
    const aggregates = db
      .prepare(
        `${conversationSessions("")}
         SELECT conversation.session_key AS session_key,
           MAX(COALESCE(s.last_activity_at, s.ended_at, s.started_at)) AS activity
         FROM conversation JOIN sessions AS s ON s.id = conversation.id
         GROUP BY conversation.session_key
         HAVING activity >= ?
         ORDER BY activity DESC LIMIT ?`,
      )
      .all(options.sinceSeconds, options.limit) as unknown as ReadonlyArray<
      Record<string, unknown>
    >;
    return aggregates.flatMap((row) => {
      const sessionKey = text(row["session_key"]).trim();
      const lastActivityAt = seconds(row["activity"]);
      if (!sessionKey || lastActivityAt === null) return [];
      return describeConversation(db, { sessionKey, lastActivityAt }) ?? [];
    });
  });
}

/**
 * The newest `limit` messages of a conversation across all its sessions,
 * oldest first. `limit` counts stored rows, so hidden rows can make a page
 * slightly shorter; `truncated` says older rows exist.
 */
export function readHermesChatTranscript(
  dbPath: string,
  sessionKey: string,
  limit: number,
): HermesChatTranscriptRows | null {
  return withStateDb(dbPath, (db) => {
    const ids = (
      db
        .prepare(
          `${conversationSessions("AND s.session_key = ?")}
           SELECT conversation.id AS id,
             COALESCE(s.last_activity_at, s.ended_at, s.started_at) AS activity
           FROM conversation JOIN sessions AS s ON s.id = conversation.id`,
        )
        .all(sessionKey) as unknown as ReadonlyArray<Record<string, unknown>>
    ).flatMap((row) => {
      const id = text(row["id"]);
      return id ? [{ id, lastActivityAt: seconds(row["activity"]) ?? 0 }] : [];
    });
    if (ids.length === 0) return { conversation: null, messages: [], truncated: false };
    const conversation = describeConversation(db, {
      sessionKey,
      lastActivityAt: Math.max(...ids.map((entry) => entry.lastActivityAt)),
    });
    // `SELECT *`: optional columns such as `display_kind` and `active` come
    // and go between Hermes versions.
    const rows = db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id IN (${ids.map(() => "?").join(", ")}) AND role IN ${VISIBLE_ROLES}
         ORDER BY timestamp DESC, id DESC LIMIT ?`,
      )
      .all(...ids.map((entry) => entry.id), limit + 1) as unknown as ReadonlyArray<
      Record<string, unknown>
    >;
    const page = rows.slice(0, limit);
    const messages = page.flatMap((row) => hermesChatMessageFrom(row) ?? []).toReversed();
    return { conversation, messages, truncated: rows.length > limit };
  });
}

/**
 * Platform channel ids a session's `origin_json` names the chat by: `chat_id`
 * for a group or DM, `thread_id` plus `parent_chat_id` for a thread.
 */
function originChannelIds(originJson: string): readonly string[] {
  try {
    const origin: unknown = JSON.parse(originJson || "null");
    if (typeof origin !== "object" || origin === null) return [];
    const record = origin as Record<string, unknown>;
    const ids = [record["chat_id"], record["thread_id"], record["parent_chat_id"]];
    return [
      ...new Set(ids.filter((id): id is string => typeof id === "string" && id.trim() !== "")),
    ];
  } catch {
    return [];
  }
}

export interface HermesChatChannelsRow {
  readonly sessionKey: string;
  readonly platform: string;
  /** Platform channel ids naming the chat: chat, thread, and parent chat. */
  readonly channelIds: readonly string[];
  /** Seconds. */
  readonly lastActivityAt: number;
}

/**
 * Conversations active at or after `sinceSeconds` with the channel ids their
 * newest keyed session names, newest first. Thread hubs match conversations to
 * their channels through this reader; the list and transcript readers do not
 * surface channel ids.
 */
export function readHermesChatChannels(
  dbPath: string,
  options: { readonly sinceSeconds: number },
): readonly HermesChatChannelsRow[] | null {
  return withStateDb(dbPath, (db) => {
    const aggregates = db
      .prepare(
        `${conversationSessions("")}
         SELECT conversation.session_key AS session_key,
           MAX(COALESCE(s.last_activity_at, s.ended_at, s.started_at)) AS activity
         FROM conversation JOIN sessions AS s ON s.id = conversation.id
         GROUP BY conversation.session_key
         HAVING activity >= ?
         ORDER BY activity DESC`,
      )
      .all(options.sinceSeconds) as unknown as ReadonlyArray<Record<string, unknown>>;
    return aggregates.flatMap((row) => {
      const sessionKey = text(row["session_key"]).trim();
      const lastActivityAt = seconds(row["activity"]);
      if (!sessionKey || lastActivityAt === null) return [];
      const newest = db
        .prepare(
          `SELECT source, origin_json FROM sessions
           WHERE session_key = ? ORDER BY started_at DESC LIMIT 1`,
        )
        .get(sessionKey) as Record<string, unknown> | undefined;
      const platform = text(newest?.["source"]).trim();
      if (!platform) return [];
      return [
        {
          sessionKey,
          platform,
          channelIds: originChannelIds(text(newest?.["origin_json"])),
          lastActivityAt,
        },
      ];
    });
  });
}
