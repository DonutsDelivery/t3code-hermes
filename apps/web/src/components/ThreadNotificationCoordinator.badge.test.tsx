import { EnvironmentId, HermesCronJobId, type HermesCronRunCompleted } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "notifications",
  inApp: false,
  dots: false,
  toast: vi.fn(),
  shells: new Map(),
  navigate: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
  environmentIds: ["one", "two"],
  hermes: new Map<string, HermesCronRunCompleted | null>(),
  location: { pathname: "/", search: {} as Record<string, string> },
  reportHermes: vi.fn(),
  markHermesSeen: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (id: string) => state.shells.get(id) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => ({}),
  useRouterState: () => state.location,
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.toast, close: vi.fn() } }));
vi.mock("../state/hermesCron", () => ({
  useHermesEnvironmentEnabled: (id: string) => state.hermes.has(id),
  useHermesCron: (id: string) => ({ view: { lastCompletion: state.hermes.get(id) ?? null } }),
}));
vi.mock("../state/hermesCronSeen", () => ({
  reportHermesCompletion: state.reportHermes,
  markHermesTasksSeen: state.markHermesSeen,
}));
vi.mock("../state/shell", () => ({ environmentShell: { stateValueAtom: (id: string) => id } }));
vi.mock("../state/environments", () => ({
  useEnvironmentIds: () => state.environmentIds,
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (
    select: (settings: {
      notificationMode: string;
      inAppNotificationsEnabled: boolean;
      tabStatusDots: boolean;
    }) => unknown,
  ) =>
    select({
      notificationMode: state.mode,
      inAppNotificationsEnabled: state.inApp,
      tabStatusDots: state.dots,
    }),
  getClientSettings: () => ({ notificationMode: state.mode }),
}));
vi.mock("../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threadNotifications")>()),
  playNotificationSound: state.sound,
  unlockNotificationAudio: vi.fn(),
  setNotificationBadge: state.badge,
}));

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

class TestNotification extends EventTarget {
  static permission = "granted";
  static sent: TestNotification[] = [];
  close = vi.fn();
  get tag() {
    return this.options.tag ?? "";
  }
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    TestNotification.sent.push(this);
  }
}

const thread = {
  id: "thread",
  title: "Test thread",
  archivedAt: null as string | null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: null as { status: string } | null,
  latestTurn: { turnId: "turn", state: "running", completedAt: null as string | null },
};
let renderer: ReactTestRenderer | undefined;
let focused = false;
let visibility = "visible";

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T07:00:00.000Z");

function toV2ThreadShell(input: typeof thread) {
  const latestTurn = input.latestTurn;
  return {
    id: input.id,
    projectId: "project",
    title: input.title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: input.id,
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: latestTurn.turnId,
    activeRunId: null,
    status:
      latestTurn.state === "completed"
        ? "completed"
        : latestTurn.state === "error" || input.session?.status === "error"
          ? "failed"
          : "running",
    pendingRuntimeRequest: input.hasPendingUserInput
      ? { id: "request-1", kind: "user_input", createdAt: SHELL_NOW }
      : input.hasPendingApprovals
        ? { id: "request-1", kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: latestTurn.completedAt
      ? DateTime.makeUnsafe(latestTurn.completedAt)
      : undefined,
    archivedAt: input.archivedAt ? DateTime.makeUnsafe(input.archivedAt) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function shell(overrides: Partial<typeof thread> = {}) {
  return {
    status: "live",
    snapshot: Option.some({ threads: [toV2ThreadShell({ ...thread, ...overrides })] }),
  };
}
function complete(environment = "one", completedAt = "2026-09-13T08:00:00Z") {
  state.shells.set(
    environment,
    shell({ latestTurn: { turnId: "turn", state: "completed", completedAt } }),
  );
}
function lastBadge() {
  return state.badge.mock.lastCall?.[0];
}
async function render() {
  await act(async () => {
    if (renderer) renderer.update(<ThreadNotificationCoordinator />);
    else renderer = create(<ThreadNotificationCoordinator />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mode = "notifications";
  state.inApp = false;
  state.dots = false;
  state.environmentIds = ["one", "two"];
  state.hermes.clear();
  state.location = { pathname: "/", search: {} };
  state.shells.set("one", shell());
  state.shells.set("two", shell());
  focused = false;
  visibility = "visible";
  TestNotification.permission = "granted";
  TestNotification.sent = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", TestNotification);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { focus: vi.fn() }));
  vi.stubGlobal(
    "document",
    Object.defineProperty(
      Object.assign(new EventTarget(), { hasFocus: () => focused }),
      "visibilityState",
      { get: () => visibility },
    ),
  );
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("counts notifying threads across environments, replaces repeat alerts, and clears on focus", async () => {
  await render();
  complete();
  await render();
  expect(lastBadge()).toBe(1);
  complete("one", "2026-09-13T08:01:00Z");
  complete("two");
  await render();
  expect(lastBadge()).toBe(2);
  expect(TestNotification.sent[0]!.close).toHaveBeenCalledOnce();
  focused = true;
  window.dispatchEvent(new Event("focus"));
  expect(lastBadge()).toBe(0);
  expect(
    TestNotification.sent.every((notification) => notification.close.mock.calls.length > 0),
  ).toBe(true);
  focused = false;
  complete("two", "2026-09-13T08:02:00Z");
  await render();
  expect(lastBadge()).toBe(1);
});

it("does not badge old completions on first load or reconnect", async () => {
  complete();
  await render();
  state.shells.set("one", { status: "connecting", snapshot: Option.none() });
  await render();
  complete("one", "2026-09-13T08:01:00Z");
  await render();
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.badge.mock.calls.every(([count]) => count === 0)).toBe(true);
});

it("removes alerts only from environments that leave the client", async () => {
  await render();
  complete("one");
  complete("two");
  await render();
  expect(lastBadge()).toBe(2);
  const [removed, retained] = TestNotification.sent;
  state.environmentIds = ["two"];
  await render();
  expect(lastBadge()).toBe(1);
  expect(removed!.close).toHaveBeenCalledOnce();
  expect(retained!.close).not.toHaveBeenCalled();
  await render();
  expect(removed!.close).toHaveBeenCalledOnce();
  state.environmentIds = [];
  await render();
  expect(lastBadge()).toBe(0);
  expect(retained!.close).toHaveBeenCalledOnce();
});

it("starts a fresh count after another native app window gains focus", async () => {
  let clear: (() => void) | undefined;
  const unsubscribe = vi.fn();
  Object.assign(window, {
    desktopBridge: {
      onNotificationBadgeClear: (listener: () => void) => {
        clear = listener;
        return unsubscribe;
      },
    },
  });
  await render();
  complete();
  await render();
  clear!();
  expect(lastBadge()).toBe(0);
  complete("two");
  await render();
  expect(lastBadge()).toBe(1);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(lastBadge()).toBe(0);
});

it.each(["off", "sound", "denied"])(
  "badges background completions without an OS alert when %s",
  async (condition) => {
    if (condition === "off" || condition === "sound") state.mode = condition;
    if (condition === "denied") TestNotification.permission = "denied";
    await render();
    complete();
    await render();
    expect(TestNotification.sent).toHaveLength(0);
    expect(state.badge).toHaveBeenLastCalledWith(1);
    window.dispatchEvent(new Event("focus"));
    expect(lastBadge()).toBe(0);
  },
);

it("with status dots on, colors the badge by the most severe alert and blinks only on arrival", async () => {
  state.mode = "off";
  state.dots = true;
  await render();
  complete("one");
  state.shells.set("two", shell({ hasPendingApprovals: true }));
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(2, { kind: "input", blink: true });
  state.shells.set("two", shell({ latestTurn: { ...thread.latestTurn, state: "error" } }));
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(2, { kind: "failed", blink: true });
  complete("one", "2026-09-13T08:01:00Z");
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(2, { kind: "failed", blink: false });
});

it("keeps the plain count badge while status dots are off, and redraws when toggled", async () => {
  state.mode = "off";
  await render();
  state.shells.set("one", shell({ hasPendingApprovals: true }));
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(1);
  state.dots = true;
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(1, { kind: "input", blink: false });
  state.dots = false;
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(1);
});

it.each(["focused", "archived"])("does not show visual alerts when %s", async (condition) => {
  if (condition === "focused") focused = true;
  await render();
  complete();
  if (condition === "archived")
    state.shells.set(
      "one",
      shell({
        archivedAt: "2026-09-13T08:00:00Z",
        hasPendingApprovals: true,
      }),
    );
  await render();
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.badge.mock.calls.every(([count]) => count === 0)).toBe(true);
});

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "badges %s and clears when the window regains focus",
  async (flag) => {
    await render();
    state.shells.set("one", shell({ [flag]: true }));
    await render();
    expect(lastBadge()).toBe(1);
    const notification = TestNotification.sent[0]!;
    notification.dispatchEvent(new Event("click"));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: EnvironmentId.make("one"), threadId: "thread" },
    });
    window.dispatchEvent(new Event("focus"));
    expect(lastBadge()).toBe(0);
    expect(notification.close).toHaveBeenCalled();
  },
);

it("shows in-app alerts without adding a badge while focused", async () => {
  state.inApp = true;
  focused = true;
  await render();
  complete();
  await render();
  expect(state.toast).toHaveBeenCalledOnce();
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.badge.mock.calls.every(([count]) => count === 0)).toBe(true);
});

it("badges background failures with in-app notifications enabled", async () => {
  state.inApp = true;
  await render();
  state.shells.set("one", shell({ latestTurn: { ...thread.latestTurn, state: "error" } }));
  await render();
  expect(TestNotification.sent[0]?.title).toBe("Thread failed");
  expect(lastBadge()).toBe(1);
  expect(state.toast).not.toHaveBeenCalled();
});

function completeHermes(environment = "two", overrides: Partial<HermesCronRunCompleted> = {}) {
  state.hermes.set(environment, {
    jobId: HermesCronJobId.make("job"),
    jobName: "Morning report",
    runId: "run",
    status: "completed",
    finishedAt: null,
    error: null,
    delivery: {
      preview: "The report is ready.",
      contentAvailable: true,
      source: "delivery",
      truncated: false,
      targets: ["local"],
      status: "delivered",
      error: null,
    },
    ...overrides,
  });
}

it("shares Hermes and thread badge counts and opens the exact remote run", async () => {
  state.hermes.set("two", null);
  await render();
  complete("one");
  await render();
  completeHermes();
  await render();
  expect(lastBadge()).toBe(2);
  const notification = TestNotification.sent.at(-1)!;
  expect(notification.options).toMatchObject({ body: "The report is ready.", silent: true });
  notification.dispatchEvent(new Event("click"));
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/hermes",
    search: { environmentId: "two", jobId: "job", runId: "run" },
  });
  state.environmentIds = ["one"];
  await render();
  expect(lastBadge()).toBe(1);
  window.dispatchEvent(new Event("focus"));
  expect(lastBadge()).toBe(0);
});

it("previews a focused Hermes completion without a badge and does not replay it on preference changes", async () => {
  state.mode = "off";
  state.inApp = true;
  focused = true;
  state.hermes.set("two", null);
  await render();
  completeHermes();
  await render();
  expect(state.toast).toHaveBeenCalledOnce();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      description: "The report is ready.",
      actionProps: expect.objectContaining({ children: "Open" }),
    }),
  );
  state.toast.mock.calls[0]![0].actionProps.onClick();
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/hermes",
    search: { environmentId: "two", jobId: "job", runId: "run" },
  });
  state.mode = "notifications-and-sound";
  focused = false;
  await render();
  expect(state.toast).toHaveBeenCalledOnce();
  expect(state.reportHermes).toHaveBeenCalledOnce();
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.sound).not.toHaveBeenCalled();
});

it("observes completions while every alert is disabled without replaying them when enabled", async () => {
  state.mode = "off";
  state.hermes.set("two", null);
  await render();
  completeHermes();
  await render();
  state.mode = "notifications";
  await render();
  expect(state.reportHermes).toHaveBeenCalledOnce();
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.toast).not.toHaveBeenCalled();
});

it.each(["off", "sound", "denied", "default", "focused"])(
  "does not show Hermes OS alerts when %s",
  async (condition) => {
    if (condition === "off" || condition === "sound") state.mode = condition;
    if (condition === "focused") focused = true;
    if (condition === "denied" || condition === "default") TestNotification.permission = condition;
    state.hermes.set("two", null);
    await render();
    completeHermes();
    await render();
    expect(TestNotification.sent).toHaveLength(0);
    expect(state.toast).not.toHaveBeenCalled();
    // Background runs still mark the tab; only a focused window skips it.
    expect(lastBadge()).toBe(condition === "focused" ? 0 : 1);
  },
);

it("suppresses the current run's in-app alert but still plays sound and marks it seen", async () => {
  state.mode = "notifications-and-sound";
  state.inApp = true;
  focused = true;
  state.location = {
    pathname: "/hermes",
    search: { environmentId: "two", jobId: "job", runId: "run" },
  };
  state.hermes.set("two", null);
  await render();
  completeHermes();
  await render();
  expect(state.toast).not.toHaveBeenCalled();
  expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
  expect(state.markHermesSeen).toHaveBeenCalledWith("two");
  expect(TestNotification.sent).toHaveLength(0);
});

it("falls back to execution errors for legacy completions and treats hidden windows as unfocused", async () => {
  state.inApp = true;
  state.dots = true;
  focused = true;
  visibility = "hidden";
  state.hermes.set("two", null);
  await render();
  state.hermes.set("two", {
    jobId: HermesCronJobId.make("job"),
    jobName: "Report",
    runId: "run",
    status: "failed",
    finishedAt: null,
    error: "Provider unavailable",
  });
  await render();
  expect(TestNotification.sent.at(-1)?.options.body).toBe("Provider unavailable");
  expect(state.toast).not.toHaveBeenCalled();
  expect(state.badge).toHaveBeenLastCalledWith(1, { kind: "failed", blink: true });
});
