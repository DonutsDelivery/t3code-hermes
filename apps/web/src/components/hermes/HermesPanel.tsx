/**
 * Full-page Hermes panel with Tasks, Memory, Patches, and Skills tabs for one device chosen in the
 * header; Patches can also show every device. Every tab renders unconditionally so the strip never
 * shifts and each explains a missing service.
 */
import { HERMES_NEW_TASK_TEMPLATE } from "@t3tools/client-runtime/state/hermes-cron";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { LayersIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { requestComposerTemplate } from "../../composerTemplateBus";
import { cn } from "../../lib/utils";
import { markHermesTasksSeen } from "../../state/hermesCronSeen";
import { useHermesEnvironmentIds } from "../../state/hermesCron";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { environmentScopeOption, ScopeMenu } from "../settings/SettingsScopeSentence";
import { settingsScopeEnvironmentLabel } from "../settings/settingsScopeAxis";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { HermesMemoryTab } from "./HermesMemoryTab";
import { HermesPatchesEverywhere, HermesPatchesTab } from "./HermesPatchesTab";
import { HermesTasksTab } from "./HermesTasksTab";
import { HermesSkillsTab } from "./HermesSkillsTab";
import { EMPTY_HERMES_SEARCH, type HermesSearch } from "./hermesNavigation";

type HermesTab = "tasks" | "memory" | "patches" | "skills";

const ALL_DEVICES_VALUE = "all";

const TABS: ReadonlyArray<{ readonly value: HermesTab; readonly label: string }> = [
  { value: "tasks", label: "Tasks" },
  { value: "memory", label: "Memory" },
  { value: "patches", label: "Patches" },
  { value: "skills", label: "Skills" },
];

export function HermesPanel({ target = EMPTY_HERMES_SEARCH }: { readonly target?: HermesSearch }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<HermesTab>("tasks");
  const hermesEnvironmentIds = useHermesEnvironmentIds();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    target.environmentId ?? null,
  );
  const [patchesEverywhere, setPatchesEverywhere] = useState(false);

  const targetKey = JSON.stringify([target.environmentId, target.jobId, target.runId]);
  const [previousTarget, setPreviousTarget] = useState(targetKey);
  if (targetKey !== previousTarget) {
    setPreviousTarget(targetKey);
    if (target.environmentId) {
      setSelectedEnvironmentId(target.environmentId);
      setPatchesEverywhere(false);
    }
    if (target.jobId) setTab("tasks");
  }

  // A deep link's environment holds even when its Hermes is not reachable
  // right now: it must never silently show another host's tasks instead.
  const environmentId =
    selectedEnvironmentId !== null &&
    (selectedEnvironmentId === target.environmentId ||
      hermesEnvironmentIds.includes(selectedEnvironmentId))
      ? selectedEnvironmentId
      : (hermesEnvironmentIds[0] ?? null);
  const tabTarget = environmentId === target.environmentId ? target : EMPTY_HERMES_SEARCH;
  const deviceOptions = hermesEnvironmentIds.flatMap((id) =>
    environments.filter((environment) => environment.environmentId === id),
  );
  const onlyPrimaryDevice =
    deviceOptions.length === 1 && deviceOptions[0]?.environmentId === primaryEnvironmentId;
  const selectedDevice = deviceOptions.find((option) => option.environmentId === environmentId);
  const canShowEverywhere = tab === "patches" && deviceOptions.length > 1;
  const showEverywhere = canShowEverywhere && patchesEverywhere;
  const showDevice = (next: EnvironmentId) => {
    setSelectedEnvironmentId(next);
    setPatchesEverywhere(false);
  };

  // Opening the panel is what clears the sidebar's unread dot.
  useEffect(() => {
    if (environmentId !== null) markHermesTasksSeen(environmentId);
  }, [environmentId]);

  const handleNewTask = () => {
    requestComposerTemplate(HERMES_NEW_TASK_TEMPLATE);
    void navigate({ to: "/" });
  };

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 px-4 py-3">
          <WorkspaceBreadcrumb ariaLabel="Hermes breadcrumb">
            <WorkspaceBreadcrumbItem current>Hermes</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          {deviceOptions.length > 0 && !onlyPrimaryDevice ? (
            <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
              <span className="shrink-0">on</span>
              <ScopeMenu
                ariaLabel="Hermes device"
                icon={
                  showEverywhere ? (
                    <LayersIcon aria-hidden className="size-3.5 shrink-0" />
                  ) : selectedDevice ? (
                    <EnvironmentMachineIcon
                      aria-hidden
                      kind={resolveEnvironmentMachineKind(selectedDevice.serverConfig)}
                      className="size-3.5 shrink-0"
                    />
                  ) : null
                }
                label={
                  showEverywhere
                    ? "All devices"
                    : selectedDevice
                      ? settingsScopeEnvironmentLabel(selectedDevice, deviceOptions)
                      : "Unavailable device"
                }
                value={showEverywhere ? ALL_DEVICES_VALUE : (environmentId ?? "")}
                options={deviceOptions.map((option) =>
                  environmentScopeOption(option, deviceOptions),
                )}
                allOption={
                  canShowEverywhere
                    ? {
                        value: ALL_DEVICES_VALUE,
                        label: "All devices",
                        icon: <LayersIcon aria-hidden className="size-3.5 shrink-0" />,
                      }
                    : null
                }
                searchLabel="Search devices"
                onChange={(next) => {
                  if (next === ALL_DEVICES_VALUE) {
                    setPatchesEverywhere(true);
                    return;
                  }
                  const device = deviceOptions.find((option) => option.environmentId === next);
                  if (device) showDevice(device.environmentId);
                }}
              />
            </span>
          ) : null}
        </header>

        <nav
          aria-label="Hermes tabs"
          className="flex shrink-0 items-center gap-1 border-b border-border/60 px-4 pb-2"
        >
          {TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={tab === item.value}
              onClick={() => setTab(item.value)}
              className={cn(
                "inline-flex items-center rounded-md px-3 py-1.5 text-xs transition-colors",
                tab === item.value
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <ScrollArea className="min-h-0 flex-1">
          {/* Keyed so no draft or selection follows the user to another device. */}
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-5">
            {tab === "tasks" ? (
              <HermesTasksTab
                key={environmentId}
                environmentId={environmentId}
                onNewTask={handleNewTask}
                target={tabTarget}
              />
            ) : tab === "memory" ? (
              <HermesMemoryTab key={environmentId} environmentId={environmentId} />
            ) : showEverywhere ? (
              <HermesPatchesEverywhere
                devices={deviceOptions.map((option) => ({
                  environmentId: option.environmentId,
                  label: settingsScopeEnvironmentLabel(option, deviceOptions),
                }))}
                onShowDevice={showDevice}
              />
            ) : tab === "patches" ? (
              <HermesPatchesTab key={environmentId} environmentId={environmentId} />
            ) : (
              <HermesSkillsTab key={environmentId} environmentId={environmentId} />
            )}
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
