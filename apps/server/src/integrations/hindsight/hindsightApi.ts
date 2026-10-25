/**
 * Hindsight HTTP API shapes from OpenAPI `205e47b4` (0.9.1), decoded by schema so upgrades fail
 * tests. `recall` and `list` name pathway and entities differently, so each has a decoder; mental
 * models have no search, so {@link filterMentalModels} matches substrings locally.
 */
import {
  type HindsightBank,
  HindsightBankId,
  type HindsightBankStats,
  type HindsightMemory,
  type HindsightPathway,
  type HindsightPathwayCount,
  type HindsightPathwayFilter,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Fact types Hindsight stamps onto a memory unit. */
const HINDSIGHT_FACT_TYPES = ["world", "experience", "observation"] as const;
type HindsightFactType = (typeof HINDSIGHT_FACT_TYPES)[number];

/**
 * `GET /version`.
 *
 * The compatibility probe. `features` is deliberately left loose — Hindsight
 * adds flags constantly and none of them change what this panel renders, so
 * requiring the exact set would turn every minor release into an incident.
 */
export const HindsightVersionResponse = Schema.Struct({
  api_version: Schema.String,
});
export type HindsightVersionResponse = typeof HindsightVersionResponse.Type;

/** `GET /v1/default/banks`. */
export const HindsightBankListItem = Schema.Struct({
  bank_id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  fact_count: Schema.optional(Schema.NullOr(Schema.Number)),
});

export const HindsightBankListResponse = Schema.Struct({
  banks: Schema.Array(HindsightBankListItem),
});
export type HindsightBankListResponse = typeof HindsightBankListResponse.Type;

/**
 * One row of `GET /v1/default/banks/{bank_id}/memories/list`.
 *
 * Hindsight types this endpoint's `items` as a bare object array, so the shape
 * comes from its `list_memory_units` query rather than from the spec.
 */
export const HindsightMemoryUnit = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  fact_type: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.NullOr(Schema.String)),
  mentioned_at: Schema.optional(Schema.NullOr(Schema.String)),
  /** Comma-joined canonical entity names, or `""`. Not an array here. */
  entities: Schema.optional(Schema.NullOr(Schema.String)),
  tags: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});

export const HindsightListMemoriesResponse = Schema.Struct({
  items: Schema.Array(HindsightMemoryUnit),
  total: Schema.Number,
});
export type HindsightListMemoriesResponse = typeof HindsightListMemoriesResponse.Type;

/** `POST /v1/default/banks/{bank_id}/memories/recall`. */
export const HindsightRecallResult = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  type: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.NullOr(Schema.String)),
  mentioned_at: Schema.optional(Schema.NullOr(Schema.String)),
  entities: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  tags: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  scores: Schema.optional(Schema.NullOr(Schema.Struct({ final: Schema.Number }))),
});

export const HindsightRecallResponse = Schema.Struct({
  results: Schema.Array(HindsightRecallResult),
});
export type HindsightRecallResponse = typeof HindsightRecallResponse.Type;

/** `GET /v1/default/banks/{bank_id}/mental-models`. */
export const HindsightMentalModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  content: Schema.optional(Schema.NullOr(Schema.String)),
  source_query: Schema.optional(Schema.NullOr(Schema.String)),
  tags: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  last_refreshed_at: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
});

export const HindsightMentalModelListResponse = Schema.Struct({
  items: Schema.Array(HindsightMentalModel),
});
export type HindsightMentalModelListResponse = typeof HindsightMentalModelListResponse.Type;

/**
 * `GET /v1/default/banks/{bank_id}/stats`, rendered fields only. Optional fields decode loosely, so
 * a never-consolidated bank isn't a decode failure.
 */
export const HindsightBankStatsResponse = Schema.Struct({
  bank_id: Schema.String,
  total_nodes: Schema.Number,
  total_links: Schema.Number,
  total_documents: Schema.Number,
  nodes_by_fact_type: Schema.Record(Schema.String, Schema.Number),
  pending_operations: Schema.Number,
  failed_operations: Schema.Number,
  last_consolidated_at: Schema.optional(Schema.NullOr(Schema.String)),
});
export type HindsightBankStatsResponse = typeof HindsightBankStatsResponse.Type;

/** `POST /v1/default/banks/{bank_id}/memories`. */
export const HindsightRetainResponse = Schema.Struct({
  success: Schema.Boolean,
  items_count: Schema.Number,
});
export type HindsightRetainResponse = typeof HindsightRetainResponse.Type;

/** `POST /v1/default/banks/{bank_id}/reflect`. */
export const HindsightReflectResponse = Schema.Struct({
  text: Schema.String,
});
export type HindsightReflectResponse = typeof HindsightReflectResponse.Type;

// ── Path building ────────────────────────────────────────────────────

/**
 * Hindsight namespaces every bank-scoped route under a fixed `default` tenant
 * in the single-tenant deployment this integration targets.
 */
const API_ROOT = "/v1/default";

/**
 * Joins a configured base URL with an API path.
 *
 * Trailing slashes on the configured base are common enough (a copy-paste from
 * a browser address bar) that stripping them here is cheaper than a settings
 * validation error nobody reads.
 */
export function hindsightUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export const hindsightPaths = {
  version: () => "/version",
  banks: () => `${API_ROOT}/banks`,
  listMemories: (bank: string) => `${API_ROOT}/banks/${encodeURIComponent(bank)}/memories/list`,
  recall: (bank: string) => `${API_ROOT}/banks/${encodeURIComponent(bank)}/memories/recall`,
  retain: (bank: string) => `${API_ROOT}/banks/${encodeURIComponent(bank)}/memories`,
  reflect: (bank: string) => `${API_ROOT}/banks/${encodeURIComponent(bank)}/reflect`,
  mentalModels: (bank: string) => `${API_ROOT}/banks/${encodeURIComponent(bank)}/mental-models`,
  stats: (bank: string) => `${API_ROOT}/banks/${encodeURIComponent(bank)}/stats`,
} as const;

// ── Filter translation ───────────────────────────────────────────────

/**
 * Fact types a filter wants from the memory endpoints.
 *
 * Empty means the filter is asking only for mental models, which those
 * endpoints know nothing about — the caller skips them entirely rather than
 * issuing a request whose answer it would throw away.
 */
export function factTypesFor(filter: HindsightPathwayFilter): ReadonlyArray<HindsightFactType> {
  switch (filter) {
    case "all":
      return HINDSIGHT_FACT_TYPES;
    case "world":
      return ["world"];
    case "experience":
      return ["experience"];
    case "mentalModel":
      return [];
  }
}

/** Whether a filter includes Hindsight's separately-stored mental models. */
export function includesMentalModels(filter: HindsightPathwayFilter): boolean {
  return filter === "all" || filter === "mentalModel";
}

// ── Row mapping ──────────────────────────────────────────────────────

/**
 * Hindsight's fact type to a contract pathway.
 *
 * An unrecognised value maps to `world` rather than being dropped: a memory
 * shown under a slightly wrong chip is still a memory the user can read, and
 * hiding rows because a future Hindsight added a fourth type would be worse.
 */
function pathwayFromFactType(factType: string | null | undefined): HindsightPathway {
  switch (factType) {
    case "experience":
      return "experience";
    case "observation":
      return "observation";
    default:
      return "world";
  }
}

/** Splits the comma-joined `entities` string the list endpoint returns. */
function splitEntities(value: string | null | undefined): ReadonlyArray<string> {
  if (!value) return [];
  return value
    .split(",")
    .map((entity) => entity.trim())
    .filter((entity) => entity.length > 0);
}

export function memoryFromUnit(unit: typeof HindsightMemoryUnit.Type): HindsightMemory {
  return {
    id: unit.id,
    pathway: pathwayFromFactType(unit.fact_type),
    text: unit.text,
    context: unit.context ?? null,
    title: null,
    rememberedAt: unit.mentioned_at ?? null,
    // Listing is chronological, not ranked, so there is no score to show.
    confidence: null,
    entities: splitEntities(unit.entities),
    tags: unit.tags ?? [],
  };
}

export function memoryFromRecallResult(result: typeof HindsightRecallResult.Type): HindsightMemory {
  return {
    id: result.id,
    pathway: pathwayFromFactType(result.type),
    text: result.text,
    context: result.context ?? null,
    title: null,
    rememberedAt: result.mentioned_at ?? null,
    confidence: result.scores?.final ?? null,
    entities: result.entities ?? [],
    tags: result.tags ?? [],
  };
}

export function memoryFromMentalModel(model: typeof HindsightMentalModel.Type): HindsightMemory {
  return {
    id: model.id,
    pathway: "mentalModel",
    // A mental model with no content yet has never been refreshed; showing the
    // query it was built from beats showing an empty row.
    text: model.content ?? model.source_query ?? "",
    context:
      model.content === null || model.content === undefined ? null : (model.source_query ?? null),
    title: model.name,
    rememberedAt: model.last_refreshed_at ?? model.created_at ?? null,
    confidence: null,
    entities: [],
    tags: model.tags ?? [],
  };
}

/**
 * Substring match standing in for semantic search over mental models.
 *
 * Hindsight exposes no ranked query for them, so a typed query narrows the
 * list by name and content rather than pretending to rank it. Called only when
 * the user typed something; browsing returns the list untouched.
 */
export function filterMentalModels(
  models: ReadonlyArray<typeof HindsightMentalModel.Type>,
  query: string,
): ReadonlyArray<typeof HindsightMentalModel.Type> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return models;
  return models.filter(
    (model) =>
      model.name.toLowerCase().includes(needle) ||
      (model.content ?? "").toLowerCase().includes(needle) ||
      (model.source_query ?? "").toLowerCase().includes(needle),
  );
}

export function bankFromListItem(item: typeof HindsightBankListItem.Type): HindsightBank {
  return {
    id: HindsightBankId.make(item.bank_id),
    name: item.name ?? null,
    factCount: item.fact_count ?? 0,
  };
}

/**
 * Bank stats for the strip, with pathways in T3 Code's fixed order; unknown and zero pathways are
 * dropped.
 */
export function statsFromResponse(response: HindsightBankStatsResponse): HindsightBankStats {
  const nodesByPathway: Array<HindsightPathwayCount> = [];
  for (const factType of HINDSIGHT_FACT_TYPES) {
    const count = response.nodes_by_fact_type[factType];
    if (count === undefined || count <= 0) continue;
    nodesByPathway.push({ pathway: pathwayFromFactType(factType), count });
  }
  return {
    nodes: response.total_nodes,
    links: response.total_links,
    documents: response.total_documents,
    nodesByPathway,
    pendingOperations: response.pending_operations,
    failedOperations: response.failed_operations,
    lastConsolidatedAt: response.last_consolidated_at ?? null,
  };
}

/**
 * Newest first, with undated rows last.
 *
 * The two sources are already sorted individually — Hindsight orders memory
 * units by `mentioned_at DESC` — but "All" interleaves them with mental
 * models, so the merge has to re-sort rather than concatenate.
 */
export function sortByRememberedAtDesc(
  memories: ReadonlyArray<HindsightMemory>,
): ReadonlyArray<HindsightMemory> {
  return [...memories].sort((left, right) => {
    const leftAt =
      left.rememberedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(left.rememberedAt);
    const rightAt =
      right.rememberedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(right.rememberedAt);
    const leftSafe = Number.isFinite(leftAt) ? leftAt : Number.NEGATIVE_INFINITY;
    const rightSafe = Number.isFinite(rightAt) ? rightAt : Number.NEGATIVE_INFINITY;
    return rightSafe - leftSafe;
  });
}
