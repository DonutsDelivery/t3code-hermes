// @effect-diagnostics nodeBuiltinImport:off
/**
 * Readers for Hermes Agent's `cron/jobs.json` and `cron/executions.db`. Read directly because
 * `hermes cron` has no JSON output (as of 0.20.2). Defensive: malformed records are skipped.
 * Verified against 0.20.2; see `hermesCronFixtures.ts` when an upgrade changes them.
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  defaultInstanceIdForDriver,
  HERMES_CRON_RUNS_PER_JOB,
  HermesSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type HermesCronDelivery,
  type HermesCronJobState,
  type HermesCronRunStatus,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Failure text is shown inline in a panel row, so it is bounded on read. */
const MAX_ERROR_TEXT_LENGTH = 400;

const RUN_STATUSES = new Set<string>(["claimed", "running", "completed", "failed", "unknown"]);

export interface HermesCronPaths {
  readonly home: string;
  readonly cronDir: string;
  readonly jobsFile: string;
  readonly executionsDb: string;
  readonly deliveriesDb: string;
  readonly stateDb: string;
}

/** `HERMES_HOME` with a leading `~` expanded, as a shell would, otherwise `~/.hermes`. */
export function resolveHermesHome(
  environment: NodeJS.ProcessEnv = process.env,
  homedir: string = NodeOS.homedir(),
): string {
  const configured = environment["HERMES_HOME"]?.trim();
  if (!configured) return NodePath.join(homedir, ".hermes");
  if (configured === "~") return homedir;
  if (configured.startsWith("~/")) return NodePath.join(homedir, configured.slice(2));
  return configured;
}

/**
 * Resolves the Hermes home the same way the usage reader does — `HERMES_HOME`
 * when set, otherwise `~/.hermes`.
 */
export function resolveHermesCronPaths(
  environment: NodeJS.ProcessEnv = process.env,
  homedir: string = NodeOS.homedir(),
): HermesCronPaths {
  const home = resolveHermesHome(environment, homedir);
  const cronDir = NodePath.join(home, "cron");
  return {
    home,
    cronDir,
    jobsFile: NodePath.join(cronDir, "jobs.json"),
    executionsDb: NodePath.join(cronDir, "executions.db"),
    deliveriesDb: NodePath.join(cronDir, "deliveries.db"),
    stateDb: NodePath.join(home, "state.db"),
  };
}

const HERMES_DRIVER_KIND = ProviderDriverKind.make("hermes");
const decodeHermesSettings = Schema.decodeUnknownOption(HermesSettings);

/** The Hermes instance this environment runs: its config plus its own env overrides. */
export interface EnabledHermesInstance {
  readonly instanceId: ProviderInstanceId;
  readonly settings: HermesSettings;
  readonly environment: ProviderInstanceConfig["environment"];
}

/**
 * The enabled Hermes instance (default slot first), or `null`, resolved like the provider registry.
 * Its `environment` matters: `HERMES_HOME` there redirects cron reads and CLI calls.
 */
export function resolveEnabledHermesInstance(
  settings: ServerSettings,
): EnabledHermesInstance | null {
  const defaultId = defaultInstanceIdForDriver(HERMES_DRIVER_KIND);
  const candidates: Array<readonly [ProviderInstanceId, ProviderInstanceConfig]> = [
    [
      defaultId,
      settings.providerInstances[defaultId] ?? { driver: HERMES_DRIVER_KIND, config: {} },
    ],
  ];
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    if (instanceId !== defaultId) candidates.push([ProviderInstanceId.make(instanceId), instance]);
  }
  const enabled = candidates.find(
    ([, instance]) =>
      instance.driver === HERMES_DRIVER_KIND && resolveProviderInstanceEnabled(instance),
  );
  if (enabled === undefined) return null;
  const [instanceId, instance] = enabled;
  const decoded = decodeHermesSettings(instance.config ?? {});
  if (Option.isNone(decoded)) return null;
  return { instanceId, settings: decoded.value, environment: instance.environment };
}

/** A job as it appears on disk, after normalisation but before contract encoding. */
export interface ParsedHermesCronJob {
  readonly id: string;
  readonly name: string;
  readonly scheduleDisplay: string;
  readonly state: HermesCronJobState;
  readonly enabled: boolean;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastStatus: string | null;
  readonly lastError: string | null;
  readonly deliver: readonly string[];
}

export interface ParsedHermesCronRun {
  readonly delivery?: HermesCronDelivery;
  readonly id: string;
  readonly jobId: string;
  readonly status: HermesCronRunStatus;
  readonly source: string | null;
  readonly claimedAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Hermes's `_coerce_job_text`: nullable and hand-edited fields are coerced to
 * text for readers rather than rejected.
 */
function coerceText(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function nonEmptyOrNull(value: unknown): string | null {
  const text = coerceText(value).trim();
  return text.length === 0 ? null : text;
}

function boundedError(value: unknown): string | null {
  const text = nonEmptyOrNull(value);
  if (text === null) return null;
  return text.length > MAX_ERROR_TEXT_LENGTH ? `${text.slice(0, MAX_ERROR_TEXT_LENGTH)}…` : text;
}

/**
 * Port of Hermes's `_schedule_display_for_job`. The stored `schedule_display`
 * wins; otherwise the first populated key of the parsed schedule object.
 */
function scheduleDisplayFor(job: Record<string, unknown>): string {
  const display = coerceText(job["schedule_display"]).trim();
  if (display.length > 0) return display;

  const schedule = job["schedule"];
  if (isRecord(schedule)) {
    for (const key of ["display", "value", "expr", "run_at"] as const) {
      const text = coerceText(schedule[key]).trim();
      if (text.length > 0) return text;
    }
    return "?";
  }
  if (schedule !== null && schedule !== undefined) {
    const text = coerceText(schedule).trim();
    if (text.length > 0) return text;
  }
  return "?";
}

function hasPauseMarker(job: Record<string, unknown>): boolean {
  if (coerceText(job["state"]).trim() === "paused") return true;
  return Boolean(job["paused_at"]);
}

/**
 * Port of Hermes's `effective_job_state`.
 * The subtlety worth preserving: `enabled: true` is authoritative, so a record that still carries a
 * stale `paused` label reads as scheduled. Hermes learned that the hard way — a list that showed
 * every job as paused while the scheduler happily kept firing them.
 */
export function effectiveJobState(job: Record<string, unknown>): HermesCronJobState {
  const stored = coerceText(job["state"]).trim();
  if (stored === "completed" || stored === "error") return stored;

  const enabled = job["enabled"] === undefined ? true : Boolean(job["enabled"]);
  if (!enabled) {
    if (hasPauseMarker(job) || stored === "paused") return "paused";
    return isJobState(stored) ? stored : "paused";
  }
  if (stored === "paused" || job["paused_at"]) return "scheduled";
  return isJobState(stored) ? stored : "scheduled";
}

function isJobState(value: string): value is HermesCronJobState {
  return value === "scheduled" || value === "paused" || value === "completed" || value === "error";
}

/**
 * Port of Hermes's own `deliver` coalescing. The field can be absent, null, a
 * bare string, or a list; a null slipping through once crashed the CLI's whole
 * listing, which is why this is spelled out rather than defaulted.
 */
function parseDeliver(value: unknown): readonly string[] {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length === 0 ? ["local"] : [text];
  }
  if (Array.isArray(value)) {
    const targets = value
      .map((entry) => coerceText(entry).trim())
      .filter((entry) => entry.length > 0);
    return targets.length === 0 ? ["local"] : targets;
  }
  return ["local"];
}

/**
 * Parses the contents of `jobs.json`.
 *
 * Accepts both shapes Hermes itself accepts: the canonical `{"jobs": [...]}`
 * wrapper and a bare array, which Hermes auto-repairs on its next write.
 * Returns `null` only when the payload is neither.
 */
export function parseHermesCronJobs(raw: unknown): readonly ParsedHermesCronJob[] | null {
  const entries = isRecord(raw) ? raw["jobs"] : raw;
  if (!Array.isArray(entries)) return null;

  const jobs: ParsedHermesCronJob[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const id = coerceText(entry["id"]).trim();
    // A record without an id cannot be paused, muted, or correlated with a
    // run. Hermes tolerates them on disk; there is nothing for a panel to do
    // with one.
    if (id.length === 0) continue;

    const name = coerceText(entry["name"]).trim();
    jobs.push({
      id,
      name: name.length === 0 ? "(unnamed)" : name,
      scheduleDisplay: scheduleDisplayFor(entry),
      state: effectiveJobState(entry),
      enabled: entry["enabled"] === undefined ? true : Boolean(entry["enabled"]),
      nextRunAt: nonEmptyOrNull(entry["next_run_at"]),
      lastRunAt: nonEmptyOrNull(entry["last_run_at"]),
      lastStatus: nonEmptyOrNull(entry["last_status"]),
      lastError: boundedError(entry["last_error"]),
      deliver: parseDeliver(entry["deliver"]),
    });
  }
  return jobs;
}

function parseTimestampMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function durationBetween(startedAt: string | null, finishedAt: string | null): number | null {
  const start = parseTimestampMs(startedAt);
  const end = parseTimestampMs(finishedAt);
  if (start === null || end === null) return null;
  const elapsed = end - start;
  return elapsed >= 0 ? elapsed : null;
}

/** Shape of one row of the Hermes `executions` table. */
interface ExecutionRow {
  readonly id: unknown;
  readonly job_id: unknown;
  readonly status: unknown;
  readonly source: unknown;
  readonly claimed_at: unknown;
  readonly started_at: unknown;
  readonly finished_at: unknown;
  readonly error: unknown;
}

function parseHermesCronRun(row: ExecutionRow): ParsedHermesCronRun | null {
  const id = coerceText(row.id).trim();
  const jobId = coerceText(row.job_id).trim();
  if (id.length === 0 || jobId.length === 0) return null;

  const status = coerceText(row.status).trim();
  // The column is CHECK-constrained in Hermes, so an unrecognised value means
  // the ledger schema moved. Drop the row rather than invent a status.
  if (!RUN_STATUSES.has(status)) return null;

  const startedAt = nonEmptyOrNull(row.started_at);
  const finishedAt = nonEmptyOrNull(row.finished_at);
  return {
    id,
    jobId,
    status: status as HermesCronRunStatus,
    source: nonEmptyOrNull(row.source),
    claimedAt: nonEmptyOrNull(row.claimed_at),
    startedAt,
    finishedAt,
    durationMs: durationBetween(startedAt, finishedAt),
    error: boundedError(row.error),
  };
}

function parseHermesCronRuns(rows: readonly ExecutionRow[]): readonly ParsedHermesCronRun[] {
  const runs: ParsedHermesCronRun[] = [];
  for (const row of rows) {
    const run = parseHermesCronRun(row);
    if (run !== null) runs.push(run);
  }
  return runs;
}

/**
 * Groups runs by job, newest first, capped per job.
 *
 * The ledger query already orders newest-first across all jobs, so the cap can
 * be applied while grouping.
 */
export function groupRunsByJob(
  runs: readonly ParsedHermesCronRun[],
  perJob: number = HERMES_CRON_RUNS_PER_JOB,
): ReadonlyMap<string, readonly ParsedHermesCronRun[]> {
  const grouped = new Map<string, ParsedHermesCronRun[]>();
  for (const run of runs) {
    const existing = grouped.get(run.jobId);
    if (existing === undefined) {
      grouped.set(run.jobId, [run]);
    } else if (existing.length < perJob) {
      existing.push(run);
    }
  }
  return grouped;
}

/**
 * The newest attempts per job, capped per job so a frequent job can't crowd out a quiet one; one
 * indexed `SELECT` per job. `null` when the ledger can't be opened, as on a fresh install with no
 * runs yet.
 */
export function readHermesCronRuns(
  dbPath: string,
  jobIds: readonly string[],
  perJob: number = HERMES_CRON_RUNS_PER_JOB,
): readonly ParsedHermesCronRun[] | null {
  if (jobIds.length === 0) return [];

  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true, timeout: 5_000 });
  } catch {
    return null;
  }

  try {
    // Hermes indexes `(job_id, claimed_at DESC, id DESC)`, so this mirrors its
    // own `list_executions` ordering and stays on the index.
    const statement = database.prepare(`
      SELECT id, job_id, status, source, claimed_at, started_at, finished_at, error
      FROM executions
      WHERE job_id = ?
      ORDER BY claimed_at DESC, id DESC
      LIMIT ?
    `);
    const rows: ExecutionRow[] = [];
    for (const jobId of jobIds) {
      rows.push(...(statement.all(jobId, perJob) as unknown as readonly ExecutionRow[]));
    }
    return parseHermesCronRuns(rows);
  } catch {
    return null;
  } finally {
    database.close();
  }
}
