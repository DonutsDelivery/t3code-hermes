/**
 * Hindsight ("Memory") contract: one bank at a time, all traffic server-side so the API key stays
 * there. Read-mostly: the only writes are retain one note and reflect now. Reads never fail; they
 * answer with a {@link HindsightStatus}.
 */
import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Bumped whenever the shapes below change incompatibly, so a client talking to an older environment
 * renders an "update T3 Code" notice rather than a half-decoded panel.
 * 2 — added `requestFailed` to {@link HindsightAvailability}, so a read that fails (unknown bank,
 * HTTP error) is reported as a failure instead of an empty result.
 */
export const HINDSIGHT_CONTRACT_VERSION = 2 as const;

/**
 * Hindsight HTTP API version this contract was transcribed from.
 *
 * Reported next to the environment's own reading of `GET /version` so a drift
 * is visible in the panel instead of showing up as mysteriously empty results.
 */
export const HINDSIGHT_TARGET_API_VERSION = "0.9.1" as const;

/** Largest page a single browse or recall will return. */
export const HINDSIGHT_MAX_PAGE_SIZE = 50;

/** Page size used when a client does not ask for one. */
export const HINDSIGHT_DEFAULT_PAGE_SIZE = 25;

/** Longest note the panel will retain in one go. */
export const HINDSIGHT_MAX_NOTE_LENGTH = 4_000;

export const HindsightBankId = TrimmedNonEmptyString.pipe(Schema.brand("HindsightBankId"));
export type HindsightBankId = typeof HindsightBankId.Type;

/**
 * Where a memory sits in Hindsight's taxonomy: the first three are `fact_type` values;
 * `mentalModel` is a separate resource listed alongside them.
 */
export const HindsightPathway = Schema.Literals([
  "world",
  "experience",
  "observation",
  "mentalModel",
]);
export type HindsightPathway = typeof HindsightPathway.Type;

/**
 * Which pathways a request wants back.
 *
 * `all` is genuinely all of them, including mental models — the panel's chips
 * would be lying otherwise.
 */
export const HindsightPathwayFilter = Schema.Literals([
  "all",
  "world",
  "experience",
  "mentalModel",
]);
export type HindsightPathwayFilter = typeof HindsightPathwayFilter.Type;

/** One memory, flattened to what a list row can render. */
export const HindsightMemory = Schema.Struct({
  id: TrimmedNonEmptyString,
  pathway: HindsightPathway,
  /** The memory itself. Mental models carry their generated markdown here. */
  text: Schema.String,
  /** Hindsight's own note about where the memory came from, when it kept one. */
  context: Schema.NullOr(Schema.String),
  /** Mental models have a name; facts do not. */
  title: Schema.NullOr(Schema.String),
  /**
   * When the memory was learned — `mentioned_at` for facts, `last_refreshed_at`
   * for mental models. Null when Hindsight recorded neither.
   */
  rememberedAt: Schema.NullOr(IsoDateTime),
  /**
   * Hindsight's final ranking score for this result, 0–1 and only meaningful
   * against the query that produced it. Null for browse, which does not rank.
   */
  confidence: Schema.NullOr(Schema.Number),
  entities: ForwardCompatibleArray(Schema.String),
  tags: ForwardCompatibleArray(Schema.String),
});
export type HindsightMemory = typeof HindsightMemory.Type;

/** One bank, as the bank picker needs it. */
export const HindsightBank = Schema.Struct({
  id: HindsightBankId,
  /** Hindsight leaves this unset for banks created implicitly by a write. */
  name: Schema.NullOr(Schema.String),
  factCount: Schema.Number,
});
export type HindsightBank = typeof HindsightBank.Type;

/**
 * Whether Hindsight can be talked to at all, and if not, why.
 *
 * These stay distinct all the way to the UI because each one has a different
 * next action: configure it, start it, or upgrade it.
 */
export const HindsightAvailability = Schema.Literals([
  /** Reachable and understood. Results may still legitimately be empty. */
  "ready",
  /** Switched off, or neither T3 Code settings nor Hermes name a Hindsight URL. */
  "notConfigured",
  /** Configured, but the base URL refused the connection or timed out. */
  "offline",
  /** Answering, but `GET /version` did not decode — likely a newer major. */
  "incompatible",
  /**
   * The read itself failed — the bank does not exist, or Hindsight answered
   * with an HTTP error. Distinct from `ready` so a panel renders a failure
   * instead of a convincingly empty list.
   */
  "requestFailed",
]);
export type HindsightAvailability = typeof HindsightAvailability.Type;

/**
 * Rides on every response so the panel always knows what it is looking at.
 *
 * Deliberately carries no URL: a base URL can embed credentials, and the panel
 * has nothing useful to do with a loopback address it cannot reach anyway.
 */
export const HindsightStatus = Schema.Struct({
  contractVersion: Schema.Literal(HINDSIGHT_CONTRACT_VERSION),
  availability: HindsightAvailability,
  /**
   * Short, already-safe explanation for a non-`ready` availability. Never a
   * stack trace, a URL, or an API key.
   */
  detail: Schema.NullOr(Schema.String),
  /** `api_version` as Hindsight reported it, once it has answered once. */
  apiVersion: Schema.NullOr(Schema.String),
  /** The version this build was written against, for a side-by-side in the UI. */
  targetApiVersion: Schema.Literal(HINDSIGHT_TARGET_API_VERSION),
});
export type HindsightStatus = typeof HindsightStatus.Type;

/**
 * Where the URL an environment talks to came from: its own
 * `integrations.hindsight` settings, or the Hermes install's Hindsight config.
 */
export const HindsightConnectionSource = Schema.Literals(["settings", "hermes"]);
export type HindsightConnectionSource = typeof HindsightConnectionSource.Type;

/** The connection an environment resolved, so Settings can say what is in use. */
export const HindsightConnectionInfo = Schema.Struct({
  source: HindsightConnectionSource,
  /** With any `user:pass@` removed. The key itself never leaves the server. */
  baseUrl: Schema.String,
  hasApiKey: Schema.Boolean,
});
export type HindsightConnectionInfo = typeof HindsightConnectionInfo.Type;

/** What the Hermes install says about Hindsight, whether or not it is in use. */
export const HindsightHermesConfig = Schema.Struct({
  /** The file it was read from, or null when it came from `HINDSIGHT_*` variables. */
  configPath: Schema.NullOr(Schema.String),
  baseUrl: Schema.String,
  bank: Schema.NullOr(Schema.String),
  hasApiKey: Schema.Boolean,
});
export type HindsightHermesConfig = typeof HindsightHermesConfig.Type;

/** Bootstrap for the panel: is Hindsight there, and which banks does it hold? */
export const HindsightBanksResult = Schema.Struct({
  status: HindsightStatus,
  banks: ForwardCompatibleArray(HindsightBank),
  /**
   * The configured default bank, when set and still present. The panel
   * preselects it rather than guessing at the first alphabetically.
   */
  defaultBank: Schema.NullOr(HindsightBankId),
  /**
   * The connection in use, or null when the integration is off or nothing is
   * configured. Optional so a client tolerates an environment that predates it.
   */
  connection: Schema.optionalKey(Schema.NullOr(HindsightConnectionInfo)),
  /** Hermes' own Hindsight config, or null when Hermes has none. */
  hermes: Schema.optionalKey(Schema.NullOr(HindsightHermesConfig)),
});
export type HindsightBanksResult = typeof HindsightBanksResult.Type;

/** What both browse and recall answer with. */
export const HindsightMemoryResult = Schema.Struct({
  status: HindsightStatus,
  memories: ForwardCompatibleArray(HindsightMemory),
  /**
   * True when Hindsight had more rows than the page size. The panel says so
   * rather than implying the bank is this small.
   */
  hasMore: Schema.Boolean,
});
export type HindsightMemoryResult = typeof HindsightMemoryResult.Type;

/** How many memories of one pathway a bank holds. */
export const HindsightPathwayCount = Schema.Struct({
  pathway: HindsightPathway,
  count: Schema.Number,
});
export type HindsightPathwayCount = typeof HindsightPathwayCount.Type;

/**
 * A bank's size for the stats strip: store size, shape, and the two trouble numbers (queued and
 * failed work).
 */
export const HindsightBankStats = Schema.Struct({
  /** Memories in the bank, across every pathway. */
  nodes: Schema.Number,
  /** Relationships Hindsight has drawn between them. */
  links: Schema.Number,
  /** Source documents the memories were extracted from. */
  documents: Schema.Number,
  /**
   * `nodes` split by pathway, in Hindsight's own order, dropping pathways this
   * build does not know. Empty when Hindsight reported no split.
   */
  nodesByPathway: ForwardCompatibleArray(HindsightPathwayCount),
  /**
   * Background work in flight and work that gave up. Both are usually zero;
   * the panel only mentions them when they are not, because a permanent
   * "0 failed" is noise on a strip read at a glance.
   */
  pendingOperations: Schema.Number,
  failedOperations: Schema.Number,
  /** When consolidation last ran. Null on a bank it has never run against. */
  lastConsolidatedAt: Schema.NullOr(IsoDateTime),
});
export type HindsightBankStats = typeof HindsightBankStats.Type;

/** Counts for one bank. Cheap enough to re-read whenever the bank changes. */
export const HindsightStatsInput = Schema.Struct({
  bank: HindsightBankId,
});
export type HindsightStatsInput = typeof HindsightStatsInput.Type;

/**
 * Counts, or the reason there are none.
 *
 * `stats` is null rather than zeroed whenever Hindsight could not answer: a
 * strip reading "0 nodes" over a list of memories is a lie, and the panel would
 * rather show nothing than a confident wrong number.
 */
export const HindsightStatsResult = Schema.Struct({
  status: HindsightStatus,
  stats: Schema.NullOr(HindsightBankStats),
});
export type HindsightStatsResult = typeof HindsightStatsResult.Type;

/**
 * No fields. Retrying is not a flag: the environment throws away an `offline`
 * verdict on the next read anyway, so re-asking is the retry.
 */
export const HindsightListBanksInput = Schema.Struct({});
export type HindsightListBanksInput = typeof HindsightListBanksInput.Type;

/** Recent memories, newest first. The default view, with no query typed. */
export const HindsightBrowseInput = Schema.Struct({
  bank: HindsightBankId,
  pathway: HindsightPathwayFilter,
  /** Clamped to {@link HINDSIGHT_MAX_PAGE_SIZE} by the environment. */
  limit: Schema.optionalKey(Schema.Number),
});
export type HindsightBrowseInput = typeof HindsightBrowseInput.Type;

/** Semantic search over a bank. */
export const HindsightRecallInput = Schema.Struct({
  bank: HindsightBankId,
  pathway: HindsightPathwayFilter,
  query: TrimmedNonEmptyString,
  limit: Schema.optionalKey(Schema.Number),
});
export type HindsightRecallInput = typeof HindsightRecallInput.Type;

/**
 * Write one note into a bank.
 *
 * Synchronous on purpose: Hindsight can extract facts in the background, but
 * then the panel would have to invent a "probably saved" state and poll for
 * it. Waiting means the confirmation the user sees is the truth.
 */
export const HindsightRetainInput = Schema.Struct({
  bank: HindsightBankId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(HINDSIGHT_MAX_NOTE_LENGTH)),
});
export type HindsightRetainInput = typeof HindsightRetainInput.Type;

/** How many facts Hindsight said it took in. */
export const HindsightRetainResult = Schema.Struct({
  status: HindsightStatus,
  itemsCount: Schema.Number,
});
export type HindsightRetainResult = typeof HindsightRetainResult.Type;

/** Ask Hindsight to reason over the bank now and answer in prose. */
export const HindsightReflectInput = Schema.Struct({
  bank: HindsightBankId,
  query: TrimmedNonEmptyString,
});
export type HindsightReflectInput = typeof HindsightReflectInput.Type;

export const HindsightReflectResult = Schema.Struct({
  status: HindsightStatus,
  /** Markdown, as Hindsight formats it. */
  text: Schema.String,
});
export type HindsightReflectResult = typeof HindsightReflectResult.Type;

/**
 * Write failures only. Reads answer with a {@link HindsightStatus} instead; a write owes the user
 * an answer, so it fails with the same vocabulary.
 */
export class HindsightError extends Schema.TaggedError<HindsightError>()("HindsightError", {
  reason: Schema.Literals([
    "notConfigured",
    "offline",
    "incompatible",
    "unknownBank",
    "requestFailed",
  ]),
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Hindsight request failed (${this.reason}): ${this.detail}`;
  }
}

/**
 * A coding agent the environment can wire into Hindsight on its own host.
 *
 * Claude Code and Codex are wired by Hindsight's own installer; Hermes has a
 * native Hindsight memory provider that only needs switching on.
 */
export const HindsightAgentTarget = Schema.Literals(["claudeCode", "codex", "hermes"]);
export type HindsightAgentTarget = typeof HindsightAgentTarget.Type;

/** One agent's wiring, as read back from its own config on the host. */
export const HindsightAgentStatus = Schema.Struct({
  target: HindsightAgentTarget,
  state: Schema.Literals(["installed", "notInstalled", "failed"]),
  /** Short, already-safe note: why it failed, or what is not covered. */
  detail: Schema.NullOr(Schema.String),
});
export type HindsightAgentStatus = typeof HindsightAgentStatus.Type;

/**
 * Why agent memory cannot be applied at all on this environment.
 *
 * `notConfigured` — no Hindsight connection resolves (see Integrations → Memory).
 * `nodeMissing` — the installer and the hooks it writes need Node.js on PATH.
 */
export const HindsightAgentMemoryBlocker = Schema.Literals(["notConfigured", "nodeMissing"]);
export type HindsightAgentMemoryBlocker = typeof HindsightAgentMemoryBlocker.Type;

/**
 * Where the environment's agents stand against `integrations.hindsight.agentMemory`.
 *
 * Streamed, because applying it runs an installer that takes seconds, and a
 * switch that flips before the work lands would be lying.
 */
export const HindsightAgentMemoryState = Schema.Struct({
  /** An install or uninstall is running right now. */
  applying: Schema.Boolean,
  blocker: Schema.NullOr(HindsightAgentMemoryBlocker),
  /** One entry per agent configured on this environment. */
  agents: ForwardCompatibleArray(HindsightAgentStatus),
  /** Short, already-safe note about the last pass when it failed as a whole. */
  detail: Schema.NullOr(Schema.String),
});
export type HindsightAgentMemoryState = typeof HindsightAgentMemoryState.Type;

export const HindsightAgentMemoryInput = Schema.Struct({});
export type HindsightAgentMemoryInput = typeof HindsightAgentMemoryInput.Type;

/**
 * One spelling per Hindsight endpoint, so a server is recognised however its
 * URL was typed: credentials and a trailing slash go, the host is lower-cased,
 * and the path and query stay.
 */
export function canonicalHindsightUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}
