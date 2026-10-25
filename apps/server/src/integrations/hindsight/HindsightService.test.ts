/**
 * Tripwire for Hindsight upgrades: fixtures from its OpenAPI document make renamed or reshaped
 * fields fail here. Also pins never-configured vs. not-answering, which have different next
 * actions.
 */
import { describe, expect, it } from "@effect/vitest";
import { HindsightBankId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";

import * as ServerSettings from "../../serverSettings.ts";
import { resolveHermesHindsightPaths } from "./hermesHindsightConfig.ts";
import * as HindsightService from "./HindsightService.ts";
import {
  HINDSIGHT_BANKS_RESPONSE,
  HINDSIGHT_BANK_STATS_RESPONSE,
  HINDSIGHT_LIST_MEMORIES_RESPONSE,
  HINDSIGHT_MENTAL_MODELS_RESPONSE,
  HINDSIGHT_RECALL_RESPONSE,
  HINDSIGHT_REFLECT_RESPONSE,
  HINDSIGHT_RETAIN_RESPONSE,
  HINDSIGHT_VERSION_RESPONSE,
} from "./hindsightFixtures.ts";

const BANK = HindsightBankId.make("hermes");

const BASE_URL = "http://127.0.0.1:8888";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  /** Query string, which the client keeps separate from `url` until it sends. */
  readonly params: string;
  readonly authorization: string | undefined;
}

/**
 * An HTTP layer that answers from a routing table and records what it was
 * asked, so a test can assert on the path and headers as well as the result.
 */
function stubHttp(
  routes: ReadonlyArray<{
    readonly match: (url: string) => boolean;
    readonly status?: number;
    readonly body?: unknown;
  }>,
  recorded: Array<RecordedRequest>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      recorded.push({
        method: request.method,
        url: request.url,
        params: UrlParams.toString(request.urlParams),
        authorization: request.headers["authorization"],
      });
      const route = routes.find((candidate) => candidate.match(request.url));
      if (route === undefined) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("not found", { status: 404 })),
        );
      }
      const status = route.status ?? 200;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          status === 204
            ? new Response(null, { status })
            : Response.json(route.body ?? {}, { status }),
        ),
      );
    }),
  );
}

/** Where the service looks for Hermes' Hindsight config in this process. */
const HERMES_CONFIG_PATH = resolveHermesHindsightPaths(process.env).configFiles[0]!;

/**
 * The layer under test, with settings, HTTP and the files Hermes keeps all
 * supplied by the caller. No test reads the real Hermes install.
 */
function withService(options: {
  readonly settings?: {
    readonly enabled?: boolean;
    readonly baseUrl?: string;
    readonly apiKey?: string;
    readonly defaultBank?: string;
  };
  readonly files?: Readonly<Record<string, string>>;
  readonly http: Layer.Layer<HttpClient.HttpClient>;
}) {
  const settingsLayer =
    options.settings === undefined
      ? ServerSettings.layerTest({})
      : ServerSettings.layerTest({ integrations: { hindsight: options.settings } });
  const files = options.files ?? {};
  const missing = FileSystem.makeNoop({});
  const fileSystemLayer = FileSystem.layerNoop({
    readFileString: (path) => {
      const contents = files[path];
      return contents === undefined ? missing.readFileString(path) : Effect.succeed(contents);
    },
  });
  return HindsightService.layer.pipe(
    Layer.provide(settingsLayer),
    Layer.provide(options.http),
    Layer.provide(fileSystemLayer),
  );
}

/** Answers every endpoint this suite touches from the transcribed fixtures. */
const HAPPY_ROUTES = [
  { match: (url: string) => url.endsWith("/version"), body: HINDSIGHT_VERSION_RESPONSE },
  { match: (url: string) => url.endsWith("/v1/default/banks"), body: HINDSIGHT_BANKS_RESPONSE },
  {
    match: (url: string) => url.includes("/memories/list"),
    body: HINDSIGHT_LIST_MEMORIES_RESPONSE,
  },
  { match: (url: string) => url.includes("/memories/recall"), body: HINDSIGHT_RECALL_RESPONSE },
  {
    match: (url: string) => url.includes("/mental-models"),
    body: HINDSIGHT_MENTAL_MODELS_RESPONSE,
  },
  {
    match: (url: string) => url.endsWith("/memories") && !url.includes("/list"),
    body: HINDSIGHT_RETAIN_RESPONSE,
  },
  { match: (url: string) => url.endsWith("/reflect"), body: HINDSIGHT_REFLECT_RESPONSE },
  { match: (url: string) => url.endsWith("/stats"), body: HINDSIGHT_BANK_STATS_RESPONSE },
] as const;

describe("HindsightService", () => {
  describe("when Hermes has its own Hindsight config", () => {
    const HERMES_URL = "http://100.64.0.7:8888";
    const hermesFiles = {
      [HERMES_CONFIG_PATH]: JSON.stringify({
        mode: "local_external",
        api_url: HERMES_URL,
        bank_id: "hermes",
        api_key: "hermes-key",
      }),
    };

    it.effect("uses it with nothing set in T3 Code settings", () => {
      const recorded: Array<RecordedRequest> = [];
      return Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight.listBanks({});
        expect(result.status.availability).toBe("ready");
        expect(result.defaultBank).toBe("hermes");
        expect(result.connection).toEqual({
          source: "hermes",
          baseUrl: HERMES_URL,
          hasApiKey: true,
        });
        expect(result.hermes).toMatchObject({ configPath: HERMES_CONFIG_PATH, bank: "hermes" });
        expect(recorded.every((request) => request.url.startsWith(HERMES_URL))).toBe(true);
        expect(recorded[0]?.authorization).toBe("Bearer hermes-key");
      }).pipe(
        Effect.provide(withService({ files: hermesFiles, http: stubHttp(HAPPY_ROUTES, recorded) })),
      );
    });

    it.effect("is overridden by a URL in settings, which never receives Hermes' key", () => {
      const recorded: Array<RecordedRequest> = [];
      return Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight.listBanks({});
        expect(result.connection).toEqual({
          source: "settings",
          baseUrl: BASE_URL,
          hasApiKey: false,
        });
        expect(recorded.length).toBeGreaterThan(0);
        expect(recorded.every((request) => request.url.startsWith(BASE_URL))).toBe(true);
        expect(recorded.every((request) => request.authorization === undefined)).toBe(true);
      }).pipe(
        Effect.provide(
          withService({
            settings: { baseUrl: BASE_URL },
            files: hermesFiles,
            http: stubHttp(HAPPY_ROUTES, recorded),
          }),
        ),
      );
    });

    it.effect("stays unused when Memory is switched off, but is still reported", () =>
      Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight.listBanks({});
        expect(result.status.availability).toBe("notConfigured");
        expect(result.status.detail).toBe("Memory is turned off for this environment.");
        expect(result.connection).toBeNull();
        expect(result.hermes?.baseUrl).toBe(HERMES_URL);
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: false },
            files: hermesFiles,
            http: Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("a switched-off Hindsight must not open a socket")),
            ),
          }),
        ),
      ),
    );
  });

  describe("when Hindsight is not configured", () => {
    const notConfigured = withService({
      http: Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("an unconfigured Hindsight must not open a socket")),
      ),
    });

    it.effect("reports notConfigured on reads instead of failing", () =>
      Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const banks = yield* hindsight.listBanks({});
        expect(banks.status.availability).toBe("notConfigured");
        expect(banks.banks).toEqual([]);

        const browsed = yield* hindsight.browse({ bank: BANK, pathway: "all" });
        expect(browsed.status.availability).toBe("notConfigured");
        expect(browsed.memories).toEqual([]);
      }).pipe(Effect.provide(notConfigured)),
    );

    it.effect("fails writes with a notConfigured reason", () =>
      Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight.retain({ bank: BANK, text: "note" }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.reason).toBe("notConfigured");
        }
      }).pipe(Effect.provide(notConfigured)),
    );
  });

  describe("when Hindsight is configured but not answering", () => {
    const offlineHttp = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.fail(new Error("ECONNREFUSED") as never)),
    );
    const offline = withService({
      settings: { enabled: true, baseUrl: BASE_URL },
      http: offlineHttp,
    });

    it.effect("reports offline on reads, distinctly from notConfigured", () =>
      Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const banks = yield* hindsight.listBanks({});
        expect(banks.status.availability).toBe("offline");
        expect(banks.status.detail).toBeTruthy();

        const recalled = yield* hindsight.recall({ bank: BANK, pathway: "all", query: "node" });
        expect(recalled.status.availability).toBe("offline");
      }).pipe(Effect.provide(offline)),
    );

    it.effect("fails writes with an offline reason", () =>
      Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight
          .reflect({ bank: BANK, query: "anything" })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.reason).toBe("offline");
        }
      }).pipe(Effect.provide(offline)),
    );
  });

  describe("when Hindsight answers in a shape T3 Code does not understand", () => {
    it.effect("reports incompatible once, from the version probe", () =>
      Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const banks = yield* hindsight.listBanks({});
        expect(banks.status.availability).toBe("incompatible");
        expect(banks.status.apiVersion).toBeNull();
        expect(banks.status.targetApiVersion).toBe("0.9.1");
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL },
            http: stubHttp(
              [{ match: (url) => url.endsWith("/version"), body: { unexpected: true } }],
              [],
            ),
          }),
        ),
      ),
    );

    it.effect(
      "reports incompatible when the api_version major differs, keeping both versions",
      () =>
        Effect.gen(function* () {
          const hindsight = yield* HindsightService.HindsightService;
          const banks = yield* hindsight.listBanks({});
          expect(banks.status.availability).toBe("incompatible");
          expect(banks.status.apiVersion).toBe("1.0.0");
          expect(banks.status.detail).toContain("1.0.0");
          expect(banks.status.detail).toContain("0.9.1");
        }).pipe(
          Effect.provide(
            withService({
              settings: { enabled: true, baseUrl: BASE_URL },
              http: stubHttp(
                [{ match: (url) => url.endsWith("/version"), body: { api_version: "1.0.0" } }],
                [],
              ),
            }),
          ),
        ),
    );

    it.effect("treats a newer minor on the same major as ready", () =>
      Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const banks = yield* hindsight.listBanks({});
        expect(banks.status.availability).toBe("ready");
        expect(banks.status.apiVersion).toBe("0.9.2");
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL },
            http: stubHttp(
              [
                { match: (url) => url.endsWith("/version"), body: { api_version: "0.9.2" } },
                { match: (url) => url.endsWith("/banks"), body: HINDSIGHT_BANKS_RESPONSE },
              ],
              [],
            ),
          }),
        ),
      ),
    );

    it.effect("re-probes after an incompatible verdict, so a live upgrade recovers", () => {
      // The stub starts answering version 1.0.0 (incompatible) and then the
      // operator "upgrades" Hindsight to 0.9.1 between the first read and the
      // retry. The cache must not pin the incompatible verdict.
      let apiVersion = "1.0.0";
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          if (request.url.endsWith("/version")) {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ api_version: apiVersion }, { status: 200 }),
              ),
            );
          }
          if (request.url.endsWith("/banks")) {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(HINDSIGHT_BANKS_RESPONSE, { status: 200 }),
              ),
            );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("not found", { status: 404 })),
          );
        }),
      );
      return Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;

        const first = yield* hindsight.listBanks({});
        expect(first.status.availability).toBe("incompatible");

        apiVersion = "0.9.1";
        const second = yield* hindsight.listBanks({});
        expect(second.status.availability).toBe("ready");

        // The healthy verdict is then reused without another probe.
        const third = yield* hindsight.listBanks({});
        expect(third.status.availability).toBe("ready");
      }).pipe(
        Effect.provide(withService({ settings: { enabled: true, baseUrl: BASE_URL }, http })),
      );
    });
  });

  describe("when a read fails despite a healthy probe", () => {
    it.effect("reports requestFailed for an unknown bank instead of an empty list", () =>
      Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight.browse({
          bank: HindsightBankId.make("missing"),
          pathway: "all",
        });
        expect(result.status.availability).toBe("requestFailed");
        expect(result.status.detail).toContain("memory bank");
        expect(result.memories).toEqual([]);
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL },
            http: stubHttp(
              [
                { match: (url) => url.endsWith("/version"), body: HINDSIGHT_VERSION_RESPONSE },
                { match: (url) => url.includes("/banks/missing/"), status: 404 },
              ],
              [],
            ),
          }),
        ),
      ),
    );

    it.effect("reports requestFailed for an HTTP error mid-read", () =>
      Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight.recall({ bank: BANK, pathway: "world", query: "node" });
        expect(result.status.availability).toBe("requestFailed");
        expect(result.status.detail).toContain("500");
        expect(result.memories).toEqual([]);
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL },
            http: stubHttp(
              [
                { match: (url) => url.endsWith("/version"), body: HINDSIGHT_VERSION_RESPONSE },
                { match: (url) => url.includes("/memories/recall"), status: 500 },
              ],
              [],
            ),
          }),
        ),
      ),
    );
  });

  describe("against a healthy Hindsight", () => {
    it.effect("lists banks and honours a configured default", () =>
      Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight.listBanks({});
        expect(result.status.availability).toBe("ready");
        expect(result.status.apiVersion).toBe("0.9.1");
        expect(result.banks).toEqual([
          { id: "hermes", name: "Hermes", factCount: 128 },
          { id: "scratch", name: null, factCount: 0 },
        ]);
        expect(result.defaultBank).toBe("hermes");
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL, defaultBank: "hermes" },
            http: stubHttp(HAPPY_ROUTES, []),
          }),
        ),
      ),
    );

    it.effect("drops a configured default bank that no longer exists", () =>
      Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight.listBanks({});
        expect(result.defaultBank).toBeNull();
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL, defaultBank: "deleted-bank" },
            http: stubHttp(HAPPY_ROUTES, []),
          }),
        ),
      ),
    );

    it.effect("browses memory units and mental models together, newest first", () =>
      Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight.browse({ bank: BANK, pathway: "all" });

        expect(result.status.availability).toBe("ready");
        expect(result.memories.map((memory) => memory.pathway)).toEqual([
          // 2026-08-15 mental model, then 08-14 world, then 08-13 experience.
          "mentalModel",
          "world",
          "experience",
        ]);

        const world = result.memories[1];
        expect(world?.text).toBe("T3 Code's server runs TypeScript directly under Node 24.");
        // `entities` arrives comma-joined from this endpoint, not as an array.
        expect(world?.entities).toEqual(["T3 Code", "Node"]);
        expect(world?.tags).toEqual(["t3code"]);
        expect(world?.rememberedAt).toBe("2026-08-14T11:00:00Z");
        // Browsing is chronological, so there is no score to claim.
        expect(world?.confidence).toBeNull();

        const model = result.memories[0];
        expect(model?.title).toBe("How this fork tracks upstream");
        expect(model?.text).toBe("Merge-based, never rebase, nightly at 05:30 UTC.");
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL },
            http: stubHttp(HAPPY_ROUTES, []),
          }),
        ),
      ),
    );

    it.effect("filters browse to one pathway and skips the mental-model call", () => {
      const recorded: Array<RecordedRequest> = [];
      return Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        yield* hindsight.browse({ bank: BANK, pathway: "world" });

        const listCall = recorded.find((request) => request.url.includes("/memories/list"));
        expect(listCall?.params).toContain("type=world");
        expect(recorded.some((request) => request.url.includes("/mental-models"))).toBe(false);
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL },
            http: stubHttp(HAPPY_ROUTES, recorded),
          }),
        ),
      );
    });

    it.effect("skips the memory endpoints when only mental models are asked for", () => {
      const recorded: Array<RecordedRequest> = [];
      return Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight.browse({ bank: BANK, pathway: "mentalModel" });

        expect(result.memories.map((memory) => memory.pathway)).toEqual(["mentalModel"]);
        expect(recorded.some((request) => request.url.includes("/memories/list"))).toBe(false);
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL },
            http: stubHttp(HAPPY_ROUTES, recorded),
          }),
        ),
      );
    });

    it.effect("recalls with a score, and sends the API key as a bearer token", () => {
      const recorded: Array<RecordedRequest> = [];
      return Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight.recall({ bank: BANK, pathway: "world", query: "node" });

        expect(result.status.availability).toBe("ready");
        const [top] = result.memories;
        expect(top?.pathway).toBe("world");
        expect(top?.confidence).toBe(0.82);
        // `recall` returns entities as an array; the list endpoint does not.
        expect(top?.entities).toEqual(["T3 Code", "Node"]);

        const recallCall = recorded.find((request) => request.url.includes("/memories/recall"));
        expect(recallCall?.method).toBe("POST");
        expect(recallCall?.authorization).toBe("Bearer secret-key");
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL, apiKey: "secret-key" },
            http: stubHttp(HAPPY_ROUTES, recorded),
          }),
        ),
      );
    });

    it.effect("sends no authorization header when no API key is configured", () => {
      const recorded: Array<RecordedRequest> = [];
      return Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        yield* hindsight.listBanks({});
        expect(recorded.every((request) => request.authorization === undefined)).toBe(true);
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL },
            http: stubHttp(HAPPY_ROUTES, recorded),
          }),
        ),
      );
    });

    it.effect("retains a note synchronously and reports the extracted count", () => {
      const recorded: Array<RecordedRequest> = [];
      return Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight.retain({ bank: BANK, text: "Remember this." });
        expect(result.itemsCount).toBe(3);

        const retainCall = recorded.find(
          (request) => request.method === "POST" && request.url.endsWith("/memories"),
        );
        expect(retainCall).toBeDefined();
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL },
            http: stubHttp(HAPPY_ROUTES, recorded),
          }),
        ),
      );
    });

    it.effect("returns the reflection markdown", () =>
      Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight.reflect({ bank: BANK, query: "what do you know?" });
        expect(result.text).toContain("The fork adds a Hermes provider");
        expect(result.status.availability).toBe("ready");
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL },
            http: stubHttp(HAPPY_ROUTES, []),
          }),
        ),
      ),
    );

    it.effect("surfaces an unknown bank distinctly from a generic failure", () =>
      Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight
          .retain({ bank: HindsightBankId.make("missing"), text: "note" })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.reason).toBe("unknownBank");
        }
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL },
            http: stubHttp(
              [
                { match: (url) => url.endsWith("/version"), body: HINDSIGHT_VERSION_RESPONSE },
                { match: (url) => url.includes("/banks/missing/"), status: 404 },
              ],
              [],
            ),
          }),
        ),
      ),
    );

    it.effect("clamps an oversized page request rather than trusting the client", () => {
      const recorded: Array<RecordedRequest> = [];
      return Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        yield* hindsight.browse({ bank: BANK, pathway: "world", limit: 10_000 });
        const listCall = recorded.find((request) => request.url.includes("/memories/list"));
        // 50 is the contract ceiling; one extra row is how "has more" is known.
        expect(listCall?.params).toContain("limit=51");
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL },
            http: stubHttp(HAPPY_ROUTES, recorded),
          }),
        ),
      );
    });

    it.effect("reads bank statistics, in T3 Code's own pathway vocabulary", () => {
      const recorded: Array<RecordedRequest> = [];
      return Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight.stats({ bank: BANK });

        expect(result.status.availability).toBe("ready");
        expect(result.stats).toEqual({
          nodes: 128,
          links: 342,
          documents: 17,
          // Hindsight's `nodes_by_fact_type` object, in T3 Code's order and
          // under its own pathway names rather than raw API keys.
          nodesByPathway: [
            { pathway: "world", count: 80 },
            { pathway: "experience", count: 40 },
            { pathway: "observation", count: 8 },
          ],
          pendingOperations: 2,
          failedOperations: 1,
          lastConsolidatedAt: "2026-08-15T17:45:00Z",
        });

        const statsCall = recorded.find((request) => request.url.endsWith("/stats"));
        expect(statsCall?.method).toBe("GET");
        expect(statsCall?.url).toContain("/v1/default/banks/hermes/stats");
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL },
            http: stubHttp(HAPPY_ROUTES, recorded),
          }),
        ),
      );
    });

    it.effect("drops zeroed pathways and tolerates a bank that never consolidated", () =>
      Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight.stats({ bank: BANK });
        expect(result.stats?.nodesByPathway).toEqual([{ pathway: "world", count: 4 }]);
        expect(result.stats?.lastConsolidatedAt).toBeNull();
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL },
            http: stubHttp(
              [
                { match: (url) => url.endsWith("/version"), body: HINDSIGHT_VERSION_RESPONSE },
                {
                  match: (url) => url.endsWith("/stats"),
                  body: {
                    ...HINDSIGHT_BANK_STATS_RESPONSE,
                    nodes_by_fact_type: { world: 4, experience: 0 },
                    last_consolidated_at: null,
                  },
                },
              ],
              [],
            ),
          }),
        ),
      ),
    );

    it.effect("answers with null stats rather than zeroes when the counts fail", () =>
      Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        const result = yield* hindsight.stats({ bank: BANK });
        expect(result.status.availability).toBe("requestFailed");
        // Zeroes here would read as an empty bank, which is a different claim.
        expect(result.stats).toBeNull();
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL },
            http: stubHttp(
              [
                { match: (url) => url.endsWith("/version"), body: HINDSIGHT_VERSION_RESPONSE },
                { match: (url) => url.endsWith("/stats"), status: 500 },
              ],
              [],
            ),
          }),
        ),
      ),
    );

    it.effect("keeps a failed stats read from taking down the memory list", () =>
      // Stats is a decoration on a working panel — an older Hindsight without
      // the route, or a stats query that timed out on a huge bank, must not
      // turn the list beside it into "Memory could not be read".
      Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;

        const stats = yield* hindsight.stats({ bank: BANK });
        expect(stats.stats).toBeNull();

        const browsed = yield* hindsight.browse({ bank: BANK, pathway: "all" });
        expect(browsed.status.availability).toBe("ready");
        expect(browsed.memories.length).toBeGreaterThan(0);

        // And the other way round: the cached verdict is still healthy after.
        const again = yield* hindsight.recall({ bank: BANK, pathway: "world", query: "node" });
        expect(again.status.availability).toBe("ready");
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: BASE_URL },
            http: stubHttp(
              [{ match: (url) => url.endsWith("/stats"), status: 404 }, ...HAPPY_ROUTES],
              [],
            ),
          }),
        ),
      ),
    );

    it.effect("tolerates a base URL with a trailing slash", () => {
      const recorded: Array<RecordedRequest> = [];
      return Effect.gen(function* () {
        const hindsight = yield* HindsightService.HindsightService;
        yield* hindsight.listBanks({});
        expect(recorded.some((request) => request.url.includes("//v1/"))).toBe(false);
      }).pipe(
        Effect.provide(
          withService({
            settings: { enabled: true, baseUrl: `${BASE_URL}/` },
            http: stubHttp(HAPPY_ROUTES, recorded),
          }),
        ),
      );
    });
  });
});
