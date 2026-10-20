/**
 * The Hermes reasoning-effort selector: what the composer offers, and what
 * picking a level does.
 *
 * Reading and writing are deliberately split across two moments. The provider
 * snapshot builds the descriptor (levels for the model, plus whatever
 * `config.yaml` currently resolves to), and the adapter applies a selection by
 * writing the per-model override back to `config.yaml`. Hermes reads that file
 * when its process starts and never re-reads it for a live session, so the
 * write happens just before the adapter spawns Hermes and a level lands on the
 * next session — there is no live channel for it, and nothing here should
 * suggest otherwise.
 *
 * @module hermesReasoningOptions
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
 *
 * No ladder means no descriptor: an unknown model, an unreadable models.dev
 * cache, or a model Hermes cannot configure reasoning for all render as a
 * composer with no reasoning control, rather than one whose levels might not
 * land.
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
 * Resolves a stored selection to the level to write, or `undefined` when there
 * is nothing to do.
 *
 * Selections are sticky per provider, so one made against a different model can
 * arrive for a model that does not offer it. Validating against the model's own
 * ladder keeps a stale pick from writing a level Hermes would reject.
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
 * Applies a composer selection to Hermes's config.
 *
 * Returns the level now recorded for the model, or `undefined` when the
 * selection said nothing about this model and the config was left alone. The
 * caller tracks that value to know when a running session needs its agent
 * rebuilt — see `forceReapply` in `applyHermesAcpModelSelection`.
 *
 * Never fails the caller: this edits a file T3 Code does not own, and a turn
 * must still run when the user's Hermes config is unwritable or hand-broken.
 * A write that failed also reports `undefined`, so nothing downstream believes
 * a level landed that did not.
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
