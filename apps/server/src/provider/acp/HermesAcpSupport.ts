/**
 * Spawn, model, and mode helpers for `hermes acp`. Hermes reads credentials from its own
 * `HERMES_HOME`, so `authenticate` is a constant.
 */
import {
  type HermesSettings,
  ProviderDriverKind,
  type RuntimeMode,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import { normalizeModelSlug } from "@t3tools/shared/model";

import type {
  AcpSessionModeState,
  AcpToolCallState,
} from "@t3tools/provider-acp/server/runtimeModel";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const HERMES_DRIVER_KIND = ProviderDriverKind.make("hermes");
/** Hermes authenticates from `~/.hermes/.env`; the method id is a formality. */
const HERMES_AUTH_METHOD_ID = "hermes";
export const HERMES_FALLBACK_MODEL_ID = "hermes-4";

/**
 * Mode ids Hermes derives from its edit-approval policy (`default`, `accept_edits`, `dont_ask`).
 * Matching is by id, name, then substring, so builds that rename a policy still resolve. Order is
 * preference: `dont_ask` auto-allows every edit, while `accept_edits` still asks outside the
 * workspace.
 */
const HERMES_AUTONOMOUS_MODE_ALIASES = [
  "dont_ask",
  "don't ask",
  "auto",
  "autonomous",
  "auto approve",
  "yolo",
  "full access",
  "accept edits",
  "bypass",
];
const HERMES_ACCEPT_EDITS_MODE_ALIASES = [
  "accept_edits",
  "accept edits",
  ...HERMES_AUTONOMOUS_MODE_ALIASES,
];
const HERMES_APPROVAL_MODE_ALIASES = ["ask", "approve", "manual", "confirm", "default"];

/**
 * Slash commands the Hermes ACP adapter handles, mirroring `_ADVERTISED_COMMANDS` in
 * `acp_adapter/server.py` (not the TUI's set). Seeds the composer before
 * `available_commands_update` lands.
 */
export const HERMES_BUILT_IN_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  { name: "help", description: "List available commands" },
  {
    name: "model",
    description: "Show current model and provider, or switch models",
    input: { hint: "model name to switch to" },
  },
  { name: "tools", description: "List available tools with descriptions" },
  { name: "context", description: "Show conversation message counts by role" },
  { name: "reset", description: "Clear conversation history" },
  { name: "compress", description: "Compress conversation context" },
  {
    name: "steer",
    description: "Inject guidance into the currently running agent turn",
    input: { hint: "guidance for the active turn" },
  },
  {
    name: "queue",
    description: "Queue a prompt to run after the current turn finishes",
    input: { hint: "prompt to run next" },
  },
  { name: "version", description: "Show Hermes version" },
];

/**
 * Hermes skill and memory tools keep their name only in the agent's title
 * (`skill view (name)`, `memory add: user`); the shared presentation flattens
 * read and edit kinds into "Read file" or "Changed files". Clients label the
 * fork's skill and memory work-log rows from the turn item title.
 */
const HERMES_AGENT_ACTIVITY_TITLE = /^(?:skills?[ _]|memory )/i;

export function preserveHermesAgentActivityTitle(toolCall: AcpToolCallState): AcpToolCallState {
  const title = typeof toolCall.data.title === "string" ? toolCall.data.title.trim() : "";
  return title && HERMES_AGENT_ACTIVITY_TITLE.test(title) && toolCall.title !== title
    ? { ...toolCall, title }
    : toolCall;
}

const HERMES_TERMINAL_RESULT_HEADINGS = new Set(["terminal result", "✅ terminal completed"]);
const HERMES_RESULT_FIELD = /^- \*\*[\w-]+:\*\*/;
const HERMES_OUTPUT_FIELD = "- **output:**";
const HERMES_EXIT_CODE_FIELD = /^- \*\*exit_code:\*\* (-?\d+)$/;

/**
 * Hermes's `terminal` tool sends a markdown summary instead of `rawOutput`, so client previews
 * would read "terminal result". Move the output into `rawOutput.stdout` and drop the summary; other
 * text passes through.
 */
export function normalizeHermesTerminalResult(toolCall: AcpToolCallState): AcpToolCallState {
  if (
    toolCall.kind !== "execute" ||
    (toolCall.status !== "completed" && toolCall.status !== "failed") ||
    toolCall.data.rawOutput !== undefined ||
    !Array.isArray(toolCall.data.content) ||
    toolCall.data.content.length !== 1
  ) {
    return toolCall;
  }
  const entry = toolCall.data.content[0] as EffectAcpSchema.ToolCallContent;
  if (entry.type !== "content" || entry.content.type !== "text") {
    return toolCall;
  }
  const [heading = "", ...lines] = entry.content.text.split("\n");
  if (!HERMES_TERMINAL_RESULT_HEADINGS.has(heading.trim())) {
    return toolCall;
  }

  // Hermes writes `output`, then `exit_code`, then optional fields such as
  // `cwd` or `hint`. The output can itself contain lines shaped like fields,
  // so it runs to the last exit-code line rather than the next field.
  const exitCodeIndex = lines.findLastIndex((line) => HERMES_EXIT_CODE_FIELD.test(line));
  const exitCodeMatch =
    exitCodeIndex === -1 ? null : HERMES_EXIT_CODE_FIELD.exec(lines[exitCodeIndex]!);
  const exitCode = exitCodeMatch ? Number(exitCodeMatch[1]) : undefined;
  const outputIndex = lines.findIndex((line) => line.startsWith(HERMES_OUTPUT_FIELD));
  let stdout: string | undefined;
  if (outputIndex !== -1) {
    const nextFieldIndex = lines.findIndex(
      (line, index) => index > outputIndex && HERMES_RESULT_FIELD.test(line),
    );
    const outputEnd =
      exitCodeIndex > outputIndex
        ? exitCodeIndex
        : nextFieldIndex === -1
          ? lines.length
          : nextFieldIndex;
    stdout = [
      lines[outputIndex]!.slice(HERMES_OUTPUT_FIELD.length),
      ...lines.slice(outputIndex + 1, outputEnd),
    ]
      .join("\n")
      .trim();
  }

  const { content: _summary, ...data } = toolCall.data;
  return {
    ...toolCall,
    data: {
      ...data,
      rawOutput: {
        ...(stdout ? { stdout } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
      },
    },
  };
}

type HermesAcpRuntimeHermesSettings = Pick<HermesSettings, "binaryPath">;

export interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: hermesSettings?.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeHermesAcpRuntime = Effect.fn("HermesAcpSupport.makeHermesAcpRuntime")(function* (
  input: HermesAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> {
  const acpContext = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
      authMethodId: HERMES_AUTH_METHOD_ID,
    }).pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      ),
    ),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
    Effect.provide(acpContext),
  );
});

export function resolveHermesAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : HERMES_FALLBACK_MODEL_ID;
  return normalizeModelSlug(base, HERMES_DRIVER_KIND) ?? HERMES_FALLBACK_MODEL_ID;
}

export function currentHermesModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyHermesAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
  /**
   * Re-send `session/set_model` even when unchanged: Hermes rebuilds the agent from `config.yaml`,
   * which is how reasoning effort reaches a running session. Session id and history survive.
   */
  readonly forceReapply?: boolean;
}): Effect.Effect<string | undefined, E> {
  // Hermes model ids are `provider:model`, so the bare placeholder is never one: asking for it
  // means "keep whatever the profile runs". A bare model naming the one already running (a
  // background run's thread records the bare model when its provider was a `custom` endpoint) is a
  // keep as well.
  const requestedModelId =
    input.requestedModelId === HERMES_FALLBACK_MODEL_ID ||
    (input.requestedModelId !== undefined &&
      !input.requestedModelId.includes(":") &&
      input.currentModelId?.endsWith(`:${input.requestedModelId}`))
      ? undefined
      : input.requestedModelId;
  const targetModelId = requestedModelId ?? input.currentModelId;
  const shouldSwitchModel =
    targetModelId !== undefined &&
    (targetModelId !== input.currentModelId || input.forceReapply === true);
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(targetModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(targetModelId));
}

function findModeIdByAliases(
  modes: ReadonlyArray<AcpSessionModeState["availableModes"][number]>,
  aliases: ReadonlyArray<string>,
): string | undefined {
  const searchText = (mode: (typeof modes)[number]) =>
    [mode.id, mode.name, mode.description]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ")
      .toLowerCase();

  for (const alias of aliases) {
    const exact = modes.find(
      (mode) => mode.id.toLowerCase() === alias || mode.name.toLowerCase() === alias,
    );
    if (exact) return exact.id;
  }
  for (const alias of aliases) {
    const partial = modes.find((mode) => searchText(mode).includes(alias));
    if (partial) return partial.id;
  }
  return undefined;
}

/**
 * Pick the Hermes session mode that matches the thread's runtime mode.
 * Returns `undefined` when the agent advertises no modes, or when the mode
 * it already runs is the best match — callers then skip `session/set_mode`.
 */
export function resolveHermesSessionModeId(input: {
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState || modeState.availableModes.length === 0) {
    return undefined;
  }
  const aliases =
    input.runtimeMode === "approval-required"
      ? HERMES_APPROVAL_MODE_ALIASES
      : input.runtimeMode === "auto-accept-edits"
        ? HERMES_ACCEPT_EDITS_MODE_ALIASES
        : HERMES_AUTONOMOUS_MODE_ALIASES;
  const requestedModeId = findModeIdByAliases(modeState.availableModes, aliases);
  return requestedModeId === undefined || requestedModeId === modeState.currentModeId
    ? undefined
    : requestedModeId;
}
