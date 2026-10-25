// The links file is read with node:fs's synchronous API, like the state readers.
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Pure pieces of Hermes conversation hubs: matching conversations to hub channels, resolving links,
 * and tailing the gateway's `<hermesHome>/t3-hub-links.jsonl`. The tailer keeps its own byte offset
 * and ignores a trailing line without a newline.
 */
import * as NodeFS from "node:fs";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ThreadId } from "@t3tools/contracts";

/** One complete links-file line the gateway cannot have written whole. */
const MAX_LINK_LINE_BYTES = 16 * 1024;

/**
 * The hub settings this module reasons about: the same fields
 * `HermesHubSettings` carries, with `threadId` null while the hub has no
 * thread to post into.
 */
export interface HermesHubChannels {
  readonly id: string;
  readonly name: string;
  readonly threadId: ThreadId | null;
  /** Platform channel ids whose conversations belong to this hub. */
  readonly channels: readonly string[];
  readonly autoLink: boolean;
  readonly autoLinkCap: number;
}

/** A conversation as the channel reader returns it, for hub matching. */
export interface HermesHubConversation {
  readonly sessionKey: string;
  readonly channelIds: readonly string[];
  /** Seconds. */
  readonly lastActivityAt: number;
}

/**
 * True when the conversation's chat, thread, or parent chat is one of the
 * hub's channels. A hub that names no channels matches nothing.
 */
export function conversationInHub(
  conversation: HermesHubConversation,
  hub: HermesHubChannels,
): boolean {
  if (hub.channels.length === 0) return false;
  const channels = new Set(hub.channels);
  return conversation.channelIds.some((id) => channels.has(id));
}

/** One manual link the user (or the links file) persisted. */
export interface ManualHermesChatLink {
  readonly threadId: ThreadId;
  readonly sessionKey: string;
}

/** One link that currently holds, and what its card follows. */
export interface EffectiveHermesChatLink {
  readonly threadId: ThreadId;
  readonly sessionKey: string;
  readonly source: "manual" | "hub";
  /** Newest known conversation activity, seconds; 0 when the window missed it. */
  readonly activityAt: number;
}

/**
 * The links that currently hold: every manual link, plus each auto-linking hub's newest
 * conversations in its channels up to its cap. A manual link to the same thread as a hub's
 * derivation wins, and cards never duplicate. Detached conversations are skipped before the cap, so
 * the hub keeps its newest conversations the user has not detached. Newest activity first.
 */
export function effectiveLinkedConversations(input: {
  readonly hubs: ReadonlyArray<HermesHubChannels>;
  readonly manualLinks: ReadonlyArray<ManualHermesChatLink>;
  readonly conversations: ReadonlyArray<HermesHubConversation>;
  /** Hub derivations the user detached; they stay out until linked again. */
  readonly detached?: ReadonlyArray<ManualHermesChatLink>;
}): ReadonlyArray<EffectiveHermesChatLink> {
  const activity = new Map(
    input.conversations.map((conversation) => [
      conversation.sessionKey,
      conversation.lastActivityAt,
    ]),
  );
  const byKey = new Map<string, EffectiveHermesChatLink>();
  const key = (threadId: ThreadId, sessionKey: string) => `${threadId}\u0000${sessionKey}`;
  const detached = new Set(
    (input.detached ?? []).map((link) => key(link.threadId, link.sessionKey)),
  );
  for (const link of input.manualLinks) {
    byKey.set(key(link.threadId, link.sessionKey), {
      threadId: link.threadId,
      sessionKey: link.sessionKey,
      source: "manual",
      activityAt: activity.get(link.sessionKey) ?? 0,
    });
  }
  for (const hub of input.hubs) {
    const threadId = hub.threadId;
    if (threadId === null || !hub.autoLink) continue;
    const matched = input.conversations
      .filter(
        (conversation) =>
          conversationInHub(conversation, hub) &&
          !detached.has(key(threadId, conversation.sessionKey)),
      )
      .toSorted((a, b) => b.lastActivityAt - a.lastActivityAt);
    for (const conversation of matched.slice(0, hub.autoLinkCap)) {
      const linkKey = key(threadId, conversation.sessionKey);
      if (byKey.has(linkKey)) continue;
      byKey.set(linkKey, {
        threadId,
        sessionKey: conversation.sessionKey,
        source: "hub",
        activityAt: conversation.lastActivityAt,
      });
    }
  }
  return [...byKey.values()].toSorted((a, b) => b.activityAt - a.activityAt);
}

const HermesHubLinkLineJson = Schema.Struct({
  sessionKey: Schema.String,
  hub: Schema.String,
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  at: Schema.optional(Schema.NullOr(Schema.String)),
  action: Schema.optional(Schema.Literals(["link", "unlink"])),
});
const decodeLinkLineJson = Schema.decodeUnknownOption(HermesHubLinkLineJson);

/** One accepted links-file line, in the shape the service acts on. */
export interface HermesHubLinkLine {
  readonly sessionKey: string;
  /** The hub the line names, by id or by name. */
  readonly hub: string;
  readonly reason: string | null;
  readonly at: string | null;
  readonly action: "link" | "unlink";
}

export interface HermesHubLinksTail {
  readonly lines: ReadonlyArray<HermesHubLinkLine>;
  /** Complete lines skipped: not JSON, oversized, or the wrong shape. */
  readonly skipped: number;
}

export interface HermesHubLinksTailer {
  /** New complete lines since the last read, and how many were skipped. */
  readonly read: () => HermesHubLinksTail;
}

/**
 * Tails the gateway's links file by byte offset. Rotation (a file that shrank)
 * resets to the start; a trailing line without its newline is held back until
 * the gateway finishes it, and malformed or oversized lines are skipped, not
 * fatal: one bad line must not hide the rest of the file.
 */
export function makeHermesHubLinksTailer(filePath: string): HermesHubLinksTailer {
  let offset = 0;
  const read = (): HermesHubLinksTail => {
    let size: number;
    try {
      size = NodeFS.statSync(filePath).size;
    } catch {
      return { lines: [], skipped: 0 };
    }
    if (size < offset) offset = 0;
    if (size === offset) return { lines: [], skipped: 0 };
    let bytes: Buffer;
    try {
      const handle = NodeFS.openSync(filePath, "r");
      try {
        bytes = Buffer.alloc(size - offset);
        NodeFS.readSync(handle, bytes, 0, bytes.length, offset);
      } finally {
        NodeFS.closeSync(handle);
      }
    } catch {
      return { lines: [], skipped: 0 };
    }
    const complete = bytes.lastIndexOf(0x0a);
    if (complete === -1) return { lines: [], skipped: 0 };
    const lines: HermesHubLinkLine[] = [];
    let skipped = 0;
    let start = 0;
    for (let index = 0; index <= complete; index++) {
      if (index !== complete && bytes[index] !== 0x0a) continue;
      const line = bytes.subarray(start, index);
      start = index + 1;
      if (line.length === 0) continue;
      if (line.length > MAX_LINK_LINE_BYTES) {
        skipped += 1;
        continue;
      }
      let decoded: Option.Option<(typeof HermesHubLinkLineJson)["Type"]>;
      try {
        decoded = decodeLinkLineJson(JSON.parse(line.toString("utf8")));
      } catch {
        skipped += 1;
        continue;
      }
      if (Option.isNone(decoded)) {
        skipped += 1;
        continue;
      }
      const value = decoded.value;
      const sessionKey = value.sessionKey.trim();
      const hub = value.hub.trim();
      if (!sessionKey || !hub) {
        skipped += 1;
        continue;
      }
      lines.push({
        sessionKey,
        hub,
        reason: value.reason ?? null,
        at: value.at ?? null,
        action: value.action ?? "link",
      });
    }
    offset += complete + 1;
    return { lines, skipped };
  };
  return { read };
}

/** FNV-1a over UTF-8 bytes, as a short hex string for ids that change with text. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}
