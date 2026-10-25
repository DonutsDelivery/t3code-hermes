import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";

import completionUrl from "./assets/notification-completion.mp3";
import inputUrl from "./assets/notification-input.mp3";

type NotificationMode = ClientSettings["notificationMode"];
export const NOTIFICATION_MODE_LABELS = {
  off: "Off",
  notifications: "Notifications only",
  sound: "Sound only",
  "notifications-and-sound": "Notifications with sound",
} satisfies Record<NotificationMode, string>;

export function hasNotificationSound(mode: NotificationMode) {
  return mode === "sound" || mode === "notifications-and-sound";
}

export function hasDesktopNotifications(mode: NotificationMode) {
  return mode === "notifications" || mode === "notifications-and-sound";
}

/** Badge severity, lowest first: a finished turn, a request for the user, a failure. */
export type AttentionKind = "completion" | "input" | "failed";

export const ATTENTION_SEVERITY = {
  completion: 0,
  input: 1,
  failed: 2,
} satisfies Record<AttentionKind, number>;

// Tailwind emerald-500 / amber-500 / red-500, matching the sidebar's status colors.
const DOT_COLORS = {
  completion: "#10b981",
  input: "#f59e0b",
  failed: "#ef4444",
} satisfies Record<AttentionKind, string>;

// A short blink when something new needs the user, then a solid dot. It stops on its
// own so a background tab never keeps repainting; hidden tabs throttle it to ~1s steps.
const DOT_BLINK = {
  input: { flashes: 3, intervalMs: 450 },
  failed: { flashes: 4, intervalMs: 200 },
} as const;

const TAG_HASH_OFFSET_BASIS = 0xcbf29ce484222325n;
const TAG_HASH_PRIME = 0x100000001b3n;
const TAG_HASH_MASK = 0xffffffffffffffffn;

/** Windows drops toast notifications with the 73-character environment/thread tag. */
export function threadNotificationTag(environmentId: EnvironmentId, threadId: ThreadId): string {
  const key = `${environmentId}:${threadId}`;
  let hash = TAG_HASH_OFFSET_BASIS;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= BigInt(key.charCodeAt(index));
    hash = (hash * TAG_HASH_PRIME) & TAG_HASH_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

let originalFavicon: HTMLLinkElement | undefined;
let badgeFavicon: HTMLLinkElement | undefined;
let baseIcon: Promise<HTMLImageElement | null> | undefined;
let faviconDot: AttentionKind | null = null;
let faviconGeneration = 0;
let blinkTimer: ReturnType<typeof setTimeout> | undefined;

export interface StatusDot {
  readonly kind: AttentionKind;
  /** Flash the dot briefly; set when a new input request or failure arrives. */
  readonly blink: boolean;
}

/**
 * Marks unseen work: a count on the browser favicon, or the desktop dock/taskbar badge.
 * With `statusDot` (the opt-in Tab status dots setting) the browser favicon gets a
 * colored dot instead of the count.
 */
export function setNotificationBadge(count: number, statusDot?: StatusDot) {
  const bridge = window.desktopBridge;
  if (!bridge) {
    if (count === 0) clearFavicon();
    else if (statusDot) {
      const blink =
        statusDot.blink &&
        statusDot.kind !== "completion" &&
        !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      showFaviconDot(statusDot.kind, blink);
    } else showFaviconCount(count);
    return;
  }
  const image =
    count > 0 && bridge.getClientPlatform?.() === "win32" ? drawCountBadge(count) : null;
  void bridge.setNotificationBadge?.({ count, image }).catch(() => undefined);
}

function drawCountBadge(count: number) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#e5484d";
  context.beginPath();
  context.arc(32, 32, 28, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "white";
  context.font = `600 ${count > 9 ? 30 : 40}px "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(count > 9 ? "9+" : String(count), 32, 34);
  return canvas.toDataURL("image/png");
}

function loadImage(href: string) {
  return new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => resolve(null), { once: true });
    image.src = href;
  });
}

function showFaviconDot(kind: AttentionKind, blink: boolean) {
  if (faviconDot === kind && !blink) return;
  faviconDot = kind;
  const generation = ++faviconGeneration;
  stopBlink();
  const baseHref = baseFavicon()?.href ?? "/favicon.ico";
  baseIcon ??= loadImage(baseHref);
  void baseIcon.then((icon) => {
    // The dot may have been cleared or changed while the icon loaded.
    if (generation !== faviconGeneration) return;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) return;
    if (icon) context.drawImage(icon, 0, 0, 64, 64);
    // Punch a transparent ring so the dot reads on light and dark tab strips.
    context.globalCompositeOperation = "destination-out";
    context.beginPath();
    context.arc(51, 13, 14, 0, Math.PI * 2);
    context.fill();
    context.globalCompositeOperation = "source-over";
    context.fillStyle = DOT_COLORS[kind];
    context.beginPath();
    context.arc(51, 13, 11, 0, Math.PI * 2);
    context.fill();
    const dotted = canvas.toDataURL("image/png");
    const link = setBadgeFavicon(dotted);
    if (!blink || kind === "completion") return;
    const { flashes, intervalMs } = DOT_BLINK[kind];
    // Off/on pairs, ending on the dot.
    let remaining = flashes * 2;
    const step = () => {
      if (generation !== faviconGeneration || badgeFavicon !== link) return;
      remaining -= 1;
      link.href = remaining % 2 === 1 ? baseHref : dotted;
      if (remaining > 0) blinkTimer = setTimeout(step, intervalMs);
    };
    blinkTimer = setTimeout(step, intervalMs);
  });
}

/** The page's own icon, whether or not a badge has replaced it. */
function baseFavicon() {
  return badgeFavicon
    ? originalFavicon
    : document.querySelector<HTMLLinkElement>('link[rel="icon"]');
}

/** Swaps the page icon for a badge image, keeping the original to restore on clear. */
function setBadgeFavicon(href: string) {
  if (!badgeFavicon) {
    originalFavicon = baseFavicon() ?? undefined;
    badgeFavicon = document.createElement("link");
    badgeFavicon.rel = "icon";
    badgeFavicon.type = "image/png";
    badgeFavicon.sizes.value = "64x64";
    originalFavicon?.remove();
    document.head.append(badgeFavicon);
  }
  badgeFavicon.href = href;
  return badgeFavicon;
}

function showFaviconCount(count: number) {
  faviconDot = null;
  faviconGeneration += 1;
  stopBlink();
  const image = drawCountBadge(count);
  if (image) setBadgeFavicon(image);
}

function stopBlink() {
  clearTimeout(blinkTimer);
  blinkTimer = undefined;
}

function clearFavicon() {
  faviconDot = null;
  faviconGeneration += 1;
  stopBlink();
  if (!badgeFavicon) return;
  badgeFavicon.remove();
  badgeFavicon = undefined;
  if (originalFavicon) document.head.append(originalFavicon);
  originalFavicon = undefined;
}

let audioContext: AudioContext | undefined;
const buffers = new Map<string, Promise<AudioBuffer>>();
/** When each sound's current playback ends, on the audio context's clock. */
const playingUntil = new Map<string, number>();

/** Called from a gesture so browsers allow later background playback. */
export function unlockNotificationAudio() {
  audioContext ??= new AudioContext();
  void audioContext.resume().catch(() => undefined);
}

export async function playNotificationSound(
  kind: "completion" | "input",
  shouldPlay: () => boolean,
) {
  if (!audioContext || audioContext.state !== "running") return;
  const context = audioContext;
  const url = kind === "completion" ? completionUrl : inputUrl;
  try {
    let buffer = buffers.get(url);
    if (!buffer) {
      buffer = fetch(url)
        .then((response) => response.arrayBuffer())
        .then((data) => context.decodeAudioData(data));
      buffers.set(url, buffer);
    }
    const decoded = await buffer;
    if (!shouldPlay() || context.state !== "running") return;
    // Coalesce same-sound bursts after decode to avoid clipping; input and completion alerts keep separate slots.
    if (context.currentTime < (playingUntil.get(url) ?? 0)) return;
    const source = context.createBufferSource();
    source.buffer = decoded;
    source.connect(context.destination);
    source.start();
    playingUntil.set(url, context.currentTime + decoded.duration);
  } catch {
    buffers.delete(url);
  }
}
