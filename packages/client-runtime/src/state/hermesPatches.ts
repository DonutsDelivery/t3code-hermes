/**
 * Wording for the Hermes Patches tab, shared by web and mobile.
 *
 * @module state/hermesPatches
 */
import type {
  HermesGatewayStatus,
  HermesPatch,
  HermesPatchMisfitReason,
  HermesPatchState,
  HermesPatchesSnapshot,
  HermesPatchUpdateHermesResult,
} from "@t3tools/contracts";

export const HERMES_PATCH_STATE_LABELS: Record<HermesPatchState, string> = {
  applied: "Applied",
  notApplied: "Not applied",
  doesNotApply: "Doesn't apply",
};

/** One line under a patch saying what its state means for the user. */
export const HERMES_PATCH_STATE_HINTS: Record<HermesPatchState, string> = {
  applied: "Hermes has this change. New Hermes sessions use it.",
  notApplied: "Applies cleanly. Hermes does not have this change yet.",
  doesNotApply:
    "Made for a different Hermes version. Update Hermes; if it still doesn't apply, the patch needs a rebase in T3 Code.",
};

/** Why a patch doesn't apply, replacing the generic hint when the server says. */
export const HERMES_PATCH_REASON_HINTS: Record<HermesPatchMisfitReason, string> = {
  hermesTooOld: "Hermes is older than this patch. Update Hermes to apply it.",
  awaitingPatchUpdate:
    "Waiting for a T3 Code update. Hermes has moved past this patch, so it needs a rebased version.",
  localChanges:
    "Local changes in the files this patch touches. Commit or discard them in the Hermes checkout.",
};

/** The line under a patch: its reason when it doesn't apply and the server gave one. */
export function describeHermesPatchHint(patch: HermesPatch): string {
  return patch.state === "doesNotApply" && patch.reason !== undefined
    ? HERMES_PATCH_REASON_HINTS[patch.reason]
    : HERMES_PATCH_STATE_HINTS[patch.state];
}

/** Whether to offer Update Hermes: it can run, and it would make a patch fit. */
export function shouldOfferHermesUpdate(snapshot: HermesPatchesSnapshot): boolean {
  return (
    snapshot.canUpdateHermes === true &&
    snapshot.patches.some((patch) => patch.reason === "hermesTooOld")
  );
}

export const HERMES_UPDATE_LABEL = "Update Hermes";
export const HERMES_UPDATE_PENDING_LABEL = "Updating Hermes…";
export const HERMES_UPDATE_DESCRIPTION =
  "Removes T3 Code's patches, updates Hermes, then puts back each one that fits. It won't run while the checkout has uncommitted edits of your own.";

/** One line saying what Update Hermes did, built from the server's summary. */
export function describeHermesUpdateResult(result: HermesPatchUpdateHermesResult): string {
  const titleOf = (id: string) =>
    result.snapshot.patches.find((patch) => patch.id === id)?.title ?? id;
  const list = (ids: ReadonlyArray<string>) => ids.map(titleOf).join(", ");
  const parts: string[] = [];
  if (result.updateFailed) {
    const lastLine = result.failureOutput
      ?.split("\n")
      .map((line) => line.trim())
      .findLast((line) => line.length > 0);
    parts.push(
      lastLine === undefined
        ? "Hermes could not be updated."
        : `Hermes could not be updated: ${lastLine.replace(/[.:]$/, "")}.`,
    );
  } else if (
    result.previousHeadCommit !== null &&
    result.previousHeadCommit === result.snapshot.headCommit
  ) {
    parts.push("Hermes was already up to date.");
  } else {
    parts.push(
      result.snapshot.headCommit === undefined
        ? "Hermes updated."
        : `Hermes updated to ${result.snapshot.headCommit}.`,
    );
  }
  if (result.reapplied.length > 0) parts.push(`Reapplied: ${list(result.reapplied)}.`);
  if (result.awaitingPatchUpdate.length > 0) {
    parts.push(`Waiting for a T3 Code update: ${list(result.awaitingPatchUpdate)}.`);
  }
  if (result.notReapplied.length > 0) parts.push(`Not reapplied: ${list(result.notReapplied)}.`);
  return parts.join(" ");
}

/** Why there is nothing to show, or null when the checkout was read. */
export function describeHermesPatchesUnavailable(
  snapshot: HermesPatchesSnapshot,
): { readonly title: string; readonly description: string } | null {
  switch (snapshot.availability) {
    case "ready":
      return null;
    case "providerDisabled":
      return {
        title: "Hermes is not enabled",
        description: "Enable the Hermes provider in this environment to manage its patches.",
      };
    case "hermesNotFound":
      return {
        title: "Hermes was not found",
        description: "The Hermes binary configured for this environment could not be found.",
      };
    case "notGitCheckout":
      return {
        title: "Hermes is not a git checkout",
        description:
          "Patches apply to a git checkout of Hermes. This install came from a package manager or image, so its patches have to come from there.",
      };
  }
}

/**
 * What to say about the Hermes gateway, or null when there is nothing to do:
 * no gateway is running, or it already runs the current code. `restart` says
 * whether to offer the restart button.
 */
export function describeHermesGateway(
  gateway: HermesGatewayStatus | null,
  restartFailure: string | null,
): { readonly tone: "warning" | "info"; readonly text: string; readonly restart: boolean } | null {
  if (gateway === null) {
    // A restart that stopped the gateway and never brought it back. There is
    // nothing left to restart, so the failure itself says how to start it.
    return restartFailure === null
      ? null
      : { tone: "warning", text: `The gateway restart failed: ${restartFailure}`, restart: false };
  }
  if (gateway.state === "restarting") {
    return {
      tone: "info",
      text: "Restarting the Hermes gateway. It finishes the chats, tasks, and webhook runs it is working on first.",
      restart: false,
    };
  }
  if (restartFailure !== null) {
    return {
      tone: "warning",
      text: `The gateway restart failed: ${restartFailure}`,
      restart: gateway.canRestart,
    };
  }
  if (gateway.state === "upToDate") return null;
  if (!gateway.canRestart) {
    return {
      tone: "warning",
      text: "The Hermes gateway is running code from before these changes. It does not run as a service, so restart it where it was started.",
      restart: false,
    };
  }
  return {
    tone: "warning",
    text: "The Hermes gateway is running code from before these changes. Restart it so messaging, scheduled tasks, and webhooks use them.",
    restart: true,
  };
}

/** The server's reason when it gave one, else a generic line. */
export function describeHermesPatchFailure(failure: unknown, fallback: string): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "HermesPatchError" &&
    "detail" in failure &&
    typeof failure.detail === "string"
  ) {
    return failure.detail;
  }
  return fallback;
}
