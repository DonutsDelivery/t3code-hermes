/**
 * Patches tab — the fork's patches to Hermes itself, and where each stands in
 * one environment's Hermes checkout, or in every one at once. Decisions live in
 * `state/hermesPatches`.
 */
import {
  describeHermesGateway,
  describeHermesPatchesUnavailable,
  describeHermesPatchHint,
  HERMES_DETACHED_HEAD_WARNING,
  HERMES_PATCH_STATE_LABELS,
  HERMES_UPDATE_DESCRIPTION,
  HERMES_UPDATE_LABEL,
  HERMES_UPDATE_PENDING_LABEL,
  shouldOfferHermesUpdate,
} from "@t3tools/client-runtime/state/hermes-patches";
import type {
  EnvironmentId,
  HermesPatch,
  HermesPatchId,
  HermesPatchState,
} from "@t3tools/contracts";
import { InfoIcon, RefreshCwIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  hermesPatchTargets,
  type HermesPatchesOnDevice,
  isHermesPatchWorkBusy,
  useHermesPatches,
  useHermesPatchesEverywhere,
} from "../../state/hermesPatches";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";

const STATE_BADGE: Record<HermesPatchState, "success" | "info" | "warning"> = {
  applied: "success",
  notApplied: "info",
  doesNotApply: "warning",
};

function PatchRow({
  patch,
  busy,
  disabled,
  updating,
  canUpdateHermes,
  onApply,
  onRemove,
  onUpdateHermes,
}: {
  readonly patch: HermesPatch;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly updating: boolean;
  readonly canUpdateHermes: boolean;
  readonly onApply: () => void;
  readonly onRemove: () => void;
  readonly onUpdateHermes: () => void;
}) {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{patch.title}</p>
          <Badge variant={STATE_BADGE[patch.state]}>{HERMES_PATCH_STATE_LABELS[patch.state]}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Needed for {patch.neededFor}</p>
        <p className="mt-1 text-xs text-muted-foreground">{describeHermesPatchHint(patch)}</p>
      </div>
      {patch.state === "notApplied" ? (
        <Button size="sm" disabled={disabled} onClick={onApply}>
          {busy ? "Applying…" : "Apply"}
        </Button>
      ) : patch.state === "applied" ? (
        <Button size="sm" variant="outline" disabled={disabled} onClick={onRemove}>
          {busy ? "Removing…" : "Remove"}
        </Button>
      ) : patch.reason === "hermesTooOld" && canUpdateHermes ? (
        <Button size="sm" variant="outline" disabled={disabled} onClick={onUpdateHermes}>
          {updating ? HERMES_UPDATE_PENDING_LABEL : HERMES_UPDATE_LABEL}
        </Button>
      ) : null}
    </li>
  );
}

export function HermesPatchesTab({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const {
    snapshot,
    isPending,
    error,
    changingPatchId,
    updating,
    updateSummary,
    busy,
    refresh,
    updateHermes,
    apply,
    remove,
    requestingRestart,
    restartGateway,
  } = useHermesPatches(environmentId);

  if (isPending) {
    return (
      <ul className="flex flex-col gap-2" aria-hidden>
        <li className="rounded-lg border border-border/60 px-3 py-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-1.5 h-4 w-64" />
        </li>
      </ul>
    );
  }

  if (snapshot === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Patches are unavailable</EmptyTitle>
          <EmptyDescription>{error ?? "No environment with Hermes is connected."}</EmptyDescription>
        </EmptyHeader>
        <Button onClick={refresh} variant="ghost">
          <RefreshCwIcon />
          Try again
        </Button>
      </Empty>
    );
  }

  const unavailable = describeHermesPatchesUnavailable(snapshot);
  if (unavailable !== null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{unavailable.title}</EmptyTitle>
          <EmptyDescription>{unavailable.description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const gateway = describeHermesGateway(snapshot.gateway, snapshot.gatewayRestartFailure);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          Hermes checkout: <span className="font-mono">{snapshot.checkoutPath}</span>
        </p>
        <Button size="xs" variant="ghost" disabled={updating} onClick={refresh}>
          <RefreshCwIcon />
          Check again
        </Button>
      </div>
      {shouldOfferHermesUpdate(snapshot) || updating ? (
        <Alert variant="info">
          <InfoIcon />
          <AlertDescription>{HERMES_UPDATE_DESCRIPTION}</AlertDescription>
          <AlertAction>
            <Button size="sm" disabled={busy} onClick={updateHermes}>
              {updating ? HERMES_UPDATE_PENDING_LABEL : HERMES_UPDATE_LABEL}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {updateSummary === null ? null : (
        <p className="text-xs text-muted-foreground" role="status">
          {updateSummary}
        </p>
      )}
      {snapshot.detachedHead ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertDescription>{HERMES_DETACHED_HEAD_WARNING}</AlertDescription>
        </Alert>
      ) : null}
      {gateway !== null ? (
        <Alert variant={gateway.tone}>
          {gateway.tone === "info" ? <InfoIcon /> : <TriangleAlertIcon />}
          <AlertDescription>{gateway.text}</AlertDescription>
          {gateway.restart ? (
            <AlertAction>
              <Button
                size="xs"
                variant="outline"
                disabled={requestingRestart || busy}
                onClick={restartGateway}
              >
                <RotateCwIcon />
                {requestingRestart ? "Restarting…" : "Restart gateway"}
              </Button>
            </AlertAction>
          ) : null}
        </Alert>
      ) : null}
      {snapshot.patches.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This T3 Code release carries no Hermes patches.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {snapshot.patches.map((patch) => (
            <PatchRow
              key={patch.id}
              patch={patch}
              busy={changingPatchId === patch.id}
              disabled={busy}
              updating={updating}
              canUpdateHermes={snapshot.canUpdateHermes === true}
              onApply={() => apply(patch.id)}
              onRemove={() => remove(patch.id)}
              onUpdateHermes={updateHermes}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface DeviceNote {
  readonly environmentId: EnvironmentId;
  readonly kind: string;
  readonly tone: "info" | "warning";
  readonly text: string;
  readonly action: ReactNode;
}

/**
 * The patches on every device at once. Each patch is one row; Apply and Remove
 * act on every device where they fit. What only one device needs (an update,
 * a gateway restart, a checkout that cannot be read) is a note naming it.
 */
export function HermesPatchesEverywhere({
  devices: deviceLabels,
  onShowDevice,
}: {
  readonly devices: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly onShowDevice: (environmentId: EnvironmentId) => void;
}) {
  const labelOf = (environmentId: EnvironmentId) =>
    deviceLabels.find((device) => device.environmentId === environmentId)?.label ?? "a device";
  const { devices, refresh, apply, remove, updateHermes, restartGateway } =
    useHermesPatchesEverywhere(
      deviceLabels.map((device) => device.environmentId),
      labelOf,
    );

  if (devices.every((device) => device.isPending)) {
    return (
      <ul className="flex flex-col gap-2" aria-hidden>
        <li className="rounded-lg border border-border/60 px-3 py-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-1.5 h-4 w-64" />
        </li>
      </ul>
    );
  }

  const showButton = (environmentId: EnvironmentId) => (
    <Button size="xs" variant="outline" onClick={() => onShowDevice(environmentId)}>
      Show device
    </Button>
  );
  const notes = devices.flatMap((device): DeviceNote[] => {
    const { environmentId, snapshot, work } = device;
    if (snapshot === null) {
      return device.error === null
        ? []
        : [
            {
              environmentId,
              kind: "error",
              tone: "warning",
              text: `Patches could not be read. ${device.error}`,
              action: showButton(environmentId),
            },
          ];
    }
    const unavailable = describeHermesPatchesUnavailable(snapshot);
    if (unavailable !== null) {
      return [
        {
          environmentId,
          kind: "unavailable",
          tone: "info",
          text: `${unavailable.title}. ${unavailable.description}`,
          action: showButton(environmentId),
        },
      ];
    }
    const result: DeviceNote[] = [];
    if (shouldOfferHermesUpdate(snapshot) || work.updating) {
      result.push({
        environmentId,
        kind: "update",
        tone: "info",
        text: HERMES_UPDATE_DESCRIPTION,
        action: (
          <Button
            size="xs"
            disabled={isHermesPatchWorkBusy(work)}
            onClick={() => updateHermes(environmentId)}
          >
            {work.updating ? HERMES_UPDATE_PENDING_LABEL : HERMES_UPDATE_LABEL}
          </Button>
        ),
      });
    }
    if (work.updateSummary !== null) {
      result.push({
        environmentId,
        kind: "summary",
        tone: "info",
        text: work.updateSummary,
        action: null,
      });
    }
    if (snapshot.detachedHead) {
      result.push({
        environmentId,
        kind: "detached",
        tone: "warning",
        text: HERMES_DETACHED_HEAD_WARNING,
        action: null,
      });
    }
    const gateway = describeHermesGateway(snapshot.gateway, snapshot.gatewayRestartFailure);
    if (gateway !== null) {
      result.push({
        environmentId,
        kind: "gateway",
        tone: gateway.tone,
        text: gateway.text,
        action: gateway.restart ? (
          <Button
            size="xs"
            variant="outline"
            disabled={work.requestingRestart || isHermesPatchWorkBusy(work)}
            onClick={() => restartGateway(environmentId)}
          >
            <RotateCwIcon />
            {work.requestingRestart ? "Restarting…" : "Restart gateway"}
          </Button>
        ) : null,
      });
    }
    return result;
  });

  // Devices may run different T3 Code releases, so the rows are every patch any of them carries.
  const patches = new Map<HermesPatchId, HermesPatch>();
  for (const device of devices) {
    if (device.snapshot?.availability !== "ready") continue;
    for (const patch of device.snapshot.patches) {
      if (!patches.has(patch.id)) patches.set(patch.id, patch);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          Apply and Remove act on every device where the patch fits.
        </p>
        <Button size="xs" variant="ghost" onClick={refresh}>
          <RefreshCwIcon />
          Check again
        </Button>
      </div>
      {notes.map((note) => (
        <Alert key={`${note.environmentId}:${note.kind}`} variant={note.tone}>
          {note.tone === "info" ? <InfoIcon /> : <TriangleAlertIcon />}
          <AlertDescription>
            <span className="font-medium text-foreground">{labelOf(note.environmentId)}:</span>{" "}
            {note.text}
          </AlertDescription>
          {note.action === null ? null : <AlertAction>{note.action}</AlertAction>}
        </Alert>
      ))}
      {patches.size === 0 ? (
        <p className="text-sm text-muted-foreground">
          No device has a Hermes checkout with patches to show.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {[...patches.values()].map((patch) => (
            <EverywherePatchRow
              key={patch.id}
              patch={patch}
              devices={devices}
              labelOf={labelOf}
              onApply={() => apply(patch.id)}
              onRemove={() => remove(patch.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function EverywherePatchRow({
  patch,
  devices,
  labelOf,
  onApply,
  onRemove,
}: {
  readonly patch: HermesPatch;
  readonly devices: ReadonlyArray<HermesPatchesOnDevice>;
  readonly labelOf: (environmentId: EnvironmentId) => string;
  readonly onApply: () => void;
  readonly onRemove: () => void;
}) {
  const states = devices.flatMap((device) => {
    const onDevice =
      device.snapshot?.availability === "ready"
        ? device.snapshot.patches.find((candidate) => candidate.id === patch.id)
        : undefined;
    return onDevice === undefined ? [] : [{ device, patch: onDevice }];
  });
  const toApply = hermesPatchTargets(devices, patch.id, "notApplied");
  const toRemove = hermesPatchTargets(devices, patch.id, "applied");
  // Apply first, so a patch only some devices have converges to everywhere.
  const direction = toApply.length > 0 ? "apply" : toRemove.length > 0 ? "remove" : null;
  const targets = direction === "apply" ? toApply : toRemove;
  // Devices finish one by one, so the row says what is running, not what the states now suggest.
  const running =
    devices.find((device) => device.work.changing?.patchId === patch.id)?.work.changing ?? null;
  const action = running?.direction ?? direction;
  const blocked = targets.some(({ work }) => isHermesPatchWorkBusy(work));
  const shared = states.every((entry) => entry.patch.state === states[0]?.patch.state)
    ? states[0]?.patch
    : undefined;

  return (
    <li className="flex items-start gap-3 rounded-lg border border-border/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{patch.title}</p>
          {shared === undefined ? null : (
            <Badge variant={STATE_BADGE[shared.state]}>
              {HERMES_PATCH_STATE_LABELS[shared.state]}
            </Badge>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Needed for {patch.neededFor}</p>
        {shared === undefined ? null : (
          <p className="mt-1 text-xs text-muted-foreground">{describeHermesPatchHint(shared)}</p>
        )}
        <ul className="mt-2 flex flex-col gap-1">
          {states.map(({ device, patch: onDevice }) => (
            <li key={device.environmentId} className="flex min-w-0 items-center gap-2 text-xs">
              <span className="min-w-0 truncate text-muted-foreground">
                {labelOf(device.environmentId)}
              </span>
              <Badge variant={STATE_BADGE[onDevice.state]}>
                {HERMES_PATCH_STATE_LABELS[onDevice.state]}
              </Badge>
              {shared === undefined && onDevice.state === "doesNotApply" ? (
                <span className="min-w-0 truncate text-muted-foreground">
                  {describeHermesPatchHint(onDevice)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      {action === null ? null : (
        <Button
          size="sm"
          variant={action === "apply" ? "default" : "outline"}
          disabled={running !== null || blocked}
          onClick={action === "apply" ? onApply : onRemove}
        >
          {running !== null
            ? running.direction === "apply"
              ? "Applying…"
              : "Removing…"
            : targets.length === states.length
              ? action === "apply"
                ? "Apply everywhere"
                : "Remove everywhere"
              : `${action === "apply" ? "Apply on" : "Remove from"} ${targets.length} ${
                  targets.length === 1 ? "device" : "devices"
                }`}
        </Button>
      )}
    </li>
  );
}
