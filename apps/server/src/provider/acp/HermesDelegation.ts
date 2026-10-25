/**
 * Hermes `delegate_task` is an ordinary ACP tool, mapped to one subagent per child. Prefer the
 * carried patch's structured fields over stock Markdown, parsed here only. Updates derive from
 * merged tool state; repeated or late updates for finished children drop.
 */
import type { OrchestrationV2SubagentUsage } from "@t3tools/contracts";

import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

/** Structurally an `AcpAdapterV2SubagentUpdate`. */
export interface HermesSubagentUpdate {
  readonly nativeTaskId: string;
  readonly prompt: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly status:
    | "pending"
    | "running"
    | "idle"
    | "completed"
    | "failed"
    | "interrupted"
    | "cancelled";
  readonly childSessionId: null;
  readonly result: string | null;
  readonly role: string | null;
  readonly usage: OrchestrationV2SubagentUsage | null;
}

type Child = {
  readonly index: number;
  readonly title: string;
  readonly role?: string;
  readonly model?: string;
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      return array(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Hermes counts a child's tokens only once it finishes: flat on a live
 * `subagent.complete`, nested under `tokens` in a result entry. Its output
 * count already includes reasoning. Duration comes from either, or from the
 * stock header's `1.5s` bit, and is Hermes's own measure of the child.
 */
function childUsage(result: Record<string, unknown>): OrchestrationV2SubagentUsage | null {
  const tokens = record(result.tokens);
  const round = (value: number | undefined) =>
    value === undefined ? undefined : Math.round(value);
  const input = round(count(result.input_tokens) ?? count(tokens.input));
  const output = round(count(result.output_tokens) ?? count(tokens.output));
  const reasoning = round(count(result.reasoning_tokens));
  const duration = count(result.duration_seconds);
  const usage = {
    ...(input !== undefined || output !== undefined
      ? { totalTokens: (input ?? 0) + (output ?? 0) }
      : {}),
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
    ...(duration !== undefined ? { durationMs: Math.round(duration * 1000) } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : null;
}

function contentText(tool: AcpToolCallState): string {
  return (Array.isArray(tool.data.content) ? tool.data.content : [])
    .flatMap((item) => {
      const entry = record(item);
      const content = record(entry.content);
      return entry.type === "content" && content.type === "text" ? [text(content.text) ?? ""] : [];
    })
    .join("\n");
}

// Stock titles vary by Hermes version and locale ("delegate: goal", "delegate batch (2 tasks)",
// "delegate_task: 2 tasks: a | b"), and list/steer/stop controls share them. The start content is
// fixed English and names a goal only for spawns ("Delegating task:\n<goal>", "Delegating 2 tasks").
const DELEGATE_TITLE =
  /^(?:delegate_task(?::|$)|delegate task$|delegate: |delegate batch \(\d+ tasks\)$)/;
const SPAWN_CONTENT = /^Delegating (?:task:\n\S|\d+ tasks(?:\n|$))/;

function isHermesDelegation(tool: AcpToolCallState): boolean {
  const args = record(tool.data.rawInput);
  if (args.action !== undefined && args.action !== "spawn") return false;
  if (tool.kind !== "execute" || !DELEGATE_TITLE.test(text(tool.data.title) ?? tool.title ?? ""))
    return false;
  return (
    text(args.goal) !== undefined ||
    array(args.tasks).length > 0 ||
    SPAWN_CONTENT.test(contentText(tool))
  );
}

/** A patched Hermes child lifecycle event, reported on its parent delegate_task call. */
function isHermesDelegationProgress(tool: AcpToolCallState): boolean {
  return typeof record(record(tool.data.rawOutput).hermesDelegation).event === "string";
}

function startChildren(tool: AcpToolCallState): Child[] {
  const args = record(tool.data.rawInput);
  const batch = array(args.tasks);
  const tasks = batch.length > 0 ? batch : text(args.goal) ? [args] : [];
  if (tasks.length > 0) {
    return tasks.map((task, index) => {
      const input = record(task);
      const role = text(input.role) ?? text(args.role);
      const model = text(input.model) ?? text(args.model);
      return {
        index,
        title: text(input.goal) ?? `Delegated task ${index + 1}`,
        ...(role ? { role } : {}),
        ...(model ? { model } : {}),
      };
    });
  }
  const content = contentText(tool);
  const batchCount =
    /^Delegating (\d+) tasks/.exec(content)?.[1] ??
    /^delegate batch \((\d+) tasks\)$/.exec(text(tool.data.title) ?? tool.title ?? "")?.[1];
  if (batchCount) {
    // Stock lists only the first eight goals but always states the count. Keep
    // every child, filling omitted metadata from final results. The count is
    // provider text: bound the up-front allocation (as the patch bounds child
    // snapshots); final results still add any child past the bound.
    return Array.from({ length: Math.min(Number(batchCount), 128) }, (_, index) => {
      const line = new RegExp(`^${index + 1}\\. (.*)$`, "m").exec(content)?.[1];
      const roleMatch = line ? /^(.*) \(([^()]+)\)$/.exec(line) : null;
      return {
        index,
        title: roleMatch?.[1] ?? line ?? `Delegated task ${index + 1}`,
        ...(roleMatch?.[2] ? { role: roleMatch[2] } : {}),
      };
    });
  }
  return [
    {
      index: 0,
      title:
        text(content.replace(/^Delegating task:?\n?/, "")) ??
        text((text(tool.data.title) ?? tool.title)?.replace(/^delegate(?:_task)?: /, "")) ??
        "Delegated task",
    },
  ];
}

function stockResults(content: string): Record<string, unknown>[] {
  const headers = [...content.matchAll(/^[✅✗⏱⚠•] Task (\d+): (\w+)(?: \(([^\n]*)\))?$/gm)];
  return headers.map((header, index) => {
    const lines = content
      .slice(header.index! + header[0].length, headers[index + 1]?.index ?? content.length)
      .trim()
      .split("\n");
    const errorAt = lines.findIndex((line) => line.startsWith("Error: "));
    const toolsAt = lines.findLastIndex((line) => line.startsWith("Tools: "));
    const end = toolsAt === -1 ? lines.length : toolsAt;
    const bits = header[3]?.split(", ") ?? [];
    const duration = bits.find((bit) => /^\d+(?:\.\d+)?s$/.test(bit));
    return {
      task_index: Number(header[1]) - 1,
      status: header[2],
      model: bits.find((bit) => !bit.startsWith("role=") && !/^\d+(?:\.\d+)?s$/.test(bit)),
      _child_role: bits.find((bit) => bit.startsWith("role="))?.slice(5),
      duration_seconds: duration ? Number(duration.slice(0, -1)) : undefined,
      summary: lines
        .slice(0, errorAt === -1 ? end : errorAt)
        .join("\n")
        .trim(),
      error: errorAt === -1 ? undefined : lines.slice(errorAt, end).join("\n").slice(7).trim(),
    };
  });
}

function terminalStatus(status: unknown): HermesSubagentUpdate["status"] | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
    case "timeout":
    case "stalled":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

const STOCK_DISPATCH_NOTE =
  "Dispatched in background; stock Hermes ACP does not report child completion.";

function childUpdate(
  toolCallId: string,
  child: Child | undefined,
  index: number,
  status: HermesSubagentUpdate["status"],
  fields: {
    readonly model?: string | undefined;
    readonly role?: string | undefined;
    readonly result?: string | undefined;
    readonly usage?: OrchestrationV2SubagentUsage | null;
  } = {},
): HermesSubagentUpdate {
  return {
    nativeTaskId: `${toolCallId}:task:${index}`,
    // Late progress for a child the adapter already knows carries no goal;
    // an empty prompt and title only update that child, never start one.
    prompt: child?.title ?? "",
    title: child?.title ?? null,
    model: fields.model ?? child?.model ?? null,
    status,
    childSessionId: null,
    result: fields.result ?? null,
    role: fields.role ?? child?.role ?? null,
    usage: fields.usage ?? null,
  };
}

/** Patched results name the role `_child_role`; stock headers carry `role=`. */
function resultRole(result: Record<string, unknown>): string | undefined {
  return text(result._child_role) ?? text(result.role);
}

function resultUpdate(
  toolCallId: string,
  child: Child | undefined,
  index: number,
  result: Record<string, unknown>,
): HermesSubagentUpdate {
  const status = terminalStatus(result.status) ?? "interrupted";
  const summary = text(result.summary) ?? text(result.text);
  const error = text(result.error);
  return childUpdate(toolCallId, child, index, status, {
    model: text(result.model),
    role: resultRole(result),
    result: (status === "completed" ? (summary ?? error) : (error ?? summary)) ?? undefined,
    usage: childUsage(result),
  });
}

/** Launches remembered at once; a call's children outlive its own updates. */
const REMEMBERED_LAUNCHES = 256;

/**
 * Subagent updates for a Hermes delegation call, or undefined when it isn't one; an empty array
 * claims the call without moving a child. Stock Hermes names children only in the start, so they're
 * remembered by call id.
 */
export function makeHermesSubagentExtractor() {
  const launches = new Map<string, ReadonlyArray<Child>>();
  return (tool: AcpToolCallState): ReadonlyArray<HermesSubagentUpdate> | undefined => {
    let children = launches.get(tool.toolCallId);
    if (children === undefined && isHermesDelegation(tool)) {
      children = startChildren(tool);
      launches.set(tool.toolCallId, children);
      if (launches.size > REMEMBERED_LAUNCHES) launches.delete(launches.keys().next().value!);
    }
    if (children === undefined && !isHermesDelegationProgress(tool)) return undefined;
    return delegationUpdates(tool, children ?? []);
  };
}

function delegationUpdates(
  tool: AcpToolCallState,
  children: ReadonlyArray<Child>,
): ReadonlyArray<HermesSubagentUpdate> {
  const output = record(tool.data.rawOutput);
  const progress = record(output.hermesDelegation);
  const childAt = (index: number) => children.find((child) => child.index === index);
  const id = tool.toolCallId;

  if (tool.status === "completed" || tool.status === "failed") {
    if (children.length === 0) return [];
    const content = contentText(tool);
    // Stock clips fallback JSON at 5,000 characters. The dispatch header
    // precedes the potentially long goals; clipping is not a child failure.
    const dispatched =
      output.status === "dispatched" ||
      record(content).status === "dispatched" ||
      /^\{\s*"status"\s*:\s*"dispatched"\s*,\s*"mode"\s*:\s*"background"/.test(content);
    if (dispatched) {
      // The patch (which also fills rawInput) reports each child's end later.
      const live = tool.data.rawInput !== undefined;
      return children.map((child) =>
        childUpdate(
          id,
          child,
          child.index,
          live ? "running" : "idle",
          live ? {} : { result: STOCK_DISPATCH_NOTE },
        ),
      );
    }
    const results = Array.isArray(output.results)
      ? output.results.map(record)
      : stockResults(content);
    const error = text(output.error) ?? /^Delegation failed: ([\s\S]*)$/.exec(content)?.[1];
    const updates: Array<HermesSubagentUpdate> = [];
    const reported = new Set<number>();
    for (const result of results) {
      const index = count(result.task_index);
      if (index === undefined || !Number.isInteger(index) || reported.has(index)) continue;
      reported.add(index);
      updates.push(
        resultUpdate(
          id,
          childAt(index) ?? { index, title: text(result.goal) ?? `Delegated task ${index + 1}` },
          index,
          result,
        ),
      );
    }
    for (const child of children) {
      if (reported.has(child.index)) continue;
      updates.push(
        childUpdate(
          id,
          child,
          child.index,
          error || tool.status === "failed" ? "failed" : "interrupted",
          {
            result: error ?? "Hermes returned without a result for this task.",
          },
        ),
      );
    }
    return updates;
  }

  if (typeof progress.event === "string") {
    const index = count(progress.task_index);
    // Grandchildren report through the same call with a depth; only direct
    // children are rows. Thinking ticks are spinner frames, not progress.
    if (
      index === undefined ||
      !Number.isInteger(index) ||
      (count(progress.depth) ?? 0) !== 0 ||
      progress.event === "subagent.thinking"
    ) {
      return [];
    }
    if (progress.event === "subagent.complete") {
      return [resultUpdate(id, childAt(index), index, progress)];
    }
    return [
      childUpdate(
        id,
        childAt(index),
        index,
        progress.event === "subagent.spawn_requested" ? "pending" : "running",
        { model: text(progress.model), role: resultRole(progress) },
      ),
    ];
  }

  return children.map((child) => childUpdate(id, child, child.index, "running"));
}
