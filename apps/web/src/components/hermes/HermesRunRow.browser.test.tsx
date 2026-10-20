import {
  EnvironmentId,
  HermesCronJobId,
  type HermesCronJob,
  type HermesCronRun,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../../test/render";

const state = vi.hoisted(() => ({ getOutput: vi.fn(), jobs: [] as HermesCronJob[] }));
vi.mock("../../state/server", () => ({ serverEnvironment: { hermesCronGetRunOutput: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.getOutput }));
vi.mock("../../state/hermesCron", () => ({
  useHermesCron: (environmentId: EnvironmentId) => ({
    environmentId,
    jobs: state.jobs,
    isPending: false,
    error: null,
    emptyState: null,
    view: { snapshot: { runHistoryAvailable: true } },
    setEnabled: vi.fn(),
    setMuted: vi.fn(),
  }),
}));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));

import { HermesRunRow } from "./HermesRunRow";
import { HermesTasksTab } from "./HermesTasksTab";

const environmentId = EnvironmentId.make("remote");
const run: HermesCronRun = {
  id: "run",
  jobId: HermesCronJobId.make("job"),
  status: "completed",
  source: null,
  claimedAt: null,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  error: null,
  delivery: {
    preview: "Short preview",
    contentAvailable: true,
    truncated: true,
    source: "session",
    targets: ["local"],
    status: "unrecorded",
    error: null,
  },
};
// The mocked modules read `state`, so every test resets it before rendering.
function setup() {
  state.getOutput.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { content: "Full report", truncated: false, source: "session" },
  });
  state.jobs = [
    {
      id: run.jobId,
      name: "Report",
      scheduleDisplay: "daily",
      state: "scheduled",
      enabled: true,
      nextRunAt: null,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      deliver: ["local"],
      muted: false,
      runs: [run],
    },
  ];
}

function click(screen: Screen, label: string) {
  const element = screen.container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  expect(element).not.toBeNull();
  return act(() => element!.click());
}

it("fetches full output only when a run is expanded, not when task history opens", async () => {
  setup();
  await using screen = await render(
    <HermesTasksTab environmentId={environmentId} onNewTask={vi.fn()} target={{ environmentId }} />,
  );
  expect(state.getOutput).not.toHaveBeenCalled();
  await click(screen, "Expand task Report");
  expect(state.getOutput).not.toHaveBeenCalled();
  await click(screen, "Run run: completed");
  expect(state.getOutput).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { jobId: run.jobId, runId: "run" },
  });
  expect(screen.container.textContent).toContain("Full report");
  await click(screen, "Run run: completed");
  expect(screen.container.textContent).not.toContain("Full report");
  expect(state.getOutput).toHaveBeenCalledTimes(1);
});

it("opens the targeted task and run immediately on its owning environment", async () => {
  setup();
  await using screen = await render(
    <HermesTasksTab
      environmentId={environmentId}
      onNewTask={vi.fn()}
      target={{ environmentId, jobId: run.jobId, runId: "run" }}
    />,
  );
  expect(state.getOutput).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { jobId: run.jobId, runId: "run" },
  });
  expect(screen.container.textContent).toContain("Full report");
});

it("does not fetch unavailable output or claim unrecorded session output was delivered", async () => {
  const unavailable = { ...run, delivery: { ...run.delivery!, contentAvailable: false } };
  setup();
  await using screen = await render(
    <HermesRunRow run={unavailable} environmentId={environmentId} targeted />,
  );
  expect(state.getOutput).not.toHaveBeenCalled();
  expect(screen.container.textContent).toContain("No recorded output is available");
  expect(screen.container.textContent).toContain("not recorded");
});

it("offers retry after a failed request and reports truncated full output", async () => {
  setup();
  state.getOutput.mockResolvedValueOnce({ _tag: "Failure" }).mockResolvedValueOnce({
    _tag: "Success",
    value: { content: "Partial report", truncated: true, source: "delivery" },
  });
  await using screen = await render(
    <HermesRunRow run={run} environmentId={environmentId} targeted />,
  );
  expect(screen.container.textContent).toContain("Could not load");
  const retry = Array.from(screen.container.querySelectorAll("button")).find(
    (button) => button.textContent === "Retry",
  );
  expect(retry).toBeDefined();
  await act(() => retry!.click());
  expect(state.getOutput).toHaveBeenCalledTimes(2);
  expect(screen.container.textContent).toContain("Partial report");
  expect(screen.container.textContent).toContain("Output truncated to the display limit.");
});
