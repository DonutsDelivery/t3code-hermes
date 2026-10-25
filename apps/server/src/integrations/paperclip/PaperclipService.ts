/**
 * The environment's side of the Paperclip surface, so the API key never leaves this process.
 * Read-only (`GET`s only), uncached, and reads never fail: errors come back as a {@link
 * PaperclipStatus} on an empty overview.
 */
import {
  PAPERCLIP_CONTRACT_VERSION,
  type PaperclipAvailability,
  type PaperclipOverviewInput,
  type PaperclipOverviewResult,
  type PaperclipSettings,
  type PaperclipStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSettings from "../../serverSettings.ts";
import {
  PAPERCLIP_ISSUE_LIMIT,
  PaperclipCompanyResponse,
  PaperclipDashboardResponse,
  PaperclipList,
  PaperclipMeResponse,
  activityFromRow,
  agentFromRow,
  companyFromResponse,
  dashboardFromResponse,
  decodeActivity,
  decodeAgents,
  decodeIssues,
  decodeProjects,
  decodeRuns,
  issueFromRow,
  paperclipApiRoot,
  paperclipPaths,
  paperclipWebRoot,
  projectFromRow,
  runFromRow,
  sortIssues,
  viewerFromMe,
} from "./paperclipApi.ts";

/** A side panel waiting longer than this on a LAN service is a service that is not answering. */
const REQUEST_TIMEOUT = Duration.seconds(10);

type FailureReason = Exclude<PaperclipAvailability, "ready" | "notConfigured">;

class PaperclipRequestError extends Data.TaggedError("PaperclipRequestError")<{
  readonly reason: FailureReason;
  readonly detail: string;
}> {}

export interface PaperclipConnection {
  readonly apiRoot: string;
  readonly apiKey: string;
  readonly companyId: string | null;
}

function trimmedOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

/** Effective connection, or null when switched off or missing a URL or key. */
function resolvePaperclipConnection(settings: PaperclipSettings): PaperclipConnection | null {
  if (!settings.enabled) return null;
  const baseUrl = trimmedOrNull(settings.baseUrl);
  const apiKey = trimmedOrNull(settings.apiKey);
  if (baseUrl === null || apiKey === null) return null;
  return {
    apiRoot: paperclipApiRoot(baseUrl),
    apiKey,
    companyId: trimmedOrNull(settings.companyId),
  };
}

function status(availability: PaperclipAvailability, detail: string | null): PaperclipStatus {
  return { contractVersion: PAPERCLIP_CONTRACT_VERSION, availability, detail };
}

function emptyOverview(
  current: PaperclipStatus,
  webUrl: string | null = null,
): PaperclipOverviewResult {
  return {
    status: current,
    viewer: null,
    company: null,
    dashboard: null,
    agents: [],
    projects: [],
    issues: [],
    issuesTruncated: false,
    runs: [],
    activity: [],
    webUrl,
  };
}

function notConfiguredDetail(settings: PaperclipSettings | null): string {
  if (settings === null || !settings.enabled)
    return "Paperclip is turned off for this environment.";
  if (trimmedOrNull(settings.baseUrl) === null) return "Add Paperclip's URL in Settings.";
  return "Add a Paperclip API key in Settings.";
}

export class PaperclipService extends Context.Service<
  PaperclipService,
  {
    /** The configured company at a glance, or the reason there is nothing to show. */
    readonly overview: (input: PaperclipOverviewInput) => Effect.Effect<PaperclipOverviewResult>;
  }
>()("t3-hermes/integrations/paperclip/PaperclipService") {}

/** @public */
export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const client = yield* HttpClient.HttpClient;

  /**
   * One `GET`, decoded. Transport errors and timeouts are `offline`, 401/403
   * are `unauthorized`, a body that will not decode is `incompatible`, and any
   * other status is `requestFailed` with its code.
   */
  const get = Effect.fn("PaperclipService.get")(function* <A, I>(
    connection: PaperclipConnection,
    path: string,
    schema: Schema.Codec<A, I, never, never>,
  ): Effect.fn.Return<A, PaperclipRequestError> {
    const response = yield* client
      .execute(
        HttpClientRequest.get(`${connection.apiRoot}${path}`).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
          HttpClientRequest.setHeader("authorization", `Bearer ${connection.apiKey}`),
        ),
      )
      .pipe(
        Effect.timeoutOption(REQUEST_TIMEOUT),
        Effect.orElseSucceed(() => Option.none()),
      );
    if (Option.isNone(response)) {
      return yield* new PaperclipRequestError({
        reason: "offline",
        detail: "Paperclip did not answer.",
      });
    }
    const http = response.value;
    if (http.status === 401 || http.status === 403) {
      return yield* new PaperclipRequestError({
        reason: "unauthorized",
        detail:
          "Paperclip rejected the API key. It may have expired or been revoked; save a new one in Settings.",
      });
    }
    if (http.status < 200 || http.status >= 300) {
      return yield* new PaperclipRequestError({
        reason: "requestFailed",
        detail: `Paperclip answered with status ${http.status}.`,
      });
    }
    return yield* http.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(
        () =>
          new PaperclipRequestError({
            reason: "incompatible",
            detail: "Paperclip answered in a shape this version of T3 Code does not understand.",
          }),
      ),
    );
  });

  /** A list the overview can live without: a failure leaves it empty. */
  const optionalList = (connection: PaperclipConnection, path: string) =>
    get(connection, path, PaperclipList).pipe(
      Effect.orElseSucceed((): ReadonlyArray<unknown> => []),
    );

  const overview = Effect.fn("PaperclipService.overview")(function* (
    _input: PaperclipOverviewInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.map((all) => all.integrations.paperclip),
      Effect.orElseSucceed(() => null),
    );
    const connection = settings === null ? null : resolvePaperclipConnection(settings);
    if (connection === null) {
      return emptyOverview(status("notConfigured", notConfiguredDetail(settings)));
    }
    const webRoot = paperclipWebRoot(connection.apiRoot);

    // Identity first: it says whether the key works at all, and which company to show.
    const me = yield* get(connection, paperclipPaths.me(), PaperclipMeResponse).pipe(Effect.result);
    if (Result.isFailure(me)) {
      return emptyOverview(status(me.failure.reason, me.failure.detail), webRoot);
    }
    const companyId = connection.companyId ?? me.success.companyIds[0] ?? null;
    if (companyId === null) {
      return emptyOverview(
        status("requestFailed", "This API key is not a member of any Paperclip company."),
        webRoot,
      );
    }
    if (!me.success.companyIds.includes(companyId) && me.success.isInstanceAdmin !== true) {
      return emptyOverview(
        status("requestFailed", "This API key cannot see the company chosen in Settings."),
        webRoot,
      );
    }

    const [company, dashboard, agents, projects, issues, runs, activity] = yield* Effect.all(
      [
        get(connection, paperclipPaths.company(companyId), PaperclipCompanyResponse).pipe(
          Effect.result,
        ),
        get(connection, paperclipPaths.dashboard(companyId), PaperclipDashboardResponse).pipe(
          Effect.option,
        ),
        optionalList(connection, paperclipPaths.agents(companyId)),
        optionalList(connection, paperclipPaths.projects(companyId)),
        optionalList(connection, paperclipPaths.issues(companyId)),
        optionalList(connection, paperclipPaths.runs(companyId)),
        optionalList(connection, paperclipPaths.activity(companyId)),
      ],
      { concurrency: "unbounded" },
    );
    if (Result.isFailure(company)) {
      return emptyOverview(status(company.failure.reason, company.failure.detail), webRoot);
    }

    const companyInfo = companyFromResponse(company.success);
    const allIssues = decodeIssues(issues).map(issueFromRow);
    return {
      status: status("ready", null),
      viewer: viewerFromMe(me.success, companyId),
      company: companyInfo,
      dashboard: Option.getOrNull(Option.map(dashboard, dashboardFromResponse)),
      agents: decodeAgents(agents).map(agentFromRow),
      projects: decodeProjects(projects).map(projectFromRow),
      issues: sortIssues(allIssues).slice(0, PAPERCLIP_ISSUE_LIMIT),
      issuesTruncated: allIssues.length > PAPERCLIP_ISSUE_LIMIT,
      runs: decodeRuns(runs).map(runFromRow),
      activity: decodeActivity(activity).map(activityFromRow),
      webUrl: webRoot === null ? null : `${webRoot}/${encodeURIComponent(companyInfo.issuePrefix)}`,
    } satisfies PaperclipOverviewResult;
  }, Effect.withSpan("PaperclipService.overview"));

  return PaperclipService.of({ overview });
});

export const layer = Layer.effect(PaperclipService, make);
