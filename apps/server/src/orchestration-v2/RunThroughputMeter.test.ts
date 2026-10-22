import { describe, expect, it } from "@effect/vitest";
import { MessageId, ProviderDriverKind, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import {
  make,
  makeRunMeterState,
  observeRunOutput,
  readRunMeter,
  type RunMeterState,
} from "./RunThroughputMeter.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");
const at = DateTime.makeUnsafe("2026-10-05T00:00:00.000Z");

function progress(chars: number): ProviderAdapterV2Event {
  return {
    type: "output.progress",
    driver: ProviderDriverKind.make("claudeAgent"),
    threadId,
    runId,
    chars,
  };
}

function measured(tokens: number, durationMs: number): ProviderAdapterV2Event {
  return {
    type: "output.measured",
    driver: ProviderDriverKind.make("claudeAgent"),
    threadId,
    runId,
    tokens,
    durationMs,
  };
}

function assistantText(
  chars: number,
  options: { readonly runId?: RunId; readonly threadId?: ThreadId } = {},
): ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver: ProviderDriverKind.make("hermes"),
    turnItem: {
      id: TurnItemId.make("item-1"),
      threadId: options.threadId ?? threadId,
      runId: options.runId ?? runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: null,
      startedAt: at,
      completedAt: null,
      updatedAt: at,
      type: "assistant_message",
      messageId: MessageId.make("message-1"),
      text: "x".repeat(chars),
      streaming: true,
    },
  };
}

function toolCall(): ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver: ProviderDriverKind.make("hermes"),
    turnItem: {
      id: TurnItemId.make("tool-1"),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 2,
      status: "running",
      title: null,
      startedAt: at,
      completedAt: null,
      updatedAt: at,
      type: "command_execution",
      input: "sleep 4",
    },
  };
}

/** Feeds `[atMs, event]` pairs in order. */
function feed(
  meter: RunMeterState,
  events: ReadonlyArray<readonly [number, ProviderAdapterV2Event]>,
) {
  for (const [atMs, event] of events) observeRunOutput(meter, event, atMs);
}

describe("RunThroughputMeter", () => {
  it("charges each delta with the time since the previous one", () => {
    const meter = makeRunMeterState(threadId, runId);
    expect(readRunMeter(meter, 0)).toBeNull();
    // 400 chars = 100 tokens every 100 ms; the run's first output is uncharged.
    feed(meter, [
      [0, progress(400)],
      [100, progress(400)],
      [200, progress(400)],
      [300, progress(400)],
    ]);
    expect(readRunMeter(meter, 300)).toMatchObject({ runId, tokensPerSecond: 1000, idle: false });
  });

  it("does not charge output with time the model spent in a tool call", () => {
    const meter = makeRunMeterState(threadId, runId);
    feed(meter, [
      [0, progress(400)],
      [100, progress(400)],
      [200, progress(400)],
      [300, progress(400)],
      [350, toolCall()],
    ]);
    // While the tool runs, the rate holds, marked idle.
    expect(readRunMeter(meter, 3_000)).toMatchObject({ runId, tokensPerSecond: 1000, idle: true });
    // The tool finishes at 5 s; the next output took 200 ms after it, then the model slows down.
    feed(meter, [
      [5_000, toolCall()],
      [5_200, progress(400)],
      [5_400, progress(200)],
      [5_600, progress(200)],
    ]);
    // (100 + 50 + 50 tokens) over 600 ms.
    expect(readRunMeter(meter, 5_600)?.tokensPerSecond).toBeCloseTo(333.33);
  });

  it("charges the few characters that end a hidden-reasoning silence with half a second at most", () => {
    const meter = makeRunMeterState(threadId, runId);
    feed(meter, [
      [0, toolCall()],
      // 5 s of hidden reasoning, then the answer streams.
      [5_000, progress(40)],
      [5_100, progress(400)],
      [5_200, progress(400)],
    ]);
    // (10 + 100 + 100 tokens) over 0.7 s, not over 5.2 s.
    expect(readRunMeter(meter, 5_200)?.tokensPerSecond).toBe(300);
  });

  it("spreads a held-back flush over its silence instead of reading it as a spike", () => {
    const meter = makeRunMeterState(threadId, runId);
    feed(meter, [
      [0, toolCall()],
      [500, progress(200)],
      // Claude after summarized thinking: 3 s of nothing, then 800 tokens at once.
      [3_500, progress(3_200)],
    ]);
    // (50 + 800 tokens) over 3.5 s.
    expect(readRunMeter(meter, 3_500)?.tokensPerSecond).toBeCloseTo(242.86);
  });

  it("ignores text items from the start once an adapter announces it reports its own output", () => {
    const meter = makeRunMeterState(threadId, runId);
    feed(meter, [
      // Claude announces each response before streaming the thinking summary as items.
      [0, progress(0)],
      [100, assistantText(400)],
      [200, assistantText(800)],
    ]);
    expect(readRunMeter(meter, 200)).toMatchObject({ tokensPerSecond: null, outputTokens: 0 });
  });

  it("keeps a response generating at the rate before it while its output is held back", () => {
    const meter = makeRunMeterState(threadId, runId, { inheritedRate: 90 });
    feed(meter, [[0, progress(0)]]);
    // Hidden thinking: nothing streams, but the response has not ended.
    expect(readRunMeter(meter, 12_000)).toMatchObject({ tokensPerSecond: 90, idle: false });
    feed(meter, [[15_000, measured(1_395, 15_000)]]);
    expect(readRunMeter(meter, 15_000)).toMatchObject({ tokensPerSecond: 93, idle: false });
    expect(readRunMeter(meter, 17_000)?.idle).toBe(true);
  });

  it("counts a response too short to time without letting it move the rate or peak", () => {
    const meter = makeRunMeterState(threadId, runId);
    feed(meter, [
      [0, progress(0)],
      [15_000, measured(1_395, 15_000)],
      [15_100, toolCall()],
      [20_000, toolCall()],
      // A tool call whose start arrived with its first tokens already generated.
      [21_000, progress(0)],
      [21_050, progress(100)],
      [21_150, progress(100)],
      [21_250, progress(100)],
      [21_350, progress(100)],
    ]);
    // Its text alone reads 250 tokens per second.
    expect(readRunMeter(meter, 21_350)?.tokensPerSecond).toBe(250);
    feed(meter, [[21_400, measured(78, 400)]]);
    expect(readRunMeter(meter, 21_400)).toMatchObject({
      tokensPerSecond: 93,
      peakTokensPerSecond: 93,
      averageTokensPerSecond: 93,
      outputTokens: 1_473,
    });
  });

  it("averages each response's wait from its request as the time to first token", () => {
    const meter = makeRunMeterState(threadId, runId, { startedAtMs: 0 });
    feed(meter, [
      // The prompt waits 3 s for the first response.
      [3_000, progress(0)],
      [6_000, measured(300, 3_000)],
      // A tool runs, then its result waits 1 s for the next response.
      [6_100, toolCall()],
      [7_000, toolCall()],
      [8_000, progress(0)],
    ]);
    expect(readRunMeter(meter, 8_000)?.timeToFirstTokenMs).toBe(2_000);
  });

  it("keeps the run's average, peak, and output tokens, corrected by exact usage", () => {
    const meter = makeRunMeterState(threadId, runId);
    feed(meter, [
      // A fast first response: 400 tokens over 2 s once measured.
      [0, progress(400)],
      [100, progress(400)],
      [200, progress(400)],
      [300, progress(400)],
      [2_000, measured(400, 2_000)],
      [2_100, toolCall()],
      // A slower second response, estimated only: 50 tokens per 100 ms.
      [5_000, toolCall()],
      [5_100, progress(200)],
      [5_200, progress(200)],
      [5_300, progress(200)],
    ]);
    expect(readRunMeter(meter, 5_300)).toMatchObject({
      // (400 + 150) tokens over (2 + 0.3) s.
      averageTokensPerSecond: expect.closeTo(239.13),
      // The estimate during the first response peaked at 1,000 before usage corrected it.
      peakTokensPerSecond: 1000,
      outputTokens: 550,
    });
  });

  it("waits for enough charged time before rating, so a tool call's input landing at once is no spike", () => {
    const meter = makeRunMeterState(threadId, runId);
    feed(meter, [
      [0, toolCall()],
      // 80 chars of tool input within 20 ms.
      [10, progress(40)],
      [20, progress(40)],
    ]);
    expect(readRunMeter(meter, 20)?.tokensPerSecond).toBeNull();
  });

  it("replaces the estimate for a response with its exact usage once it ends", () => {
    const meter = makeRunMeterState(threadId, runId);
    feed(meter, [
      [0, toolCall()],
      // Visible text the estimate saw; the hidden thinking it could not.
      [1_000, progress(400)],
      [2_000, progress(400)],
      // The response ran 2.5 s and generated 1,000 tokens.
      [2_500, measured(1_000, 2_500)],
    ]);
    expect(readRunMeter(meter, 2_500)?.tokensPerSecond).toBe(400);
  });

  it("measures streaming adapters by the growth of the run's text items", () => {
    const meter = makeRunMeterState(threadId, runId);
    feed(meter, [
      [0, assistantText(40)],
      [100, assistantText(440)],
      // Another run's or another thread's output is not this run's.
      [150, assistantText(10_000, { runId: RunId.make("run-0") })],
      [150, assistantText(10_000, { threadId: ThreadId.make("child") })],
      [200, assistantText(840)],
      [300, assistantText(1_240)],
    ]);
    expect(readRunMeter(meter, 300)?.tokensPerSecond).toBe(1000);
  });

  it("ignores text items once the adapter reports its own output", () => {
    const meter = makeRunMeterState(threadId, runId);
    feed(meter, [
      [0, progress(400)],
      // Claude's finished block repeats text the deltas already counted.
      [50, assistantText(4_000)],
      [100, progress(400)],
      [200, progress(400)],
      [300, progress(400)],
    ]);
    expect(readRunMeter(meter, 300)?.tokensPerSecond).toBe(1000);
  });

  it.effect("starts a thread's next run idle at the rate its previous run ended with", () =>
    Effect.gen(function* () {
      const meter = yield* make;
      const first = { threadId, runId };
      for (const chars of [400, 400, 400, 400]) {
        yield* meter.observe(first, progress(chars));
        yield* TestClock.adjust(100);
      }
      yield* meter.endRun(first);

      const next = { threadId, runId: RunId.make("run-2") };
      yield* meter.startRun(next);
      const [sent] = yield* meter.stream(threadId).pipe(Stream.take(1), Stream.runCollect);
      // The new run's own totals start empty.
      expect(sent).toEqual({
        runId: next.runId,
        tokensPerSecond: 1000,
        idle: true,
        averageTokensPerSecond: null,
        peakTokensPerSecond: null,
        outputTokens: 0,
      });

      // Its first response starts 1.5 s after the prompt.
      yield* TestClock.adjust(1_500);
      yield* meter.observe(next, progress(0));
      const [responding] = yield* meter.stream(threadId).pipe(Stream.take(1), Stream.runCollect);
      expect(responding).toMatchObject({
        tokensPerSecond: 1000,
        idle: false,
        timeToFirstTokenMs: 1_500,
      });
    }),
  );

  it.effect("ignores a finished run's late events instead of replacing the next run's meter", () =>
    Effect.gen(function* () {
      const meter = yield* make;
      const first = { threadId, runId };
      const next = { threadId, runId: RunId.make("run-2") };
      yield* meter.observe(first, progress(400));
      yield* meter.endRun(first);
      for (const chars of [400, 400, 400, 400]) {
        yield* meter.observe(next, progress(chars));
        yield* TestClock.adjust(100);
      }
      // Background work the first run started reports after the next run began.
      yield* meter.observe(first, progress(4_000));

      const [current] = yield* meter.stream(threadId).pipe(Stream.take(1), Stream.runCollect);
      expect(current).toMatchObject({ runId: next.runId, outputTokens: 400 });
    }),
  );

  it.effect(
    "pushes the rate while the run generates, once more when it idles, and null when it ends",
    () =>
      Effect.gen(function* () {
        const meter = yield* make;
        const run = { threadId, runId };
        const subscribed = yield* Deferred.make<void>();
        const collected = yield* meter.stream(threadId).pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.take(5),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(subscribed);

        yield* meter.observe(run, progress(400));
        // The 250 ms tick reports output without enough charged time to rate yet.
        yield* TestClock.adjust(400);
        yield* meter.observe(run, progress(1_600));
        yield* TestClock.adjust(100);
        yield* Effect.yieldNow;
        // Output stopped at 400 ms; a tick reports idle once the pause outlasts 1.5 s.
        yield* TestClock.adjust(2_000);
        yield* Effect.yieldNow;
        yield* meter.endRun(run);

        const pushes = yield* Fiber.join(collected);
        expect(
          pushes.map((push) =>
            push === null ? null : { tokensPerSecond: push.tokensPerSecond, idle: push.idle },
          ),
        ).toEqual([
          null,
          { tokensPerSecond: null, idle: false },
          { tokensPerSecond: 1000, idle: false },
          { tokensPerSecond: 1000, idle: true },
          null,
        ]);
      }),
  );
});
