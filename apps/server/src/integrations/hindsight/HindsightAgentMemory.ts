/**
 * HindsightAgentMemory — keeps this host's coding agents wired into Hindsight.
 *
 * `integrations.hindsight.agentMemory` is the whole interface: switched on,
 * every supported agent configured on this environment recalls from and
 * retains to the Hindsight connection the Memory tab already resolves;
 * switched off, what T3 Code added is taken back out. The work runs on the
 * environment's own host, so a remote or tunnelled environment wires its own
 * agents, never the machine the client happens to run on.
 *
 * Claude Code and Codex are wired by Hindsight's own installer
 * (`@vectorize-io/hindsight-coding-agents`), which owns their hooks, MCP entry
 * and skill. Hermes has a native Hindsight memory provider, so it only needs
 * that provider switched on and, when it has no Hindsight config of its own,
 * pointed at this connection.
 *
 * A pass is idempotent and only acts on drift: it runs at startup, whenever the
 * settings it depends on change, and on an explicit retry. Undoing is driven
 * by a ledger of what T3 Code itself changed, so an agent someone wired by
 * hand — or a Hermes install that already used Hindsight — is never torn down
 * by switching this off; it is only pointed back at the server it used before.
 * The ledger is saved before anything it covers is changed, and an entry is
 * cleared only once its undo succeeds, so a failed one is retried by the next
 * pass. Wiring follows what should be wired right now: with Memory off, no
 * server left, or an agent no longer set up, what T3 Code wired for it is
 * taken out, and the switch puts it back once it should be wired again.
 *
 * @module HindsightAgentMemory
 */
import * as NodeOS from "node:os";

import {
  canonicalHindsightUrl,
  type HindsightAgentMemoryBlocker,
  type HindsightAgentMemoryState,
  type HindsightAgentStatus,
  type HindsightAgentTarget,
  type ServerSettings,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CommandAvailability } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { isMap, parseDocument } from "yaml";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../../config.ts";
import { resolveEnabledHermesInstance, resolveHermesHome } from "../../hermes/hermesCronState.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ServerSettingsService from "../../serverSettings.ts";
import { hermesUserHome } from "./hermesHindsightConfig.ts";
import {
  HindsightService,
  type HindsightConnection,
  type ResolvedHindsight,
} from "./HindsightService.ts";

/**
 * Pinned so the flags below keep meaning what they mean. The runtime the
 * installer copies into `~/.hindsight/coding-agents` updates itself.
 */
export const HINDSIGHT_INSTALLER_PACKAGE = "@vectorize-io/hindsight-coding-agents@0.8.0";

/** A cold `npx` fetch plus the installer's own `claude mcp add` can take a while. */
const INSTALLER_TIMEOUT = Duration.minutes(5);
const INSTALLER_OUTPUT_MAX_BYTES = 16 * 1024;

/** Every hook the installer writes runs from `~/.hindsight/coding-agents/…`. */
const INSTALLER_MARKER = "coding-agents";

const HINDSIGHT_CLOUD_HOST = "api.hindsight.vectorize.io";

const LEDGER_FILE = "hindsight-agent-memory.json";

type CodingAgentTarget = "claudeCode" | "codex";

const CODING_AGENTS: ReadonlyArray<{
  readonly target: CodingAgentTarget;
  readonly driver: string;
  /** Used when an instance does not set its own `binaryPath`. */
  readonly binary: string;
  readonly installerId: string;
  /** The variable a provider instance uses for its own config home. */
  readonly homeVariable: string;
  /** The home the installer writes to, under the user's home directory. */
  readonly defaultHome: string;
}> = [
  {
    target: "claudeCode",
    driver: "claudeAgent",
    binary: "claude",
    installerId: "claude-code",
    homeVariable: "CLAUDE_CONFIG_DIR",
    defaultHome: ".claude",
  },
  {
    target: "codex",
    driver: "codex",
    binary: "codex",
    installerId: "codex",
    homeVariable: "CODEX_HOME",
    defaultHome: ".codex",
  },
];

const INITIAL_STATE: HindsightAgentMemoryState = {
  applying: false,
  blocker: null,
  agents: [],
  detail: null,
};

/** What T3 Code changed, so switching off undoes exactly that and nothing else. */
const AgentMemoryLedger = Schema.Struct({
  codingAgents: Schema.Array(Schema.Literals(["claudeCode", "codex"])),
  /**
   * The installer config's connection fields as they were before T3 Code
   * first ran the installer, and whether the file existed. The installer keeps
   * the server and token only there, so putting them back returns a hand-made
   * install to its own server; every other field is left as it is by then.
   * Absent while T3 Code has not touched it.
   */
  installerConnection: Schema.optionalKey(
    Schema.Struct({
      existed: Schema.Boolean,
      fields: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
  hermes: Schema.NullOr(
    Schema.Struct({
      home: Schema.String,
      /** `memory.provider` before T3 Code set it, or null when it was unset. */
      previousProvider: Schema.NullOr(Schema.String),
      changedProvider: Schema.Boolean,
      wroteConfig: Schema.Boolean,
    }),
  ),
});
type AgentMemoryLedger = typeof AgentMemoryLedger.Type;
type HermesLedger = NonNullable<AgentMemoryLedger["hermes"]>;
type InstallerConnection = NonNullable<AgentMemoryLedger["installerConnection"]>;

const EMPTY_LEDGER: AgentMemoryLedger = { codingAgents: [], hermes: null };

const decodeLedger = Schema.decodeEffect(Schema.fromJsonString(AgentMemoryLedger));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function isHindsightCloud(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === HINDSIGHT_CLOUD_HOST;
  } catch {
    return false;
  }
}

/** Arguments for `npx`, so the installer runs without a prompt or a TTY. */
export function installerArgs(
  action: "install" | "uninstall",
  targets: ReadonlyArray<CodingAgentTarget>,
  connection: Pick<HindsightConnection, "baseUrl" | "apiKey"> | null,
): ReadonlyArray<string> {
  const ids = CODING_AGENTS.filter((agent) => targets.includes(agent.target)).map(
    (agent) => agent.installerId,
  );
  const args = ["--yes", HINDSIGHT_INSTALLER_PACKAGE, action, ...ids];
  if (action === "uninstall" || connection === null) return args;
  if (isHindsightCloud(connection.baseUrl)) {
    args.push("--server", "cloud");
  } else {
    args.push("--server", "self-hosted", "--api-url", connection.baseUrl);
  }
  if (connection.apiKey !== null) args.push("--api-token", connection.apiKey);
  return args;
}

/**
 * Whether the installer's own config still points where this connection does.
 * A stale one means the agents would write to the old server, so the pass
 * re-runs the installer. A token the connection no longer has is stale too;
 * the installer never clears a token it is not given, so the pass removes it.
 */
export function installerConfigMatches(
  config: unknown,
  connection: Pick<HindsightConnection, "baseUrl" | "apiKey">,
): boolean {
  const record = asRecord(config);
  if (record === null) return false;
  const cloud = isHindsightCloud(connection.baseUrl);
  if (record["serverMode"] !== (cloud ? "cloud" : "self-hosted")) return false;
  if (!cloud && nonEmptyString(record["apiUrl"]) !== connection.baseUrl) return false;
  return nonEmptyString(record["apiToken"]) === connection.apiKey;
}

/**
 * Hermes' plugin config for this connection, as written to
 * `<HERMES_HOME>/hindsight/config.json`.
 */
function hermesHindsightConfigText(
  connection: Pick<HindsightConnection, "baseUrl" | "apiKey">,
): string {
  const contents = {
    mode: isHindsightCloud(connection.baseUrl) ? "cloud" : "local_external",
    api_url: connection.baseUrl,
    bank_id: "hermes",
    ...(connection.apiKey === null ? {} : { api_key: connection.apiKey }),
  };
  return `${JSON.stringify(contents, null, 2)}\n`;
}

/** The installer config fields that say where memory goes; the only ones the pass changes. */
const INSTALLER_CONNECTION_FIELDS = ["serverMode", "apiUrl", "apiToken"] as const;

/** Those fields as `record` has them; a missing one stays missing. */
function installerConnectionFields(
  record: Record<string, unknown> | null,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of INSTALLER_CONNECTION_FIELDS) {
    if (record !== null && key in record) fields[key] = record[key];
  }
  return fields;
}

/**
 * The installer config with its connection fields put back as they were and
 * every other field as it is now, or null when T3 Code created the file and
 * nothing else has been put in it since.
 */
function restoredInstallerConfigText(
  current: Record<string, unknown>,
  previous: InstallerConnection,
): string | null {
  const next: Record<string, unknown> = { ...current };
  for (const key of INSTALLER_CONNECTION_FIELDS) delete next[key];
  Object.assign(next, previous.fields);
  if (!previous.existed && Object.keys(next).length === 0) return null;
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** The installer's config text without its `apiToken`. */
function withoutApiToken(record: Record<string, unknown>): string {
  const rest = { ...record };
  delete rest["apiToken"];
  return `${JSON.stringify(rest, null, 2)}\n`;
}

/** The Hermes Hindsight config fields that say where memory goes; the only ones the pass manages. */
const HERMES_CONNECTION_FIELDS = ["mode", "api_url", "api_key"] as const;

function hermesConnectionFields(
  connection: Pick<HindsightConnection, "baseUrl" | "apiKey">,
): Record<string, unknown> {
  return {
    mode: isHindsightCloud(connection.baseUrl) ? "cloud" : "local_external",
    api_url: connection.baseUrl,
    ...(connection.apiKey === null ? {} : { api_key: connection.apiKey }),
  };
}

/**
 * The config with its connection fields set for `connection` and every other
 * field as it is, or null when they already match, so edits Hermes or its
 * owner made to the rest are kept.
 */
function reconcileHermesConnection(
  current: Record<string, unknown>,
  connection: Pick<HindsightConnection, "baseUrl" | "apiKey">,
): string | null {
  const wanted = hermesConnectionFields(connection);
  const drifted = HERMES_CONNECTION_FIELDS.some((key) => current[key] !== wanted[key]);
  if (!drifted) return null;
  const next: Record<string, unknown> = { ...current };
  for (const key of HERMES_CONNECTION_FIELDS) delete next[key];
  return `${JSON.stringify({ ...next, ...wanted }, null, 2)}\n`;
}

/**
 * The config without its connection fields, or null when nothing beyond
 * what T3 Code wrote is left in it and the file can go.
 */
function withoutHermesConnection(current: Record<string, unknown>): string | null {
  const rest: Record<string, unknown> = { ...current };
  for (const key of HERMES_CONNECTION_FIELDS) delete rest[key];
  const keys = Object.keys(rest);
  if (keys.length === 0 || (keys.length === 1 && rest["bank_id"] === "hermes")) return null;
  return `${JSON.stringify(rest, null, 2)}\n`;
}

/** A server's host, for naming it to a client without credentials or a query. */
function hindsightServerHost(url: string): string {
  try {
    return new URL(url.trim()).host;
  } catch {
    return "another address";
  }
}

/** Whether an agent's hook config carries an entry the installer wrote. */
function hasInstallerHook(hooks: unknown): boolean {
  return hooks !== null && hooks !== undefined && JSON.stringify(hooks).includes(INSTALLER_MARKER);
}

/** The installer's failure as one short line, with the key never echoed back. */
function summarizeFailure(output: ProcessRunner.ProcessRunOutput, apiKey: string | null): string {
  if (output.timedOut) return "Hindsight's installer timed out.";
  const lines = `${output.stderr}\n${output.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    // npm's own update notices come last and say nothing about the failure.
    .filter((line) => line.length > 0 && !line.startsWith("npm notice"));
  const last = lines.at(-1) ?? `exited with code ${String(output.code)}`;
  const safe = apiKey === null ? last : last.split(apiKey).join("•••");
  return `Hindsight's installer failed: ${safe.slice(0, 240)}`;
}

interface PresentAgent {
  readonly target: HindsightAgentTarget;
  /** Instance ids that use their own config home, which the installer cannot reach. */
  readonly customHomeInstances: ReadonlyArray<string>;
  /** Hermes only: its home, after the instance's `HERMES_HOME`. */
  readonly hermesHome: string | null;
}

/** Inputs a pass depends on; a settings change that leaves this alone is skipped. */
function reconcileKey(settings: ServerSettings): string {
  const instances = Object.entries(deriveProviderInstanceConfigMap(settings)).filter(
    ([, instance]) =>
      instance.driver === "hermes" ||
      CODING_AGENTS.some((agent) => agent.driver === instance.driver),
  );
  return JSON.stringify({ hindsight: settings.integrations.hindsight, instances });
}

export class HindsightAgentMemory extends Context.Service<
  HindsightAgentMemory,
  {
    /** The current state, then every change. */
    readonly changes: Stream.Stream<HindsightAgentMemoryState>;
    /** Runs a pass now and answers with where it left things. */
    readonly apply: Effect.Effect<HindsightAgentMemoryState>;
  }
>()("t3-hermes/integrations/hindsight/HindsightAgentMemory") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("HindsightAgentMemory.make")(function* (
  options: { readonly homeDir?: string } = {},
) {
  const settingsService = yield* ServerSettingsService.ServerSettingsService;
  const hindsight = yield* HindsightService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const hostEnvironment = yield* HostProcess.Environment;
  const commandAvailable = yield* CommandAvailability;
  const homeDir = options.homeDir ?? NodeOS.homedir();
  const ledgerPath = path.join(config.stateDir, LEDGER_FILE);
  const installerConfigPath =
    nonEmptyString(hostEnvironment["HINDSIGHT_CONFIG"]) ??
    path.join(homeDir, ".hindsight", "coding-agent.json");

  const isAvailable = (command: string, env: NodeJS.ProcessEnv) =>
    commandAvailable(command, { env }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const readText = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));

  const readJson = (file: string) =>
    readText(file).pipe(
      Effect.flatMap((text) =>
        text === null
          ? Effect.succeed(null)
          : decodeJson(text).pipe(Effect.orElseSucceed(() => null)),
      ),
    );

  /**
   * The ledger, empty when there is none yet, or null when one is there but
   * cannot be read: that is not proof T3 Code changed nothing.
   */
  const readLedger = Effect.gen(function* () {
    if (!(yield* fs.exists(ledgerPath).pipe(Effect.orElseSucceed(() => true)))) {
      return EMPTY_LEDGER;
    }
    const text = yield* readText(ledgerPath);
    const ledger =
      text === null ? null : yield* decodeLedger(text).pipe(Effect.orElseSucceed(() => null));
    if (ledger === null) {
      yield* Effect.logWarning("could not read the agent memory ledger", { path: ledgerPath });
    }
    return ledger;
  });

  /**
   * Whether the file now holds `contents`. A file that is there keeps its
   * mode and a new one gets `newFileMode`, set before it is published, so a
   * private config never comes back readable by others.
   */
  const writeText = Effect.fn("HindsightAgentMemory.writeText")(function* (
    filePath: string,
    contents: string,
    newFileMode?: number,
  ) {
    const mode =
      (yield* fs.stat(filePath).pipe(
        Effect.map((info) => info.mode & 0o777),
        Effect.orElseSucceed(() => undefined),
      )) ?? newFileMode;
    return yield* writeFileStringAtomically({
      filePath,
      contents,
      ...(mode === undefined ? {} : { mode }),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  });

  /** Whether `file` is gone afterwards; a missing file already is. */
  const removeFile = (file: string) =>
    fs.remove(file, { force: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  // Owner-only from the start: the installer fields it may hold carry the API key.
  const writeLedger = (ledger: AgentMemoryLedger) =>
    writeFileStringAtomically({
      filePath: ledgerPath,
      contents: `${JSON.stringify(ledger, null, 2)}\n`,
      mode: 0o600,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("could not save the agent memory ledger", { cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  /** A configured home as an absolute path, `~` meaning this host's home. */
  const resolveHomePath = (value: string) =>
    value === "~"
      ? homeDir
      : value.startsWith("~/") || value.startsWith("~\\")
        ? path.join(homeDir, value.slice(2))
        : path.resolve(value);

  /**
   * Whether a Codex shadow home still runs the shared `hooks.json`. A shadow
   * links it from the shared home when Codex starts, unless it already holds
   * a file of its own, which then never sees the installer's hooks.
   */
  const shadowSharesHooks = Effect.fn("HindsightAgentMemory.shadowSharesHooks")(function* (
    shadowHome: string,
  ) {
    const shadowHooks = path.join(resolveHomePath(shadowHome), "hooks.json");
    // Missing, or a link to a shared file not written yet: linked on the next start.
    if (!(yield* fs.exists(shadowHooks).pipe(Effect.orElseSucceed(() => false)))) return true;
    const own = yield* fs.realPath(shadowHooks).pipe(Effect.orElseSucceed(() => null));
    const shared = yield* fs
      .realPath(path.join(homeDir, ".codex", "hooks.json"))
      .pipe(Effect.orElseSucceed(() => null));
    return own !== null && own === shared;
  });

  /** Agents with an enabled instance whose CLI is actually on this host. */
  const presentAgents = Effect.fn("HindsightAgentMemory.presentAgents")(function* (
    settings: ServerSettings,
  ) {
    const instances = Object.entries(deriveProviderInstanceConfigMap(settings));
    const present: Array<PresentAgent> = [];
    for (const agent of CODING_AGENTS) {
      let found = false;
      const customHomeInstances: Array<string> = [];
      for (const [instanceId, instance] of instances) {
        if (instance.driver !== agent.driver || !resolveProviderInstanceEnabled(instance)) continue;
        const instanceConfig = asRecord(instance.config) ?? {};
        const env = yield* mergeProviderInstanceEnvironment(instance.environment, hostEnvironment);
        // Managed Codex runs a copy T3 Code installs itself, usually off PATH.
        const managed = agent.target === "codex" && instanceConfig["setupMode"] === "managed";
        const binary = nonEmptyString(instanceConfig["binaryPath"]) ?? agent.binary;
        if (!managed && !(yield* isAvailable(binary, env))) continue;
        found = true;
        // The same environment the provider is launched with, so a home
        // inherited from T3 Code's own counts too.
        // A configured `homePath` takes `~`; an inherited variable is not
        // shell-expanded, so its `~` stays literal, as the drivers read it.
        const configuredHome = nonEmptyString(instanceConfig["homePath"]);
        // Managed Codex replaces any inherited CODEX_HOME with its own layout.
        const inheritedHome = managed ? null : nonEmptyString(env[agent.homeVariable]);
        const effectiveHome =
          configuredHome !== null
            ? resolveHomePath(configuredHome)
            : inheritedHome !== null
              ? path.resolve(inheritedHome)
              : null;
        // One that is the default home is the home the installer writes.
        const ownHome =
          effectiveHome !== null && effectiveHome !== path.join(homeDir, agent.defaultHome)
            ? effectiveHome
            : null;
        // A managed instance other than the default runs from a shadow home
        // under T3 Code's state, as `resolveManagedCodexHomeLayout` places it.
        const shadowHome =
          agent.target !== "codex"
            ? null
            : (nonEmptyString(instanceConfig["shadowHomePath"]) ??
              (managed && instanceId !== "codex"
                ? path.join(config.stateDir, "providers", "codex", instanceId, "shadow")
                : null));
        if (ownHome !== null || (shadowHome !== null && !(yield* shadowSharesHooks(shadowHome)))) {
          customHomeInstances.push(instanceId);
        }
      }
      if (found) present.push({ target: agent.target, customHomeInstances, hermesHome: null });
    }
    // Resolved exactly as the connection resolver finds Hermes' config.
    const hermesHomeOf = (env: NodeJS.ProcessEnv) =>
      resolveHermesHome(env, hermesUserHome(env, homeDir));
    // Like Memory, Skills and Tasks, this follows one Hermes instance; another
    // enabled one with a home of its own is named, not wired.
    const hermes = resolveEnabledHermesInstance(settings);
    if (hermes !== null) {
      const env = yield* mergeProviderInstanceEnvironment(hermes.environment, hostEnvironment);
      const binary = nonEmptyString(hermes.settings.binaryPath) ?? "hermes";
      if (yield* isAvailable(binary, env)) {
        const hermesHome = hermesHomeOf(env);
        const otherHomes: Array<string> = [];
        for (const [instanceId, instance] of instances) {
          if (
            instanceId !== hermes.instanceId &&
            instance.driver === "hermes" &&
            resolveProviderInstanceEnabled(instance) &&
            hermesHomeOf(
              yield* mergeProviderInstanceEnvironment(instance.environment, hostEnvironment),
            ) !== hermesHome
          ) {
            otherHomes.push(instanceId);
          }
        }
        present.push({ target: "hermes", customHomeInstances: otherHomes, hermesHome });
      }
    }
    return present;
  });

  const codingAgentInstalled = (target: CodingAgentTarget) =>
    target === "claudeCode"
      ? readJson(path.join(homeDir, ".claude", "settings.json")).pipe(
          Effect.map((settings) => hasInstallerHook(asRecord(settings)?.["hooks"])),
        )
      : readJson(path.join(homeDir, ".codex", "hooks.json")).pipe(Effect.map(hasInstallerHook));

  const runInstaller = (
    action: "install" | "uninstall",
    targets: ReadonlyArray<CodingAgentTarget>,
    connection: HindsightConnection | null,
  ) =>
    runner
      .run({
        command: "npx",
        args: installerArgs(action, targets, connection),
        cwd: homeDir,
        timeout: INSTALLER_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        outputMode: "truncate",
        maxOutputBytes: INSTALLER_OUTPUT_MAX_BYTES,
      })
      .pipe(
        Effect.map((output) =>
          output.code === 0 && !output.timedOut
            ? null
            : summarizeFailure(output, connection?.apiKey ?? null),
        ),
        Effect.catch((error) =>
          Effect.logWarning("Hindsight's installer could not be started", { error }).pipe(
            Effect.as("Hindsight's installer could not be started."),
          ),
        ),
      );

  /** The installer config can hold a token, so a new one is owner-only. */
  const writeInstallerConfig = (contents: string) =>
    writeText(installerConfigPath, contents, 0o600);

  /** Drops `apiToken` from the installer's config; whether none is left. */
  const clearInstallerToken = Effect.gen(function* () {
    const record = asRecord(yield* readJson(installerConfigPath));
    if (record === null || !("apiToken" in record)) return true;
    return yield* writeInstallerConfig(withoutApiToken(record));
  });

  /** What the installer config's connection is before T3 Code changes it. */
  const snapshotInstallerConnection = Effect.gen(function* () {
    const existed = (yield* readText(installerConfigPath)) !== null;
    const fields = installerConnectionFields(asRecord(yield* readJson(installerConfigPath)));
    return { existed, fields } satisfies InstallerConnection;
  });

  /**
   * Puts the installer config's connection back; whether that is done. A file
   * that no longer parses is left for its owner to fix, and retried later.
   */
  const restoreInstallerConnection = Effect.fn("HindsightAgentMemory.restoreInstallerConnection")(
    function* (previous: InstallerConnection) {
      const text = yield* readText(installerConfigPath);
      const current = text === null ? {} : asRecord(yield* readJson(installerConfigPath));
      if (current === null) return false;
      const restored = restoredInstallerConfigText(current, previous);
      return restored === null
        ? yield* removeFile(installerConfigPath)
        : yield* writeInstallerConfig(restored);
    },
  );

  const hermesConfigFile = (home: string) => path.join(home, "config.yaml");
  const hermesHindsightFile = (home: string) => path.join(home, "hindsight", "config.json");

  /** `memory.provider`, or `undefined` when `config.yaml` exists but does not parse. */
  const readHermesProvider = (home: string) =>
    readText(hermesConfigFile(home)).pipe(
      Effect.map((text) => {
        const document = parseDocument(text ?? "");
        if (document.errors.length > 0) return undefined;
        return nonEmptyString(document.getIn(["memory", "provider"]));
      }),
    );

  /**
   * Sets or clears `memory.provider`. Never rewrites a `config.yaml` that does
   * not parse: a typo elsewhere in a file Hermes owns must survive this.
   */
  const writeHermesProvider = Effect.fn("HindsightAgentMemory.writeHermesProvider")(function* (
    home: string,
    provider: string | null,
  ) {
    const document = parseDocument((yield* readText(hermesConfigFile(home))) ?? "");
    if (document.errors.length > 0) return false;
    if (provider === null) {
      document.deleteIn(["memory", "provider"]);
      const memory = document.getIn(["memory"]);
      if (isMap(memory) && memory.items.length === 0) document.deleteIn(["memory"]);
    } else {
      document.setIn(["memory", "provider"], provider);
    }
    // A file left with nothing in it reads better empty than as `{}`.
    const emptied = isMap(document.contents) && document.contents.items.length === 0;
    return yield* writeText(hermesConfigFile(home), emptied ? "" : document.toString());
  });

  /** Owner-only from the start when new, because a Hindsight Cloud key may ride in it. */
  const writeHermesHindsightConfig = (home: string, contents: string) =>
    writeText(hermesHindsightFile(home), contents, 0o600);

  const state = yield* SubscriptionRef.make<HindsightAgentMemoryState>(INITIAL_STATE);
  const lock = yield* Semaphore.make(1);
  const markApplying = SubscriptionRef.update(state, (current) => ({ ...current, applying: true }));

  /**
   * Takes T3 Code's connection back out of a Hermes Hindsight config it
   * created, keeping anything added since; whether that is done. A file that
   * no longer parses is left for its owner, and retried later.
   */
  const removeHermesConnection = Effect.fn("HindsightAgentMemory.removeHermesConnection")(
    function* (home: string) {
      const file = hermesHindsightFile(home);
      if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => true)))) return true;
      const current = asRecord(yield* readJson(file));
      if (current === null) return false;
      const rest = withoutHermesConnection(current);
      return rest === null ? yield* removeFile(file) : yield* writeText(file, rest, 0o600);
    },
  );

  /**
   * Takes out what T3 Code put into one Hermes home. Answers with what is
   * still left to undo, or null once nothing is.
   */
  const undoHermes = Effect.fn("HindsightAgentMemory.undoHermes")(function* (owned: HermesLedger) {
    let changedProvider = owned.changedProvider;
    if (changedProvider) {
      const current = yield* readHermesProvider(owned.home);
      if (current === "hindsight") {
        yield* markApplying;
        changedProvider = !(yield* writeHermesProvider(owned.home, owned.previousProvider));
      } else {
        // Someone has since picked another provider: theirs stays. A file
        // that does not parse is retried rather than given up on.
        changedProvider = current === undefined;
      }
    }
    const wroteConfig = owned.wroteConfig && !(yield* removeHermesConnection(owned.home));
    return changedProvider || wroteConfig ? { ...owned, changedProvider, wroteConfig } : null;
  });

  /**
   * One row per present agent. `wroteHermesConfig` is null when the ledger
   * could not be read, so whose Hermes config it is stays unknown.
   */
  const agentStatuses = Effect.fn("HindsightAgentMemory.agentStatuses")(function* (input: {
    readonly agents: ReadonlyArray<PresentAgent>;
    readonly failures: ReadonlyMap<HindsightAgentTarget, string>;
    readonly hermesConfig: ResolvedHindsight["hermes"];
    readonly connection: HindsightConnection | null;
    readonly wroteHermesConfig: boolean | null;
  }) {
    const { connection, hermesConfig } = input;
    const statuses: Array<HindsightAgentStatus> = [];
    for (const agent of input.agents) {
      const failure = input.failures.get(agent.target) ?? null;
      const installed =
        agent.target === "hermes"
          ? agent.hermesHome !== null &&
            hermesConfig !== null &&
            (yield* readHermesProvider(agent.hermesHome)) === "hindsight"
          : yield* codingAgentInstalled(agent.target);
      // Hermes' own Hindsight config is never rewritten, so one pointing at
      // another server, or sending another key, is named instead of
      // passing for wired to this connection. The key itself never shows.
      const ownConfig =
        agent.target === "hermes" &&
        connection !== null &&
        hermesConfig !== null &&
        input.wroteHermesConfig === false;
      const note =
        ownConfig &&
        canonicalHindsightUrl(hermesConfig.baseUrl) !== canonicalHindsightUrl(connection.baseUrl)
          ? `Not covered: uses its own Hindsight server at ${hindsightServerHost(hermesConfig.baseUrl)}.`
          : ownConfig && connection.apiKey !== null && hermesConfig.apiKey !== connection.apiKey
            ? "Not covered: uses its own API key for this server."
            : agent.customHomeInstances.length > 0
              ? `Not covered: ${agent.customHomeInstances.join(", ")} (own config home).`
              : null;
      statuses.push({
        target: agent.target,
        state: failure !== null ? "failed" : installed ? "installed" : "notInstalled",
        detail: failure ?? note,
      });
    }
    return statuses;
  });

  const pass = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings === null) return yield* SubscriptionRef.get(state);
    const desired = settings.integrations.hindsight.agentMemory;
    const resolved = yield* hindsight.resolveConnection;
    const agents = yield* presentAgents(settings);
    const ledger = yield* readLedger;
    // A connection found only in the Hermes config T3 Code itself wrote is
    // circular: it is the server T3 Code was handed, not one this machine
    // has. It counts as none, so that config is taken back out with the rest.
    const circular =
      ledger !== null &&
      ledger.hermes?.wroteConfig === true &&
      resolved.connection?.source === "hermes" &&
      resolved.hermes?.configPath === hermesHindsightFile(ledger.hermes.home);
    const connection = circular ? null : resolved.connection;
    if (ledger === null) {
      // Changing anything now could leave a change T3 Code cannot undo.
      return {
        applying: false,
        blocker: null,
        agents: yield* agentStatuses({
          agents,
          failures: new Map(),
          hermesConfig: resolved.hermes,
          connection,
          wroteHermesConfig: null,
        }),
        detail:
          "T3 Code could not read its record of what it changed here, so it changed nothing. The server log has the details.",
      } satisfies HindsightAgentMemoryState;
    }
    let nextLedger = ledger;
    let blocker: HindsightAgentMemoryBlocker | null =
      desired && connection === null ? "notConfigured" : null;
    let detail: string | null = null;
    const failures = new Map<HindsightAgentTarget, string>();
    // Wired only while there is a server to point them at.
    const wire = desired && connection !== null;

    /**
     * Saves the ledger. Called with what is about to change before changing
     * it, so a crash or a failed write never leaves a change T3 Code cannot
     * find to undo; on `false` the change must not be made.
     */
    let persisted = ledger;
    const persist = Effect.fn("HindsightAgentMemory.persist")(function* (next: AgentMemoryLedger) {
      if (next === persisted) return true;
      if (!(yield* writeLedger(next))) {
        detail =
          "T3 Code could not save what it changes, so it changed nothing. The server log has the details.";
        return false;
      }
      persisted = next;
      return true;
    });

    const coding = agents.flatMap((agent) =>
      agent.target === "claudeCode" || agent.target === "codex" ? [agent.target] : [],
    );

    if (desired && connection !== null && coding.length > 0) {
      const wiredBefore = new Set<CodingAgentTarget>();
      for (const target of coding) {
        if (yield* codingAgentInstalled(target)) wiredBefore.add(target);
      }
      const installerConfigExists = yield* fs
        .exists(installerConfigPath)
        .pipe(Effect.orElseSucceed(() => true));
      const installerConfig = yield* readJson(installerConfigPath);
      const configMatches = installerConfigMatches(installerConfig, connection);
      if (installerConfigExists && asRecord(installerConfig) === null) {
        // Hindsight's own config is there but unreadable: the installer would
        // replace it, and switching off could not put it back.
        for (const target of coding) {
          failures.set(
            target,
            "Hindsight's installer config could not be read, so it was left alone.",
          );
        }
      } else if (!configMatches || wiredBefore.size < coding.length) {
        if (!(yield* isAvailable("npx", hostEnvironment))) {
          blocker = "nodeMissing";
        } else {
          yield* markApplying;
          // Claimed before the installer runs; uninstalling an agent a failed
          // install never reached is harmless.
          const ownedByT3 = new Set([
            ...ledger.codingAgents,
            ...coding.filter((target) => !wiredBefore.has(target)),
          ]);
          const claimed: AgentMemoryLedger = {
            ...nextLedger,
            codingAgents: [...ownedByT3],
            installerConnection:
              nextLedger.installerConnection ?? (yield* snapshotInstallerConnection),
          };
          const saved = yield* persist(claimed);
          if (persisted === claimed) nextLedger = claimed;
          // The installer never clears a token it is not given, so one the
          // connection no longer has goes first: the hooks must never point at
          // a new server while still holding the old server's key.
          const failure = !saved
            ? "T3 Code could not save what it changes, so the installer was not run."
            : connection.apiKey === null && !(yield* clearInstallerToken)
              ? "The removed API key could not be cleared from Hindsight's config, so the installer was not run."
              : yield* runInstaller("install", coding, connection);
          if (failure !== null) {
            for (const target of coding) failures.set(target, failure);
          }
        }
      }
    }

    // What T3 Code wired but should not be wired now: the switch is off, there
    // is no server, or the agent is no longer set up here.
    const wanted: ReadonlyArray<CodingAgentTarget> = wire ? coding : [];
    const unwanted = nextLedger.codingAgents.filter((target) => !wanted.includes(target));
    if (unwanted.length > 0) {
      if (!(yield* isAvailable("npx", hostEnvironment))) {
        blocker = "nodeMissing";
      } else {
        yield* markApplying;
        const failure = yield* runInstaller("uninstall", unwanted, null);
        if (failure === null) {
          nextLedger = {
            ...nextLedger,
            codingAgents: nextLedger.codingAgents.filter((target) => wanted.includes(target)),
          };
        } else {
          for (const target of unwanted) failures.set(target, failure);
          if (unwanted.some((target) => !coding.includes(target))) {
            detail = failure;
          }
        }
      }
    }
    // Only once nothing T3 Code wired is left, so its hooks never run against it.
    if (
      wanted.length === 0 &&
      nextLedger.codingAgents.length === 0 &&
      nextLedger.installerConnection !== undefined
    ) {
      if (yield* restoreInstallerConnection(nextLedger.installerConnection)) {
        nextLedger = { codingAgents: nextLedger.codingAgents, hermes: nextLedger.hermes };
      } else {
        const failure = "Hindsight's config could not be put back as it was.";
        for (const target of coding) failures.set(target, failure);
        // With no Claude Code or Codex row left to carry it, the machine does.
        if (coding.length === 0) detail = failure;
      }
    }

    const hermes = agents.find((agent) => agent.target === "hermes");
    if (desired && connection !== null && hermes?.hermesHome) {
      const home = hermes.hermesHome;
      // A home T3 Code wired before `HERMES_HOME` moved is put back first.
      let owned = nextLedger.hermes;
      if (owned !== null && owned.home !== home) {
        owned = yield* undoHermes(owned);
        nextLedger = { ...nextLedger, hermes: owned };
      }
      const provider = yield* readHermesProvider(home);
      if (owned !== null && owned.home !== home) {
        failures.set(
          "hermes",
          `Hermes' previous home (${owned.home}) could not be put back, so this one was left alone.`,
        );
      } else if (provider === undefined) {
        failures.set("hermes", "Hermes' config.yaml could not be parsed, so it was left alone.");
      } else {
        // A config T3 Code created follows the connection, in its connection
        // fields only. Hermes' own is never written, and one that does not read
        // (or no longer parses) is left alone with Hermes not switched onto it.
        const configFile = hermesHindsightFile(home);
        const configExists = yield* fs.exists(configFile).pipe(Effect.orElseSucceed(() => true));
        // A config T3 Code created and someone has since deleted is no longer
        // its own: whatever Hermes falls back to is Hermes'.
        if (owned !== null && owned.wroteConfig && !configExists) {
          owned = owned.changedProvider ? { ...owned, wroteConfig: false } : null;
          nextLedger = { ...nextLedger, hermes: owned };
        }
        const ownsConfig = owned?.wroteConfig === true;
        const current = configExists ? asRecord(yield* readJson(configFile)) : null;
        const unusable =
          configExists && (current === null || (!ownsConfig && resolved.hermes === null));
        if (unusable) {
          failures.set(
            "hermes",
            "Hermes' Hindsight config could not be read, so Hermes was left alone.",
          );
        }
        const nextConfig = unusable
          ? null
          : !configExists
            ? resolved.hermes === null
              ? hermesHindsightConfigText(connection)
              : null
            : ownsConfig && current !== null
              ? reconcileHermesConnection(current, connection)
              : null;
        const intendSwitch = !unusable && provider !== "hindsight";
        const previousProvider = owned?.changedProvider ? owned.previousProvider : provider;
        const claimed =
          nextConfig !== null || intendSwitch
            ? yield* persist({
                ...nextLedger,
                hermes: {
                  home,
                  previousProvider,
                  changedProvider: intendSwitch || (owned?.changedProvider ?? false),
                  wroteConfig: nextConfig !== null || ownsConfig,
                },
              })
            : true;
        const wroteConfig =
          claimed && nextConfig !== null
            ? yield* writeHermesHindsightConfig(home, nextConfig)
            : false;
        if (nextConfig !== null && !wroteConfig) {
          failures.set("hermes", "Hermes' Hindsight config could not be written.");
        }
        // Only onto a config that says where to go.
        const switchProvider = intendSwitch && (nextConfig === null || wroteConfig);
        const changedProvider =
          claimed && switchProvider ? yield* writeHermesProvider(home, "hindsight") : false;
        if (switchProvider && !changedProvider) {
          failures.set("hermes", "Hermes' config.yaml could not be updated.");
        }
        if (wroteConfig || changedProvider) {
          nextLedger = {
            ...nextLedger,
            hermes: {
              home,
              previousProvider,
              changedProvider: changedProvider || (owned?.changedProvider ?? false),
              wroteConfig: wroteConfig || ownsConfig,
            },
          };
        }
      }
    } else if (nextLedger.hermes !== null) {
      // Off, no server, or Hermes no longer set up here.
      const remaining = yield* undoHermes(nextLedger.hermes);
      nextLedger = { ...nextLedger, hermes: remaining };
      if (remaining !== null) {
        const failure = "Hermes' config could not be put back yet. Retry to try again.";
        failures.set("hermes", failure);
        if (hermes === undefined) detail = failure;
      }
    }

    // What actually changed; drops a claim whose change did not happen.
    yield* persist(nextLedger);

    const after =
      nextLedger.hermes !== ledger.hermes ? yield* hindsight.resolveConnection : resolved;
    const statuses = yield* agentStatuses({
      agents,
      failures,
      hermesConfig: after.hermes,
      connection,
      wroteHermesConfig: nextLedger.hermes?.wroteConfig === true,
    });
    return {
      applying: false,
      blocker,
      agents: statuses,
      detail,
    } satisfies HindsightAgentMemoryState;
  });

  const apply = lock.withPermits(1)(
    pass.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Hindsight agent memory pass failed", cause).pipe(
          Effect.andThen(SubscriptionRef.get(state)),
          Effect.map((current): HindsightAgentMemoryState => ({
            ...current,
            applying: false,
            detail: "Applying agent memory failed. The server log has the details.",
          })),
        ),
      ),
      Effect.tap((next) => SubscriptionRef.set(state, next)),
    ),
  );

  // Subscribe before the first pass so a change made while it runs is not missed.
  const settingsChanges = yield* settingsService.subscribeChanges;
  const initialSettings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
  let lastKey = initialSettings === null ? null : reconcileKey(initialSettings);
  yield* apply.pipe(
    Effect.andThen(
      settingsChanges.pipe(
        Stream.runForEach((next) => {
          const key = reconcileKey(next);
          if (key === lastKey) return Effect.void;
          lastKey = key;
          return apply;
        }),
      ),
    ),
    Effect.forkScoped,
  );

  return HindsightAgentMemory.of({ changes: SubscriptionRef.changes(state), apply });
});

export const layer = Layer.effect(HindsightAgentMemory, make());
