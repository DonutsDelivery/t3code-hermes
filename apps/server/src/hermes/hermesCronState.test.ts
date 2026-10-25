// @effect-diagnostics nodeBuiltinImport:off
/**
 * These tests are the tripwire for a Hermes upgrade.
 * The run-ledger cases build a real SQLite database from the DDL Hermes itself executes, and the
 * job cases start from the full record `create_job` writes. If Hermes changes either shape, these
 * fail here rather than in someone's Tasks panel. See `hermesCronFixtures.ts`.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";

import {
  HERMES_EXECUTIONS_DDL,
  makeHermesExecutionRow,
  makeHermesJobRecord,
  makeHermesJobsFile,
} from "./hermesCronFixtures.ts";
import {
  effectiveJobState,
  groupRunsByJob,
  parseHermesCronJobs,
  readHermesCronRuns,
  resolveEnabledHermesInstance,
  resolveHermesCronPaths,
} from "./hermesCronState.ts";

function withExecutionsDb(
  rows: readonly Record<string, unknown>[],
  run: (dbPath: string) => void,
): void {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-cron-"));
  const dbPath = NodePath.join(dir, "executions.db");
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    database.exec(HERMES_EXECUTIONS_DDL);
    const insert = database.prepare(`
      INSERT INTO executions
        (id, job_id, source, process_id, pid, process_started_at,
         status, claimed_at, started_at, finished_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        row["id"] as string,
        row["job_id"] as string,
        row["source"] as string,
        row["process_id"] as string,
        row["pid"] as number,
        row["process_started_at"] as number,
        row["status"] as string,
        row["claimed_at"] as string,
        (row["started_at"] ?? null) as string | null,
        (row["finished_at"] ?? null) as string | null,
        (row["error"] ?? null) as string | null,
      );
    }
    database.close();
    run(dbPath);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

describe("resolveHermesCronPaths", () => {
  it("prefers HERMES_HOME over the home directory", () => {
    const paths = resolveHermesCronPaths({ HERMES_HOME: "/srv/hermes" }, "/home/dev");
    expect(paths.jobsFile).toBe(NodePath.join("/srv/hermes", "cron", "jobs.json"));
    expect(paths.executionsDb).toBe(NodePath.join("/srv/hermes", "cron", "executions.db"));
  });

  it("falls back to ~/.hermes when HERMES_HOME is blank", () => {
    const paths = resolveHermesCronPaths({ HERMES_HOME: "   " }, "/home/dev");
    expect(paths.home).toBe(NodePath.join("/home/dev", ".hermes"));
  });
});

describe("resolveEnabledHermesInstance", () => {
  const hermes = ProviderDriverKind.make("hermes");
  const withInstances = (
    providerInstances: ServerSettings["providerInstances"],
  ): ServerSettings => ({ ...DEFAULT_SERVER_SETTINGS, providerInstances });

  it("is null when Hermes was never switched on", () => {
    expect(resolveEnabledHermesInstance(DEFAULT_SERVER_SETTINGS)).toBeNull();
  });

  it("honours the explicit instance the Settings switch writes", () => {
    const settings = withInstances({
      [ProviderInstanceId.make("hermes")]: {
        driver: hermes,
        enabled: true,
        config: { binaryPath: "/opt/hermes" },
      },
    });
    expect(resolveEnabledHermesInstance(settings)?.settings.binaryPath).toBe("/opt/hermes");
  });

  it("prefers the default slot over an enabled custom instance", () => {
    const settings = withInstances({
      [ProviderInstanceId.make("hermes-box")]: {
        driver: hermes,
        enabled: true,
        config: { binaryPath: "/srv/hermes" },
      },
      [ProviderInstanceId.make("hermes")]: {
        driver: hermes,
        enabled: true,
        config: { binaryPath: "/opt/hermes" },
      },
    });
    expect(resolveEnabledHermesInstance(settings)?.instanceId).toBe("hermes");
  });

  it("uses an enabled custom instance when the default slot is off", () => {
    const settings = withInstances({
      [ProviderInstanceId.make("hermes-box")]: {
        driver: hermes,
        enabled: true,
        config: { binaryPath: "/srv/hermes" },
      },
    });
    expect(resolveEnabledHermesInstance(settings)?.settings.binaryPath).toBe("/srv/hermes");
  });

  it("carries the instance environment so cron follows its HERMES_HOME", () => {
    const environment = [{ name: "HERMES_HOME", value: "/srv/hermes-home", sensitive: false }];
    const settings = withInstances({
      [ProviderInstanceId.make("hermes-box")]: { driver: hermes, enabled: true, environment },
    });
    const instance = resolveEnabledHermesInstance(settings);
    expect(instance?.environment).toEqual(environment);
  });

  it("respects an explicit disable of the default slot", () => {
    const settings = withInstances({
      [ProviderInstanceId.make("hermes")]: {
        driver: hermes,
        enabled: false,
        config: { enabled: true },
      },
    });
    expect(resolveEnabledHermesInstance(settings)).toBeNull();
  });
});

describe("parseHermesCronJobs", () => {
  it('reads the canonical {"jobs": [...]} wrapper Hermes writes', () => {
    const jobs = parseHermesCronJobs(JSON.parse(makeHermesJobsFile([makeHermesJobRecord()])));
    expect(jobs).not.toBeNull();
    expect(jobs).toHaveLength(1);
    expect(jobs?.[0]).toMatchObject({
      id: "job-1",
      name: "Morning digest",
      scheduleDisplay: "every day at 09:00",
      state: "scheduled",
      enabled: true,
      nextRunAt: "2026-08-17T09:00:00Z",
      deliver: ["local"],
    });
  });

  it("accepts the bare array Hermes auto-repairs on its next write", () => {
    const jobs = parseHermesCronJobs([makeHermesJobRecord({ id: "job-2" })]);
    expect(jobs).toHaveLength(1);
    expect(jobs?.[0]?.id).toBe("job-2");
  });

  it("returns null for a payload that is neither shape", () => {
    expect(parseHermesCronJobs("corrupted")).toBeNull();
    expect(parseHermesCronJobs(42)).toBeNull();
  });

  it("skips records with no id rather than failing the whole read", () => {
    const jobs = parseHermesCronJobs({
      jobs: [makeHermesJobRecord({ id: "" }), makeHermesJobRecord({ id: "job-ok" })],
    });
    expect(jobs?.map((job) => job.id)).toEqual(["job-ok"]);
  });

  it("falls back through the schedule object when schedule_display is absent", () => {
    const jobs = parseHermesCronJobs({
      jobs: [
        makeHermesJobRecord({
          schedule_display: null,
          schedule: { type: "interval", value: "30m" },
        }),
      ],
    });
    expect(jobs?.[0]?.scheduleDisplay).toBe("30m");
  });

  it("coalesces a null deliver to local instead of crashing the listing", () => {
    const jobs = parseHermesCronJobs({ jobs: [makeHermesJobRecord({ deliver: null })] });
    expect(jobs?.[0]?.deliver).toEqual(["local"]);
  });

  it("accepts a bare string deliver target", () => {
    const jobs = parseHermesCronJobs({ jobs: [makeHermesJobRecord({ deliver: "telegram" })] });
    expect(jobs?.[0]?.deliver).toEqual(["telegram"]);
  });

  it("bounds an overlong last_error", () => {
    const jobs = parseHermesCronJobs({
      jobs: [makeHermesJobRecord({ last_error: "x".repeat(1000) })],
    });
    expect(jobs?.[0]?.lastError?.length).toBe(401);
    expect(jobs?.[0]?.lastError?.endsWith("…")).toBe(true);
  });
});

describe("effectiveJobState", () => {
  it("treats enabled as authoritative so a stale paused label reads as scheduled", () => {
    expect(effectiveJobState({ enabled: true, state: "paused", paused_at: "2026-08-01" })).toBe(
      "scheduled",
    );
  });

  it("reports paused when disabled with a pause marker", () => {
    expect(effectiveJobState({ enabled: false, state: "paused" })).toBe("paused");
    expect(effectiveJobState({ enabled: false, paused_at: "2026-08-01" })).toBe("paused");
  });

  it("defaults a disabled job with no marker to paused", () => {
    expect(effectiveJobState({ enabled: false })).toBe("paused");
  });

  it("preserves terminal states regardless of enabled", () => {
    expect(effectiveJobState({ enabled: true, state: "completed" })).toBe("completed");
    expect(effectiveJobState({ enabled: false, state: "error" })).toBe("error");
  });

  it("defaults a record with no state at all to scheduled", () => {
    expect(effectiveJobState({})).toBe("scheduled");
  });
});

describe("readHermesCronRuns", () => {
  it("reads runs newest first and derives duration from the recorded ends", () => {
    withExecutionsDb(
      [
        makeHermesExecutionRow({
          id: "exec-1",
          claimed_at: "2026-08-16T09:00:00Z",
          started_at: "2026-08-16T09:00:01Z",
          finished_at: "2026-08-16T09:00:31Z",
        }),
        makeHermesExecutionRow({
          id: "exec-2",
          claimed_at: "2026-08-16T10:00:00Z",
          status: "failed",
          started_at: "2026-08-16T10:00:01Z",
          finished_at: "2026-08-16T10:00:04Z",
          error: "provider timeout",
        }),
      ],
      (dbPath) => {
        const runs = readHermesCronRuns(dbPath, ["job-1"]);
        expect(runs?.map((run) => run.id)).toEqual(["exec-2", "exec-1"]);
        expect(runs?.[0]).toMatchObject({
          status: "failed",
          error: "provider timeout",
          durationMs: 3_000,
        });
        expect(runs?.[1]?.durationMs).toBe(30_000);
      },
    );
  });

  it("leaves duration null for an attempt that never finished", () => {
    withExecutionsDb(
      [makeHermesExecutionRow({ status: "running", finished_at: null, error: null })],
      (dbPath) => {
        const runs = readHermesCronRuns(dbPath, ["job-1"]);
        expect(runs?.[0]).toMatchObject({ status: "running", durationMs: null });
      },
    );
  });

  it("only returns runs for the requested jobs", () => {
    withExecutionsDb(
      [
        makeHermesExecutionRow({ id: "exec-1", job_id: "job-1" }),
        makeHermesExecutionRow({ id: "exec-2", job_id: "job-2" }),
      ],
      (dbPath) => {
        const runs = readHermesCronRuns(dbPath, ["job-2"]);
        expect(runs?.map((run) => run.id)).toEqual(["exec-2"]);
      },
    );
  });

  it("returns null when the ledger does not exist yet", () => {
    expect(readHermesCronRuns("/nonexistent/executions.db", ["job-1"])).toBeNull();
  });

  it("caps history per job so a busy job cannot crowd a quiet one out", () => {
    // job-1 is busy (25 runs); job-2 is quiet (2 runs). The global LIMIT would
    // have filled the whole page with job-1's newest runs and dropped job-2's
    // entirely; per-job limiting must keep both.
    const rows: Record<string, unknown>[] = [];
    for (let index = 0; index < 25; index += 1) {
      rows.push(
        makeHermesExecutionRow({
          id: `busy-${String(index).padStart(2, "0")}`,
          job_id: "job-1",
          claimed_at: `2026-08-16T${String(index).padStart(2, "0")}:00:00Z`,
        }),
      );
    }
    rows.push(
      makeHermesExecutionRow({
        id: "quiet-latest",
        job_id: "job-2",
        claimed_at: "2026-08-16T12:00:00Z",
      }),
      makeHermesExecutionRow({
        id: "quiet-older",
        job_id: "job-2",
        claimed_at: "2026-08-16T11:00:00Z",
      }),
    );

    withExecutionsDb(rows, (dbPath) => {
      const runs = readHermesCronRuns(dbPath, ["job-1", "job-2"], 20) ?? [];
      const busyRuns = runs.filter((run) => run.jobId === "job-1");
      const quietRuns = runs.filter((run) => run.jobId === "job-2");

      // The quiet job keeps its runs, newest first.
      expect(quietRuns.map((run) => run.id)).toEqual(["quiet-latest", "quiet-older"]);
      // The busy job is capped at its own newest 20, not the global total.
      expect(busyRuns).toHaveLength(20);
      expect(busyRuns[0]?.id).toBe("busy-24");
      expect(busyRuns[19]?.id).toBe("busy-05");
      expect(runs.some((run) => run.id === "busy-00")).toBe(false);
    });
  });

  it("returns an empty list without opening anything when there are no jobs", () => {
    expect(readHermesCronRuns("/nonexistent/executions.db", [])).toEqual([]);
  });
});

describe("groupRunsByJob", () => {
  it("caps history per job while preserving order", () => {
    const runs = [
      { jobId: "a", id: "a3" },
      { jobId: "a", id: "a2" },
      { jobId: "b", id: "b1" },
      { jobId: "a", id: "a1" },
    ] as never;
    const grouped = groupRunsByJob(runs, 2);
    expect(grouped.get("a")?.map((run) => run.id)).toEqual(["a3", "a2"]);
    expect(grouped.get("b")?.map((run) => run.id)).toEqual(["b1"]);
  });
});
