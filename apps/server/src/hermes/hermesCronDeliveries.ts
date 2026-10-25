// @effect-diagnostics nodeBuiltinImport:off
// Synchronous read-only node:sqlite access to Hermes-owned stores, as in usageHermes.ts.
import * as NodeSqlite from "node:sqlite";

import {
  HERMES_CRON_OUTPUT_LENGTH,
  HERMES_CRON_PREVIEW_LENGTH,
  type HermesCronDelivery,
  type HermesCronRunOutput,
} from "@t3tools/contracts";

import type {
  HermesCronPaths,
  ParsedHermesCronJob,
  ParsedHermesCronRun,
} from "./hermesCronState.ts";

const EMPTY_OUTPUT: HermesCronRunOutput = { content: null, truncated: false, source: null };
const PREVIEW_READ_LENGTH = HERMES_CRON_PREVIEW_LENGTH * 4;
const DELIVERY_STATUSES = new Set(["pending", "delivering", "delivered", "failed", "unknown"]);

/** Bound UTF-16 payloads without leaving a dangling surrogate in JSON or markdown. */
export function boundHermesOutput(text: string, limit: number): string {
  const end =
    text.length > limit && /[\uD800-\uDBFF]/.test(text[limit - 1] ?? "") ? limit - 1 : limit;
  return text.slice(0, end);
}

/**
 * Notification surfaces are plain text; retain the original Markdown only in run output.
 * Every inline span is single-line and length-capped so each opener scans a bounded
 * window: polls run this per retained run, and unclosed markers must stay linear.
 */
export function hermesOutputToPlainText(markdown: string): string {
  return markdown
    .replace(/^ {0,3}(?:`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/^ {0,3}\[[^\]\n]+\]:[^\n]*$/gm, "")
    .replace(/^ {0,3}(?:[-*_][ \t]*){3,}$/gm, "")
    .replace(/^ {0,3}(?:=+|-+)[ \t]*$/gm, "")
    .replace(/^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/gm, "$1")
    .replace(/^ {0,3}(?:>[ \t]*)+/gm, "")
    .replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]*)?/gm, "")
    .replace(/!?\[([^\]\n]{0,256})\]\([^\n)]{0,512}\)/g, "$1")
    .replace(/!?\[([^\]\n]{0,256})\]\[[^\]\n]{0,256}\]/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^>\n]{1,512})>/g, "$1")
    .replace(/<\/?[A-Za-z][^>\n]{0,256}>/g, "")
    .replace(/(`+)([^`]*?)\1/g, "$2")
    .replace(
      /(?<![\p{L}\p{N}])(\*{1,3}|_{1,3}|~~)(?=\S)(\S(?:[^\n]{0,256}?\S)?)\1(?![\p{L}\p{N}])/gu,
      "$2",
    )
    .replace(/\\([\\`*{}[\]()#+.!_>~-])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function openReadOnly(path: string): NodeSqlite.DatabaseSync | null {
  try {
    return new NodeSqlite.DatabaseSync(path, { readOnly: true, timeout: 100 });
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deliveryTargets(jobJson: unknown, forFailure: unknown): readonly string[] | null {
  if (typeof jobJson !== "string") return null;
  try {
    const job: unknown = JSON.parse(jobJson);
    if (!record(job)) return null;
    const deliver = forFailure === 1 ? (job.failure_deliver ?? job.deliver) : job.deliver;
    const entries = typeof deliver === "string" ? [deliver] : Array.isArray(deliver) ? deliver : [];
    const origin = record(job.origin) ? job.origin : null;
    return entries
      .filter((entry): entry is string => typeof entry === "string")
      .slice(0, 20)
      .map((entry) => {
        const target =
          entry === "origin" && typeof origin?.platform === "string"
            ? `origin (${origin.platform})`
            : entry;
        return boundHermesOutput(target, 200);
      });
  } catch {
    return null;
  }
}

interface DeliveryRecord {
  readonly output: HermesCronRunOutput;
  readonly status: HermesCronDelivery["status"];
  readonly targets: readonly string[] | null;
  readonly error: string | null;
}

/** Hermes 0.21.0 `delivery_queue.py`: terminal payloads are blank, tombstones retain only outcome. */
function readDelivery(
  database: NodeSqlite.DatabaseSync | null,
  runId: string,
): DeliveryRecord | null {
  if (database === null) return null;
  try {
    const row = database
      .prepare(`
      SELECT substr(content, 1, ?) AS content, status, for_failure, substr(error, 1, 400) AS error,
             -- Project only the target fields: a long prompt must not truncate them away.
             CASE WHEN json_valid(job_json) THEN
               CASE WHEN json_type(job_json) = 'object' THEN substr(json_object(
                 'deliver', json_extract(job_json, '$.deliver'),
                 'failure_deliver', json_extract(job_json, '$.failure_deliver'),
                 'origin', json_object('platform', json_extract(job_json, '$.origin.platform'))
               ), 1, 65536) END
             END AS job_json
      FROM deliveries WHERE execution_id = ?
    `)
      .get(HERMES_CRON_OUTPUT_LENGTH + 1, runId);
    if (row !== undefined && typeof row.status === "string" && DELIVERY_STATUSES.has(row.status)) {
      const content = text(row.content);
      return {
        output:
          content === null
            ? EMPTY_OUTPUT
            : {
                content: boundHermesOutput(content, HERMES_CRON_OUTPUT_LENGTH),
                truncated: content.length > HERMES_CRON_OUTPUT_LENGTH,
                source: "delivery",
              },
        status: row.status as HermesCronDelivery["status"],
        targets: deliveryTargets(row.job_json, row.for_failure),
        error: text(row.error),
      };
    }
    const tombstone = database
      .prepare("SELECT terminal_status FROM delivery_tombstones WHERE execution_id = ?")
      .get(runId);
    if (
      typeof tombstone?.terminal_status === "string" &&
      DELIVERY_STATUSES.has(tombstone.terminal_status)
    ) {
      return {
        output: EMPTY_OUTPUT,
        status: tombstone.terminal_status as HermesCronDelivery["status"],
        targets: null,
        error: null,
      };
    }
  } catch {
    // A missing store or a newer schema must not hide the job or invent delivery success.
  }
  return null;
}

/**
 * Reads the cron session's messages from state.db, preferring deliveries.db when observed, since
 * its terminal payloads are erased promptly. Roots match `cron_<job>_<local time>` with
 * `started_at` inside the attempt; ambiguous roots fail closed. Follow compression continuations
 * only; runs with no source report unavailable.
 */
function readSessionOutput(
  database: NodeSqlite.DatabaseSync | null,
  run: ParsedHermesCronRun,
  fullOutput: boolean,
): HermesCronRunOutput {
  // A bounded lookahead lets formatting be stripped before applying the wire cap.
  const limit = fullOutput ? HERMES_CRON_OUTPUT_LENGTH : PREVIEW_READ_LENGTH;
  if (database === null || run.status !== "completed") return EMPTY_OUTPUT;
  const start = Date.parse(run.startedAt ?? run.claimedAt ?? "") / 1000;
  const end = Date.parse(run.finishedAt ?? "") / 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return EMPTY_OUTPUT;
  try {
    const prefix = `cron_${run.jobId}_`;
    const roots = database
      .prepare(`
      SELECT id, end_reason FROM sessions
      WHERE id >= ? AND id < ? AND source = 'cron' AND parent_session_id IS NULL
        AND started_at >= ? AND started_at <= ?
      LIMIT 3
    `)
      .all(prefix, `${prefix}￿`, start, end)
      .filter(
        (row) => typeof row.id === "string" && /^\d{8}_\d{6}$/.test(row.id.slice(prefix.length)),
      );
    if (roots.length !== 1) return EMPTY_OUTPUT;
    let session = roots[0]!;
    const seen = new Set<string>();
    while (session.end_reason === "compression") {
      if (typeof session.id !== "string" || seen.has(session.id) || seen.size >= 32)
        return EMPTY_OUTPUT;
      seen.add(session.id);
      const children = database
        .prepare(`
        SELECT id, end_reason FROM sessions WHERE parent_session_id = ?
          AND source != 'tool'
          AND json_extract(COALESCE(model_config, '{}'), '$._branched_from') IS NULL
          AND json_extract(COALESCE(model_config, '{}'), '$._delegate_from') IS NULL
          AND started_at <= ?
        LIMIT 2
      `)
        .all(session.id, end);
      if (children.length !== 1) return EMPTY_OUTPUT;
      session = children[0]!;
    }
    if (session.end_reason !== "cron_complete" || typeof session.id !== "string")
      return EMPTY_OUTPUT;
    // Inspect the LAST row, not the last assistant row: a partial/tool turn is not a report.
    const last = database
      .prepare(`
      SELECT role, substr(content, 1, ?) AS content, tool_calls FROM messages
      WHERE session_id = ? AND timestamp <= ? AND active = 1
      ORDER BY timestamp DESC, id DESC LIMIT 1
    `)
      .get(limit + 1, session.id, end);
    if (
      last?.role !== "assistant" ||
      (last.tool_calls != null && last.tool_calls !== "[]" && last.tool_calls !== "")
    )
      return EMPTY_OUTPUT;
    const content = text(last.content);
    if (content === null) return EMPTY_OUTPUT;
    return {
      content: boundHermesOutput(content, limit),
      truncated: content.length > limit,
      source: "session",
    };
  } catch {
    return EMPTY_OUTPUT;
  }
}

/** One environment-scoped, bounded cache of queue payloads observed before Hermes clears them. */
export function createHermesCronDeliveryReader() {
  const cache = new Map<string, DeliveryRecord>();
  let cacheHome: string | null = null;
  let cacheSize = 0;
  const remember = (id: string, value: DeliveryRecord) => {
    const previous = cache.get(id);
    cacheSize -= previous?.output.content?.length ?? 0;
    cache.delete(id);
    cache.set(id, value);
    cacheSize += value.output.content?.length ?? 0;
    while (cache.size > 1000 || cacheSize > 4 * 1024 * 1024) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cacheSize -= cache.get(oldest)?.output.content?.length ?? 0;
      cache.delete(oldest);
    }
  };

  const read = (
    paths: HermesCronPaths,
    jobs: readonly ParsedHermesCronJob[],
    runs: readonly ParsedHermesCronRun[],
    fullOutput = false,
    contextRuns: readonly ParsedHermesCronRun[] = runs,
  ) => {
    if (cacheHome !== paths.home) {
      cache.clear();
      cacheSize = 0;
      cacheHome = paths.home;
    }
    const deliveries = openReadOnly(paths.deliveriesDb);
    const state = openReadOnly(paths.stateDb);
    const jobById = new Map(jobs.map((job) => [job.id, job]));
    const outputs = new Map<string, HermesCronRunOutput>();
    const runsByJob = new Map<string, ParsedHermesCronRun[]>();
    for (const run of contextRuns) {
      const siblings = runsByJob.get(run.jobId);
      if (siblings) siblings.push(run);
      else runsByJob.set(run.jobId, [run]);
    }
    try {
      const enriched = runs.map((run) => {
        const observed = readDelivery(deliveries, run.id);
        const cached = cache.get(run.id);
        const queue =
          observed === null
            ? cached
            : {
                ...observed,
                output:
                  observed.output.content === null
                    ? (cached?.output ?? EMPTY_OUTPUT)
                    : observed.output,
                targets: observed.targets?.length ? observed.targets : (cached?.targets ?? null),
              };
        if (queue !== undefined) remember(run.id, queue);
        const start = Date.parse(run.startedAt ?? run.claimedAt ?? "");
        const end = Date.parse(run.finishedAt ?? "");
        // Without an execution→session key, overlapping attempts cannot be correlated
        // safely even if only one of them persisted a session (e.g. an early failure).
        // An unparseable sibling interval counts as overlapping, so this fails closed too.
        const overlaps = (runsByJob.get(run.jobId) ?? []).some((other) => {
          if (other.id === run.id || other.jobId !== run.jobId) return false;
          const otherStart = Date.parse(other.startedAt ?? other.claimedAt ?? "");
          const otherEnd = other.finishedAt === null ? Infinity : Date.parse(other.finishedAt);
          return !(otherStart >= end || otherEnd <= start);
        });
        const output =
          queue?.output.content != null
            ? queue.output
            : overlaps
              ? EMPTY_OUTPUT
              : readSessionOutput(state, run, fullOutput);
        if (fullOutput) outputs.set(run.id, output);
        const plainText =
          output.content === null
            ? null
            : hermesOutputToPlainText(boundHermesOutput(output.content, PREVIEW_READ_LENGTH));
        const preview =
          plainText === null ? null : boundHermesOutput(plainText, HERMES_CRON_PREVIEW_LENGTH);
        const delivery: HermesCronDelivery = {
          preview,
          contentAvailable: output.content !== null,
          truncated:
            output.truncated ||
            (output.content?.length ?? 0) > PREVIEW_READ_LENGTH ||
            (plainText?.length ?? 0) > HERMES_CRON_PREVIEW_LENGTH,
          source: output.source,
          // The queue erases its job snapshot too; without an observed target,
          // expose the current configuration, not an asserted historic recipient.
          targets:
            queue?.targets ??
            (jobById.get(run.jobId)?.deliver ?? [])
              .slice(0, 20)
              .map((target) => boundHermesOutput(target, 200)),
          status: queue?.status ?? "unrecorded",
          error: queue?.error ?? null,
        };
        return { ...run, delivery };
      });
      return { runs: enriched, outputs };
    } finally {
      deliveries?.close();
      state?.close();
    }
  };
  return { read };
}
