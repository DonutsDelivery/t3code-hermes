#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import * as AcpSchema from "effect-acp/schema";

const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;
const exitLogPath = process.env.T3_ACP_EXIT_LOG_PATH;
const antigravityProfile = process.env.T3_ACP_ANTIGRAVITY === "1";
/** Stock or patched Hermes delegate_task wire fixtures; no model or Hermes install needed. */
const decodeHermesFixture = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeTestUpdates = Schema.decodeUnknownEffect(
  Schema.Struct({ updates: Schema.Array(AcpSchema.SessionNotification) }),
);
let pendingHermesDelegation: string | undefined;
/**
 * `T3_ACP_HERMES_BACKGROUND=1`: the first prompt leaves a patched-Hermes background process
 * running. `T3_ACP_HERMES_BACKGROUND_FINISH` says when it exits: `next-prompt` (default, reported
 * silently), `after-turn` or `cancel` (both followed by Hermes's idle `_hermes/notification`).
 */
const hermesBackground = process.env.T3_ACP_HERMES_BACKGROUND === "1";
const hermesBackgroundFinish = process.env.T3_ACP_HERMES_BACKGROUND_FINISH ?? "next-prompt";
const hermesCiProcess = {
  processId: "proc_ci000001",
  command: "gh pr checks 94 --watch\necho done",
};
let runningHermesProcess: { sessionId: string; toolCallId: string } | undefined;
function finishHermesProcess(notify: boolean) {
  const finished = runningHermesProcess;
  if (!finished) return;
  runningHermesProcess = undefined;
  writeJsonRpcNotification("_hermes/process", {
    ...finished,
    ...hermesCiProcess,
    status: "exited",
    exitCode: 1,
    reason: "exited",
  });
  if (notify) {
    const notification = {
      sessionId: finished.sessionId,
      kind: "completion",
      ...(process.env.T3_ACP_HERMES_NOTIFICATION_ID
        ? { notificationIds: [process.env.T3_ACP_HERMES_NOTIFICATION_ID] }
        : {}),
      title: "Background Process Failed (exit 1): gh pr checks 94 --watch echo done",
      text: "[IMPORTANT: Background process proc_ci000001 exited (exit code 1).\nCommand: gh pr checks 94 --watch\nOutput:\nX  Test Server 1]",
    };
    writeJsonRpcNotification("_hermes/notification", notification);
    if (process.env.T3_ACP_HERMES_REPEAT_NOTIFICATION === "1") {
      setTimeout(() => writeJsonRpcNotification("_hermes/notification", notification), 50);
      setTimeout(() => writeJsonRpcNotification("_hermes/notification", notification), 100);
    }
  }
}
const hermesDelegation = process.env.T3_ACP_HERMES_DELEGATION;
const hermesDelegationDelayMs = Math.max(
  0,
  Number(process.env.T3_ACP_HERMES_DELEGATION_DELAY_MS) || 0,
);
const emitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS === "1";
/** `T3_ACP_EMIT_USAGE_UPDATE=used/size` sends an ACP `usage_update` per prompt. */
const usageUpdate = process.env.T3_ACP_EMIT_USAGE_UPDATE;
/**
 * `T3_ACP_EMIT_PROMPT_USAGE=input/output/total[/cachedRead/thought]` attaches
 * end-of-turn totals to the `session/prompt` response.
 */
const promptUsage = process.env.T3_ACP_EMIT_PROMPT_USAGE;
/** Streams this text as an `agent_thought_chunk` before the assistant reply. */
const thoughtText = process.env.T3_ACP_EMIT_THOUGHT_TEXT;
/** Emits a Hermes-shaped compaction `session_info_update` before finishing the prompt. */
const emitCompactionInfo = process.env.T3_ACP_EMIT_COMPACTION_INFO === "1";
const emitInterleavedAssistantToolCalls =
  process.env.T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS === "1";
const emitGenericToolPlaceholders = process.env.T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS === "1";
const emitBackgroundToolDuringAnswer =
  process.env.T3_ACP_EMIT_BACKGROUND_TOOL_DURING_ANSWER === "1";
const emitAskQuestion = process.env.T3_ACP_EMIT_ASK_QUESTION === "1";
const emitXAiAskUserQuestion = process.env.T3_ACP_EMIT_XAI_ASK_USER_QUESTION === "1";
const emitXAiExitPlanMode = process.env.T3_ACP_EMIT_XAI_EXIT_PLAN_MODE === "1";
const emitXAiPlanMdWrite = process.env.T3_ACP_EMIT_XAI_PLAN_MD_WRITE === "1";
const emitXAiPromptCompleteThenHang = process.env.T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG === "1";
const emitXAiRateLimitThenHang = process.env.T3_ACP_EMIT_XAI_RATE_LIMIT_THEN_HANG === "1";
const emitXAiAskUserQuestionThenHang =
  process.env.T3_ACP_EMIT_XAI_ASK_USER_QUESTION_THEN_HANG === "1";
const emitContentThenHang = process.env.T3_ACP_EMIT_CONTENT_THEN_HANG === "1";
const emitPlanThenHang = process.env.T3_ACP_EMIT_PLAN_THEN_HANG === "1";
const emitActiveToolThenHang = process.env.T3_ACP_EMIT_ACTIVE_TOOL_THEN_HANG === "1";
const emitGrokMonitorPostTurnPoll = process.env.T3_ACP_EMIT_GROK_MONITOR_POST_TURN_POLL === "1";
const emitGrokBackgroundTaskStarted = process.env.T3_ACP_EMIT_GROK_BACKGROUND_TASK_STARTED === "1";
const emitForeignSessionUpdates = process.env.T3_ACP_EMIT_FOREIGN_SESSION_UPDATES === "1";
const waitForResumeRelease = process.env.T3_ACP_WAIT_FOR_RESUME_RELEASE === "1";
const completeFirstPromptOnCancel = process.env.T3_ACP_COMPLETE_FIRST_PROMPT_ON_CANCEL === "1";
const completeFirstPromptOnSecond = process.env.T3_ACP_COMPLETE_FIRST_PROMPT_ON_SECOND === "1";
const redirectOverlappingPrompts = process.env.T3_ACP_REDIRECT_OVERLAPPING_PROMPTS === "1";
const floodStderr = process.env.T3_ACP_FLOOD_STDERR === "1";
const hangPromptForever = process.env.T3_ACP_HANG_PROMPT_FOREVER === "1";
const hangFirstPromptForever = process.env.T3_ACP_HANG_FIRST_PROMPT_FOREVER === "1";
const emitLateUpdateAfterCancel = process.env.T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL === "1";
const omitXAiPromptCompleteStopReason =
  process.env.T3_ACP_OMIT_XAI_PROMPT_COMPLETE_STOP_REASON === "1";
const failLoadSession = process.env.T3_ACP_FAIL_LOAD_SESSION === "1";
const emitLoadReplay = process.env.T3_ACP_EMIT_LOAD_REPLAY === "1";
const hangLoadSessionAfterReplay = process.env.T3_ACP_HANG_LOAD_SESSION_AFTER_REPLAY === "1";
const delayLoadSessionAfterReplay = process.env.T3_ACP_DELAY_LOAD_SESSION_AFTER_REPLAY === "1";
const loadSessionDelayMs = Number(process.env.T3_ACP_LOAD_SESSION_DELAY_MS ?? "5000");
const emitStaleXAiPromptCompleteBeforeSecondHang =
  process.env.T3_ACP_EMIT_STALE_XAI_PROMPT_COMPLETE_BEFORE_SECOND_HANG === "1";
const emitOverlappingXAiPromptCompleteOutOfOrder =
  process.env.T3_ACP_EMIT_OVERLAPPING_XAI_PROMPT_COMPLETE_OUT_OF_ORDER === "1";
const failPrompt = process.env.T3_ACP_FAIL_PROMPT === "1";
const failSetConfigOption = process.env.T3_ACP_FAIL_SET_CONFIG_OPTION === "1";
const exitOnSetConfigOption = process.env.T3_ACP_EXIT_ON_SET_CONFIG_OPTION === "1";
const promptResponseText = process.env.T3_ACP_PROMPT_RESPONSE_TEXT;
const initialGrokReasoningEffort =
  process.env.T3_ACP_INITIAL_GROK_REASONING_EFFORT?.trim() || undefined;
const promptDelayMs = Number(process.env.T3_ACP_PROMPT_DELAY_MS ?? "0");
const permissionOptionIds = {
  allowOnce: process.env.T3_ACP_ALLOW_ONCE_OPTION_ID ?? "allow-once",
  allowAlways: process.env.T3_ACP_ALLOW_ALWAYS_OPTION_ID ?? "allow-always",
  rejectOnce: process.env.T3_ACP_REJECT_ONCE_OPTION_ID ?? "reject-once",
};
const omitAllowAlways = process.env.T3_ACP_OMIT_ALLOW_ALWAYS === "1";
const permissionRequestCount = Math.max(
  1,
  Number(process.env.T3_ACP_PERMISSION_REQUEST_COUNT ?? "1") || 1,
);
const sessionId = "mock-session-1";

let currentModeId = antigravityProfile ? "default" : "ask";
let currentModelId = antigravityProfile ? "gemini-test-low" : "default";
let parameterizedModelPicker = false;
let currentReasoning = "medium";
let currentContext = "272k";
let currentFast = false;
let promptCount = 0;
let overlappingFirstPromptId: string | undefined;
let redirectableTurnActive = false;
const cancelledSessions = new Set<string>();

function promptIdFromRequestMeta(
  request: Pick<AcpSchema.PromptRequest, "_meta">,
): string | undefined {
  const meta = request._meta;
  if (meta === null || typeof meta !== "object") {
    return undefined;
  }
  const promptId = meta.promptId ?? meta.requestId;
  return typeof promptId === "string" && promptId.length > 0 ? promptId : undefined;
}

function logExit(reason: string): void {
  if (!exitLogPath) {
    return;
  }
  NodeFS.appendFileSync(exitLogPath, `${reason}\n`, "utf8");
}

function writeJsonRpcNotification(method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

process.once("SIGTERM", () => {
  logExit("SIGTERM");
  process.exit(0);
});

process.once("SIGINT", () => {
  logExit("SIGINT");
  process.exit(0);
});

process.once("exit", (code) => {
  logExit(`exit:${code}`);
});

function configOptions(): ReadonlyArray<AcpSchema.SessionConfigOption> {
  if (antigravityProfile) {
    return [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: currentModelId,
        options: antigravityModels.map((model) => ({ value: model.modelId, name: model.name })),
      },
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: currentModeId,
        options: availableModes.map((mode) => ({ value: mode.id, name: mode.name })),
      },
    ];
  }
  if (parameterizedModelPicker) {
    const baseOptions: Array<AcpSchema.SessionConfigOption> = [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: currentModeId,
        options: availableModes.map((mode) => ({
          value: mode.id,
          name: mode.name,
          ...(mode.description ? { description: mode.description } : {}),
        })),
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: currentModelId,
        options: [
          { value: "default", name: "Auto" },
          { value: "composer-2", name: "Composer 2" },
          { value: "gpt-5.4", name: "GPT-5.4" },
          { value: "claude-opus-4-6", name: "Opus 4.6" },
        ],
      },
    ];

    switch (currentModelId) {
      case "gpt-5.4":
        return [
          ...baseOptions,
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: [
              { value: "none", name: "None" },
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
              { value: "extra-high", name: "Extra High" },
            ],
          },
          {
            id: "context",
            name: "Context",
            category: "model_config",
            type: "select",
            currentValue: currentContext,
            options: [
              { value: "272k", name: "272K" },
              { value: "1m", name: "1M" },
            ],
          },
          {
            id: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ];
      case "composer-2":
        return [
          ...baseOptions,
          {
            id: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ];
      case "claude-opus-4-6":
        return [
          ...baseOptions,
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
          {
            id: "thinking",
            name: "Thinking",
            category: "model_config",
            type: "boolean",
            currentValue: true,
          },
        ];
      default:
        return baseOptions;
    }
  }

  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: currentModelId,
      options: [
        { value: "default", name: "Auto" },
        { value: "composer-2", name: "Composer 2" },
        { value: "composer-2[fast=true]", name: "Composer 2 Fast" },
        { value: "gpt-5.3-codex[reasoning=medium,fast=false]", name: "Codex 5.3" },
      ],
    },
  ];
}

function modelConfigOptionsFor(modelId: string): ReadonlyArray<AcpSchema.SessionConfigOption> {
  const previousModelId = currentModelId;
  try {
    currentModelId = modelId;
    return configOptions().filter(
      (option) => option.category !== "mode" && option.category !== "model",
    );
  } finally {
    currentModelId = previousModelId;
  }
}

function availableModels(): ReadonlyArray<{
  readonly value: string;
  readonly name: string;
  readonly configOptions: ReadonlyArray<AcpSchema.SessionConfigOption>;
}> {
  return [
    { value: "default", name: "Auto" },
    { value: "composer-2", name: "Composer 2" },
    { value: "gpt-5.4", name: "GPT-5.4" },
    { value: "claude-opus-4-6", name: "Opus 4.6" },
  ].map((model) => ({
    value: model.value,
    name: model.name,
    configOptions: modelConfigOptionsFor(model.value),
  }));
}

const antigravityModels = [
  { modelId: "gemini-test-low", name: "Gemini Test Low" },
  { modelId: "gemini-test-high", name: "Gemini Test High" },
] satisfies ReadonlyArray<AcpSchema.ModelInfo>;

const availableModes: ReadonlyArray<AcpSchema.SessionMode> = antigravityProfile
  ? [
      { id: "default", name: "Default" },
      { id: "auto_edit", name: "Auto edit" },
      { id: "yolo", name: "YOLO" },
    ]
  : [
      {
        id: "ask",
        name: "Ask",
        description: "Request permission before making any changes",
      },
      {
        id: "architect",
        name: "Architect",
        description: "Design and plan software systems without implementation",
      },
      {
        id: "code",
        name: "Code",
        description: "Write and modify code with full tool access",
      },
    ];

function modeState(): AcpSchema.SessionModeState {
  return {
    currentModeId,
    availableModes,
  };
}

// Mirrors the real Grok ACP: it advertises versioned model ids, never the CLI's own
// "grok-build" product name, and it rejects unknown ids in session/set_model.
const grokAcpModels: ReadonlyArray<AcpSchema.ModelInfo> = [
  {
    modelId: "grok-4.6",
    name: "Grok 4.6",
    _meta: {
      totalContextTokens: 500_000,
      supportsReasoningEffort: true,
      reasoningEffort: initialGrokReasoningEffort ?? "high",
      reasoningEfforts: [
        { id: "xhigh", value: "xhigh", label: "Extra High Effort", default: false },
        { id: "high", value: "high", label: "High Effort", default: true },
        { id: "low", value: "low", label: "Low Effort", default: false },
      ],
    },
  },
  { modelId: "grok-mock-alt", name: "Grok Mock Alt" },
];

/** `T3_ACP_MODEL_IDS=id:Name,id:Name` overrides the advertised model picker. */
function parseModelOverrides(raw: string | undefined): ReadonlyArray<AcpSchema.ModelInfo> {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [modelId, name] = entry.split(":");
      return { modelId: modelId ?? entry, name: name ?? modelId ?? entry };
    });
  if (entries.length === 0) return grokAcpModels;
  return entries.map((model) =>
    model.modelId === "grok-build" && initialGrokReasoningEffort
      ? { ...model, _meta: { reasoningEffort: initialGrokReasoningEffort } }
      : model,
  );
}

const acpModels = parseModelOverrides(process.env.T3_ACP_MODEL_IDS);

function modelState(): AcpSchema.SessionModelState {
  if (antigravityProfile) {
    return { currentModelId, availableModels: antigravityModels };
  }
  const modelId = acpModels.some((model) => model.modelId === currentModelId)
    ? currentModelId
    : (acpModels[0]?.modelId ?? "grok-4.6");
  return {
    currentModelId: modelId,
    availableModels: acpModels,
  };
}

const program = Effect.gen(function* () {
  const agent = yield* EffectAcpAgent.AcpAgent;
  const resumeRelease = yield* Deferred.make<void>();
  const nativeCancelRequested = yield* Deferred.make<void>();
  const nativeCancelRelease = yield* Deferred.make<void>();
  const firstPromptRelease = yield* Deferred.make<void>();
  const steerRelease = yield* Deferred.make<void>();
  const publishAntigravityCommands = (targetSessionId: string) =>
    agent.client.sessionUpdate({
      sessionId: targetSessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "plan", description: "Plan a task", input: { hint: "task" } },
          { name: "logout", description: "Sign out" },
        ],
      },
    });

  yield* agent.handleInitialize((request) =>
    Effect.gen(function* () {
      if (floodStderr) {
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              process.stderr.write("stderr".repeat(350_000), () => resolve());
            }),
        );
      }
      parameterizedModelPicker =
        request.clientCapabilities?._meta?.parameterizedModelPicker === true;
      if (antigravityProfile) {
        return {
          protocolVersion: 1,
          agentInfo: { name: "antigravity-acp", version: "mock" },
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { resume: {} },
            auth: { logout: {} },
            promptCapabilities: { image: true, embeddedContext: true },
          },
          authMethods: [{ id: "oauth-personal", name: "Sign in with Google" }],
        };
      }
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
        // Grok advertises model state before any session exists; the provider
        // health check reads it from here without authenticating.
        _meta: { modelState: modelState() },
      };
    }),
  );

  // Mirrors the real agent: the API key method reads GEMINI_API_KEY from the
  // process environment and rejects when it is missing.
  yield* agent.handleAuthenticate((request) =>
    !antigravityProfile || request.methodId === "oauth-personal"
      ? Effect.succeed({})
      : request.methodId === "gemini-api-key" && process.env.GEMINI_API_KEY
        ? Effect.succeed({})
        : Effect.fail(
            AcpError.AcpRequestError.invalidParams(
              `Mock Antigravity rejected auth method ${request.methodId}.`,
            ),
          ),
  );
  if (antigravityProfile) {
    yield* agent.handleLogout(() => Effect.succeed({}));
  }

  yield* agent.handleCreateSession(() =>
    Effect.gen(function* () {
      if (antigravityProfile) {
        yield* publishAntigravityCommands(sessionId);
      }
      return {
        sessionId,
        modes: modeState(),
        models: modelState(),
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleResumeSession((request) =>
    Effect.gen(function* () {
      yield* agent.client.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "native-resume-started" },
        },
      });
      if (waitForResumeRelease) {
        yield* Deferred.await(resumeRelease);
      }
      if (antigravityProfile) {
        yield* publishAntigravityCommands(request.sessionId);
      }
      return {
        modes: modeState(),
        models: modelState(),
        configOptions: configOptions(),
        _meta: { nativeResume: true },
      };
    }),
  );

  const emitLoadReplayNotifications = (requestedSessionId: string) => {
    writeJsonRpcNotification("session/update", {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "replay-tool-1",
        title: "Replay tool",
        kind: "search",
        status: "completed",
      },
    });
    writeJsonRpcNotification("session/update", {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "replayed assistant text" },
      },
    });
  };

  yield* agent.handleLoadSession((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      if (failLoadSession) {
        return yield* AcpError.AcpRequestError.internalError("Mock load session failure");
      }
      if (hangLoadSessionAfterReplay || delayLoadSessionAfterReplay) {
        emitLoadReplayNotifications(requestedSessionId);
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "replay-tail" },
          },
        });
        yield* Effect.sleep(loadSessionDelayMs);
        return {
          modes: modeState(),
          models: modelState(),
          configOptions: configOptions(),
        };
      }
      if (emitLoadReplay) {
        emitLoadReplayNotifications(requestedSessionId);
      }
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "replay" },
        },
      });
      return {
        modes: modeState(),
        models: modelState(),
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleSetSessionModel((request) =>
    Effect.gen(function* () {
      if (!modelState().availableModels.some((model) => model.modelId === request.modelId)) {
        return yield* AcpError.AcpRequestError.invalidParams(
          `Unknown mock model id: ${request.modelId}`,
          {
            method: "session/set_model",
            params: request,
          },
        );
      }
      currentModelId = request.modelId;
      return {};
    }),
  );

  yield* agent.handleSetSessionConfigOption((request) =>
    Effect.gen(function* () {
      if (exitOnSetConfigOption) {
        return yield* Effect.sync(() => {
          process.exit(7);
        });
      }
      if (failSetConfigOption) {
        return yield* AcpError.AcpRequestError.invalidParams(
          "Mock invalid params for session/set_config_option",
          {
            method: "session/set_config_option",
            params: request,
          },
        );
      }
      if (request.configId === "mode" && typeof request.value === "string") {
        currentModeId = request.value;
      }
      if (request.configId === "model" && typeof request.value === "string") {
        currentModelId = request.value;
      }
      if (request.configId === "reasoning" && typeof request.value === "string") {
        currentReasoning = request.value;
      }
      if (request.configId === "context" && typeof request.value === "string") {
        currentContext = request.value;
      }
      if (request.configId === "fast") {
        currentFast = request.value === true || request.value === "true";
      }
      return {
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleCancel(({ sessionId }) =>
    Effect.gen(function* () {
      const cancelledSessionId = String(sessionId ?? "mock-session-1");
      cancelledSessions.add(cancelledSessionId);
      if (hermesBackgroundFinish === "cancel" && runningHermesProcess) {
        const started = runningHermesProcess;
        yield* Effect.sync(() => {
          finishHermesProcess(true);
          // A later report: once it surfaces, the client has handled the notice before it.
          writeJsonRpcNotification("_hermes/process", {
            ...started,
            processId: "proc_next0002",
            command: "tail -f server.log",
            status: "running",
          });
        });
      }
      if (process.env.T3_ACP_HERMES_DELEGATION_EXIT_ON_CANCEL === "1") {
        return yield* Effect.sync(() => process.exit(19));
      }
      if (completeFirstPromptOnCancel) {
        yield* Deferred.succeed(nativeCancelRequested, undefined);
        yield* agent.client.sessionUpdate({
          sessionId: cancelledSessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "native-cancel-received" },
          },
        });
      }
      if (emitLateUpdateAfterCancel) {
        yield* Effect.sleep("50 millis");
        yield* Effect.sync(() => {
          writeJsonRpcNotification("session/update", {
            sessionId: cancelledSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "late after cancel" },
            },
          });
        });
      }
    }),
  );

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      promptCount += 1;
      if (
        process.env.T3_ACP_CRASH_PROMPT === "1" &&
        request.prompt.some((part) => part.type === "text" && part.text === "crash now")
      ) {
        return yield* Effect.sync(() => process.exit(23));
      }

      if (hermesBackground) {
        const promptText = request.prompt
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        if (promptText.startsWith("[IMPORTANT:") || runningHermesProcess) {
          // The watcher has finished by the next prompt, whatever it is.
          finishHermesProcess(false);
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: promptText.startsWith("[IMPORTANT:")
                  ? "CI failed on Test Server 1; looking into it."
                  : "Noted.",
              },
            },
          });
          return { stopReason: "end_turn" };
        }
        const toolCallId = `hermes-terminal-${promptCount}`;
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "terminal: gh pr checks 94 --watch",
            kind: "execute",
            status: "in_progress",
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            content: [
              {
                type: "content",
                content: { type: "text", text: "Background process started" },
              },
            ],
          },
        });
        runningHermesProcess = { sessionId: requestedSessionId, toolCallId };
        writeJsonRpcNotification("_hermes/process", {
          ...runningHermesProcess,
          ...hermesCiProcess,
          status: "running",
        });
        if (hermesBackgroundFinish === "after-turn") {
          // Exits just after this prompt returns, while the session is idle.
          yield* Effect.forkDetach(
            Effect.sleep("20 millis").pipe(
              Effect.andThen(Effect.sync(() => finishHermesProcess(true))),
            ),
          );
        }
        return { stopReason: "end_turn" };
      }

      if (hermesDelegation === "stock" || hermesDelegation === "progress") {
        const fixture = decodeHermesFixture(
          NodeFS.readFileSync(
            new URL("../src/provider/acp/fixtures/hermes-delegation.json", import.meta.url),
            "utf8",
          ),
        ) as {
          cases: Array<{
            name: string;
            args: unknown;
            result: unknown;
            start: Extract<AcpSchema.SessionNotification["update"], { sessionUpdate: "tool_call" }>;
            complete: Extract<
              AcpSchema.SessionNotification["update"],
              { sessionUpdate: "tool_call_update" }
            >;
          }>;
        };
        const scenario = fixture.cases.find(
          (item) => item.name === (process.env.T3_ACP_HERMES_DELEGATION_CASE ?? "batch"),
        )!;
        const toolCallId = `hermes-delegate-${promptCount}`;
        const send = (update: AcpSchema.SessionNotification["update"]) =>
          agent.client.sessionUpdate({ sessionId: requestedSessionId, update });
        // The next prompt delivers the old background result while a new turn is active.
        if (pendingHermesDelegation && hermesDelegation === "progress") {
          yield* send({
            sessionUpdate: "tool_call_update",
            toolCallId: pendingHermesDelegation,
            status: "in_progress",
            rawOutput: {
              hermesDelegation: {
                event: "subagent.complete",
                task_index: 0,
                status: "completed",
                summary: "Background review completed.",
                duration_seconds: 3,
              },
            },
          });
          pendingHermesDelegation = undefined;
        }
        yield* send({
          ...scenario.start,
          toolCallId,
          ...(hermesDelegation === "progress" ? { rawInput: scenario.args } : {}),
        });
        if (hermesDelegationDelayMs > 0) yield* Effect.sleep(hermesDelegationDelayMs);
        if (hermesDelegation === "progress") {
          const args = scenario.args as {
            goal?: string;
            model?: string;
            tasks?: Array<{ goal: string; model?: string }>;
          };
          const tasks = args.tasks ?? [{ goal: args.goal ?? "Delegated task", model: args.model }];
          for (let index = 0; index < tasks.length; index += 1) {
            yield* send({
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: "in_progress",
              rawOutput: {
                hermesDelegation: {
                  event: "subagent.start",
                  task_index: index,
                  goal: tasks[index]?.goal,
                  model: tasks[index]?.model,
                },
              },
            });
          }
          for (const text of [
            "Inspecting the delegation boundary.",
            "Routing inspected; checking parallel child isolation.",
          ]) {
            yield* send({
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: "in_progress",
              rawOutput: { hermesDelegation: { event: "subagent.text", task_index: 0, text } },
            });
            if (hermesDelegationDelayMs > 0) yield* Effect.sleep(hermesDelegationDelayMs);
          }
        }
        if (process.env.T3_ACP_HERMES_DELEGATION_HANG === "1") return yield* Effect.never;
        yield* send({
          ...scenario.complete,
          toolCallId,
          ...(hermesDelegation === "progress" ? { rawOutput: scenario.result } : {}),
        });
        if (scenario.name === "dispatched") {
          pendingHermesDelegation = toolCallId;
          if (
            promptCount === 1 &&
            process.env.T3_ACP_HERMES_DELEGATION_HANG_AFTER_DISPATCH === "1"
          ) {
            return yield* Effect.never;
          }
        }
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text:
              scenario.name === "dispatched"
                ? "Delegated background work; the next prompt delivers its result."
                : scenario.name === "batch"
                  ? "Delegation finished. Routing was inspected; the test child reported a process failure."
                  : scenario.name === "failure"
                    ? "Delegation unavailable."
                    : "Parser reviewed.",
          },
        });
        return { stopReason: "end_turn" };
      }

      if (completeFirstPromptOnSecond && promptCount === 1) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "await-live-steer",
            title: "Waiting for steering message",
            kind: "execute",
            status: "in_progress",
          },
        });
        yield* Deferred.await(firstPromptRelease);
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "await-live-steer",
            status: "completed",
          },
        });
        return { stopReason: "end_turn" };
      }
      // The first turn ends before the agent handles the overlapping prompt, which
      // then streams its own answer once the client calls `_test/release-steer`.
      if (completeFirstPromptOnSecond && promptCount === 2) {
        yield* Deferred.succeed(firstPromptRelease, undefined);
        yield* Deferred.await(steerRelease);
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Answered the steer." },
          },
        });
        return { stopReason: "end_turn" };
      }

      // Mirrors Hermes ACP: a prompt overlapping a running turn returns at once.
      // Text-only prompts redirect the turn; anything else is queued as text.
      if (redirectOverlappingPrompts) {
        const sendText = (text: string) =>
          agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          });
        if (redirectableTurnActive) {
          const textOnly = request.prompt.every((block) => block.type === "text");
          yield* sendText(
            textOnly
              ? "Redirected the active turn with your correction."
              : "Queued for the next turn. (1 queued)",
          );
          return { stopReason: "end_turn" };
        }
        if (promptCount > 1) {
          yield* sendText("Handled follow-up.");
          return { stopReason: "end_turn" };
        }
        redirectableTurnActive = true;
        yield* sendText("Working on the original task.");
        // The approval holds the turn open until the client answers it.
        yield* agent.client.requestPermission({
          sessionId: requestedSessionId,
          toolCall: {
            toolCallId: "redirectable-tool",
            title: "`sleep 60`",
            kind: "execute",
            status: "pending",
            rawInput: { command: "sleep 60" },
          },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });
        yield* sendText("Finished the redirected task.");
        redirectableTurnActive = false;
        return { stopReason: "end_turn" };
      }

      if (completeFirstPromptOnCancel && promptCount === 1) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "native-cancel-tool",
            title: "Long command",
            kind: "execute",
            status: "in_progress",
          },
        });
        yield* Deferred.await(nativeCancelRequested);
        yield* Deferred.await(nativeCancelRelease);
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "native-cancel-tool",
            status: "failed",
            content: [{ type: "content", content: { type: "text", text: "Cancelled." } }],
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Request cancelled." },
          },
        });
        return { stopReason: "cancelled", _meta: { nativeCancel: true } };
      }

      if (Number.isFinite(promptDelayMs) && promptDelayMs > 0) {
        yield* Effect.sleep(`${promptDelayMs} millis`);
      }

      if (failPrompt) {
        return yield* AcpError.AcpRequestError.internalError("Mock prompt failure");
      }

      if (emitStaleXAiPromptCompleteBeforeSecondHang && promptCount === 1) {
        return {
          stopReason: "end_turn",
          _meta: {
            promptId: "mock-stale-xai-prompt-1",
            requestId: "mock-stale-xai-prompt-1",
          },
        };
      }

      if (emitStaleXAiPromptCompleteBeforeSecondHang && promptCount === 2) {
        const currentPromptId = promptIdFromRequestMeta(request) ?? "mock-current-xai-prompt-2";
        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: "mock-stale-xai-prompt-1",
          stopReason: "end_turn",
          agentResult: null,
        });

        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: currentPromptId,
          stopReason: "end_turn",
          agentResult: null,
        });

        return yield* Effect.never;
      }

      if (emitOverlappingXAiPromptCompleteOutOfOrder && promptCount === 1) {
        overlappingFirstPromptId = promptIdFromRequestMeta(request);
        return yield* Effect.never;
      }

      if (emitOverlappingXAiPromptCompleteOutOfOrder && promptCount === 2) {
        const secondPromptId = promptIdFromRequestMeta(request);
        if (overlappingFirstPromptId !== undefined && secondPromptId !== undefined) {
          writeJsonRpcNotification("_x.ai/session/prompt_complete", {
            sessionId: requestedSessionId,
            promptId: secondPromptId,
            stopReason: "end_turn",
            agentResult: null,
          });
          writeJsonRpcNotification("_x.ai/session/prompt_complete", {
            sessionId: requestedSessionId,
            promptId: overlappingFirstPromptId,
            stopReason: "end_turn",
            agentResult: null,
          });
        }
        return yield* Effect.never;
      }

      if (hangPromptForever || (hangFirstPromptForever && promptCount === 1)) {
        return yield* Effect.never;
      }

      if (emitXAiRateLimitThenHang) {
        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? "mock-xai-rate-limit-prompt-1",
          stopReason: "rate_limit",
          agentResult: null,
        });
        return yield* Effect.never;
      }

      if (emitContentThenHang) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "partial before stall" },
          },
        });
        return yield* Effect.never;
      }

      if (emitPlanThenHang) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "plan",
            entries: [
              {
                content: "Wait for more ACP progress",
                priority: "high",
                status: "in_progress",
              },
            ],
          },
        });
        return yield* Effect.never;
      }

      if (emitActiveToolThenHang) {
        const toolCallId = "tool-call-long-running-1";
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Long-running tool",
            kind: "execute",
            status: "pending",
            rawInput: { command: ["long-running-tool"] },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });
        return yield* Effect.never;
      }

      if (emitXAiPromptCompleteThenHang) {
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from" },
          },
        });

        if (emitForeignSessionUpdates) {
          writeJsonRpcNotification("session/update", {
            sessionId: "mock-child-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "child before completion" },
            },
          });
        }

        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? "mock-xai-prompt-1",
          ...(omitXAiPromptCompleteStopReason ? {} : { stopReason: "end_turn" }),
          agentResult: null,
        });

        if (emitForeignSessionUpdates) {
          writeJsonRpcNotification("session/update", {
            sessionId: "mock-child-session-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "child-tool-call-1",
              title: "Child-only tool",
              kind: "other",
              status: "pending",
              rawInput: {},
            },
          });
          writeJsonRpcNotification("session/update", {
            sessionId: "mock-child-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "child after completion" },
            },
          });
        }

        for (const text of [" ", "mo", "ck"]) {
          writeJsonRpcNotification("session/update", {
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          });
        }

        return yield* Effect.never;
      }

      if (emitGrokMonitorPostTurnPoll) {
        const monitorCallId = "call-monitor-1";
        const pollCallId = "call-monitor-poll-1";
        const taskId = "01a05f41-5107-7550-821e-79e8d1cd7687";
        const description = "Watch count-sheet Typst unit until done";
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: monitorCallId,
            title: "monitor",
            kind: "other",
            status: "pending",
            rawInput: { description },
            _meta: {
              "x.ai/tool": { version: 1, name: "monitor", kind: "task", namespace: "grok_build" },
            },
          },
        });
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: monitorCallId,
            status: "completed",
            rawInput: { description },
            rawOutput: {
              type: "Monitor",
              taskId,
              timeoutMs: 36_000_000,
            },
          },
        });
        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? "mock-xai-prompt-1",
          stopReason: "end_turn",
          agentResult: null,
        });
        yield* Effect.sleep("120 millis");
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: pollCallId,
            title: "get_command_or_subagent_output",
            kind: "other",
            status: "completed",
            rawInput: { variant: "TaskOutput", task_ids: [taskId], timeout_ms: 0 },
            rawOutput: {
              type: "TaskOutput",
              Result: {
                task_id: taskId,
                command: `[monitor] ${description}`,
                status: "completed",
                exit_code: 0,
                output: "Monitor finished.",
              },
            },
          },
        });
        return yield* Effect.never;
      }

      if (emitGrokBackgroundTaskStarted) {
        const toolCallId = "call-fb9d0000-0000-0000-0000-000000000026";
        const command = "sleep 40; echo done-a";
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "run_terminal_command",
            kind: "execute",
            status: "in_progress",
            rawInput: { command },
          },
        });
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              type: "BackgroundTaskStarted",
              task_id: toolCallId,
              task_type: "bash",
              status: "running",
              command,
            },
          },
        });
        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? "mock-xai-prompt-1",
          stopReason: "end_turn",
          agentResult: null,
        });
        return yield* Effect.never;
      }

      if (emitBackgroundToolDuringAnswer) {
        // A command backgrounded earlier reports progress and then finishes
        // while the next answer is still streaming.
        const toolCallId = "background-1";
        const say = (text: string) =>
          agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          });
        const progress = (status: "in_progress" | "completed", stdout: string) =>
          agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status,
              rawOutput: { stdout },
            },
          });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "in_progress",
            rawInput: { command: "sleep 3 && echo done" },
          },
        });
        yield* say("| a | b |\n|---|---|\n| 1 ");
        yield* progress("in_progress", ".");
        yield* say("| x |\n");
        yield* progress("completed", "done");
        yield* say("| 2 | y |\n");
        // Agents can repeat a terminal update after the call finished.
        yield* progress("completed", "done");
        yield* say("| 3 | z |");
        return { stopReason: "end_turn" };
      }

      if (emitInterleavedAssistantToolCalls) {
        const toolCallId = "tool-call-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "before tool" },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["echo", "hello"],
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              exitCode: 0,
              stdout: "hello",
              stderr: "",
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "after tool" },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (emitToolCalls) {
        const toolCallId = "tool-call-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["cat", "server/package.json"],
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });

        const permissionOptions: Array<AcpSchema.PermissionOption> = [
          { optionId: permissionOptionIds.allowOnce, name: "Allow once", kind: "allow_once" },
          ...(omitAllowAlways
            ? []
            : [
                {
                  optionId: permissionOptionIds.allowAlways,
                  name: "Allow always",
                  kind: "allow_always" as const,
                },
              ]),
          { optionId: permissionOptionIds.rejectOnce, name: "Reject", kind: "reject_once" },
        ];

        let cancelled = cancelledSessions.delete(requestedSessionId);
        for (let index = 0; index < permissionRequestCount; index++) {
          const command =
            index > 0
              ? (process.env.T3_ACP_SECOND_PERMISSION_COMMAND ?? "cat server/package.json")
              : "cat server/package.json";
          const permission = yield* agent.client.requestPermission({
            sessionId: requestedSessionId,
            toolCall: {
              toolCallId: index === 0 ? toolCallId : `${toolCallId}-${index + 1}`,
              title: process.env.T3_ACP_PERMISSION_TITLE ?? `\`${command}\``,
              kind: "execute",
              status: "pending",
              rawInput: {
                variant: "Bash",
                command,
                description: index === 0 ? "Read package metadata" : "Read it again",
              },
              content: [
                {
                  type: "content",
                  content: {
                    type: "text",
                    text: `Not in allowlist: ${command}`,
                  },
                },
              ],
            },
            options: permissionOptions,
          });
          cancelled =
            cancelled ||
            cancelledSessions.delete(requestedSessionId) ||
            permission.outcome.outcome === "cancelled";
          if (cancelled) {
            break;
          }
        }

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "completed",
            rawOutput: {
              exitCode: 0,
              stdout: '{ "name": "t3" }',
              stderr: "",
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from mock" },
          },
        });

        return { stopReason: cancelled ? "cancelled" : "end_turn" };
      }

      if (emitGenericToolPlaceholders) {
        const toolCallId = "tool-call-generic-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Read File",
            kind: "read",
            status: "pending",
            rawInput: {},
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              content: "package.json\n",
            },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (emitAskQuestion) {
        yield* agent.client.extRequest("cursor/ask_question", {
          toolCallId: "ask-question-tool-call-1",
          title: "Question",
          questions: [
            {
              id: "scope",
              prompt: "Which scope?",
              options: [
                { id: "workspace", label: "Workspace" },
                { id: "session", label: "Session" },
              ],
            },
          ],
        });

        return { stopReason: "end_turn" };
      }

      if (emitXAiAskUserQuestion || emitXAiAskUserQuestionThenHang) {
        const result = yield* agent.client.extRequest("_x.ai/ask_user_question", {
          method: "x.ai/ask_user_question",
          params: {
            sessionId: requestedSessionId,
            toolCallId: "ask-user-question-tool-call-1",
            questions: [
              {
                question: "Which scope should Grok use?",
                multiSelect: null,
                options: [
                  { label: "Workspace", description: "Use the current workspace" },
                  { label: "Session", description: "Only use this session" },
                ],
              },
            ],
            mode: "default",
          },
        });
        if (typeof result !== "object" || result === null || !("outcome" in result)) {
          throw new Error("Expected _x.ai/ask_user_question response outcome.");
        }
        if (result.outcome === "cancelled") {
          return { stopReason: "end_turn" };
        }
        if (
          result.outcome !== "accepted" ||
          !("answers" in result) ||
          typeof result.answers !== "object" ||
          result.answers === null
        ) {
          throw new Error("Expected accepted _x.ai/ask_user_question response answers.");
        }

        if (emitXAiAskUserQuestionThenHang) {
          return yield* Effect.never;
        }

        return { stopReason: "end_turn" };
      }

      if (emitXAiPlanMdWrite) {
        // Match Grok's real session layout so isGrokPlanMarkdownPath accepts it.
        const planRoot = process.env.T3_ACP_PLAN_ROOT ?? "/tmp/mock-home/.grok";
        const planPath = `${planRoot}/sessions/${requestedSessionId}/plan.md`;
        const planBody = "# Mock plan\n\n- Write the feature\n- Add a test\n- Ship it\n";
        // enter_plan_mode first so the adapter arms planModeActive.
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "enter-plan-mode-1",
            title: "enter_plan_mode",
            kind: "other",
            status: "completed",
            rawInput: { variant: "EnterPlanMode" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "plan-md-write-1",
            title: "write",
            kind: "edit",
            status: "pending",
            rawInput: { file_path: planPath, content: planBody },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "plan-md-write-1",
            kind: "edit",
            status: "completed",
            title: `Write \`${planPath}\``,
            rawInput: { file_path: planPath, content: planBody },
            content: [
              {
                type: "diff",
                path: planPath,
                oldText: "",
                newText: planBody,
              },
            ],
          },
        });
        return { stopReason: "end_turn" };
      }

      if (emitXAiExitPlanMode) {
        const result = yield* agent.client.extRequest("_x.ai/exit_plan_mode", {
          method: "x.ai/exit_plan_mode",
          params: {
            sessionId: requestedSessionId,
            toolCallId: "exit-plan-mode-tool-call-1",
            planContent: "# Exit plan\n\n- Step one\n- Step two\n",
          },
        });
        if (typeof result !== "object" || result === null || !("outcome" in result)) {
          throw new Error("Expected _x.ai/exit_plan_mode response outcome.");
        }
        if (
          result.outcome !== "abandoned" &&
          result.outcome !== "approved" &&
          result.outcome !== "request_changes"
        ) {
          throw new Error(
            `Expected exit_plan_mode outcome abandoned|approved|request_changes, got ${String(result.outcome)}`,
          );
        }
        return { stopReason: "end_turn" };
      }

      if (emitForeignSessionUpdates) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "root before child" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: "mock-child-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "child content" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: "mock-child-session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "child-tool-call-1",
            title: "Child-only tool",
            kind: "other",
            status: "pending",
            rawInput: {},
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: " root after child" },
          },
        });
        return { stopReason: "end_turn" };
      }

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "plan",
          entries: [
            {
              content: "Inspect mock ACP state",
              priority: "high",
              status: "completed",
            },
            {
              content: "Implement the requested change",
              priority: "high",
              status: "in_progress",
            },
          ],
        },
      });

      if (thoughtText) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: thoughtText },
          },
        });
      }

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: promptResponseText ?? "hello from mock" },
        },
      });

      if (emitCompactionInfo) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "session_info_update",
            title: "Compacted thread",
            _meta: {
              hermes: {
                sessionProvenance: { compressionDepth: 1, reason: "compression" },
              },
            },
          },
        });
      }

      if (usageUpdate) {
        const [used, size] = usageUpdate.split("/").map((part) => Number(part));
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: { sessionUpdate: "usage_update", used: used ?? 0, size: size ?? 0 },
        });
      }

      if (promptUsage) {
        const [input, output, total, cachedRead, thought] = promptUsage
          .split("/")
          .map((part) => Number(part));
        return {
          stopReason: "end_turn" as const,
          usage: {
            inputTokens: input ?? 0,
            outputTokens: output ?? 0,
            totalTokens: total ?? 0,
            ...(cachedRead !== undefined && Number.isFinite(cachedRead)
              ? { cachedReadTokens: cachedRead }
              : {}),
            ...(thought !== undefined && Number.isFinite(thought)
              ? { thoughtTokens: thought }
              : {}),
          },
        };
      }

      return { stopReason: "end_turn" };
    }),
  );

  yield* agent.handleUnknownExtRequest((method, params) => {
    if (method === "_test/session-updates") {
      return decodeTestUpdates(params).pipe(
        Effect.orDie,
        Effect.flatMap(({ updates }) =>
          Effect.forEach(updates, (update) => agent.client.sessionUpdate(update), {
            discard: true,
          }),
        ),
        Effect.as({}),
      );
    }
    if (method === "_test/environment") {
      return Effect.succeed({
        inherited: process.env.T3_ACP_RUNTIME_AMBIENT === "sentinel",
        explicit: process.env.T3_ACP_RUNTIME_EXPLICIT === "kept",
      });
    }
    if (method === "_test/release-resume") {
      return Deferred.succeed(resumeRelease, undefined).pipe(Effect.as({}));
    }
    if (method === "_test/release-steer") {
      return Deferred.succeed(steerRelease, undefined).pipe(Effect.as({}));
    }
    if (method === "_test/finish-cancel") {
      return Deferred.succeed(nativeCancelRelease, undefined).pipe(Effect.as({}));
    }
    if (method === "_test/startup-metadata") {
      return Effect.gen(function* () {
        for (const [metadataSessionId, commandName, modeId] of [
          [sessionId, "plan", "code"],
          ["child-session", "foreign-command", "ask"],
        ] as const) {
          yield* agent.client.sessionUpdate({
            sessionId: metadataSessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [{ name: commandName, description: "Native command" }],
            },
          });
          yield* agent.client.sessionUpdate({
            sessionId: metadataSessionId,
            update: { sessionUpdate: "current_mode_update", currentModeId: modeId },
          });
          yield* agent.client.sessionUpdate({
            sessionId: metadataSessionId,
            update: {
              sessionUpdate: "config_option_update",
              configOptions: configOptions().map((option) =>
                option.type === "select" && option.category === "model"
                  ? {
                      ...option,
                      currentValue: metadataSessionId === sessionId ? "gpt-5.4" : "default",
                    }
                  : option,
              ),
            },
          });
          yield* agent.client.sessionUpdate({
            sessionId: metadataSessionId,
            update: {
              sessionUpdate: "usage_update",
              used: metadataSessionId === sessionId ? 48_120 : 100,
              size: 200_000,
            },
          });
          yield* agent.client.sessionUpdate({
            sessionId: metadataSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Startup transcript must not replay." },
            },
          });
        }
        return {};
      });
    }
    if (method === "cursor/list_available_models") {
      return Effect.succeed({
        models: availableModels(),
      });
    }

    if (method !== "session/mode/set") {
      return Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
    }

    const nextModeId =
      typeof params === "object" &&
      params !== null &&
      "modeId" in params &&
      typeof params.modeId === "string"
        ? params.modeId
        : typeof params === "object" &&
            params !== null &&
            "mode" in params &&
            typeof params.mode === "string"
          ? params.mode
          : undefined;
    const requestedSessionId =
      typeof params === "object" &&
      params !== null &&
      "sessionId" in params &&
      typeof params.sessionId === "string"
        ? params.sessionId
        : sessionId;

    if (typeof nextModeId === "string" && nextModeId.trim()) {
      currentModeId = nextModeId.trim();
      return agent.client
        .sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId,
          },
        })
        .pipe(Effect.as({}));
    }

    return Effect.succeed({});
  });

  yield* agent.handleUnknownExtNotification((method) =>
    method === "_test/exit" ? Effect.sync(() => process.exit(19)) : Effect.void,
  );

  return yield* Effect.never;
}).pipe(
  Effect.provide(
    EffectAcpAgent.layerStdio(
      requestLogPath
        ? {
            logIncoming: true,
            logger: (event) => {
              if (event.direction !== "incoming" || event.stage !== "raw") {
                return Effect.void;
              }
              if (typeof event.payload !== "string") {
                return Effect.void;
              }
              const payload = event.payload;
              return Effect.sync(() => {
                NodeFS.appendFileSync(
                  requestLogPath,
                  payload.endsWith("\n") ? payload : `${payload}\n`,
                  "utf8",
                );
              });
            },
          }
        : {},
    ),
  ),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program);
