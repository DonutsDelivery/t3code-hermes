/**
 * Turns a Hermes background run's stored messages into run-less thread turn items with ids derived
 * from the run and row, so replays re-derive the same items and cursors can stay in memory. Tool
 * rows map to the item kinds a live Hermes session produces.
 */
import {
  MessageId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { HermesMessageRow } from "./hermesRunState.ts";

/** Longest message text mirrored. A webhook prompt can embed a whole payload. */
const MAX_MESSAGE_CHARS = 20_000;
/** Longest tool result mirrored, matching what live ACP tool calls keep. */
const MAX_TOOL_RESULT_CHARS = 8_000;

/** Hermes's final answer when a run has nothing to report. */
const SILENT_MARKER = "[SILENT]";

export interface HermesRunIds {
  readonly threadId: ThreadId;
  /** `hermes-run:<profile>:<rootSessionId>`, the prefix of every derived id. */
  readonly prefix: string;
}

export interface HermesToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** Unix seconds the call was made, so its finished item keeps its start. */
  readonly startedAt?: number;
}

// Port of Hermes's `TOOL_KIND_MAP` (acp_adapter/tools.py).
const TOOL_KINDS: Record<string, "read" | "edit" | "search" | "execute" | "fetch" | "think"> = {
  read_file: "read",
  skill_view: "read",
  skills_list: "read",
  browser_snapshot: "read",
  browser_vision: "read",
  browser_get_images: "read",
  vision_analyze: "read",
  write_file: "edit",
  patch: "edit",
  skill_manage: "edit",
  search_files: "search",
  terminal: "execute",
  process: "execute",
  execute_code: "execute",
  browser_click: "execute",
  browser_type: "execute",
  browser_scroll: "execute",
  browser_press: "execute",
  browser_back: "execute",
  delegate_task: "execute",
  image_generate: "execute",
  text_to_speech: "execute",
  web_search: "fetch",
  web_extract: "fetch",
  browser_navigate: "fetch",
  _thinking: "think",
};

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function arg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Port of the common cases of Hermes's `build_tool_title`. */
function toolTitle(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "terminal":
      return `terminal: ${clip(arg(args, "command"), 80)}`;
    case "read_file":
      return `read: ${arg(args, "path") || "?"}`;
    case "write_file":
      return `write: ${arg(args, "path") || "?"}`;
    case "patch":
      return `patch (${arg(args, "mode") || "replace"}): ${arg(args, "path") || "?"}`;
    case "search_files":
      return `search: ${arg(args, "pattern") || "?"}`;
    case "web_search":
      return `web search: ${arg(args, "query") || "?"}`;
    case "session_search":
      return arg(args, "query") ? `session search: ${arg(args, "query")}` : "recent sessions";
    case "delegate_task":
      return arg(args, "goal") ? `delegate: ${clip(arg(args, "goal"), 60)}` : "delegate task";
    case "execute_code": {
      const firstLine = arg(args, "code")
        .split("\n")
        .find((line) => line.trim());
      return firstLine ? `python: ${clip(firstLine.trim(), 70)}` : "python code";
    }
    case "skill_view":
      return `skill view (${arg(args, "name") || "?"})`;
    case "browser_navigate":
      return `navigate: ${arg(args, "url") || "?"}`;
    default:
      return name;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Port of Hermes's `_tool_result_failed` for structured results. */
function toolResultFailed(result: unknown): boolean {
  if (!isRecord(result)) return false;
  if (result["success"] === false || result["ok"] === false) return true;
  const exitCode = result["exit_code"];
  if (typeof exitCode === "number" && exitCode !== 0) return true;
  return Boolean(result["error"]) && !result["content"] && !result["output"];
}

type HermesItemStatus = "running" | "completed" | "failed";

function runlessItem(
  ids: HermesRunIds,
  id: string,
  fields: {
    readonly status: HermesItemStatus;
    readonly title: string | null;
    readonly startedAt: DateTime.Utc;
    readonly at: DateTime.Utc;
  },
) {
  return {
    id: TurnItemId.make(`${ids.prefix}:${id}`),
    threadId: ids.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    // Placed by the turn item position store when the item is written.
    ordinal: 0,
    status: fields.status,
    title: fields.title,
    startedAt: fields.startedAt,
    completedAt: fields.status === "running" ? null : fields.at,
    updatedAt: fields.at,
  } as const;
}

/**
 * One tool call as a turn item. `result` is undefined while the call is still
 * running, which renders as an in-progress row.
 */
function hermesToolItem(input: {
  readonly ids: HermesRunIds;
  readonly toolCallId: string;
  readonly call: HermesToolCall;
  readonly result: string | undefined;
  readonly at: DateTime.Utc;
}): OrchestrationV2TurnItem {
  const { call, result } = input;
  const structured = result === undefined ? undefined : parseJson(result);
  const status: HermesItemStatus =
    result === undefined ? "running" : toolResultFailed(structured) ? "failed" : "completed";
  const text =
    result !== undefined && result.trim() ? clip(result, MAX_TOOL_RESULT_CHARS) : undefined;
  const title = toolTitle(call.name, call.args);
  const base = runlessItem(input.ids, `tool:${input.toolCallId}`, {
    status,
    title,
    startedAt: call.startedAt === undefined ? input.at : utcFromSeconds(call.startedAt),
    at: input.at,
  });
  const record = isRecord(structured) ? structured : undefined;
  switch (TOOL_KINDS[call.name]) {
    case "execute":
      if (call.name === "terminal") {
        // Only the usual `{output, exit_code}` shape becomes command output; a
        // bare `{error}` keeps its whole text so the failure stays readable.
        const output =
          typeof record?.["output"] === "string"
            ? clip(record["output"], MAX_TOOL_RESULT_CHARS)
            : text;
        const exitCode = record?.["exit_code"];
        return {
          ...base,
          type: "command_execution",
          input: arg(call.args, "command") || title,
          ...(output === undefined ? {} : { output }),
          ...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exitCode } : {}),
          ...(status === "failed" ? { outputIndicatesFailure: true } : {}),
        };
      }
      break;
    case "edit": {
      const path = arg(call.args, "path");
      return { ...base, type: "file_change", fileName: path || title };
    }
    case "search": {
      const pattern = arg(call.args, "pattern");
      return { ...base, type: "file_search", ...(pattern ? { pattern } : {}) };
    }
    case "fetch": {
      const target = arg(call.args, "query") || arg(call.args, "url");
      return { ...base, type: "web_search", ...(target ? { patterns: [target] } : {}) };
    }
  }
  return {
    ...base,
    type: "dynamic_tool",
    toolName: call.name,
    input: call.args,
    ...(structured !== undefined
      ? { output: structured }
      : text !== undefined
        ? { output: text }
        : {}),
  };
}

/** The tool calls an assistant row asked for, in OpenAI's `tool_calls` shape. */
function parseHermesToolCalls(
  toolCalls: string | null,
): ReadonlyArray<{ readonly id: string } & HermesToolCall> {
  const parsed = toolCalls === null ? undefined : parseJson(toolCalls);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || !entry["id"].trim()) return [];
    const fn = isRecord(entry["function"]) ? entry["function"] : {};
    const name = typeof fn["name"] === "string" && fn["name"].trim() ? fn["name"].trim() : "tool";
    const rawArgs = fn["arguments"];
    const args = typeof rawArgs === "string" ? parseJson(rawArgs) : rawArgs;
    return [{ id: entry["id"].trim(), name, args: isRecord(args) ? args : {} }];
  });
}

/** Hermes stores Unix seconds as REAL; the read model wants ISO strings. */
export function isoFromSeconds(value: number): string {
  return DateTime.formatIso(utcFromSeconds(value));
}

function utcFromSeconds(value: number): DateTime.Utc {
  return DateTime.makeUnsafe(Math.round(value * 1000));
}

/** A turn item to write, with the conversation message it carries, if any. */
export interface HermesRunEntry {
  readonly item: OrchestrationV2TurnItem;
  readonly message?: OrchestrationV2ConversationMessage;
}

export interface HermesRunBatch {
  readonly entries: HermesRunEntry[];
  readonly pullRequestUrls: string[];
  /** Newest assistant text in the batch, the run's report once it ends. */
  readonly lastAssistantText: string | null;
}

function messageEntry(
  ids: HermesRunIds,
  row: HermesMessageRow,
  role: "user" | "assistant",
  text: string,
): HermesRunEntry {
  const at = utcFromSeconds(row.timestamp);
  const messageId = MessageId.make(`${ids.prefix}:m${row.id}`);
  const base = runlessItem(ids, `m${row.id}`, {
    status: "completed",
    title: null,
    startedAt: at,
    at,
  });
  return {
    item:
      role === "user"
        ? {
            ...base,
            createdBy: "user",
            creationSource: "server",
            type: "user_message",
            messageId,
            inputIntent: "turn_start",
            text,
            attachments: [],
          }
        : { ...base, type: "assistant_message", messageId, text, streaming: false },
    message: {
      createdBy: role === "user" ? "user" : "agent",
      creationSource: "server",
      id: messageId,
      threadId: ids.threadId,
      runId: null,
      nodeId: null,
      role,
      text,
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  };
}

/**
 * Turn items for a batch of rows. `toolCalls` carries calls whose result has
 * not arrived yet across batches, keyed by Hermes's tool call id.
 */
export function hermesRunItemsFor(
  ids: HermesRunIds,
  rows: readonly HermesMessageRow[],
  toolCalls: Map<string, HermesToolCall>,
): HermesRunBatch {
  const entries: HermesRunEntry[] = [];
  const pullRequestUrls = new Set<string>();
  let lastAssistantText: string | null = null;
  for (const row of rows) {
    const at = utcFromSeconds(row.timestamp);
    const text = clip(row.content.trim(), MAX_MESSAGE_CHARS);
    if (row.role === "user" && text) {
      entries.push(messageEntry(ids, row, "user", text));
      continue;
    }
    if (row.role === "assistant") {
      for (const url of pullRequestUrlsIn(row, undefined)) pullRequestUrls.add(url);
      if (text) lastAssistantText = text;
      if (row.reasoning) {
        entries.push({
          item: {
            ...runlessItem(ids, `r${row.id}`, {
              status: "completed",
              title: null,
              startedAt: at,
              at,
            }),
            type: "reasoning",
            text: clip(row.reasoning, MAX_MESSAGE_CHARS),
            streaming: false,
          },
        });
      }
      if (text) entries.push(messageEntry(ids, row, "assistant", text));
      for (const call of parseHermesToolCalls(row.toolCalls)) {
        const pending = { name: call.name, args: call.args, startedAt: row.timestamp };
        toolCalls.set(call.id, pending);
        entries.push({
          item: hermesToolItem({ ids, toolCallId: call.id, call: pending, result: undefined, at }),
        });
      }
      continue;
    }
    if (row.role === "tool" && row.toolCallId) {
      const call = toolCalls.get(row.toolCallId) ?? { name: row.toolName ?? "tool", args: {} };
      toolCalls.delete(row.toolCallId);
      for (const url of pullRequestUrlsIn(row, call)) pullRequestUrls.add(url);
      entries.push({
        item: hermesToolItem({ ids, toolCallId: row.toolCallId, call, result: row.content, at }),
      });
    }
  }
  return { entries, pullRequestUrls: [...pullRequestUrls], lastAssistantText };
}

/** A notice that closes a run that could not finish normally. */
export function hermesRunNoticeItem(
  ids: HermesRunIds,
  message: string,
  at: DateTime.Utc,
): OrchestrationV2TurnItem {
  return {
    ...runlessItem(ids, "notice:ended", { status: "completed", title: null, startedAt: at, at }),
    type: "system_notice",
    message,
  };
}

/** A final answer of `[SILENT]` is Hermes's way of saying the run had nothing to report. */
export function isSilentReport(text: string | null): boolean {
  return text !== null && text.trim().startsWith(SILENT_MARKER);
}

// GitHub/Forgejo pulls, GitLab merge requests, Bitbucket and Azure pull requests;
// `parseChangeRequestUrl` decides which of them are real.
const PULL_REQUEST_URL =
  /https?:\/\/[^\s"'<>()[\]`]+(?:\/pulls?\/\d+|\/-\/merge_requests\/\d+|\/pull-requests\/\d+|\/pullrequest\/\d+)/g;

/**
 * Pull request URLs a run worked on: in the agent's own words or the output of `gh pr create`.
 * Read-only commands (`list`, `view`, `status`, ...) print pull requests the run merely looked
 * at, and linking those lets an unrelated merge settle the run's thread. `gh pr merge` prints
 * no URL, and a pull request the run opened was already linked by its `create`.
 */
function pullRequestUrlsIn(row: HermesMessageRow, call: HermesToolCall | undefined): string[] {
  const fromTool =
    row.role === "tool" &&
    call?.name === "terminal" &&
    /\bgh\s+pr\s+create\b/.test(arg(call.args, "command"));
  if (row.role !== "assistant" && !fromTool) return [];
  return [...new Set(row.content.match(PULL_REQUEST_URL) ?? [])];
}
