// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { ThreadId } from "@t3tools/contracts";

import {
  conversationInHub,
  effectiveLinkedConversations,
  makeHermesHubLinksTailer,
  type HermesHubChannels,
  type HermesHubConversation,
} from "./hermesChatHubs.ts";

const HUB_THREAD = ThreadId.make("thread-hub");

function hub(overrides: Partial<HermesHubChannels> = {}): HermesHubChannels {
  return {
    id: "gaming",
    name: "Gaming",
    threadId: HUB_THREAD,
    channels: ["111", "222"],
    autoLink: true,
    autoLinkCap: 5,
    ...overrides,
  };
}

function conversation(
  sessionKey: string,
  channelIds: readonly string[],
  lastActivityAt: number,
): HermesHubConversation {
  return { sessionKey, channelIds, lastActivityAt };
}

describe("conversationInHub", () => {
  it("matches a chat, thread, or parent chat channel", () => {
    const channels = hub();
    expect(conversationInHub(conversation("k1", ["999"], 1), channels)).toBe(false);
    expect(conversationInHub(conversation("k2", ["999", "111"], 1), channels)).toBe(true);
    expect(conversationInHub(conversation("k3", ["222"], 1), channels)).toBe(true);
    // A hub naming no channels matches nothing, not everything.
    expect(conversationInHub(conversation("k4", ["111"], 1), hub({ channels: [] }))).toBe(false);
  });
});

describe("effectiveLinkedConversations", () => {
  it("keeps manual links and caps each hub's auto links at its newest conversations", () => {
    const manualThread = ThreadId.make("thread-manual");
    const links = effectiveLinkedConversations({
      hubs: [hub({ autoLinkCap: 2 })],
      manualLinks: [{ threadId: manualThread, sessionKey: "dm" }],
      conversations: [
        conversation("dm", ["333"], 500),
        conversation("old", ["111"], 100),
        conversation("mid", ["111", "999"], 300),
        conversation("new", ["222"], 400),
        conversation("outside", ["999"], 900),
      ],
    });
    expect(links).toEqual([
      { threadId: manualThread, sessionKey: "dm", source: "manual", activityAt: 500 },
      { threadId: HUB_THREAD, sessionKey: "new", source: "hub", activityAt: 400 },
      { threadId: HUB_THREAD, sessionKey: "mid", source: "hub", activityAt: 300 },
    ]);
  });

  it("skips detached conversations before the cap, so the next newest fills in", () => {
    const links = effectiveLinkedConversations({
      hubs: [hub({ autoLinkCap: 2 })],
      manualLinks: [],
      conversations: [
        conversation("old", ["111"], 100),
        conversation("mid", ["111"], 300),
        conversation("new", ["222"], 400),
      ],
      detached: [{ threadId: HUB_THREAD, sessionKey: "new" }],
    });
    expect(links.map((link) => link.sessionKey)).toEqual(["mid", "old"]);
  });

  it("prefers a manual link over the same hub derivation and skips hubs without threads or autoLink", () => {
    const links = effectiveLinkedConversations({
      hubs: [
        hub(),
        hub({ id: "off", name: "Off", autoLink: false }),
        hub({ id: "loose", name: "Loose", threadId: null }),
      ],
      manualLinks: [{ threadId: HUB_THREAD, sessionKey: "new" }],
      conversations: [conversation("new", ["222"], 400), conversation("mid", ["111"], 300)],
    });
    expect(links).toEqual([
      { threadId: HUB_THREAD, sessionKey: "new", source: "manual", activityAt: 400 },
      { threadId: HUB_THREAD, sessionKey: "mid", source: "hub", activityAt: 300 },
    ]);
  });
});

describe("makeHermesHubLinksTailer", () => {
  function makeLinksFile(initial = "") {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-hub-links-"));
    const filePath = NodePath.join(dir, "t3-hub-links.jsonl");
    if (initial) NodeFS.writeFileSync(filePath, initial);
    return {
      filePath,
      append: (text: string) => NodeFS.appendFileSync(filePath, text),
      replace: (text: string) => NodeFS.writeFileSync(filePath, text),
      cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("returns each complete line once and holds a partial trailing line back", () => {
    const file = makeLinksFile();
    try {
      const tailer = makeHermesHubLinksTailer(file.filePath);
      file.append(
        `${JSON.stringify({ sessionKey: "k1", hub: "gaming", reason: "asked", at: "2026-10-01T00:00:00Z" })}\n` +
          `${JSON.stringify({ sessionKey: "k2", hub: "Gaming", action: "unlink" })}\n`,
      );
      // No trailing newline: the gateway has not finished this line yet.
      file.append(`${JSON.stringify({ sessionKey: "k3", hub: "gaming" })}`);
      expect(tailer.read()).toEqual({
        lines: [
          {
            sessionKey: "k1",
            hub: "gaming",
            reason: "asked",
            at: "2026-10-01T00:00:00Z",
            action: "link",
          },
          { sessionKey: "k2", hub: "Gaming", reason: null, at: null, action: "unlink" },
        ],
        skipped: 0,
      });
      expect(tailer.read()).toEqual({ lines: [], skipped: 0 });

      file.append("\n");
      expect(tailer.read().lines.map((line) => line.sessionKey)).toEqual(["k3"]);
    } finally {
      file.cleanup();
    }
  });

  it("skips malformed and oversized lines but keeps the valid ones around them", () => {
    const file = makeLinksFile();
    try {
      const tailer = makeHermesHubLinksTailer(file.filePath);
      const oversized = `${JSON.stringify({ sessionKey: "k-big", hub: "gaming" })}${"x".repeat(20_000)}`;
      file.append(
        `not json\n` +
          `${oversized}\n` +
          `${JSON.stringify({ sessionKey: "k-ok", hub: "gaming" })}\n` +
          `${JSON.stringify({ hub: "gaming" })}\n`,
      );
      const tail = tailer.read();
      expect(tail.lines.map((line) => line.sessionKey)).toEqual(["k-ok"]);
      expect(tail.skipped).toBe(3);
      expect(tailer.read()).toEqual({ lines: [], skipped: 0 });
    } finally {
      file.cleanup();
    }
  });

  it("reads a rotated file from the start again", () => {
    const file = makeLinksFile();
    try {
      const tailer = makeHermesHubLinksTailer(file.filePath);
      file.append(
        `${"y".repeat(20_000)}\n${"y".repeat(20_000)}\n${"y".repeat(20_000)}\n${"y".repeat(20_000)}\n`,
      );
      expect(tailer.read().skipped).toBe(4); // malformed, but the offset advanced
      // Rotation: the gateway truncated and rewrote the file smaller.
      file.replace(`${JSON.stringify({ sessionKey: "k-new", hub: "gaming" })}\n`);
      expect(tailer.read().lines.map((line) => line.sessionKey)).toEqual(["k-new"]);
    } finally {
      file.cleanup();
    }
  });

  it("reads a missing file as nothing without failing", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-hub-links-"));
    try {
      const tailer = makeHermesHubLinksTailer(NodePath.join(dir, "t3-hub-links.jsonl"));
      expect(tailer.read()).toEqual({ lines: [], skipped: 0 });
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
