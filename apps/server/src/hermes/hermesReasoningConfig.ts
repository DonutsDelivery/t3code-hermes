// @effect-diagnostics nodeBuiltinImport:off
/**
 * Reading and writing the reasoning effort in Hermes's own `config.yaml`.
 *
 * Hermes resolves reasoning through a single chokepoint
 * (`hermes_constants.resolve_reasoning_config`): a per-model entry under
 * `agent.reasoning_overrides` wins, otherwise the global
 * `agent.reasoning_effort`. T3 Code writes the per-model entry, so picking a
 * level for one model never rewrites the default the user chose for every
 * other one.
 *
 * This is the user's real Hermes config — the same file the `hermes` CLI
 * reads — which is the point: a level picked in T3 Code is the level the
 * terminal uses, and vice versa. That also means the writes here are careful:
 * the document is edited in place through `yaml`'s document API so comments and
 * unrelated keys survive, a file that fails to parse is never overwritten, and
 * the replacement lands atomically.
 *
 * @module hermesReasoningConfig
 */
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { isMap, parseDocument } from "yaml";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import {
  isHermesReasoningLevel,
  parseHermesModelSlug,
  type HermesReasoningLevel,
} from "./hermesReasoning.ts";

const AGENT_KEY = "agent";
const OVERRIDES_KEY = "reasoning_overrides";
const GLOBAL_KEY = "reasoning_effort";

/**
 * Bounded spelling variants for a model, in the order Hermes's own
 * `resolve_per_model_reasoning_effort` tries them: exact, then dots and dashes
 * swapped, then with and without the provider prefix. Hermes's matcher is
 * wider than this; we only need to recognise what we write plus what a user
 * plausibly hand-wrote.
 */
function modelOverrideVariants(slug: string): ReadonlyArray<string> {
  const parsed = parseHermesModelSlug(slug);
  if (parsed === null) return [];

  const seeds = [parsed.model, parsed.bare];
  if (parsed.provider !== null) {
    seeds.push(`${parsed.provider}:${parsed.model}`, `${parsed.provider}/${parsed.model}`);
  }

  const variants: Array<string> = [];
  for (const seed of seeds) {
    for (const spelling of [seed, seed.replaceAll(".", "-"), seed.replaceAll("-", ".")]) {
      for (const cased of [spelling, spelling.toLowerCase()]) {
        if (cased.length > 0 && !variants.includes(cased)) variants.push(cased);
      }
    }
  }
  return variants;
}

/**
 * The key T3 Code writes an override under: the model without its provider
 * prefix, which is how the CLI's own `/reasoning` writes it and what Hermes
 * matches first.
 */
export function hermesReasoningOverrideKey(slug: string | null | undefined): string | null {
  return parseHermesModelSlug(slug)?.model ?? null;
}

/** What `config.yaml` currently resolves to for one model. */
export interface HermesResolvedReasoning {
  readonly level: HermesReasoningLevel | null;
  /** Where the level came from, for callers that explain themselves. */
  readonly source: "per-model" | "global" | "unset";
}

const UNSET: HermesResolvedReasoning = { level: null, source: "unset" };

function normalizeLevel(value: unknown): HermesReasoningLevel | null {
  if (!isHermesReasoningLevel(value)) return null;
  return value.trim().toLowerCase() as HermesReasoningLevel;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function existingOverrideKey(overrides: unknown, slug: string): string | null {
  if (!isMap(overrides)) return null;
  const keys = overrides.items.map((item) => {
    const key = item.key as { readonly value?: unknown };
    return String(key.value ?? item.key);
  });
  const lowered = new Map(keys.map((key) => [key.trim().toLowerCase(), key] as const));
  for (const variant of modelOverrideVariants(slug)) {
    const key = lowered.get(variant.toLowerCase());
    if (key !== undefined) return key;
  }
  return null;
}

/**
 * Port of `resolve_reasoning_config`, narrowed to the levels T3 Code offers.
 *
 * Hermes treats a `false`/`none`/`disabled` value as "thinking disabled", which
 * is a state T3 Code deliberately does not offer — reporting it as `unset`
 * would mislabel it, so it is reported as no level from the source that set it
 * and the caller leaves the file alone until the user picks something.
 */
export function resolveHermesReasoningFromConfig(input: {
  readonly config: unknown;
  readonly slug: string | null | undefined;
}): HermesResolvedReasoning {
  const config = plainRecord(input.config);
  if (config === null) return UNSET;
  const agent = plainRecord(config[AGENT_KEY]);
  if (agent === null) return UNSET;

  const overrides = plainRecord(agent[OVERRIDES_KEY]);
  if (overrides !== null && input.slug) {
    const lowered = new Map(
      Object.entries(overrides).map(([key, value]) => [key.trim().toLowerCase(), value] as const),
    );
    for (const variant of modelOverrideVariants(input.slug)) {
      const hit = Object.hasOwn(overrides, variant)
        ? overrides[variant]
        : lowered.get(variant.toLowerCase());
      if (hit === undefined) continue;
      return { level: normalizeLevel(hit), source: "per-model" };
    }
  }

  const global = agent[GLOBAL_KEY];
  if (global === undefined || global === null || global === "") return UNSET;
  return { level: normalizeLevel(global), source: "global" };
}

export type HermesReasoningWriteOutcome =
  | { readonly _tag: "written"; readonly level: HermesReasoningLevel | null }
  | { readonly _tag: "unchanged" }
  | { readonly _tag: "parseFailed"; readonly detail: string }
  | { readonly _tag: "writeFailed"; readonly detail: string };

/**
 * Reads `config.yaml` as plain data. Missing or unparseable reads as `null`,
 * which callers treat as "no configured level" rather than an error — the file
 * belongs to another application and is allowed to be absent or mid-edit.
 *
 * Synchronous because the provider snapshot resolves the current level while
 * building model capabilities, where a single small local read is cheaper than
 * threading a filesystem service through the probe.
 */
export function readHermesConfigSync(configFile: string): unknown {
  let text: string;
  try {
    text = NodeFS.readFileSync(configFile, "utf8");
  } catch {
    return null;
  }
  const document = parseDocument(text);
  if (document.errors.length > 0) return null;
  return document.toJS() as unknown;
}

/**
 * Sets (or clears) the per-model reasoning override in `config.yaml`.
 *
 * `level: null` deletes the override, handing the model back to the global
 * default — the way out of a level the user no longer wants. Pruning the
 * containers we created keeps repeated toggling from leaving `agent: {}`
 * behind in a file we do not own.
 */
export const writeHermesReasoningOverride = Effect.fn(
  "hermesReasoningConfig.writeHermesReasoningOverride",
)(function* (input: {
  readonly configFile: string;
  readonly slug: string;
  readonly level: HermesReasoningLevel | null;
}): Effect.fn.Return<HermesReasoningWriteOutcome, never, FileSystem.FileSystem | Path.Path> {
  const key = hermesReasoningOverrideKey(input.slug);
  if (key === null) return { _tag: "unchanged" } as const;

  const fs = yield* FileSystem.FileSystem;
  const existing = yield* fs
    .readFileString(input.configFile)
    .pipe(Effect.orElseSucceed(() => null));

  // Nothing to clear in a file that does not exist yet, and no reason to
  // create one just to say "default".
  if (existing === null && input.level === null) return { _tag: "unchanged" } as const;

  const document = parseDocument(existing ?? "");
  if (document.errors.length > 0) {
    // Never rewrite a file we could not read. A hand-edited config with a
    // typo in an unrelated section must survive T3 Code touching it.
    return {
      _tag: "parseFailed",
      detail: document.errors[0]?.message ?? "unknown YAML parse error",
    } as const;
  }

  const overrides = document.getIn([AGENT_KEY, OVERRIDES_KEY]);
  const existingKey = existingOverrideKey(overrides, input.slug);
  const resolvedKey = existingKey ?? key;
  const currentLevel = normalizeLevel(
    existingKey === null ? undefined : document.getIn([AGENT_KEY, OVERRIDES_KEY, existingKey]),
  );
  if (currentLevel === input.level) return { _tag: "unchanged" } as const;

  if (input.level === null) {
    if (existingKey === null) return { _tag: "unchanged" } as const;
    document.deleteIn([AGENT_KEY, OVERRIDES_KEY, existingKey]);
    const overrides = document.getIn([AGENT_KEY, OVERRIDES_KEY]);
    if (isMap(overrides) && overrides.items.length === 0) {
      document.deleteIn([AGENT_KEY, OVERRIDES_KEY]);
      const agent = document.getIn([AGENT_KEY]);
      if (isMap(agent) && agent.items.length === 0) document.deleteIn([AGENT_KEY]);
    }
  } else {
    // `setIn` builds the `agent:` / `reasoning_overrides:` containers itself,
    // including on a document parsed from an empty file.
    document.setIn([AGENT_KEY, OVERRIDES_KEY, resolvedKey], input.level);
  }

  const written = yield* writeFileStringAtomically({
    filePath: input.configFile,
    contents: document.toString(),
  }).pipe(Effect.result);
  if (Result.isFailure(written)) {
    return { _tag: "writeFailed", detail: written.failure._tag } as const;
  }
  return { _tag: "written", level: input.level } as const;
});
