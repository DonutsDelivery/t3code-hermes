/**
 * The read-only Paperclip surface: one company's agents, work, and runs.
 *
 * Everything comes from one `paperclip.overview` read through the
 * environment's server, so the surface works the same from a phone or a
 * tunnel. Lists arrive already capped server-side, which is why they render
 * as plain rows rather than through a virtualized list.
 *
 * Nothing here writes to Paperclip. Rows open in Paperclip's own web app when
 * the environment knows its address.
 */
import {
  describePaperclipConnection,
  describePaperclipViewer,
  formatPaperclipAction,
  formatPaperclipAge,
  formatPaperclipCents,
  formatPaperclipStatus,
  paperclipAgentName,
  paperclipOrgRows,
  paperclipStatusTone,
} from "@t3tools/client-runtime/state/paperclip";
import type { EnvironmentId, PaperclipOverviewResult } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, Paperclip, SettingsIcon } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";

function openInPaperclip(url: string) {
  const api = readLocalApi();
  if (api) void api.shell.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function StatusBadge({ status }: { readonly status: string }) {
  return (
    <Badge size="sm" variant={paperclipStatusTone(status)}>
      {formatPaperclipStatus(status)}
    </Badge>
  );
}

function Section(props: {
  readonly title: string;
  readonly count?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="flex items-baseline gap-2 px-1 text-xs font-medium text-muted-foreground">
        {props.title}
        {props.count === undefined ? null : <span className="tabular-nums">{props.count}</span>}
      </h3>
      {props.children}
    </section>
  );
}

function EmptyLine({ children }: { readonly children: ReactNode }) {
  return <p className="px-1 text-xs text-muted-foreground">{children}</p>;
}

/**
 * Rereads on the user's interval while the surface is open. A hidden tab skips
 * its ticks and a read still in flight is never cancelled, so a short interval
 * cannot pile reads onto a slow Paperclip.
 */
function usePaperclipAutoRefresh(
  query: { readonly refresh: () => void; readonly isPending: boolean },
  intervalSeconds: number,
) {
  const tick = useEffectEvent(() => {
    if (document.visibilityState === "visible" && !query.isPending) query.refresh();
  });
  useEffect(() => {
    if (intervalSeconds <= 0) return;
    const timer = setInterval(tick, intervalSeconds * 1000);
    return () => clearInterval(timer);
  }, [intervalSeconds]);
}

export function PaperclipPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const enabled = useEnvironmentSettings(
    environmentId,
    (settings) => settings.integrations.paperclip.enabled,
  );
  const autoRefreshSeconds = useEnvironmentSettings(
    environmentId,
    (settings) => settings.integrations.paperclip.autoRefreshSeconds,
  );
  const query = useEnvironmentQuery(
    enabled ? serverEnvironment.paperclipOverview({ environmentId, input: {} }) : null,
  );
  usePaperclipAutoRefresh(query, enabled ? autoRefreshSeconds : 0);
  const navigate = useNavigate();
  const openSettings = () => void navigate({ to: "/settings/integrations" });

  const result = query.data;
  if (!enabled || (result !== null && result.status.availability !== "ready")) {
    const summary = describePaperclipConnection(result, { enabled });
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Paperclip />
          </EmptyMedia>
          <EmptyTitle>{enabled ? summary.label : "Paperclip is off"}</EmptyTitle>
          <EmptyDescription>
            {summary.detail ??
              "Connect a Paperclip company in Settings to see its agents and work."}
          </EmptyDescription>
        </EmptyHeader>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={openSettings}>
            <SettingsIcon />
            Settings
          </Button>
          {enabled ? (
            <Button size="sm" variant="outline" disabled={query.isPending} onClick={query.refresh}>
              <RefreshIcon refreshing={query.isPending} />
              Try again
            </Button>
          ) : null}
        </div>
      </Empty>
    );
  }
  if (result === null) {
    return (
      <div className="flex flex-col gap-2 p-3" aria-busy>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-12" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  return (
    <PaperclipOverview result={result} refreshing={query.isPending} onRefresh={query.refresh} />
  );
}

function PaperclipOverview(props: {
  readonly result: PaperclipOverviewResult;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}) {
  const { result } = props;
  const company = result.company;
  const orgRows = paperclipOrgRows(result.agents, result.issues);
  const agentName = (id: string | null) => paperclipAgentName(result.agents, id);
  const issueById = new Map(result.issues.map((issue) => [issue.id, issue]));
  const openIssues = result.issues.filter(
    (issue) => issue.status !== "done" && issue.status !== "cancelled",
  ).length;
  const companyUrl = result.webUrl;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{company?.name ?? "Paperclip"}</p>
          <p className="truncate text-2xs text-muted-foreground">
            {describePaperclipViewer(result.viewer) ?? "Connected"}
          </p>
        </div>
        {companyUrl === null ? null : (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Open in Paperclip"
            onClick={() => openInPaperclip(companyUrl)}
          >
            <ArrowUpRightIcon />
          </Button>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh"
          disabled={props.refreshing}
          onClick={props.onRefresh}
        >
          <RefreshIcon refreshing={props.refreshing} />
        </Button>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          {result.dashboard === null ? null : (
            <dl className="grid grid-cols-4 gap-2 text-center">
              {(
                [
                  ["Open", result.dashboard.tasks.open],
                  ["Working", result.dashboard.tasks.inProgress],
                  ["Blocked", result.dashboard.tasks.blocked],
                  ["Spend", formatPaperclipCents(result.dashboard.monthSpendCents)],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border/60 px-1 py-1.5">
                  <dd className="text-sm font-medium tabular-nums">{value}</dd>
                  <dt className="text-2xs text-muted-foreground">{label}</dt>
                </div>
              ))}
            </dl>
          )}

          <Section title="Agents" count={String(result.agents.length)}>
            {orgRows.length === 0 ? (
              <EmptyLine>No agents yet.</EmptyLine>
            ) : (
              <ul className="flex flex-col">
                {orgRows.map(({ agent, depth, openIssues: assigned }) => (
                  <li
                    key={agent.id}
                    className="flex items-center gap-2 rounded-md px-1 py-1 text-sm"
                    style={{ paddingInlineStart: `${0.25 + depth * 0.875}rem` }}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{agent.name}</span>
                      {agent.title === null ? null : (
                        <span className="text-muted-foreground"> · {agent.title}</span>
                      )}
                    </span>
                    {assigned === 0 ? null : (
                      <span className="text-2xs text-muted-foreground tabular-nums">
                        {assigned} open
                      </span>
                    )}
                    <StatusBadge status={agent.status} />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="Issues"
            count={`${openIssues} open${result.issuesTruncated ? `, ${result.issues.length}+ shown` : ""}`}
          >
            {result.issues.length === 0 ? (
              <EmptyLine>No issues yet.</EmptyLine>
            ) : (
              <ul className="flex flex-col">
                {result.issues.map((issue) => {
                  const assignee = agentName(issue.assigneeAgentId);
                  const age = formatPaperclipAge(issue.updatedAt);
                  const href =
                    companyUrl === null
                      ? null
                      : `${companyUrl}/issues/${encodeURIComponent(issue.identifier)}`;
                  return (
                    <li key={issue.id}>
                      <button
                        type="button"
                        disabled={href === null}
                        onClick={() => href !== null && openInPaperclip(href)}
                        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm enabled:hover:bg-accent/60"
                      >
                        <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                          {issue.identifier}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{issue.title}</span>
                          <span className="block truncate text-2xs text-muted-foreground">
                            {[
                              assignee ??
                                (issue.assigneeUserId === null ? "Unassigned" : "A person"),
                              issue.hasActiveRun ? "working now" : null,
                              age,
                            ]
                              .filter((part): part is string => part !== null)
                              .join(" · ")}
                          </span>
                        </span>
                        <StatusBadge status={issue.status} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section title="Recent runs" count={String(result.runs.length)}>
            {result.runs.length === 0 ? (
              <EmptyLine>No agent has run yet.</EmptyLine>
            ) : (
              <ul className="flex flex-col">
                {result.runs.map((run) => {
                  const issue = run.issueId === null ? undefined : issueById.get(run.issueId);
                  return (
                    <li key={run.id} className="flex items-center gap-2 px-1 py-1 text-sm">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">
                          {agentName(run.agentId)}
                          {issue === undefined ? null : (
                            <span className="text-muted-foreground"> · {issue.identifier}</span>
                          )}
                        </span>
                        <span className="block truncate text-2xs text-muted-foreground">
                          {run.error ??
                            [
                              run.invocationSource,
                              formatPaperclipAge(run.finishedAt ?? run.startedAt),
                            ]
                              .filter((part): part is string => part !== null)
                              .join(" · ")}
                        </span>
                      </span>
                      <StatusBadge status={run.status} />
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section title="Activity">
            {result.activity.length === 0 ? (
              <EmptyLine>Nothing has happened yet.</EmptyLine>
            ) : (
              <ul className="flex flex-col">
                {result.activity.map((entry) => (
                  <li key={entry.id} className="flex items-baseline gap-2 px-1 py-0.5 text-xs">
                    <span className="min-w-0 flex-1 truncate">
                      {formatPaperclipAction(entry.action)}
                      {entry.actorType === "agent" && entry.actorId !== null ? (
                        <span className="text-muted-foreground">
                          {" "}
                          by {agentName(entry.actorId)}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-2xs text-muted-foreground">
                      {formatPaperclipAge(entry.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </ScrollArea>
    </div>
  );
}
