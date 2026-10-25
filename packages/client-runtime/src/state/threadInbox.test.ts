import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadIsMonitoring } from "./models.ts";
import {
  createInboxReturnTracker,
  isThreadWorking,
  sortWorkingThreadsBySend,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    pendingBackgroundTasks: [],
    pullRequests: [],
    settledAt: null,
    settledOverride: null,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("createInboxReturnTracker", () => {
  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    const first = tracker.observe([thread("a", true), thread("b", false)]);
    expect(first(thread("a", true))).toBeUndefined();
    expect(first(thread("b", false))).toBeUndefined();

    const second = tracker.observe([thread("a", false), thread("b", false)]);
    expect(second(thread("a", false))).toBeDefined();
    expect(second(thread("b", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("a", false))).toBe(second(thread("a", false)));
    // An earlier observation keeps its answer, so lists built from it stay valid.
    expect(first(thread("a", false))).toBeUndefined();
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});

describe("threadIsMonitoring", () => {
  const watchedPullRequest = {
    host: "github.com",
    repository: "pingdotgg/t3code",
    number: 1,
    url: "https://github.com/pingdotgg/t3code/pull/1",
    source: "agent" as const,
    linkedAt: "2026-06-01T00:00:00.000Z",
    snapshot: null,
    stack: null,
    watch: {
      startedAt: "2026-06-01T00:00:00.000Z",
      headSha: null,
      failedChecks: [],
      passed: false,
      passedChecks: [],
      remarksThrough: "2026-06-01T00:00:00.000Z",
      remarkIds: [],
      conflicting: false,
      wakes: 0,
    },
  };
  const runtime = (status: "running" | "completed" | "failed" | "idle") => ({
    status,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    providerName: null,
    lastError: null,
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
  const watching = { ...thread("watching", false), pullRequests: [watchedPullRequest] };

  it("monitors a settled thread that watches a pull request, and folds it into Working", () => {
    const settled = { ...watching, runtime: runtime("completed") };
    expect(threadIsMonitoring(settled)).toBe(true);
    expect(isThreadWorking(settled)).toBe(true);
    const { watch: _ended, ...unwatched } = watchedPullRequest;
    expect(threadIsMonitoring({ ...settled, pullRequests: [unwatched] })).toBe(false);
  });

  it("lets a running or failed run outrank the watch", () => {
    expect(threadIsMonitoring({ ...watching, runtime: runtime("running") })).toBe(false);
    expect(threadIsMonitoring({ ...watching, runtime: runtime("failed") })).toBe(false);
  });

  it("lets a plan waiting on the user outrank the watch", () => {
    const planReady = {
      ...watching,
      runtime: runtime("completed"),
      interactionMode: "plan" as const,
      hasActionableProposedPlan: true,
    };
    expect(threadIsMonitoring(planReady)).toBe(false);
    expect(isThreadWorking(planReady)).toBe(false);
  });

  it("does not monitor a settled thread, whose watch the server holds", () => {
    const settled = { ...watching, runtime: runtime("completed") };
    expect(threadIsMonitoring({ ...settled, settledAt: "2026-06-01T01:00:00.000Z" })).toBe(false);
    expect(threadIsMonitoring({ ...settled, settledOverride: "settled" as const })).toBe(false);
  });

  it("monitors awaited provider monitors only when nothing else holds the thread", () => {
    const monitor = { taskId: "monitor", kind: "monitor" as const, awaited: true as const };
    const watchdog = { taskId: "watchdog", kind: "monitor" as const };
    const command = { taskId: "dev-server", kind: "command" as const };
    const subagent = { taskId: "subagent", kind: "subagent" as const };
    const parked = { ...thread("parked", false), runtime: runtime("idle") };
    expect(threadIsMonitoring({ ...parked, pendingBackgroundTasks: [monitor, command] })).toBe(
      true,
    );
    expect(threadIsMonitoring({ ...parked, pendingBackgroundTasks: [watchdog, command] })).toBe(
      false,
    );
    expect(threadIsMonitoring({ ...parked, pendingBackgroundTasks: [monitor, subagent] })).toBe(
      false,
    );
    expect(
      threadIsMonitoring({
        ...parked,
        pullRequests: [watchedPullRequest],
        pendingBackgroundTasks: [subagent],
      }),
    ).toBe(false);
  });

  it("returns a thread to the inbox when its watch ends", () => {
    const settled = { ...watching, runtime: runtime("completed") };
    const tracker = createInboxReturnTracker();
    tracker.observe([settled]);
    tracker.observe([settled]);
    expect(tracker.returnedAt(settled)).toBeUndefined();
    const ended = { ...settled, pullRequests: [] };
    tracker.observe([ended]);
    expect(tracker.returnedAt(ended)).toBeDefined();
  });
});
