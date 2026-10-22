import type { OrchestrationV2RunThroughput, RunId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";

/**
 * Live output-token throughput of each thread's running turn, measured where
 * the provider's raw deltas arrive, before the paragraph buffer holds text
 * back from clients. Tokens are chars ÷ 4; no provider reports a per-delta
 * token count.
 *
 * Each delta is charged with the time since the previous output, or since the
 * run's last tool or approval activity, so time spent in tools never dilutes
 * the rate. A silence before output is charged too, but only as long as the
 * output could plausibly have taken: a held-back flush (Claude's answer after
 * summarized thinking, an ACP agent's whole reply) spreads over its silence
 * instead of reading as a thousand tokens per second, while the few characters
 * that end a long hidden-reasoning silence are not charged with all of it and
 * read as a crawl. The first output after the prompt is uncharged, keeping
 * time to first token out. The rate is total tokens over total charged time
 * across a short window.
 *
 * Adapters whose provider reports a response's exact output (Claude's message
 * usage, hidden thinking included) send it when the response ends, replacing
 * the estimate for its duration, so the rate held through the next tool call
 * is the real one. The run's totals (average, output tokens) are corrected the
 * same way. Such adapters also mark each response's start: until its usage
 * arrives the model is generating, however long its output is held back, and
 * the wait since the run's request (its prompt, a tool's result) is the
 * response's time to first token.
 *
 * Memory only, one meter per thread for its latest run. Clients subscribe per
 * thread and get a push at most every {@link TICK_MS} while the run generates,
 * then one idle push holding the last rate; nothing is sent while it is idle.
 *
 * @module orchestration-v2/RunThroughputMeter
 */

const CHARS_PER_TOKEN = 4;
/** How much recent output the rate averages over; models stream in uneven bursts. */
const WINDOW_MS = 4_000;
/** No output for this long reads as idle (a tool call, hidden thinking). */
const IDLE_AFTER_MS = 1_500;
/** Less charged time than this is too little to rate, like a tool call's input landing at once. */
const MIN_CHARGED_MS = 250;
/** A silence before output is charged at most this long, or longer for output that fills it. */
const MAX_SILENCE_CHARGE_MS = 500;
/** Slowest generation a silence is credited with: longer is hidden work, not this output. */
const MIN_PLAUSIBLE_TOKENS_PER_SECOND = 50;
/**
 * A measured response shorter than this cannot be timed: Claude's start
 * arrives with the first tokens already generated, so a short tool call reads
 * several times faster than the model runs.
 */
const MIN_MEASURED_MS = 2_000;
/** Push cadence while any run is generating. */
const TICK_MS = 250;

interface RunTotals {
  outputTokens: number;
  /** Tokens of output that was charged generation time, and that time. */
  chargedTokens: number;
  chargedMs: number;
}

const emptyTotals = (): RunTotals => ({ outputTokens: 0, chargedTokens: 0, chargedMs: 0 });

interface OutputSample {
  readonly atMs: number;
  readonly tokens: number;
  /** Generation time charged to this output; null for the run's first output. */
  readonly spanMs: number | null;
}

export interface RunMeterState {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  samples: OutputSample[];
  lastOutputAtMs: number | null;
  /** When the model last demonstrably started or continued generating. */
  referenceAtMs: number | null;
  rate: number | null;
  /** Highest rate this run measured; an inherited rate does not count. */
  peak: number | null;
  /** Run totals confirmed by `output.measured`. */
  exact: RunTotals;
  /** Run totals estimated since the last `output.measured`. */
  estimated: RunTotals;
  /** Set by the first `output.progress` or `output.measured`: the adapter reports all output itself. */
  reportsOwnOutput: boolean;
  readonly itemTextLengths: Map<string, number>;
  /** When the run last asked the model for a response, until one starts. */
  requestedAtMs: number | null;
  /** The rate and peak as a marked response started, kept until its usage arrives. */
  openResponse: { readonly rate: number | null; readonly peak: number | null } | null;
  /** Waits from request to response start, for the run's average time to first token. */
  readonly firstTokenWaits: { totalMs: number; count: number };
}

export function makeRunMeterState(
  threadId: ThreadId,
  runId: RunId,
  options: {
    /** The thread's previous run's rate, shown idle until this run measures its own. */
    readonly inheritedRate?: number | null;
    /** When the run sent its prompt. */
    readonly startedAtMs?: number | null;
  } = {},
): RunMeterState {
  return {
    threadId,
    runId,
    samples: [],
    lastOutputAtMs: null,
    referenceAtMs: null,
    rate: options.inheritedRate ?? null,
    peak: null,
    exact: emptyTotals(),
    estimated: emptyTotals(),
    reportsOwnOutput: false,
    itemTextLengths: new Map(),
    requestedAtMs: options.startedAtMs ?? null,
    openResponse: null,
    firstTokenWaits: { totalMs: 0, count: 0 },
  };
}

/**
 * Characters of new model output an event carries for this run, or "activity"
 * when it shows the model busy elsewhere (a tool call, an approval).
 */
function classify(
  meter: RunMeterState,
  event: Exclude<ProviderAdapterV2Event, { readonly type: "output.measured" }>,
): number | "activity" {
  if (event.type === "output.progress") {
    meter.reportsOwnOutput = true;
    return event.chars;
  }
  if (event.type !== "turn_item.updated") return 0;
  const item = event.turnItem;
  if (item.threadId !== meter.threadId || item.runId !== meter.runId) return 0;
  // The prompt starts the run, not generation.
  if (item.type === "user_message") return 0;
  if (item.type !== "assistant_message" && item.type !== "reasoning") return "activity";
  if (meter.reportsOwnOutput) return 0;
  // Adapters send each item's whole text so far; the growth is the new output.
  const seen = meter.itemTextLengths.get(item.id) ?? 0;
  meter.itemTextLengths.set(item.id, item.text.length);
  return item.text.length - seen;
}

/** Feeds one routed provider event; returns whether the run is now generating. */
export function observeRunOutput(
  meter: RunMeterState,
  event: ProviderAdapterV2Event,
  nowMs: number,
): boolean {
  if (event.type === "output.measured") return measureResponse(meter, event, nowMs);
  if (event.type === "output.progress" && event.chars === 0) {
    meter.reportsOwnOutput = true;
    openResponse(meter, nowMs);
    return true;
  }
  const chars = classify(meter, event);
  if (chars === "activity") {
    meter.referenceAtMs = nowMs;
    meter.requestedAtMs = nowMs;
    return false;
  }
  if (chars <= 0) return false;
  const reference = meter.referenceAtMs;
  const tokens = chars / CHARS_PER_TOKEN;
  const plausibleMs = Math.max(
    MAX_SILENCE_CHARGE_MS,
    (tokens / MIN_PLAUSIBLE_TOKENS_PER_SECOND) * 1000,
  );
  const spanMs = reference === null ? null : Math.min(nowMs - reference, plausibleMs);
  addToTotals(meter.estimated, tokens, spanMs);
  recordOutput(meter, nowMs, { atMs: nowMs, tokens, spanMs });
  return true;
}

function openResponse(meter: RunMeterState, nowMs: number): void {
  if (meter.requestedAtMs !== null) {
    meter.firstTokenWaits.totalMs += nowMs - meter.requestedAtMs;
    meter.firstTokenWaits.count += 1;
  }
  meter.requestedAtMs = null;
  meter.openResponse = { rate: meter.rate, peak: meter.peak };
  // Its first output lands with whatever was generated before the start
  // arrived, so, like the run's first output, it is uncharged.
  meter.referenceAtMs = null;
}

function measureResponse(
  meter: RunMeterState,
  event: Extract<ProviderAdapterV2Event, { readonly type: "output.measured" }>,
  nowMs: number,
): boolean {
  meter.reportsOwnOutput = true;
  const opened = meter.openResponse;
  meter.openResponse = null;
  // The earliest the run can ask for its next response.
  meter.requestedAtMs = nowMs;
  // The exact count supersedes what was estimated while the response streamed.
  const startedAtMs = nowMs - event.durationMs;
  meter.samples = meter.samples.filter((sample) => sample.atMs < startedAtMs);
  meter.estimated = emptyTotals();
  if (event.durationMs < MIN_MEASURED_MS) {
    // Its estimate was as untimeable as its usage, so the response's tokens
    // count but the rate and peak stay what they were before it.
    addToTotals(meter.exact, event.tokens, null);
    if (opened !== null) {
      meter.rate = opened.rate;
      meter.peak = opened.peak;
    }
    if (event.tokens === 0) return false;
    meter.lastOutputAtMs = nowMs;
    return true;
  }
  if (event.tokens === 0) return false;
  addToTotals(meter.exact, event.tokens, event.durationMs);
  recordOutput(meter, nowMs, { atMs: nowMs, tokens: event.tokens, spanMs: event.durationMs });
  return true;
}

function addToTotals(totals: RunTotals, tokens: number, spanMs: number | null): void {
  totals.outputTokens += tokens;
  if (spanMs === null) return;
  totals.chargedTokens += tokens;
  totals.chargedMs += spanMs;
}

function recordOutput(meter: RunMeterState, nowMs: number, sample: OutputSample): void {
  meter.referenceAtMs = nowMs;
  meter.lastOutputAtMs = nowMs;
  meter.samples = meter.samples.filter((existing) => nowMs - existing.atMs <= WINDOW_MS);
  meter.samples.push(sample);
  let tokens = 0;
  let chargedMs = 0;
  for (const existing of meter.samples) {
    if (existing.spanMs === null) continue;
    tokens += existing.tokens;
    chargedMs += existing.spanMs;
  }
  if (chargedMs < MIN_CHARGED_MS) return;
  meter.rate = (tokens / chargedMs) * 1000;
  meter.peak = Math.max(meter.peak ?? 0, meter.rate);
}

/** The run's throughput, or null before it has produced output or inherited a rate. */
export function readRunMeter(
  meter: RunMeterState,
  nowMs: number,
): OrchestrationV2RunThroughput | null {
  if (meter.lastOutputAtMs === null && meter.rate === null && meter.openResponse === null) {
    return null;
  }
  const chargedTokens = meter.exact.chargedTokens + meter.estimated.chargedTokens;
  const chargedMs = meter.exact.chargedMs + meter.estimated.chargedMs;
  const waits = meter.firstTokenWaits;
  return {
    runId: meter.runId,
    tokensPerSecond: meter.rate,
    idle:
      meter.openResponse === null &&
      (meter.lastOutputAtMs === null || nowMs - meter.lastOutputAtMs > IDLE_AFTER_MS),
    averageTokensPerSecond: chargedMs >= MIN_CHARGED_MS ? (chargedTokens / chargedMs) * 1000 : null,
    peakTokensPerSecond: meter.peak,
    outputTokens: Math.round(meter.exact.outputTokens + meter.estimated.outputTokens),
    ...(waits.count === 0 ? {} : { timeToFirstTokenMs: Math.round(waits.totalMs / waits.count) }),
  };
}

export interface RunThroughputRunRef {
  readonly threadId: ThreadId;
  readonly runId: RunId;
}

export interface RunThroughputMeterShape {
  /** Marks the run sending its prompt, the request its first response answers. */
  readonly startRun: (run: RunThroughputRunRef) => Effect.Effect<void>;
  /** Feeds a provider event already routed to the run. */
  readonly observe: (
    run: RunThroughputRunRef,
    event: ProviderAdapterV2Event,
  ) => Effect.Effect<void>;
  readonly endRun: (run: RunThroughputRunRef) => Effect.Effect<void>;
  /** Emits the thread's current throughput (or null) first, then every change. */
  readonly stream: (threadId: ThreadId) => Stream.Stream<OrchestrationV2RunThroughput | null>;
}

/** No-op by default so test layers that never stream to clients need not provide one. */
export class RunThroughputMeter extends Context.Reference<RunThroughputMeterShape>(
  "t3-hermes/orchestration-v2/RunThroughputMeter",
  {
    defaultValue: () => ({
      startRun: () => Effect.void,
      observe: () => Effect.void,
      endRun: () => Effect.void,
      stream: () => Stream.make(null),
    }),
  },
) {}

/** Threads whose last rate is kept for their next run. */
const MAX_REMEMBERED_THREADS = 256;
/** Ended runs remembered so their late events are ignored; far more than ever overlap. */
const MAX_ENDED_RUNS = 1_024;

interface ThroughputChange {
  readonly threadId: ThreadId;
  readonly value: OrchestrationV2RunThroughput | null;
}

export const make = Effect.gen(function* () {
  const meters = new Map<ThreadId, RunMeterState>();
  const published = new Map<ThreadId, OrchestrationV2RunThroughput>();
  // A run that only thinks before answering (Claude holds its text back) has
  // nothing to show until it ends, so it starts from the thread's last rate.
  const lastRateByThread = new Map<ThreadId, number>();
  // A run's subscription can outlive its terminal event while background work
  // it started still reports. Those late events must not displace the meter
  // of the thread's next run.
  const endedRuns = new Set<RunId>();
  const changes = yield* PubSub.unbounded<ThroughputChange>();
  let ticking = false;

  // Runs only while some run is generating, then stops itself.
  const tick: Effect.Effect<void> = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(TICK_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      let generating = false;
      for (const meter of meters.values()) {
        const value = readRunMeter(meter, nowMs);
        if (value === null) continue;
        if (!value.idle) generating = true;
        const previous = published.get(meter.threadId);
        if (
          previous?.runId === value.runId &&
          previous.idle === value.idle &&
          previous.tokensPerSecond === value.tokensPerSecond &&
          previous.outputTokens === value.outputTokens &&
          previous.timeToFirstTokenMs === value.timeToFirstTokenMs
        ) {
          continue;
        }
        yield* publish(meter.threadId, value);
      }
      if (!generating) {
        ticking = false;
        return;
      }
    }
  });

  const publish = (threadId: ThreadId, value: OrchestrationV2RunThroughput | null) => {
    if (value === null) published.delete(threadId);
    else published.set(threadId, value);
    return PubSub.publish(changes, { threadId, value });
  };

  const meterFor =
    /* Runs for every provider event `observe` takes; avoid a span for each. */
    Effect.fnUntraced(function* (run: RunThroughputRunRef, nowMs: number) {
      const existing = meters.get(run.threadId);
      if (existing?.runId === run.runId) return existing;
      const meter = makeRunMeterState(run.threadId, run.runId, {
        inheritedRate: lastRateByThread.get(run.threadId) ?? null,
      });
      meters.set(run.threadId, meter);
      const inherited = readRunMeter(meter, nowMs);
      if (inherited !== null) yield* publish(run.threadId, inherited);
      return meter;
    });

  const startRun: RunThroughputMeterShape["startRun"] = Effect.fn("RunThroughputMeter.startRun")(
    function* (run) {
      if (endedRuns.has(run.runId)) return;
      const nowMs = yield* Clock.currentTimeMillis;
      const meter = yield* meterFor(run, nowMs);
      meter.requestedAtMs = nowMs;
    },
  );

  const observe: RunThroughputMeterShape["observe"] =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (run, event) {
      if (
        event.type !== "output.progress" &&
        event.type !== "output.measured" &&
        event.type !== "turn_item.updated"
      ) {
        return;
      }
      if (endedRuns.has(run.runId)) return;
      const nowMs = yield* Clock.currentTimeMillis;
      const meter = yield* meterFor(run, nowMs);
      if (!observeRunOutput(meter, event, nowMs) || ticking) return;
      ticking = true;
      yield* Effect.forkDetach(tick);
    });

  const endRun: RunThroughputMeterShape["endRun"] =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (run) {
      if (!endedRuns.has(run.runId)) {
        endedRuns.add(run.runId);
        if (endedRuns.size > MAX_ENDED_RUNS) {
          const oldest = endedRuns.values().next().value;
          if (oldest !== undefined) endedRuns.delete(oldest);
        }
      }
      const meter = meters.get(run.threadId);
      if (meter?.runId !== run.runId) return;
      meters.delete(run.threadId);
      if (meter.rate !== null) {
        lastRateByThread.delete(run.threadId);
        lastRateByThread.set(run.threadId, meter.rate);
        if (lastRateByThread.size > MAX_REMEMBERED_THREADS) {
          const oldest = lastRateByThread.keys().next().value;
          if (oldest !== undefined) lastRateByThread.delete(oldest);
        }
      }
      if (published.has(run.threadId)) yield* publish(run.threadId, null);
    });

  const stream: RunThroughputMeterShape["stream"] = (threadId) =>
    Stream.callback<OrchestrationV2RunThroughput | null>(
      (mailbox) =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const meter = meters.get(threadId);
          Queue.offerUnsafe(
            mailbox,
            meter === undefined ? null : readRunMeter(meter, yield* Clock.currentTimeMillis),
          );
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.runForEach((change) =>
              Effect.sync(() => {
                if (change.threadId === threadId) Queue.offerUnsafe(mailbox, change.value);
              }),
            ),
            Effect.forkScoped,
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );

  return { startRun, observe, endRun, stream } satisfies RunThroughputMeterShape;
});

export const layer = Layer.effect(RunThroughputMeter, make);
