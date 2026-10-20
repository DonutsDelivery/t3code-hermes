/**
 * HermesRunService — mirrors Hermes background runs into threads.
 *
 * Hermes runs agents on its own: a webhook route per incoming delivery, a cron
 * job per firing, in any of its profiles. This service discovers those sources
 * from Hermes's config, lets the user switch on the ones that should produce
 * threads (and pick their project), and tails each switched-on source's runs
 * from the profile's `state.db` into ordinary threads: the transcript with its
 * tool calls, a running turn while Hermes works, the pull request the run
 * opened, and a finished turn when it ends.
 *
 * A run has no T3 run of its own: Hermes already did the work. Its thread is
 * created and stamped with `hermesRun` through orchestrator commands, and its
 * transcript lands as run-less turn items written straight to the event sink,
 * like imported history. Ids derive from Hermes row ids, so replays write
 * nothing new and cursors live in memory. Nothing is checkpointed: the run
 * worked in its own checkout, not the project's. `hermesRun.live` is the only
 * liveness signal, so a live run is never interrupted by provider recovery.
 *
 * Replies start a fresh Hermes session in the instance's own Hermes home:
 * Hermes cannot reopen webhook or cron sessions over ACP. The thread's history
 * is marked imported, so V2 hands the mirrored transcript to that session.
 *
 * Cost: one settings read per tick with nothing switched on; otherwise a few
 * indexed reads per switched-on source every 30s, every 5s while a run is live.
 *
 * @module HermesRunService
 */
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  HermesRunError,
  hermesRunIdPrefix,
  ProjectId,
  pullRequestHostOf,
  ProviderDriverKind,
  ThreadId,
  type ThreadHermesRun,
  type HermesRunSource,
  type HermesRunSourceSetInput,
  type HermesRunSourcesResult,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveEnabledHermesInstance, resolveHermesHome } from "./hermesCronState.ts";
import {
  DEFAULT_HERMES_PROFILE,
  cronSourceKey,
  isHermesRunOver,
  parseHermesCronJobSources,
  parseHermesWebhookRoutes,
  readHermesRunChain,
  readHermesRunMessages,
  readHermesRunRoots,
  readHermesSourceRunStats,
  webhookSourceKey,
  type HermesMessageRow,
  type HermesProfileHome,
  type HermesSessionRow,
} from "./hermesRunState.ts";
import {
  hermesRunItemsFor,
  hermesRunNoticeItem,
  isoFromSeconds,
  isSilentReport,
  type HermesRunEntry,
  type HermesRunIds,
  type HermesToolCall,
} from "./hermesRunTranscript.ts";

const HERMES = ProviderDriverKind.make("hermes");
const STATE_FILENAME = "hermes-run-sources.json";
const IDLE_INTERVAL = Duration.seconds(30);
const HERMES_OFF_REASON = "Hermes was turned off before this run finished.";
const LIVE_INTERVAL = Duration.seconds(5);
/** Window the settings list counts recent runs over. */
const RECENT_RUN_WINDOW_SECONDS = 30 * 24 * 60 * 60;
/** Turn items per event sink write when a run's backlog is mirrored. */
const WRITE_BATCH_SIZE = 50;
/** Scripts are read only to spot a repository name; anything larger is not a filter script. */
const MAX_HINT_FILE_BYTES = 64 * 1024;
/** "Sep 30, 14:05" — Hermes titles cron runs this way; webhook runs get the same shape. */
const RUN_TITLE_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const EnabledSource = Schema.Struct({
  profile: Schema.String,
  sourceKey: Schema.String,
  projectId: ProjectId,
  enabledAt: Schema.String,
});
type EnabledSource = typeof EnabledSource.Type;

const PersistedState = Schema.Struct({
  version: Schema.Literal(1),
  sources: Schema.Array(EnabledSource),
});
const PersistedStateJson = Schema.fromJsonString(PersistedState);
const decodePersistedState = Schema.decodeUnknownEffect(PersistedStateJson);
const encodePersistedState = Schema.encodeEffect(PersistedStateJson);
const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

interface TrackedRun {
  readonly ids: HermesRunIds;
  readonly profile: HermesProfileHome;
  readonly instanceId: ProviderInstanceId;
  readonly sourceKey: string;
  /** Fixed when the run is first followed: moving its source later leaves it here. */
  readonly projectId: ProjectId;
  readonly sourceLabel: string;
  readonly rootSessionId: string;
  created: boolean;
  cursor: number;
  lastMessageAt: number | null;
  latestSessionId: string;
  finalReport: string | null;
  readonly toolCalls: Map<string, HermesToolCall>;
  readonly pullRequestUrls: Set<string>;
  /** Status of each item already in the thread; read from the thread on first write. */
  written: Map<string, OrchestrationV2TurnItem["status"]> | null;
}

export class HermesRunService extends Context.Service<
  HermesRunService,
  {
    /** Every background source Hermes has, with whether it produces threads. */
    readonly listSources: Effect.Effect<HermesRunSourcesResult, HermesRunError>;
    /** Switch a source on for a project, or off with a null project. */
    readonly setSource: (
      input: HermesRunSourceSetInput,
    ) => Effect.Effect<HermesRunSourcesResult, HermesRunError>;
    /** One watcher pass: pick up new runs and mirror what is new in followed ones. */
    readonly sync: Effect.Effect<void>;
    /** Starts the watcher loop. Called once from the orchestration reactor. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3-hermes/hermes/HermesRunService") {}

function sourceId(profile: string, sourceKey: string): string {
  return `${profile}\u0000${sourceKey}`;
}

function labelOf(sourceKey: string): string {
  return sourceKey.startsWith("cron:")
    ? sourceKey.slice("cron:".length)
    : `webhook/${sourceKey.slice("webhook:".length)}`;
}

/** The project a source most likely works in, from a workdir or a repository its config names. */
function suggestProject(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  hint: { readonly workdir: string | null; readonly text: string },
): ProjectId | null {
  if (hint.workdir !== null) {
    const byRoot = projects.find(
      (project) =>
        hint.workdir === project.workspaceRoot ||
        hint.workdir!.startsWith(`${project.workspaceRoot}/`),
    );
    if (byRoot) return byRoot.id;
  }
  const text = hint.text.toLowerCase();
  if (!text.trim()) return null;
  const byRepository = projects.find((project) => {
    const repository = sourceControlRepositorySelector(project.repositoryIdentity)?.toLowerCase();
    return (
      (repository !== undefined && repository.includes("/") && text.includes(repository)) ||
      text.includes(project.workspaceRoot.toLowerCase())
    );
  });
  return byRepository?.id ?? null;
}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
  const projectService = yield* ProjectService.ProjectService;

  const statePath = path.join(config.stateDir, STATE_FILENAME);
  const enabledRef = yield* Ref.make<ReadonlyArray<EnabledSource>>([]);
  const stateMutex = yield* Semaphore.make(1);
  const wake = yield* Queue.sliding<void>(1);
  const runs = new Map<string, TrackedRun>();
  /** Runs finished, skipped, or deleted in this process; never looked at again. */
  const settledRoots = new Set<string>();

  // A missing or unreadable file means nothing is switched on, the quiet side.
  yield* Effect.gen(function* () {
    const raw = yield* fs.readFileString(statePath).pipe(Effect.orElseSucceed(() => ""));
    if (!raw.trim()) return;
    const decoded = yield* decodePersistedState(raw).pipe(Effect.option);
    if (Option.isSome(decoded)) yield* Ref.set(enabledRef, decoded.value.sources);
  });

  const readText = (filePath: string) =>
    fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => null as string | null));

  /** The enabled Hermes instance and every profile under its home, or null when Hermes is off. */
  const hermesContext = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    const instance = settings === null ? null : resolveEnabledHermesInstance(settings);
    if (instance === null) return null;
    const root = resolveHermesHome(yield* mergeProviderInstanceEnvironment(instance.environment));
    const profiles: HermesProfileHome[] = [{ profile: DEFAULT_HERMES_PROFILE, home: root }];
    const profilesDir = path.join(root, "profiles");
    const names = yield* fs
      .readDirectory(profilesDir)
      .pipe(Effect.orElseSucceed(() => [] as string[]));
    for (const name of names.toSorted()) {
      const home = path.join(profilesDir, name);
      const info = yield* fs.stat(home).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "Directory")
        profiles.push({ profile: name, home });
    }
    return { instanceId: instance.instanceId, profiles };
  });

  const readHintFile = Effect.fn("HermesRunService.readHintFile")(function* (
    home: string,
    scriptPath: string | null,
  ) {
    if (scriptPath === null) return "";
    const candidates = path.isAbsolute(scriptPath)
      ? [scriptPath]
      : [path.join(home, "scripts", scriptPath), path.join(home, scriptPath)];
    for (const candidate of candidates) {
      const info = yield* fs.stat(candidate).pipe(Effect.option);
      if (Option.isNone(info) || Number(info.value.size) > MAX_HINT_FILE_BYTES) continue;
      const contents = yield* readText(candidate);
      if (contents !== null) return contents;
    }
    return "";
  });

  const listSources: HermesRunService["Service"]["listSources"] = Effect.gen(function* () {
    const context = yield* hermesContext;
    if (context === null) return { hermesEnabled: false, sources: [] };
    const enabled = new Map(
      (yield* Ref.get(enabledRef)).map((entry) => [
        sourceId(entry.profile, entry.sourceKey),
        entry,
      ]),
    );
    const projects = yield* projectService
      .listShells()
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<OrchestrationProjectShell>));
    const nowSeconds = (yield* Clock.currentTimeMillis) / 1000;
    const sources: HermesRunSource[] = [];
    for (const { profile, home } of context.profiles) {
      const routes = parseHermesWebhookRoutes(
        yield* readText(path.join(home, "config.yaml")),
        yield* readText(path.join(home, "webhook_subscriptions.json")),
      );
      const jobsText = yield* readText(path.join(home, "cron", "jobs.json"));
      const jobs = parseHermesCronJobSources(
        jobsText === null ? null : Option.getOrNull(decodeJsonOption(jobsText)),
      );
      const stats =
        (yield* Effect.sync(() =>
          readHermesSourceRunStats(
            path.join(home, "state.db"),
            nowSeconds - RECENT_RUN_WINDOW_SECONDS,
          ),
        )) ?? new Map();
      const seen = new Set<string>();
      const push = (
        sourceKey: string,
        entry: Omit<
          HermesRunSource,
          "profile" | "sourceKey" | "lastRunAt" | "recentRunCount" | "projectId"
        >,
      ) => {
        seen.add(sourceKey);
        const stat = stats.get(sourceKey);
        sources.push({
          profile,
          sourceKey,
          ...entry,
          lastRunAt: stat ? isoFromSeconds(stat.lastRunAt) : null,
          recentRunCount: stat?.recentRunCount ?? 0,
          projectId: enabled.get(sourceId(profile, sourceKey))?.projectId ?? null,
        });
      };
      for (const route of routes) {
        const scriptText = yield* readHintFile(home, route.scriptPath);
        push(webhookSourceKey(route.name), {
          kind: "webhook",
          label: route.name,
          detail: route.events.length > 0 ? route.events.join(", ") : null,
          configured: true,
          suggestedProjectId: suggestProject(projects, {
            workdir: null,
            text: `${route.hint}\n${scriptText}`,
          }),
        });
      }
      for (const job of jobs) {
        push(cronSourceKey(job.id), {
          kind: "cron",
          label: job.name,
          detail: job.schedule,
          configured: true,
          suggestedProjectId: suggestProject(projects, { workdir: job.workdir, text: job.hint }),
        });
      }
      // Sources that ran recently but are gone from config, or still switched on.
      const leftovers = new Set<string>(stats.keys());
      for (const entry of enabled.values()) {
        if (entry.profile === profile) leftovers.add(entry.sourceKey);
      }
      for (const sourceKey of leftovers) {
        if (seen.has(sourceKey)) continue;
        push(sourceKey, {
          kind: sourceKey.startsWith("cron:") ? "cron" : "webhook",
          label: labelOf(sourceKey),
          detail: null,
          configured: false,
          suggestedProjectId: null,
        });
      }
    }
    return { hermesEnabled: true, sources };
  });

  const setSource: HermesRunService["Service"]["setSource"] = Effect.fn(
    "HermesRunService.setSource",
  )(function* (input) {
    // Saving a choice Hermes cannot act on would switch it on silently later.
    if ((yield* hermesContext) === null) {
      return yield* new HermesRunError({
        reason: "providerDisabled",
        detail: "Hermes is not enabled in this environment.",
      });
    }
    // Switching off always works; switching on needs a source Hermes has.
    if (input.projectId !== null) {
      const listed = yield* listSources;
      const known = listed.sources.some(
        (source) => source.profile === input.profile && source.sourceKey === input.sourceKey,
      );
      if (!known) {
        return yield* new HermesRunError({
          reason: "unknownSource",
          detail: "Hermes has no such route or scheduled job.",
        });
      }
    }
    if (input.projectId !== null) {
      const project = yield* projectService
        .getShell(input.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(project)) {
        return yield* new HermesRunError({
          reason: "unknownProject",
          detail: "That project no longer exists in this environment.",
        });
      }
    }
    yield* stateMutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(enabledRef);
        const id = sourceId(input.profile, input.sourceKey);
        const previous = current.find((entry) => sourceId(entry.profile, entry.sourceKey) === id);
        const rest = current.filter((entry) => sourceId(entry.profile, entry.sourceKey) !== id);
        const next =
          input.projectId === null
            ? rest
            : [
                ...rest,
                {
                  profile: input.profile,
                  sourceKey: input.sourceKey,
                  projectId: input.projectId,
                  // Moving a source to another project keeps its history window.
                  enabledAt: previous?.enabledAt ?? DateTime.formatIso(yield* DateTime.now),
                },
              ];
        yield* encodePersistedState({ version: 1, sources: next }).pipe(
          Effect.flatMap((contents) =>
            writeFileStringAtomically({ filePath: statePath, contents: `${contents}\n` }),
          ),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) =>
              new HermesRunError({
                reason: "writeFailed",
                detail: "Could not save which Hermes sources produce threads.",
                cause,
              }),
          ),
        );
        yield* Ref.set(enabledRef, next);
      }),
    );
    yield* Queue.offer(wake, undefined);
    return yield* listSources;
  });

  // ── Watcher ────────────────────────────────────────────────────────────

  const dispatch = (command: OrchestrationV2ServerCommand) =>
    orchestrator.dispatch(command).pipe(
      // A rejected command stays rejected; replaying it can never apply it.
      Effect.catchTags({ OrchestratorCommandPreviouslyRejectedError: () => Effect.void }),
      Effect.asVoid,
    );

  const hermesRunState = (run: TrackedRun, live: boolean): ThreadHermesRun => ({
    profile: run.profile.profile,
    sourceKey: run.sourceKey,
    sourceLabel: run.sourceLabel,
    sessionId: run.rootSessionId,
    latestSessionId: run.latestSessionId,
    live,
  });

  const setHermesRun = (run: TrackedRun, live: boolean, suffix: string) =>
    dispatch({
      type: "thread.hermes-run.set",
      commandId: CommandId.make(`${run.ids.prefix}:${suffix}`),
      threadId: run.ids.threadId,
      hermesRun: hermesRunState(run, live),
    });

  /**
   * Writes the entries whose item is new or has moved on from running. Event
   * ids derive from the item and its status, and an item is only skipped once
   * the thread holds it, so a failed write is retried next pass as it was.
   */
  const writeEntries = Effect.fn("HermesRunService.writeEntries")(function* (
    run: TrackedRun,
    entries: ReadonlyArray<HermesRunEntry>,
  ) {
    if (run.written === null) {
      const records = yield* projections.getThreadRecords(run.ids.threadId, ["turnItems"], {
        turnItemRunIds: [null],
      });
      run.written = new Map(records.turnItems.map((item) => [item.id, item.status]));
    }
    const written = run.written;
    const fresh = entries.filter(({ item }) => {
      const previous = written.get(item.id);
      return previous === undefined || (previous === "running" && item.status !== "running");
    });
    for (let index = 0; index < fresh.length; index += WRITE_BATCH_SIZE) {
      const batch = fresh.slice(index, index + WRITE_BATCH_SIZE);
      const events: OrchestrationV2DomainEvent[] = [];
      for (const entry of batch) {
        const item = yield* positions.normalize(entry.item);
        if (entry.message !== undefined) {
          events.push({
            id: EventId.make(`${entry.message.id}:message`),
            type: "message.updated",
            threadId: run.ids.threadId,
            occurredAt: entry.message.updatedAt,
            payload: entry.message,
          });
        }
        events.push({
          id: EventId.make(`${item.id}:${item.status}`),
          type: "turn-item.updated",
          threadId: run.ids.threadId,
          occurredAt: item.updatedAt,
          payload: item,
        });
      }
      yield* eventSink.write({ events });
      for (const { item } of batch) written.set(item.id, item.status);
    }
  });

  /**
   * Ends a run that can no longer be followed, so its source's replies unlock.
   * A failure fails the pass, and the close is retried next tick.
   */
  const closeRun = Effect.fn("HermesRunService.closeRun")(function* (
    run: TrackedRun,
    reason: string,
  ) {
    yield* writeEntries(run, [{ item: hermesRunNoticeItem(run.ids, reason, yield* DateTime.now) }]);
    yield* setHermesRun(run, false, "ended");
  });

  const createThread = Effect.fn("HermesRunService.createThread")(function* (
    run: TrackedRun,
    root: HermesSessionRow,
    project: OrchestrationProjectShell,
  ) {
    yield* dispatch({
      type: "thread.create",
      createdBy: "system",
      creationSource: "server",
      commandId: CommandId.make(`${run.ids.prefix}:create`),
      threadId: run.ids.threadId,
      projectId: project.id,
      title:
        root.title?.trim() ||
        `${run.sourceLabel} · ${RUN_TITLE_DATE.format(root.startedAt * 1000)}`,
      modelSelection: {
        instanceId: run.instanceId,
        model: root.model ?? DEFAULT_MODEL_BY_PROVIDER[HERMES] ?? "hermes-4",
      },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
    });
    yield* setHermesRun(run, true, "live");
    run.created = true;
  });

  const linkPullRequests = (
    run: TrackedRun,
    urls: readonly string[],
    project: OrchestrationProjectShell,
  ) =>
    Effect.forEach(
      urls,
      (url) =>
        Effect.gen(function* () {
          if (run.pullRequestUrls.has(url)) return;
          const parsed = parseChangeRequestUrl(url);
          const identity = project.repositoryIdentity;
          const repository = sourceControlRepositorySelector(identity);
          const host = identity?.provider
            ? pullRequestHostOf(identity, identity.provider as SourceControlProviderKind)
            : null;
          // Only the project's own repository, on its own host: a run mentions
          // upstream PRs too.
          if (
            parsed === null ||
            repository === null ||
            parsed.repository.toLowerCase() !== repository.toLowerCase() ||
            (host !== null && host !== parsed.host && host !== parsed.authority)
          ) {
            run.pullRequestUrls.add(url);
            return;
          }
          // Linking an already linked pull request changes nothing; any other
          // failure fails the pass so the batch, link included, is retried.
          yield* dispatch({
            type: "thread.pull-request.link",
            commandId: CommandId.make(`${run.ids.prefix}:pr:${parsed.repository}#${parsed.number}`),
            threadId: run.ids.threadId,
            host: parsed.host,
            repository: parsed.repository,
            number: parsed.number,
            url,
            source: "agent",
          });
          run.pullRequestUrls.add(url);
        }),
      { discard: true },
    );

  /** Mirrors whatever is new in one run. Returns true once the run needs no more ticks. */
  const advance = Effect.fn("HermesRunService.advance")(function* (
    run: TrackedRun,
    nowSeconds: number,
  ) {
    const dbPath = path.join(run.profile.home, "state.db");
    const chain = yield* Effect.sync(() => readHermesRunChain(dbPath, run.rootSessionId));
    if (chain === null) {
      // Unreadable is usually a lock and passes; a missing store never will.
      const exists = yield* fs.exists(dbPath).pipe(Effect.orElseSucceed(() => true));
      if (exists) return false;
      if (run.created) yield* closeRun(run, "Its Hermes profile no longer exists.");
      return true;
    }
    if (chain.length === 0) {
      if (run.created) yield* closeRun(run, "Hermes no longer has this run's session.");
      return true;
    }
    const root = chain[0]!;
    run.latestSessionId = chain.at(-1)!.id;
    const project = Option.getOrUndefined(
      yield* projectService.getShell(run.projectId).pipe(Effect.orElseSucceed(() => Option.none())),
    );
    if (project === undefined) return true;

    const sessionIds = chain.map((session) => session.id);
    const rows: HermesMessageRow[] = [];
    let cursor = run.cursor;
    for (;;) {
      const page = yield* Effect.sync(() => readHermesRunMessages(dbPath, sessionIds, cursor));
      if (page === null) return false;
      rows.push(...page.rows);
      cursor = page.lastId;
      if (!page.full) break;
    }
    const lastMessageAt = rows.at(-1)?.timestamp ?? run.lastMessageAt;
    const over = isHermesRunOver(chain, nowSeconds, lastMessageAt);

    if (!run.created) {
      const usedTools =
        chain.some((session) => session.toolCallCount > 0) ||
        rows.some((row) => row.toolCalls !== null);
      const report = rows.findLast((row) => row.role === "assistant" && row.content.trim());
      // Only runs that did something become threads, and never a silent one.
      if (!usedTools) return over;
      if (over && isSilentReport(report?.content ?? null)) return true;
      yield* createThread(run, root, project);
      // A thread this pass created holds nothing yet.
      run.written ??= new Map();
    }

    // Tool calls still waiting on a result carry across passes; work on a
    // copy so a failed pass can replay this batch from the same state.
    const toolCalls = new Map(run.toolCalls);
    const batch = hermesRunItemsFor(run.ids, rows, toolCalls);
    yield* writeEntries(run, batch.entries);
    yield* linkPullRequests(run, batch.pullRequestUrls, project);
    run.toolCalls.clear();
    for (const [id, call] of toolCalls) run.toolCalls.set(id, call);
    run.cursor = cursor;
    run.lastMessageAt = lastMessageAt;
    if (batch.lastAssistantText !== null) run.finalReport = batch.lastAssistantText;

    if (!over) {
      if (chain.length > 1) yield* setHermesRun(run, true, `live:${run.latestSessionId}`);
      return false;
    }

    const tip = chain.at(-1)!;
    if (isSilentReport(run.finalReport)) {
      yield* dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`${run.ids.prefix}:delete`),
        threadId: run.ids.threadId,
      });
      return true;
    }
    const failure =
      tip.endedAt === null
        ? "Hermes stopped reporting on this run before it finished."
        : tip.endReason === "cron_incomplete_no_output"
          ? "The run ended without a final answer."
          : null;
    if (failure !== null) {
      const endedAt = DateTime.makeUnsafe(
        Math.round((tip.endedAt ?? lastMessageAt ?? tip.startedAt) * 1000),
      );
      yield* writeEntries(run, [{ item: hermesRunNoticeItem(run.ids, failure, endedAt) }]);
    }
    yield* setHermesRun(run, false, "ended");
    return true;
  });

  /** Finds runs of switched-on sources that are not being followed yet. */
  const discover = Effect.fn("HermesRunService.discover")(function* (context: {
    readonly instanceId: ProviderInstanceId;
    readonly profiles: ReadonlyArray<HermesProfileHome>;
  }) {
    // Labels come from Hermes's config, read only when a new run shows up.
    let labels: Map<string, string> | null = null;
    const labelFor = Effect.fn("HermesRunService.labelFor")(function* (source: EnabledSource) {
      if (labels === null) {
        const listed = yield* listSources.pipe(Effect.orElseSucceed(() => null));
        labels = new Map(
          (listed?.sources ?? []).map((entry) => [
            sourceId(entry.profile, entry.sourceKey),
            entry.kind === "webhook" ? `webhook/${entry.label}` : entry.label,
          ]),
        );
      }
      return labels.get(sourceId(source.profile, source.sourceKey)) ?? labelOf(source.sourceKey);
    });
    for (const source of yield* Ref.get(enabledRef)) {
      const profile = context.profiles.find((entry) => entry.profile === source.profile);
      if (profile === undefined) continue;
      const since = Option.match(DateTime.make(source.enabledAt), {
        onNone: () => 0,
        onSome: (enabledAt) => DateTime.toEpochMillis(enabledAt) / 1000,
      });
      const roots = yield* Effect.sync(() =>
        readHermesRunRoots(path.join(profile.home, "state.db"), source.sourceKey, since),
      );
      for (const root of roots ?? []) {
        const prefix = hermesRunIdPrefix({ profile: profile.profile, sessionId: root.id });
        if (runs.has(prefix) || settledRoots.has(prefix)) continue;
        const threadId = ThreadId.make(prefix);
        const existing = yield* projections
          .getThreadShell(threadId)
          .pipe(Effect.orElseSucceed(() => null));
        // A thread from before a restart that already finished, or that was
        // deleted, needs nothing.
        if (
          existing !== null &&
          (existing.deletedAt !== null || existing.hermesRun?.live !== true)
        ) {
          settledRoots.add(prefix);
          continue;
        }
        runs.set(prefix, {
          ids: { threadId, prefix },
          profile,
          instanceId: context.instanceId,
          sourceKey: source.sourceKey,
          projectId: existing?.projectId ?? source.projectId,
          sourceLabel: yield* labelFor(source),
          rootSessionId: root.id,
          created: existing !== null,
          cursor: 0,
          lastMessageAt: null,
          latestSessionId: root.id,
          finalReport: null,
          toolCalls: new Map(),
          pullRequestUrls: new Set(),
          written: null,
        });
      }
    }
  });

  /**
   * Picks live runs back up after a restart from the threads themselves, so a
   * run whose source was switched off or moved meanwhile still finishes in its
   * own thread and never leaves replies locked.
   */
  let resumedLiveRuns = false;
  let closedWhileOff = false;
  const resumeLiveRuns = Effect.fn("HermesRunService.resumeLiveRuns")(function* (
    context: {
      readonly instanceId: ProviderInstanceId;
      readonly profiles: ReadonlyArray<HermesProfileHome>;
    } | null,
  ) {
    for (const thread of yield* projections.getLiveHermesRunThreads()) {
      const hermesRun = thread.hermesRun;
      if (hermesRun?.live !== true) continue;
      const prefix = hermesRunIdPrefix(hermesRun);
      if (runs.has(prefix)) continue;
      const profile = context?.profiles.find((entry) => entry.profile === hermesRun.profile);
      const run: TrackedRun = {
        ids: { threadId: thread.id, prefix },
        profile: profile ?? { profile: hermesRun.profile, home: "" },
        instanceId: context?.instanceId ?? thread.providerInstanceId,
        sourceKey: hermesRun.sourceKey,
        projectId: thread.projectId,
        sourceLabel: hermesRun.sourceLabel,
        rootSessionId: hermesRun.sessionId,
        created: true,
        cursor: 0,
        lastMessageAt: null,
        latestSessionId: hermesRun.latestSessionId,
        finalReport: null,
        toolCalls: new Map(),
        pullRequestUrls: new Set(),
        written: null,
      };
      // A run that can never be read again is closed rather than left
      // holding its source's replies.
      if (context === null) {
        yield* closeRun(run, HERMES_OFF_REASON);
        continue;
      }
      if (profile === undefined) {
        yield* closeRun(run, "Its Hermes profile no longer exists.");
        continue;
      }
      runs.set(prefix, run);
    }
    resumedLiveRuns = true;
  });

  /** One pass. Returns whether any followed run is still live. */
  const tick = Effect.gen(function* () {
    const context = yield* hermesContext;
    if (context === null) {
      // With Hermes off, its runs can't be followed: end them once per off
      // period so nothing stays reply-locked. One read, then idle.
      if (!closedWhileOff) {
        for (const run of runs.values()) {
          if (run.created) yield* closeRun(run, HERMES_OFF_REASON);
        }
        runs.clear();
        yield* resumeLiveRuns(null);
        resumedLiveRuns = false;
        closedWhileOff = true;
      }
      return false;
    }
    closedWhileOff = false;
    if (!resumedLiveRuns) yield* resumeLiveRuns(context);
    if ((yield* Ref.get(enabledRef)).length > 0) yield* discover(context);
    const nowSeconds = (yield* Clock.currentTimeMillis) / 1000;
    for (const [prefix, run] of runs) {
      const done = yield* advance(run, nowSeconds).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Hermes run mirroring failed for a run").pipe(
              Effect.annotateLogs({ threadId: run.ids.threadId, cause }),
            );
            // A thread deleted mid-run rejects every further command, so let it
            // go. Anything else is retried next tick: dropping a live run would
            // leave its source's replies locked.
            if (!run.created) return false;
            const thread = yield* projections
              .getThreadShell(run.ids.threadId)
              .pipe(Effect.orElseSucceed(() => undefined));
            return thread === null || (thread !== undefined && thread.deletedAt !== null);
          }),
        ),
      );
      if (done) {
        runs.delete(prefix);
        settledRoots.add(prefix);
      }
    }
    return [...runs.values()].some((run) => run.created);
  });

  const tickMutex = yield* Semaphore.make(1);
  const safeTick = tickMutex.withPermits(1)(
    tick.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Hermes run watcher tick failed").pipe(
          Effect.annotateLogs({ cause }),
          Effect.as(false),
        ),
      ),
    ),
  );

  const start: HermesRunService["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        for (;;) {
          const live = yield* safeTick;
          yield* Effect.raceFirst(
            Queue.take(wake),
            Effect.sleep(live ? LIVE_INTERVAL : IDLE_INTERVAL),
          );
        }
      }),
    );

  return HermesRunService.of({ listSources, setSource, sync: Effect.asVoid(safeTick), start });
});

export const layer = Layer.effect(HermesRunService, make);
