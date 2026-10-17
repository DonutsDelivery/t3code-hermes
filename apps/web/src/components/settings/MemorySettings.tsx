/**
 * Memory settings — where an environment's Hindsight connection comes from.
 *
 * With nothing set here, the environment uses the Hermes install's own
 * Hindsight config, so these rows are overrides: a filled field wins over
 * Hermes for that field alone, and clearing it hands the field back. The
 * connection row reads what the server actually resolved rather than what the
 * fields say, so it cannot claim a connection the Memory tab does not have.
 *
 * @module MemorySettings
 */
import { describeHindsightConnection } from "@t3tools/client-runtime/state/hindsight";
import type { EnvironmentId, HindsightSettings } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

/** Hindsight's own default, shown when Hermes has nothing to suggest. */
const HINDSIGHT_URL_PLACEHOLDER = "http://127.0.0.1:8888";

type HindsightPatch = { -readonly [K in keyof HindsightSettings]?: HindsightSettings[K] };

export function MemorySettingsSection() {
  const { environment: selected } = useSettingsScope();
  const connected = selected?.connection.phase === "connected" && selected.serverConfig !== null;

  return (
    <SettingsSection id="memory" title="Memory">
      {connected ? (
        <MemorySettingsControls
          key={selected.environmentId}
          environmentId={selected.environmentId}
        />
      ) : (
        <SettingsRow
          {...searchableSetting("memory")}
          description="Connect an environment to set up the Hermes panel's Memory tab."
        />
      )}
    </SettingsSection>
  );
}

function MemorySettingsControls({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const saved = useEnvironmentSettings(
    environmentId,
    (settings) => settings.integrations.hindsight,
  );
  const banksQuery = useEnvironmentQuery(
    serverEnvironment.hindsightBanks({ environmentId, input: {} }),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save Memory settings",
  });
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const result = banksQuery.data;
  const hermes = result?.hermes ?? null;
  const summary = describeHindsightConnection(result, { enabled: saved.enabled });
  const savedUrl = saved.baseUrl ?? "";
  const savedBank = saved.defaultBank ?? "";
  const hasSavedKey = (saved.apiKey ?? "").length > 0;
  // Hermes' key only goes to Hermes' URL, so it only counts while that URL is in use.
  const usesHermesKey = savedUrl.length === 0 && !hasSavedKey && hermes?.hasApiKey === true;

  const save = async (patch: HindsightPatch) => {
    setSaving(true);
    // Atom commands settle into a result instead of rejecting, so cleanup follows the await.
    const saveResult = await updateSettings({
      environmentId,
      input: { patch: { integrations: { hindsight: patch } } },
    });
    if (saveResult._tag === "Success") {
      setApiKeyDraft("");
      // The server resolves the connection on the next read; ask it now.
      banksQuery.refresh();
    }
    setSaving(false);
  };

  const fromHermes =
    hermes === null
      ? null
      : `Empty uses Hermes' ${hermes.configPath === null ? "HINDSIGHT_* variables" : hermes.configPath}.`;
  const disabled = saving || !saved.enabled;

  return (
    <>
      <SettingsRow
        {...searchableSetting("memory")}
        description="Browse and search what Hermes remembers from the Memory tab of the Hermes panel. Uses Hermes' own Hindsight config unless you set a server below."
        control={
          <Switch
            checked={saved.enabled}
            disabled={saving}
            aria-label="Memory"
            onCheckedChange={(checked) => void save({ enabled: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        title="Connection"
        status={
          <span className="flex min-w-0 items-center gap-2 text-xs">
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                summary.tone === "ready"
                  ? "bg-success"
                  : summary.tone === "attention"
                    ? "bg-warning"
                    : "bg-muted-foreground/40",
              )}
            />
            <span className="font-medium text-foreground">{summary.label}</span>
            {summary.detail === null ? null : (
              <span className="min-w-0 truncate text-muted-foreground">{summary.detail}</span>
            )}
          </span>
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!saved.enabled || banksQuery.isPending}
            onClick={() => banksQuery.refresh()}
          >
            <RefreshCwIcon />
            Check again
          </Button>
        }
      />
      <SettingsRow
        {...searchableSetting("memory-server")}
        description={
          fromHermes === null
            ? "Hindsight's API, as seen from this environment's server."
            : `Hindsight's API, as seen from this environment's server. ${fromHermes}`
        }
        resetAction={
          savedUrl.length > 0 ? (
            <SettingResetButton
              label="Hindsight server"
              tooltip={hermes === null ? "Clear" : "Use Hermes' config"}
              onClick={() => void save({ baseUrl: "" })}
            />
          ) : null
        }
        control={
          <DraftInput
            className="w-64"
            size="sm"
            aria-label="Hindsight server URL"
            disabled={disabled}
            placeholder={hermes?.baseUrl ?? HINDSIGHT_URL_PLACEHOLDER}
            value={savedUrl}
            onCommit={(next) => {
              if (next.trim() !== savedUrl) void save({ baseUrl: next.trim() });
            }}
          />
        }
      />
      <SettingsRow
        title="Default bank"
        description="Preselected in the Memory tab's bank picker."
        resetAction={
          savedBank.length > 0 ? (
            <SettingResetButton
              label="default bank"
              tooltip={hermes?.bank ? "Use Hermes' bank" : "Clear"}
              onClick={() => void save({ defaultBank: "" })}
            />
          ) : null
        }
        control={
          <DraftInput
            className="w-64"
            size="sm"
            aria-label="Default bank"
            disabled={disabled}
            placeholder={hermes?.bank ?? "First bank Hindsight lists"}
            value={savedBank}
            onCommit={(next) => {
              if (next.trim() !== savedBank) void save({ defaultBank: next.trim() });
            }}
          />
        }
      />
      <SettingsRow
        title="API key"
        description="Sent as a bearer token. Hermes' key is only ever sent to Hermes' server."
        control={
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const next = apiKeyDraft.trim();
              if (next.length > 0) void save({ apiKey: next });
            }}
          >
            <Input
              className="w-64"
              type="password"
              autoComplete="off"
              size="sm"
              aria-label="Hindsight API key"
              disabled={disabled}
              placeholder={
                hasSavedKey
                  ? "Saved, enter a new key to replace"
                  : usesHermesKey
                    ? "Using Hermes' key"
                    : "Not set"
              }
              value={apiKeyDraft}
              onChange={(event) => setApiKeyDraft(event.target.value)}
            />
            {hasSavedKey && apiKeyDraft.length === 0 ? (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => void save({ apiKey: "" })}
              >
                Remove
              </Button>
            ) : (
              <Button
                type="submit"
                size="sm"
                disabled={disabled || apiKeyDraft.trim().length === 0}
              >
                Save
              </Button>
            )}
          </form>
        }
      />
    </>
  );
}
