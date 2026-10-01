/**
 * HermesAcpSupport — spawn, model, and mode helpers for the Hermes Agent
 * ACP stdio server (`hermes acp`).
 *
 * Hermes reads its credentials from its own `HERMES_HOME` (`~/.hermes/.env`),
 * so unlike Grok there is no API-key-vs-cached-token branch here: the
 * `authenticate` method id is a constant and the agent resolves the rest.
 *
 * @module provider/acp/HermesAcpSupport
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
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import type { AcpSessionModeState, AcpToolCallState } from "./AcpRuntimeModel.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { isHermesDelegationProgress } from "./HermesDelegation.ts";

const HERMES_DRIVER_KIND = ProviderDriverKind.make("hermes");
/** Hermes authenticates from `~/.hermes/.env`; the method id is a formality. */
const HERMES_AUTH_METHOD_ID = "hermes";
export const HERMES_FALLBACK_MODEL_ID = "hermes-4";

/**
 * Mode ids Hermes derives from its edit-approval policy (`default`,
 * `accept_edits`, `dont_ask`). Matching is by id, name, then substring, so
 * builds that rename a policy still resolve. Order is preference: `dont_ask`
 * auto-allows every edit, while `accept_edits` still asks outside the
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
 * Slash commands the Hermes ACP adapter handles locally, mirroring its
 * `_ADVERTISED_COMMANDS` table (`acp_adapter/server.py`). Hermes advertises the
 * same list over `available_commands_update` shortly after `session/new`; this
 * seed keeps the composer menu populated on a cold snapshot and whenever the
 * probe's session closes before that notification lands.
 *
 * Note these are the *ACP adapter's* commands, which are a different set from
 * the interactive `hermes` TUI's commands — the adapter only implements the
 * nine below, and anything else is forwarded to the model as ordinary prose.
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
 * Hermes reports context compaction through its own `_meta` extension rather
 * than an ACP-native update: `session_info_update` carries
 * `_meta.hermes.sessionProvenance` and sets `reason: "compression"` when the
 * notification was triggered by a compression-driven session split.
 *
 * @see acp_adapter/provenance.py in NousResearch/hermes-agent
 */
export function hermesSessionInfoIndicatesCompaction(rawPayload: unknown): boolean {
  if (typeof rawPayload !== "object" || rawPayload === null) {
    return false;
  }
  const meta = (rawPayload as { readonly _meta?: unknown })._meta;
  const update = (rawPayload as { readonly update?: { readonly _meta?: unknown } }).update;
  for (const candidate of [update?._meta, meta]) {
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }
    const hermes = (candidate as { readonly hermes?: unknown }).hermes;
    if (typeof hermes !== "object" || hermes === null) {
      continue;
    }
    const provenance = (hermes as { readonly sessionProvenance?: unknown }).sessionProvenance;
    if (typeof provenance !== "object" || provenance === null) {
      continue;
    }
    const reason = (provenance as { readonly reason?: unknown }).reason;
    if (reason === "compression") {
      return true;
    }
  }
  return false;
}

const HERMES_TERMINAL_RESULT_HEADINGS = new Set(["terminal result", "✅ terminal completed"]);
const HERMES_RESULT_FIELD = /^- \*\*[\w-]+:\*\*/;
const HERMES_OUTPUT_FIELD = "- **output:**";
const HERMES_EXIT_CODE_FIELD = /^- \*\*exit_code:\*\* (-?\d+)$/;

/**
 * Hermes sends no `rawOutput` for its `terminal` tool. Its completion content
 * is a markdown summary instead (`_format_generic_structured_result` in
 * acp_adapter/tools.py):
 *
 *     terminal result
 *     - **output:** <command output, possibly multi-line>
 *     - **exit_code:** 0
 *
 * Clients only receive a one-line preview of tool content, so every Hermes
 * command would read "terminal result". Move the output into
 * `rawOutput.stdout` and drop the summary so the preview is the real output.
 * Anything else, including Hermes's `terminal failed: <error>` text, passes
 * through untouched.
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

/**
 * How many of a session's opening prompts to keep for
 * {@link isHermesDerivedTitle}. Hermes titles from the first message that
 * reaches the agent, which a locally handled slash command or a quick steer
 * can push past the very first prompt.
 */
export const HERMES_TITLE_PROMPT_LIMIT = 4;

/**
 * Hermes titles a session twice: first an instant title cut from the opening
 * message (`derive_title` in agent/title_generator.py), then a model-written
 * one. ACP does not say which is which, and T3 Code already titles a thread
 * from its first message, so a title that is just a prefix of one of the
 * opening prompts is the derived one and is not worth forwarding.
 */
export function isHermesDerivedTitle(
  title: string,
  openingPrompts: ReadonlyArray<string>,
): boolean {
  const collapse = (value: string) => value.split(/\s+/).filter(Boolean).join(" ");
  const stem = collapse(title.replace(/…$/, "")).replace(/[ ,.;:—-]+$/, "");
  return stem.length > 0 && openingPrompts.some((prompt) => collapse(prompt).startsWith(stem));
}

type HermesAcpRuntimeHermesSettings = Pick<HermesSettings, "binaryPath">;

export interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn" | "transformSessionUpdate"
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

/** Hermes's reply to a steer it folded into the running turn. */
const HERMES_REDIRECT_ACK = "Redirected the active turn with your correction.";

/**
 * Hermes confirms a live steer by sending a fixed sentence as assistant text.
 * The user's steer message already shows in the thread, so the sentence is
 * blanked; the runtime drops empty chunks without opening an assistant message.
 */
function dropHermesRedirectAck(
  notification: EffectAcpSchema.SessionNotification,
): EffectAcpSchema.SessionNotification {
  const update = notification.update;
  if (
    update.sessionUpdate !== "agent_message_chunk" ||
    update.content.type !== "text" ||
    update.content.text !== HERMES_REDIRECT_ACK
  ) {
    return notification;
  }
  return { ...notification, update: { ...update, content: { ...update.content, text: "" } } };
}

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        authMethodId: HERMES_AUTH_METHOD_ID,
        clientCapabilities: { _meta: { "hermes.backgroundNotifications": 1 } },
        transformSessionUpdate: dropHermesRedirectAck,
        isPassthroughToolCallUpdate: isHermesDelegationProgress,
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
   * Re-send `session/set_model` even when the model is unchanged.
   *
   * Hermes rebuilds the session's agent from `config.yaml` on every
   * `set_session_model`, so this is how a setting that only lives in that file
   * — reasoning effort — reaches a session that is already running. The session
   * id and its history survive the rebuild, exactly as they do for a real model
   * switch.
   */
  readonly forceReapply?: boolean;
}): Effect.Effect<string | undefined, E> {
  // Hermes model ids are `provider:model`, so the bare placeholder is never
  // one: asking for it means "keep whatever the profile runs".
  // A bare model naming the one already running (a background run's thread
  // records the bare model when its provider was a `custom` endpoint) is a
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
