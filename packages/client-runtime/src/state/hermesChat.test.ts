import type { HermesChatMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeHermesChatTools,
  formatHermesChatAge,
  hermesChatConversationSubtitle,
  hermesChatConversationTitle,
  hermesChatPlatformLabel,
  hermesChatTranscriptItems,
} from "./hermesChat.ts";

const message = (
  id: number,
  role: HermesChatMessage["role"],
  sessionId = "s1",
  toolName: string | null = null,
): HermesChatMessage => ({
  id,
  sessionId,
  role,
  text: `${role} ${id}`,
  replyTo: null,
  toolName,
  timestamp: "2026-10-23T12:00:00.000Z",
});

describe("hermesChatConversationTitle", () => {
  const base = { title: null, userName: "Yato", chatType: "thread" };
  it("names threads by thread, channels by channel and person, and DMs by person", () => {
    expect(
      hermesChatConversationTitle({ ...base, displayName: "Guild / #general / fix my lag" }),
    ).toBe("fix my lag");
    expect(
      hermesChatConversationTitle({ ...base, chatType: "group", displayName: "Guild / #general" }),
    ).toBe("#general · Yato");
    expect(hermesChatConversationTitle({ ...base, chatType: "dm", displayName: null })).toBe(
      "Yato",
    );
  });

  it("skips Hermes's placeholder trigger title", () => {
    expect(
      hermesChatConversationTitle({
        displayName: null,
        title: "[Triggering message id: `1`…",
        userName: null,
        chatType: "thread",
      }),
    ).toBe("Conversation");
  });
});

it("describes the platform and where the conversation lives", () => {
  expect(
    hermesChatConversationSubtitle({
      platform: "discord",
      displayName: "Guild / #general",
      title: "Explore WARP options",
      chatType: "group",
    }),
  ).toBe("Discord · Guild · Explore WARP options");
  expect(hermesChatPlatformLabel("whatsapp_cloud")).toBe("WhatsApp");
  expect(hermesChatPlatformLabel("my_irc")).toBe("My irc");
});

it("formats short ages for list rows", () => {
  const now = Date.parse("2026-10-23T12:00:00.000Z");
  expect(formatHermesChatAge("2026-10-23T11:59:40.000Z", now)).toBe("now");
  expect(formatHermesChatAge("2026-10-23T11:15:00.000Z", now)).toBe("45m");
  expect(formatHermesChatAge("2026-10-22T09:00:00.000Z", now)).toBe("1d");
  expect(formatHermesChatAge("not a date", now)).toBe("");
});

describe("hermesChatTranscriptItems", () => {
  it("collapses tool runs between messages and marks new sessions", () => {
    const items = hermesChatTranscriptItems([
      message(1, "user"),
      message(2, "tool", "s1", "terminal, skill_view"),
      message(3, "tool", "s1", "terminal"),
      message(4, "assistant"),
      message(5, "tool", "s2", "hindsight_retain"),
      message(6, "assistant", "s2"),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "tools",
      "message",
      "session",
      "tools",
      "message",
    ]);
    const tools = items[1];
    expect(tools?.kind === "tools" && tools.toolNames).toEqual(["terminal", "skill_view"]);
    expect(tools?.kind === "tools" && describeHermesChatTools(tools)).toBe(
      "Used terminal, skill_view",
    );
  });
});
