/**
 * The Memory tab's copy and small formatters, shared so web and mobile explain Hindsight the same
 * way.
 */
import {
  canonicalHindsightUrl,
  HINDSIGHT_TARGET_API_VERSION,
  type HindsightAgentMemoryState,
  type HindsightAgentTarget,
  type HindsightBanksResult,
  type HindsightBankStats,
  type HindsightPathway,
  type HindsightPathwayFilter,
  type HindsightStatus,
} from "@t3tools/contracts";
import { DateTime, Option } from "effect";

/** Prompt used by "Reflect now" when the user has not typed a query. */
export const HINDSIGHT_DEFAULT_REFLECT_QUERY =
  "Summarise what you know, and what you are least sure about.";

export interface HindsightPathwayFilterOption {
  readonly value: HindsightPathwayFilter;
  readonly label: string;
}

export const HINDSIGHT_PATHWAY_FILTERS: ReadonlyArray<HindsightPathwayFilterOption> = [
  { value: "all", label: "All" },
  { value: "world", label: "World" },
  { value: "experience", label: "Experiences" },
  { value: "mentalModel", label: "Mental models" },
];

export const HINDSIGHT_PATHWAY_LABELS: Record<HindsightPathway, string> = {
  world: "World",
  experience: "Experience",
  observation: "Observation",
  mentalModel: "Mental model",
};

/** Coarse buckets on purpose: an exact age is noise on a memory list. */
export function formatHindsightMemoryAge(value: string | null): string | null {
  if (value === null) return null;
  const parsed = DateTime.make(value);
  if (Option.isNone(parsed)) return null;
  const elapsed =
    DateTime.toEpochMillis(DateTime.nowUnsafe()) - DateTime.toEpochMillis(parsed.value);
  if (elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return DateTime.toDate(parsed.value).toLocaleDateString();
}

/** Shown in place of the counts until the first read lands. Never zeroes. */
export const HINDSIGHT_STATS_PENDING_LABEL = "Counting memories…";

export interface HindsightStatsSummary {
  /** The size of the bank, in reading order. Joined with a separator by the UI. */
  readonly counts: ReadonlyArray<string>;
  /** The pathway split, using the same labels as the list's chips. */
  readonly breakdown: ReadonlyArray<string>;
  /** Background work worth mentioning. Empty when nothing is queued or failed. */
  readonly operations: ReadonlyArray<string>;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/**
 * The stats strip's words.
 *
 * Pending and failed operations are omitted at zero on purpose: they are the
 * only two numbers here that mean "something needs attention", and a permanent
 * "0 failed" trains people to stop reading the strip.
 */
export function describeHindsightStats(stats: HindsightBankStats): HindsightStatsSummary {
  const consolidated = formatHindsightMemoryAge(stats.lastConsolidatedAt);
  return {
    counts: [
      countLabel(stats.nodes, "memory", "memories"),
      countLabel(stats.links, "link", "links"),
      countLabel(stats.documents, "document", "documents"),
      ...(consolidated === null ? [] : [`consolidated ${consolidated}`]),
    ],
    breakdown: stats.nodesByPathway.map(
      (entry) => `${HINDSIGHT_PATHWAY_LABELS[entry.pathway]} ${entry.count.toLocaleString()}`,
    ),
    operations: [
      ...(stats.pendingOperations > 0
        ? [`${stats.pendingOperations.toLocaleString()} pending`]
        : []),
      ...(stats.failedOperations > 0 ? [`${stats.failedOperations.toLocaleString()} failed`] : []),
    ],
  };
}

export interface HindsightUnavailableState {
  readonly title: string;
  readonly description: string;
  /** Whether asking again could plausibly change the answer. */
  readonly retryable: boolean;
}

/**
 * Copy for a Hindsight that cannot answer, or `null`. Cases stay distinct because each has a
 * different next action. `enabled` is `integrations.hindsight.enabled`.
 */
export function describeHindsightUnavailable(
  status: HindsightStatus | null,
  options: { readonly enabled: boolean },
): HindsightUnavailableState | null {
  switch (status?.availability) {
    case "notConfigured":
      return options.enabled
        ? {
            title: "Memory is not set up",
            description:
              "Set up Hindsight memory in Hermes and it is picked up here automatically, or enter a Hindsight server in Memory settings.",
            retryable: true,
          }
        : {
            title: "Memory is turned off",
            description: "Turn it on in Memory settings to browse what the agent remembers.",
            retryable: false,
          };
    case "offline":
      return {
        title: "Hindsight is not answering",
        description: status.detail ?? "Hindsight is configured but not reachable on this host.",
        retryable: true,
      };
    case "incompatible":
      return {
        title: "Hindsight is a version T3 Code does not understand",
        description:
          status.detail ?? `T3 Code targets Hindsight API ${HINDSIGHT_TARGET_API_VERSION}.`,
        retryable: true,
      };
    case "requestFailed":
      return {
        title: "Memory could not be read",
        description: status.detail ?? "Hindsight did not answer the read.",
        retryable: true,
      };
    default:
      return null;
  }
}

export interface HindsightConnectionSummary {
  /** `ready` reads as healthy, `attention` as something to fix, `idle` as neither. */
  readonly tone: "ready" | "attention" | "idle";
  readonly label: string;
  readonly detail: string | null;
}

/**
 * The Memory settings' account of the connection in use: whether it answers,
 * where it is, and whether that came from Hermes or from these settings.
 * `result` is null until the first read lands.
 */
export function describeHindsightConnection(
  result: HindsightBanksResult | null,
  options: { readonly enabled: boolean },
): HindsightConnectionSummary {
  if (!options.enabled) {
    return { tone: "idle", label: "Off", detail: "The Memory tab stays empty until this is on." };
  }
  if (result === null) return { tone: "idle", label: "Checking…", detail: null };
  // An environment older than the `connection` field omits it; only its status is known.
  const connection = result.connection;
  if (connection === undefined) {
    return result.status.availability === "ready"
      ? { tone: "ready", label: "Connected", detail: null }
      : { tone: "attention", label: "Needs attention", detail: result.status.detail };
  }
  if (connection === null) {
    return {
      tone: "attention",
      label: "Not set up",
      detail: "Hermes has no Hindsight config on this environment. Enter a server URL below.",
    };
  }
  const where = `${connection.baseUrl} · ${connection.source === "hermes" ? "from Hermes" : "from these settings"}`;
  switch (result.status.availability) {
    case "ready":
      return {
        tone: "ready",
        label: "Connected",
        detail:
          result.status.apiVersion === null ? where : `${where} · API ${result.status.apiVersion}`,
      };
    case "offline":
      return { tone: "attention", label: "Not answering", detail: where };
    default:
      return {
        tone: "attention",
        label: "Needs attention",
        detail: result.status.detail === null ? where : `${where} · ${result.status.detail}`,
      };
  }
}

export interface HindsightEmptyListState {
  readonly title: string;
  readonly description: string;
}

/** Why the list is empty: nothing matched, or nothing is there at all. */
export function describeHindsightEmptyList(submittedQuery: string): HindsightEmptyListState {
  return submittedQuery.length > 0
    ? {
        title: "Nothing recalled",
        description: "Hindsight found no memories matching that.",
      }
    : {
        title: "This bank is empty",
        description:
          "Nothing has been remembered here yet. Retain a note below, or let the agent write its own.",
      };
}

/** What a saved note actually produced — Hindsight splits one note into facts. */
export function describeHindsightRetainResult(itemsCount: number): string {
  return itemsCount === 1
    ? "Hindsight extracted 1 memory from it."
    : `Hindsight extracted ${itemsCount} memories from it.`;
}

const HINDSIGHT_AGENT_LABELS: Record<HindsightAgentTarget, string> = {
  claudeCode: "Claude Code",
  codex: "Codex",
  hermes: "Hermes",
};

export interface HindsightAgentMemoryRow {
  readonly target: HindsightAgentTarget;
  readonly label: string;
  /** Only a failure gets a word; the dot already says wired or not. */
  readonly status: string | null;
  readonly tone: "ready" | "attention" | "idle";
  readonly detail: string | null;
  /**
   * The row as one line: the name, a failure if any, then the detail. The
   * detail shows even on a wired agent, where it names the instances with
   * their own config home that the wiring does not reach.
   */
  readonly text: string;
}

export interface HindsightAgentMemorySummary {
  readonly tone: "ready" | "attention" | "idle";
  /** Null when the switch already says it all: plainly on, or plainly off. */
  readonly label: string | null;
  readonly detail: string | null;
  readonly agents: ReadonlyArray<HindsightAgentMemoryRow>;
  /**
   * Running the pass again could change the answer: something failed or is
   * blocked. A coverage gap needs attention but not a retry.
   */
  readonly retryable: boolean;
}

/**
 * The Providers settings' account of agent memory: one headline for the
 * switch, then one row per agent configured on the environment. `state` is
 * null until the environment answers, or when it predates agent memory.
 */
export function describeHindsightAgentMemory(
  state: HindsightAgentMemoryState | null,
  options: { readonly enabled: boolean },
): HindsightAgentMemorySummary {
  if (state === null) {
    return { tone: "idle", label: "Checking…", detail: null, agents: [], retryable: false };
  }
  const agents = state.agents.map((agent): HindsightAgentMemoryRow => {
    const label = HINDSIGHT_AGENT_LABELS[agent.target];
    const status = agent.state === "failed" ? "Failed" : null;
    const name = status === null ? label : `${label} ${status.toLowerCase()}`;
    return {
      target: agent.target,
      label,
      status,
      // Wired with a detail means wired somewhere the agent does not look:
      // the detail names what is not covered.
      tone:
        agent.state === "installed"
          ? agent.detail === null
            ? "ready"
            : "attention"
          : agent.state === "failed"
            ? "attention"
            : "idle",
      detail: agent.detail,
      text: agent.detail === null ? name : `${name} · ${agent.detail}`,
    };
  });
  const retryable =
    !state.applying &&
    (state.blocker !== null ||
      state.detail !== null ||
      state.agents.some((agent) => agent.state === "failed"));
  const headline = (
    tone: HindsightAgentMemorySummary["tone"],
    label: string | null,
    detail: string | null,
  ): HindsightAgentMemorySummary => ({ tone, label, detail, agents, retryable });

  if (state.applying) return headline("idle", "Applying…", null);
  if (state.blocker === "notConfigured") {
    return headline(
      "attention",
      "No Hindsight server",
      "Set one up in Settings → Integrations → Memory first.",
    );
  }
  if (state.blocker === "nodeMissing") {
    return headline(
      "attention",
      "Node.js not found",
      "Hindsight's installer and the hooks it adds need Node.js 18+ on this machine's PATH.",
    );
  }
  if (state.detail !== null) return headline("attention", "Needs attention", state.detail);
  // Off, a failed row is cleanup still to finish: it needs attention, and the
  // rows themselves say what failed.
  if (!options.enabled) {
    return headline(
      agents.some((agent) => agent.tone === "attention") ? "attention" : "idle",
      null,
      null,
    );
  }
  if (agents.length === 0) {
    return headline(
      "idle",
      "No supported agents",
      "Claude Code, Codex, and Hermes aren't set up on this environment.",
    );
  }
  // The rows say what needs attention; a headline would only hide them.
  return headline(
    agents.every((agent) => agent.tone === "ready") ? "ready" : "attention",
    null,
    null,
  );
}

/** One connected machine, as the all-machines switch needs to see it. */
export interface HindsightMachineInput {
  /** `integrations.hindsight.agentMemory` on that machine. */
  readonly enabled: boolean;
  /** This client may change settings there. */
  readonly writable: boolean;
  /** Its agent memory state, or null until the machine has answered. */
  readonly state: HindsightAgentMemoryState | null;
}

export interface HindsightMachinesSummary {
  /** Every writable machine has it on. */
  readonly checked: boolean;
  /** Some writable machines have it on and some do not. */
  readonly mixed: boolean;
  /** The switch is useless until a machine can be written to. */
  readonly canToggle: boolean;
  readonly tone: "ready" | "attention" | "idle";
  /** One line for the switch; null whenever the switch and the rows say it all. */
  readonly label: string | null;
}

/**
 * The one switch over every connected machine. It reads as on only when every
 * machine this client can write to has agent memory on; a partial set shows as
 * mixed so one click finishes the job rather than undoing it.
 */
export function summarizeHindsightMachines(
  machines: ReadonlyArray<HindsightMachineInput>,
): HindsightMachinesSummary {
  const writable = machines.filter((machine) => machine.writable);
  const on = writable.filter((machine) => machine.enabled).length;
  const checked = writable.length > 0 && on === writable.length;
  const mixed = on > 0 && on < writable.length;
  const summaries = machines.map((machine) =>
    describeHindsightAgentMemory(machine.state, { enabled: machine.enabled }),
  );
  const tone: HindsightMachinesSummary["tone"] = summaries.some(
    (summary) => summary.tone === "attention",
  )
    ? "attention"
    : summaries.some((summary) => summary.label === "Applying…")
      ? "idle"
      : checked
        ? "ready"
        : "idle";
  // Only what the rows cannot say themselves; each row carries its own state.
  const label =
    machines.length === 0
      ? "No connected machines"
      : writable.length === 0
        ? "No machine lets this client change settings"
        : mixed
          ? `On for ${on} of ${writable.length} machines`
          : null;
  return { checked, mixed, canToggle: writable.length > 0, tone, label };
}

/** A connected machine, as handing it the shared server needs to see it. */
export interface HindsightHandoffMachine {
  /** `integrations.hindsight.agentMemory` on that machine. */
  readonly enabled: boolean;
  /** It resolves a server of its own; null until it has answered. */
  readonly hasServer: boolean | null;
  /** The server it resolves, if any. */
  readonly serverUrl: string | null;
  /** Its saved server override, or empty. */
  readonly savedUrl: string;
  /**
   * It has an API key saved. Only ever shown, never trusted to belong to
   * any particular server.
   */
  readonly hasSavedKey: boolean;
  /** That server is reached with an API key. */
  readonly serverHasKey: boolean;
}

export interface HindsightServerHandoff {
  /** What a machine with no server of its own is handed, or null when there is nothing to hand. */
  readonly url: string | null;
  /**
   * That server takes an API key. Clients never see a saved key, so it is
   * only handed on together with a key entered here: a key a machine already
   * has may belong to some other server.
   */
  readonly needsKey: boolean;
}

/** The shared server: the saved override, else one some machine already resolves. */
export function planHindsightServerHandoff(
  saved: { readonly url: string; readonly hasKey: boolean },
  machines: ReadonlyArray<HindsightHandoffMachine>,
): HindsightServerHandoff {
  if (saved.url.length > 0) return { url: saved.url, needsKey: saved.hasKey };
  const source = machines.find((machine) => machine.serverUrl !== null);
  return source === undefined
    ? { url: null, needsKey: false }
    : { url: source.serverUrl, needsKey: source.serverHasKey };
}

/**
 * Whether a write should hand `machine` the shared server. `enabling` is set
 * when the write itself switches agent memory on, `withKey` when it carries
 * an API key. A machine is never handed a keyed server without a key, so its
 * agents do not start calling it unauthenticated.
 */
export function shouldHandOffHindsightServer(
  machine: HindsightHandoffMachine,
  handoff: HindsightServerHandoff,
  options: { readonly enabling: boolean; readonly withKey: boolean },
): boolean {
  return (
    (options.enabling || machine.enabled) &&
    machine.hasServer === false &&
    handoff.url !== null &&
    (!handoff.needsKey || options.withKey)
  );
}

/** The switch's line while switched-on machines wait for the server's key, else null. */
export function describeHindsightKeyWait(
  machines: ReadonlyArray<HindsightHandoffMachine>,
  handoff: HindsightServerHandoff,
): string | null {
  const waiting = machines.filter(
    (machine) =>
      machine.enabled && machine.hasServer === false && handoff.url !== null && handoff.needsKey,
  ).length;
  if (waiting === 0) return null;
  return `Enter the API key below to finish ${waiting === 1 ? "1 machine" : `${waiting} machines`}`;
}

/** One change the clients make on every machine they can write to. */
export type HindsightSharedWrite =
  | { readonly kind: "switch"; readonly agentMemory: boolean }
  /** An empty key removes it. */
  | { readonly kind: "apiKey"; readonly apiKey: string }
  /** An empty URL puts each machine back on its own server. */
  | { readonly kind: "server"; readonly url: string }
  /** Removes the key from every machine that has one, whatever its server. */
  | { readonly kind: "clearKeys" };

export interface HindsightSharedPatch {
  readonly agentMemory?: boolean;
  readonly baseUrl?: string;
  readonly apiKey?: string;
}

function isOnHindsightServer(machine: HindsightHandoffMachine, url: string | null): boolean {
  if (url === null || url.trim().length === 0) return false;
  const target = canonicalHindsightUrl(url);
  return [machine.savedUrl, machine.serverUrl].some(
    (candidate) =>
      candidate !== null && candidate.length > 0 && canonicalHindsightUrl(candidate) === target,
  );
}

/**
 * What one shared write changes on one machine, or null for nothing. A
 * machine's server and key move together, so a key only ever reaches the
 * server it was entered for: a key goes to machines on the shared server,
 * and a machine moved to another server loses the key it had.
 */
export function hindsightSharedPatch(
  machine: HindsightHandoffMachine,
  handoff: HindsightServerHandoff,
  write: HindsightSharedWrite,
): HindsightSharedPatch | null {
  switch (write.kind) {
    case "switch":
      // Only an open server is handed on here; a keyed one waits for its key.
      return write.agentMemory &&
        handoff.url !== null &&
        shouldHandOffHindsightServer(machine, handoff, { enabling: true, withKey: false })
        ? { agentMemory: true, baseUrl: handoff.url, apiKey: "" }
        : { agentMemory: write.agentMemory };
    case "apiKey":
      if (isOnHindsightServer(machine, handoff.url)) return { apiKey: write.apiKey };
      return write.apiKey.length > 0 &&
        handoff.url !== null &&
        shouldHandOffHindsightServer(machine, handoff, { enabling: false, withKey: true })
        ? { baseUrl: handoff.url, apiKey: write.apiKey }
        : null;
    case "clearKeys":
      // Removing a key sends it nowhere, so it may reach every machine.
      return machine.hasSavedKey ? { apiKey: "" } : null;
    case "server":
      if (write.url.length === 0) {
        return machine.savedUrl.length > 0 ? { baseUrl: "", apiKey: "" } : null;
      }
      // A machine already on it is left as it is: an override there would
      // cut it off from a key it inherits from Hermes.
      return isOnHindsightServer(machine, write.url) ? null : { baseUrl: write.url, apiKey: "" };
  }
}

/** What the shared server and key controls show, across every machine they write to. */
export interface HindsightSharedSettings {
  /** The override the machines that have one agree on; empty when none has one or they differ. */
  readonly url: string;
  /** Machines hold different overrides, so no one URL stands for them. */
  readonly urlsDiffer: boolean;
  /** Some machine has an override, which a reset clears. */
  readonly hasOverride: boolean;
  /** Some machine on the shared server has a key saved, which Remove clears. */
  readonly hasKey: boolean;
  /**
   * Some machine on another server has a key saved, which only a
   * remove-everywhere reaches.
   */
  readonly keysElsewhere: boolean;
}

/**
 * The shared controls' state from all the machines they write to, not one
 * stand-in, so an override or key saved on any of them stays visible and
 * can be taken back.
 */
export function summarizeHindsightSharedSettings(
  machines: ReadonlyArray<HindsightHandoffMachine>,
): HindsightSharedSettings {
  const overrides = machines.filter((machine) => machine.savedUrl.length > 0);
  const distinct = new Set(overrides.map((machine) => canonicalHindsightUrl(machine.savedUrl)));
  const url = distinct.size === 1 ? (overrides[0]?.savedUrl ?? "") : "";
  const target =
    url.length > 0
      ? url
      : (machines.find((machine) => machine.serverUrl !== null)?.serverUrl ?? null);
  return {
    url,
    urlsDiffer: distinct.size > 1,
    hasOverride: overrides.length > 0,
    hasKey: machines.some((machine) => machine.hasSavedKey && isOnHindsightServer(machine, target)),
    keysElsewhere: machines.some(
      (machine) => machine.hasSavedKey && !isOnHindsightServer(machine, target),
    ),
  };
}
