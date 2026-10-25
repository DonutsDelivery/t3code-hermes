/**
 * Pinned threads that collect Hermes gateway conversations from the Discord channels each hub
 * names. Saved whole because settings deep-merge replaces arrays.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type HermesHubSettings,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useThreadActions } from "~/hooks/useThreadActions";
import { newThreadId } from "~/lib/utils";
import { resolveAppModelSelectionState } from "~/modelSelection";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

export function HermesHubsSettingsSection() {
  const { environment: selected } = useSettingsScope();
  const connected = selected?.connection.phase === "connected" && selected.serverConfig !== null;

  return (
    <SettingsSection id="hermes-hubs" title="External thread hubs">
      {connected ? (
        <HermesHubsControls key={selected.environmentId} environmentId={selected.environmentId} />
      ) : (
        <SettingsRow
          {...searchableSetting("hermes-hubs")}
          description="Connect an environment to set up thread hubs for Hermes conversations."
        />
      )}
    </SettingsSection>
  );
}

/** Channel ids from free text: commas, spaces, or newlines between them. */
function parseHubChannels(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter((channel) => channel.length > 0))];
}

function nextHubId(hubs: readonly HermesHubSettings[]): string {
  const taken = new Set(hubs.map((hub) => hub.id));
  let index = hubs.length + 1;
  while (taken.has(`hub-${index}`)) index += 1;
  return `hub-${index}`;
}

function HermesHubsControls({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const hubs = useEnvironmentSettings(
    environmentId,
    (settings) => settings.integrations.hermesHubs,
  );
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save Hermes hubs",
  });
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const { pinThread } = useThreadActions();
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  // Hub threads land in a project the user picks; guessing one put them in unrelated projects.
  const [projectByHub, setProjectByHub] = useState<Record<string, ProjectId>>({});
  const projectFor = (hub: HermesHubSettings) => {
    const picked = projectByHub[hub.id];
    if (picked !== undefined) return projects.find((project) => project.id === picked);
    const hubName = hub.name.trim().toLowerCase();
    return projects.find((project) => project.title.trim().toLowerCase() === hubName);
  };
  const pinnedThreads = useThreadShells().filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.pinnedAt !== null &&
      thread.archivedAt === null,
  );
  const [saving, setSaving] = useState(false);

  const reportFailure = (title: string, error: unknown) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );

  const save = async (next: readonly HermesHubSettings[]) => {
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { integrations: { hermesHubs: [...next] } } },
    });
    setSaving(false);
    if (result._tag === "Failure") reportFailure("Could not save hubs", result.cause);
  };
  const update = (id: string, patch: Partial<HermesHubSettings>) =>
    void save(hubs.map((hub) => (hub.id === id ? { ...hub, ...patch } : hub)));

  const createPinnedThread = async (hub: HermesHubSettings) => {
    const hubProject = projectFor(hub);
    if (hubProject === undefined) {
      reportFailure("Could not create hub thread", "Pick a project for the hub thread first.");
      return;
    }
    setSaving(true);
    const threadId = newThreadId();
    const created = await createThread({
      environmentId,
      input: {
        threadId,
        projectId: hubProject.id,
        title: hub.name,
        modelSelection:
          hubProject.defaultModelSelection ?? resolveAppModelSelectionState(settings, providers),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      },
    });
    setSaving(false);
    if (created._tag === "Failure") {
      reportFailure("Could not create hub thread", created.cause);
      return;
    }
    const pinned = await pinThread(scopeThreadRef(environmentId, threadId));
    if (pinned._tag === "Failure") reportFailure("Could not pin hub thread", pinned.cause);
    update(hub.id, { threadId });
  };

  const intro = (
    <SettingsRow
      {...searchableSetting("hermes-hubs")}
      description="Collect Hermes conversations from Discord channels into one pinned thread. Each conversation shows up as a card you can open or detach."
      control={
        <Button
          size="compact"
          variant="outline"
          disabled={saving}
          onClick={() =>
            void save([
              ...hubs,
              {
                id: nextHubId(hubs),
                name: "New hub",
                threadId: null,
                channels: [],
                autoLink: true,
                autoLinkCap: 5,
              },
            ])
          }
        >
          Add hub
        </Button>
      }
    />
  );

  return (
    <>
      {intro}
      {hubs.map((hub) => {
        const thread =
          hub.threadId === null
            ? undefined
            : pinnedThreads.find((candidate) => candidate.id === hub.threadId);
        const needsThread = thread === undefined;
        return (
          <div key={hub.id} className="flex flex-col">
            <SettingsRow
              title={hub.name}
              description={
                needsThread
                  ? "Needs a thread: pick a pinned thread or create one."
                  : `Posts into ${thread.title}`
              }
              control={
                <div className="flex items-center gap-2">
                  <DraftInput
                    className="w-40"
                    size="sm"
                    aria-label={`${hub.name} name`}
                    disabled={saving}
                    value={hub.name}
                    onCommit={(next) => {
                      const name = next.trim();
                      if (name && name !== hub.name) update(hub.id, { name });
                    }}
                  />
                  <Button
                    size="compact"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => void save(hubs.filter((candidate) => candidate.id !== hub.id))}
                  >
                    Remove
                  </Button>
                </div>
              }
            />
            <SettingsRow
              title="Thread"
              description="The pinned thread this hub posts conversation cards into."
              control={
                <div className="flex items-center gap-2">
                  <Select
                    value={thread?.id ?? ""}
                    onValueChange={(value) => {
                      if (value && value !== hub.threadId)
                        update(hub.id, { threadId: value as ThreadId });
                    }}
                  >
                    <SelectTrigger
                      size="compact"
                      className="w-44"
                      aria-label={`${hub.name} thread`}
                      disabled={saving || pinnedThreads.length === 0}
                    >
                      <SelectValue>{thread?.title ?? "Needs a thread"}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {pinnedThreads.map((candidate) => {
                        // Pinned threads from every project are valid hubs, so
                        // the project and any hub already using one tell
                        // same-named threads apart.
                        const project = projects.find((entry) => entry.id === candidate.projectId);
                        const usedBy = hubs.find(
                          (other) => other.id !== hub.id && other.threadId === candidate.id,
                        );
                        return (
                          <SelectItem key={candidate.id} value={candidate.id}>
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{candidate.title}</span>
                              <span className="truncate text-muted-foreground text-xs">
                                {[project?.title, usedBy ? `Hub: ${usedBy.name}` : null]
                                  .filter(Boolean)
                                  .join(" · ") || "No project"}
                              </span>
                            </span>
                          </SelectItem>
                        );
                      })}
                    </SelectPopup>
                  </Select>
                  {needsThread ? (
                    <>
                      <Select
                        value={projectFor(hub)?.id ?? ""}
                        onValueChange={(value) => {
                          if (value)
                            setProjectByHub((current) => ({
                              ...current,
                              [hub.id]: value as ProjectId,
                            }));
                        }}
                      >
                        <SelectTrigger
                          size="compact"
                          className="w-40"
                          aria-label={`${hub.name} project`}
                          disabled={saving || projects.length === 0}
                        >
                          <SelectValue>{projectFor(hub)?.title ?? "Pick a project"}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup align="end" alignItemWithTrigger={false}>
                          {projects.map((project) => (
                            <SelectItem key={project.id} value={project.id}>
                              {project.title}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                      <Button
                        size="compact"
                        variant="outline"
                        disabled={saving || projectFor(hub) === undefined}
                        onClick={() => void createPinnedThread(hub)}
                      >
                        Create pinned thread
                      </Button>
                    </>
                  ) : null}
                </div>
              }
            />
            <SettingsRow
              title="Channels"
              description="Discord channel ids, separated by commas or spaces."
              control={
                <DraftInput
                  className="w-64"
                  size="sm"
                  aria-label={`${hub.name} channels`}
                  disabled={saving}
                  placeholder="123456789012345678"
                  value={hub.channels.join(", ")}
                  onCommit={(next) => {
                    const channels = parseHubChannels(next);
                    if (channels.join(",") !== hub.channels.join(",")) update(hub.id, { channels });
                  }}
                />
              }
            />
            <SettingsRow
              title="Link new conversations"
              description="Link each conversation in these channels automatically, keeping the newest few."
              control={
                <div className="flex items-center gap-2">
                  <NumberField
                    // Remount when the saved value changes so a clamped entry shows what was saved.
                    key={hub.autoLinkCap}
                    defaultValue={hub.autoLinkCap}
                    min={0}
                    step={1}
                    size="sm"
                    className="w-20"
                    disabled={saving || !hub.autoLink}
                    onValueCommitted={(value) => {
                      if (value !== null && value !== hub.autoLinkCap)
                        update(hub.id, { autoLinkCap: Math.max(0, Math.round(value)) });
                    }}
                  >
                    <NumberFieldGroup>
                      <NumberFieldInput aria-label={`${hub.name} conversation cap`} />
                    </NumberFieldGroup>
                  </NumberField>
                  <Switch
                    checked={hub.autoLink}
                    disabled={saving}
                    aria-label={`Link new ${hub.name} conversations automatically`}
                    onCheckedChange={(autoLink) => update(hub.id, { autoLink })}
                  />
                </div>
              }
            />
          </div>
        );
      })}
    </>
  );
}
