/**
 * Client-side view of the Hermes cron subscription.
 *
 * The environment streams two kinds of event — a snapshot when the task list
 * changed, and a one-off announcement when a run finished. A React panel wants
 * neither of those directly; it wants "the current tasks, plus whether
 * something just landed". This module folds the stream into exactly that, so
 * both web and mobile can render from one shape and no client has to remember
 * which event it saw last.
 *
 * @module state/hermesCron
 */
import type {
  HermesCronJob,
  HermesCronRunCompleted,
  HermesCronSnapshot,
  HermesCronStreamEvent,
} from "@t3tools/contracts";
import { DateTime, Option } from "effect";

export interface HermesCronView {
  readonly snapshot: HermesCronSnapshot | null;
  /**
   * The most recent finished run, or `null` if none has landed this session.
   *
   * Paired with {@link completionSeq} rather than replaced-and-forgotten so a
   * consumer can tell "the same run I already toasted" from "it happened
   * again" without diffing run ids itself.
   */
  readonly lastCompletion: HermesCronRunCompleted | null;
  /** Increments once per completed run. Never resets while subscribed. */
  readonly completionSeq: number;
}

export const emptyHermesCronView: HermesCronView = {
  snapshot: null,
  lastCompletion: null,
  completionSeq: 0,
};

/**
 * Folds one event into the view.
 *
 * A `runCompleted` event deliberately keeps the previous snapshot: the
 * environment sends the announcement and the refreshed snapshot separately,
 * and blanking the list in between would flash the panel empty.
 */
function foldHermesCronEvent(
  previous: HermesCronView,
  event: HermesCronStreamEvent,
): HermesCronView {
  if (event._tag === "snapshot") {
    return { ...previous, snapshot: event.snapshot };
  }
  return {
    snapshot: previous.snapshot,
    lastCompletion: event.run,
    completionSeq: previous.completionSeq + 1,
  };
}

/**
 * `Stream.mapAccum` shape of {@link foldHermesCronEvent}: every event yields
 * the freshly folded view, so subscribers always hold the whole picture.
 */
export function foldHermesCronView(
  current: HermesCronView,
  event: HermesCronStreamEvent,
): readonly [HermesCronView, ReadonlyArray<HermesCronView>] {
  const next = foldHermesCronEvent(current, event);
  return [next, [next]];
}

/**
 * Seeds a composer so the user writes the schedule, not a form.
 *
 * Shared because the sentence a client starts for you is part of the feature,
 * not of the platform: web drops it into the chat composer, mobile copies it
 * for the existing new-task flow, and both must start the same way.
 */
export const HERMES_NEW_TASK_TEMPLATE = "Schedule a recurring task: ";

/** `null` when Hermes has never recorded a finished run for the job. */
export function formatHermesRunDuration(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  if (durationMs < 1_000) return `${durationMs}ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.round(seconds);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${totalSeconds % 60}s`;
}

/** `null` for both "never happened" and "Hermes wrote something unparseable". */
export function formatHermesTimestamp(value: string | null): string | null {
  if (value === null) return null;
  return Option.getOrNull(
    DateTime.make(value).pipe(Option.map((parsed) => DateTime.toDate(parsed).toLocaleString())),
  );
}

export type HermesCronStatusTone = "ok" | "failed" | "paused" | "idle";

export interface HermesCronStatusChip {
  readonly tone: HermesCronStatusTone;
  readonly label: string;
}

/**
 * The chip a job row shows.
 *
 * The job's own state outranks its history: a paused job that failed last week
 * is paused, not failed. Only once the state says the job is live does the
 * latest run get to speak.
 */
export function describeHermesJobStatus(job: HermesCronJob): HermesCronStatusChip {
  if (job.state === "paused") return { tone: "paused", label: "Paused" };
  if (job.state === "error") return { tone: "failed", label: "Error" };
  if (job.state === "completed") return { tone: "idle", label: "Completed" };
  const lastRun = job.runs[0];
  if (lastRun?.status === "failed" || job.lastStatus === "failed") {
    return { tone: "failed", label: "Failed" };
  }
  if (job.lastStatus === "ok" || lastRun?.status === "completed") {
    return { tone: "ok", label: "OK" };
  }
  return { tone: "idle", label: "Scheduled" };
}

/** One line under a job's name: schedule, last run, and how long it took. */
export function describeHermesJobSummary(job: HermesCronJob): string {
  const parts: string[] = [job.scheduleDisplay];
  const lastRun = formatHermesTimestamp(job.lastRunAt);
  parts.push(lastRun === null ? "never run" : `last run ${lastRun}`);
  const duration = formatHermesRunDuration(job.runs[0]?.durationMs ?? null);
  if (duration !== null) parts.push(duration);
  return parts.join(" · ");
}

/** Why the task list is empty, in words a panel can render as-is. */
export interface HermesCronEmptyState {
  readonly title: string;
  readonly description: string;
}

/**
 * Copy for every non-populated state.
 *
 * Returns `null` when there are tasks to show. The distinction between "not
 * enabled", "never used", and "could not read" is kept all the way to the UI
 * because each one has a different next action for the reader.
 */
export function describeHermesCronEmptyState(
  snapshot: HermesCronSnapshot | null,
): HermesCronEmptyState | null {
  if (snapshot === null) return null;
  if (snapshot.jobs.length > 0) return null;

  switch (snapshot.availability) {
    case "providerDisabled":
      return {
        title: "Hermes is not enabled here",
        description: "Turn on the Hermes provider in Settings to see its scheduled tasks.",
      };
    case "unreadable":
      return {
        title: "Hermes tasks could not be read",
        description: snapshot.detail ?? "The scheduled task list could not be read.",
      };
    case "noCronStore":
    case "ready":
      return {
        title: "No scheduled tasks",
        description:
          'Tasks are created by asking Hermes in chat. Try "every morning at 9, summarise my open PRs".',
      };
  }
}
