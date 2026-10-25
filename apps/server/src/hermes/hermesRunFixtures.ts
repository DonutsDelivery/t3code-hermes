// Fixtures write a real Hermes state.db through node:sqlite, as Hermes itself would.
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Hermes `state.db` DDL from Hermes Agent 0.21.0 (`hermes_state_common.py`, schema 30), verbatim.
 * Update it from the new source when an upgrade changes a column the run reader uses.
 */
import * as NodeSqlite from "node:sqlite";

export const HERMES_STATE_DDL = `
CREATE TABLE IF NOT EXISTS system_prompts (
    hash TEXT PRIMARY KEY,
    prompt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    user_id TEXT,
    session_key TEXT,
    chat_id TEXT,
    chat_type TEXT,
    thread_id TEXT,
    display_name TEXT,
    origin_json TEXT,
    expiry_finalized INTEGER DEFAULT 0,
    model TEXT,
    model_config TEXT,
    system_prompt TEXT,
    system_prompt_hash TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    end_reason TEXT,
    message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    cwd TEXT,
    git_branch TEXT,
    git_repo_root TEXT,
    git_metadata_generation INTEGER NOT NULL DEFAULT 0,
    billing_provider TEXT,
    billing_base_url TEXT,
    billing_mode TEXT,
    estimated_cost_usd REAL,
    actual_cost_usd REAL,
    cost_status TEXT,
    cost_source TEXT,
    pricing_version TEXT,
    title TEXT,
    title_source TEXT,
    last_activity_at REAL,
    last_activity_description TEXT,
    last_activity_provenance TEXT,
    api_call_count INTEGER DEFAULT 0,
    handoff_state TEXT,
    handoff_platform TEXT,
    handoff_error TEXT,
    compression_failure_cooldown_until REAL,
    compression_failure_error TEXT,
    compression_fallback_streak INTEGER NOT NULL DEFAULT 0,
    compression_ineffective_count INTEGER NOT NULL DEFAULT 0,
    compression_recovery_deadline REAL,
    profile_name TEXT,
    rewind_count INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    last_read_at REAL,
    tool_names TEXT,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id),
    FOREIGN KEY (system_prompt_hash) REFERENCES system_prompts(hash)
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    effect_disposition TEXT,
    timestamp REAL NOT NULL,
    token_count INTEGER,
    finish_reason TEXT,
    reasoning TEXT,
    reasoning_content TEXT,
    reasoning_details TEXT,
    codex_reasoning_items TEXT,
    codex_message_items TEXT,
    platform_message_id TEXT,
    observed INTEGER DEFAULT 0,
    _compressed_summary INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    compacted INTEGER NOT NULL DEFAULT 0,
    api_content TEXT,
    display_kind TEXT,
    display_metadata TEXT
);
`;

export interface HermesSessionFixture {
  readonly id: string;
  readonly source: "webhook" | "cron" | "acp";
  readonly route?: string;
  readonly startedAt: number;
  readonly endedAt?: number | null;
  readonly endReason?: string | null;
  readonly parentSessionId?: string | null;
  readonly title?: string | null;
  readonly toolCallCount?: number;
  readonly model?: string | null;
  readonly billingProvider?: string | null;
}

/** Inserts a session the way the webhook platform or cron scheduler writes one. */
export function insertHermesSession(db: NodeSqlite.DatabaseSync, session: HermesSessionFixture) {
  const origin =
    session.route === undefined
      ? null
      : JSON.stringify({
          platform: "webhook",
          chat_id: `webhook:${session.route}:delivery-${session.id}`,
          chat_name: `webhook/${session.route}`,
          chat_type: "webhook",
          user_id: `webhook:${session.route}`,
          user_name: session.route,
        });
  db.prepare(
    `INSERT INTO sessions (id, source, user_id, origin_json, parent_session_id, started_at,
       ended_at, end_reason, title, tool_call_count, model, billing_provider)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.source,
    session.route === undefined ? null : `webhook:${session.route}`,
    origin,
    session.parentSessionId ?? null,
    session.startedAt,
    session.endedAt ?? null,
    session.endReason ?? null,
    session.title ?? null,
    session.toolCallCount ?? 0,
    session.model ?? null,
    session.billingProvider ?? null,
  );
}

export interface HermesGatewaySessionFixture {
  readonly id: string;
  /** Null for a compression continuation, which Hermes writes without a key. */
  readonly sessionKey: string | null;
  readonly source?: string;
  readonly startedAt: number;
  readonly endedAt?: number | null;
  readonly endReason?: string | null;
  readonly parentSessionId?: string | null;
  readonly lastActivityAt?: number | null;
  readonly title?: string | null;
  readonly displayName?: string | null;
  readonly userName?: string;
  /** Overrides the default origin JSON, e.g. to name platform channel ids. */
  readonly originJson?: string;
}

/** Inserts a session the way the messaging gateway writes one. */
export function insertHermesGatewaySession(
  db: NodeSqlite.DatabaseSync,
  session: HermesGatewaySessionFixture,
) {
  const keyed = session.sessionKey !== null;
  db.prepare(
    `INSERT INTO sessions (id, source, session_key, chat_type, display_name, origin_json,
       parent_session_id, started_at, ended_at, end_reason, last_activity_at, title)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.source ?? "discord",
    session.sessionKey,
    keyed ? "thread" : null,
    keyed ? (session.displayName ?? "Guild / #general / help") : null,
    keyed
      ? (session.originJson ??
          JSON.stringify({
            platform: "discord",
            chat_type: "thread",
            user_name: session.userName ?? "Yato",
          }))
      : null,
    session.parentSessionId ?? null,
    session.startedAt,
    session.endedAt ?? null,
    session.endReason ?? null,
    session.lastActivityAt ?? null,
    session.title ?? null,
  );
}

export interface HermesMessageFixture {
  readonly sessionId: string;
  readonly role: "user" | "assistant" | "tool" | "system" | "session_meta";
  readonly content?: string;
  readonly toolCalls?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly args: Record<string, unknown>;
  }>;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly timestamp: number;
  readonly compressedSummary?: boolean;
  readonly displayKind?: string;
}

/** Inserts a message the way Hermes's conversation loop persists one. */
export function insertHermesMessage(db: NodeSqlite.DatabaseSync, message: HermesMessageFixture) {
  db.prepare(
    `INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name,
       timestamp, _compressed_summary, display_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.sessionId,
    message.role,
    message.content ?? "",
    message.toolCallId ?? null,
    message.toolCalls === undefined
      ? null
      : JSON.stringify(
          message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        ),
    message.toolName ?? null,
    message.timestamp,
    message.compressedSummary ? 1 : 0,
    message.displayKind ?? null,
  );
}
