/**
 * Hindsight response fixtures from `vectorize-io/hindsight` `205e47b4` (API 0.9.1, `openapi.json`
 * and `curation.py::list_memory_units`). Every declared field is kept so a rename fails tests
 * instead of blanking the Memory tab.
 */

/** `BankListResponse`. */
export const HINDSIGHT_BANKS_RESPONSE = {
  banks: [
    {
      bank_id: "hermes",
      name: "Hermes",
      disposition: { curiosity: 0.5, skepticism: 0.5, verbosity: 0.5 },
      mission: "Assist with the T3 Code fork.",
      created_at: "2026-07-01T09:00:00Z",
      updated_at: "2026-08-15T18:30:00Z",
      fact_count: 128,
      last_document_at: "2026-08-15T18:00:00Z",
      last_write_at: "2026-08-15T18:30:00Z",
    },
    {
      bank_id: "scratch",
      name: null,
      disposition: { curiosity: 0.5, skepticism: 0.5, verbosity: 0.5 },
      mission: null,
      created_at: "2026-08-01T09:00:00Z",
      updated_at: "2026-08-01T09:00:00Z",
      fact_count: 0,
      last_document_at: null,
      last_write_at: null,
    },
  ],
} as const;

/** `VersionResponse`. */
export const HINDSIGHT_VERSION_RESPONSE = {
  api_version: "0.9.1",
  features: {
    observations: true,
    mcp: true,
    worker: true,
    bank_config_api: true,
    bank_llm_health: true,
    file_upload_api: true,
    document_export_api: true,
    document_import_api: true,
    audit_log: false,
    llm_trace: false,
    store_document_text: true,
  },
} as const;

/**
 * `ListMemoryUnitsResponse`.
 *
 * Note `fact_type` rather than `type`, and `entities` as one comma-joined
 * string rather than an array — this endpoint disagrees with `recall` on both.
 */
export const HINDSIGHT_LIST_MEMORIES_RESPONSE = {
  items: [
    {
      id: "6f1d0b6e-2f7a-4a2e-9f1a-000000000001",
      text: "T3 Code's server runs TypeScript directly under Node 24.",
      context: "Learned while reading FORK.md",
      date: "2026-08-14",
      fact_type: "world",
      document_id: "doc-1",
      mentioned_at: "2026-08-14T11:00:00Z",
      occurred_start: null,
      occurred_end: null,
      entities: "T3 Code, Node",
      chunk_id: "chunk-1",
      proof_count: 2,
      tags: ["t3code"],
      metadata: {},
      consolidated_at: null,
      consolidation_failed_at: null,
      state: "valid",
      invalidation_reason: null,
      invalidated_at: null,
      edited_at: null,
    },
    {
      id: "6f1d0b6e-2f7a-4a2e-9f1a-000000000002",
      text: "Rebasing the fork's main branch would break every clone.",
      context: "",
      date: "",
      fact_type: "experience",
      document_id: null,
      mentioned_at: "2026-08-13T08:15:00Z",
      occurred_start: null,
      occurred_end: null,
      entities: "",
      chunk_id: null,
      proof_count: 1,
      tags: [],
      metadata: {},
      consolidated_at: null,
      consolidation_failed_at: null,
      state: "valid",
      invalidation_reason: null,
      invalidated_at: null,
      edited_at: null,
    },
  ],
  total: 128,
  limit: 26,
  offset: 0,
} as const;

/** `RecallResponse`. */
export const HINDSIGHT_RECALL_RESPONSE = {
  results: [
    {
      id: "6f1d0b6e-2f7a-4a2e-9f1a-000000000001",
      text: "T3 Code's server runs TypeScript directly under Node 24.",
      type: "world",
      entities: ["T3 Code", "Node"],
      context: "Learned while reading FORK.md",
      occurred_start: null,
      occurred_end: null,
      mentioned_at: "2026-08-14T11:00:00Z",
      document_id: "doc-1",
      metadata: {},
      chunk_id: "chunk-1",
      tags: ["t3code"],
      source_fact_ids: null,
      scores: { final: 0.82, reranker: 0.79, semantic: 0.71, keyword: null },
    },
  ],
  trace: null,
  entities: null,
  chunks: null,
  source_facts: null,
  source_facts_truncated: null,
} as const;

/** `MentalModelListResponse` at `detail=content`. */
export const HINDSIGHT_MENTAL_MODELS_RESPONSE = {
  items: [
    {
      id: "mm-1",
      bank_id: "hermes",
      name: "How this fork tracks upstream",
      source_query: "How does the fork stay current with upstream?",
      content: "Merge-based, never rebase, nightly at 05:30 UTC.",
      tags: [],
      max_tokens: 2048,
      trigger: null,
      last_refreshed_at: "2026-08-15T06:00:00Z",
      created_at: "2026-07-02T10:00:00Z",
      reflect_response: null,
      is_stale: false,
    },
  ],
} as const;

/**
 * `BankStatsResponse`.
 *
 * Every declared field is here, including the ones the strip never renders —
 * link breakdowns, per-status operation counts — so a Hindsight that renames
 * one is caught by the decoder rather than by a blank strip.
 */
export const HINDSIGHT_BANK_STATS_RESPONSE = {
  bank_id: "hermes",
  total_nodes: 128,
  total_links: 342,
  total_documents: 17,
  nodes_by_fact_type: { world: 80, experience: 40, observation: 8 },
  links_by_link_type: { supports: 200, contradicts: 12, relates: 130 },
  links_by_fact_type: { world: 220, experience: 110, observation: 12 },
  links_breakdown: { world: { supports: 180, relates: 40 } },
  pending_operations: 2,
  failed_operations: 1,
  operations_by_status: {
    pending: 2,
    processing: 0,
    completed: 54,
    failed: 1,
    cancelled: 0,
  },
  last_consolidated_at: "2026-08-15T17:45:00Z",
  last_memory_write_at: "2026-08-15T18:30:00Z",
  pending_consolidation: 3,
  failed_consolidation: 0,
  total_observations: 8,
} as const;

/** `RetainResponse` for a synchronous write. */
export const HINDSIGHT_RETAIN_RESPONSE = {
  success: true,
  bank_id: "hermes",
  items_count: 3,
  async: false,
  operation_id: null,
  operation_ids: null,
  usage: null,
} as const;

/** `ReflectResponse`. */
export const HINDSIGHT_REFLECT_RESPONSE = {
  text: "## What I know\n\nThe fork adds a Hermes provider and tracks upstream by merge.",
  based_on: null,
  structured_output: null,
  usage: null,
  trace: null,
} as const;
