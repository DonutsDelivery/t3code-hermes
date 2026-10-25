/**
 * Which Hermes webhook routes and scheduled jobs, in every profile, mirror their runs into threads
 * in the chosen project.
 */
import type { EnvironmentId, HermesRunSource, ProjectId } from "@t3tools/contracts";
import { useState } from "react";

import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

export function HermesRunsSettingsSection() {
  const { environment: selected } = useSettingsScope();
  const connected = selected?.connection.phase === "connected" && selected.serverConfig !== null;

  return (
    <SettingsSection id="hermes-runs" title="Hermes runs">
      {connected ? (
        <HermesRunsControls key={selected.environmentId} environmentId={selected.environmentId} />
      ) : (
        <SettingsRow
          {...searchableSetting("hermes-runs")}
          description="Connect an environment to choose which Hermes tasks show up as threads."
        />
      )}
    </SettingsSection>
  );
}

function describeSource(source: HermesRunSource): string {
  const parts = [source.kind === "webhook" ? "Webhook" : "Scheduled"];
  if (source.detail) parts.push(source.detail);
  if (source.profile !== "default") parts.push(`profile ${source.profile}`);
  parts.push(
    source.lastRunAt === null
      ? "hasn't run yet"
      : `last ran ${formatRelativeTimeLabel(source.lastRunAt)}`,
  );
  if (!source.configured) parts.push("no longer in Hermes's config");
  return parts.join(" · ");
}

function HermesRunsControls({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    serverEnvironment.hermesRunSources({ environmentId, input: {} }),
  );
  const setSource = useAtomCommand(serverEnvironment.hermesRunSourceSet, {
    label: "save Hermes run source",
  });
  const allProjects = useProjects();
  const projects = allProjects.filter((project) => project.environmentId === environmentId);
  const [pending, setPending] = useState<string | null>(null);

  const save = async (source: HermesRunSource, projectId: ProjectId | null) => {
    setPending(`${source.profile}:${source.sourceKey}`);
    const result = await setSource({
      environmentId,
      input: { profile: source.profile, sourceKey: source.sourceKey, projectId },
    });
    if (result._tag === "Success") query.refresh();
    setPending(null);
  };

  const result = query.data;
  const intro = (
    <SettingsRow
      {...searchableSetting("hermes-runs")}
      description="Turn on a Hermes webhook route or scheduled job to see each of its runs as a thread: live while Hermes works, with its pull request linked. You can reply once a run finishes."
    />
  );
  if (result == null) return intro;
  if (!result.hermesEnabled) {
    return (
      <>
        {intro}
        <SettingsRow title="Hermes is off" description="Turn on Hermes in Providers first." />
      </>
    );
  }
  if (result.sources.length === 0) {
    return (
      <>
        {intro}
        <SettingsRow
          title="No background tasks"
          description="Hermes has no webhook routes or scheduled jobs yet. Ask Hermes for one in chat."
        />
      </>
    );
  }

  return (
    <>
      {intro}
      {result.sources.map((source) => {
        const key = `${source.profile}:${source.sourceKey}`;
        const busy = pending === key;
        const fallbackProject = source.suggestedProjectId ?? projects[0]?.id ?? null;
        return (
          <SettingsRow
            key={key}
            title={source.label}
            description={describeSource(source)}
            control={
              <div className="flex items-center gap-2">
                {source.projectId !== null ? (
                  <Select
                    value={source.projectId}
                    onValueChange={(value) => {
                      if (value && value !== source.projectId)
                        void save(source, value as ProjectId);
                    }}
                  >
                    <SelectTrigger size="compact" className="w-44" aria-label="Project">
                      <SelectValue>
                        {projects.find((project) => project.id === source.projectId)?.title ??
                          "Missing project"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null}
                <Switch
                  checked={source.projectId !== null}
                  disabled={busy || (source.projectId === null && fallbackProject === null)}
                  aria-label={`Show ${source.label} runs as threads`}
                  onCheckedChange={(checked) => void save(source, checked ? fallbackProject : null)}
                />
              </div>
            }
          />
        );
      })}
    </>
  );
}
