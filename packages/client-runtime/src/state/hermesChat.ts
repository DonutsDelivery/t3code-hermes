// @effect-diagnostics globalDate:off -- Display-only relative ages and clock labels for transcript rows.
/**
 * Presentation for the read-only Hermes conversation surface, shared by every
 * client: what a conversation is called, how its platform reads, and how a
 * transcript groups into bubbles. No atoms here; each client reads through its
 * own `serverEnvironment.hermesChatList` / `hermesChatTranscript` queries.
 *
 * @module state/hermesChat
 */
import type {
  HermesChatAvailability,
  HermesChatConversation,
  HermesChatMessage,
} from "@t3tools/contracts";

const PLATFORM_LABELS: Record<string, string> = {
  discord: "Discord",
  telegram: "Telegram",
  slack: "Slack",
  whatsapp: "WhatsApp",
  whatsapp_cloud: "WhatsApp",
  signal: "Signal",
  matrix: "Matrix",
  mattermost: "Mattermost",
  email: "Email",
  sms: "SMS",
  bluebubbles: "iMessage",
};

export function hermesChatPlatformLabel(platform: string): string {
  return (
    PLATFORM_LABELS[platform] ??
    platform.replace(/[_-]+/g, " ").replace(/^\w/, (first) => first.toUpperCase())
  );
}

// Hermes titles a fresh thread from its trigger before it has a real title.
const PLACEHOLDER_TITLE = /^\[Triggering message id:/;

/**
 * The conversation's name: the thread or channel's own name, else Hermes's
 * title, else who it is with. A channel conversation is per person, so its
 * channel name carries the person too.
 */
export function hermesChatConversationTitle(
  conversation: Pick<HermesChatConversation, "displayName" | "title" | "userName" | "chatType">,
): string {
  const title =
    conversation.title !== null && !PLACEHOLDER_TITLE.test(conversation.title)
      ? conversation.title
      : null;
  const place = conversation.displayName?.split(" / ").at(-1)?.trim() || null;
  if (conversation.chatType === "dm") return conversation.userName ?? title ?? "Direct message";
  if (conversation.chatType === "thread" && place) return place;
  if (place && conversation.userName) return `${place} · ${conversation.userName}`;
  return place ?? title ?? conversation.userName ?? "Conversation";
}

/** The line under the title: platform, then the server or channel path. */
export function hermesChatConversationSubtitle(
  conversation: Pick<HermesChatConversation, "platform" | "displayName" | "title" | "chatType">,
): string {
  const path = conversation.displayName?.split(" / ").slice(0, -1).join(" / ") || null;
  const title =
    conversation.chatType !== "thread" &&
    conversation.title !== null &&
    !PLACEHOLDER_TITLE.test(conversation.title)
      ? conversation.title
      : null;
  return [hermesChatPlatformLabel(conversation.platform), path, title]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** "now", "5m", "3h", "2d", then a date. */
export function formatHermesChatAge(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatHermesChatTime(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export type HermesChatTranscriptItem =
  | { readonly kind: "message"; readonly message: HermesChatMessage }
  /** Consecutive tool rows between two messages, shown collapsed. */
  | {
      readonly kind: "tools";
      readonly id: string;
      readonly messages: readonly HermesChatMessage[];
      readonly toolNames: readonly string[];
    }
  /** Where Hermes started a fresh session under the same conversation. */
  | { readonly kind: "session"; readonly id: string; readonly timestamp: string };

/** Groups a transcript into bubbles, collapsed tool runs, and session boundaries. */
export function hermesChatTranscriptItems(
  messages: readonly HermesChatMessage[],
): readonly HermesChatTranscriptItem[] {
  const items: HermesChatTranscriptItem[] = [];
  let tools: HermesChatMessage[] = [];
  let sessionId: string | null = null;
  const flushTools = () => {
    if (tools.length === 0) return;
    const names = tools.flatMap((message) =>
      message.toolName === null ? [] : message.toolName.split(", "),
    );
    items.push({
      kind: "tools",
      id: `tools:${tools[0]!.id}`,
      messages: tools,
      toolNames: [...new Set(names)],
    });
    tools = [];
  };
  for (const message of messages) {
    if (sessionId !== null && message.sessionId !== sessionId) {
      flushTools();
      items.push({ kind: "session", id: `session:${message.id}`, timestamp: message.timestamp });
    }
    sessionId = message.sessionId;
    if (message.role === "tool") tools.push(message);
    else {
      flushTools();
      items.push({ kind: "message", message });
    }
  }
  flushTools();
  return items;
}

/** "Used terminal, skill_view" for a collapsed tool run. */
export function describeHermesChatTools(
  item: Extract<HermesChatTranscriptItem, { kind: "tools" }>,
): string {
  const shown = item.toolNames.slice(0, 3).join(", ");
  const more = item.toolNames.length > 3 ? ` +${item.toolNames.length - 3}` : "";
  return item.toolNames.length === 0
    ? `${item.messages.length} tool steps`
    : `Used ${shown}${more}`;
}

/** Why there is nothing to show, or null when the read succeeded. */
export function describeHermesChatAvailability(
  availability: HermesChatAvailability,
): { readonly title: string; readonly detail: string } | null {
  switch (availability) {
    case "ready":
      return null;
    case "hermes-off":
      return {
        title: "Hermes is off",
        detail: "Turn on the Hermes provider in Settings to see its gateway conversations.",
      };
    case "unavailable":
      return {
        title: "Hermes conversations unavailable",
        detail: "This environment could not read Hermes's session store. It retries on its own.",
      };
  }
}
