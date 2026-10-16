import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import { deriveSubagentElapsedMs, formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";

export function subagentCardDetail(detail: string | null): string | null {
  if (!detail || /^Child task ended with status\b/i.test(detail)) return null;
  return (
    detail
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`/g, "")
      .replace(/^[ \t]*[-*][ \t]+/gm, "")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

/** A lone agent shows its own duration, which prefers the provider's report. */
export function subagentCardElapsed(
  agents: ReadonlyArray<
    Pick<OrchestrationV2Subagent, "status" | "startedAt" | "completedAt" | "usage">
  >,
  nowMs: number,
): string | null {
  const only = agents.length === 1 ? agents[0] : undefined;
  if (only !== undefined) {
    const elapsedMs = deriveSubagentElapsedMs(
      {
        status: only.status,
        startedAt: only.startedAt === null ? null : DateTime.formatIso(only.startedAt),
        completedAt: only.completedAt === null ? null : DateTime.formatIso(only.completedAt),
        usage: only.usage,
      },
      nowMs,
    );
    return elapsedMs ? formatDuration(elapsedMs) : null;
  }
  const starts = agents.flatMap((agent) =>
    agent.startedAt ? [DateTime.toEpochMillis(agent.startedAt)] : [],
  );
  if (starts.length === 0) return null;
  const live = agents.some((agent) => isActiveSubagentStatus(agent.status));
  if (!live && agents.some((agent) => agent.completedAt === null)) return null;
  const ends = agents.flatMap((agent) =>
    agent.completedAt ? [DateTime.toEpochMillis(agent.completedAt)] : [],
  );
  const duration = (live ? nowMs : Math.max(...ends)) - Math.min(...starts);
  return duration > 0 ? formatDuration(duration) : null;
}
