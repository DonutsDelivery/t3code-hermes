/**
 * The Paperclip surface's server side, against fixtures shaped like a live Paperclip's answers.
 * What matters here is the panel's honesty: an unconfigured, offline, or rejected key each renders
 * its own sentence, a viewer key is reported as read-only, and only `GET`s ever leave this service.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSettings from "../../serverSettings.ts";
import * as PaperclipService from "./PaperclipService.ts";

const COMPANY_ID = "1f11f756-9f68-452d-94a6-d3360ea9d2d1";
const AERIS = "108af42e-1b99-4924-b0de-ce62331fcf01";
const PENTECOST = "2384d228-6cdb-4cab-b545-14f628c1f353";
const KEY = "pcp_board_test";

const ME = {
  user: { id: "u1", name: "T3-Viewer", email: "viewer@example.com" },
  userId: "u1",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, membershipRole: "viewer", status: "active" }],
  source: "board_key",
  keyId: "k1",
};

const COMPANY = {
  id: COMPANY_ID,
  name: "SpacetimeEngineering",
  description: null,
  status: "active",
  issuePrefix: "SPA",
  issueCounter: 1,
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  createdAt: "2026-10-02T15:22:28.754Z",
};

const AGENTS = [
  {
    id: AERIS,
    name: "AERIS",
    title: "Project Manager",
    role: "general",
    status: "paused",
    adapterType: "hermes_local",
    adapterConfig: { env: { SOME_TOKEN: "must-not-cross-the-wire" } },
    reportsTo: null,
    lastHeartbeatAt: null,
    pauseReason: "manual",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    urlKey: "aeris",
  },
  {
    id: PENTECOST,
    name: "Pentecost",
    title: "Lead Engineer",
    role: "ceo",
    status: "idle",
    adapterType: "claude_local",
    reportsTo: AERIS,
    lastHeartbeatAt: null,
    pauseReason: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    urlKey: "pentecost",
  },
  // Paperclip changed this row's shape; it is dropped, not the roster.
  { id: "broken", name: 42 },
];

const issue = (identifier: string, status: string, lastActivityAt: string) => ({
  id: `issue-${identifier}`,
  identifier,
  title: `Work on ${identifier}`,
  status,
  priority: "medium",
  assigneeAgentId: PENTECOST,
  assigneeUserId: null,
  projectId: null,
  parentId: null,
  updatedAt: lastActivityAt,
  lastActivityAt,
  activeRun: status === "in_progress" ? { id: "run-1" } : null,
  description: "long body the panel never needs",
});

const ISSUES = [
  issue("SPA-1", "done", "2026-10-16T12:00:00.000Z"),
  issue("SPA-2", "blocked", "2026-10-02T16:13:45.982Z"),
  issue("SPA-3", "in_progress", "2026-10-15T09:00:00.000Z"),
];

const DASHBOARD = {
  companyId: COMPANY_ID,
  agents: { active: 1, running: 0, paused: 1, error: 0 },
  tasks: { open: 1, inProgress: 1, blocked: 1, done: 1 },
  costs: { monthSpendCents: 120, monthBudgetCents: 0, monthUtilizationPercent: 0 },
  pendingApprovals: 0,
  budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
  runActivity: [],
};

const RUNS = [
  {
    id: "run-1",
    agentId: PENTECOST,
    issueId: "issue-SPA-3",
    status: "failed",
    invocationSource: "assignment",
    startedAt: "2026-10-15T09:00:00.000Z",
    finishedAt: "2026-10-15T09:05:00.000Z",
    error: "adapter exited 1\nfull stderr tail follows",
  },
];

const ACTIVITY = [
  {
    id: "a1",
    companyId: COMPANY_ID,
    actorType: "user",
    actorId: "u1",
    action: "issue.updated",
    entityType: "issue",
    entityId: "issue-SPA-2",
    details: { secretish: "never forwarded" },
    createdAt: "2026-10-16T21:46:21.060Z",
  },
];

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
}

type Route = {
  readonly match: (url: string) => boolean;
  readonly status?: number;
  readonly body?: unknown;
};

const HAPPY: ReadonlyArray<Route> = [
  { match: (url) => url.endsWith("/api/cli-auth/me"), body: ME },
  { match: (url) => url.includes("/dashboard"), body: DASHBOARD },
  { match: (url) => url.includes("/agents"), body: AGENTS },
  { match: (url) => url.includes("/projects"), body: [] },
  { match: (url) => url.includes("/issues"), body: ISSUES },
  { match: (url) => url.includes("/heartbeat-runs"), body: RUNS },
  { match: (url) => url.includes("/activity"), body: ACTIVITY },
  { match: (url) => url.endsWith(`/api/companies/${COMPANY_ID}`), body: COMPANY },
];

function stubHttp(routes: ReadonlyArray<Route>, recorded: Array<Recorded>) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      recorded.push({
        method: request.method,
        url: request.url,
        authorization: request.headers["authorization"],
      });
      const route = routes.find((candidate) => candidate.match(request.url));
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          route === undefined
            ? new Response("not found", { status: 404 })
            : Response.json(route.body ?? {}, { status: route.status ?? 200 }),
        ),
      );
    }),
  );
}

const offlineHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.fail(new Error("connect ECONNREFUSED") as never)),
);

function withService(
  settings: Record<string, unknown> | undefined,
  http: Layer.Layer<HttpClient.HttpClient>,
) {
  return PaperclipService.layer.pipe(
    Layer.provide(
      ServerSettings.layerTest(
        settings === undefined ? {} : { integrations: { paperclip: settings } },
      ),
    ),
    Layer.provide(http),
  );
}

const CONFIGURED = { enabled: true, baseUrl: "http://100.120.104.23:3100/", apiKey: KEY };

const overview = Effect.gen(function* () {
  const service = yield* PaperclipService.PaperclipService;
  return yield* service.overview({});
});

describe("PaperclipService", () => {
  it.effect("reads nothing until it is switched on with a URL and a key", () => {
    const recorded: Array<Recorded> = [];
    return Effect.gen(function* () {
      const off = yield* overview.pipe(
        Effect.provide(withService(undefined, stubHttp(HAPPY, recorded))),
      );
      expect(off.status.availability).toBe("notConfigured");
      expect(off.status.detail).toContain("turned off");

      const noKey = yield* overview.pipe(
        Effect.provide(
          withService({ enabled: true, baseUrl: CONFIGURED.baseUrl }, stubHttp(HAPPY, recorded)),
        ),
      );
      expect(noKey.status.availability).toBe("notConfigured");
      expect(noKey.status.detail).toContain("API key");
      expect(recorded).toHaveLength(0);
    });
  });

  it.effect("shows the whole company, open work first, through GETs only", () => {
    const recorded: Array<Recorded> = [];
    return Effect.gen(function* () {
      const result = yield* overview.pipe(
        Effect.provide(withService(CONFIGURED, stubHttp(HAPPY, recorded))),
      );
      expect(result.status.availability).toBe("ready");
      expect(result.viewer).toEqual({
        name: "T3-Viewer",
        role: "viewer",
        isInstanceAdmin: false,
        readOnly: true,
      });
      expect(result.company?.issuePrefix).toBe("SPA");
      expect(result.agents.map((agent) => agent.name)).toEqual(["AERIS", "Pentecost"]);
      expect(result.agents[1]?.reportsTo).toBe(AERIS);
      expect(result.issues.map((entry) => entry.identifier)).toEqual(["SPA-2", "SPA-3", "SPA-1"]);
      expect(result.issues[1]?.hasActiveRun).toBe(true);
      expect(result.runs[0]?.error).toBe("adapter exited 1");
      expect(result.dashboard?.monthSpendCents).toBe(120);
      expect(result.webUrl).toBe("http://100.120.104.23:3100/SPA");

      // Agent config and activity details stay on the server.
      const wire = JSON.stringify(result);
      expect(wire).not.toContain("must-not-cross-the-wire");
      expect(wire).not.toContain("never forwarded");
      expect(wire).not.toContain("long body");

      expect(new Set(recorded.map((request) => request.method))).toEqual(new Set(["GET"]));
      expect(recorded.every((request) => request.authorization === `Bearer ${KEY}`)).toBe(true);
      expect(
        recorded.every((request) => request.url.startsWith("http://100.120.104.23:3100/api/")),
      ).toBe(true);
    });
  });

  it.effect("says the key was rejected rather than showing an empty company", () =>
    Effect.gen(function* () {
      const result = yield* overview.pipe(
        Effect.provide(
          withService(
            CONFIGURED,
            stubHttp([{ match: () => true, status: 401, body: { error: "Unauthorized" } }], []),
          ),
        ),
      );
      expect(result.status.availability).toBe("unauthorized");
      expect(result.status.detail).toContain("rejected the API key");
      expect(result.webUrl).toBe("http://100.120.104.23:3100");
    }),
  );

  it.effect("says Paperclip is offline when nothing answers", () =>
    Effect.gen(function* () {
      const result = yield* overview.pipe(Effect.provide(withService(CONFIGURED, offlineHttp)));
      expect(result.status.availability).toBe("offline");
      expect(result.agents).toEqual([]);
    }),
  );

  it.effect("refuses a configured company the key cannot see", () =>
    Effect.gen(function* () {
      const result = yield* overview.pipe(
        Effect.provide(
          withService({ ...CONFIGURED, companyId: "other-company" }, stubHttp(HAPPY, [])),
        ),
      );
      expect(result.status.availability).toBe("requestFailed");
      expect(result.status.detail).toContain("cannot see the company");
    }),
  );

  it.effect("keeps the overview when an optional list fails", () =>
    Effect.gen(function* () {
      const result = yield* overview.pipe(
        Effect.provide(
          withService(
            CONFIGURED,
            stubHttp(
              [{ match: (url) => url.includes("/heartbeat-runs"), status: 403 }, ...HAPPY],
              [],
            ),
          ),
        ),
      );
      expect(result.status.availability).toBe("ready");
      expect(result.runs).toEqual([]);
      expect(result.agents).toHaveLength(2);
    }),
  );
});
