import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderRuntimeEvent } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("accepts task duration without falsely requiring a token total", () => {
    const event = {
      type: "task.completed",
      eventId: "duration-only",
      provider: "hermes",
      createdAt: "2026-09-29T00:00:00.000Z",
      threadId: "thread",
      turnId: "turn",
      payload: { taskId: "child", status: "completed", typedUsage: { durationMs: 2500 } },
    };
    expect(decodeRuntimeEvent(event)).toMatchObject({
      payload: { typedUsage: { durationMs: 2500 } },
    });
    expect(() =>
      decodeRuntimeEvent({
        ...event,
        payload: { ...event.payload, typedUsage: { totalTokens: -1 } },
      }),
    ).toThrow();
  });
});
