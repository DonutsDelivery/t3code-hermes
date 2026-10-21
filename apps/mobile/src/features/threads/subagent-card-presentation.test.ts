import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { subagentCardElapsed } from "./subagent-card-presentation";

describe("subagent card", () => {
  const start = DateTime.makeUnsafe("2026-09-21T12:00:00Z");
  const end = DateTime.makeUnsafe("2026-09-21T12:01:00Z");
  const later = DateTime.makeUnsafe("2026-09-21T12:02:00Z");
  const done = { status: "completed" as const, startedAt: start, completedAt: end };

  it("counts live work but never uses a settled agent's age as its duration", () => {
    const unfinished = { ...done, completedAt: null };
    expect(subagentCardElapsed([unfinished], DateTime.toEpochMillis(later))).toBeNull();
    expect(
      subagentCardElapsed([{ ...unfinished, status: "running" }], DateTime.toEpochMillis(later)),
    ).toBe("2m");
    expect(
      subagentCardElapsed([{ ...unfinished, status: "idle" }], DateTime.toEpochMillis(later)),
    ).toBeNull();
    expect(
      subagentCardElapsed([{ ...done, startedAt: null }], DateTime.toEpochMillis(later)),
    ).toBeNull();
  });

  it("shows a lone settled agent's reported duration, not its wait to start", () => {
    const reported = { ...done, usage: { totalTokens: 1_200, durationMs: 2_500 } };
    expect(subagentCardElapsed([reported], DateTime.toEpochMillis(later))).toBe("2.5s");
    // A group still spans wall time; per-child durations cannot be placed in it.
    expect(subagentCardElapsed([reported, done], DateTime.toEpochMillis(later))).toBe("1m");
  });
});
