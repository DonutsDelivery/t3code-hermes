// @effect-diagnostics nodeBuiltinImport:off
/**
 * Reads and writes reasoning effort in Hermes's own `config.yaml`, shared with the `hermes` CLI.
 * The per-model `agent.reasoning_overrides` entry is written so other models keep the user's
 * default. Edits keep comments, never overwrite an unparseable file, and land atomically.
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
 * `resolve_per_model_reasoning_effort` tries them: exact, then dots and dashes swapped, then with
 * and without the provider prefix. Hermes's matcher is wider than this; we only need to recognise
 * what we write plus what a user plausibly hand-wrote.
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
 * Port of `resolve_reasoning_config`, narrowed to T3 Code's levels. A disabled value
 * (`false`/`none`/`disabled`) reports no level from its source, so the file is left alone until the
 * user picks one.
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
 * Reads `config.yaml` as plain data; missing or unparseable is `null` (no configured level), since
 * another app owns the file. Synchronous because the provider snapshot reads it while building
 * model capabilities.
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
 * `level: null` deletes the override, handing the model back to the global default — the way out of
 * a level the user no longer wants. Pruning the containers we created keeps repeated toggling from
 * leaving `agent: {}` behind in a file we do not own.
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
