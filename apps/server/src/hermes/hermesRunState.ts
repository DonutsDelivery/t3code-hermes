// Hermes's state.db is read with node:sqlite's synchronous read-only API, like the cron ledger.
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Readers for the Hermes state behind background runs.
 *
 * Hermes does work outside any chat: webhook routes run an agent per incoming
 * delivery, and cron jobs run one per firing. Every run is an ordinary Hermes
 * session in the profile's `state.db`, with `source` set to `webhook` or
 * `cron`. Which routes and jobs exist comes from the profile's own config:
 * routes from `config.yaml` (`platforms.webhook.extra.routes`) and
 * `webhook_subscriptions.json`, jobs from `cron/jobs.json`.
 *
 * Everything here is read-only and defensive, like `hermesCronState`: Hermes
 * upgrades on its own schedule and tolerates hand edits, so anything malformed
 * is skipped rather than failing the whole read.
 *
 * Verified against Hermes Agent 0.21.0 (state schema 30).
 *
 * @module hermesRunState
 */
import * as NodeSqlite from "node:sqlite";

import { parse as parseYaml } from "yaml";

import { parseHermesCronJobs } from "./hermesCronState.ts";

/** The profile Hermes calls "default" lives at the Hermes home itself. */
export const DEFAULT_HERMES_PROFILE = "default";

/**
 * An unended session with no activity for this long is treated as over.
 * Hermes ends webhook sessions best-effort, so a crashed gateway can leave a
 * run "open" forever. Two hours covers a run that sits waiting on CI.
 */
export const HERMES_RUN_STALE_AFTER_SECONDS = 2 * 60 * 60;

export interface HermesProfileHome {
  readonly profile: string;
  readonly home: string;
}

export interface HermesWebhookRoute {
  readonly name: string;
  readonly events: readonly string[];
  /** The route's prompt and script path, searched for a repository it names. */
  readonly hint: string;
  /** Script that filters deliveries, whose contents often name the repository. */
  readonly scriptPath: string | null;
}

export interface HermesCronJobSource {
  readonly id: string;
  readonly name: string;
  readonly schedule: string;
  readonly workdir: string | null;
  readonly hint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): readonly string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && !!entry.trim());
}

function routeFrom(name: string, route: unknown): HermesWebhookRoute | null {
  if (!name.trim() || !isRecord(route)) return null;
  const script = text(route["script"]).trim() || null;
  return {
    name: name.trim(),
    events: stringList(route["events"]),
    hint: [text(route["prompt"]), text(route["description"]), script ?? ""].join("\n"),
    scriptPath: script,
  };
}

/**
 * The webhook routes a profile serves: static routes from `config.yaml`, then
 * agent-created subscriptions, where a static route of the same name wins —
 * the same precedence Hermes's webhook platform applies.
 */
export function parseHermesWebhookRoutes(
  configYaml: string | null,
  subscriptionsJson: string | null,
): readonly HermesWebhookRoute[] {
  const routes = new Map<string, HermesWebhookRoute>();
  if (subscriptionsJson !== null) {
    try {
      const parsed: unknown = JSON.parse(subscriptionsJson);
      if (isRecord(parsed)) {
        for (const [name, route] of Object.entries(parsed)) {
          const entry = routeFrom(name, route);
          if (entry) routes.set(entry.name, entry);
        }
      }
    } catch {
      // A torn or hand-broken subscriptions file hides only dynamic routes.
    }
  }
  if (configYaml !== null) {
    try {
      const config: unknown = parseYaml(configYaml);
      const platforms = isRecord(config) ? config["platforms"] : undefined;
      const webhook = isRecord(platforms) ? platforms["webhook"] : undefined;
      const extra = isRecord(webhook) ? webhook["extra"] : undefined;
      const staticRoutes = isRecord(extra) ? extra["routes"] : undefined;
      if (isRecord(staticRoutes)) {
        for (const [name, route] of Object.entries(staticRoutes)) {
          const entry = routeFrom(name, route);
          if (entry) routes.set(entry.name, entry);
        }
      }
    } catch {
      // Hermes refuses to start on a config it cannot parse; neither can we.
    }
  }
  return [...routes.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

/** A profile's cron jobs with the fields that locate their work. */
export function parseHermesCronJobSources(raw: unknown): readonly HermesCronJobSource[] {
  const jobs = parseHermesCronJobs(raw) ?? [];
  const entries = isRecord(raw) ? raw["jobs"] : raw;
  const rawById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      // Same id coercion as parseHermesCronJobs, which accepts numeric ids.
      const id = entry["id"];
      rawById.set((typeof id === "number" ? String(id) : text(id)).trim(), entry);
    }
  }
  return jobs.map((job) => {
    const entry = rawById.get(job.id) ?? {};
    return {
      id: job.id,
      name: job.name,
      schedule: job.scheduleDisplay,
      workdir: text(entry["workdir"]).trim() || null,
      hint: [text(entry["prompt"]), text(entry["script"])].join("\n"),
    };
  });
}

export function webhookSourceKey(route: string): string {
  return `webhook:${route}`;
}

export function cronSourceKey(jobId: string): string {
  return `cron:${jobId}`;
}

const CRON_SESSION_ID = /^cron_(.+)_\d{8}_\d{6}$/;
const WEBHOOK_CHAT_NAME = /^webhook\/(.+)$/;
const WEBHOOK_KEY = /^webhook:([^:]+)(?::|$)/;

/**
 * Which source a session came from, or null for chats. Webhook sessions carry
 * their route in `origin_json.chat_name` ("webhook/<route>"); cron sessions
 * are named `cron_<jobId>_<YYYYmmdd_HHMMSS>` by the scheduler.
 */
export function sourceKeyOfSession(row: {
  readonly id: unknown;
  readonly source: unknown;
  readonly origin_json?: unknown;
  readonly user_id?: unknown;
}): string | null {
  if (row.source === "cron") {
    const match = CRON_SESSION_ID.exec(text(row.id));
    return match ? cronSourceKey(match[1]!) : null;
  }
  if (row.source !== "webhook") return null;
  try {
    const origin: unknown = JSON.parse(text(row.origin_json) || "null");
    if (isRecord(origin)) {
      const fromName = WEBHOOK_CHAT_NAME.exec(text(origin["chat_name"]));
      if (fromName) return webhookSourceKey(fromName[1]!);
      const fromChat = WEBHOOK_KEY.exec(text(origin["chat_id"]));
      if (fromChat) return webhookSourceKey(fromChat[1]!);
    }
  } catch {
    // Fall through to the user id, which the webhook platform also stamps.
  }
  const fromUser = WEBHOOK_KEY.exec(text(row.user_id));
  return fromUser ? webhookSourceKey(fromUser[1]!) : null;
}

/** Runs `read` against a read-only connection; null when the store cannot be opened or read. */
export function withStateDb<A>(dbPath: string, read: (db: NodeSqlite.DatabaseSync) => A): A | null {
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true, timeout: 5_000 });
  } catch {
    return null;
  }
  try {
    return read(database);
  } catch {
    return null;
  } finally {
    database.close();
  }
}

function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// A session continued after compression is a child of one that ended with
// `compression`; it belongs to its root's run, not a run of its own.
const IS_RUN_ROOT = `NOT EXISTS (
  SELECT 1 FROM sessions AS parent
  WHERE parent.id = s.parent_session_id AND parent.end_reason = 'compression'
)`;

export interface HermesSourceRunStats {
  readonly lastRunAt: number;
  readonly recentRunCount: number;
}

/** Last run and recent tool-using run count per source, from one scan of recent sessions. */
export function readHermesSourceRunStats(
  dbPath: string,
  sinceSeconds: number,
): ReadonlyMap<string, HermesSourceRunStats> | null {
  return withStateDb(dbPath, (db) => {
    const rows = db
      .prepare(
        `SELECT s.id, s.source, s.origin_json, s.user_id, s.started_at, s.tool_call_count
         FROM sessions AS s
         WHERE s.source IN ('webhook', 'cron') AND s.started_at >= ? AND ${IS_RUN_ROOT}`,
      )
      .all(sinceSeconds) as unknown as ReadonlyArray<Record<string, unknown>>;
    const stats = new Map<string, { lastRunAt: number; recentRunCount: number }>();
    for (const row of rows) {
      const key = sourceKeyOfSession(row as Parameters<typeof sourceKeyOfSession>[0]);
      const startedAt = seconds(row["started_at"]);
      if (key === null || startedAt === null) continue;
      const entry = stats.get(key) ?? { lastRunAt: 0, recentRunCount: 0 };
      entry.lastRunAt = Math.max(entry.lastRunAt, startedAt);
      if ((seconds(row["tool_call_count"]) ?? 0) > 0) entry.recentRunCount += 1;
      stats.set(key, entry);
    }
    return stats;
  });
}

export interface HermesSessionRow {
  readonly id: string;
  readonly title: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly endReason: string | null;
  readonly lastActivityAt: number | null;
  readonly toolCallCount: number;
  /**
   * The model the session ran on, as a Hermes ACP model id: `provider:model`
   * when the row names a routable provider, else the bare model.
   */
  readonly model: string | null;
}

// Hermes's own non-routable billing buckets (`_BARE_BILLING_PROVIDERS`).
const BARE_BILLING_PROVIDERS = new Set(["auto", "custom"]);

function sessionModelFrom(row: Record<string, unknown>): string | null {
  const model = text(row["model"]).trim();
  if (!model) return null;
  const provider = text(row["billing_provider"]).trim().toLowerCase();
  return provider && !BARE_BILLING_PROVIDERS.has(provider) ? `${provider}:${model}` : model;
}

function sessionRowFrom(row: Record<string, unknown>): HermesSessionRow | null {
  const id = text(row["id"]).trim();
  const startedAt = seconds(row["started_at"]);
  if (!id || startedAt === null) return null;
  return {
    id,
    title: text(row["title"]).trim() || null,
    startedAt,
    endedAt: seconds(row["ended_at"]),
    endReason: text(row["end_reason"]).trim() || null,
    lastActivityAt: seconds(row["last_activity_at"]),
    toolCallCount: seconds(row["tool_call_count"]) ?? 0,
    model: sessionModelFrom(row),
  };
}

const SESSION_COLUMNS = `s.id, s.title, s.started_at, s.ended_at, s.end_reason, s.last_activity_at, s.tool_call_count, s.model, s.billing_provider`;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function sourcePredicate(sourceKey: string): { readonly sql: string; readonly params: string[] } {
  if (sourceKey.startsWith("cron:")) {
    // The whole id, not a prefix: job "foo" must not match job "foo_bar"'s runs.
    const prefix = `cron_${sourceKey.slice("cron:".length)}_`;
    return {
      sql: `s.source = 'cron' AND substr(s.id, 1, length(?)) = ?
        AND substr(s.id, length(?) + 1) GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9]'`,
      params: [prefix, prefix, prefix],
    };
  }
  // The same three places `sourceKeyOfSession` looks. `json_valid` first:
  // `json_extract` throws on a torn row and would fail the whole read.
  const route = sourceKey.slice("webhook:".length);
  return {
    sql: `s.source = 'webhook' AND (s.user_id = ? OR (json_valid(s.origin_json) AND (
      json_extract(s.origin_json, '$.chat_name') = ?
      OR json_extract(s.origin_json, '$.chat_id') LIKE ? ESCAPE '\\')))`,
    params: [`webhook:${route}`, `webhook/${route}`, `webhook:${escapeLike(route)}:%`],
  };
}

// The run's last words, for telling a silent run from one with a report.
const LAST_ASSISTANT_TEXT = `(
  SELECT m.content FROM messages AS m
  WHERE m.session_id = s.id AND m.role = 'assistant' AND TRIM(COALESCE(m.content, '')) != ''
  ORDER BY m.id DESC LIMIT 1
)`;

/**
 * The runs of a source to mirror: every run started at or after `since`, plus
 * the newest earlier run that used tools and reported something, so switching
 * a source on shows its last real run straight away instead of an empty list
 * until it next fires.
 */
export function readHermesRunRoots(
  dbPath: string,
  sourceKey: string,
  sinceSeconds: number,
): readonly HermesSessionRow[] | null {
  const predicate = sourcePredicate(sourceKey);
  return withStateDb(dbPath, (db) => {
    const recent = db
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions AS s
         WHERE ${predicate.sql} AND s.started_at >= ? AND ${IS_RUN_ROOT}
         ORDER BY s.started_at`,
      )
      .all(...predicate.params, sinceSeconds) as unknown as ReadonlyArray<Record<string, unknown>>;
    const previous = db
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions AS s
         WHERE ${predicate.sql} AND s.started_at < ? AND s.tool_call_count > 0 AND ${IS_RUN_ROOT}
           AND LTRIM(COALESCE(${LAST_ASSISTANT_TEXT}, '')) NOT LIKE '[SILENT]%'
         ORDER BY s.started_at DESC LIMIT 1`,
      )
      .all(...predicate.params, sinceSeconds) as unknown as ReadonlyArray<Record<string, unknown>>;
    return [...previous, ...recent].flatMap((row) => sessionRowFrom(row) ?? []);
  });
}

/**
 * A run's sessions from its root to the newest one. Compression ends a session
 * with `compression` and continues in a child, so the run follows that chain.
 */
export function readHermesRunChain(
  dbPath: string,
  rootSessionId: string,
): readonly HermesSessionRow[] | null {
  return withStateDb(dbPath, (db) => {
    const byId = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions AS s WHERE s.id = ?`);
    const childOf = db.prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions AS s WHERE s.parent_session_id = ?
       ORDER BY s.started_at LIMIT 1`,
    );
    const root = byId.get(rootSessionId) as Record<string, unknown> | undefined;
    const chain: HermesSessionRow[] = [];
    const seen = new Set<string>();
    let current = root ? sessionRowFrom(root) : null;
    // No length cap: a truncated chain would read a compression-ended tip as
    // live forever. `seen` guards against a hand-edited parent cycle.
    while (current !== null && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current);
      if (current.endReason !== "compression") break;
      const child = childOf.get(current.id) as Record<string, unknown> | undefined;
      current = child ? sessionRowFrom(child) : null;
    }
    return chain;
  });
}

/**
 * How long a session that ended for compression may wait for its continuation
 * to be recorded. Hermes writes the child straight after, so a longer gap means
 * the run died mid-handoff.
 */
export const HERMES_COMPRESSION_HANDOFF_SECONDS = 10 * 60;

/** Whether a run is over: its newest session ended for good, or went quiet. */
export function isHermesRunOver(
  chain: readonly HermesSessionRow[],
  nowSeconds: number,
  lastMessageAt: number | null,
): boolean {
  const tip = chain.at(-1);
  if (tip === undefined) return true;
  if (tip.endedAt !== null) {
    return (
      tip.endReason !== "compression" ||
      nowSeconds - tip.endedAt > HERMES_COMPRESSION_HANDOFF_SECONDS
    );
  }
  const lastSeen = Math.max(tip.startedAt, tip.lastActivityAt ?? 0, lastMessageAt ?? 0);
  return nowSeconds - lastSeen > HERMES_RUN_STALE_AFTER_SECONDS;
}

export interface HermesMessageRow {
  readonly id: number;
  readonly role: string;
  readonly content: string;
  readonly toolCallId: string | null;
  readonly toolCalls: string | null;
  readonly toolName: string | null;
  readonly reasoning: string | null;
  readonly timestamp: number;
}

export interface HermesMessagePage {
  readonly rows: readonly HermesMessageRow[];
  /** Id of the last row read, skipped ones included; the next page starts after it. */
  readonly lastId: number;
  /** Whether the page was full, so more rows may follow. */
  readonly full: boolean;
}

/** Messages of a run's sessions after `afterId`, oldest first, at most `limit` rows read. */
export function readHermesRunMessages(
  dbPath: string,
  sessionIds: readonly string[],
  afterId: number,
  limit = 500,
): HermesMessagePage | null {
  if (sessionIds.length === 0) return { rows: [], lastId: afterId, full: false };
  return withStateDb(dbPath, (db) => {
    // `SELECT *` rather than a column list: optional columns such as
    // `_compressed_summary` come and go between Hermes versions.
    const rows = db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id IN (${sessionIds.map(() => "?").join(", ")}) AND id > ?
         ORDER BY id LIMIT ?`,
      )
      .all(...sessionIds, afterId, limit) as unknown as ReadonlyArray<Record<string, unknown>>;
    const messages = rows.flatMap((row): HermesMessageRow[] => {
      const id = seconds(row["id"]);
      const timestamp = seconds(row["timestamp"]);
      if (id === null || timestamp === null) return [];
      // Compression summaries stand in for history the thread already shows.
      if (row["_compressed_summary"]) return [];
      return [
        {
          id,
          role: text(row["role"]),
          content: text(row["content"]),
          toolCallId: text(row["tool_call_id"]).trim() || null,
          toolCalls: text(row["tool_calls"]).trim() || null,
          toolName: text(row["tool_name"]).trim() || null,
          reasoning: text(row["reasoning"]).trim() || null,
          timestamp,
        },
      ];
    });
    return {
      rows: messages,
      lastId: seconds(rows.at(-1)?.["id"]) ?? afterId,
      full: rows.length === limit,
    };
  });
}
