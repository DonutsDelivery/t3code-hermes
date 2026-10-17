/**
 * Everything the Patches tab decides: which environment, the latest read of
 * its Hermes checkout, and what applying or removing a patch, or updating
 * Hermes, does afterwards.
 *
 * @module state/hermesPatches
 */
import {
  describeHermesPatchFailure,
  describeHermesUpdateResult,
} from "@t3tools/client-runtime/state/hermes-patches";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, HermesPatchId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { useHermesEnvironmentId } from "./hermesCron";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

const GATEWAY_RESTART_POLL_MS = 2_000;

/** The record minus one environment's entry. */
const without = <V>(
  record: Partial<Record<EnvironmentId, V>>,
  environmentId: EnvironmentId,
): Partial<Record<EnvironmentId, V>> => {
  const next = { ...record };
  delete next[environmentId];
  return next;
};

export function useHermesPatches() {
  const environmentId = useHermesEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.hermesPatches({ environmentId, input: {} }),
  );
  const applyCommand = useAtomCommand(serverEnvironment.hermesPatchApply);
  const revertCommand = useAtomCommand(serverEnvironment.hermesPatchRevert);
  const updateCommand = useAtomCommand(serverEnvironment.hermesPatchUpdateHermes);
  // Per environment: work can be running in several at once, and switching
  // environments must neither show nor clear another's progress or result.
  const [changing, setChanging] = useState<Partial<Record<EnvironmentId, HermesPatchId>>>({});
  const [updatingIn, setUpdatingIn] = useState<ReadonlySet<EnvironmentId>>(new Set());
  const [summaries, setSummaries] = useState<Partial<Record<EnvironmentId, string>>>({});
  const changingPatchId = environmentId === null ? null : (changing[environmentId] ?? null);
  const updating = environmentId !== null && updatingIn.has(environmentId);
  const updateSummary = environmentId === null ? null : (summaries[environmentId] ?? null);
  const refresh = query.refresh;
  const busy = changingPatchId !== null || updating;
  const restartCommand = useAtomCommand(serverEnvironment.hermesGatewayRestart);
  const [requestingRestart, setRequestingRestart] = useState(false);
  const restarting = query.data?.gateway?.state === "restarting";

  // The restart runs on the server after the request returns; re-read until it is done.
  useEffect(() => {
    if (!restarting) return;
    const timer = window.setInterval(refresh, GATEWAY_RESTART_POLL_MS);
    return () => window.clearInterval(timer);
  }, [restarting, refresh]);

  const restartGateway = async () => {
    if (environmentId === null || busy || requestingRestart || restarting) return;
    setRequestingRestart(true);
    // Atom commands settle into a result instead of rejecting, so cleanup follows the await.
    const result = await restartCommand({ environmentId, input: {} });
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Gateway not restarted",
        description: describeHermesPatchFailure(
          squashAtomCommandFailure(result),
          "The Hermes gateway could not be restarted.",
        ),
      });
    }
    setRequestingRestart(false);
    refresh();
  };

  const change = async (patchId: HermesPatchId, direction: "apply" | "remove") => {
    if (environmentId === null || busy) return;
    setChanging((current) => ({ ...current, [environmentId]: patchId }));
    const command = direction === "apply" ? applyCommand : revertCommand;
    const result = await command({ environmentId, input: { patchId } });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: direction === "apply" ? "Patch applied" : "Patch removed",
        description: "New Hermes sessions pick this up. Running sessions keep what they had.",
      });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: direction === "apply" ? "Patch not applied" : "Patch not removed",
        description: describeHermesPatchFailure(
          squashAtomCommandFailure(result),
          "The Hermes checkout could not be changed.",
        ),
      });
    }
    setChanging((current) => without(current, environmentId));
    // Success or not, the checkout is the source of truth: read it again.
    refresh();
  };

  /** Removes the patches, updates Hermes, and reapplies; the outcome stays as a line in the tab. */
  const updateHermes = async () => {
    if (environmentId === null || busy) return;
    setUpdatingIn((current) => new Set(current).add(environmentId));
    setSummaries((current) => without(current, environmentId));
    const result = await updateCommand({ environmentId, input: {} });
    if (result._tag === "Success") {
      const text = describeHermesUpdateResult(result.value);
      setSummaries((current) => ({ ...current, [environmentId]: text }));
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Hermes not updated",
        description: describeHermesPatchFailure(
          squashAtomCommandFailure(result),
          "Hermes could not be updated.",
        ),
      });
    }
    setUpdatingIn((current) => {
      const next = new Set(current);
      next.delete(environmentId);
      return next;
    });
    refresh();
  };

  return {
    environmentId,
    snapshot: query.data,
    isPending: query.isPending && query.data === null,
    error: query.data === null ? query.error : null,
    changingPatchId,
    updating,
    updateSummary,
    busy,
    refresh,
    updateHermes: () => void updateHermes(),
    apply: (patchId: HermesPatchId) => void change(patchId, "apply"),
    remove: (patchId: HermesPatchId) => void change(patchId, "remove"),
    requestingRestart,
    restartGateway: () => void restartGateway(),
  };
}
