// @effect-diagnostics nodeBuiltinImport:off
/**
 * Which reasoning-effort levels a Hermes model supports, from Hermes's own `models_dev_cache.json`,
 * with ported `hermes-webui` ceilings and GLM-4.7 forced thinking. Returns `null` (no selector)
 * when the catalogue can't answer; custom endpoints fall back to the vendor's catalogue when
 * recognizable.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Hermes's own ladder, weakest first
 * (`hermes_constants.VALID_REASONING_EFFORTS`). Order is load-bearing: the
 * ceiling rules below cap by position.
 */
export const HERMES_REASONING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type HermesReasoningLevel = (typeof HERMES_REASONING_LEVELS)[number];

export function isHermesReasoningLevel(value: unknown): value is HermesReasoningLevel {
  return (
    typeof value === "string" &&
    (HERMES_REASONING_LEVELS as ReadonlyArray<string>).includes(value.trim().toLowerCase())
  );
}

export interface HermesReasoningPaths {
  readonly home: string;
  readonly configFile: string;
  readonly modelsDevCacheFile: string;
}

/**
 * Resolves Hermes's home the same way the cron reader does — `HERMES_HOME`
 * when set, otherwise `~/.hermes`.
 */
export function resolveHermesReasoningPaths(
  environment: NodeJS.ProcessEnv = process.env,
  homedir: string = NodeOS.homedir(),
): HermesReasoningPaths {
  const home = environment["HERMES_HOME"]?.trim() || NodePath.join(homedir, ".hermes");
  return {
    home,
    configFile: NodePath.join(home, "config.yaml"),
    modelsDevCacheFile: NodePath.join(home, "models_dev_cache.json"),
  };
}

/** A Hermes model slug split into the parts a catalogue lookup needs. */
export interface ParsedHermesModelSlug {
  /** Hermes provider id, lowercased. `null` when the slug carries no prefix. */
  readonly provider: string | null;
  /** Model id as the upstream spells it, e.g. `moonshotai/kimi-k2`. */
  readonly model: string;
  /** Last path segment of the model id, used by the family rules. */
  readonly bare: string;
}

/**
 * Splits the slug Hermes's ACP adapter encodes.
 * `_encode_model_choice` writes `<provider>:<model>` and falls back to a bare model id when it has
 * no provider. The model half keeps any vendor namespace (`openrouter:moonshotai/kimi-k2`), because
 * that is how models.dev keys aggregator catalogues.
 */
export function parseHermesModelSlug(
  slug: string | null | undefined,
): ParsedHermesModelSlug | null {
  const trimmed = slug?.trim();
  if (!trimmed) return null;

  // Named endpoints encode their provider as `custom:<name>`. Keep model
  // namespaces and trailing tags intact rather than splitting at the last colon.
  const namedEndpoint = /^custom:[^:/]+:/i.exec(trimmed);
  const separator = namedEndpoint ? namedEndpoint[0].length - 1 : trimmed.indexOf(":");
  const provider = separator > 0 ? trimmed.slice(0, separator).trim().toLowerCase() : "";
  const model = separator > 0 ? trimmed.slice(separator + 1).trim() : trimmed;
  if (model.length === 0) return null;

  return {
    provider: provider.length > 0 ? provider : null,
    model,
    bare: (model.split("/").pop() ?? model).toLowerCase(),
  };
}

/**
 * Hermes provider id -> models.dev provider id (`agent/models_dev.PROVIDER_TO_MODELS_DEV`). Only
 * the entries whose catalogue answer differs from the Hermes id are worth carrying; anything absent
 * falls back to the Hermes id itself, which is right for the majority of providers and harmless
 * when it is not (an unknown id yields "no opinion").
 */
const PROVIDER_TO_MODELS_DEV: Readonly<Record<string, string>> = {
  "openai-codex": "openai",
  novita: "novita-ai",
  kimi: "kimi-for-coding",
  "kimi-coding": "kimi-for-coding",
  "kimi-coding-cn": "kimi-for-coding",
  moonshot: "kimi-for-coding",
  "minimax-oauth": "minimax",
  "qwen-oauth": "alibaba",
  copilot: "github-copilot",
  "ai-gateway": "vercel",
  "opencode-zen": "opencode",
  kilocode: "kilo",
  fireworks: "fireworks-ai",
  gemini: "google",
  "xai-oauth": "xai",
  "meta-ai": "meta",
};

function modelsDevProviderId(provider: string): string {
  return PROVIDER_TO_MODELS_DEV[provider] ?? provider;
}

/** Custom endpoints inherit the underlying model vendor's catalogue and limits. */
function resolveCatalogueModel(
  cache: ModelsDevCache,
  parsed: ParsedHermesModelSlug,
): ParsedHermesModelSlug {
  if (parsed.provider === null || isRecord(cache[modelsDevProviderId(parsed.provider)])) {
    return parsed;
  }
  const provider = /^(gpt-|o[134](?:-|$))/.test(parsed.bare)
    ? "openai"
    : parsed.bare.startsWith("claude-")
      ? "anthropic"
      : parsed.bare.startsWith("gemini-")
        ? "google"
        : null;
  return provider === null ? parsed : { ...parsed, provider, model: parsed.bare };
}

/**
 * The slice of `models_dev_cache.json` we depend on.
 *
 * The file is the verbatim models.dev `api.json` payload: provider id at the
 * top level, a `models` map beneath it, and a boolean `reasoning` flag on each
 * model. `hermesReasoningFixtures.ts` pins that shape.
 */
export interface ModelsDevCache {
  readonly [providerId: string]: {
    readonly models?: {
      readonly [modelId: string]: {
        readonly reasoning?: unknown;
        readonly reasoning_options?: unknown;
      };
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads and validates the cache Hermes keeps on disk.
 *
 * Mirrors Hermes's own `_validate_registry`: anything that is not a non-empty
 * object is treated as absent, because a `{}` masquerading as a catalogue would
 * turn every model into "does not reason".
 */
export function readModelsDevCache(cacheFile: string): ModelsDevCache | null {
  let raw: string;
  try {
    raw = NodeFS.readFileSync(cacheFile, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || Object.keys(parsed).length === 0) return null;
  return parsed as ModelsDevCache;
}

/**
 * Port of Hermes's `_find_model_entry`: exact, then case-insensitive, then the
 * `:cloud`/`-cloud` suffix forms some catalogues key their models under.
 */
function findModelEntry(
  models: Record<string, unknown>,
  model: string,
): Record<string, unknown> | null {
  const exact = models[model];
  if (isRecord(exact)) return exact;

  const lowered = model.toLowerCase();
  for (const [id, entry] of Object.entries(models)) {
    if (id.toLowerCase() === lowered && isRecord(entry)) return entry;
  }
  for (const suffix of [":cloud", "-cloud"]) {
    const suffixed = models[`${model}${suffix}`];
    if (isRecord(suffixed)) return suffixed;
    const suffixedLower = `${lowered}${suffix}`;
    for (const [id, entry] of Object.entries(models)) {
      if (id.toLowerCase() === suffixedLower && isRecord(entry)) return entry;
    }
  }
  return null;
}

/** The catalogue entry for a model, including any explicit effort options. */
function lookupModelsDevEntry(
  cache: ModelsDevCache | null,
  parsed: ParsedHermesModelSlug,
): Record<string, unknown> | null {
  if (cache === null || parsed.provider === null) return null;
  const catalogueModel = resolveCatalogueModel(cache, parsed);
  if (catalogueModel.provider === null) return null;
  const providerEntry = cache[modelsDevProviderId(catalogueModel.provider)];
  if (!isRecord(providerEntry)) return null;
  const models = providerEntry["models"];
  if (!isRecord(models)) return null;
  return findModelEntry(models, catalogueModel.model);
}

const OPENAI_FAMILY_PROVIDERS = new Set([
  "openai",
  "openai-codex",
  "azure",
  "azure-openai",
  "azure-foundry",
  "copilot",
  "github-copilot",
]);

const GEMINI_PROVIDERS = new Set(["gemini", "google", "google-gemini", "google-vertex", "vertex"]);

const ANTHROPIC_LANES = new Set([
  "anthropic",
  "claude",
  "anthropic-claude",
  "azure-foundry",
  "azure-openai",
  "azure",
  "bedrock",
  "aws-bedrock",
  "vertex",
  "google-vertex",
]);

function capAt(level: HermesReasoningLevel): ReadonlyArray<HermesReasoningLevel> {
  return HERMES_REASONING_LEVELS.slice(0, HERMES_REASONING_LEVELS.indexOf(level) + 1);
}

/**
 * GPT-5.6 and its Sol/Terra/Luna variants add a `max` tier above `xhigh`;
 * 5.5 and earlier stop at `xhigh`. Neither takes `ultra`.
 */
function isGpt56(bare: string): boolean {
  return bare.startsWith("gpt-5.6") || bare.startsWith("gpt-5-6");
}

/**
 * Port of `_is_pre_adaptive_anthropic`: Claude 3.x and 4.0–4.5 use manual
 * thinking budgets with no `max` tier, so they must be capped at xhigh rather
 * than silently falling back to an 8k budget. 4.6+ is adaptive.
 */
export function isPreAdaptiveAnthropic(bare: string): boolean {
  if (!bare.includes("claude")) return false;
  if (/claude-3\b/.test(bare) || /claude-3[.-]/.test(bare)) return true;

  // A date stamp (six digits or more) is not a minor version.
  const versioned = /(\d+)[.-](\d{1,2})(?!\d)/.exec(bare);
  if (versioned) {
    const major = Number(versioned[1]);
    const minor = Number(versioned[2]);
    return major < 4 || (major === 4 && minor < 6);
  }
  const majorOnly = /[-.](\d+)(?:[-.]\d{6,})?(?:\b|-)/.exec(bare);
  if (majorOnly) return Number(majorOnly[1]) < 5;
  // Unversioned or `-latest` is the current flagship, which is adaptive.
  return false;
}

/**
 * Z.AI tier for a native-`zai` GLM model (port of `_zai_glm_classification`): `effort` for
 * GLM-5.2+, `thinking` (on/off) for 4.5 to 5.1, `forced` for the 4.7 family, or `null`.
 */
export function classifyZaiGlm(
  parsed: ParsedHermesModelSlug,
): "effort" | "thinking" | "forced" | null {
  const provider = parsed.provider;
  if (provider === null) return null;
  if (!["zai", "glm", "z-ai", "z.ai", "zhipu"].includes(provider)) return null;
  if (!parsed.bare.includes("glm")) return null;
  if (parsed.bare.startsWith("glm-4.7")) return "forced";

  const match = /glm-(\d+)(?:\D+(\d+))?/.exec(parsed.bare);
  if (match) {
    const major = Number(match[1]);
    const minor = match[2] ? Number(match[2]) : 0;
    if (major > 5 || (major === 5 && minor >= 2)) return "effort";
    if (major > 4 || (major === 4 && minor >= 5)) return "thinking";
  }
  return null;
}

/**
 * Applies the lane quirks to an otherwise-full ladder. Port of
 * `_filter_reasoning_efforts_for_provider`, minus the heuristics hermes-webui
 * needs for locally probed endpoints.
 */
function applyHermesReasoningCeilings(
  parsed: ParsedHermesModelSlug,
): ReadonlyArray<HermesReasoningLevel> {
  const provider = parsed.provider ?? "";
  const bare = parsed.bare;

  if (OPENAI_FAMILY_PROVIDERS.has(provider)) {
    // o-series reasoning models document low/medium/high only.
    if (/^o[134]/.test(bare)) return ["low", "medium", "high"];
    if (bare.startsWith("gpt-5")) return capAt(isGpt56(bare) ? "max" : "xhigh");
  }
  if (GEMINI_PROVIDERS.has(provider)) return capAt("xhigh");
  if (ANTHROPIC_LANES.has(provider) && isPreAdaptiveAnthropic(bare)) return capAt("xhigh");

  const zai = classifyZaiGlm(parsed);
  // `thinking` and `forced` tiers reject the ladder outright; the exclusion is
  // what keeps the UI from offering a level that cannot land.
  if (zai !== null && zai !== "effort") return [];

  return HERMES_REASONING_LEVELS;
}

/**
 * The levels to offer for one Hermes model slug.
 *
 * `null` means "no opinion" — the caller omits the control. An empty array
 * means "known to have no configurable reasoning", which the caller also omits
 * but for a reason it can state.
 */
export function resolveHermesReasoningLevels(input: {
  readonly slug: string | null | undefined;
  readonly cache: ModelsDevCache | null;
}): ReadonlyArray<HermesReasoningLevel> | null {
  const parsed = parseHermesModelSlug(input.slug);
  if (parsed === null) return null;

  const entry = lookupModelsDevEntry(input.cache, parsed);
  if (entry === null || typeof entry["reasoning"] !== "boolean") return null;
  if (entry["reasoning"] === false) return [];

  const ladder = applyHermesReasoningCeilings(
    input.cache === null ? parsed : resolveCatalogueModel(input.cache, parsed),
  );
  const options = entry["reasoning_options"];
  const effort = Array.isArray(options)
    ? options.find((option: unknown) => isRecord(option) && option["type"] === "effort")
    : undefined;
  // Explicit options narrow the legacy ladder; unsupported values never leak
  // into the selector, and forced-thinking/provider exclusions still apply.
  if (isRecord(effort) && Array.isArray(effort["values"])) {
    const values = effort["values"];
    return ladder.filter((level) => values.includes(level));
  }
  return ladder;
}
