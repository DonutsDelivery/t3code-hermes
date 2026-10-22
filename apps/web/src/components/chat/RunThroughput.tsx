import type { ScopedThreadRef } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import { formatContextWindowTokens } from "~/lib/contextWindow";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

/**
 * The running turn's output rate, pushed by the server a few times a second
 * while the model generates and cleared when the turn ends. Both readers share
 * one subscription, and only they re-render on a push.
 */
function useRunThroughput(threadRef: ScopedThreadRef) {
  return useEnvironmentQuery(
    orchestrationEnvironment.v2.runThroughput({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  ).data;
}

function formatTokensPerSecond(tokensPerSecond: number | null): string {
  return tokensPerSecond === null ? "— tok/s" : `${Math.round(tokensPerSecond)} tok/s`;
}

/** Composer footer chip beside the context ring; dims while the model is in a tool call. */
export function RunThroughputChip({ threadRef }: { threadRef: ScopedThreadRef }) {
  const throughput = useRunThroughput(threadRef);
  if (!throughput) return null;
  return (
    <span
      data-idle={throughput.idle ? "" : undefined}
      className="shrink-0 whitespace-nowrap font-mono text-2xs text-muted-foreground tabular-nums data-idle:opacity-60"
    >
      {formatTokensPerSecond(throughput.tokensPerSecond)}
    </span>
  );
}

const CHART_WIDTH = 100;
const CHART_HEIGHT = 36;
/** Keeps the line's peaks and troughs off the chart's edges. */
const CHART_INSET = 3;

/** Throughput section of the context ring's popover: live rate, chart, and the turn so far. */
export function RunThroughputSection({ threadRef }: { threadRef: ScopedThreadRef }) {
  const throughput = useRunThroughput(threadRef);
  if (!throughput) return null;
  const line = chartLine(throughput.history);
  const rows = [
    ["Average this turn", formatRate(throughput.averageTokensPerSecond)],
    ["Peak", formatRate(throughput.peakTokensPerSecond)],
    [
      "Output tokens",
      throughput.outputTokens > 0 ? formatContextWindowTokens(throughput.outputTokens) : "—",
    ],
    // Only providers that mark their responses report it.
    ...(throughput.timeToFirstTokenMs === undefined
      ? []
      : [["Average time to first token", formatDuration(throughput.timeToFirstTokenMs)] as const]),
  ] as const;
  return (
    <div className="flex flex-col border-t border-border/60 pt-2">
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">Throughput</div>
        <div className="font-mono text-secondary-label text-2xs tabular-nums">
          {formatTokensPerSecond(throughput.tokensPerSecond)}
        </div>
      </div>
      <svg
        aria-hidden
        className="mt-1.5 mb-0.5 h-9 w-full text-muted-foreground"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
      >
        <line
          x1={0}
          y1={CHART_HEIGHT / 2}
          x2={CHART_WIDTH}
          y2={CHART_HEIGHT / 2}
          className="stroke-border"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {line ? (
          <>
            <path
              d={`${line} L${CHART_WIDTH},${CHART_HEIGHT} L0,${CHART_HEIGHT} Z`}
              fill="currentColor"
              opacity={0.1}
            />
            <path
              d={line}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        ) : null}
      </svg>
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-3 py-0.5 text-2xs">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-mono text-secondary-label tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  );
}

function formatRate(tokensPerSecond: number | null): string {
  return tokensPerSecond === null ? "—" : formatTokensPerSecond(tokensPerSecond);
}

/** The run's rates spread across the chart's width, oldest at the left; null before two exist. */
function chartLine(history: ReadonlyArray<number>): string | null {
  if (history.length < 2) return null;
  const max = Math.max(...history, 1);
  const stepX = CHART_WIDTH / (history.length - 1);
  return history
    .map((value, index) => {
      const x = (stepX * index).toFixed(1);
      const y = (
        CHART_HEIGHT -
        CHART_INSET -
        (value / max) * (CHART_HEIGHT - 2 * CHART_INSET)
      ).toFixed(1);
      return `${index === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");
}
