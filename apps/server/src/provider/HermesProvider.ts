import {
  type HermesSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  HERMES_BUILT_IN_SLASH_COMMANDS,
  HERMES_FALLBACK_MODEL_ID,
  makeHermesAcpRuntime,
  resolveHermesAcpBaseModelId,
} from "./acp/HermesAcpSupport.ts";
import { dedupeSlashCommands } from "@t3tools/provider-core/server/slashCommands";
import {
  buildHermesModelCapabilities,
  readHermesReasoningContext,
  type HermesReasoningContext,
} from "../hermes/hermesReasoningOptions.ts";
import {
  HERMES_FAST_MODE_DESCRIPTOR,
  HERMES_FAST_MODE_OPTION_ID,
  hermesModelSupportsFastMode,
} from "../hermes/hermesFastMode.ts";

const HERMES_PRESENTATION = {
  displayName: "Hermes",
  reportsContextWindow: true,
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
/**
 * `compact` is T3 Code's manual-compaction entry point: ProviderService runs it
 * as Hermes's own `/compress` (see HermesAdapter's `compaction`).
 */
const withCompactCommand = (
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> =>
  dedupeSlashCommands([COMPACT_SLASH_COMMAND, ...commands]);
const HERMES_SLASH_COMMANDS = withCompactCommand(HERMES_BUILT_IN_SLASH_COMMANDS);
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 10_000;
const HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Placeholder shown before the ACP handshake reports the models Hermes
 * actually has configured in `~/.hermes/.env`.
 */
const HERMES_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: HERMES_FALLBACK_MODEL_ID,
    name: "Hermes 4",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export const buildInitialHermesProviderSnapshot = Effect.fn(
  "HermesProvider.buildInitialHermesProviderSnapshot",
)(function* (hermesSettings: HermesSettings): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const models = hermesModelsFromSettings(
    hermesSettings.customModels,
    readHermesReasoningContext(),
  );

  if (!hermesSettings.enabled) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hermes is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    presentation: HERMES_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    slashCommands: HERMES_SLASH_COMMANDS,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Hermes CLI availability...",
    },
  });
});

/**
 * Attaches the reasoning-effort selector to every model that has one and keeps fast-mode discovery
 * on the models Hermes marked, so discovered, built-in, and custom models are treated alike.
 */
function withHermesReasoningCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  context: HermesReasoningContext,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    const reasoning = buildHermesModelCapabilities({ slug: model.slug, context });
    const fastMode = model.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === HERMES_FAST_MODE_OPTION_ID,
    );
    return {
      ...model,
      capabilities:
        fastMode === undefined
          ? reasoning
          : createModelCapabilities({
              optionDescriptors: [...(reasoning.optionDescriptors ?? []), fastMode],
            }),
    };
  });
}

function hermesModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  context: HermesReasoningContext,
  builtInModels: ReadonlyArray<ServerProviderModel> = HERMES_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return withHermesReasoningCapabilities(
    providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES),
    context,
  );
}

function buildHermesDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveHermesAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: hermesModelSupportsFastMode(model)
          ? createModelCapabilities({ optionDescriptors: [HERMES_FAST_MODE_DESCRIPTOR] })
          : EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

/**
 * Upstream slugs are `provider/model`; the prefix is the upstream Hermes is
 * configured to talk to. Surfacing the distinct prefixes tells the user which
 * credentials Hermes actually resolved without reading `~/.hermes/.env`.
 */
function deriveConfiguredUpstreams(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<string> {
  const upstreams = new Set<string>();
  for (const model of modelState?.availableModels ?? []) {
    const slash = model.modelId.indexOf("/");
    if (slash <= 0) {
      continue;
    }
    const prefix = model.modelId.slice(0, slash).trim().toLowerCase();
    if (prefix) {
      upstreams.add(prefix);
    }
  }
  return [...upstreams].sort();
}

const UPSTREAM_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  google: "Google",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  groq: "Groq",
  mistral: "Mistral",
  nousresearch: "Nous Research",
  ollama: "Ollama",
  together: "Together",
  xai: "xAI",
};

/** Render the upstreams Hermes reported as an auth card subtitle. */
function formatUpstreamLabel(upstreams: ReadonlyArray<string>): string {
  return upstreams
    .map(
      (upstream) =>
        UPSTREAM_DISPLAY_NAMES[upstream] ?? upstream.charAt(0).toUpperCase() + upstream.slice(1),
    )
    .join(", ");
}

interface HermesAcpDiscovery {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly upstreams: ReadonlyArray<string>;
}

/**
 * How long the probe waits for Hermes's `available_commands_update`. Hermes schedules it on the
 * event loop immediately after `session/new` responds, so this only has to cover a round trip; on
 * timeout we keep the static seed. Deliberately short — it is wall-clock time added to every Hermes
 * health check, and missing it costs nothing but a slightly stale menu.
 */
const HERMES_ACP_COMMAND_ADVERTISEMENT_TIMEOUT_MS = 1_000;

const discoverHermesModelsViaAcp = Effect.fn("HermesProvider.discoverHermesModelsViaAcp")(
  function* (
    hermesSettings: HermesSettings,
    environment: NodeJS.ProcessEnv = process.env,
    commandAdvertisementTimeoutMs: number = HERMES_ACP_COMMAND_ADVERTISEMENT_TIMEOUT_MS,
  ) {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeHermesAcpRuntime({
      hermesSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    const advertised = yield* acp.awaitSlashCommands.pipe(
      Effect.timeoutOption(commandAdvertisementTimeoutMs),
    );
    const slashCommands = Option.getOrElse(
      Option.filter(advertised, (commands) => commands.length > 0),
      () => HERMES_BUILT_IN_SLASH_COMMANDS,
    );
    return {
      models: buildHermesDiscoveredModelsFromSessionModelState(started.sessionSetupResult.models),
      slashCommands: withCompactCommand(slashCommands),
      upstreams: deriveConfiguredUpstreams(started.sessionSetupResult.models),
    } satisfies HermesAcpDiscovery;
  },
  Effect.scoped,
);

const runHermesVersionCommand = Effect.fn("HermesProvider.runHermesVersionCommand")(function* (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const command = hermesSettings.binaryPath || "hermes";
  const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
    env: environment,
  });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options?: {
    /**
     * Overrides how long the probe waits for `available_commands_update`.
     * Tests raise this so they wait on the advertisement receipt instead of
     * racing the production deadline under parallel load.
     */
    readonly commandAdvertisementTimeoutMs?: number;
  },
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  // Read Hermes's models.dev cache and `config.yaml` once per probe: every
  // model in this snapshot resolves its reasoning ladder against the same two
  // files, and re-reading them per model would be the only I/O that scales
  // with the model count.
  const reasoningContext = readHermesReasoningContext(environment);
  const fallbackModels = hermesModelsFromSettings(hermesSettings.customModels, reasoningContext);

  if (!hermesSettings.enabled) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hermes is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runHermesVersionCommand(hermesSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Hermes CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands: HERMES_SLASH_COMMANDS,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Hermes CLI (`hermes`) is not installed or not on PATH."
          : "Failed to execute Hermes CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands: HERMES_SLASH_COMMANDS,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes CLI is installed but timed out while running `hermes --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Hermes CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands: HERMES_SLASH_COMMANDS,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverHermesModelsViaAcp(
    hermesSettings,
    environment,
    options?.commandAdvertisementTimeoutMs,
  ).pipe(Effect.timeoutOption(HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS), Effect.exit);
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Hermes ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands: HERMES_SLASH_COMMANDS,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Hermes ACP model discovery timed out after ${HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands: HERMES_SLASH_COMMANDS,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Hermes CLI is installed but ACP startup timed out after ${HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const discovery = discoveryExit.value.value;
  const discoveredModels = discovery.models;
  const models =
    discoveredModels.length > 0
      ? hermesModelsFromSettings(hermesSettings.customModels, reasoningContext, discoveredModels)
      : fallbackModels;

  // T3 Code must not read `~/.hermes/.env`, so a handshake returning models is the best credential
  // signal: Hermes lists only models it has credentials for. An empty list reads as
  // unauthenticated.
  const auth =
    discoveredModels.length > 0
      ? ({
          status: "authenticated",
          ...(discovery.upstreams.length > 0
            ? { label: formatUpstreamLabel(discovery.upstreams) }
            : {}),
        } as const)
      : ({ status: "unauthenticated" } as const);

  return buildServerProvider({
    presentation: HERMES_PRESENTATION,
    enabled: hermesSettings.enabled,
    checkedAt,
    models,
    slashCommands: discovery.slashCommands,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth,
      ...(discoveredModels.length === 0
        ? {
            message:
              "Hermes is running but reported no models. Configure provider credentials in Hermes.",
          }
        : {}),
    },
  });
});

export const enrichHermesSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
  readonly latestVersions: ProviderLatestVersions.ProviderLatestVersions["Service"];
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, input.latestVersions),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Hermes version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
