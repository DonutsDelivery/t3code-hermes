/**
 * Hermes cron ("Tasks") contract over `cron/jobs.json` and `cron/executions.db`. Authoring stays in
 * chat; the only mutations are pause/resume and mute/unmute. Snapshots are pushed only when they
 * change.
 */
import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Bumped whenever {@link HermesCronSnapshot} changes incompatibly. Clients
 * render a plain "update T3 Code" notice instead of a half-decoded panel when
 * an environment reports a version they do not understand.
 */
export const HERMES_CRON_CONTRACT_VERSION = 1 as const;

/** Newest runs retained per job in a snapshot. Older attempts stay in Hermes. */
export const HERMES_CRON_RUNS_PER_JOB = 20;

export const HermesCronJobId = TrimmedNonEmptyString.pipe(Schema.brand("HermesCronJobId"));
export type HermesCronJobId = typeof HermesCronJobId.Type;

/**
 * Terminal and in-flight states of a single execution attempt, mirroring the
 * `status` column of the Hermes execution ledger.
 *
 * `unknown` is Hermes's own marker for an attempt whose owning process was
 * proved gone before it reported a result. It is not treated as a failure.
 */
export const HermesCronRunStatus = Schema.Literals([
  "claimed",
  "running",
  "completed",
  "failed",
  "unknown",
]);
export type HermesCronRunStatus = typeof HermesCronRunStatus.Type;

/**
 * Operator-facing state of a job.
 *
 * Hermes derives this from the flag its scheduler actually honours rather than
 * from the stored label, so a job that is enabled never displays as paused.
 */
export const HermesCronJobState = Schema.Literals(["scheduled", "paused", "completed", "error"]);
export type HermesCronJobState = typeof HermesCronJobState.Type;

/** Snapshots carry previews only; full output is fetched when a run is opened. */
export const HERMES_CRON_PREVIEW_LENGTH = 600;
/** Safety ceiling for a single on-demand response, not a websocket snapshot. */
export const HERMES_CRON_OUTPUT_LENGTH = 262_144;

export const HermesCronOutputSource = Schema.NullOr(Schema.Literals(["delivery", "session"]));
export const HermesCronDelivery = Schema.Struct({
  preview: Schema.NullOr(Schema.String.check(Schema.isMaxLength(HERMES_CRON_PREVIEW_LENGTH))),
  contentAvailable: Schema.Boolean,
  truncated: Schema.Boolean,
  source: HermesCronOutputSource,
  targets: Schema.Array(Schema.String),
  /** `unrecorded` is not a claim that a message was delivered. */
  status: Schema.Literals([
    "pending",
    "delivering",
    "delivered",
    "failed",
    "unknown",
    "unrecorded",
  ]),
  error: Schema.NullOr(Schema.String),
});
export type HermesCronDelivery = typeof HermesCronDelivery.Type;

export const HermesCronGetRunOutputInput = Schema.Struct({
  jobId: HermesCronJobId,
  runId: TrimmedNonEmptyString,
});
export type HermesCronGetRunOutputInput = typeof HermesCronGetRunOutputInput.Type;
export const HermesCronRunOutput = Schema.Struct({
  content: Schema.NullOr(Schema.String.check(Schema.isMaxLength(HERMES_CRON_OUTPUT_LENGTH))),
  truncated: Schema.Boolean,
  source: HermesCronOutputSource,
});
export type HermesCronRunOutput = typeof HermesCronRunOutput.Type;

/** One recorded execution attempt. */
export const HermesCronRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  jobId: HermesCronJobId,
  status: HermesCronRunStatus,
  /** What triggered the attempt — the scheduler tick, a manual run, and so on. */
  source: Schema.NullOr(Schema.String),
  claimedAt: Schema.NullOr(IsoDateTime),
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  /** Wall time from start to finish, when both ends were recorded. */
  durationMs: Schema.NullOr(Schema.Number),
  /** Failure text as Hermes recorded it, already truncated for display. */
  error: Schema.NullOr(Schema.String),
  delivery: Schema.optionalKey(HermesCronDelivery),
});
export type HermesCronRun = typeof HermesCronRun.Type;

/** A scheduled job plus the recent history T3 Code shows for it. */
export const HermesCronJob = Schema.Struct({
  id: HermesCronJobId,
  name: Schema.String,
  /** Human-readable schedule as Hermes renders it, e.g. `every 2h`. */
  scheduleDisplay: Schema.String,
  state: HermesCronJobState,
  /** The scheduler-honoured flag. Pausing a job clears it. */
  enabled: Schema.Boolean,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  /** Outcome Hermes stamped on the job record itself, e.g. `ok`. */
  lastStatus: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  /** Where results are delivered — `local`, `telegram`, `discord`, and so on. */
  deliver: ForwardCompatibleArray(Schema.String),
  /** True while this job's run notifications are suppressed for this environment. */
  muted: Schema.Boolean,
  /** Newest first, at most {@link HERMES_CRON_RUNS_PER_JOB} entries. */
  runs: ForwardCompatibleArray(HermesCronRun),
});
export type HermesCronJob = typeof HermesCronJob.Type;

/**
 * Why a snapshot has no jobs to show.
 *
 * These are distinct on purpose: the panel must never render a spinner or a
 * bare "no tasks" line when the real answer is that the provider is off or
 * that Hermes has never written a cron store.
 */
export const HermesCronAvailability = Schema.Literals([
  /** Jobs were read successfully. The list may still legitimately be empty. */
  "ready",
  /** The Hermes provider is disabled in this environment's settings. */
  "providerDisabled",
  /** No cron store exists yet — Hermes has never been asked for a task. */
  "noCronStore",
  /** The store exists but could not be read or parsed. */
  "unreadable",
]);
export type HermesCronAvailability = typeof HermesCronAvailability.Type;

export const HermesCronSnapshot = Schema.Struct({
  contractVersion: Schema.Literal(HERMES_CRON_CONTRACT_VERSION),
  readAt: IsoDateTime,
  availability: HermesCronAvailability,
  /**
   * Present when `availability` is `unreadable`. Short, already-safe text —
   * never a raw stack trace or an absolute path.
   */
  detail: Schema.NullOr(Schema.String),
  /**
   * False when the run ledger could not be opened. Jobs still render from the
   * last-run summary Hermes keeps on each job record; per-run history is empty.
   */
  runHistoryAvailable: Schema.Boolean,
  jobs: ForwardCompatibleArray(HermesCronJob),
});
export type HermesCronSnapshot = typeof HermesCronSnapshot.Type;

/**
 * A run that reached a terminal state since the environment last looked.
 * These ride the subscription rather than a separate notification channel: clients that are
 * watching raise their own toast, and a client that connects later gets the snapshot without a
 * backlog of announcements for runs that finished while it was away.
 */
export const HermesCronRunCompleted = Schema.Struct({
  jobId: HermesCronJobId,
  jobName: Schema.String,
  runId: TrimmedNonEmptyString,
  status: Schema.Literals(["completed", "failed"]),
  finishedAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(Schema.String),
  delivery: Schema.optionalKey(HermesCronDelivery),
});
export type HermesCronRunCompleted = typeof HermesCronRunCompleted.Type;

/**
 * What a subscriber receives. The first event is always a `snapshot`; further
 * snapshots arrive only when the state actually differs.
 */
export const HermesCronStreamEvent = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("snapshot"), snapshot: HermesCronSnapshot }),
  Schema.Struct({ _tag: Schema.tag("runCompleted"), run: HermesCronRunCompleted }),
]);
export type HermesCronStreamEvent = typeof HermesCronStreamEvent.Type;

/**
 * Subscribe or refresh. Environments keep polling Hermes only while at least
 * one client holds a subscription.
 */
export const HermesCronListInput = Schema.Struct({
  /**
   * When true the environment re-reads Hermes state before replying instead of
   * serving the cached snapshot.
   */
  refresh: Schema.optionalKey(Schema.Boolean),
});
export type HermesCronListInput = typeof HermesCronListInput.Type;

/** Pause or resume a job. Reversible, and the panel shows both directions. */
export const HermesCronSetEnabledInput = Schema.Struct({
  jobId: HermesCronJobId,
  enabled: Schema.Boolean,
});
export type HermesCronSetEnabledInput = typeof HermesCronSetEnabledInput.Type;

/**
 * Mute or unmute a job's run notifications.
 *
 * Mute is T3 Code's own state, not Hermes's: it changes what this environment
 * notifies about and never touches the job record, so the `hermes` CLI and any
 * other consumer of the cron store see exactly what they saw before.
 */
export const HermesCronSetMutedInput = Schema.Struct({
  jobId: HermesCronJobId,
  muted: Schema.Boolean,
});
export type HermesCronSetMutedInput = typeof HermesCronSetMutedInput.Type;

/** Every mutation answers with the snapshot that reflects it. */
export const HermesCronMutationResult = Schema.Struct({
  snapshot: HermesCronSnapshot,
});
export type HermesCronMutationResult = typeof HermesCronMutationResult.Type;

export class HermesCronError extends Schema.TaggedError<HermesCronError>()("HermesCronError", {
  reason: Schema.Literals(["providerDisabled", "unknownJob", "commandFailed", "unreadable"]),
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Hermes cron request failed (${this.reason}): ${this.detail}`;
  }
}
