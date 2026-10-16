import { type ServerSettingsPatch, UsageLimitSourceId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

/** Hubs belong to the environment that connects to them, including remote servers. */
export function EnvironmentHubSettings() {
  const { environments } = useEnvironments();
  return (
    <SettingsSection title="CLIProxyAPI hubs">
      {environments.length === 0 ? (
        <Text className="p-4 text-sm text-foreground-muted">
          Connect an environment to add a hub.
        </Text>
      ) : (
        environments.map((environment) => (
          <EnvironmentHubs key={environment.environmentId} environment={environment} />
        ))
      )}
    </SettingsSection>
  );
}

function EnvironmentHubs({ environment }: { readonly environment: EnvironmentPresentation }) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [managementKey, setManagementKey] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const connected = environment.connection.phase === "connected";
  const supported = environment.serverConfig?.environment.capabilities.usageLimitSources === true;
  const editable = connected && supported;
  const sources = environment.serverConfig?.settings.usageLimitSources ?? {};
  const reset = () => {
    setAdding(false);
    setUrl("");
    setManagementKey("");
    setLabel("");
    setError(null);
  };
  const save = async (patch: ServerSettingsPatch) => {
    if (!editable || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await updateSettings({
        environmentId: environment.environmentId,
        input: { patch },
      });
      if (result._tag === "Success") reset();
      else
        setError(
          "Could not save hub settings. Check your connection and permissions, then try again.",
        );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const add = () => {
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error("Invalid protocol");
    } catch {
      setError("Enter a valid HTTP or HTTPS hub URL.");
      return;
    }
    // Match the web client's stable hub identity so both clients manage the same entry.
    const slug = parsed.host
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const id = UsageLimitSourceId.make(`cliproxy-${slug || "hub"}`);
    if (sources[id]) {
      setError("This hub is already configured. Remove it before adding it with a different key.");
      return;
    }
    if (!managementKey.trim()) return;
    void save({
      usageLimitSources: {
        [id]: {
          kind: "cliproxy",
          url: url.trim(),
          managementKey: managementKey.trim(),
          enabled: true,
          ...(label.trim() ? { label: label.trim() } : {}),
        },
      },
    });
  };
  return (
    <View className="gap-3 p-4">
      <Text className="text-base font-t3-medium text-foreground">{environment.label}</Text>
      {Object.entries(sources).map(([id, source]) => (
        <View key={id} className="gap-1">
          <Text className="text-base text-foreground">{source.label || source.url}</Text>
          <Text className="text-sm text-foreground-muted">
            {source.url}
            {source.enabled ? "" : " · Disabled"}
          </Text>
          {editable ? (
            <HubButton
              label="Remove hub"
              disabled={busy}
              onPress={() =>
                Alert.alert(
                  `Remove ${source.label || source.url}?`,
                  "Its accounts will leave Limits and its management key will be deleted from this environment. You can add it again with its URL and key.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Remove hub",
                      style: "destructive",
                      onPress: () => void save({ usageLimitSources: { [id]: null } }),
                    },
                  ],
                )
              }
            />
          ) : null}
        </View>
      ))}
      {!editable ? (
        <Text className="text-sm text-foreground-muted">
          {!connected
            ? "Connect this environment to manage hubs."
            : !environment.serverConfig
              ? "Loading environment settings…"
              : "Update this environment's server to manage CLIProxyAPI hubs."}
        </Text>
      ) : adding ? (
        <View className="gap-3">
          <Text className="text-sm text-foreground-muted">
            Show limits across the hub's accounts. Use a URL reachable from {environment.label}. The
            management key stays on that server.
          </Text>
          <TextInput
            accessibilityLabel="Hub URL"
            placeholder="https://hub.example.com:8318"
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!busy}
            className="min-h-11 rounded-xl bg-subtle px-3 py-2 text-base"
          />
          <TextInput
            accessibilityLabel="Management key"
            placeholder="Management key"
            value={managementKey}
            onChangeText={setManagementKey}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            editable={!busy}
            className="min-h-11 rounded-xl bg-subtle px-3 py-2 text-base"
          />
          <TextInput
            accessibilityLabel="Label (optional)"
            placeholder="Label (optional)"
            value={label}
            onChangeText={setLabel}
            editable={!busy}
            className="min-h-11 rounded-xl bg-subtle px-3 py-2 text-base"
          />
          <View className="flex-row gap-3">
            <HubButton label="Cancel" disabled={busy} onPress={reset} />
            <HubButton
              label={busy ? "Saving…" : "Add hub"}
              disabled={busy || !url.trim() || !managementKey.trim()}
              onPress={add}
            />
          </View>
        </View>
      ) : (
        <HubButton label="Add hub" disabled={busy} onPress={() => setAdding(true)} />
      )}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-red-500">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function HubButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-11 justify-center self-start rounded-full bg-subtle-strong px-4 py-2 disabled:opacity-50"
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}
