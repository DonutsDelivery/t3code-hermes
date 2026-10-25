// @effect-diagnostics nodeBuiltinImport:off
// Pure path and home-directory resolution, shared with tests; file reads go through Effect's FileSystem.
/**
 * Hermes's own Hindsight connection, resolved in its order: `$HERMES_HOME/hindsight/config.json`,
 * `~/.hindsight/config.json`, then `HINDSIGHT_*` (`$HERMES_HOME/.env` first). Only URL, bank, and
 * key; `bank_id_template` uses its static fallback. Verified against Hermes 0.20.
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { resolveHermesHome } from "../../hermes/hermesCronState.ts";

/** Hermes' defaults for a local (external or embedded) and a cloud Hindsight. */
const HERMES_DEFAULT_LOCAL_URL = "http://localhost:8888";
const HERMES_DEFAULT_CLOUD_URL = "https://api.hindsight.vectorize.io";
const HERMES_DEFAULT_BANK = "hermes";
const LOCAL_MODES = new Set(["local", "local_embedded", "local_external"]);

export interface HermesHindsightConfig {
  /** The file it was read from, or null when it came from `HINDSIGHT_*` variables. */
  readonly configPath: string | null;
  readonly baseUrl: string;
  readonly bank: string | null;
  readonly apiKey: string | null;
}

export interface HermesHindsightPaths {
  /** Config files in the order Hermes tries them. */
  readonly configFiles: ReadonlyArray<string>;
  readonly dotenvFile: string;
}

/**
 * `~` for a Hermes instance. Python's `Path.home()` honours HOME
 * (USERPROFILE on Windows), so an instance given its own home is followed there.
 */
export function hermesUserHome(
  environment: NodeJS.ProcessEnv,
  fallback: string = NodeOS.homedir(),
): string {
  return environment["HOME"]?.trim() || environment["USERPROFILE"]?.trim() || fallback;
}

export function resolveHermesHindsightPaths(
  environment: NodeJS.ProcessEnv,
  homedir: string = hermesUserHome(environment),
): HermesHindsightPaths {
  // The same resolution agent memory writes with, `~/…` included.
  const hermesHome = resolveHermesHome(environment, homedir);
  return {
    configFiles: [
      NodePath.join(hermesHome, "hindsight", "config.json"),
      NodePath.join(homedir, ".hindsight", "config.json"),
    ],
    dotenvFile: NodePath.join(hermesHome, ".env"),
  };
}

/** A quoted value, optionally followed by a comment: `"value" # note`. */
const QUOTED_VALUE = /^(["'])(.*)\1(?:\s+#.*)?$/;

/** `KEY=value` lines, as python-dotenv reads them for the handful of keys used here. */
export function parseDotenv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (line.length === 0 || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    const raw = line.slice(equals + 1).trim();
    const quoted = QUOTED_VALUE.exec(raw);
    values[key] =
      quoted === null
        ? raw.replace(/\s+#.*$/, "")
        : // Double quotes decode escapes, single quotes keep the text as written.
          quoted[1] === '"'
          ? (quoted[2] ?? "").replace(/\\(["\\])/g, "$1")
          : (quoted[2] ?? "");
  }
  return values;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Hermes' connection from what was found on disk, or null when Hermes is not set up to use
 * Hindsight.
 * `config` is the first config file that parsed to an object, as Hermes skips one that is missing
 * or malformed. `environment` is the process environment with Hermes' `.env` already laid over it.
 */
export function resolveHermesHindsightConfig(input: {
  readonly config: { readonly path: string; readonly value: unknown } | null;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): HermesHindsightConfig | null {
  const env = (name: string) => nonEmptyString(input.environment[name]);
  const file = input.config === null ? null : asRecord(input.config.value);
  // Without a config file Hermes builds the same shape from variables.
  const config: Record<string, unknown> = file ?? {
    mode: env("HINDSIGHT_MODE") ?? "cloud",
    bank_id: env("HINDSIGHT_BANK_ID"),
  };

  const mode = nonEmptyString(config["mode"]) ?? "cloud";
  const apiKey =
    nonEmptyString(config["apiKey"]) ??
    nonEmptyString(config["api_key"]) ??
    env("HINDSIGHT_API_KEY");
  const apiUrl = nonEmptyString(config["api_url"]) ?? env("HINDSIGHT_API_URL");
  // Hermes' own availability check: a local mode, or cloud with a key or URL.
  // Anything else means Hermes is not using Hindsight either.
  if (!LOCAL_MODES.has(mode) && apiKey === null && apiUrl === null) return null;

  const banks = asRecord(config["banks"]);
  const hermesBank = banks === null ? null : asRecord(banks["hermes"]);
  return {
    configPath: file === null ? null : (input.config?.path ?? null),
    baseUrl:
      apiUrl ?? (LOCAL_MODES.has(mode) ? HERMES_DEFAULT_LOCAL_URL : HERMES_DEFAULT_CLOUD_URL),
    bank:
      nonEmptyString(config["bank_id"]) ??
      nonEmptyString(hermesBank?.["bankId"]) ??
      HERMES_DEFAULT_BANK,
    apiKey,
  };
}
