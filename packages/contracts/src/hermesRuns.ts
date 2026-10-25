/**
 * Which Hermes background jobs (webhook routes, cron jobs, any profile) mirror into threads in a
 * project. A run's transcript, PR, and lifecycle arrive through the ordinary thread read model as
 * `hermesRun`.
 */
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * A Hermes background run (a webhook route delivery or a cron job firing) mirrored into this
 * thread. Hermes runs these on its own; T3 Code tails Hermes's session store and replays each run
 * as a thread. `live` holds while Hermes is still working, and replies to any thread of the same
 * source wait for every live run of that source to finish.
 */
export const ThreadHermesRun = Schema.Struct({
  /** Hermes profile the run belongs to: "default", or a name under `profiles/`. */
  profile: TrimmedNonEmptyString,
  /** "webhook:<route>" or "cron:<jobId>". */
  sourceKey: TrimmedNonEmptyString,
  sourceLabel: TrimmedNonEmptyString,
  /** Hermes session the run started as. */
  sessionId: TrimmedNonEmptyString,
  /** Newest session in the run's compression chain. */
  latestSessionId: TrimmedNonEmptyString,
  live: Schema.Boolean,
});
export type ThreadHermesRun = typeof ThreadHermesRun.Type;

export const HermesRunSourceKind = Schema.Literals(["webhook", "cron"]);
export type HermesRunSourceKind = typeof HermesRunSourceKind.Type;

export const HermesRunSource = Schema.Struct({
  /** "default", or a profile name under `<hermes home>/profiles/`. */
  profile: TrimmedNonEmptyString,
  /** "webhook:<route>" or "cron:<jobId>". Stable across renames of a cron job. */
  sourceKey: TrimmedNonEmptyString,
  kind: HermesRunSourceKind,
  /** Route name or job name. */
  label: TrimmedNonEmptyString,
  /** Events a route listens for, or a job's schedule. */
  detail: Schema.NullOr(Schema.String),
  /** False when the route or job is gone from Hermes's config but has past runs. */
  configured: Schema.Boolean,
  lastRunAt: Schema.NullOr(IsoDateTime),
  /** Runs in the last 30 days that used tools, the ones that would become threads. */
  recentRunCount: NonNegativeInt,
  /** Project its runs become threads in; null while switched off. */
  projectId: Schema.NullOr(ProjectId),
  /** Best guess at the project, from a cron job's workdir or a repository the route names. */
  suggestedProjectId: Schema.NullOr(ProjectId),
});
export type HermesRunSource = typeof HermesRunSource.Type;

export const HermesRunSourcesResult = Schema.Struct({
  /** False when no Hermes provider is enabled; `sources` is then empty. */
  hermesEnabled: Schema.Boolean,
  sources: ForwardCompatibleArray(HermesRunSource),
});
export type HermesRunSourcesResult = typeof HermesRunSourcesResult.Type;

export const HermesRunSourcesListInput = Schema.Struct({});
export type HermesRunSourcesListInput = typeof HermesRunSourcesListInput.Type;

/** Switch a source on (with the project its runs go to) or off (null). */
export const HermesRunSourceSetInput = Schema.Struct({
  profile: TrimmedNonEmptyString,
  sourceKey: TrimmedNonEmptyString,
  projectId: Schema.NullOr(ProjectId),
});
export type HermesRunSourceSetInput = typeof HermesRunSourceSetInput.Type;

export class HermesRunError extends Schema.TaggedError<HermesRunError>()("HermesRunError", {
  reason: Schema.Literals([
    "providerDisabled",
    "unknownProject",
    "unknownSource",
    "unreadable",
    "writeFailed",
  ]),
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Hermes runs request failed (${this.reason}): ${this.detail}`;
  }
}

/**
 * Whether a reply to `run`'s thread has to wait. A source's runs share state
 * (the resolver's branch, a job's working files), so replying to any of its
 * threads waits until none of its runs is still live.
 */
export function isHermesRunSourceBusy(
  run: ThreadHermesRun,
  threads: ReadonlyArray<{
    readonly hermesRun?: ThreadHermesRun | null | undefined;
    /** An ISO string or a DateTime; any non-null value marks the thread deleted. */
    readonly deletedAt?: unknown;
  }>,
): boolean {
  return threads.some(
    (thread) =>
      (thread.deletedAt ?? null) === null &&
      thread.hermesRun?.live === true &&
      thread.hermesRun.profile === run.profile &&
      thread.hermesRun.sourceKey === run.sourceKey,
  );
}

/** `hermes-run:<profile>:<root session>`: a mirrored run's thread id, turn id, and id prefix. */
export function hermesRunIdPrefix(run: Pick<ThreadHermesRun, "profile" | "sessionId">): string {
  return `hermes-run:${run.profile}:${run.sessionId}`;
}

/**
 * Whether a thread's latest activity is a mirrored default-profile cron run Hermes Tasks already
 * announces, so it isn't alerted twice. Once a reply starts a run (`latestRunId`), the thread
 * alerts as usual.
 */
export function isHermesTasksAnnouncedTurn(thread: {
  readonly hermesRun?: ThreadHermesRun | null | undefined;
  readonly latestRunId?: string | null | undefined;
}): boolean {
  const run = thread.hermesRun;
  return (
    run != null &&
    run.profile === "default" &&
    run.sourceKey.startsWith("cron:") &&
    (thread.latestRunId ?? null) === null
  );
}
