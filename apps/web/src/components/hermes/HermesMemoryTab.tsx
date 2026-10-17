/** Hermes's built-in notes remain available independently of the optional
 * Hindsight bank. Each section owns its loading and failure state. */
import {
  describeHindsightEmptyList,
  describeHindsightStats,
  describeHindsightUnavailable,
  formatHindsightMemoryAge,
  HINDSIGHT_PATHWAY_FILTERS,
  HINDSIGHT_PATHWAY_LABELS,
  HINDSIGHT_STATS_PENDING_LABEL,
} from "@t3tools/client-runtime/state/hindsight";
import type { HindsightBankId, HindsightBankStats, HindsightMemory } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlugZapIcon, RefreshCwIcon, SettingsIcon, SparklesIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useHindsightMemory } from "../../state/hindsight";
import { HermesNativeMemorySection } from "./HermesNativeMemorySection";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function MemoryRow({ memory }: { readonly memory: HindsightMemory }) {
  const when = formatHindsightMemoryAge(memory.rememberedAt);
  return (
    <li className="rounded-lg border border-border/60 px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded-full bg-muted px-2 py-0.5 font-medium">
          {HINDSIGHT_PATHWAY_LABELS[memory.pathway]}
        </span>
        {when === null ? null : <span>{when}</span>}
        {memory.confidence === null ? null : (
          <Tooltip>
            <TooltipTrigger render={<span>{Math.round(memory.confidence * 100)}% match</span>} />
            <TooltipPopup side="top">Hindsight&apos;s relevance score for this query</TooltipPopup>
          </Tooltip>
        )}
      </div>
      {memory.title === null ? null : <p className="mt-1 text-sm font-medium">{memory.title}</p>}
      <p className="mt-1 whitespace-pre-wrap break-words text-sm">{memory.text}</p>
      {memory.context === null || memory.context.length === 0 ? null : (
        <p className="mt-1 break-words text-xs text-muted-foreground">{memory.context}</p>
      )}
      {memory.entities.length === 0 ? null : (
        <p className="mt-1 truncate text-xs text-muted-foreground">{memory.entities.join(" · ")}</p>
      )}
    </li>
  );
}

/**
 * How big the bank is, in one line above the search box.
 *
 * Renders nothing at all when the counts could not be read: they decorate the
 * list, and a strip is not worth an error state of its own while the memories
 * underneath it are perfectly readable. Until they land it says so in words —
 * "0 memories" for a bank nobody has counted yet would be a lie.
 */
function MemoryStatsStrip({
  isPending,
  stats,
}: {
  readonly isPending: boolean;
  readonly stats: HindsightBankStats | null;
}) {
  if (stats === null) {
    return isPending ? (
      <p className="text-xs text-muted-foreground">{HINDSIGHT_STATS_PENDING_LABEL}</p>
    ) : null;
  }

  const summary = describeHindsightStats(stats);
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{summary.counts.join(" · ")}</span>
      {summary.breakdown.length === 0 ? null : <span>{summary.breakdown.join(" · ")}</span>}
      {summary.operations.length === 0 ? null : (
        <span className="text-warning">{summary.operations.join(" · ")}</span>
      )}
    </div>
  );
}

/** Shape-matched ghost, so the real list does not shift the layout when it lands. */
function MemoriesGhost() {
  return (
    <ul className="flex flex-col gap-2" aria-hidden>
      {[0, 1, 2].map((index) => (
        <li key={index} className="rounded-lg border border-border/60 px-3 py-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-2 h-4 w-full" />
          <Skeleton className="mt-1 h-4 w-3/5" />
        </li>
      ))}
    </ul>
  );
}

/** The inline note composer behind "Retain a note". */
function RetainNote({
  disabled,
  isRetaining,
  onRetain,
}: {
  readonly disabled: boolean;
  readonly isRetaining: boolean;
  readonly onRetain: (text: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (text.trim().length === 0) return;
    void onRetain(text).then((saved) => {
      if (!saved) return;
      setText("");
      setOpen(false);
    });
  };

  if (!open) {
    return (
      <Button disabled={disabled} onClick={() => setOpen(true)} variant="ghost">
        Retain a note…
      </Button>
    );
  }

  return (
    <form className="flex items-center gap-2" onSubmit={submit}>
      <Input
        autoFocus
        aria-label="Note to remember"
        onChange={(event) => setText(event.target.value)}
        placeholder="Something worth remembering…"
        value={text}
      />
      <Button disabled={isRetaining || text.trim().length === 0} type="submit">
        {isRetaining ? "Saving…" : "Save"}
      </Button>
      <Button
        aria-label="Cancel note"
        onClick={() => {
          setOpen(false);
          setText("");
        }}
        size="icon"
        type="button"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </form>
  );
}

export function HermesMemoryTab() {
  return (
    <div className="flex flex-col gap-6">
      <HermesNativeMemorySection />
      <section
        aria-label="Hindsight memory"
        className="flex flex-col gap-3 border-t border-border/60 pt-4"
      >
        <h2 className="text-sm font-semibold">Hindsight</h2>
        <HindsightMemorySection />
      </section>
    </div>
  );
}

function HindsightMemorySection() {
  const {
    status,
    banks,
    bank,
    pathway,
    submittedQuery,
    memories,
    hasMore,
    stats,
    isStatsPending,
    isPending,
    error,
    reflection,
    isReflecting,
    isRetaining,
    selectBank,
    selectPathway,
    submitQuery,
    clearQuery,
    retry,
    retain,
    reflect,
    dismissReflection,
    enabled,
    environmentId,
  } = useHindsightMemory();
  const navigate = useNavigate();

  const [draft, setDraft] = useState("");

  const onSearch = (event: React.FormEvent) => {
    event.preventDefault();
    submitQuery(draft);
  };

  const onClear = () => {
    setDraft("");
    clearQuery();
  };

  const unavailable = describeHindsightUnavailable(status, { enabled });

  if (status?.availability === "notConfigured") {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-xs text-muted-foreground">
          Hindsight is optional and adds searchable, long-term recall. Configure it in Memory
          settings to use it alongside native Hermes memory.
        </p>
        <Button
          onClick={() =>
            void navigate({
              to: "/settings/integrations",
              search: environmentId === null ? {} : { machine: environmentId },
              hash: "memory",
            })
          }
          variant="outline"
        >
          <SettingsIcon />
          Memory settings
        </Button>
      </div>
    );
  }

  if (unavailable !== null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{unavailable.title}</EmptyTitle>
          <EmptyDescription>{unavailable.description}</EmptyDescription>
        </EmptyHeader>
        {unavailable.retryable ? (
          <Button onClick={retry} variant="ghost">
            <PlugZapIcon />
            Try again
          </Button>
        ) : null}
      </Empty>
    );
  }

  if (error !== null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Hindsight is unavailable</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
        <Button onClick={retry} variant="ghost">
          <RefreshCwIcon />
          Try again
        </Button>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <MemoryStatsStrip isPending={isStatsPending} stats={stats} />

      <form className="flex items-center gap-2" onSubmit={onSearch}>
        <Input
          aria-label="Search memories"
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Recall something…"
          value={draft}
        />
        <Button type="submit">Recall</Button>
        {submittedQuery.length === 0 ? null : (
          <Button aria-label="Clear search" onClick={onClear} size="icon" variant="ghost">
            <XIcon />
          </Button>
        )}
      </form>

      <div className="flex flex-wrap items-center gap-1">
        {HINDSIGHT_PATHWAY_FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            aria-pressed={pathway === filter.value}
            onClick={() => selectPathway(filter.value)}
            className={cn(
              "inline-flex items-center rounded-full px-2.5 py-1 text-xs transition-colors",
              pathway === filter.value
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {filter.label}
          </button>
        ))}

        {/* One bank needs no picker — it would be a select with a single option. */}
        {banks.length > 1 ? (
          <select
            aria-label="Memory bank"
            className="ml-auto rounded-md border border-border/60 bg-transparent px-2 py-1 text-xs"
            onChange={(event) => selectBank(event.target.value as HindsightBankId)}
            value={bank ?? ""}
          >
            {banks.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name ?? candidate.id}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {reflection === null ? null : (
        <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm">{reflection}</p>
            <Button
              aria-label="Dismiss reflection"
              onClick={dismissReflection}
              size="icon"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </div>
        </div>
      )}

      {isPending ? (
        <MemoriesGhost />
      ) : memories.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{describeHindsightEmptyList(submittedQuery).title}</EmptyTitle>
            <EmptyDescription>
              {describeHindsightEmptyList(submittedQuery).description}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {memories.map((memory) => (
              <MemoryRow key={`${memory.pathway}:${memory.id}`} memory={memory} />
            ))}
          </ul>
          {hasMore ? (
            <p className="text-xs text-muted-foreground">
              Showing the most recent {memories.length}. Narrow it with a search or a filter.
            </p>
          ) : null}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
        <RetainNote disabled={bank === null} isRetaining={isRetaining} onRetain={retain} />
        <Button disabled={bank === null || isReflecting} onClick={reflect} variant="ghost">
          <SparklesIcon />
          {isReflecting ? "Reflecting…" : "Reflect now"}
        </Button>
      </div>
    </div>
  );
}
