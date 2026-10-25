// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";

import {
  HERMES_CHAT_MESSAGE_TEXT_MAX,
  cleanHermesGatewayUserText,
  readHermesChatConversations,
  readHermesChatTranscript,
} from "./hermesChatState.ts";
import {
  HERMES_STATE_DDL,
  insertHermesGatewaySession,
  insertHermesMessage,
  insertHermesSession,
} from "./hermesRunFixtures.ts";

const THREAD = "agent:main:discord:thread:111:111";
const DM = "agent:main:discord:dm:222";

function withStateDb(seed: (db: NodeSqlite.DatabaseSync) => void, run: (dbPath: string) => void) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-chat-"));
  const dbPath = NodePath.join(dir, "state.db");
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    db.exec(HERMES_STATE_DDL);
    seed(db);
  } finally {
    db.close();
  }
  try {
    run(dbPath);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

/** A thread that was compressed once, then reset into a fresh keyed session. */
function seedRotatedThread(db: NodeSqlite.DatabaseSync) {
  insertHermesGatewaySession(db, {
    id: "s1",
    sessionKey: THREAD,
    startedAt: 1_000,
    endedAt: 1_100,
    endReason: "compression",
    title: "Fix my lag",
  });
  // Hermes writes the compression continuation without a key.
  insertHermesGatewaySession(db, {
    id: "s1-cont",
    sessionKey: null,
    parentSessionId: "s1",
    startedAt: 1_100,
    endedAt: 1_200,
    endReason: "session_reset",
  });
  insertHermesGatewaySession(db, {
    id: "s2",
    sessionKey: THREAD,
    startedAt: 1_300,
    lastActivityAt: 1_400,
    displayName: "Guild / #general / fix my lag",
  });
  insertHermesMessage(db, {
    sessionId: "s1",
    role: "system",
    content: "You are Hermes",
    timestamp: 1_000,
  });
  insertHermesMessage(db, {
    sessionId: "s1",
    role: "user",
    content: "[Yato] my game lags",
    timestamp: 1_001,
  });
  insertHermesMessage(db, {
    sessionId: "s1",
    role: "assistant",
    toolCalls: [
      { id: "c1", name: "terminal", args: { command: "uptime" } },
      { id: "c2", name: "terminal", args: { command: "free" } },
    ],
    timestamp: 1_002,
  });
  insertHermesMessage(db, {
    sessionId: "s1",
    role: "tool",
    toolName: "terminal",
    toolCallId: "c1",
    content: `{"output": "${"load ".repeat(100)}"}`,
    timestamp: 1_003,
  });
  insertHermesMessage(db, {
    sessionId: "s1-cont",
    role: "user",
    content: "Summary of the earlier conversation",
    compressedSummary: true,
    timestamp: 1_100,
  });
  insertHermesMessage(db, {
    sessionId: "s1-cont",
    role: "assistant",
    content: "Load looks fine.",
    timestamp: 1_101,
  });
  insertHermesMessage(db, { sessionId: "s1-cont", role: "session_meta", timestamp: 1_102 });
  insertHermesMessage(db, {
    sessionId: "s1-cont",
    role: "assistant",
    content: "",
    displayKind: "hidden",
    timestamp: 1_103,
  });
  insertHermesMessage(db, {
    sessionId: "s2",
    role: "user",
    content:
      '[Replying to: "Load looks fine."]\n\n[backfilled channel history]\n\n[New message]\nstill lagging',
    timestamp: 1_301,
  });
  insertHermesMessage(db, {
    sessionId: "s2",
    role: "assistant",
    content: "x".repeat(9_000),
    timestamp: 1_302,
  });
}

describe("readHermesChatTranscript", () => {
  it("follows resets and compression across one session key, oldest first", () => {
    withStateDb(seedRotatedThread, (dbPath) => {
      const read = readHermesChatTranscript(dbPath, THREAD, 500);
      expect(read?.truncated).toBe(false);
      expect(read?.messages.map((message) => [message.sessionId, message.role])).toEqual([
        ["s1", "user"],
        ["s1", "tool"],
        ["s1", "tool"],
        ["s1-cont", "assistant"],
        ["s2", "user"],
        ["s2", "assistant"],
      ]);
      const [, call, result, , reply, long] = read!.messages;
      expect(call).toMatchObject({ text: "Called terminal", toolName: "terminal" });
      expect(result!.text.startsWith('terminal → {"output": "load load')).toBe(true);
      expect(result!.text.length).toBeLessThanOrEqual(160);
      expect(reply).toMatchObject({ text: "still lagging", replyTo: "Load looks fine." });
      expect(long!.text.length).toBe(HERMES_CHAT_MESSAGE_TEXT_MAX);
      expect(read?.conversation).toMatchObject({
        sessionKey: THREAD,
        platform: "discord",
        displayName: "Guild / #general / fix my lag",
        title: "Fix my lag",
        lastActivityAt: 1_400,
        latestMessagePreview: `${"x".repeat(139)}…`,
      });
    });
  });

  it("keeps the newest messages when the conversation is longer than the limit", () => {
    withStateDb(seedRotatedThread, (dbPath) => {
      const read = readHermesChatTranscript(dbPath, THREAD, 2);
      expect(read?.truncated).toBe(true);
      expect(read?.messages.map((message) => message.text)).toEqual([
        "still lagging",
        expect.stringMatching(/^x+…$/),
      ]);
    });
  });

  it("reads an unknown key as empty and a missing store as unavailable", () => {
    withStateDb(seedRotatedThread, (dbPath) => {
      expect(readHermesChatTranscript(dbPath, DM, 10)).toEqual({
        conversation: null,
        messages: [],
        truncated: false,
      });
      expect(
        readHermesChatTranscript(NodePath.join(NodePath.dirname(dbPath), "missing.db"), THREAD, 10),
      ).toBeNull();
    });
  });
});

describe("readHermesChatConversations", () => {
  it("lists messaging conversations by recent activity and skips agent and background sessions", () => {
    withStateDb(
      (db) => {
        seedRotatedThread(db);
        insertHermesGatewaySession(db, {
          id: "dm1",
          sessionKey: DM,
          startedAt: 2_000,
          userName: "Kirby",
        });
        insertHermesMessage(db, {
          sessionId: "dm1",
          role: "user",
          content: "hi",
          timestamp: 2_001,
        });
        insertHermesGatewaySession(db, {
          id: "old",
          sessionKey: "agent:main:discord:thread:333:333",
          startedAt: 10,
        });
        insertHermesGatewaySession(db, {
          id: "acp1",
          sessionKey: "agent:main:local:dm:abc",
          source: "acp",
          startedAt: 3_000,
        });
        insertHermesSession(db, {
          id: "cron_job_20260101_000000",
          source: "cron",
          startedAt: 3_000,
        });
      },
      (dbPath) => {
        const conversations = readHermesChatConversations(dbPath, { sinceSeconds: 500, limit: 10 });
        expect(
          conversations?.map((entry) => [entry.sessionKey, entry.messageCount, entry.userName]),
        ).toEqual([
          [DM, 1, "Kirby"],
          [THREAD, 8, "Yato"],
        ]);
        expect(readHermesChatConversations(dbPath, { sinceSeconds: 500, limit: 1 })).toHaveLength(
          1,
        );
      },
    );
  });
});

describe("cleanHermesGatewayUserText", () => {
  it("keeps what the person wrote when there is no gateway context", () => {
    expect(cleanHermesGatewayUserText("  plain words ")).toEqual({
      text: "plain words",
      replyTo: null,
    });
    expect(cleanHermesGatewayUserText('[Replying to your previous message: "a\nb"]\n\nok')).toEqual(
      { text: "ok", replyTo: "a b" },
    );
  });
});
