import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { EnvironmentId, HermesCronJobId, type HermesCronRunCompleted } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render, stubGlobal, type Screen } from "../../test/render";

const state = vi.hoisted(() => ({
  mode: "notifications",
  inApp: false,
  dots: false,
  toast: vi.fn(),
  shells: null as unknown as { set: (id: string, value: unknown) => void },
  navigate: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
  environmentIds: ["one", "two"],
  hermes: null as unknown as { set: (id: string, value: HermesCronRunCompleted | null) => void },
  location: { pathname: "/", search: {} as Record<string, string> },
  reportHermes: vi.fn(),
  markHermesSeen: vi.fn(),
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useParams: (() => ({})) as never,
  useRouterState: (() => state.location) as never,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: state.toast as never, close: vi.fn() },
  };
});
vi.mock(import("../state/hermesCron"), async (original) => ({
  ...(await original()),
  useHermesEnvironmentEnabled: ((id: string) =>
    useAtomValue(hermesCompletionAtom(id)) !== undefined) as never,
  useHermesCron: ((id: string) => ({
    view: { lastCompletion: useAtomValue(hermesCompletionAtom(id)) ?? null },
  })) as never,
}));
vi.mock(import("../state/hermesCronSeen"), async (original) => ({
  ...(await original()),
  reportHermesCompletion: state.reportHermes,
  markHermesTasksSeen: state.markHermesSeen,
}));
vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentShell: {
      ...actual.environmentShell,
      stateValueAtom: ((id: string) => shellAtom(id)) as never,
    },
  };
});
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => state.environmentIds) as never,
}));
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((
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
    })) as never,
  getClientSettings: (() => ({ notificationMode: state.mode })) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  unlockNotificationAudio: vi.fn(),
  setNotificationBadge: state.badge,
}));

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

let registry: AtomRegistry.AtomRegistry;
const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
state.shells = { set: (id, value) => registry.set(shellAtom(id), value) };
// Undefined means Hermes is not enabled on that environment.
const hermesCompletionAtom = Atom.family((_id: string) =>
  Atom.make<HermesCronRunCompleted | null | undefined>(undefined),
);
state.hermes = { set: (id, value) => registry.set(hermesCompletionAtom(id), value) };

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

function shell(overrides: Partial<typeof thread> = {}, ...others: Partial<typeof thread>[]) {
  return {
    status: "live",
    snapshot: Option.some({
      threads: [overrides, ...others].map((override) =>
        toV2ThreadShell({ ...thread, ...override }),
      ),
    }),
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
// The mocked modules read `state`, the registry and the focus flags, so every test starts by
// resetting them. The first render is left to the test because some tests change state first.
function setup() {
  vi.clearAllMocks();
  const stack = new AsyncDisposableStack();
  registry = AtomRegistry.make();
  const testRegistry = registry;
  stack.defer(() => testRegistry.dispose());
  state.mode = "notifications";
  state.inApp = false;
  state.dots = false;
  state.environmentIds = ["one", "two"];
  state.location = { pathname: "/", search: {} };
  state.shells.set("one", shell());
  state.shells.set("two", shell());
  focused = false;
  visibility = "visible";
  TestNotification.permission = "granted";
  TestNotification.sent = [];
  stack.use(stubGlobal("Notification", TestNotification));
  stack.use(vi.spyOn(window, "focus").mockImplementation(() => undefined));
  stack.use(vi.spyOn(document, "hasFocus").mockImplementation(() => focused));
  stack.use(
    vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility as DocumentVisibilityState),
  );
  const ui = () => (
    <RegistryContext.Provider value={testRegistry}>
      <ThreadNotificationCoordinator />
    </RegistryContext.Provider>
  );
  let screen: Screen | undefined;
  return {
    async render() {
      if (screen) await screen.rerender(ui());
      else screen = stack.use(await render(ui()));
    },
    unmount: () => screen!.unmount(),
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

it.each(["off", "sound", "denied"])(
  "badges background completions without an OS alert when %s",
  async (condition) => {
    await using app = setup();
    if (condition === "off" || condition === "sound") state.mode = condition;
    if (condition === "denied") TestNotification.permission = "denied";
    await app.render();
    complete();
    await app.render();
    expect(TestNotification.sent).toHaveLength(0);
    expect(state.badge).toHaveBeenLastCalledWith(1);
    window.dispatchEvent(new Event("focus"));
    expect(lastBadge()).toBe(0);
  },
);

it("with status dots on, colors the badge by the most severe alert and blinks only on arrival", async () => {
  await using app = setup();
  state.mode = "off";
  state.dots = true;
  await app.render();
  complete("one");
  state.shells.set("two", shell({ hasPendingApprovals: true }));
  await app.render();
  expect(state.badge).toHaveBeenLastCalledWith(2, { kind: "input", blink: true });
  state.shells.set("two", shell({ latestTurn: { ...thread.latestTurn, state: "error" } }));
  await app.render();
  expect(state.badge).toHaveBeenLastCalledWith(2, { kind: "failed", blink: true });
  complete("one", "2026-09-13T08:01:00Z");
  await app.render();
  expect(state.badge).toHaveBeenLastCalledWith(2, { kind: "failed", blink: false });
});

it("keeps the plain count badge while status dots are off, and redraws when toggled", async () => {
  await using app = setup();
  state.mode = "off";
  await app.render();
  state.shells.set("one", shell({ hasPendingApprovals: true }));
  await app.render();
  expect(state.badge).toHaveBeenLastCalledWith(1);
  state.dots = true;
  await app.render();
  expect(state.badge).toHaveBeenLastCalledWith(1, { kind: "input", blink: false });
  state.dots = false;
  await app.render();
  expect(state.badge).toHaveBeenLastCalledWith(1);
});

it.each(["focused", "archived"])("does not show visual alerts when %s", async (condition) => {
  await using app = setup();
  if (condition === "focused") focused = true;
  await app.render();
  complete();
  if (condition === "archived")
    state.shells.set(
      "one",
      shell({
        archivedAt: "2026-09-13T08:00:00Z",
        hasPendingApprovals: true,
      }),
    );
  await app.render();
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.badge.mock.calls.every(([count]) => count === 0)).toBe(true);
});

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "badges %s and clears when the window regains focus",
  async (flag) => {
    await using app = setup();
    await app.render();
    state.shells.set("one", shell({ [flag]: true }));
    await app.render();
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
  await using app = setup();
  state.hermes.set("two", null);
  await app.render();
  complete("one");
  await app.render();
  completeHermes();
  await app.render();
  expect(lastBadge()).toBe(2);
  const notification = TestNotification.sent.at(-1)!;
  expect(notification.options).toMatchObject({ body: "The report is ready.", silent: true });
  notification.dispatchEvent(new Event("click"));
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/hermes",
    search: { environmentId: "two", jobId: "job", runId: "run" },
  });
  state.environmentIds = ["one"];
  await app.render();
  expect(lastBadge()).toBe(1);
  window.dispatchEvent(new Event("focus"));
  expect(lastBadge()).toBe(0);
});

it("previews a focused Hermes completion without a badge and does not replay it on preference changes", async () => {
  await using app = setup();
  state.mode = "off";
  state.inApp = true;
  focused = true;
  state.hermes.set("two", null);
  await app.render();
  completeHermes();
  await app.render();
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
  await app.render();
  expect(state.toast).toHaveBeenCalledOnce();
  expect(state.reportHermes).toHaveBeenCalledOnce();
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.sound).not.toHaveBeenCalled();
});

it("observes completions while every alert is disabled without replaying them when enabled", async () => {
  await using app = setup();
  state.mode = "off";
  state.hermes.set("two", null);
  await app.render();
  completeHermes();
  await app.render();
  state.mode = "notifications";
  await app.render();
  expect(state.reportHermes).toHaveBeenCalledOnce();
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.toast).not.toHaveBeenCalled();
});

it.each(["off", "sound", "denied", "default", "focused"])(
  "does not show Hermes OS alerts when %s",
  async (condition) => {
    await using app = setup();
    if (condition === "off" || condition === "sound") state.mode = condition;
    if (condition === "focused") focused = true;
    if (condition === "denied" || condition === "default") TestNotification.permission = condition;
    state.hermes.set("two", null);
    await app.render();
    completeHermes();
    await app.render();
    expect(TestNotification.sent).toHaveLength(0);
    expect(state.toast).not.toHaveBeenCalled();
    // Background runs still mark the tab; only a focused window skips it.
    expect(lastBadge()).toBe(condition === "focused" ? 0 : 1);
  },
);

it("suppresses the current run's in-app alert but still plays sound and marks it seen", async () => {
  await using app = setup();
  state.mode = "notifications-and-sound";
  state.inApp = true;
  focused = true;
  state.location = {
    pathname: "/hermes",
    search: { environmentId: "two", jobId: "job", runId: "run" },
  };
  state.hermes.set("two", null);
  await app.render();
  completeHermes();
  await app.render();
  expect(state.toast).not.toHaveBeenCalled();
  expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
  expect(state.markHermesSeen).toHaveBeenCalledWith("two");
  expect(TestNotification.sent).toHaveLength(0);
});

it("falls back to execution errors for legacy completions and treats hidden windows as unfocused", async () => {
  await using app = setup();
  state.inApp = true;
  state.dots = true;
  focused = true;
  visibility = "hidden";
  state.hermes.set("two", null);
  await app.render();
  state.hermes.set("two", {
    jobId: HermesCronJobId.make("job"),
    jobName: "Report",
    runId: "run",
    status: "failed",
    finishedAt: null,
    error: "Provider unavailable",
  });
  await app.render();
  expect(TestNotification.sent.at(-1)?.options.body).toBe("Provider unavailable");
  expect(state.toast).not.toHaveBeenCalled();
  expect(state.badge).toHaveBeenLastCalledWith(1, { kind: "failed", blink: true });
});
