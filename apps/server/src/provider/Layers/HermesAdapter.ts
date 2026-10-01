import * as NodeURL from "node:url";

import {
  ApprovalRequestId,
  type HermesSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  parsePermissionRequest,
  parsePromptResponseUsage,
  type AcpUsageUpdate,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { applyHermesReasoningSelection } from "../../hermes/hermesReasoningOptions.ts";
import type { HermesReasoningLevel } from "../../hermes/hermesReasoning.ts";
import {
  applyHermesAcpModelSelection,
  currentHermesModelIdFromSessionSetup,
  hermesSessionInfoIndicatesCompaction,
  HERMES_TITLE_PROMPT_LIMIT,
  isHermesDerivedTitle,
  makeHermesAcpRuntime,
  normalizeHermesTerminalResult,
  resolveHermesAcpBaseModelId,
  resolveHermesSessionModeId,
} from "../acp/HermesAcpSupport.ts";
import {
  HERMES_NOTIFICATION_METHOD,
  HERMES_PROCESS_METHOD,
  HermesBackgroundProcesses,
  HermesNotification,
  HermesProcessReport,
} from "../acp/HermesBackground.ts";
import { HermesDelegations } from "../acp/HermesDelegation.ts";
import { type HermesAdapterShape } from "../Services/HermesAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("hermes");
const HERMES_RESUME_VERSION = 1 as const;

type HermesPromptAttachment = {
  readonly type: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
};

export function makeHermesAttachmentPromptPart(input: {
  readonly attachment: HermesPromptAttachment;
  readonly attachmentPath: string;
  readonly imageBytes?: Uint8Array;
}): EffectAcpSchema.ContentBlock {
  if (input.attachment.type === "image") {
    if (!input.imageBytes) {
      throw new Error("Image attachment bytes are required.");
    }
    return {
      type: "image",
      data: Buffer.from(input.imageBytes).toString("base64"),
      mimeType: input.attachment.mimeType,
    };
  }

  return {
    type: "resource_link",
    uri: NodeURL.pathToFileURL(input.attachmentPath).href,
    name: input.attachment.name,
    mimeType: input.attachment.mimeType,
    size: input.attachment.sizeBytes,
  };
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface HermesAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface HermesSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly delegations: HermesDelegations;
  /** Background processes the patched Hermes reports; see HermesBackground.ts. */
  readonly backgroundProcesses: HermesBackgroundProcesses;
  /** Background-work notices Hermes sent, waiting to wake the agent once idle. */
  pendingWakes: Array<{ text: string; notificationIds: ReadonlyArray<string> }>;
  readonly seenWakeIds: Set<string>;
  /** Stop holds wakes until the user's next turn, as Hermes's own TUI does. */
  wakesHeld: boolean;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Turns already interrupted; late prompt RPCs must not resurrect them. */
  interruptedTurnIds: Set<TurnId>;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  /** The first ACP prompt must be sent before overlapping steering can be redirected. */
  firstPromptDispatched: Deferred.Deferred<void> | undefined;
  currentModelId: string | undefined;
  /**
   * Reasoning level Hermes's live agent was built with, as far as we know.
   * Hermes only reads the level when it builds an agent, so a turn whose
   * selection differs from this has to force a rebuild to make it land.
   */
  reasoningLevel: HermesReasoningLevel | null | undefined;
  /** Last known reading from each token-usage source, merged on every emit. */
  tokenUsage: HermesTokenUsageState;
  /** The session's opening prompts, to recognise Hermes's derived title. */
  openingPrompts: Array<string>;
  /** Environment the session's `hermes acp` runs with, including a profile's HERMES_HOME. */
  readonly environment: NodeJS.ProcessEnv | undefined;
  /** Context still owed ahead of the next prompt; see {@link HermesResume.primer}. */
  pendingPrimer: string | undefined;
  stopped: boolean;
}

/**
 * Hermes reports token usage from two complementary places: streaming
 * `usage_update` notifications carry context pressure (`used`/`size`) but no
 * totals, and the end-of-turn `session/prompt` response carries the turn's
 * actual token counts but no window size. Neither is a superset of the other,
 * so readings accumulate here and each emit publishes the merge — a later
 * `usage_update` must not erase a known total, and vice versa.
 */
interface HermesTokenUsageState {
  usedTokens?: number;
  maxTokens?: number;
  totalProcessedTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function appendPromptResultToTurn(
  ctx: HermesSessionContext,
  turnId: TurnId,
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): void {
  const existingTurnRecord = ctx.turns.find((turn) => turn.id === turnId);
  ctx.turns = existingTurnRecord
    ? ctx.turns.map((turn) =>
        turn.id === turnId
          ? { ...turn, items: [...turn.items, { prompt: promptParts, result }] }
          : turn,
      )
    : [...ctx.turns, { id: turnId, items: [{ prompt: promptParts, result }] }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const resolveNotificationTurnId = (ctx: HermesSessionContext): TurnId | undefined =>
  ctx.activeTurnId;

const resolveSessionCallbackTurnId = (
  sessions: ReadonlyMap<ThreadId, HermesSessionContext>,
  threadId: ThreadId,
): TurnId | undefined => sessions.get(threadId)?.activeTurnId;

interface HermesResume {
  /** The ACP session to load. Absent for a thread whose first session is still to come. */
  readonly sessionId?: string;
  /**
   * Hermes home (profile directory) the session lives in, when it is not the
   * instance's own. Threads mirrored from a background run in another profile
   * keep talking to that profile.
   */
  readonly hermesHome?: string;
  /**
   * Context owed ahead of the next prompt, sent once and dropped from the
   * cursor after Hermes accepts it. Kept in the cursor until then, so a
   * restart or a failed first prompt does not lose it.
   */
  readonly primer?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseHermesResume(raw: unknown): HermesResume | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== HERMES_RESUME_VERSION) return undefined;
  const sessionId = nonEmptyString(raw.sessionId);
  const hermesHome = nonEmptyString(raw.hermesHome);
  const primer = nonEmptyString(raw.primer);
  if (!sessionId && !hermesHome && !primer) return undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(hermesHome ? { hermesHome } : {}),
    ...(primer ? { primer } : {}),
  };
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === kind);
  return option?.optionId.trim() || undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

export function hermesPromptSettlementBelongsToContext(input: {
  readonly liveAcpSessionId: string;
  readonly expectedAcpSessionId: string;
  readonly liveActiveTurnId: TurnId | undefined;
  readonly liveSessionActiveTurnId: TurnId | undefined;
  readonly turnId: TurnId;
}): boolean {
  return (
    input.liveAcpSessionId === input.expectedAcpSessionId &&
    (input.liveActiveTurnId === input.turnId || input.liveSessionActiveTurnId === input.turnId)
  );
}

export function makeHermesAdapter(
  hermesSettings: HermesSettings,
  options?: HermesAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("hermes");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, HermesSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const reasoningConfigMutex = yield* Semaphore.make(1);
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Hermes runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Hermes ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const finishDelegations = Effect.fnUntraced(function* (
      ctx: HermesSessionContext,
      turnId: TurnId | undefined,
      status: "cancelled" | "failed" | "interrupted",
      error?: string,
      preserveBackground = false,
    ) {
      for (const event of ctx.delegations.finish(
        status,
        error,
        turnId ? { turnId, preserveBackground } : undefined,
      )) {
        yield* offerRuntimeEvent({
          ...event,
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
        });
      }
    });

    const emitBackgroundProcessEvents = Effect.fnUntraced(function* (
      ctx: HermesSessionContext,
      events: ReturnType<HermesBackgroundProcesses["report"]>,
    ) {
      for (const event of events) {
        yield* offerRuntimeEvent({
          ...event,
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
        });
      }
    });

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const settlePromptInFlight = (
      threadId: ThreadId,
      turnId: TurnId,
      expectedAcpSessionId: string,
      options?: {
        readonly errorMessage?: string;
        readonly completedStopReason?: EffectAcpSchema.StopReason | null;
        readonly emitTurnCompletion?: boolean;
        /** Interrupt/cancel: drop every outstanding prompt slot and settle once. */
        readonly settleAllPrompts?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const liveCtx = sessions.get(threadId);
        if (!liveCtx) {
          return;
        }
        const settlementBelongsToLiveContext = hermesPromptSettlementBelongsToContext({
          liveAcpSessionId: liveCtx.acpSessionId,
          expectedAcpSessionId,
          liveActiveTurnId: liveCtx.activeTurnId,
          liveSessionActiveTurnId: liveCtx.session.activeTurnId,
          turnId,
        });
        if (!settlementBelongsToLiveContext) {
          // interruptTurn already consumed every prompt slot for this turn. A
          // late prompt result must neither emit a second terminal event nor
          // consume a slot belonging to a newer turn on the same ACP session.
          if (
            liveCtx.acpSessionId !== expectedAcpSessionId ||
            liveCtx.interruptedTurnIds.has(turnId)
          ) {
            return;
          }
          if (options?.emitTurnCompletion !== false) {
            if (options?.errorMessage !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: "failed",
                  errorMessage: options.errorMessage,
                },
              });
            } else if (options?.completedStopReason !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
                  stopReason: options.completedStopReason ?? null,
                },
              });
            }
          }
          return;
        }
        let settleTurnId = turnId;
        if (options?.settleAllPrompts) {
          liveCtx.promptsInFlight = 0;
          if (liveCtx.activeTurnId !== turnId && liveCtx.session.activeTurnId !== turnId) {
            const fallbackTurnId = liveCtx.activeTurnId ?? liveCtx.session.activeTurnId;
            if (!fallbackTurnId) {
              if (liveCtx.session.status === "running" || liveCtx.session.status === "connecting") {
                const updatedAt = yield* nowIso;
                const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
                liveCtx.activeTurnId = undefined;
                liveCtx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt,
                };
              }
              return;
            }
            settleTurnId = fallbackTurnId;
          }
        } else {
          const remainingPrompts = Math.max(0, liveCtx.promptsInFlight - 1);
          if (
            remainingPrompts > 0 ||
            liveCtx.activeTurnId !== settleTurnId ||
            liveCtx.session.activeTurnId !== settleTurnId
          ) {
            liveCtx.promptsInFlight = remainingPrompts;
            return;
          }
          liveCtx.promptsInFlight = remainingPrompts;
        }
        yield* finishDelegations(
          liveCtx,
          settleTurnId,
          options?.errorMessage
            ? "failed"
            : options?.completedStopReason === "cancelled"
              ? "cancelled"
              : "interrupted",
          options?.errorMessage,
          true,
        );
        const updatedAt = yield* nowIso;
        const canEmitTurnCompletion =
          liveCtx.session.status === "running" || liveCtx.session.status === "connecting";
        const shouldEmitFailedTurn = options?.errorMessage !== undefined && canEmitTurnCompletion;
        const shouldEmitCompletedTurn =
          options?.completedStopReason !== undefined && canEmitTurnCompletion;
        const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
        liveCtx.activeTurnId = undefined;
        liveCtx.session = {
          ...readySession,
          status: "ready",
          updatedAt,
        };
        if (options?.emitTurnCompletion === false) {
          return;
        }
        if (shouldEmitFailedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: "failed",
              errorMessage: options.errorMessage,
            },
          });
        } else if (shouldEmitCompletedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: options.completedStopReason ?? null,
            },
          });
        }
      });

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native Hermes notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const emitPlanUpdate = (
      ctx: HermesSessionContext,
      turnId: TurnId | undefined,
      stamp: { readonly eventId: EventId; readonly createdAt: string },
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${turnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    /**
     * Publish the merge of every token-usage reading seen so far as the shared
     * context-window snapshot, so ProviderRuntimeIngestion produces
     * `context-window.updated` activities exactly like Claude and Codex do.
     *
     * Hermes's `used` is a whole-request estimate (system prompt + history +
     * tool schemas), not a per-turn delta, so the `last*` fields stay absent
     * rather than carry a number that would be wrong.
     */
    const emitMergedTokenUsage = (
      ctx: HermesSessionContext,
      turnId: TurnId | undefined,
      raw: { readonly method: string; readonly payload: unknown },
    ) =>
      Effect.gen(function* () {
        const state = ctx.tokenUsage;
        const usedTokens = state.usedTokens;
        if (usedTokens === undefined) {
          return;
        }
        const { totalProcessedTokens } = state;
        yield* offerRuntimeEvent({
          type: "thread.token-usage.updated",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          ...(turnId !== undefined ? { turnId } : {}),
          payload: {
            usage: {
              usedTokens,
              // Matches Claude and Codex: a total that is not larger than the
              // live window reading tells the reader nothing, so it is omitted.
              ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
                ? { totalProcessedTokens }
                : {}),
              ...(state.maxTokens !== undefined ? { maxTokens: state.maxTokens } : {}),
              ...(state.inputTokens !== undefined ? { inputTokens: state.inputTokens } : {}),
              ...(state.cachedInputTokens !== undefined
                ? { cachedInputTokens: state.cachedInputTokens }
                : {}),
              ...(state.outputTokens !== undefined ? { outputTokens: state.outputTokens } : {}),
              ...(state.reasoningOutputTokens !== undefined
                ? { reasoningOutputTokens: state.reasoningOutputTokens }
                : {}),
              // Hermes compresses on its own once the window fills.
              compactsAutomatically: true,
            },
          },
          raw: {
            source: "acp.jsonrpc",
            method: raw.method,
            payload: raw.payload,
          },
        });
      });

    const emitTokenUsage = (
      ctx: HermesSessionContext,
      usage: AcpUsageUpdate,
      rawPayload: unknown,
    ) =>
      Effect.gen(function* () {
        // Hermes `used` is a whole-request estimate, so `0` is a real reading
        // (e.g. right after a reset) rather than an absent one. Emitting it
        // clears the meter; dropping it would leave stale context pressure.
        const usedTokens =
          usage.usedTokens !== null && usage.usedTokens !== undefined
            ? Math.max(0, usage.usedTokens)
            : null;
        if (usedTokens === null) {
          return;
        }
        ctx.tokenUsage = {
          ...ctx.tokenUsage,
          usedTokens,
          ...(usage.maxTokens !== undefined ? { maxTokens: usage.maxTokens } : {}),
        };
        yield* emitMergedTokenUsage(ctx, resolveNotificationTurnId(ctx), {
          method: "session/update",
          payload: rawPayload,
        });
      });

    /**
     * Fold the end-of-turn `session/prompt` usage totals into the snapshot.
     * Hermes never reports a window size here, and only reports the turn's
     * totals, so this contributes `totalProcessedTokens` plus the breakdown and
     * leaves `usedTokens`/`maxTokens` to `usage_update`. When no `usage_update`
     * has landed yet, the prompt token count is the same quantity Hermes would
     * have reported as `used`, so it seeds the meter rather than dropping it.
     */
    const emitPromptResponseTokenUsage = (
      ctx: HermesSessionContext,
      turnId: TurnId,
      result: EffectAcpSchema.PromptResponse,
    ) =>
      Effect.gen(function* () {
        const usage = parsePromptResponseUsage(result);
        if (!usage) {
          return;
        }
        ctx.tokenUsage = {
          ...ctx.tokenUsage,
          ...(ctx.tokenUsage.usedTokens === undefined && usage.inputTokens !== undefined
            ? { usedTokens: usage.inputTokens }
            : {}),
          totalProcessedTokens: usage.totalTokens,
          ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
          ...(usage.cachedInputTokens !== undefined
            ? { cachedInputTokens: usage.cachedInputTokens }
            : {}),
          ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
          ...(usage.reasoningOutputTokens !== undefined
            ? { reasoningOutputTokens: usage.reasoningOutputTokens }
            : {}),
        };
        yield* emitMergedTokenUsage(ctx, turnId, {
          method: "session/prompt",
          payload: result,
        });
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<HermesSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: HermesSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        yield* finishDelegations(ctx, undefined, "cancelled");
        yield* emitBackgroundProcessEvents(ctx, ctx.backgroundProcesses.stopAll());
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: HermesAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const hermesModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          // Hermes resolves reasoning effort from `config.yaml` when its
          // process starts, and never re-reads it for a running session, so
          // the composer's level has to be on disk before the spawn below.
          // That is also why the descriptor bills it as a next-session
          // setting rather than pretending it lands mid-conversation.
          const resume = parseHermesResume(input.resumeCursor);
          const sessionEnvironment = resume?.hermesHome
            ? { ...(options?.environment ?? process.env), HERMES_HOME: resume.hermesHome }
            : options?.environment;
          let reasoningConfigPermitHeld = false;
          yield* reasoningConfigMutex.take(1);
          reasoningConfigPermitHeld = true;
          yield* Effect.addFinalizer(() =>
            reasoningConfigPermitHeld ? reasoningConfigMutex.release(1) : Effect.void,
          );
          const startReasoningLevel = yield* applyHermesReasoningSelection({
            model: hermesModelSelection?.model,
            selections: hermesModelSelection?.options,
            ...(sessionEnvironment ? { environment: sessionEnvironment } : {}),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );

          const resumeSessionId = resume?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeHermesAcpRuntime({
            hermesSettings,
            ...(sessionEnvironment ? { environment: sessionEnvironment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/request_permission", params);
                  if (input.runtimeMode === "full-access") {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const permissionRequest = parsePermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                  pendingApprovals.set(requestId, { decision });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const selectedOptionId =
                    resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
                  return {
                    outcome: selectedOptionId
                      ? {
                          outcome: "selected" as const,
                          optionId: selectedOptionId,
                        }
                      : ({ outcome: "cancelled" } as const),
                  };
                }),
              ),
            );
            yield* acp.handleExtNotification(HERMES_PROCESS_METHOD, HermesProcessReport, (report) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, HERMES_PROCESS_METHOD, report);
                  const ctx = sessions.get(input.threadId);
                  if (!ctx || ctx.stopped || ctx.acpSessionId !== report.sessionId) return;
                  yield* emitBackgroundProcessEvents(
                    ctx,
                    ctx.backgroundProcesses.report(report, ctx.activeTurnId),
                  );
                }),
              ),
            );
            yield* acp.handleExtNotification(
              HERMES_NOTIFICATION_METHOD,
              HermesNotification,
              (notice) =>
                mapAcpCallbackFailure(
                  Effect.gen(function* () {
                    yield* logNative(input.threadId, HERMES_NOTIFICATION_METHOD, notice);
                    const ctx = sessions.get(input.threadId);
                    if (!ctx || ctx.stopped || ctx.acpSessionId !== notice.sessionId) return;
                    const notificationIds = notice.notificationIds ?? [];
                    if (
                      notificationIds.length === 0 ||
                      !notificationIds.every((id) => ctx.seenWakeIds.has(id))
                    ) {
                      for (const id of notificationIds) ctx.seenWakeIds.add(id);
                      // Retain recent receipts after draining, including while the wake runs.
                      while (ctx.seenWakeIds.size > 1024) {
                        const oldest = ctx.seenWakeIds.values().next().value;
                        if (oldest !== undefined) ctx.seenWakeIds.delete(oldest);
                      }
                      ctx.pendingWakes.push({ text: notice.text, notificationIds });
                    }
                    yield* wakeWhenIdle(input.threadId);
                  }),
                ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );
          reasoningConfigPermitHeld = false;
          yield* reasoningConfigMutex.release(1);

          // Hermes exposes its edit-approval policy as ACP session modes, so
          // the thread's runtime mode picks the matching one. A build that
          // advertises no usable mode — or rejects `session/set_mode` — still
          // runs: the adapter's own approval gate is what actually enforces
          // `approval-required`, so a failure here is a warning, not a stop.
          const requestedModeId = resolveHermesSessionModeId({
            runtimeMode: input.runtimeMode,
            modeState: yield* acp.getModeState,
          });
          if (requestedModeId !== undefined) {
            yield* acp
              .request("session/set_mode", {
                sessionId: started.sessionId,
                modeId: requestedModeId,
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Hermes session mode selection failed.", {
                    cause,
                    threadId: input.threadId,
                    modeId: requestedModeId,
                  }),
                ),
              );
          }

          const requestedStartModelId = hermesModelSelection?.model
            ? resolveHermesAcpBaseModelId(hermesModelSelection.model)
            : undefined;
          const boundModelId = yield* applyHermesAcpModelSelection({
            runtime: acp,
            currentModelId: currentHermesModelIdFromSessionSetup(started.sessionSetupResult),
            requestedModelId: requestedStartModelId,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(boundModelId ? { model: resolveHermesAcpBaseModelId(boundModelId) } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: HERMES_RESUME_VERSION,
              sessionId: started.sessionId,
              ...(resume?.hermesHome ? { hermesHome: resume.hermesHome } : {}),
              ...(resume?.primer ? { primer: resume.primer } : {}),
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: HermesSessionContext = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            interruptedTurnIds: new Set(),
            delegations: new HermesDelegations(),
            backgroundProcesses: new HermesBackgroundProcesses(),
            pendingWakes: [],
            seenWakeIds: new Set(),
            wakesHeld: false,
            promptsInFlight: 0,
            firstPromptDispatched: undefined,
            currentModelId: boundModelId,
            reasoningLevel: startReasoningLevel,
            tokenUsage: {},
            openingPrompts: [],
            environment: sessionEnvironment,
            pendingPrimer: resume?.primer,
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier") {
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                }
                if (
                  event._tag === "PlanUpdated" ||
                  event._tag === "ToolCallUpdated" ||
                  event._tag === "ContentDelta" ||
                  event._tag === "ThoughtDelta"
                ) {
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                }

                if (event._tag === "ModeChanged") {
                  return;
                }

                // Hermes advertises commands right after `session/new` and
                // sends usage/session-info updates outside a turn too, so
                // these are handled ahead of the turn gate below. The provider
                // snapshot's `slashCommands` is filled by the provider probe
                // (HermesProvider), which owns that snapshot; here the
                // advertisement is only logged so a mismatch is diagnosable.
                if (event._tag === "AvailableCommandsUpdated") {
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                  return;
                }

                if (event._tag === "UsageUpdated") {
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                  yield* emitTokenUsage(ctx, event.usage, event.rawPayload);
                  return;
                }

                if (event._tag === "SessionInfoUpdated") {
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                  // Hermes auto-titles each session in its first turn's prologue.
                  if (
                    event.title !== undefined &&
                    !isHermesDerivedTitle(event.title, ctx.openingPrompts)
                  ) {
                    yield* offerRuntimeEvent({
                      type: "thread.metadata.updated",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      payload: { name: event.title },
                      raw: {
                        source: "acp.jsonrpc",
                        method: "session/update",
                        payload: event.rawPayload,
                      },
                    });
                  }
                  if (hermesSessionInfoIndicatesCompaction(event.rawPayload)) {
                    yield* offerRuntimeEvent({
                      type: "thread.state.changed",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      payload: { state: "compacted" },
                    });
                  }
                  return;
                }

                // Detached children outlive prompts, but cannot report after ACP
                // disconnects. Handle this even with no active parent turn.
                if (event._tag === "ConnectionTerminated") {
                  yield* finishDelegations(
                    ctx,
                    undefined,
                    "interrupted",
                    "Hermes ACP disconnected before the child result arrived.",
                  );
                  yield* emitBackgroundProcessEvents(ctx, ctx.backgroundProcesses.stopAll());
                  return;
                }

                const notificationTurnId = resolveNotificationTurnId(ctx);
                if (event._tag === "ToolCallUpdated") {
                  const tasks = ctx.delegations.update(
                    event.toolCall,
                    notificationTurnId && !ctx.interruptedTurnIds.has(notificationTurnId)
                      ? notificationTurnId
                      : undefined,
                  );
                  if (tasks) {
                    for (const task of tasks) {
                      yield* offerRuntimeEvent({
                        ...task,
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                      });
                    }
                    return;
                  }
                }
                if (
                  notificationTurnId === undefined ||
                  ctx.interruptedTurnIds.has(notificationTurnId)
                ) {
                  return;
                }
                const stamp = yield* makeEventStamp();

                switch (event._tag) {
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* emitPlanUpdate(
                      ctx,
                      notificationTurnId,
                      stamp,
                      event.payload,
                      event.rawPayload,
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated": {
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        toolCall: normalizeHermesTerminalResult(event.toolCall),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "ThoughtDelta":
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        streamKind: "reasoning_text",
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Hermes runtime notification.", { cause }),
            ),
            // Fork into the session scope, not the calling fiber. `forkChild`
            // makes this a child of `startSession`, and Effect interrupts a
            // fiber's children when it completes, so the consumer died as soon
            // as `startSession` returned and every later notification was
            // dropped. The scope is created, stored on the context and closed
            // on teardown already; only the fork target was wrong.
            Effect.forkIn(ctx.scope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Hermes ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    /**
     * One prompt. A user turn releases wakes held by Stop; a wake turn prompts
     * with Hermes's background-work notices and has no user message of its own.
     */
    const runTurn = (
      input: ProviderSendTurnInput,
      origin: "user" | "wake",
      notificationIds: ReadonlyArray<string> = [],
    ) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            if (origin === "user") {
              ctx.wakesHeld = false;
            }
            // A sendTurn while a prompt is in flight is a steer: the agent
            // folds the new prompt into the ongoing work, so the active turn
            // id is reused instead of opening a new turn.
            const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
            const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
            if (steeringTurnId === undefined) {
              ctx.firstPromptDispatched = yield* Deferred.make<void>();
            }
            const firstPromptDispatched = ctx.firstPromptDispatched;
            // Count this prompt immediately so a superseded in-flight prompt
            // resolving from here on does not settle the turn; decremented on
            // preparation failure here, and after the prompt below otherwise.
            ctx.promptsInFlight += 1;
            // Bind the turn id before cooperative yields so interruptTurn can
            // settle this prompt even if stop arrives during preparation.
            ctx.activeTurnId = turnId;
            ctx.session = {
              ...ctx.session,
              status: steeringTurnId === undefined ? "connecting" : "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };

            return yield* Effect.gen(function* () {
              const turnModelSelection =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined;
              const requestedTurnModelId = turnModelSelection?.model
                ? resolveHermesAcpBaseModelId(turnModelSelection.model)
                : undefined;

              // Record the turn's reasoning level before the model call below:
              // Hermes reads `config.yaml` while it builds the agent, so the
              // write has to be on disk first to be picked up by the rebuild
              // that `session/set_model` triggers.
              const { turnReasoningLevel, currentModelId } = yield* reasoningConfigMutex.withPermit(
                Effect.gen(function* () {
                  const turnReasoningLevel = yield* applyHermesReasoningSelection({
                    model: turnModelSelection?.model,
                    selections: turnModelSelection?.options,
                    ...(ctx.environment ? { environment: ctx.environment } : {}),
                  }).pipe(
                    Effect.provideService(FileSystem.FileSystem, fileSystem),
                    Effect.provideService(Path.Path, path),
                  );
                  // A model switch rebuilds the agent by itself; only a level that
                  // moved on its own needs the no-op switch to force one.
                  const reasoningNeedsRebuild =
                    turnReasoningLevel !== undefined && turnReasoningLevel !== ctx.reasoningLevel;
                  const currentModelId = yield* applyHermesAcpModelSelection({
                    runtime: ctx.acp,
                    currentModelId: ctx.currentModelId,
                    requestedModelId: requestedTurnModelId,
                    ...(reasoningNeedsRebuild ? { forceReapply: true } : {}),
                    mapError: (cause) =>
                      mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
                  });
                  return { turnReasoningLevel, currentModelId };
                }),
              );
              if (turnReasoningLevel !== undefined) {
                ctx.reasoningLevel = turnReasoningLevel;
              }

              const text = input.input?.trim();
              if (
                origin === "user" &&
                text &&
                ctx.openingPrompts.length < HERMES_TITLE_PROMPT_LIMIT
              ) {
                ctx.openingPrompts.push(text);
              }
              const attachmentPromptParts = yield* Effect.forEach(
                input.attachments ?? [],
                (attachment) =>
                  Effect.gen(function* () {
                    const attachmentPath = resolveAttachmentPath({
                      attachmentsDir: serverConfig.attachmentsDir,
                      attachment,
                    });
                    if (!attachmentPath) {
                      return yield* new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: `Invalid attachment id '${attachment.id}'.`,
                      });
                    }
                    const imageBytes =
                      attachment.type === "image"
                        ? yield* fileSystem.readFile(attachmentPath).pipe(
                            Effect.mapError(
                              (cause) =>
                                new ProviderAdapterRequestError({
                                  provider: PROVIDER,
                                  method: "session/prompt",
                                  detail: cause.message,
                                  cause,
                                }),
                            ),
                          )
                        : undefined;
                    return makeHermesAttachmentPromptPart({
                      attachment,
                      attachmentPath,
                      ...(imageBytes ? { imageBytes } : {}),
                    });
                  }),
              );
              // A steer joins a prompt already in flight, which carried the primer.
              const primer = steeringTurnId === undefined ? ctx.pendingPrimer : undefined;
              const promptParts: Array<EffectAcpSchema.ContentBlock> = [
                ...(primer ? [{ type: "text" as const, text: primer }] : []),
                ...(text ? [{ type: "text" as const, text }] : []),
                ...attachmentPromptParts,
              ];

              if (promptParts.length === 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Turn requires non-empty text or attachments.",
                });
              }

              ctx.currentModelId = currentModelId;
              const displayModel = currentModelId
                ? resolveHermesAcpBaseModelId(currentModelId)
                : undefined;
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              if (ctx.interruptedTurnIds.has(turnId)) {
                yield* settlePromptInFlight(input.threadId, turnId, ctx.acpSessionId, {
                  completedStopReason: "cancelled",
                  emitTurnCompletion: false,
                  settleAllPrompts: true,
                });
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Hermes prompt was interrupted during preparation.",
                });
              }
              if (steeringTurnId === undefined) {
                ctx.lastPlanFingerprint = undefined;
              }
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                ...(displayModel ? { model: displayModel } : {}),
              };

              if (steeringTurnId === undefined) {
                yield* offerRuntimeEvent({
                  type: "turn.started",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: displayModel ? { model: displayModel } : {},
                });
              }

              return {
                acp: ctx.acp,
                acpSessionId: ctx.acpSessionId,
                displayModel,
                promptParts,
                turnId,
                steeringTurnId,
                firstPromptDispatched,
                primed: primer !== undefined,
              };
            }).pipe(
              Effect.tapCause(() =>
                Effect.gen(function* () {
                  if (steeringTurnId === undefined && firstPromptDispatched) {
                    yield* Deferred.succeed(firstPromptDispatched, undefined);
                  }
                  const liveCtx = sessions.get(input.threadId);
                  if (!liveCtx) {
                    return;
                  }
                  yield* settlePromptInFlight(input.threadId, turnId, liveCtx.acpSessionId, {
                    errorMessage: "Hermes prompt preparation failed.",
                    emitTurnCompletion: false,
                  });
                }),
              ),
            );
          }),
        );
        const promptSettled = yield* Ref.make(false);
        const promptRpcSucceeded = yield* Ref.make(false);
        const promptResultRef = yield* Ref.make<EffectAcpSchema.PromptResponse | undefined>(
          undefined,
        );

        const promptFailureMessageRef = yield* Ref.make<string | undefined>(undefined);

        return yield* Effect.gen(function* () {
          if (prepared.steeringTurnId !== undefined && prepared.firstPromptDispatched) {
            yield* Deferred.await(prepared.firstPromptDispatched);
          }
          // Hermes only redirects text-only prompts into a running turn. It queues
          // anything else as plain text, dropping attachments, so those steers
          // wait for the running prompt instead.
          const steersLive =
            prepared.steeringTurnId !== undefined &&
            prepared.promptParts.every((part) => part.type === "text");
          const promptRequest = steersLive
            ? prepared.acp.promptWhileRunning({ prompt: prepared.promptParts })
            : prepared.acp.prompt(
                {
                  // ACP has no system-message field; keep runtime context separate from user input.
                  ...(notificationIds.length > 0
                    ? { _meta: { "hermes.notificationIds": notificationIds } }
                    : {}),
                  prompt: [
                    ...prepared.promptParts,
                    {
                      type: "text",
                      text: buildRuntimeInstructions({
                        harness: "Hermes",
                        model: prepared.displayModel,
                      }),
                    },
                  ],
                },
                prepared.steeringTurnId === undefined && prepared.firstPromptDispatched
                  ? { dispatched: prepared.firstPromptDispatched }
                  : undefined,
              );
          const result = yield* promptRequest.pipe(
            Effect.tap((promptResult) =>
              Effect.all([
                Ref.set(promptRpcSucceeded, true),
                Ref.set(promptResultRef, promptResult),
              ]),
            ),
            Effect.tapError((error) =>
              Ref.set(
                promptFailureMessageRef,
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error).message,
              ).pipe(Effect.andThen(prepared.acp.drainEvents)),
            ),
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
            ),
          );

          return yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              if (ctx.acpSessionId !== prepared.acpSessionId) {
                yield* settlePromptInFlight(
                  input.threadId,
                  prepared.turnId,
                  prepared.acpSessionId,
                  {
                    errorMessage: "Hermes session changed before the turn completed.",
                    settleAllPrompts: true,
                  },
                );
                yield* Ref.set(promptSettled, true);
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Hermes session changed before the turn completed.",
                });
              }
              // Hermes accepted the primed prompt, so the primer is spent.
              if (prepared.primed && ctx.pendingPrimer !== undefined) {
                ctx.pendingPrimer = undefined;
                const { primer: _spent, ...cursor } = ctx.session.resumeCursor as Record<
                  string,
                  unknown
                >;
                ctx.session = { ...ctx.session, resumeCursor: cursor };
              }
              // Keep prompt settlement atomic with respect to Stop and steering.
              // interruptTurn marks its target before waiting for this lock, so
              // cancellation can still win while queued ACP events are drained.
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              yield* prepared.acp.drainEvents;
              if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              if (
                ctx.promptsInFlight <= 0 ||
                ctx.activeTurnId !== prepared.turnId ||
                ctx.session.activeTurnId !== prepared.turnId
              ) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              appendPromptResultToTurn(ctx, prepared.turnId, prepared.promptParts, result);
              yield* emitPromptResponseTokenUsage(ctx, prepared.turnId, result);
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: prepared.turnId,
                updatedAt: yield* nowIso,
                ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
              };
              const remainingPrompts = Math.max(0, ctx.promptsInFlight - 1);
              ctx.promptsInFlight = remainingPrompts;

              // Only the last remaining prompt settles the turn. A steer-
              // superseded prompt resolving while another is in flight or
              // pending must leave the merged turn running.
              if (
                remainingPrompts === 0 &&
                ctx.activeTurnId === prepared.turnId &&
                ctx.session.activeTurnId === prepared.turnId
              ) {
                if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                  yield* Ref.set(promptSettled, true);
                  return {
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    resumeCursor: ctx.session.resumeCursor,
                  };
                }
                yield* finishDelegations(
                  ctx,
                  prepared.turnId,
                  result.stopReason === "cancelled" ? "cancelled" : "interrupted",
                  undefined,
                  true,
                );
                const completedAt = yield* nowIso;
                const { activeTurnId: _completedTurnId, ...readySession } = ctx.session;
                ctx.activeTurnId = undefined;
                ctx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt: completedAt,
                  ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
                };
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  payload: {
                    state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                    stopReason: result.stopReason,
                  },
                });
                ctx.interruptedTurnIds.delete(prepared.turnId);
                yield* Ref.set(promptSettled, true);
              } else if (remainingPrompts > 0) {
                yield* Ref.set(promptSettled, true);
              }

              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (prepared.steeringTurnId === undefined && prepared.firstPromptDispatched) {
                yield* Deferred.succeed(prepared.firstPromptDispatched, undefined);
              }
              if (yield* Ref.get(promptSettled)) {
                return;
              }

              if (yield* Ref.get(promptRpcSucceeded)) {
                const promptResult = yield* Ref.get(promptResultRef);
                if (promptResult === undefined) {
                  return;
                }
                yield* withThreadLock(
                  input.threadId,
                  Effect.gen(function* () {
                    const ctx = yield* requireSession(input.threadId);
                    if (ctx.acpSessionId !== prepared.acpSessionId) {
                      yield* settlePromptInFlight(
                        input.threadId,
                        prepared.turnId,
                        prepared.acpSessionId,
                        {
                          errorMessage: "Hermes session changed before the turn completed.",
                          settleAllPrompts: true,
                        },
                      );
                      return;
                    }
                    if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                      return;
                    }
                    if (
                      ctx.promptsInFlight <= 0 ||
                      ctx.activeTurnId !== prepared.turnId ||
                      ctx.session.activeTurnId !== prepared.turnId
                    ) {
                      return;
                    }
                    appendPromptResultToTurn(
                      ctx,
                      prepared.turnId,
                      prepared.promptParts,
                      promptResult,
                    );
                    yield* emitPromptResponseTokenUsage(ctx, prepared.turnId, promptResult);
                    yield* settlePromptInFlight(
                      input.threadId,
                      prepared.turnId,
                      prepared.acpSessionId,
                      { completedStopReason: promptResult.stopReason },
                    );
                  }),
                );
                return;
              }

              const errorMessage = yield* Ref.get(promptFailureMessageRef);
              yield* withThreadLock(
                input.threadId,
                settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
                  errorMessage: errorMessage ?? "Hermes prompt request failed.",
                }),
              );
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        );
      }).pipe(Effect.ensuring(wakeWhenIdle(input.threadId)));

    const sendTurn: HermesAdapterShape["sendTurn"] = (input) => runTurn(input, "user");

    /**
     * Prompt with Hermes's background-work notices once no prompt is in
     * flight, the way Hermes's CLI starts a turn for them. Forked into the
     * session scope: the notice arrives on the ACP dispatcher, which must stay
     * free to deliver the prompt's own updates and response.
     */
    function wakeWhenIdle(threadId: ThreadId): Effect.Effect<void> {
      return Effect.suspend(() => {
        const ctx = sessions.get(threadId);
        if (
          !ctx ||
          ctx.stopped ||
          ctx.wakesHeld ||
          ctx.promptsInFlight > 0 ||
          ctx.pendingWakes.length === 0
        ) {
          return Effect.void;
        }
        const wakes = ctx.pendingWakes.splice(0);
        const notices = wakes.map((wake) => wake.text).join("\n\n");
        const notificationIds = wakes.flatMap((wake) => [...wake.notificationIds]);
        return runTurn({ threadId, input: notices }, "wake", notificationIds).pipe(
          Effect.tapCause(() =>
            Effect.sync(() => {
              ctx.pendingWakes.unshift(...wakes);
              ctx.wakesHeld = true;
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Hermes background wake failed.", { cause, threadId }),
          ),
          Effect.forkIn(ctx.scope),
          Effect.asVoid,
        );
      });
    }

    const interruptTurn: HermesAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const observed = yield* Effect.sync(() => {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) {
            return {
              _tag: "Proceed" as const,
              acpSessionId: undefined,
              interruptedTurnId: turnId,
            };
          }
          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
          if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
            return { _tag: "Ignore" as const };
          }
          const interruptedTurnId = turnId ?? activeTurnId;
          if (interruptedTurnId !== undefined) {
            ctx.interruptedTurnIds.add(interruptedTurnId);
          }
          ctx.wakesHeld = true;
          return {
            _tag: "Proceed" as const,
            acpSessionId: ctx.acpSessionId,
            interruptedTurnId,
          };
        });
        if (observed._tag === "Ignore") {
          return;
        }

        yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            if (observed.acpSessionId !== undefined && ctx.acpSessionId !== observed.acpSessionId) {
              return;
            }
            const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
            if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
              return;
            }
            if (
              observed.interruptedTurnId !== undefined &&
              activeTurnId !== undefined &&
              activeTurnId !== observed.interruptedTurnId
            ) {
              return;
            }
            const interruptedTurnId =
              observed.interruptedTurnId ?? turnId ?? activeTurnId ?? ctx.session.activeTurnId;
            yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* Effect.ignore(
              ctx.acp.cancel.pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
                ),
              ),
            );
            if (interruptedTurnId) {
              ctx.interruptedTurnIds.add(interruptedTurnId);
              yield* settlePromptInFlight(threadId, interruptedTurnId, ctx.acpSessionId, {
                completedStopReason: "cancelled",
                settleAllPrompts: true,
              });
            } else if (
              ctx.promptsInFlight > 0 ||
              ctx.session.status === "running" ||
              ctx.session.status === "connecting"
            ) {
              const updatedAt = yield* nowIso;
              ctx.promptsInFlight = 0;
              ctx.activeTurnId = undefined;
              const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
              ctx.session = {
                ...readySession,
                status: "ready",
                updatedAt,
              };
            }
          }),
        );
      });

    const respondToRequest: HermesAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    /**
     * Hermes has no structured user-input surface: it asks through the ACP
     * permission flow instead, so nothing ever opens one of these requests.
     */
    const respondToUserInput: HermesAdapterShape["respondToUserInput"] = (threadId, requestId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/user_input",
          detail: `Hermes sessions do not request structured user input: ${requestId}`,
        });
      });

    const readThread: HermesAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: HermesAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Hermes ACP sessions do not support provider-side rollback yet.",
        });
      });

    const stopSession: HermesAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: HermesAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: HermesAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: HermesAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      compaction: { type: "slash-command", command: "/compress" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies HermesAdapterShape;
  });
}
