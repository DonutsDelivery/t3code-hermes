/**
 * Everything the Memory tab decides.
 *
 * The tab itself renders rows; this hook owns which bank, which pathway,
 * whether the view is browsing or recalling, and what the two write actions do
 * afterwards. Keeping it here is what lets the component stay a pure function
 * of one object.
 *
 * Two behaviours are worth knowing:
 *
 * - **Searching is submit-on-Enter, not as-you-type.** A recall is a semantic
 *   query against a real service; firing one per keystroke would be both slow
 *   and rude to whatever model backs it.
 * - **Retrying is just asking again.** The environment discards a stale
 *   `offline` verdict on the next read, so the retry button refreshes the same
 *   atoms rather than carrying a flag through the contract.
 *
 * @module state/hindsight
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  HindsightBank,
  HindsightBankId,
  HindsightBankStats,
  HindsightMemory,
  HindsightPathwayFilter,
  HindsightStatus,
} from "@t3tools/contracts";
import {
  describeHindsightRetainResult,
  HINDSIGHT_DEFAULT_REFLECT_QUERY,
} from "@t3tools/client-runtime/state/hindsight";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { useHermesEnvironmentId } from "./hermesCron";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

export interface HindsightMemoryState {
  /** The environment the tab reads from, for pointing at its Memory settings. */
  readonly environmentId: EnvironmentId | null;
  /** `integrations.hindsight.enabled` on that environment. */
  readonly enabled: boolean;
  readonly status: HindsightStatus | null;
  readonly banks: ReadonlyArray<HindsightBank>;
  readonly bank: HindsightBankId | null;
  readonly pathway: HindsightPathwayFilter;
  /** The query the list currently reflects. Empty means the browse view. */
  readonly submittedQuery: string;
  readonly memories: ReadonlyArray<HindsightMemory>;
  readonly hasMore: boolean;
  /**
   * Bank counts, or null when they have not landed or Hindsight could not give
   * them. Never zeroes standing in for "unknown" — see `isStatsPending`.
   */
  readonly stats: HindsightBankStats | null;
  /** True while the counts are still being read for the current bank. */
  readonly isStatsPending: boolean;
  /** True only before the first list lands — never while one is on screen. */
  readonly isPending: boolean;
  /** Transport-level failure. A Hindsight that is merely down is a `status`. */
  readonly error: string | null;
  /** Markdown from the last reflection, until the user dismisses it. */
  readonly reflection: string | null;
  readonly isReflecting: boolean;
  readonly isRetaining: boolean;
}

export interface HindsightMemoryActions {
  readonly selectBank: (bank: HindsightBankId) => void;
  readonly selectPathway: (pathway: HindsightPathwayFilter) => void;
  readonly submitQuery: (query: string) => void;
  readonly clearQuery: () => void;
  readonly retry: () => void;
  readonly retain: (text: string) => Promise<boolean>;
  readonly reflect: () => void;
  readonly dismissReflection: () => void;
}

const hindsightEnabledAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) =>
    environmentId === null
      ? true
      : (get(serverEnvironment.settingsValueAtom(environmentId))?.integrations.hindsight.enabled ??
        true),
  ),
);

export function useHindsightMemory(): HindsightMemoryState & HindsightMemoryActions {
  // Hindsight is configured beside Hermes, so the panel reads both from the
  // same environment rather than defaulting to whichever one opened first.
  const environmentId = useHermesEnvironmentId();
  const enabled = useAtomValue(hindsightEnabledAtom(environmentId));

  const [selectedBank, setSelectedBank] = useState<HindsightBankId | null>(null);
  const selectedBankRef = useRef<HindsightBankId | null>(null);
  const [pathway, setPathway] = useState<HindsightPathwayFilter>("all");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [reflection, setReflection] = useState<string | null>(null);
  const [isReflecting, setIsReflecting] = useState(false);
  const [isRetaining, setIsRetaining] = useState(false);

  const banksQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.hindsightBanks({ environmentId, input: {} }),
  );

  const banks = banksQuery.data?.banks ?? [];
  // The user's pick wins, then the configured default, then the only sensible
  // guess. Falling back to the first bank matters because Hindsight creates one
  // implicitly on the first write, so a fresh install has exactly one.
  const bank =
    selectedBank !== null && banks.some((candidate) => candidate.id === selectedBank)
      ? selectedBank
      : (banksQuery.data?.defaultBank ?? banks[0]?.id ?? null);
  // A reflection that lands after the bank changed belongs to the old bank.
  useEffect(() => {
    selectedBankRef.current = bank;
  }, [bank]);

  const isRecalling = submittedQuery.length > 0;

  // Both atoms are subscribed unconditionally — hooks cannot be conditional —
  // but only one is ever non-null, so only one request is in flight.
  const browseQuery = useEnvironmentQuery(
    environmentId === null || bank === null || isRecalling
      ? null
      : serverEnvironment.hindsightBrowse({ environmentId, input: { bank, pathway } }),
  );
  const recallQuery = useEnvironmentQuery(
    environmentId === null || bank === null || !isRecalling
      ? null
      : serverEnvironment.hindsightRecall({
          environmentId,
          input: { bank, pathway, query: submittedQuery },
        }),
  );

  // Counts belong to the bank, not to the query, so swapping browse for recall
  // leaves this one alone. It re-reads when the bank changes, and after a write.
  const statsQuery = useEnvironmentQuery(
    environmentId === null || bank === null
      ? null
      : serverEnvironment.hindsightStats({ environmentId, input: { bank } }),
  );

  const activeQuery = isRecalling ? recallQuery : browseQuery;
  const memories = activeQuery.data?.memories ?? [];

  // The list's own status outranks the bank list's: it is the more recent read,
  // so it is the one that knows whether Hindsight is still answering.
  const status = activeQuery.data?.status ?? banksQuery.data?.status ?? null;

  const retainCommand = useAtomCommand(serverEnvironment.hindsightRetain);
  const reflectCommand = useAtomCommand(serverEnvironment.hindsightReflect);

  const refreshList = browseQuery.refresh;
  const refreshRecall = recallQuery.refresh;
  const refreshBanks = banksQuery.refresh;
  const refreshStats = statsQuery.refresh;

  const retry = () => {
    refreshBanks();
    refreshList();
    refreshRecall();
    refreshStats();
  };

  const submitQuery = (query: string) => {
    setSubmittedQuery(query.trim());
  };

  const clearQuery = () => setSubmittedQuery("");

  const selectBank = (next: HindsightBankId) => {
    setSelectedBank(next);
    // A reflection is about one bank. Carrying it across would misattribute it.
    setReflection(null);
  };

  const retain = async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (environmentId === null || bank === null || trimmed.length === 0) return false;
    setIsRetaining(true);
    // Atom commands settle into a result instead of rejecting, so cleanup follows the await.
    const result = await retainCommand({ environmentId, input: { bank, text: trimmed } });
    setIsRetaining(false);
    if (result._tag !== "Success") {
      // An interrupted command means the user navigated away, not a failure.
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Note not saved",
          description: "Hindsight did not accept the note.",
        });
      }
      return false;
    }
    toastManager.add({
      type: "success",
      title: "Note saved",
      description: describeHindsightRetainResult(result.value.itemsCount),
    });
    // The new memory is only in the list after a re-read.
    retry();
    return true;
  };

  const reflect = () => {
    if (environmentId === null || bank === null || isReflecting) return;
    setIsReflecting(true);
    const reflectBank = bank;
    const query = submittedQuery.length > 0 ? submittedQuery : HINDSIGHT_DEFAULT_REFLECT_QUERY;
    void reflectCommand({ environmentId, input: { bank, query } })
      .then((result) => {
        if (result._tag !== "Success") {
          if (selectedBankRef.current !== reflectBank) return;
          if (!isAtomCommandInterrupted(result)) {
            toastManager.add({
              type: "error",
              title: "Reflection failed",
              description: "Hindsight could not complete the reflection.",
            });
          }
          return;
        }
        if (selectedBankRef.current !== reflectBank) return;
        setReflection(result.value.text);
        toastManager.add({ type: "success", title: "Reflection ready" });
        // A reflection writes mental models and can consolidate, so the counts
        // the strip is showing are now behind.
        refreshStats();
      })
      .finally(() => setIsReflecting(false));
  };

  const dismissReflection = () => setReflection(null);

  return {
    environmentId,
    enabled,
    status,
    banks,
    bank,
    pathway,
    submittedQuery,
    memories,
    hasMore: activeQuery.data?.hasMore ?? false,
    // A failed stats read answers with `stats: null`, which renders as no
    // strip at all — the list beside it is unaffected either way.
    stats: statsQuery.data?.stats ?? null,
    isStatsPending: bank !== null && statsQuery.data === null && statsQuery.error === null,
    // A list already on screen outranks a refetch: swapping a chip keeps the
    // previous rows readable instead of flashing back to a skeleton.
    isPending: (banksQuery.isPending || activeQuery.isPending) && activeQuery.data === null,
    error: activeQuery.error ?? banksQuery.error,
    reflection,
    isReflecting,
    isRetaining,
    selectBank,
    selectPathway: setPathway,
    submitQuery,
    clearQuery,
    retry,
    retain,
    reflect,
    dismissReflection,
  };
}
