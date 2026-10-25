/**
 * Opts CLIProxyAPI endpoints into fast mode in Hermes's `config.yaml` (`capabilities: {fast_mode:
 * true}`) while the `acp-fast-mode` patch is applied. A marker comment lets removal take out only
 * what T3 Code added. Edits keep comments, never rewrite an unparseable file, and land atomically.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import { HttpClient, HttpClientRequest } from "effect/http";
import { type Document, isMap, isScalar, isSeq, parseDocument, Scalar, YAMLMap } from "yaml";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

const CAPABILITIES_KEY = "capabilities";
const FAST_MODE_KEY = "fast_mode";
/** Trailing comment that marks a flag T3 Code wrote. */
const MARKER = " added by T3 Code (Fast mode patch)";

/** A custom endpoint entry from `custom_providers:` or `providers:`. */
function customEndpointEntries(document: Document): ReadonlyArray<YAMLMap> {
  const entries: Array<YAMLMap> = [];
  const legacy = document.get("custom_providers", true);
  if (isSeq(legacy)) for (const item of legacy.items) if (isMap(item)) entries.push(item);
  const providers = document.get("providers", true);
  if (isMap(providers))
    for (const item of providers.items) if (isMap(item.value)) entries.push(item.value);
  return entries;
}

function endpointBaseUrl(entry: YAMLMap): string | null {
  for (const key of ["base_url", "url", "api"]) {
    const value = entry.get(key);
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) return value.trim();
  }
  return null;
}

/** The entry's `capabilities:` node, whatever shape the user gave it. */
function capabilitiesNode(entry: YAMLMap): unknown {
  return entry.get(CAPABILITIES_KEY, true);
}

function fastModeFlag(entry: YAMLMap): Scalar | null {
  const capabilities = capabilitiesNode(entry);
  if (!isMap(capabilities)) return null;
  const flag: unknown = capabilities.get(FAST_MODE_KEY, true);
  return isScalar(flag) ? flag : null;
}

/** Adds the marked flag to every endpoint `accepts` says yes to, unless it already has one. */
export function markFastModeEndpoints(
  document: Document,
  accepts: (baseUrl: string) => boolean,
): number {
  let marked = 0;
  for (const entry of customEndpointEntries(document)) {
    const baseUrl = endpointBaseUrl(entry);
    if (baseUrl === null || !accepts(baseUrl)) continue;
    const existing = capabilitiesNode(entry);
    if (existing !== undefined && !isMap(existing)) continue;
    // Whatever the user already decided for this endpoint stands.
    if (isMap(existing) && existing.has(FAST_MODE_KEY)) continue;
    const capabilities = isMap(existing) ? existing : new YAMLMap();
    if (!isMap(existing)) entry.set(CAPABILITIES_KEY, capabilities);
    // A flow map with a trailing comment renders across several lines anyway.
    capabilities.flow = false;
    const flag = new Scalar(true);
    flag.comment = MARKER;
    capabilities.set(FAST_MODE_KEY, flag);
    marked += 1;
  }
  return marked;
}

/** Removes the flags T3 Code added, and a `capabilities:` map left empty by it. */
export function unmarkFastModeEndpoints(document: Document): number {
  let removed = 0;
  for (const entry of customEndpointEntries(document)) {
    const capabilities = capabilitiesNode(entry);
    if (!isMap(capabilities) || fastModeFlag(entry)?.comment !== MARKER) continue;
    capabilities.delete(FAST_MODE_KEY);
    if (capabilities.items.length === 0) entry.delete(CAPABILITIES_KEY);
    removed += 1;
  }
  return removed;
}

/**
 * Whether the server behind a base URL identifies as CLIProxyAPI. Its root
 * answers without credentials with `{"message":"CLI Proxy API Server"}` and
 * `X-CPA-*` headers, so no API key is ever sent.
 */
const isCliProxyApiEndpoint = Effect.fn("hermesFastModeConfig.isCliProxyApiEndpoint")(
  function* (baseUrl: string) {
    const root = new URL(baseUrl);
    root.pathname = root.pathname.replace(/\/v1\/?$/, "/");
    root.search = "";
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(HttpClientRequest.get(root.toString()));
    if (response.headers["x-cpa-version"] !== undefined) return true;
    const body = yield* response.json;
    return (
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      body.message === "CLI Proxy API Server"
    );
  },
  Effect.timeout("3 seconds"),
  Effect.orElseSucceed(() => false),
);

/**
 * Applies `edit` to `config.yaml` and writes it back when it changed anything.
 * Never fails the caller: the patch change already happened, and a config T3
 * Code could not read or write is left exactly as it was.
 */
const editHermesConfig = Effect.fn("hermesFastModeConfig.editHermesConfig")(function* <R>(
  configFile: string,
  edit: (document: Document) => Effect.Effect<number, never, R>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem.readFileString(configFile).pipe(Effect.orElseSucceed(() => null));
  if (text === null) return 0;
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    yield* Effect.logWarning("Hermes config.yaml did not parse; fast mode was not configured.");
    return 0;
  }
  const changed = yield* edit(document);
  if (changed === 0) return 0;
  const written = yield* writeFileStringAtomically({
    filePath: configFile,
    contents: document.toString(),
  }).pipe(Effect.result);
  if (Result.isFailure(written)) {
    yield* Effect.logWarning("Could not write Hermes config.yaml for fast mode.", {
      cause: written.failure._tag,
    });
    return 0;
  }
  return changed;
});

/** Opts every CLIProxyAPI endpoint in Hermes's config into fast mode. */
export const optInHermesFastModeEndpoints = (configFile: string) =>
  editHermesConfig(configFile, (document) =>
    Effect.gen(function* () {
      const candidates = customEndpointEntries(document)
        .filter((entry) => fastModeFlag(entry) === null)
        .flatMap((entry) => endpointBaseUrl(entry) ?? []);
      const detected = yield* Effect.forEach(
        [...new Set(candidates)],
        (baseUrl) =>
          isCliProxyApiEndpoint(baseUrl).pipe(Effect.map((yes) => (yes ? [baseUrl] : []))),
        { concurrency: 4 },
      );
      const accepted = new Set(detected.flat());
      return markFastModeEndpoints(document, (baseUrl) => accepted.has(baseUrl));
    }),
  );

/** Takes back the fast-mode opt-ins T3 Code added. */
export const optOutHermesFastModeEndpoints = (configFile: string) =>
  editHermesConfig(configFile, (document) => Effect.succeed(unmarkFastModeEndpoints(document)));
