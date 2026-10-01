/**
 * Hermes background work over ACP. Only the carried `acp-background-reports`
 * patch (infra/hermes) sends `_hermes/process` and `_hermes/notification`;
 * stock Hermes reports nothing once a background terminal call returns, so
 * without the patch no task is ever opened and none can be left running.
 */
import {
  RuntimeTaskId,
  type ProviderRuntimeTaskCompletedEvent,
  type ProviderRuntimeTaskStartedEvent,
  type TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const HERMES_PROCESS_METHOD = "_hermes/process";

/** A background process a `terminal` call left running, then its exit. */
export const HermesProcessReport = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  processId: Schema.String,
  command: Schema.String,
  status: Schema.Literals(["running", "exited"]),
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
  reason: Schema.optional(Schema.String),
});
export type HermesProcessReport = typeof HermesProcessReport.Type;

export const HERMES_NOTIFICATION_METHOD = "_hermes/notification";

/**
 * Text Hermes's CLI would inject as the next turn when background work
 * finishes (a process exit, a watch match, a subagent result). Hermes sends it
 * only while the session is idle.
 */
export const HermesNotification = Schema.Struct({
  sessionId: Schema.String,
  kind: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.String,
  notificationIds: Schema.optional(Schema.Array(Schema.String)),
});
export type HermesNotification = typeof HermesNotification.Type;

type TaskEvent = (
  | Pick<ProviderRuntimeTaskStartedEvent, "type" | "payload">
  | Pick<ProviderRuntimeTaskCompletedEvent, "type" | "payload">
) & { readonly turnId?: TurnId };

interface LiveProcess {
  readonly payload: {
    readonly taskId: RuntimeTaskId;
    readonly taskType: "shell";
    readonly description: string;
    readonly title: string;
    readonly toolUseId: string;
  };
  readonly turnId: TurnId | undefined;
}

function outcome(report: HermesProcessReport): {
  status: "completed" | "failed" | "stopped";
  summary?: string;
} {
  if (report.reason === "killed") return { status: "stopped", summary: "Stopped" };
  if (report.reason === "lost") return { status: "failed", summary: "Process backend disappeared" };
  if (report.reason === "failed_start") return { status: "failed", summary: "Failed to start" };
  if (report.exitCode === 0) return { status: "completed" };
  return {
    status: "failed",
    ...(typeof report.exitCode === "number" ? { summary: `Exit code ${report.exitCode}` } : {}),
  };
}

/** Background shells as tasks: the thread reads as Monitoring until each exits. */
export class HermesBackgroundProcesses {
  private readonly live = new Map<string, LiveProcess>();

  report(report: HermesProcessReport, turnId: TurnId | undefined): TaskEvent[] {
    const known = this.live.get(report.processId);
    if (report.status === "running") {
      if (known) return [];
      const description =
        report.command.trim().split("\n")[0]!.slice(0, 200) || "Background process";
      const process: LiveProcess = {
        payload: {
          taskId: RuntimeTaskId.make(report.processId),
          taskType: "shell",
          description,
          title: description,
          toolUseId: report.toolCallId,
        },
        turnId,
      };
      this.live.set(report.processId, process);
      return [{ type: "task.started", payload: process.payload, ...attribution(process) }];
    }
    if (!known) return [];
    this.live.delete(report.processId);
    const { status, summary } = outcome(report);
    return [
      {
        type: "task.completed",
        payload: { ...known.payload, status, ...(summary ? { summary } : {}) },
        ...attribution(known),
      },
    ];
  }

  /** Hermes kills its background processes when its ACP process goes away. */
  stopAll(): TaskEvent[] {
    const events: TaskEvent[] = [...this.live.values()].map((process) => ({
      type: "task.completed",
      payload: { ...process.payload, status: "stopped", summary: "Hermes session ended" },
      ...attribution(process),
    }));
    this.live.clear();
    return events;
  }
}

const attribution = (process: LiveProcess) => (process.turnId ? { turnId: process.turnId } : {});
