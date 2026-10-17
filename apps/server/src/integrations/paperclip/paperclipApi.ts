/**
 * Wire shapes of the Paperclip HTTP API, and the mapping onto T3 Code's own.
 *
 * Transcribed from Paperclip's server routes (`server/src/routes/*.ts`) and
 * checked against a live instance. Only the fields the panel renders are
 * declared; Paperclip returns far more (adapter config, execution state,
 * budgets per window) and none of it should cross the wire to a client.
 *
 * Decoding is deliberately forgiving inside a list and strict at its root: a
 * single agent with an unexpected field shape is dropped rather than failing
 * the whole roster, but a list that is not a list means Paperclip changed and
 * is reported as `incompatible`.
 *
 * @module paperclipApi
 */
import type {
  PaperclipActivity,
  PaperclipAgent,
  PaperclipCompany,
  PaperclipDashboard,
  PaperclipIssue,
  PaperclipProject,
  PaperclipRun,
  PaperclipViewer,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));
const OptionalNumber = Schema.optional(Schema.NullOr(Schema.Number));

/** `GET /api/cli-auth/me`: who a board key acts as. */
export const PaperclipMeResponse = Schema.Struct({
  user: Schema.optional(Schema.NullOr(Schema.Struct({ name: OptionalString }))),
  isInstanceAdmin: Schema.optional(Schema.Boolean),
  companyIds: Schema.Array(Schema.String),
  memberships: Schema.optional(
    Schema.Array(
      Schema.Struct({
        companyId: Schema.String,
        membershipRole: OptionalString,
        status: OptionalString,
      }),
    ),
  ),
});
export type PaperclipMeResponse = typeof PaperclipMeResponse.Type;

/** `GET /api/companies/:id`. */
export const PaperclipCompanyResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  issuePrefix: Schema.String,
  status: OptionalString,
  budgetMonthlyCents: OptionalNumber,
  spentMonthlyCents: OptionalNumber,
});

const PaperclipAgentRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  title: OptionalString,
  role: OptionalString,
  status: OptionalString,
  adapterType: OptionalString,
  reportsTo: OptionalString,
  lastHeartbeatAt: OptionalString,
  pauseReason: OptionalString,
  budgetMonthlyCents: OptionalNumber,
  spentMonthlyCents: OptionalNumber,
  urlKey: OptionalString,
});

const PaperclipProjectRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: OptionalString,
  leadAgentId: OptionalString,
  taskCount: OptionalNumber,
});

const PaperclipIssueRow = Schema.Struct({
  id: Schema.String,
  identifier: OptionalString,
  title: Schema.String,
  status: OptionalString,
  priority: OptionalString,
  assigneeAgentId: OptionalString,
  assigneeUserId: OptionalString,
  projectId: OptionalString,
  parentId: OptionalString,
  updatedAt: OptionalString,
  lastActivityAt: OptionalString,
  /** An object while a run holds the issue; its shape is not this panel's business. */
  activeRun: Schema.optional(Schema.Unknown),
});

const PaperclipRunRow = Schema.Struct({
  id: Schema.String,
  agentId: Schema.String,
  issueId: OptionalString,
  status: OptionalString,
  invocationSource: OptionalString,
  startedAt: OptionalString,
  finishedAt: OptionalString,
  error: OptionalString,
});

const PaperclipActivityRow = Schema.Struct({
  id: Schema.String,
  action: Schema.String,
  actorType: OptionalString,
  actorId: OptionalString,
  entityType: OptionalString,
  entityId: OptionalString,
  createdAt: Schema.String,
});

const Count = Schema.optional(Schema.Number);

/** `GET /api/companies/:id/dashboard`. */
export const PaperclipDashboardResponse = Schema.Struct({
  agents: Schema.Struct({ active: Count, running: Count, paused: Count, error: Count }),
  tasks: Schema.Struct({ open: Count, inProgress: Count, blocked: Count, done: Count }),
  costs: Schema.optional(Schema.Struct({ monthSpendCents: Count, monthBudgetCents: Count })),
  pendingApprovals: Count,
});

/** A list endpoint: a JSON array of rows that are decoded one by one. */
export const PaperclipList = Schema.Array(Schema.Unknown);

const decodeRow =
  <A, I>(schema: Schema.Codec<A, I, never, never>) =>
  (rows: ReadonlyArray<unknown>): ReadonlyArray<A> =>
    rows.flatMap((row) => Option.toArray(Schema.decodeUnknownOption(schema)(row)));

export const decodeAgents = decodeRow(PaperclipAgentRow);
export const decodeProjects = decodeRow(PaperclipProjectRow);
export const decodeIssues = decodeRow(PaperclipIssueRow);
export const decodeRuns = decodeRow(PaperclipRunRow);
export const decodeActivity = decodeRow(PaperclipActivityRow);

// ── Paths ────────────────────────────────────────────────────────────

/**
 * The API root for a configured URL.
 *
 * People paste either the web app's address or the API's, with or without a
 * trailing slash; all of them mean the same server.
 */
export function paperclipApiRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

/** The web app's root for a configured URL, without credentials. Null when unparsable. */
export function paperclipWebRoot(baseUrl: string): string | null {
  try {
    const url = new URL(paperclipApiRoot(baseUrl));
    url.username = "";
    url.password = "";
    url.pathname = url.pathname.replace(/\/api$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

const company = (id: string) => `/companies/${encodeURIComponent(id)}`;

/** Activity and runs are capped by the side panel, not by what Paperclip would send. */
const PAPERCLIP_ACTIVITY_LIMIT = 30;
const PAPERCLIP_RUN_LIMIT = 20;
/** Paperclip's own issue list default is 500; a side panel never needs that many. */
export const PAPERCLIP_ISSUE_LIMIT = 50;

export const paperclipPaths = {
  me: () => "/cli-auth/me",
  company: (id: string) => company(id),
  dashboard: (id: string) => `${company(id)}/dashboard`,
  agents: (id: string) => `${company(id)}/agents`,
  projects: (id: string) => `${company(id)}/projects`,
  // One more than shown, so "there are more" is known without a count query.
  issues: (id: string) => `${company(id)}/issues?limit=${PAPERCLIP_ISSUE_LIMIT + 1}`,
  runs: (id: string) => `${company(id)}/heartbeat-runs?summary=true&limit=${PAPERCLIP_RUN_LIMIT}`,
  activity: (id: string) => `${company(id)}/activity?limit=${PAPERCLIP_ACTIVITY_LIMIT}`,
} as const;

// ── Mapping ──────────────────────────────────────────────────────────

/** Roles Paperclip lets act on a company. `viewer` is the one it keeps read-only. */
const READ_ONLY_ROLES = new Set(["viewer"]);

export function viewerFromMe(me: PaperclipMeResponse, companyId: string): PaperclipViewer {
  const membership = me.memberships?.find(
    (candidate) => candidate.companyId === companyId && candidate.status !== "archived",
  );
  const role = membership?.membershipRole ?? null;
  const isInstanceAdmin = me.isInstanceAdmin === true;
  return {
    name: me.user?.name ?? null,
    role,
    isInstanceAdmin,
    readOnly: !isInstanceAdmin && role !== null && READ_ONLY_ROLES.has(role),
  };
}

export function companyFromResponse(
  response: typeof PaperclipCompanyResponse.Type,
): PaperclipCompany {
  return {
    id: response.id,
    name: response.name,
    issuePrefix: response.issuePrefix,
    status: response.status ?? "active",
    budgetMonthlyCents: response.budgetMonthlyCents ?? 0,
    spentMonthlyCents: response.spentMonthlyCents ?? 0,
  };
}

export function dashboardFromResponse(
  response: typeof PaperclipDashboardResponse.Type,
): PaperclipDashboard {
  return {
    agents: {
      active: response.agents.active ?? 0,
      running: response.agents.running ?? 0,
      paused: response.agents.paused ?? 0,
      error: response.agents.error ?? 0,
    },
    tasks: {
      open: response.tasks.open ?? 0,
      inProgress: response.tasks.inProgress ?? 0,
      blocked: response.tasks.blocked ?? 0,
      done: response.tasks.done ?? 0,
    },
    monthSpendCents: response.costs?.monthSpendCents ?? 0,
    monthBudgetCents: response.costs?.monthBudgetCents ?? 0,
    pendingApprovals: response.pendingApprovals ?? 0,
  };
}

export function agentFromRow(row: typeof PaperclipAgentRow.Type): PaperclipAgent {
  return {
    id: row.id,
    name: row.name,
    title: row.title ?? null,
    role: row.role ?? "general",
    status: row.status ?? "unknown",
    adapterType: row.adapterType ?? "unknown",
    reportsTo: row.reportsTo ?? null,
    lastHeartbeatAt: row.lastHeartbeatAt ?? null,
    pauseReason: row.pauseReason ?? null,
    budgetMonthlyCents: row.budgetMonthlyCents ?? 0,
    spentMonthlyCents: row.spentMonthlyCents ?? 0,
    urlKey: row.urlKey ?? null,
  };
}

export function projectFromRow(row: typeof PaperclipProjectRow.Type): PaperclipProject {
  return {
    id: row.id,
    name: row.name,
    status: row.status ?? "unknown",
    leadAgentId: row.leadAgentId ?? null,
    taskCount: row.taskCount ?? null,
  };
}

export function issueFromRow(row: typeof PaperclipIssueRow.Type): PaperclipIssue {
  return {
    id: row.id,
    identifier: row.identifier ?? row.id.slice(0, 8),
    title: row.title,
    status: row.status ?? "unknown",
    priority: row.priority ?? null,
    assigneeAgentId: row.assigneeAgentId ?? null,
    assigneeUserId: row.assigneeUserId ?? null,
    projectId: row.projectId ?? null,
    parentId: row.parentId ?? null,
    updatedAt: row.lastActivityAt ?? row.updatedAt ?? null,
    hasActiveRun: row.activeRun !== undefined && row.activeRun !== null,
  };
}

export function runFromRow(row: typeof PaperclipRunRow.Type): PaperclipRun {
  return {
    id: row.id,
    agentId: row.agentId,
    issueId: row.issueId ?? null,
    status: row.status ?? "unknown",
    invocationSource: row.invocationSource ?? null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    // Paperclip's run errors can be whole stderr tails; a row needs a line.
    error: row.error == null ? null : row.error.split("\n", 1)[0]!.slice(0, 200),
  };
}

export function activityFromRow(row: typeof PaperclipActivityRow.Type): PaperclipActivity {
  return {
    id: row.id,
    action: row.action,
    actorType: row.actorType ?? "system",
    actorId: row.actorId ?? null,
    entityType: row.entityType ?? "unknown",
    entityId: row.entityId ?? null,
    createdAt: row.createdAt,
  };
}

/** Statuses that mean nobody needs to look at the issue any more. */
const CLOSED_ISSUE_STATUSES = new Set(["done", "cancelled"]);

/** How urgently a status wants attention; lower sorts first. */
function issueStatusRank(status: string): number {
  switch (status) {
    case "blocked":
      return 0;
    case "in_progress":
      return 1;
    case "in_review":
      return 2;
    case "todo":
      return 3;
    case "backlog":
      return 4;
    default:
      return CLOSED_ISSUE_STATUSES.has(status) ? 6 : 5;
  }
}

/**
 * Open work first, most urgent status first, then most recently touched.
 *
 * A side panel is read at a glance: a blocked issue from last week matters
 * more than one closed five minutes ago.
 */
export function sortIssues(issues: ReadonlyArray<PaperclipIssue>): ReadonlyArray<PaperclipIssue> {
  return [...issues].sort((left, right) => {
    const rank = issueStatusRank(left.status) - issueStatusRank(right.status);
    if (rank !== 0) return rank;
    return timestamp(right.updatedAt) - timestamp(left.updatedAt);
  });
}

function timestamp(value: string | null): number {
  if (value === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
