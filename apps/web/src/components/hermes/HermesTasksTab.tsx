/**
 * Tasks tab — Hermes's own scheduled jobs.
 *
 * Read-mostly by design. Creating and editing tasks stays in chat, so the only
 * controls here are the two reversible ones: pause/resume and mute/unmute.
 *
 * The component is deliberately dumb; everything that decides anything lives in
 * `useHermesCron` and the client-runtime fold behind it.
 */
import {
  describeHermesJobStatus,
  describeHermesJobSummary,
  type HermesCronStatusTone,
} from "@t3tools/client-runtime/state/hermes-cron";
import type { EnvironmentId, HermesCronJob, HermesCronJobId } from "@t3tools/contracts";
import {
  BellIcon,
  BellOffIcon,
  ChevronRightIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useHermesCron } from "../../state/hermesCron";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import { HermesRunRow } from "./HermesRunRow";
import { EMPTY_HERMES_SEARCH, type HermesSearch } from "./hermesNavigation";

export interface HermesTasksTabProps {
  readonly environmentId: EnvironmentId | null;
  readonly target?: HermesSearch;
  /** Closes the panel and drops a scheduling prompt into the composer. */
  readonly onNewTask: () => void;
}

const CHIP_CLASSES: Record<HermesCronStatusTone, string> = {
  ok: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  paused: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  idle: "bg-muted text-muted-foreground",
};

function StatusChip({ job }: { readonly job: HermesCronJob }) {
  const { tone, label } = describeHermesJobStatus(job);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium",
        CHIP_CLASSES[tone],
      )}
    >
      {label}
    </span>
  );
}

function TaskRow({
  job,
  environmentId,
  targetRunId,
  targeted,
  onSetEnabled,
  onSetMuted,
}: {
  readonly job: HermesCronJob;
  readonly environmentId: EnvironmentId;
  readonly targetRunId: string | undefined;
  readonly targeted: boolean;
  readonly onSetEnabled: (jobId: HermesCronJobId, enabled: boolean) => void;
  readonly onSetMuted: (jobId: HermesCronJobId, muted: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(targeted);
  const toggleExpanded = () => setExpanded((value) => !value);
  const pauseLabel = job.enabled ? "Pause task" : "Resume task";
  const muteLabel = job.muted ? "Unmute notifications" : "Mute notifications";

  return (
    <li className="rounded-lg border border-border/60 px-3 py-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} task ${job.name}`}
          onClick={toggleExpanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRightIcon
            className={cn("size-4 shrink-0 text-muted-foreground", expanded && "rotate-90")}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{job.name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {describeHermesJobSummary(job)}
            </span>
          </span>
        </button>
        <StatusChip job={job} />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={pauseLabel}
                aria-pressed={!job.enabled}
                onClick={() => onSetEnabled(job.id, !job.enabled)}
                size="icon"
                variant="ghost"
              >
                {job.enabled ? <PauseIcon /> : <PlayIcon />}
              </Button>
            }
          />
          <TooltipPopup side="top">{pauseLabel}</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={muteLabel}
                aria-pressed={job.muted}
                onClick={() => onSetMuted(job.id, !job.muted)}
                size="icon"
                variant="ghost"
              >
                {job.muted ? <BellOffIcon /> : <BellIcon />}
              </Button>
            }
          />
          <TooltipPopup side="top">{muteLabel}</TooltipPopup>
        </Tooltip>
      </div>

      {expanded ? (
        <div className="mt-2 pl-6">
          {job.deliver.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Configured targets: {job.deliver.join(", ")}
            </p>
          ) : null}
          {job.lastError === null ? null : (
            <p className="mt-1 break-words font-mono text-2xs text-destructive">{job.lastError}</p>
          )}
          {targeted && targetRunId && !job.runs.some((run) => run.id === targetRunId) ? (
            <p className="mt-1 text-xs text-muted-foreground">
              The requested run is no longer in recent history.
            </p>
          ) : null}
          {job.runs.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">No recorded runs yet.</p>
          ) : (
            <ul className="mt-1">
              {job.runs.map((run) => (
                <HermesRunRow
                  key={`${run.id}:${targeted && run.id === targetRunId}`}
                  run={run}
                  environmentId={environmentId}
                  targeted={targeted && run.id === targetRunId}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}

/** Shape-matched ghost, so the real list does not shift the layout when it lands. */
function TasksGhost() {
  return (
    <ul className="flex flex-col gap-2" aria-hidden>
      {[0, 1, 2].map((index) => (
        <li key={index} className="rounded-lg border border-border/60 px-3 py-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-1.5 h-4 w-64" />
        </li>
      ))}
    </ul>
  );
}

export function HermesTasksTab({
  environmentId,
  onNewTask,
  target = EMPTY_HERMES_SEARCH,
}: HermesTasksTabProps) {
  const { jobs, isPending, error, emptyState, view, setEnabled, setMuted } =
    useHermesCron(environmentId);

  return (
    <div className="flex flex-col gap-3">
      {error !== null ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Hermes tasks are unavailable</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : isPending ? (
        <TasksGhost />
      ) : emptyState !== null ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{emptyState.title}</EmptyTitle>
            <EmptyDescription>{emptyState.description}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {view.snapshot?.runHistoryAvailable === false ? (
            <p className="text-xs text-muted-foreground">
              Run history is unavailable, so only the latest outcome is shown.
            </p>
          ) : null}
          {target.jobId && !jobs.some((job) => job.id === target.jobId) ? (
            <p className="text-xs text-muted-foreground">
              The requested task is no longer available on this environment.
            </p>
          ) : null}
          <ul className="flex flex-col gap-2">
            {environmentId !== null &&
              jobs.map((job) => (
                <TaskRow
                  key={`${environmentId}:${job.id}:${job.id === target.jobId ? (target.runId ?? "target") : ""}`}
                  job={job}
                  environmentId={environmentId}
                  targeted={job.id === target.jobId}
                  targetRunId={target.runId}
                  onSetEnabled={setEnabled}
                  onSetMuted={setMuted}
                />
              ))}
          </ul>
        </>
      )}

      <div className="border-t border-border/60 pt-3">
        <Button onClick={onNewTask} variant="ghost">
          <PlusIcon />
          New task…
        </Button>
        <p className="mt-1 text-xs text-muted-foreground">
          Tasks are written by Hermes itself — describe the schedule you want in chat.
        </p>
      </div>
    </div>
  );
}
