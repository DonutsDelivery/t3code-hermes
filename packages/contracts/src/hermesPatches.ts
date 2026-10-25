/**
 * Hermes patches contract: the fork's patches against the user's Hermes checkout (`infra/hermes`),
 * whose status the Patches tab shows. Clients name a shipped patch by id and never send patch
 * content.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  ForwardCompatibleOptional,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const HermesPatchId = TrimmedNonEmptyString.pipe(Schema.brand("HermesPatchId"));
export type HermesPatchId = typeof HermesPatchId.Type;

/**
 * - `applied`: the checkout already contains the change.
 * - `notApplied`: the patch applies cleanly and can be applied now.
 * - `doesNotApply`: it applies in neither direction. `HermesPatch.reason`
 *   says why.
 */
export const HermesPatchState = Schema.Literals(["applied", "notApplied", "doesNotApply"]);
export type HermesPatchState = typeof HermesPatchState.Type;

/**
 * Why a `doesNotApply` patch does not fit: `hermesTooOld` (update Hermes), `awaitingPatchUpdate`
 * (needs a T3 Code update with a rebased version), or `localChanges` (commit or discard edits in
 * its files).
 */
export const HermesPatchMisfitReason = Schema.Literals([
  "hermesTooOld",
  "awaitingPatchUpdate",
  "localChanges",
]);
export type HermesPatchMisfitReason = typeof HermesPatchMisfitReason.Type;

export const HermesPatch = Schema.Struct({
  id: HermesPatchId,
  title: TrimmedNonEmptyString,
  /** What stops working without the patch, in the user's terms. */
  neededFor: TrimmedNonEmptyString,
  state: HermesPatchState,
  /** Set only for `doesNotApply`. Absent from older servers. */
  reason: ForwardCompatibleOptional(HermesPatchMisfitReason),
});
export type HermesPatch = typeof HermesPatch.Type;

/**
 * Whether the environment could inspect a Hermes checkout at all.
 *
 * `notGitCheckout` covers pip, Nix, Docker and package installs: patches apply
 * to a git checkout, the same install shape `hermes update` can update.
 */
export const HermesPatchesAvailability = Schema.Literals([
  "ready",
  "providerDisabled",
  "hermesNotFound",
  "notGitCheckout",
]);
export type HermesPatchesAvailability = typeof HermesPatchesAvailability.Type;

/**
 * The gateway serving the Hermes home, which runs the code it imported at startup: `upToDate`
 * (started after patched files changed), `outdated`, or `restarting` (this server is restarting
 * it).
 */
export const HermesGatewayState = Schema.Literals(["upToDate", "outdated", "restarting"]);
export type HermesGatewayState = typeof HermesGatewayState.Type;

export const HermesGatewayStatus = Schema.Struct({
  state: HermesGatewayState,
  /**
   * False when nothing would bring the gateway back after it stops, such as
   * one started with `hermes gateway run` in a terminal. It has to be
   * restarted where it was started.
   */
  canRestart: Schema.Boolean,
});
export type HermesGatewayStatus = typeof HermesGatewayStatus.Type;

export const HermesPatchesSnapshot = Schema.Struct({
  availability: HermesPatchesAvailability,
  /** The checkout the states describe; null unless `ready`. */
  checkoutPath: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * Always false. Older clients warned that `hermes update` cannot move a
   * detached HEAD; it does, and release channels leave the checkout detached
   * on purpose. Kept because those clients require the field.
   */
  detachedHead: Schema.Boolean,
  /** The checkout's HEAD, abbreviated. Absent unless `ready`, and from older servers. */
  headCommit: Schema.optionalKey(TrimmedNonEmptyString),
  /**
   * True when `hermesPatchUpdateHermes` can run: any git checkout.
   * Absent from older servers, which have no such call.
   */
  canUpdateHermes: Schema.optionalKey(Schema.Boolean),
  patches: ForwardCompatibleArray(HermesPatch),
  /** Null when no gateway is running, and from servers that predate this field. */
  gateway: Schema.NullOr(HermesGatewayStatus).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * Why the last gateway restart from T3 Code failed, until the next one
   * starts. Null when it succeeded or none was attempted.
   */
  gatewayRestartFailure: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type HermesPatchesSnapshot = typeof HermesPatchesSnapshot.Type;

export const HermesPatchListInput = Schema.Struct({});
export type HermesPatchListInput = typeof HermesPatchListInput.Type;

export const HermesPatchChangeInput = Schema.Struct({
  patchId: HermesPatchId,
});
export type HermesPatchChangeInput = typeof HermesPatchChangeInput.Type;

export const HermesPatchUpdateHermesInput = Schema.Struct({});
export type HermesPatchUpdateHermesInput = typeof HermesPatchUpdateHermesInput.Type;

/**
 * What `hermesPatchUpdateHermes` did: it removes the applied patches, runs
 * `hermes update`, and reapplies them with the version that fits the new HEAD.
 */
export const HermesPatchUpdateHermesResult = Schema.Struct({
  snapshot: HermesPatchesSnapshot,
  /** HEAD before the update, abbreviated; compare with `snapshot.headCommit`. */
  previousHeadCommit: Schema.NullOr(TrimmedNonEmptyString),
  /** `hermes update` exited non-zero or timed out. Patches were still restored where they fit. */
  updateFailed: Schema.Boolean,
  /** The tail of `hermes update`'s output when it failed, else null. */
  failureOutput: Schema.NullOr(Schema.String),
  /** Patches that were applied before and are applied again. */
  reapplied: ForwardCompatibleArray(HermesPatchId),
  /** Previously applied patches no version fits any more; a T3 Code update brings them back. */
  awaitingPatchUpdate: ForwardCompatibleArray(HermesPatchId),
  /** Previously applied patches that could not be reapplied for any other reason. */
  notReapplied: ForwardCompatibleArray(HermesPatchId),
});
export type HermesPatchUpdateHermesResult = typeof HermesPatchUpdateHermesResult.Type;
export const HermesGatewayRestartInput = Schema.Struct({});
export type HermesGatewayRestartInput = typeof HermesGatewayRestartInput.Type;

export class HermesPatchError extends Schema.TaggedError<HermesPatchError>()("HermesPatchError", {
  reason: Schema.Literals(["unavailable", "unknownPatch", "wrongState", "commandFailed"]),
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Hermes patch request failed (${this.reason}): ${this.detail}`;
  }
}
