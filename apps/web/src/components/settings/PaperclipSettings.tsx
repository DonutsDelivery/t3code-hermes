/**
 * Paperclip settings — where an environment's Paperclip company lives.
 *
 * The connection row reads what the server actually resolved, including who
 * the key acts as and whether Paperclip lets it write, so it cannot claim a
 * connection the Paperclip surface does not have.
 *
 * @module PaperclipSettings
 */
import { describePaperclipConnection } from "@t3tools/client-runtime/state/paperclip";
import type { EnvironmentId, PaperclipSettings } from "@t3tools/contracts";
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

type PaperclipPatch = { -readonly [K in keyof PaperclipSettings]?: PaperclipSettings[K] };

export function PaperclipSettingsSection() {
  const { environment: selected } = useSettingsScope();
  const connected = selected?.connection.phase === "connected" && selected.serverConfig !== null;

  return (
    <SettingsSection id="paperclip" title="Paperclip">
      {connected ? (
        <PaperclipSettingsControls
          key={selected.environmentId}
          environmentId={selected.environmentId}
        />
      ) : (
        <SettingsRow
          {...searchableSetting("paperclip")}
          description="Connect an environment to set up the Paperclip surface."
        />
      )}
    </SettingsSection>
  );
}

function PaperclipSettingsControls({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const saved = useEnvironmentSettings(
    environmentId,
    (settings) => settings.integrations.paperclip,
  );
  const overviewQuery = useEnvironmentQuery(
    saved.enabled ? serverEnvironment.paperclipOverview({ environmentId, input: {} }) : null,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save Paperclip settings",
  });
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const summary = describePaperclipConnection(overviewQuery.data, { enabled: saved.enabled });
  const savedUrl = saved.baseUrl ?? "";
  const savedCompany = saved.companyId ?? "";
  const hasSavedKey = (saved.apiKey ?? "").length > 0;

  const save = async (patch: PaperclipPatch) => {
    setSaving(true);
    // Atom commands settle into a result instead of rejecting, so cleanup follows the await.
    const saveResult = await updateSettings({
      environmentId,
      input: { patch: { integrations: { paperclip: patch } } },
    });
    if (saveResult._tag === "Success") {
      setApiKeyDraft("");
      overviewQuery.refresh();
    }
    setSaving(false);
  };
  const disabled = saving || !saved.enabled;

  return (
    <>
      <SettingsRow
        {...searchableSetting("paperclip")}
        description="See a Paperclip company's agents, issues, and runs from the Paperclip surface. Read-only: use a board API key from a Paperclip user with the company's viewer role."
        control={
          <Switch
            checked={saved.enabled}
            disabled={saving}
            aria-label="Paperclip"
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
            disabled={!saved.enabled || overviewQuery.isPending}
            onClick={() => overviewQuery.refresh()}
          >
            <RefreshCwIcon />
            Check again
          </Button>
        }
      />
      <SettingsRow
        {...searchableSetting("paperclip-server")}
        description="Paperclip's address as this environment's server reaches it. A trailing /api is fine."
        resetAction={
          savedUrl.length > 0 ? (
            <SettingResetButton
              label="Paperclip server"
              tooltip="Clear"
              onClick={() => void save({ baseUrl: "" })}
            />
          ) : null
        }
        control={
          <DraftInput
            className="w-64"
            size="sm"
            aria-label="Paperclip server URL"
            disabled={disabled}
            placeholder="http://127.0.0.1:3100"
            value={savedUrl}
            onCommit={(next) => {
              if (next.trim() !== savedUrl) void save({ baseUrl: next.trim() });
            }}
          />
        }
      />
      <SettingsRow
        title="API key"
        description="A Paperclip board API key, sent as a bearer token. Stored in this environment's secret store."
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
              aria-label="Paperclip API key"
              disabled={disabled}
              placeholder={hasSavedKey ? "Saved, enter a new key to replace" : "Not set"}
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
      <SettingsRow
        title="Company"
        description="Company ID to show. Empty shows the first company the key belongs to."
        resetAction={
          savedCompany.length > 0 ? (
            <SettingResetButton
              label="Paperclip company"
              tooltip="Use the key's first company"
              onClick={() => void save({ companyId: "" })}
            />
          ) : null
        }
        control={
          <DraftInput
            className="w-64"
            size="sm"
            aria-label="Paperclip company ID"
            disabled={disabled}
            placeholder={overviewQuery.data?.company?.id ?? "First company"}
            value={savedCompany}
            onCommit={(next) => {
              if (next.trim() !== savedCompany) void save({ companyId: next.trim() });
            }}
          />
        }
      />
    </>
  );
}
