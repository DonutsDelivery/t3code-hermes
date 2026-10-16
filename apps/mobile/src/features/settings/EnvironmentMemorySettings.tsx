import { useAtomValue } from "@effect/atom-react";
import { describeHindsightConnection } from "@t3tools/client-runtime/state/hindsight";
import type { EnvironmentId, HindsightSettings } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

type HindsightPatch = { -readonly [K in keyof HindsightSettings]?: HindsightSettings[K] };

const INPUT_CLASS = "min-h-11 rounded-xl bg-subtle px-3 py-2 text-base";

/**
 * The environment's Hindsight connection, mirroring the web Memory settings:
 * every field overrides Hermes' own Hindsight config, and an empty field
 * hands that field back to Hermes.
 */
export function EnvironmentMemorySettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const saved = useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.integrations
    .hindsight;
  const banksQuery = useEnvironmentQuery(
    serverEnvironment.hindsightBanks({ environmentId, input: {} }),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save Memory settings",
  });
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [bankDraft, setBankDraft] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);

  if (saved === undefined) return null;

  const hermes = banksQuery.data?.hermes ?? null;
  const summary = describeHindsightConnection(banksQuery.data, { enabled: saved.enabled });
  const savedUrl = saved.baseUrl ?? "";
  const savedBank = saved.defaultBank ?? "";
  const hasSavedKey = (saved.apiKey ?? "").length > 0;
  const usesHermesKey = savedUrl.length === 0 && !hasSavedKey && hermes?.hasApiKey === true;
  const editable = saved.enabled && !saving;

  const save = async (patch: HindsightPatch) => {
    setSaving(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { integrations: { hindsight: patch } } },
      });
      if (result._tag === "Success") {
        setUrlDraft(null);
        setBankDraft(null);
        setApiKeyDraft("");
        banksQuery.refresh();
      }
    } finally {
      setSaving(false);
    }
  };
  const commit = (field: "baseUrl" | "defaultBank", draft: string | null, current: string) => {
    if (draft !== null && draft.trim() !== current) void save({ [field]: draft.trim() });
  };

  return (
    <SettingsSection title="Memory">
      <SettingsSwitchRow
        icon="brain"
        label="Hindsight memory"
        subtitle={summary.detail === null ? summary.label : `${summary.label} · ${summary.detail}`}
        disabled={saving}
        value={saved.enabled}
        onValueChange={(enabled) => void save({ enabled })}
      />
      <View className="gap-3 px-4 pb-4">
        <Text className="text-sm text-foreground-muted">
          {hermes === null
            ? "Hermes has no Hindsight config here. Enter the server this environment should use."
            : "Empty fields use Hermes' Hindsight config."}
        </Text>
        <TextInput
          accessibilityLabel="Hindsight server URL"
          placeholder={hermes?.baseUrl ?? "http://127.0.0.1:8888"}
          value={urlDraft ?? savedUrl}
          onChangeText={setUrlDraft}
          onEndEditing={() => commit("baseUrl", urlDraft, savedUrl)}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={editable}
          className={INPUT_CLASS}
        />
        <TextInput
          accessibilityLabel="Default bank"
          placeholder={hermes?.bank ?? "Default bank"}
          value={bankDraft ?? savedBank}
          onChangeText={setBankDraft}
          onEndEditing={() => commit("defaultBank", bankDraft, savedBank)}
          autoCapitalize="none"
          autoCorrect={false}
          editable={editable}
          className={INPUT_CLASS}
        />
        <View className="flex-row items-center gap-3">
          <TextInput
            accessibilityLabel="Hindsight API key"
            placeholder={
              hasSavedKey ? "Saved API key" : usesHermesKey ? "Using Hermes' key" : "API key"
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
              onPress={() => void save({ apiKey: apiKeyDraft.trim() })}
            />
          ) : hasSavedKey ? (
            <MemoryButton
              label="Remove"
              disabled={!editable}
              onPress={() => void save({ apiKey: "" })}
            />
          ) : null}
        </View>
        {savedUrl.length > 0 || savedBank.length > 0 ? (
          <MemoryButton
            label={hermes === null ? "Clear server and bank" : "Use Hermes' config"}
            disabled={!editable}
            onPress={() => void save({ baseUrl: "", defaultBank: "" })}
          />
        ) : null}
      </View>
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
