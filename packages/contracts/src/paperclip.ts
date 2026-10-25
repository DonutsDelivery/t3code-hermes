/**
 * Paperclip contract for the read-only right-panel surface. All traffic goes through the server so
 * the API key stays there; reads answer with a {@link PaperclipStatus}. Statuses, roles, and
 * actions stay plain strings because Paperclip adds them often.
 */
import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, IsoDateTime } from "./baseSchemas.ts";

/** Bumped whenever the shapes below change incompatibly. */
export const PAPERCLIP_CONTRACT_VERSION = 1 as const;

/**
 * Whether Paperclip can be talked to, and if not, why. Each has its own next
 * action in the UI: configure it, start it, replace the key, or upgrade.
 */
export const PaperclipAvailability = Schema.Literals([
  /** Reachable, authenticated, and understood. */
  "ready",
  /** Switched off, or no URL and key saved. */
  "notConfigured",
  /** Configured, but the URL refused the connection or timed out. */
  "offline",
  /** Paperclip rejected the key (401/403): revoked, expired, or wrong. */
  "unauthorized",
  /** Answering, but in a shape this build does not understand. */
  "incompatible",
  /** Any other failure, such as a company the key cannot see. */
  "requestFailed",
]);
export type PaperclipAvailability = typeof PaperclipAvailability.Type;

export const PaperclipStatus = Schema.Struct({
  contractVersion: Schema.Literal(PAPERCLIP_CONTRACT_VERSION),
  availability: PaperclipAvailability,
  /** Short, already-safe explanation. Never a URL or a key. */
  detail: Schema.NullOr(Schema.String),
});
export type PaperclipStatus = typeof PaperclipStatus.Type;

/** Who the key acts as, so Settings can say what it is allowed to do. */
export const PaperclipViewer = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  /** The key's company membership role, such as `viewer` or `owner`. */
  role: Schema.NullOr(Schema.String),
  isInstanceAdmin: Schema.Boolean,
  /** True only when Paperclip itself refuses this key's writes. */
  readOnly: Schema.Boolean,
});
export type PaperclipViewer = typeof PaperclipViewer.Type;

export const PaperclipCompany = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Prefix of issue identifiers (`SPA` in `SPA-1`), and of the company's web routes. */
  issuePrefix: Schema.String,
  status: Schema.String,
  budgetMonthlyCents: Schema.Number,
  spentMonthlyCents: Schema.Number,
});
export type PaperclipCompany = typeof PaperclipCompany.Type;

export const PaperclipAgent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  title: Schema.NullOr(Schema.String),
  role: Schema.String,
  status: Schema.String,
  adapterType: Schema.String,
  /** Manager's agent id; null at the top of the org chart. */
  reportsTo: Schema.NullOr(Schema.String),
  lastHeartbeatAt: Schema.NullOr(IsoDateTime),
  pauseReason: Schema.NullOr(Schema.String),
  budgetMonthlyCents: Schema.Number,
  spentMonthlyCents: Schema.Number,
  urlKey: Schema.NullOr(Schema.String),
});
export type PaperclipAgent = typeof PaperclipAgent.Type;

export const PaperclipProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  leadAgentId: Schema.NullOr(Schema.String),
  taskCount: Schema.NullOr(Schema.Number),
});
export type PaperclipProject = typeof PaperclipProject.Type;

export const PaperclipIssue = Schema.Struct({
  id: Schema.String,
  /** `SPA-1`. */
  identifier: Schema.String,
  title: Schema.String,
  status: Schema.String,
  priority: Schema.NullOr(Schema.String),
  assigneeAgentId: Schema.NullOr(Schema.String),
  assigneeUserId: Schema.NullOr(Schema.String),
  projectId: Schema.NullOr(Schema.String),
  parentId: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(IsoDateTime),
  /** An agent is working it right now. */
  hasActiveRun: Schema.Boolean,
});
export type PaperclipIssue = typeof PaperclipIssue.Type;

/** One heartbeat run: an agent waking up to do work. */
export const PaperclipRun = Schema.Struct({
  id: Schema.String,
  agentId: Schema.String,
  issueId: Schema.NullOr(Schema.String),
  status: Schema.String,
  invocationSource: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  /** Paperclip's own short error, when the run failed. */
  error: Schema.NullOr(Schema.String),
});
export type PaperclipRun = typeof PaperclipRun.Type;

export const PaperclipActivity = Schema.Struct({
  id: Schema.String,
  /** Dotted verb, such as `issue.updated` or `agent.paused`. */
  action: Schema.String,
  actorType: Schema.String,
  actorId: Schema.NullOr(Schema.String),
  entityType: Schema.String,
  entityId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type PaperclipActivity = typeof PaperclipActivity.Type;

/** Paperclip's own headline counts for the company. */
export const PaperclipDashboard = Schema.Struct({
  agents: Schema.Struct({
    active: Schema.Number,
    running: Schema.Number,
    paused: Schema.Number,
    error: Schema.Number,
  }),
  tasks: Schema.Struct({
    open: Schema.Number,
    inProgress: Schema.Number,
    blocked: Schema.Number,
    done: Schema.Number,
  }),
  monthSpendCents: Schema.Number,
  monthBudgetCents: Schema.Number,
  pendingApprovals: Schema.Number,
});
export type PaperclipDashboard = typeof PaperclipDashboard.Type;

/** No fields. Re-asking is the retry; nothing is cached across reads. */
export const PaperclipOverviewInput = Schema.Struct({});
export type PaperclipOverviewInput = typeof PaperclipOverviewInput.Type;

/**
 * The whole company in one answer.
 * One round trip rather than a call per list: the panel renders all of it at once, and the server
 * fans out to Paperclip in parallel. Lists are trimmed to what a side panel shows, so the payload
 * stays small however big the company grows.
 */
export const PaperclipOverviewResult = Schema.Struct({
  status: PaperclipStatus,
  viewer: Schema.NullOr(PaperclipViewer),
  company: Schema.NullOr(PaperclipCompany),
  /** Null when the company's dashboard could not be read; the rest may still be. */
  dashboard: Schema.NullOr(PaperclipDashboard),
  agents: ForwardCompatibleArray(PaperclipAgent),
  projects: ForwardCompatibleArray(PaperclipProject),
  /** Open work first, then the most recently updated. */
  issues: ForwardCompatibleArray(PaperclipIssue),
  /** True when the company has more issues than were sent. */
  issuesTruncated: Schema.Boolean,
  /** Newest first. */
  runs: ForwardCompatibleArray(PaperclipRun),
  /** Newest first. */
  activity: ForwardCompatibleArray(PaperclipActivity),
  /**
   * Paperclip's web app for this company, for "open in Paperclip" links. Null
   * when the configured URL cannot be turned into one. Credentials removed.
   */
  webUrl: Schema.NullOr(Schema.String),
});
export type PaperclipOverviewResult = typeof PaperclipOverviewResult.Type;
