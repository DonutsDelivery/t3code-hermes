/**
 * Whether a Hermes run landed since the Tasks panel was last open. Session-local on purpose so a
 * reload clears the dot; plain module state because both clients subscribe their own way.
 */

type EnvironmentKey = string;
const seenByEnvironment = new Map<EnvironmentKey, { lastSeenSeq: number; latestSeq: number }>();
const listeners = new Set<() => void>();

function state(environmentId: EnvironmentKey) {
  let value = seenByEnvironment.get(environmentId);
  if (value === undefined) {
    value = { lastSeenSeq: 0, latestSeq: 0 };
    seenByEnvironment.set(environmentId, value);
  }
  return value;
}

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Called once per finished run. Counts here rather than taking the
 * subscription's own counter, which restarts from zero on every reconnect.
 */
export function reportHermesCompletion(environmentId: EnvironmentKey): void {
  state(environmentId).latestSeq += 1;
  emit();
}

/** Opening the panel acknowledges everything seen so far. */
export function markHermesTasksSeen(environmentId: EnvironmentKey): void {
  const current = state(environmentId);
  if (current.lastSeenSeq === current.latestSeq) return;
  current.lastSeenSeq = current.latestSeq;
  emit();
}

export function subscribeHermesTasksSeen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function hasUnseenHermesCompletions(environmentId: EnvironmentKey): boolean {
  const current = state(environmentId);
  return current.latestSeq > current.lastSeenSeq;
}
