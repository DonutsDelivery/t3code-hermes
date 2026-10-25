/**
 * The Hermes reasoning-effort selector. The snapshot offers levels and the current `config.yaml`
 * value; the adapter writes the per-model override before spawning Hermes, which reads it only at
 * startup.
 */
import type { ModelCapabilities, ProviderOptionSelection } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import {
  isHermesReasoningLevel,
  readModelsDevCache,
  resolveHermesReasoningLevels,
  resolveHermesReasoningPaths,
  type HermesReasoningLevel,
} from "./hermesReasoning.ts";
import {
  readHermesConfigSync,
  resolveHermesReasoningFromConfig,
  writeHermesReasoningOverride,
} from "./hermesReasoningConfig.ts";

/** Descriptor id, also the key a stored selection is keyed by. */
export const HERMES_REASONING_OPTION_ID = "reasoningEffort";

/**
 * Choice that hands the model back to whatever Hermes is configured to do —
 * the way out of a level, without inventing a "reasoning off" state Hermes
 * treats as something else entirely.
 */
export const HERMES_REASONING_DEFAULT_CHOICE_ID = "default";

const LEVEL_LABELS: Readonly<Record<HermesReasoningLevel, string>> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

/**
 * Everything the descriptor builder needs, read once per snapshot so a
 * provider probe touches each file once rather than once per model.
 */
export interface HermesReasoningContext {
  readonly cache: ReturnType<typeof readModelsDevCache>;
  readonly config: unknown;
  readonly configFile: string;
}

export function readHermesReasoningContext(
  environment: NodeJS.ProcessEnv = process.env,
): HermesReasoningContext {
  const paths = resolveHermesReasoningPaths(environment);
  return {
    cache: readModelsDevCache(paths.modelsDevCacheFile),
    config: readHermesConfigSync(paths.configFile),
    configFile: paths.configFile,
  };
}

/**
 * Capabilities for one Hermes model.
 * No ladder means no descriptor: an unknown model, an unreadable models.dev cache, or a model
 * Hermes cannot configure reasoning for all render as a composer with no reasoning control, rather
 * than one whose levels might not land.
 */
export function buildHermesModelCapabilities(input: {
  readonly slug: string;
  readonly context: HermesReasoningContext;
}): ModelCapabilities {
  const levels = resolveHermesReasoningLevels({
    slug: input.slug,
    cache: input.context.cache,
  });
  if (levels === null || levels.length === 0) {
    return createModelCapabilities({ optionDescriptors: [] });
  }

  const resolved = resolveHermesReasoningFromConfig({
    config: input.context.config,
    slug: input.slug,
  });
  const currentValue =
    resolved.level !== null && levels.includes(resolved.level)
      ? resolved.level
      : HERMES_REASONING_DEFAULT_CHOICE_ID;

  return createModelCapabilities({
    optionDescriptors: [
      {
        id: HERMES_REASONING_OPTION_ID,
        label: "Reasoning",
        description: "Applies to the next Hermes session for a thread.",
        type: "select",
        options: [
          {
            id: HERMES_REASONING_DEFAULT_CHOICE_ID,
            label: "Hermes default",
            description: "Uses the effort configured in Hermes.",
            isDefault: true,
          },
          ...levels.map((level) => ({ id: level, label: LEVEL_LABELS[level] })),
        ],
        currentValue,
      },
    ],
  });
}

/**
 * Resolves a stored selection to the level to write, or `undefined` when there is nothing to do.
 * Selections are sticky per provider, so one made against a different model can arrive for a model
 * that does not offer it. Validating against the model's own ladder keeps a stale pick from writing
 * a level Hermes would reject.
 */
export function resolveHermesReasoningSelection(input: {
  readonly slug: string;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly cache: HermesReasoningContext["cache"];
}): HermesReasoningLevel | null | undefined {
  const selection = input.selections?.find((entry) => entry.id === HERMES_REASONING_OPTION_ID);
  if (selection === undefined || typeof selection.value !== "string") return undefined;

  const levels = resolveHermesReasoningLevels({ slug: input.slug, cache: input.cache });
  if (levels === null || levels.length === 0) return undefined;

  const value = selection.value.trim().toLowerCase();
  if (value === HERMES_REASONING_DEFAULT_CHOICE_ID) return null;
  if (!isHermesReasoningLevel(value)) return undefined;
  const level = value as HermesReasoningLevel;
  return levels.includes(level) ? level : undefined;
}

/**
 * Applies a composer selection to Hermes's config and returns the level now recorded, or
 * `undefined` if untouched. Never fails a turn on an unwritable config; a failed write also reports
 * `undefined`.
 */
export const applyHermesReasoningSelection = Effect.fn(
  "hermesReasoningOptions.applyHermesReasoningSelection",
)(function* (input: {
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.fn.Return<
  HermesReasoningLevel | null | undefined,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const slug = input.model?.trim();
  if (!slug || !input.selections || input.selections.length === 0) return undefined;

  const context = readHermesReasoningContext(input.environment ?? process.env);
  const level = resolveHermesReasoningSelection({
    slug,
    selections: input.selections,
    cache: context.cache,
  });
  if (level === undefined) return undefined;

  const outcome = yield* writeHermesReasoningOverride({
    configFile: context.configFile,
    slug,
    level,
  });
  if (outcome._tag === "parseFailed" || outcome._tag === "writeFailed") {
    yield* Effect.logWarning("Could not record the Hermes reasoning effort.", {
      outcome: outcome._tag,
      detail: outcome.detail,
      model: slug,
    });
    return undefined;
  }
  return level;
});
