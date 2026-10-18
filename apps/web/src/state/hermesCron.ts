import { useAtomValue } from "@effect/atom-react";
import {
  describeHermesCronEmptyState,
  emptyHermesCronView,
  type HermesCronView,
} from "@t3tools/client-runtime/state/hermes-cron";
import { ProviderDriverKind } from "@t3tools/contracts";
import type { EnvironmentId, HermesCronJobId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { deriveProviderInstanceEntries } from "../providerInstances";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

const HERMES_DRIVER_KIND = ProviderDriverKind.make("hermes");

/**
 * Every connected environment with Hermes enabled, primary first.
 *
 * Hermes is a built-in driver, so every environment reports a snapshot for it
 * — disabled by default. Matching on presence alone would list every
 * environment and default to the primary one, never the remote box actually
 * running Hermes.
 */
const hermesEnvironmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const primaryId = get(primaryEnvironmentIdAtom);
  const candidates: EnvironmentId[] = [];
  for (const [environmentId] of get(environmentPresentations.presentationsAtom)) {
    candidates.push(environmentId);
  }
  const ordered =
    primaryId === null ? candidates : [primaryId, ...candidates.filter((id) => id !== primaryId)];

  return ordered.filter((environmentId) => {
    const providers = get(serverEnvironment.configValueAtom(environmentId))?.providers;
    return (
      providers !== undefined &&
      deriveProviderInstanceEntries(providers).some(
        (entry) => entry.driverKind === HERMES_DRIVER_KIND && entry.enabled,
      )
    );
  });
}).pipe(Atom.withLabel("web-hermes-environment-ids"));

/**
 * The environment the Hermes panel opens on and the sidebar watches, or `null`
 * when no connected environment has Hermes enabled.
 *
 * Hermes often lives on an always-on box that is not the environment a browser
 * opened first, so this resolves across every connected environment (primary
 * first, so a local Hermes still wins).
 */
const hermesEnvironmentIdAtom = Atom.make(
  (get): EnvironmentId | null => get(hermesEnvironmentIdsAtom)[0] ?? null,
).pipe(Atom.withLabel("web-hermes-environment-id"));

/**
 * Whether any connected environment has Hermes enabled.
 *
 * Drives the sidebar entry point: with no Hermes there is nothing to schedule,
 * so the button never appears rather than leading to an explanatory page.
 */
export function useHermesEnvironmentId(): EnvironmentId | null {
  return useAtomValue(hermesEnvironmentIdAtom);
}

export function useHermesEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(hermesEnvironmentIdsAtom);
}

export function useHermesEnvironmentEnabled(environmentId: EnvironmentId): boolean {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return (
    config !== null &&
    config !== undefined &&
    deriveProviderInstanceEntries(config.providers).some(
      (entry) => entry.driverKind === HERMES_DRIVER_KIND && entry.enabled,
    )
  );
}

export interface HermesCronState {
  readonly view: HermesCronView;
  readonly environmentId: EnvironmentId | null;
  /** True only before the first snapshot lands — never while one is on screen. */
  readonly isPending: boolean;
  readonly error: string | null;
  readonly emptyState: ReturnType<typeof describeHermesCronEmptyState>;
}

export function useHermesCron(targetEnvironmentId?: EnvironmentId | null) {
  const automaticEnvironmentId = useHermesEnvironmentId();
  // An explicit target must never silently fall back to another host.
  const environmentId =
    targetEnvironmentId === undefined ? automaticEnvironmentId : targetEnvironmentId;
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.hermesCron({ environmentId, input: {} }),
  );
  const view = query.data ?? emptyHermesCronView;
  const state: HermesCronState = {
    view,
    environmentId,
    // A snapshot already on screen outranks a reconnecting subscription: the
    // list stays readable instead of flashing back to a skeleton.
    isPending: query.isPending && view.snapshot === null,
    error: view.snapshot === null ? query.error : null,
    emptyState: describeHermesCronEmptyState(view.snapshot),
  };

  const setEnabledCommand = useAtomCommand(serverEnvironment.hermesCronSetEnabled);
  const setMutedCommand = useAtomCommand(serverEnvironment.hermesCronSetMuted);

  const setEnabled = (jobId: HermesCronJobId, enabled: boolean) => {
    if (environmentId === null) return;
    void setEnabledCommand({ environmentId, input: { jobId, enabled } });
  };

  const setMuted = (jobId: HermesCronJobId, muted: boolean) => {
    if (environmentId === null) return;
    void setMutedCommand({ environmentId, input: { jobId, muted } });
  };

  const jobs = state.view.snapshot?.jobs ?? [];

  return { ...state, jobs, setEnabled, setMuted };
}
