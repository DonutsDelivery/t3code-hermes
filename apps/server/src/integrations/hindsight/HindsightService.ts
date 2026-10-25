/**
 * The Memory tab's server side, so the API key stays here. Request/response with no memory cache;
 * only the `GET /version` verdict is reused. Reads never fail (a {@link HindsightStatus}); writes
 * fail with the same vocabulary. The connection resolves per request from settings, then Hermes's
 * config.
 */
import {
  HINDSIGHT_CONTRACT_VERSION,
  HINDSIGHT_DEFAULT_PAGE_SIZE,
  HINDSIGHT_MAX_PAGE_SIZE,
  HINDSIGHT_TARGET_API_VERSION,
  HindsightBankId,
  type HindsightAvailability,
  type HindsightBank,
  type HindsightBanksResult,
  type HindsightBrowseInput,
  type HindsightConnectionSource,
  HindsightError,
  type HindsightListBanksInput,
  type HindsightMemory,
  type HindsightMemoryResult,
  type HindsightRecallInput,
  type HindsightReflectInput,
  type HindsightReflectResult,
  type HindsightRetainInput,
  type HindsightRetainResult,
  type HindsightStatsInput,
  type HindsightStatsResult,
  type HindsightSettings,
  type HindsightStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { resolveEnabledHermesInstance } from "../../hermes/hermesCronState.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ServerSettings from "../../serverSettings.ts";
import {
  type HermesHindsightConfig,
  parseDotenv,
  resolveHermesHindsightConfig,
  resolveHermesHindsightPaths,
} from "./hermesHindsightConfig.ts";
import {
  HindsightBankListResponse,
  HindsightBankStatsResponse,
  HindsightListMemoriesResponse,
  HindsightMentalModelListResponse,
  HindsightRecallResponse,
  HindsightReflectResponse,
  HindsightRetainResponse,
  HindsightVersionResponse,
  bankFromListItem,
  factTypesFor,
  filterMentalModels,
  hindsightPaths,
  hindsightUrl,
  includesMentalModels,
  memoryFromMentalModel,
  memoryFromRecallResult,
  memoryFromUnit,
  sortByRememberedAtDesc,
  statsFromResponse,
} from "./hindsightApi.ts";

/**
 * Ceiling on a single Hindsight call.
 *
 * Generous because `reflect` runs an LLM loop, and a reflection that takes
 * forty seconds is working, not broken. Reads finish in milliseconds against a
 * local instance, so the same ceiling costs them nothing.
 */
const REQUEST_TIMEOUT = Duration.seconds(60);

const decodeJsonString = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Shorter ceiling for the probe: it only reads a constant. */
const PROBE_TIMEOUT = Duration.seconds(5);

/**
 * Recall asks for a token budget rather than a row count, so a page size is
 * translated into roughly this many tokens per row. Overshooting is harmless —
 * results are truncated to the requested page afterwards.
 */
const RECALL_TOKENS_PER_RESULT = 220;

/** What the compatibility probe concluded, reused until a refresh. */
interface HindsightProbe {
  readonly availability: HindsightAvailability;
  readonly detail: string | null;
  readonly apiVersion: string | null;
}

/** Effective connection settings, or `null` when the integration is off. */
export interface HindsightConnection {
  readonly source: HindsightConnectionSource;
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly defaultBank: string | null;
}

/** Everything the environment knows about where Hindsight is. */
export interface ResolvedHindsight {
  readonly connection: HindsightConnection | null;
  readonly hermes: HermesHindsightConfig | null;
  readonly enabled: boolean;
}

function notConfigured(enabled: boolean): HindsightProbe {
  return {
    availability: "notConfigured",
    detail: enabled
      ? "Neither T3 Code settings nor Hermes name a Hindsight service for this environment."
      : "Memory is turned off for this environment.",
    apiVersion: null,
  };
}

const NOT_CONFIGURED = notConfigured(true);

function trimmedOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Settings overrides laid over Hermes' config, field by field.
 *
 * The key follows the URL: a key saved in settings may go to either URL, but
 * Hermes' key is only ever sent to Hermes' URL, so pointing the panel somewhere
 * else never hands that server a credential it was not given.
 */
function resolveHindsightConnection(
  settings: HindsightSettings,
  hermes: HermesHindsightConfig | null,
): HindsightConnection | null {
  if (!settings.enabled) return null;
  const apiKey = trimmedOrNull(settings.apiKey);
  const defaultBank = trimmedOrNull(settings.defaultBank);
  const baseUrl = trimmedOrNull(settings.baseUrl);
  if (baseUrl !== null) {
    return {
      source: "settings",
      baseUrl,
      apiKey,
      defaultBank: defaultBank ?? hermes?.bank ?? null,
    };
  }
  if (hermes === null) return null;
  return {
    source: "hermes",
    baseUrl: hermes.baseUrl,
    apiKey: apiKey ?? hermes.apiKey,
    defaultBank: defaultBank ?? hermes.bank,
  };
}

/** A URL safe to show a client: any `user:pass@` is removed. */
function displayUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return baseUrl.replace(/\/\/[^/@]*@/, "//");
  }
}

function statusOf(probe: HindsightProbe): HindsightStatus {
  return {
    contractVersion: HINDSIGHT_CONTRACT_VERSION,
    availability: probe.availability,
    detail: probe.detail,
    apiVersion: probe.apiVersion,
    targetApiVersion: HINDSIGHT_TARGET_API_VERSION,
  };
}

/**
 * Whether `api_version` has the major this build was transcribed from. Minor bumps keep shapes; a
 * major bump or unparseable version is `incompatible`.
 */
function isCompatibleApiVersion(apiVersion: string): boolean {
  const foundMajor = apiVersion.trim().split(".")[0] ?? "";
  const targetMajor = HINDSIGHT_TARGET_API_VERSION.split(".")[0] ?? "";
  return foundMajor.length > 0 && foundMajor === targetMajor;
}

/**
 * The failure reason a read ended with, as the availability a panel renders.
 *
 * Every non-healthy verdict shares one shape, but each keeps its words: the
 * panel says "not answering" for `offline`, "update one of the two sides" for
 * `incompatible`, and shows the failure's own detail for `requestFailed`.
 */
function availabilityForReadFailure(reason: HindsightError["reason"]): HindsightAvailability {
  switch (reason) {
    case "offline":
      return "offline";
    case "incompatible":
      return "incompatible";
    case "notConfigured":
      return "notConfigured";
    case "unknownBank":
    case "requestFailed":
      return "requestFailed";
  }
}

function emptyMemoryResult(probe: HindsightProbe): HindsightMemoryResult {
  return { status: statusOf(probe), memories: [], hasMore: false };
}

/**
 * A probe verdict as a write failure.
 *
 * Reads and writes agree on vocabulary — the only difference is that a write
 * has nowhere to put a status, so the same words arrive as a typed error.
 */
function probeFailure(probe: HindsightProbe): HindsightError {
  const reason =
    probe.availability === "notConfigured"
      ? ("notConfigured" as const)
      : probe.availability === "incompatible"
        ? ("incompatible" as const)
        : probe.availability === "requestFailed"
          ? ("requestFailed" as const)
          : ("offline" as const);
  return new HindsightError({
    reason,
    detail: probe.detail ?? "Hindsight is unavailable.",
  });
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return HINDSIGHT_DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(HINDSIGHT_MAX_PAGE_SIZE, Math.floor(limit)));
}

export class HindsightService extends Context.Service<
  HindsightService,
  {
    /**
     * Banks plus the compatibility verdict — everything the panel needs to
     * decide what to render.
     */
    readonly listBanks: (input: HindsightListBanksInput) => Effect.Effect<HindsightBanksResult>;

    /** Recent memories, newest first. The view with no query typed. */
    readonly browse: (input: HindsightBrowseInput) => Effect.Effect<HindsightMemoryResult>;

    /** Semantic search over a bank. */
    readonly recall: (input: HindsightRecallInput) => Effect.Effect<HindsightMemoryResult>;

    /**
     * How big the bank is. Answers with `stats: null` rather than zeroes when
     * Hindsight could not say, so the strip disappears instead of lying.
     */
    readonly stats: (input: HindsightStatsInput) => Effect.Effect<HindsightStatsResult>;

    /** Write one note. Fails rather than silently swallowing a lost note. */
    readonly retain: (
      input: HindsightRetainInput,
    ) => Effect.Effect<HindsightRetainResult, HindsightError>;

    /** Ask Hindsight to reason over the bank now. */
    readonly reflect: (
      input: HindsightReflectInput,
    ) => Effect.Effect<HindsightReflectResult, HindsightError>;

    /**
     * The connection this environment resolves, key included. Server-side
     * only: agent memory hands it to the agents on this host.
     */
    readonly resolveConnection: Effect.Effect<ResolvedHindsight>;
  }
>()("t3-hermes/integrations/hindsight/HindsightService") {}

/** @public */
export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const client = yield* HttpClient.HttpClient;

  /**
   * A missing file is the normal "Hermes has no Hindsight config" case. Any
   * other failure is logged but still reads as absent, because reads never
   * fail: the panel says "not set up" and the log says why.
   */
  const readFileOrNull = (path: string) =>
    fs
      .readFileString(path)
      .pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(null)
            : Effect.logWarning("could not read Hermes' Hindsight config", { path, cause }).pipe(
                Effect.as(null),
              ),
        ),
      );

  /**
   * Hermes' Hindsight config, read fresh each time: a handful of small local
   * files, and caching them would make an edit in Hermes look ignored.
   */
  const readHermesConfig = Effect.fn("HindsightService.readHermesConfig")(function* (
    environment: NodeJS.ProcessEnv,
  ) {
    const paths = resolveHermesHindsightPaths(environment);
    let config: { readonly path: string; readonly value: unknown } | null = null;
    for (const path of paths.configFiles) {
      const raw = yield* readFileOrNull(path);
      if (raw === null) continue;
      const value = yield* decodeJsonString(raw).pipe(Effect.orElseSucceed(() => null));
      // Hermes skips a malformed file and tries the next, so this does too.
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      config = { path, value };
      break;
    }
    const dotenv = yield* readFileOrNull(paths.dotenvFile);
    return resolveHermesHindsightConfig({
      config,
      // Hermes' own `.env` outranks the shell it was started from.
      environment: { ...environment, ...(dotenv === null ? {} : parseDotenv(dotenv)) },
    });
  });

  const resolve: Effect.Effect<ResolvedHindsight> = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings === null) return { connection: null, hermes: null, enabled: false };
    // A Hermes instance can point `HERMES_HOME` elsewhere; follow it when one is on.
    const instance = resolveEnabledHermesInstance(settings);
    const environment =
      instance === null
        ? process.env
        : yield* mergeProviderInstanceEnvironment(instance.environment);
    const hermes = yield* readHermesConfig(environment);
    const hindsight = settings.integrations.hindsight;
    return {
      connection: resolveHindsightConnection(hindsight, hermes),
      hermes,
      enabled: hindsight.enabled,
    };
  });

  /** The verdict is only reused for the connection it was reached against. */
  const probeRef = yield* Ref.make<{
    readonly connection: HindsightConnection;
    readonly probe: HindsightProbe;
  } | null>(null);

  const authorized = (request: HttpClientRequest.HttpClientRequest, apiKey: string | null) =>
    apiKey === null
      ? request
      : HttpClientRequest.setHeader(request, "authorization", `Bearer ${apiKey}`);

  /**
   * One call, decoded.
   * Every way this can go wrong is folded into the vocabulary the panel speaks: a transport error
   * or a timeout is `offline`, a body that will not decode is `incompatible`, and anything else
   * Hindsight says is `requestFailed` with its status code.
   */
  const send = Effect.fn("HindsightService.send")(function* <A, I>(
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, I, never, never>,
    options: { readonly apiKey: string | null; readonly timeout: Duration.Duration },
  ): Effect.fn.Return<A, HindsightError> {
    const response = yield* client.execute(authorized(request, options.apiKey)).pipe(
      Effect.timeoutOption(options.timeout),
      Effect.orElseSucceed(() => Option.none()),
    );

    if (Option.isNone(response)) {
      return yield* new HindsightError({
        reason: "offline",
        detail: "Hindsight did not answer.",
      });
    }

    const httpResponse = response.value;
    if (httpResponse.status === 404) {
      return yield* new HindsightError({
        reason: "unknownBank",
        detail: "Hindsight does not have that memory bank.",
      });
    }
    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      return yield* new HindsightError({
        reason: "requestFailed",
        detail: `Hindsight answered with status ${httpResponse.status}.`,
      });
    }

    return yield* httpResponse.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(
        (cause) =>
          new HindsightError({
            reason: "incompatible",
            detail: "Hindsight answered in a shape this version of T3 Code does not understand.",
            cause,
          }),
      ),
    );
  });

  /**
   * The cached verdict, probing if needed. Only a healthy verdict is reused, and only for the same
   * URL and key, so retry recovers after a repoint, a start, an upgrade, or a mid-flight failure.
   * `refresh` forces a probe.
   */
  const probe = Effect.fn("HindsightService.probe")(function* (options: {
    readonly refresh: boolean;
  }) {
    const resolved = yield* resolve;
    const settings = resolved.connection;
    if (settings === null) {
      yield* Ref.set(probeRef, null);
      return { probe: notConfigured(resolved.enabled), connection: null, resolved } as const;
    }

    const cached = yield* Ref.get(probeRef);
    if (
      cached !== null &&
      !options.refresh &&
      cached.connection.baseUrl === settings.baseUrl &&
      cached.connection.apiKey === settings.apiKey &&
      cached.probe.availability === "ready"
    ) {
      return { probe: cached.probe, connection: settings, resolved } as const;
    }

    const version = yield* send(
      HttpClientRequest.get(hindsightUrl(settings.baseUrl, hindsightPaths.version())).pipe(
        HttpClientRequest.setHeader("accept", "application/json"),
      ),
      HindsightVersionResponse,
      { apiKey: settings.apiKey, timeout: PROBE_TIMEOUT },
    ).pipe(Effect.result);

    const next: HindsightProbe = Result.isSuccess(version)
      ? isCompatibleApiVersion(version.success.api_version)
        ? { availability: "ready", detail: null, apiVersion: version.success.api_version }
        : {
            availability: "incompatible",
            detail: `Hindsight reports API ${version.success.api_version}, but T3 Code targets ${HINDSIGHT_TARGET_API_VERSION}. The major versions differ, so the panel cannot safely decode its answers.`,
            apiVersion: version.success.api_version,
          }
      : version.failure.reason === "incompatible"
        ? {
            availability: "incompatible",
            detail: `Hindsight did not report a version this build understands. T3 Code targets Hindsight API ${HINDSIGHT_TARGET_API_VERSION}.`,
            apiVersion: null,
          }
        : {
            availability: "offline",
            detail: "Hindsight is configured but not answering on this host.",
            apiVersion: null,
          };

    yield* Ref.set(probeRef, { connection: settings, probe: next });
    return { probe: next, connection: settings, resolved } as const;
  });

  /**
   * Runs a read, turning failure into a renderable status and invalidating the cached verdict,
   * unless `invalidatesProbe: false` because its failure says nothing about the rest of the panel
   * (see {@link stats}).
   */
  const readOrStatus = Effect.fn("HindsightService.readOrStatus")(function* <A>(
    run: (
      settings: HindsightConnection,
      probe: HindsightProbe,
      resolved: ResolvedHindsight,
    ) => Effect.Effect<A, HindsightError>,
    fallback: (probe: HindsightProbe, resolved: ResolvedHindsight) => A,
    options?: { readonly invalidatesProbe?: boolean },
  ): Effect.fn.Return<A> {
    const probed = yield* probe({ refresh: false });
    if (probed.connection === null || probed.probe.availability !== "ready") {
      return fallback(probed.probe, probed.resolved);
    }
    const result = yield* run(probed.connection, probed.probe, probed.resolved).pipe(Effect.result);
    if (Result.isSuccess(result)) return result.success;

    const availability = availabilityForReadFailure(result.failure.reason);
    const failed: HindsightProbe = {
      availability,
      detail:
        availability === "offline"
          ? "Hindsight stopped answering on this host."
          : result.failure.detail,
      apiVersion: probed.probe.apiVersion,
    };

    if (availability !== "ready" && options?.invalidatesProbe !== false) {
      yield* Ref.set(probeRef, null);
    }
    return fallback(failed, probed.resolved);
  });

  /** A write only runs against a `ready` Hindsight; otherwise it says why not. */
  const write = Effect.fn("HindsightService.write")(function* <A>(
    run: (settings: HindsightConnection, probe: HindsightProbe) => Effect.Effect<A, HindsightError>,
  ): Effect.fn.Return<A, HindsightError> {
    const probed = yield* probe({ refresh: false });
    if (probed.connection === null || probed.probe.availability !== "ready") {
      return yield* probeFailure(probed.probe);
    }
    return yield* run(probed.connection, probed.probe);
  });

  const fetchMentalModels = (settings: HindsightConnection, bank: string, limit: number) =>
    send(
      HttpClientRequest.get(hindsightUrl(settings.baseUrl, hindsightPaths.mentalModels(bank))).pipe(
        HttpClientRequest.setUrlParams({ detail: "content", limit: String(limit) }),
        HttpClientRequest.setHeader("accept", "application/json"),
      ),
      HindsightMentalModelListResponse,
      { apiKey: settings.apiKey, timeout: REQUEST_TIMEOUT },
    );

  /** Where Hindsight is, as Settings shows it. Never the key itself. */
  const connectionInfo = (resolved: ResolvedHindsight) => ({
    connection:
      resolved.connection === null
        ? null
        : {
            source: resolved.connection.source,
            baseUrl: displayUrl(resolved.connection.baseUrl),
            hasApiKey: resolved.connection.apiKey !== null,
          },
    hermes:
      resolved.hermes === null
        ? null
        : {
            configPath: resolved.hermes.configPath,
            baseUrl: displayUrl(resolved.hermes.baseUrl),
            bank: resolved.hermes.bank,
            hasApiKey: resolved.hermes.apiKey !== null,
          },
  });

  const listBanks = (_input: HindsightListBanksInput) =>
    readOrStatus<HindsightBanksResult>(
      (settings, probed, resolved) =>
        Effect.map(
          send(
            HttpClientRequest.get(hindsightUrl(settings.baseUrl, hindsightPaths.banks())).pipe(
              HttpClientRequest.setHeader("accept", "application/json"),
            ),
            HindsightBankListResponse,
            { apiKey: settings.apiKey, timeout: REQUEST_TIMEOUT },
          ),
          (response): HindsightBanksResult => {
            const banks: ReadonlyArray<HindsightBank> = response.banks.map(bankFromListItem);
            // A configured default that no longer exists is worse than no
            // default: the panel would preselect a bank every read 404s on.
            const defaultBank =
              settings.defaultBank !== null &&
              banks.some((bank) => bank.id === settings.defaultBank)
                ? HindsightBankId.make(settings.defaultBank)
                : null;
            return {
              status: statusOf(probed),
              banks,
              defaultBank,
              ...connectionInfo(resolved),
            };
          },
        ),
      (probed, resolved) => ({
        status: statusOf(probed),
        banks: [],
        defaultBank: null,
        ...connectionInfo(resolved),
      }),
    );

  const browse = (input: HindsightBrowseInput) =>
    readOrStatus<HindsightMemoryResult>(
      (settings, probed) =>
        Effect.gen(function* () {
          const limit = clampLimit(input.limit);
          const factTypes = factTypesFor(input.pathway);

          // Asking for one more row than the page is how "there is more" is
          // known without a second count query.
          const units =
            factTypes.length === 0
              ? null
              : yield* send(
                  HttpClientRequest.get(
                    hindsightUrl(settings.baseUrl, hindsightPaths.listMemories(input.bank)),
                  ).pipe(
                    HttpClientRequest.setUrlParams({
                      limit: String(limit + 1),
                      offset: "0",
                      // One type means a filter; three means "no filter", which
                      // Hindsight spells as an absent parameter.
                      ...(factTypes.length === 1 ? { type: factTypes[0] } : {}),
                    }),
                    HttpClientRequest.setHeader("accept", "application/json"),
                  ),
                  HindsightListMemoriesResponse,
                  { apiKey: settings.apiKey, timeout: REQUEST_TIMEOUT },
                );

          const models = includesMentalModels(input.pathway)
            ? yield* fetchMentalModels(settings, input.bank, limit + 1)
            : null;

          const memories: ReadonlyArray<HindsightMemory> = sortByRememberedAtDesc([
            ...(units?.items ?? []).map(memoryFromUnit),
            ...(models?.items ?? []).map(memoryFromMentalModel),
          ]);

          return {
            status: statusOf(probed),
            memories: memories.slice(0, limit),
            hasMore: memories.length > limit,
          } satisfies HindsightMemoryResult;
        }),
      emptyMemoryResult,
    );

  const recall = (input: HindsightRecallInput) =>
    readOrStatus<HindsightMemoryResult>(
      (settings, probed) =>
        Effect.gen(function* () {
          const limit = clampLimit(input.limit);
          const factTypes = factTypesFor(input.pathway);

          const recalled =
            factTypes.length === 0
              ? null
              : yield* send(
                  HttpClientRequest.post(
                    hindsightUrl(settings.baseUrl, hindsightPaths.recall(input.bank)),
                  ).pipe(
                    HttpClientRequest.bodyJsonUnsafe({
                      query: input.query,
                      types: factTypes,
                      // Drops raw facts that a returned observation already
                      // supersedes, so the list does not read as duplicated.
                      prefer_observations: factTypes.includes("observation"),
                      max_tokens: limit * RECALL_TOKENS_PER_RESULT,
                    }),
                    HttpClientRequest.setHeader("accept", "application/json"),
                  ),
                  HindsightRecallResponse,
                  { apiKey: settings.apiKey, timeout: REQUEST_TIMEOUT },
                );

          // Hindsight has no ranked query over mental models, so a query
          // narrows them by substring instead. See `filterMentalModels`.
          const models = includesMentalModels(input.pathway)
            ? filterMentalModels(
                (yield* fetchMentalModels(settings, input.bank, HINDSIGHT_MAX_PAGE_SIZE)).items,
                input.query,
              )
            : [];

          // Ranked results first, in Hindsight's order; matched mental models
          // after, since their "score" is a substring hit and not comparable.
          const memories: ReadonlyArray<HindsightMemory> = [
            ...(recalled?.results ?? []).map(memoryFromRecallResult),
            ...models.map(memoryFromMentalModel),
          ];

          return {
            status: statusOf(probed),
            memories: memories.slice(0, limit),
            hasMore: memories.length > limit,
          } satisfies HindsightMemoryResult;
        }),
      emptyMemoryResult,
    );

  /**
   * Bank counts for the strip. Never invalidates the probe: a failed stats call (older build, slow
   * huge bank) must not replace a working list with an error.
   */
  const stats = (input: HindsightStatsInput) =>
    readOrStatus<HindsightStatsResult>(
      (settings, probed) =>
        Effect.map(
          send(
            HttpClientRequest.get(
              hindsightUrl(settings.baseUrl, hindsightPaths.stats(input.bank)),
            ).pipe(HttpClientRequest.setHeader("accept", "application/json")),
            HindsightBankStatsResponse,
            { apiKey: settings.apiKey, timeout: REQUEST_TIMEOUT },
          ),
          (response): HindsightStatsResult => ({
            status: statusOf(probed),
            stats: statsFromResponse(response),
          }),
        ),
      (probed) => ({ status: statusOf(probed), stats: null }),
      { invalidatesProbe: false },
    );

  const retain = (input: HindsightRetainInput) =>
    write((settings, probed) =>
      Effect.map(
        send(
          HttpClientRequest.post(
            hindsightUrl(settings.baseUrl, hindsightPaths.retain(input.bank)),
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              items: [{ content: input.text }],
              // Synchronous: the confirmation the user sees should be the
              // truth, not a promise to extract facts later.
              async: false,
            }),
            HttpClientRequest.setHeader("accept", "application/json"),
          ),
          HindsightRetainResponse,
          { apiKey: settings.apiKey, timeout: REQUEST_TIMEOUT },
        ),
        (response): HindsightRetainResult => ({
          status: statusOf(probed),
          itemsCount: response.items_count,
        }),
      ),
    );

  const reflect = (input: HindsightReflectInput) =>
    write((settings, probed) =>
      Effect.map(
        send(
          HttpClientRequest.post(
            hindsightUrl(settings.baseUrl, hindsightPaths.reflect(input.bank)),
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe({ query: input.query }),
            HttpClientRequest.setHeader("accept", "application/json"),
          ),
          HindsightReflectResponse,
          { apiKey: settings.apiKey, timeout: REQUEST_TIMEOUT },
        ),
        (response): HindsightReflectResult => ({
          status: statusOf(probed),
          text: response.text,
        }),
      ),
    );

  return HindsightService.of({
    listBanks,
    browse,
    recall,
    stats,
    retain,
    reflect,
    resolveConnection: resolve,
  });
});

export const layer = Layer.effect(HindsightService, make);

/** Unconfigured service, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  HindsightService,
  HindsightService.of({
    listBanks: () =>
      Effect.succeed({ status: statusOf(NOT_CONFIGURED), banks: [], defaultBank: null }),
    browse: () => Effect.succeed(emptyMemoryResult(NOT_CONFIGURED)),
    recall: () => Effect.succeed(emptyMemoryResult(NOT_CONFIGURED)),
    stats: () => Effect.succeed({ status: statusOf(NOT_CONFIGURED), stats: null }),
    retain: () => Effect.fail(probeFailure(NOT_CONFIGURED)),
    reflect: () => Effect.fail(probeFailure(NOT_CONFIGURED)),
    resolveConnection: Effect.succeed({ connection: null, hermes: null, enabled: false }),
  }),
);
