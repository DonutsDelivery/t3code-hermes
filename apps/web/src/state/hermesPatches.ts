/**
 * Everything the Patches tab decides: the latest read of each environment's
 * Hermes checkout, and what applying or removing a patch, or updating Hermes,
 * does afterwards — on one environment, or on every one at once.
 *
 * @module state/hermesPatches
 */
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  describeHermesPatchFailure,
  describeHermesUpdateResult,
} from "@t3tools/client-runtime/state/hermes-patches";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  HermesPatchesSnapshot,
  HermesPatchId,
  HermesPatchState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { useContext, useEffect } from "react";

import { toastManager } from "../components/ui/toast";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

const GATEWAY_RESTART_POLL_MS = 2_000;

const CHANGED_DESCRIPTION =
  "New Hermes sessions pick this up. Running sessions keep what they had.";

export interface HermesPatchWork {
  readonly changing: {
    readonly patchId: HermesPatchId;
    readonly direction: "apply" | "remove";
  } | null;
  readonly updating: boolean;
  /** What the last Update Hermes did, kept as a line in the tab. */
  readonly updateSummary: string | null;
  readonly requestingRestart: boolean;
}

const IDLE_WORK: HermesPatchWork = {
  changing: null,
  updating: false,
  updateSummary: null,
  requestingRestart: false,
};

const IDLE_WORK_ATOM = Atom.make<HermesPatchWork>(IDLE_WORK).pipe(
  Atom.withLabel("web-hermes-patch-work:none"),
);

// Kept alive per environment: work outlives the view that started it, and the
// one-device and all-devices views must both show it.
const patchWorkAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<HermesPatchWork>(IDLE_WORK).pipe(
    Atom.keepAlive,
    Atom.withLabel(`web-hermes-patch-work:${environmentId}`),
  ),
);

const patchesQuery = (environmentId: EnvironmentId) =>
  serverEnvironment.hermesPatches({ environmentId, input: {} });

export const isHermesPatchWorkBusy = (work: HermesPatchWork) =>
  work.changing !== null || work.updating;

const startGatewayPolling = (
  registry: AtomRegistry.AtomRegistry,
  environmentIds: ReadonlyArray<EnvironmentId>,
) => {
  if (environmentIds.length === 0) return;
  // The restart runs on the server after the request returns; re-read until it is done.
  const timer = window.setInterval(() => {
    for (const environmentId of environmentIds) registry.refresh(patchesQuery(environmentId));
  }, GATEWAY_RESTART_POLL_MS);
  return () => window.clearInterval(timer);
};

/**
 * Re-reads the checkout and settles once that read lands. Work stays marked
 * until then, so no button offers to act on the state from before it.
 */
const reread = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
  const query = patchesQuery(environmentId);
  registry.refresh(query);
  return Effect.runPromise(
    AtomRegistry.getResult(registry, query, { suspendOnWaiting: true }).pipe(
      Effect.timeout("30 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
};

/** The actions, per environment. Each re-reads the checkout afterwards: it is the source of truth. */
function useHermesPatchActions() {
  const registry = useContext(RegistryContext);
  const applyCommand = useAtomCommand(serverEnvironment.hermesPatchApply);
  const revertCommand = useAtomCommand(serverEnvironment.hermesPatchRevert);
  const updateCommand = useAtomCommand(serverEnvironment.hermesPatchUpdateHermes);
  const restartCommand = useAtomCommand(serverEnvironment.hermesGatewayRestart);

  const workOf = (environmentId: EnvironmentId) => registry.get(patchWorkAtom(environmentId));
  const setWork = (environmentId: EnvironmentId, next: Partial<HermesPatchWork>) =>
    registry.set(patchWorkAtom(environmentId), { ...workOf(environmentId), ...next });
  const refresh = (environmentId: EnvironmentId) => registry.refresh(patchesQuery(environmentId));

  /** The command's result, or null when other patch work already holds the environment. */
  const change = async (
    environmentId: EnvironmentId,
    patchId: HermesPatchId,
    direction: "apply" | "remove",
  ) => {
    if (isHermesPatchWorkBusy(workOf(environmentId))) return null;
    setWork(environmentId, { changing: { patchId, direction } });
    const command = direction === "apply" ? applyCommand : revertCommand;
    const result = await command({ environmentId, input: { patchId } });
    await reread(registry, environmentId);
    setWork(environmentId, { changing: null });
    return result;
  };

  /** Removes the patches, updates Hermes, and reapplies; the outcome stays as a line in the tab. */
  const updateHermes = async (environmentId: EnvironmentId) => {
    if (isHermesPatchWorkBusy(workOf(environmentId))) return;
    setWork(environmentId, { updating: true, updateSummary: null });
    const result = await updateCommand({ environmentId, input: {} });
    if (result._tag === "Success") {
      setWork(environmentId, { updateSummary: describeHermesUpdateResult(result.value) });
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
    await reread(registry, environmentId);
    setWork(environmentId, { updating: false });
  };

  const restartGateway = async (environmentId: EnvironmentId) => {
    const work = workOf(environmentId);
    const snapshot = Option.getOrNull(AsyncResult.value(registry.get(patchesQuery(environmentId))));
    if (
      isHermesPatchWorkBusy(work) ||
      work.requestingRestart ||
      snapshot?.gateway?.state === "restarting"
    ) {
      return;
    }
    setWork(environmentId, { requestingRestart: true });
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
    await reread(registry, environmentId);
    setWork(environmentId, { requestingRestart: false });
  };

  return { registry, change, updateHermes, restartGateway, refresh };
}

export function useHermesPatches(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(environmentId === null ? null : patchesQuery(environmentId));
  const actions = useHermesPatchActions();
  const work = useAtomValue(environmentId === null ? IDLE_WORK_ATOM : patchWorkAtom(environmentId));
  const restarting = query.data?.gateway?.state === "restarting";
  const { registry } = actions;

  useEffect(
    () =>
      environmentId !== null && restarting
        ? startGatewayPolling(registry, [environmentId])
        : undefined,
    [environmentId, restarting, registry],
  );

  const change = async (patchId: HermesPatchId, direction: "apply" | "remove") => {
    if (environmentId === null) return;
    const result = await actions.change(environmentId, patchId, direction);
    if (result === null) return;
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: direction === "apply" ? "Patch applied" : "Patch removed",
        description: CHANGED_DESCRIPTION,
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
  };

  return {
    environmentId,
    snapshot: query.data,
    isPending: query.isPending && query.data === null,
    error: query.data === null ? query.error : null,
    changingPatchId: work.changing?.patchId ?? null,
    updating: work.updating,
    updateSummary: work.updateSummary,
    busy: isHermesPatchWorkBusy(work),
    refresh: query.refresh,
    updateHermes: () => {
      if (environmentId !== null) void actions.updateHermes(environmentId);
    },
    apply: (patchId: HermesPatchId) => void change(patchId, "apply"),
    remove: (patchId: HermesPatchId) => void change(patchId, "remove"),
    requestingRestart: work.requestingRestart,
    restartGateway: () => {
      if (environmentId !== null) void actions.restartGateway(environmentId);
    },
  };
}

export interface HermesPatchesOnDevice {
  readonly environmentId: EnvironmentId;
  readonly snapshot: HermesPatchesSnapshot | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly work: HermesPatchWork;
}

// Keyed by the id list, like usage's per-window atoms, so every device is read in one subscription.
const patchesEverywhereAtom = Atom.family((environmentIdsKey: string) =>
  Atom.make((get): ReadonlyArray<HermesPatchesOnDevice> =>
    (JSON.parse(environmentIdsKey) as EnvironmentId[]).map((environmentId) => {
      const result = get(patchesQuery(environmentId));
      const snapshot = Option.getOrNull(AsyncResult.value(result));
      return {
        environmentId,
        snapshot,
        isPending: result.waiting && snapshot === null,
        error:
          snapshot === null && result._tag === "Failure"
            ? formatEnvironmentQueryError(result.cause)
            : null,
        work: get(patchWorkAtom(environmentId)),
      };
    }),
  ).pipe(Atom.withLabel(`web-hermes-patches-everywhere:${environmentIdsKey}`)),
);

/** Every device where a patch can move from `from`: applying needs `notApplied`, removing `applied`. */
export function hermesPatchTargets(
  devices: ReadonlyArray<HermesPatchesOnDevice>,
  patchId: HermesPatchId,
  from: HermesPatchState,
): ReadonlyArray<HermesPatchesOnDevice> {
  return devices.filter(
    (device) =>
      device.snapshot?.availability === "ready" &&
      device.snapshot.patches.some((patch) => patch.id === patchId && patch.state === from),
  );
}

/**
 * The same patches on every device at once. A change runs on each device where
 * it fits and is reported once, naming only the devices where it failed.
 */
export function useHermesPatchesEverywhere(
  environmentIds: ReadonlyArray<EnvironmentId>,
  labelOf: (environmentId: EnvironmentId) => string,
) {
  const devices = useAtomValue(patchesEverywhereAtom(JSON.stringify(environmentIds)));
  const actions = useHermesPatchActions();
  const { registry } = actions;
  const restartingKey = JSON.stringify(
    devices
      .filter((device) => device.snapshot?.gateway?.state === "restarting")
      .map((device) => device.environmentId),
  );

  useEffect(
    () => startGatewayPolling(registry, JSON.parse(restartingKey) as EnvironmentId[]),
    [restartingKey, registry],
  );

  const changeEverywhere = async (patchId: HermesPatchId, direction: "apply" | "remove") => {
    const targets = hermesPatchTargets(
      devices,
      patchId,
      direction === "apply" ? "notApplied" : "applied",
    );
    const outcomes = await Promise.all(
      targets.map(async ({ environmentId }) => ({
        environmentId,
        result: await actions.change(environmentId, patchId, direction),
      })),
    );
    const changed = outcomes.filter((outcome) => outcome.result?._tag === "Success").length;
    if (changed > 0) {
      toastManager.add({
        type: "success",
        title: `${direction === "apply" ? "Patch applied" : "Patch removed"} on ${changed} ${
          changed === 1 ? "device" : "devices"
        }`,
        description: CHANGED_DESCRIPTION,
      });
    }
    for (const { environmentId, result } of outcomes) {
      if (result === null || result._tag === "Success" || isAtomCommandInterrupted(result)) {
        continue;
      }
      toastManager.add({
        type: "error",
        title: `${direction === "apply" ? "Patch not applied" : "Patch not removed"} on ${labelOf(environmentId)}`,
        description: describeHermesPatchFailure(
          squashAtomCommandFailure(result),
          "The Hermes checkout could not be changed.",
        ),
      });
    }
  };

  return {
    devices,
    refresh: () => {
      for (const environmentId of environmentIds) actions.refresh(environmentId);
    },
    apply: (patchId: HermesPatchId) => void changeEverywhere(patchId, "apply"),
    remove: (patchId: HermesPatchId) => void changeEverywhere(patchId, "remove"),
    updateHermes: (environmentId: EnvironmentId) => void actions.updateHermes(environmentId),
    restartGateway: (environmentId: EnvironmentId) => void actions.restartGateway(environmentId),
  };
}
