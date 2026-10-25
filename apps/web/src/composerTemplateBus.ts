/**
 * Hands a prompt template to a composer that isn't mounted yet (full-page views like Hermes Tasks).
 * A slot, not an event, since the request precedes the listener; only the latest request survives.
 */
const TEMPLATE_READY_EVENT = "t3code:composer-template-ready";

let pendingTemplate: string | null = null;

/** Queues a template and wakes any composer that is already mounted. */
export function requestComposerTemplate(template: string): void {
  pendingTemplate = template;
  window.dispatchEvent(new CustomEvent(TEMPLATE_READY_EVENT));
}

/**
 * Takes the pending template, if any. Claiming it clears the slot so a
 * remount does not prefill the composer a second time.
 */
export function claimComposerTemplate(): string | null {
  const template = pendingTemplate;
  pendingTemplate = null;
  return template;
}

export function peekComposerTemplate(): string | null {
  return pendingTemplate;
}

export function onComposerTemplateRequested(listener: () => void): () => void {
  window.addEventListener(TEMPLATE_READY_EVENT, listener);
  return () => window.removeEventListener(TEMPLATE_READY_EVENT, listener);
}
