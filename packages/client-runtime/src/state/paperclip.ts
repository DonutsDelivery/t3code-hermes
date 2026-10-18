// @effect-diagnostics globalDate:off -- Display-only relative ages and locale date labels for UI rows.
/**
 * Presentation for the read-only Paperclip surface, shared by every client.
 *
 * Pure functions over the overview the environment returns: what the
 * connection line says, how statuses read, and how agents nest under the
 * agent they report to. No atoms here; each client reads the overview through
 * its own `serverEnvironment.paperclipOverview` query.
 *
 * @module state/paperclip
 */
import type {
  PaperclipAgent,
  PaperclipIssue,
  PaperclipOverviewResult,
  PaperclipViewer,
} from "@t3tools/contracts";

export type PaperclipTone = "ready" | "attention" | "idle";

export interface PaperclipConnectionSummary {
  readonly tone: PaperclipTone;
  readonly label: string;
  readonly detail: string | null;
}

/**
 * The Settings line for the connection: does it answer, as whom, and can it
 * write. `result` is null until the first read lands.
 */
export function describePaperclipConnection(
  result: PaperclipOverviewResult | null,
  options: { readonly enabled: boolean },
): PaperclipConnectionSummary {
  if (!options.enabled) {
    return {
      tone: "idle",
      label: "Off",
      detail: "The Paperclip surface stays empty until this is on.",
    };
  }
  if (result === null) return { tone: "idle", label: "Checking…", detail: null };
  switch (result.status.availability) {
    case "ready":
      return {
        tone: "ready",
        label: "Connected",
        detail: [result.company?.name ?? null, describePaperclipViewer(result.viewer)]
          .filter((part): part is string => part !== null)
          .join(" · "),
      };
    case "notConfigured":
      return { tone: "attention", label: "Not set up", detail: result.status.detail };
    case "offline":
      return { tone: "attention", label: "Not answering", detail: result.status.detail };
    case "unauthorized":
      return { tone: "attention", label: "Key rejected", detail: result.status.detail };
    default:
      return { tone: "attention", label: "Needs attention", detail: result.status.detail };
  }
}

/** "viewer, read-only" — what the key may do, in words. */
export function describePaperclipViewer(viewer: PaperclipViewer | null): string | null {
  if (viewer === null) return null;
  const who = viewer.name === null ? null : `as ${viewer.name}`;
  const role = viewer.isInstanceAdmin ? "instance admin" : (viewer.role ?? "no role");
  const access = viewer.readOnly ? "read-only" : "can write";
  return [who, `${role}, ${access}`].filter((part): part is string => part !== null).join(" ");
}

/** `in_progress` → `In progress`. Paperclip's statuses are snake_case words. */
export function formatPaperclipStatus(status: string): string {
  const words = status.replaceAll("_", " ").trim();
  return words.length === 0 ? status : words[0]!.toUpperCase() + words.slice(1);
}

/** Which badge an agent, issue, or run status deserves. */
export function paperclipStatusTone(
  status: string,
): "success" | "warning" | "error" | "info" | "secondary" {
  switch (status) {
    case "running":
    case "in_progress":
    case "active":
      return "info";
    case "done":
    case "succeeded":
    case "completed":
      return "success";
    case "blocked":
    case "paused":
    case "in_review":
    case "pending_approval":
      return "warning";
    case "error":
    case "failed":
    case "timed_out":
    case "cancelled":
    case "terminated":
      return "error";
    default:
      return "secondary";
  }
}

/** Short relative age for a row. Null when Paperclip did not record a time. */
export function formatPaperclipAge(value: string | null, now: number = Date.now()): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const elapsed = now - parsed;
  if (elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(parsed).toLocaleDateString();
}

/** `$1.20`; whole dollars drop the cents. */
export function formatPaperclipCents(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

export interface PaperclipOrgRow {
  readonly agent: PaperclipAgent;
  /** 0 at the top of the org chart. */
  readonly depth: number;
  /** Open issues assigned to this agent. */
  readonly openIssues: number;
}

const CLOSED_ISSUE_STATUSES = new Set(["done", "cancelled"]);

/**
 * Agents in org-chart order: each manager followed by its reports, depth
 * first, siblings by name.
 *
 * An agent whose manager is not in the list (terminated, or outside what the
 * key can see) is treated as a root rather than hidden, and a reporting cycle
 * is broken where it is found, so every agent appears exactly once.
 */
export function paperclipOrgRows(
  agents: ReadonlyArray<PaperclipAgent>,
  issues: ReadonlyArray<PaperclipIssue>,
): ReadonlyArray<PaperclipOrgRow> {
  const ids = new Set(agents.map((agent) => agent.id));
  const openByAgent = new Map<string, number>();
  for (const issue of issues) {
    if (issue.assigneeAgentId === null || CLOSED_ISSUE_STATUSES.has(issue.status)) continue;
    openByAgent.set(issue.assigneeAgentId, (openByAgent.get(issue.assigneeAgentId) ?? 0) + 1);
  }
  const byName = (left: PaperclipAgent, right: PaperclipAgent) =>
    left.name.localeCompare(right.name);
  const children = new Map<string, Array<PaperclipAgent>>();
  const roots: Array<PaperclipAgent> = [];
  for (const agent of agents) {
    if (agent.reportsTo === null || !ids.has(agent.reportsTo) || agent.reportsTo === agent.id) {
      roots.push(agent);
    } else {
      const siblings = children.get(agent.reportsTo) ?? [];
      siblings.push(agent);
      children.set(agent.reportsTo, siblings);
    }
  }

  const rows: Array<PaperclipOrgRow> = [];
  const seen = new Set<string>();
  const visit = (agent: PaperclipAgent, depth: number) => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    rows.push({ agent, depth, openIssues: openByAgent.get(agent.id) ?? 0 });
    for (const child of (children.get(agent.id) ?? []).sort(byName)) visit(child, depth + 1);
  };
  for (const root of roots.sort(byName)) visit(root, 0);
  // Agents only reachable through a cycle never met a root; list them flat.
  for (const agent of [...agents].sort(byName)) visit(agent, 0);
  return rows;
}

/** Names for ids in rows that only carry an id. Unknown ids read as a short id. */
export function paperclipAgentName(
  agents: ReadonlyArray<PaperclipAgent>,
  id: string | null,
): string | null {
  if (id === null) return null;
  return agents.find((agent) => agent.id === id)?.name ?? `Agent ${id.slice(0, 8)}`;
}

export type PaperclipRefreshUnit = "seconds" | "minutes" | "hours" | "days";

export const PAPERCLIP_REFRESH_UNIT_SECONDS: Readonly<Record<PaperclipRefreshUnit, number>> = {
  seconds: 1,
  minutes: 60,
  hours: 3_600,
  days: 86_400,
};

/**
 * Each overview is several Paperclip reads, so faster than this would mostly
 * cancel the read still in flight.
 */
export const PAPERCLIP_REFRESH_MIN_SECONDS = 10;
/** `setInterval` overflows a 32-bit millisecond delay past ~24.8 days. */
export const PAPERCLIP_REFRESH_MAX_SECONDS = 7 * 86_400;

/**
 * The saved interval as the amount and unit the setting shows: the largest
 * unit that divides it evenly, so 7200 reads as 2 hours and 90 as 90 seconds.
 * Zero (off) keeps whichever unit the caller was already showing.
 */
export function splitPaperclipRefreshInterval(
  seconds: number,
  fallbackUnit: PaperclipRefreshUnit = "minutes",
): { readonly amount: number; readonly unit: PaperclipRefreshUnit } {
  if (seconds <= 0) return { amount: 0, unit: fallbackUnit };
  for (const unit of ["days", "hours", "minutes"] as const) {
    const size = PAPERCLIP_REFRESH_UNIT_SECONDS[unit];
    if (seconds % size === 0) return { amount: seconds / size, unit };
  }
  return { amount: seconds, unit: "seconds" };
}

/** What to save for an amount in a unit: 0 is off, anything else is clamped into range. */
export function paperclipRefreshSeconds(amount: number, unit: PaperclipRefreshUnit): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const seconds = Math.round(amount * PAPERCLIP_REFRESH_UNIT_SECONDS[unit]);
  return Math.min(PAPERCLIP_REFRESH_MAX_SECONDS, Math.max(PAPERCLIP_REFRESH_MIN_SECONDS, seconds));
}

/** `issue.updated` → `Issue updated`. */
export function formatPaperclipAction(action: string): string {
  return formatPaperclipStatus(action.replaceAll(".", " "));
}
