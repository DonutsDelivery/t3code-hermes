import type { PaperclipAgent, PaperclipIssue, PaperclipOverviewResult } from "@t3tools/contracts";
import { PAPERCLIP_CONTRACT_VERSION } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describePaperclipConnection,
  formatPaperclipAge,
  formatPaperclipStatus,
  paperclipOrgRows,
  paperclipRefreshSeconds,
  splitPaperclipRefreshInterval,
} from "./paperclip.ts";

const agent = (id: string, name: string, reportsTo: string | null): PaperclipAgent => ({
  id,
  name,
  title: null,
  role: "general",
  status: "idle",
  adapterType: "claude_local",
  reportsTo,
  lastHeartbeatAt: null,
  pauseReason: null,
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  urlKey: null,
});

const issue = (assigneeAgentId: string, status: string): PaperclipIssue => ({
  id: `${assigneeAgentId}-${status}`,
  identifier: "SPA-1",
  title: "Work",
  status,
  priority: null,
  assigneeAgentId,
  assigneeUserId: null,
  projectId: null,
  parentId: null,
  updatedAt: null,
  hasActiveRun: false,
});

describe("paperclipOrgRows", () => {
  it("nests reports under their manager and counts only open work", () => {
    const rows = paperclipOrgRows(
      [agent("p", "Pentecost", "a"), agent("e", "Engineer", "p"), agent("a", "AERIS", null)],
      [issue("p", "blocked"), issue("p", "done"), issue("e", "todo")],
    );
    expect(rows.map((row) => [row.agent.name, row.depth, row.openIssues])).toEqual([
      ["AERIS", 0, 0],
      ["Pentecost", 1, 1],
      ["Engineer", 2, 1],
    ]);
  });

  it("lists every agent once, even with a missing manager or a cycle", () => {
    const rows = paperclipOrgRows(
      [
        agent("x", "Orphan", "gone"),
        agent("c1", "Cycle one", "c2"),
        agent("c2", "Cycle two", "c1"),
      ],
      [],
    );
    expect(rows.map((row) => row.agent.name).sort()).toEqual(["Cycle one", "Cycle two", "Orphan"]);
  });
});

describe("describePaperclipConnection", () => {
  const ready: PaperclipOverviewResult = {
    status: { contractVersion: PAPERCLIP_CONTRACT_VERSION, availability: "ready", detail: null },
    viewer: { name: "T3-Viewer", role: "viewer", isInstanceAdmin: false, readOnly: true },
    company: {
      id: "c",
      name: "SpacetimeEngineering",
      issuePrefix: "SPA",
      status: "active",
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
    },
    dashboard: null,
    agents: [],
    projects: [],
    issues: [],
    issuesTruncated: false,
    runs: [],
    activity: [],
    webUrl: null,
  };

  it("names the company and says the key is read-only", () => {
    expect(describePaperclipConnection(ready, { enabled: true })).toEqual({
      tone: "ready",
      label: "Connected",
      detail: "SpacetimeEngineering · as T3-Viewer viewer, read-only",
    });
  });

  it("says a rejected key apart from an offline Paperclip", () => {
    const rejected = describePaperclipConnection(
      {
        ...ready,
        status: { ...ready.status, availability: "unauthorized", detail: "rejected" },
      },
      { enabled: true },
    );
    expect(rejected.label).toBe("Key rejected");
    expect(describePaperclipConnection(ready, { enabled: false }).label).toBe("Off");
  });
});

it("formats statuses and ages for rows", () => {
  expect(formatPaperclipStatus("in_progress")).toBe("In progress");
  const now = Date.parse("2026-10-17T12:00:00.000Z");
  expect(formatPaperclipAge("2026-10-17T09:00:00.000Z", now)).toBe("3h ago");
  expect(formatPaperclipAge(null, now)).toBeNull();
});

describe("auto-refresh interval", () => {
  it("shows a saved interval in the largest unit that divides it", () => {
    expect(splitPaperclipRefreshInterval(7_200)).toEqual({ amount: 2, unit: "hours" });
    expect(splitPaperclipRefreshInterval(90)).toEqual({ amount: 90, unit: "seconds" });
    expect(splitPaperclipRefreshInterval(172_800)).toEqual({ amount: 2, unit: "days" });
    expect(splitPaperclipRefreshInterval(0, "hours")).toEqual({ amount: 0, unit: "hours" });
  });

  it("saves zero as off and clamps everything else into range", () => {
    expect(paperclipRefreshSeconds(0, "minutes")).toBe(0);
    expect(paperclipRefreshSeconds(5, "minutes")).toBe(300);
    expect(paperclipRefreshSeconds(3, "seconds")).toBe(10);
    expect(paperclipRefreshSeconds(30, "days")).toBe(7 * 86_400);
  });

  it("round-trips what it saves", () => {
    const saved = paperclipRefreshSeconds(45, "minutes");
    expect(splitPaperclipRefreshInterval(saved)).toEqual({ amount: 45, unit: "minutes" });
  });
});
