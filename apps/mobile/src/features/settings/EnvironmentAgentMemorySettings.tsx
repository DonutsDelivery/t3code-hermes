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
import type { HindsightAgentMemoryState, HindsightSettings } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { canMaintainEnvironment } from "./environment-maintenance";

type HindsightPatch = { -readonly [K in keyof HindsightSettings]?: HindsightSettings[K] };

const INPUT_CLASS = "min-h-11 rounded-xl bg-subtle px-3 py-2 text-base";

interface Machine extends HindsightHandoffMachine {
  readonly environment: EnvironmentPresentation;
  /** Its connection is being read again; until then its server may be stale. */
  readonly refreshing: boolean;
  readonly writable: boolean;
  readonly saved: HindsightSettings;
  readonly hasServer: boolean | null;
  readonly serverUrl: string | null;
  readonly state: HindsightAgentMemoryState | null;
  readonly summary: HindsightAgentMemorySummary;
  readonly unsupported: boolean;
}

function machineStatus(machine: Machine): string {
  if (!machine.writable) return "No access from this device";
  if (machine.unsupported) return "Update T3 Code on this machine";
  const { summary } = machine;
  if (summary.label !== null) {
    return summary.detail === null ? summary.label : `${summary.label} · ${summary.detail}`;
  }
  if (summary.agents.length === 0) return "Checking…";
  return summary.agents.map((agent) => agent.text).join(" · ");
}

/**
 * Hindsight for every agent, mirroring the web Providers settings: one switch
 * over every connected environment. Each one wires its own agents; one that
 * has no Hindsight server yet is handed the shared one on the way.
 */
export function EnvironmentAgentMemorySettings() {
  const { environments } = useEnvironments();
  const connected = useMemo(
    () =>
      environments.filter(
        (environment) =>
          environment.connection.phase === "connected" && environment.serverConfig !== null,
      ),
    [environments],
  );
  const machines = useAtomValue(
    useMemo(
      () =>
        Atom.make((get): ReadonlyArray<Machine> =>
          connected.map((environment) => {
            const { environmentId } = environment;
            const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
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
              writable:
                !AsyncResult.isFailure(sessionResult) &&
                canMaintainEnvironment(
                  Option.getOrNull(AsyncResult.value(sessionResult)) ?? null,
                  true,
                ),
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
              unsupported: state === null && memoryResult._tag === "Failure",
            };
          }),
        ),
      [connected],
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
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
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
  const handoff = planHindsightServerHandoff({ url: savedUrl, hasKey: hasSavedKey }, machines);
  const statusLabel = describeHindsightKeyWait(writable, handoff) ?? overall.label;
  // Keys are routed by each machine's server, so nothing is written while one is stale.
  const busy =
    saving || machines.some((machine) => machine.state?.applying === true || machine.refreshing);
  const checking = writable.some((machine) => machine.hasServer === null);
  const editable = overall.canToggle && !busy;

  const writeAll = async (patchFor: (machine: Machine) => HindsightPatch | null) => {
    setSaving(true);
    try {
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
      setUrlDraft(null);
      setApiKeyDraft("");
    } finally {
      setSaving(false);
    }
  };

  // A machine without a server is handed the shared one, and a key entered
  // here also finishes the machines that were waiting for it. Each machine's
  // server and key move together; see `hindsightSharedPatch`.
  const writeShared = (write: HindsightSharedWrite) =>
    writeAll((machine) => hindsightSharedPatch(machine, handoff, write));
  const setEnabled = (agentMemory: boolean) => writeShared({ kind: "switch", agentMemory });
  const saveApiKey = (apiKey: string) => writeShared({ kind: "apiKey", apiKey });
  const saveServer = (url: string) => writeShared({ kind: "server", url });

  return (
    <SettingsSection title="Memory">
      <SettingsSwitchRow
        icon="brain"
        label="Hindsight for every agent"
        {...(statusLabel === null ? {} : { subtitle: statusLabel })}
        disabled={!editable || checking}
        value={overall.checked}
        onValueChange={(next) => void setEnabled(next || overall.mixed)}
      />
      <View className="gap-3 px-4 pb-4">
        <Text className="text-sm text-foreground-muted">
          Gives Claude Code, Codex, and Hermes on every connected environment long-term memory in
          one Hindsight server. Turning it off removes only what T3 Code added.
        </Text>
        {machines.map((machine) => (
          <Text
            key={machine.environment.environmentId}
            selectable
            className={
              machine.summary.tone === "attention" && machine.writable
                ? "text-sm text-danger-foreground"
                : "text-sm text-foreground-muted"
            }
          >
            <Text className="text-sm font-t3-medium text-foreground">
              {machine.environment.label}
            </Text>
            {` · ${machineStatus(machine)}`}
          </Text>
        ))}
        <TextInput
          accessibilityLabel="Hindsight server URL"
          placeholder={
            shared.urlsDiffer ? "Differs per machine" : (resolvedUrl ?? "http://127.0.0.1:8888")
          }
          value={urlDraft ?? savedUrl}
          onChangeText={setUrlDraft}
          onEndEditing={() => {
            if (urlDraft !== null && urlDraft.trim() !== savedUrl) {
              void saveServer(urlDraft.trim());
            }
          }}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={editable}
          className={INPUT_CLASS}
        />
        {shared.hasOverride ? (
          <MemoryButton
            label="Use each machine's own server"
            disabled={!editable}
            onPress={() => void saveServer("")}
          />
        ) : null}
        <View className="flex-row items-center gap-3">
          <TextInput
            accessibilityLabel="Hindsight API key"
            placeholder={
              hasSavedKey
                ? "Saved API key"
                : shared.keysElsewhere
                  ? "Saved on some machines"
                  : "API key (optional)"
            }
            value={apiKeyDraft}
            onChangeText={setApiKeyDraft}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            editable={editable}
            className={`${INPUT_CLASS} flex-1`}
          />
          {apiKeyDraft.trim().length > 0 ? (
            <MemoryButton
              label="Save"
              disabled={!editable}
              onPress={() => void saveApiKey(apiKeyDraft.trim())}
            />
          ) : hasSavedKey || shared.keysElsewhere ? (
            <MemoryButton
              label={shared.keysElsewhere ? "Remove everywhere" : "Remove"}
              disabled={!editable}
              onPress={() =>
                void (shared.keysElsewhere ? writeShared({ kind: "clearKeys" }) : saveApiKey(""))
              }
            />
          ) : null}
        </View>
      </View>
      {writable
        // Also while switched off: cleanup that failed is retried the same way.
        .filter((machine) => machine.summary.retryable)
        .map((machine) => (
          <SettingsActionRow
            key={machine.environment.environmentId}
            icon="arrow.clockwise"
            label={`Retry on ${machine.environment.label}`}
            disabled={busy}
            loading={machine.state?.applying === true}
            onPress={() =>
              void apply({ environmentId: machine.environment.environmentId, input: {} })
            }
          />
        ))}
    </SettingsSection>
  );
}

function MemoryButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={`min-h-11 items-center justify-center rounded-full bg-subtle px-4 ${props.disabled ? "opacity-50" : ""}`}
    >
      <Text className="text-sm font-t3-semibold text-foreground">{props.label}</Text>
    </Pressable>
  );
}
