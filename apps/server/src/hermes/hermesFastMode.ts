/**
 * The Hermes fast-mode toggle. Hermes decides eligibility; with T3 Code's `acp-fast-mode` patch it
 * marks eligible picker rows with `_meta.hermes.fastMode` and takes a per-session `fast_mode`
 * option. Stock Hermes marks nothing, so the toggle never appears where it would be ignored.
 */
import type { ModelSelection } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import { getModelSelectionBooleanOptionValue } from "@t3tools/shared/model";

import { buildBooleanOptionDescriptor } from "@t3tools/provider-core/server/snapshotProbe";

/** Descriptor id, shared with Claude and Codex so clients render one Fast toggle. */
export const HERMES_FAST_MODE_OPTION_ID = "fastMode";

/** The ACP session config option the patched Hermes reads. */
export const HERMES_FAST_MODE_CONFIG_ID = "fast_mode";

export const HERMES_FAST_MODE_DESCRIPTOR = buildBooleanOptionDescriptor({
  id: HERMES_FAST_MODE_OPTION_ID,
  label: "Fast Mode",
  description: "Faster output at a higher price.",
});

/** Whether Hermes marked this picker row as taking fast mode. */
export function hermesModelSupportsFastMode(model: EffectAcpSchema.ModelInfo): boolean {
  const hermes = model._meta?.hermes;
  return typeof hermes === "object" && hermes !== null && "fastMode" in hermes
    ? hermes.fastMode === true
    : false;
}

/**
 * The `fast_mode` value to send, or `undefined` when the selection never
 * touched the toggle, so an untouched session keeps Hermes's own default.
 */
export function resolveHermesFastModeSelection(
  modelSelection: ModelSelection | null | undefined,
): boolean | undefined {
  return getModelSelectionBooleanOptionValue(modelSelection, HERMES_FAST_MODE_OPTION_ID);
}
