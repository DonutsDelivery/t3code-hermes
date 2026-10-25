/** Re-sent receipt ids are remembered this long, per session. */
const SEEN_LIMIT = 1024;

/**
 * Receipt ids a wake notice carries (Hermes `notificationIds`), held by notice text until the wake
 * turn prompts. `admit` drops re-sent notices while queued or prompting; `forget` reopens them once
 * the prompt settles.
 */
export class AcpWakeReceipts {
  private readonly seen = new Set<string>();
  private readonly pending: Array<{ readonly text: string; readonly ids: ReadonlyArray<string> }> =
    [];

  /** False when every id was already admitted: the notice is a re-send. */
  admit(text: string, ids: ReadonlyArray<string>): boolean {
    if (ids.length === 0) return true;
    if (ids.every((id) => this.seen.has(id))) return false;
    for (const id of ids) this.seen.add(id);
    while (this.seen.size > SEEN_LIMIT) {
      this.seen.delete(this.seen.values().next().value!);
    }
    this.pending.push({ text, ids });
    return true;
  }

  /**
   * Ids for a wake turn prompted with `promptText`. A context handoff or
   * restart note can prefix the notice, so the notice only has to end it.
   */
  take(promptText: string): ReadonlyArray<string> {
    const index = this.pending.findIndex((entry) => promptText.endsWith(entry.text));
    if (index === -1) return [];
    return this.pending.splice(index, 1)[0]!.ids;
  }

  forget(ids: ReadonlyArray<string>): void {
    for (const id of ids) this.seen.delete(id);
  }
}
