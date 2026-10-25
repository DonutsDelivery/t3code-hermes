/**
 * One switch over every connected machine for `integrations.hindsight.agentMemory`. A machine
 * without a Hindsight server is handed the shared one, unless it needs an API key this client never
 * sees. The server and key rows write to every machine too.
 */
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  describeHindsightAgentMemory,
  describeHindsightKeyWait,
  hindsightSharedPatch,
  planHindsightServerHandoff,
  summarizeHindsightMachines,
  summarizeHindsightSharedSettings,
  type HindsightAgentMemorySummary,
  type HindsightHandoffMachine,
  type HindsightSharedWrite,
} from "@t3tools/client-runtime/state/hindsight";
import {
  type EnvironmentId,
  type HindsightAgentMemoryState,
  type HindsightSettings,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { RefreshCwIcon } from "lucide-react";
import { useContext, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { primarySessionStateAtom } from "../../environments/primary/sessionState";
import { cn } from "../../lib/utils";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Hindsight's own default, shown when no machine has a server yet. */
const HINDSIGHT_URL_PLACEHOLDER = "http://127.0.0.1:8888";

type HindsightPatch = { -readonly [K in keyof HindsightSettings]?: HindsightSettings[K] };

interface Machine extends HindsightHandoffMachine {
  readonly environment: EnvironmentPresentation;
  /** Its connection is being read again; until then its server may be stale. */
  readonly refreshing: boolean;
  readonly writable: boolean;
  readonly saved: HindsightSettings;
  /** Null until the machine has said whether it resolves a server. */
  readonly hasServer: boolean | null;
  /** The server it resolved, credentials removed, for the shared placeholder. */
  readonly serverUrl: string | null;
  /** Its agent memory state, or null until it has answered. */
  readonly state: HindsightAgentMemoryState | null;
  readonly summary: HindsightAgentMemorySummary;
  readonly applying: boolean;
  /** The machine predates agent memory and rejects the subscription. */
  readonly unsupported: boolean;
}

function ToneDot({ tone }: { readonly tone: "ready" | "attention" | "idle" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        tone === "ready"
          ? "bg-success"
          : tone === "attention"
            ? "bg-warning"
            : "bg-muted-foreground/40",
      )}
    />
  );
}

/** What a machine's row says after its name. */
function machineStatus(machine: Machine): {
  readonly text: string;
  readonly tone: Machine["summary"]["tone"];
} {
  if (!machine.writable) return { text: "No access from this device", tone: "idle" };
  if (machine.unsupported) return { text: "Update T3 Code on this machine", tone: "attention" };
  const { summary } = machine;
  if (summary.label !== null) {
    return {
      text: summary.detail === null ? summary.label : `${summary.label} · ${summary.detail}`,
      tone: summary.tone,
    };
  }
  if (summary.agents.length === 0) return { text: "Checking…", tone: "idle" };
  return { text: summary.agents.map((agent) => agent.text).join(" · "), tone: summary.tone };
}

export function HindsightAgentMemorySettings() {
  const { environments } = useEnvironments();
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const machines = useAtomValue(
    Atom.make((get): ReadonlyArray<Machine> =>
      connected.map((environment) => {
        const { environmentId } = environment;
        const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
        const sessionResult = isPrimary
          ? get(primarySessionStateAtom)
          : get(environmentSession.sessionStateAtom(environmentId));
        const access = {
          session: Option.getOrNull(AsyncResult.value(sessionResult)),
          isPending: sessionResult.waiting,
          hasError: sessionResult._tag === "Failure",
        };
        const operate = isPrimary
          ? resolvePrimaryOperateAccess({ ...access, isPrimary, hasDesktopBridge: isElectron })
          : resolveRemoteOperateAccess(access);
        const saved =
          get(serverEnvironment.settingsValueAtom(environmentId))?.integrations.hindsight ??
          environment.serverConfig!.settings.integrations.hindsight;
        const banksResult = get(serverEnvironment.hindsightBanks({ environmentId, input: {} }));
        const banks = Option.getOrNull(AsyncResult.value(banksResult));
        const memoryResult = get(
          serverEnvironment.hindsightAgentMemory({ environmentId, input: {} }),
        );
        const state = Option.getOrNull(AsyncResult.value(memoryResult));
        const connection = banks?.connection;
        return {
          environment,
          writable: operate === "granted",
          saved,
          enabled: saved.agentMemory,
          refreshing: banksResult.waiting,
          hasServer: connection === undefined ? null : connection !== null,
          serverUrl: connection?.baseUrl ?? null,
          savedUrl: saved.baseUrl ?? "",
          hasSavedKey: (saved.apiKey ?? "").length > 0,
          serverHasKey: connection?.hasApiKey === true,
          state,
          summary: describeHindsightAgentMemory(state, { enabled: saved.agentMemory }),
          applying: state?.applying === true,
          unsupported: state === null && memoryResult._tag === "Failure",
        };
      }),
    ),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save Hindsight agent memory",
  });
  const apply = useAtomCommand(serverEnvironment.applyHindsightAgentMemory, {
    label: "apply Hindsight agent memory",
  });
  const registry = useContext(RegistryContext);
  const [saving, setSaving] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");

  const writable = machines.filter((machine) => machine.writable && !machine.unsupported);
  const overall = summarizeHindsightMachines(
    machines.map((machine) => ({
      enabled: machine.saved.agentMemory,
      writable: machine.writable && !machine.unsupported,
      state: machine.state,
    })),
  );
  // The shared fields speak for every machine they write to.
  const shared = summarizeHindsightSharedSettings(writable);
  const savedUrl = shared.url;
  const hasSavedKey = shared.hasKey;
  const resolvedUrl = machines.find((machine) => machine.serverUrl !== null)?.serverUrl ?? null;
  // What a machine without a server is handed: the shared override, else the
  // server some other machine already resolved (usually from Hermes).
  const handoff = planHindsightServerHandoff({ url: savedUrl, hasKey: hasSavedKey }, machines);
  const keyWait = describeHindsightKeyWait(writable, handoff);
  const statusLabel = keyWait ?? overall.label;
  const statusTone = keyWait === null ? overall.tone : "attention";
  // Keys are routed by each machine's server, so nothing is written while one is stale.
  const busy = saving || machines.some((machine) => machine.applying || machine.refreshing);
  const checking = writable.some((machine) => machine.hasServer === null);

  const writeAll = async (patchFor: (machine: Machine) => HindsightPatch | null) => {
    setSaving(true);
    // Atom commands settle into a result instead of rejecting, so cleanup follows the await.
    await Promise.all(
      writable.flatMap((machine) => {
        const patch = patchFor(machine);
        return patch === null
          ? []
          : [
              updateSettings({
                environmentId: machine.environment.environmentId,
                input: { patch: { integrations: { hindsight: patch } } },
              }),
            ];
      }),
    );
    // The server answers from its new settings on the next read; read now.
    for (const machine of writable) {
      registry.refresh(
        serverEnvironment.hindsightBanks({
          environmentId: machine.environment.environmentId,
          input: {},
        }),
      );
    }
    setApiKeyDraft("");
    setSaving(false);
  };

  // A machine without a server is handed the shared one, and a key entered
  // here also finishes the machines that were waiting for it. Each machine's
  // server and key move together; see `hindsightSharedPatch`.
  const writeShared = (write: HindsightSharedWrite) =>
    writeAll((machine) => hindsightSharedPatch(machine, handoff, write));
  const setEnabled = (agentMemory: boolean) => writeShared({ kind: "switch", agentMemory });
  const saveApiKey = (apiKey: string) => writeShared({ kind: "apiKey", apiKey });
  const saveServer = (url: string) => writeShared({ kind: "server", url });

  const retry = (environmentId: EnvironmentId) => void apply({ environmentId, input: {} });

  return (
    <SettingsSection title="Memory">
      <SettingsRow
        {...searchableSetting("agent-memory")}
        description="Give Claude Code, Codex, and Hermes on every connected machine long-term memory in one Hindsight server. Each machine wires its own agents; turning it off removes only what T3 Code added."
        status={
          statusLabel === null ? undefined : (
            <span className="flex min-w-0 items-center gap-2 text-xs">
              <ToneDot tone={statusTone} />
              <span className="font-medium text-foreground">{statusLabel}</span>
            </span>
          )
        }
        control={
          <Switch
            checked={overall.checked}
            mixed={overall.mixed}
            disabled={!overall.canToggle || busy || checking}
            aria-label="Hindsight for every agent"
            onCheckedChange={(checked) => void setEnabled(Boolean(checked) || overall.mixed)}
          />
        }
      >
        {machines.length === 0 ? null : (
          <ul className="mt-3 flex flex-col gap-1.5 text-xs">
            {machines.map((machine) => {
              const status = machineStatus(machine);
              // Also while switched off: cleanup that failed is retried the same way.
              const canRetry =
                machine.writable && !machine.unsupported && machine.summary.retryable;
              return (
                <li
                  key={machine.environment.environmentId}
                  className="flex min-h-6 min-w-0 items-center gap-2"
                >
                  <ToneDot tone={status.tone} />
                  <EnvironmentMachineIcon
                    kind={resolveEnvironmentMachineKind(machine.environment.serverConfig)}
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="shrink-0 font-medium text-foreground">
                    {machine.environment.label}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">{status.text}</span>
                  {canRetry ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      disabled={busy}
                      onClick={() => retry(machine.environment.environmentId)}
                    >
                      <RefreshCwIcon />
                      Retry
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </SettingsRow>
      <SettingsRow
        title="Hindsight server"
        description={
          resolvedUrl === null
            ? "Every connected machine sends its agents' memory here. Each machine must be able to reach it."
            : "Every connected machine sends its agents' memory here. Empty keeps each machine's own server."
        }
        resetAction={
          shared.hasOverride ? (
            <SettingResetButton
              label="Hindsight server"
              tooltip="Use each machine's own server"
              onClick={() => void saveServer("")}
            />
          ) : null
        }
        control={
          <DraftInput
            className="w-64"
            size="sm"
            aria-label="Hindsight server URL"
            disabled={!overall.canToggle || busy}
            placeholder={
              shared.urlsDiffer ? "Differs per machine" : (resolvedUrl ?? HINDSIGHT_URL_PLACEHOLDER)
            }
            value={savedUrl}
            onCommit={(next) => {
              if (next.trim() !== savedUrl) void saveServer(next.trim());
            }}
          />
        }
      />
      <SettingsRow
        title="API key"
        description="Sent as a bearer token by every machine on that server, never to another one. Leave empty for an open instance."
        control={
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const next = apiKeyDraft.trim();
              if (next.length > 0) void saveApiKey(next);
            }}
          >
            <Input
              className="w-64"
              type="password"
              autoComplete="off"
              size="sm"
              aria-label="Hindsight API key"
              disabled={!overall.canToggle || busy}
              placeholder={
                hasSavedKey
                  ? "Saved, enter a new key to replace"
                  : shared.keysElsewhere
                    ? "Saved on some machines"
                    : "Not set"
              }
              value={apiKeyDraft}
              onChange={(event) => setApiKeyDraft(event.target.value)}
            />
            {(hasSavedKey || shared.keysElsewhere) && apiKeyDraft.length === 0 ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!overall.canToggle || busy}
                onClick={() =>
                  void (shared.keysElsewhere ? writeShared({ kind: "clearKeys" }) : saveApiKey(""))
                }
              >
                {shared.keysElsewhere ? "Remove everywhere" : "Remove"}
              </Button>
            ) : (
              <Button
                type="submit"
                size="sm"
                disabled={!overall.canToggle || busy || apiKeyDraft.trim().length === 0}
              >
                Save
              </Button>
            )}
          </form>
        }
      />
    </SettingsSection>
  );
}
