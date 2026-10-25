// @effect-diagnostics nodeBuiltinImport:off
/**
 * Pins what a Hermes upgrade can quietly break: the levels a model is offered (from
 * `models_dev_cache.json`) and what a write does to `config.yaml`. Ceiling and forced-thinking
 * cases port Hermes's own rules.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  HERMES_REASONING_LEVELS,
  classifyZaiGlm,
  isPreAdaptiveAnthropic,
  parseHermesModelSlug,
  readModelsDevCache,
  resolveHermesReasoningLevels,
  resolveHermesReasoningPaths,
  type ModelsDevCache,
} from "./hermesReasoning.ts";
import {
  hermesReasoningOverrideKey,
  readHermesConfigSync,
  resolveHermesReasoningFromConfig,
  writeHermesReasoningOverride,
} from "./hermesReasoningConfig.ts";
import {
  HERMES_REASONING_DEFAULT_CHOICE_ID,
  HERMES_REASONING_OPTION_ID,
  applyHermesReasoningSelection,
  buildHermesModelCapabilities,
  resolveHermesReasoningSelection,
} from "./hermesReasoningOptions.ts";

/** The slice of models.dev's `api.json` the resolver reads. */
function modelsDevCache(
  providers: Readonly<Record<string, ReadonlyArray<readonly [string, boolean]>>>,
): ModelsDevCache {
  return Object.fromEntries(
    Object.entries(providers).map(([provider, models]) => [
      provider,
      { models: Object.fromEntries(models.map(([id, reasoning]) => [id, { reasoning }])) },
    ]),
  );
}

function withTempDir<A>(run: (dir: string) => A): A {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-reasoning-"));
  try {
    return run(dir);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs an effect that needs a real filesystem against a scratch directory. */
const withConfigFile = <A>(
  initialContents: string | null,
  run: (configFile: string) => Effect.Effect<A, never, NodeServices.NodeServices>,
) =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-config-"));
    const configFile = NodePath.join(dir, "config.yaml");
    if (initialContents !== null) NodeFS.writeFileSync(configFile, initialContents, "utf8");
    return yield* run(configFile).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const FULL_LADDER = [...HERMES_REASONING_LEVELS];
/** OpenAI's 5.6 family: the ladder up to `max`, with no `ultra` tier. */
const GPT_56_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

describe("resolveHermesReasoningPaths", () => {
  it("prefers HERMES_HOME over the home directory", () => {
    expect(resolveHermesReasoningPaths({ HERMES_HOME: "/srv/hermes" }, "/home/nate")).toEqual({
      home: "/srv/hermes",
      configFile: NodePath.join("/srv/hermes", "config.yaml"),
      modelsDevCacheFile: NodePath.join("/srv/hermes", "models_dev_cache.json"),
    });
    expect(resolveHermesReasoningPaths({}, "/home/nate").home).toBe(
      NodePath.join("/home/nate", ".hermes"),
    );
  });
});

describe("parseHermesModelSlug", () => {
  it("splits the provider prefix and keeps the vendor namespace", () => {
    expect(parseHermesModelSlug("openrouter:moonshotai/kimi-k2")).toEqual({
      provider: "openrouter",
      model: "moonshotai/kimi-k2",
      bare: "kimi-k2",
    });
  });

  it("treats a bare slug as having no provider", () => {
    expect(parseHermesModelSlug("gpt-5.4")).toEqual({
      provider: null,
      model: "gpt-5.4",
      bare: "gpt-5.4",
    });
  });

  it("keeps a trailing tag on the model rather than reading it as a prefix", () => {
    expect(parseHermesModelSlug("ollama:kimi-k2.6:cloud")?.model).toBe("kimi-k2.6:cloud");
  });

  it("rejects blank and prefix-only slugs", () => {
    expect(parseHermesModelSlug(null)).toBeNull();
    expect(parseHermesModelSlug("   ")).toBeNull();
    expect(parseHermesModelSlug("openai:")).toBeNull();
  });
});

describe("named custom endpoint reasoning", () => {
  const levels = ["low", "medium", "high", "xhigh", "max"];
  const cache: ModelsDevCache = {
    openai: {
      models: {
        "gpt-6-astra": {
          reasoning: true,
          reasoning_options: [{ type: "effort", values: levels }],
        },
      },
    },
  };
  const slug = "custom:cliproxyapi:gpt-6-astra";

  it("keeps the named endpoint separate from the model and its tags", () => {
    expect(parseHermesModelSlug(slug)).toEqual({
      provider: "custom:cliproxyapi",
      model: "gpt-6-astra",
      bare: "gpt-6-astra",
    });
    expect(parseHermesModelSlug("custom:ollama:vendor/model:cloud")?.model).toBe(
      "vendor/model:cloud",
    );
    expect(parseHermesModelSlug("custom:cliproxyapi:")).toBeNull();
    expect(hermesReasoningOverrideKey(slug)).toBe("gpt-6-astra");
  });

  it("uses explicit catalogue effort options for native and custom providers", () => {
    for (const model of [slug, "openai:gpt-6-astra", "cliproxyapi:gpt-6-astra"]) {
      expect(resolveHermesReasoningLevels({ slug: model, cache })).toEqual(levels);
    }
  });

  it("filters unknown effort values without bypassing provider exclusions", () => {
    for (const values of [[], ["unsupported"], ["high", "high", "unsupported"]]) {
      const entry = { reasoning: true, reasoning_options: [{ type: "effort", values }] };
      expect(
        resolveHermesReasoningLevels({
          slug,
          cache: { openai: { models: { "gpt-6-astra": entry } } },
        }),
      ).toEqual(values.includes("high") ? ["high"] : []);
      expect(
        resolveHermesReasoningLevels({
          slug: "zai:glm-4.7",
          cache: { zai: { models: { "glm-4.7": entry } } },
        }),
      ).toEqual([]);
    }
  });

  it("builds the selector and validates selections against the same ladder", () => {
    const capabilities = buildHermesModelCapabilities({
      slug,
      context: {
        cache,
        config: { agent: { reasoning_overrides: { "gpt-6-astra": "high" } } },
        configFile: "/unused",
      },
    });
    expect(capabilities.optionDescriptors).toMatchObject([
      {
        id: "reasoningEffort",
        currentValue: "high",
        options: [{ id: "default" }, ...levels.map((id) => ({ id }))],
      },
    ]);
    expect(
      resolveHermesReasoningSelection({
        slug,
        cache,
        selections: [{ id: "reasoningEffort", value: "max" }],
      }),
    ).toBe("max");
    expect(
      resolveHermesReasoningSelection({
        slug,
        cache,
        selections: [{ id: "reasoningEffort", value: "ultra" }],
      }),
    ).toBeUndefined();
  });
});

describe("readModelsDevCache", () => {
  it("returns null when the cache is missing", () => {
    withTempDir((dir) => {
      expect(readModelsDevCache(NodePath.join(dir, "models_dev_cache.json"))).toBeNull();
    });
  });

  it("returns null for a corrupt cache rather than treating it as empty", () => {
    withTempDir((dir) => {
      const file = NodePath.join(dir, "models_dev_cache.json");
      NodeFS.writeFileSync(file, "{ this is not json", "utf8");
      expect(readModelsDevCache(file)).toBeNull();
    });
  });

  it("returns null for an empty object, which would otherwise read as 'nothing reasons'", () => {
    withTempDir((dir) => {
      const file = NodePath.join(dir, "models_dev_cache.json");
      NodeFS.writeFileSync(file, "{}", "utf8");
      expect(readModelsDevCache(file)).toBeNull();
      NodeFS.writeFileSync(file, "[]", "utf8");
      expect(readModelsDevCache(file)).toBeNull();
    });
  });

  it("reads a well-formed cache", () => {
    withTempDir((dir) => {
      const file = NodePath.join(dir, "models_dev_cache.json");
      NodeFS.writeFileSync(
        file,
        JSON.stringify(modelsDevCache({ openai: [["gpt-5.4", true]] })),
        "utf8",
      );
      expect(readModelsDevCache(file)).not.toBeNull();
    });
  });
});

describe("resolveHermesReasoningLevels", () => {
  const cache = modelsDevCache({
    openrouter: [
      ["moonshotai/kimi-k2", true],
      ["mistralai/mistral-large", false],
    ],
    openai: [
      ["gpt-5.4", true],
      ["gpt-5.5", true],
      ["gpt-5.6", true],
      ["gpt-5.6-sol", true],
      ["gpt-5.6-luna", true],
      ["o3", true],
    ],
    google: [["gemini-3-pro", true]],
    anthropic: [
      ["claude-sonnet-4-5", true],
      ["claude-opus-4-6", true],
    ],
    zai: [
      ["glm-4.7", true],
      ["glm-4.6", true],
      ["glm-5.2", true],
    ],
  });

  it("offers the full ladder for a model models.dev says reasons", () => {
    expect(resolveHermesReasoningLevels({ slug: "openrouter:moonshotai/kimi-k2", cache })).toEqual(
      FULL_LADDER,
    );
  });

  it("offers nothing for a model models.dev says does not reason", () => {
    expect(
      resolveHermesReasoningLevels({ slug: "openrouter:mistralai/mistral-large", cache }),
    ).toEqual([]);
  });

  it("has no opinion about a model the catalogue does not list", () => {
    expect(resolveHermesReasoningLevels({ slug: "openai:gpt-6", cache })).toBeNull();
  });

  it("resolves custom proxy models through their vendor with the vendor's limits", () => {
    for (const slug of ["cliproxyapi:gpt-5.6-luna", "custom:openai/gpt-5.6-luna"]) {
      expect(resolveHermesReasoningLevels({ slug, cache })).toEqual(GPT_56_LADDER);
    }
    expect(resolveHermesReasoningLevels({ slug: "cliproxyapi:o3", cache })).toEqual([
      "low",
      "medium",
      "high",
    ]);
    for (const slug of ["cliproxyapi:claude-sonnet-4-5", "custom:gemini-3-pro"]) {
      expect(resolveHermesReasoningLevels({ slug, cache })).toEqual([
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
    }
    expect(resolveHermesReasoningLevels({ slug: "custom:gpt-6", cache })).toBeNull();
    expect(resolveHermesReasoningLevels({ slug: "custom:unknown", cache })).toBeNull();
  });

  it("preserves a listed provider's answer instead of falling back to the vendor", () => {
    expect(
      resolveHermesReasoningLevels({
        slug: "cliproxyapi:gpt-5.6-luna",
        cache: { ...cache, ...modelsDevCache({ cliproxyapi: [["gpt-5.6-luna", false]] }) },
      }),
    ).toEqual([]);
    expect(
      resolveHermesReasoningLevels({
        slug: "openrouter:gpt-5.6-luna",
        cache,
      }),
    ).toBeNull();
  });

  it("has no opinion when the catalogue is unavailable", () => {
    expect(
      resolveHermesReasoningLevels({ slug: "openrouter:moonshotai/kimi-k2", cache: null }),
    ).toBeNull();
  });

  it("has no opinion about a slug with no provider prefix to look up", () => {
    expect(resolveHermesReasoningLevels({ slug: "gpt-5.4", cache })).toBeNull();
  });

  it("matches the catalogue case-insensitively", () => {
    expect(
      resolveHermesReasoningLevels({
        slug: "openai:GPT-5.6",
        cache,
      }),
    ).toEqual(GPT_56_LADDER);
  });

  it("finds a model the catalogue keys under a cloud suffix", () => {
    expect(
      resolveHermesReasoningLevels({
        slug: "openrouter:moonshotai/kimi-k2",
        cache: modelsDevCache({ openrouter: [["moonshotai/kimi-k2:cloud", true]] }),
      }),
    ).toEqual(FULL_LADDER);
  });

  it("resolves a Hermes provider id the catalogue spells differently", () => {
    expect(
      resolveHermesReasoningLevels({
        slug: "gemini:gemini-3-pro",
        // `gemini` is Hermes's id; models.dev keys it as `google`.
        cache,
      }),
    ).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  });

  describe("provider ceilings", () => {
    it("caps GPT-5.5 and earlier at xhigh, and the 5.6 family at max", () => {
      // models.dev: gpt-5.4 and gpt-5.5 stop at xhigh; the 5.6 family adds a
      // `max` tier. Nothing in the OpenAI lane takes `ultra`.
      for (const slug of ["openai:gpt-5.4", "openai:gpt-5.5"]) {
        expect(resolveHermesReasoningLevels({ slug, cache })).toEqual([
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
        ]);
      }
      for (const slug of ["openai:gpt-5.6", "openai:gpt-5.6-sol"]) {
        expect(resolveHermesReasoningLevels({ slug, cache })).toEqual(GPT_56_LADDER);
      }
    });

    it("offers the o-series only the three levels it documents", () => {
      expect(resolveHermesReasoningLevels({ slug: "openai:o3", cache })).toEqual([
        "low",
        "medium",
        "high",
      ]);
    });

    it("caps pre-adaptive Claude at xhigh and leaves 4.6 uncapped", () => {
      expect(resolveHermesReasoningLevels({ slug: "anthropic:claude-sonnet-4-5", cache })).toEqual([
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      expect(resolveHermesReasoningLevels({ slug: "anthropic:claude-opus-4-6", cache })).toEqual(
        FULL_LADDER,
      );
    });

    it("classifies Claude versions without reading a date stamp as a minor version", () => {
      expect(isPreAdaptiveAnthropic("claude-3-5-sonnet")).toBe(true);
      expect(isPreAdaptiveAnthropic("claude-sonnet-4-5-20250929")).toBe(true);
      expect(isPreAdaptiveAnthropic("claude-opus-4-6")).toBe(false);
      expect(isPreAdaptiveAnthropic("claude-sonnet-latest")).toBe(false);
      expect(isPreAdaptiveAnthropic("gpt-5.4")).toBe(false);
    });
  });

  describe("forced-thinking exclusions", () => {
    it("offers no ladder for the GLM-4.7 family, which cannot be configured", () => {
      expect(resolveHermesReasoningLevels({ slug: "zai:glm-4.7", cache })).toEqual([]);
      expect(classifyZaiGlm(parseHermesModelSlug("zai:glm-4.7")!)).toBe("forced");
    });

    it("offers no ladder for the on/off-only GLM tier", () => {
      expect(resolveHermesReasoningLevels({ slug: "zai:glm-4.6", cache })).toEqual([]);
      expect(classifyZaiGlm(parseHermesModelSlug("zai:glm-4.6")!)).toBe("thinking");
    });

    it("offers the ladder for the GLM tier that accepts it", () => {
      expect(resolveHermesReasoningLevels({ slug: "zai:glm-5.2", cache })).toEqual(FULL_LADDER);
    });

    it("does not apply the GLM rules to a GLM served by another provider", () => {
      expect(classifyZaiGlm(parseHermesModelSlug("openrouter:z-ai/glm-4.7")!)).toBeNull();
    });
  });
});

describe("resolveHermesReasoningFromConfig", () => {
  const config = {
    agent: {
      reasoning_effort: "medium",
      reasoning_overrides: { "gpt-5.4": "xhigh", "Claude-Sonnet-4-5": "high" },
    },
  };

  it("prefers a per-model override over the global level", () => {
    expect(resolveHermesReasoningFromConfig({ config, slug: "openai:gpt-5.4" })).toEqual({
      level: "xhigh",
      source: "per-model",
    });
  });

  it("matches an override the user spelled with different case", () => {
    expect(
      resolveHermesReasoningFromConfig({ config, slug: "anthropic:claude-sonnet-4-5" }).level,
    ).toBe("high");
  });

  it("matches an override the user hand-wrote with dashes where Hermes uses dots", () => {
    expect(
      resolveHermesReasoningFromConfig({
        config: { agent: { reasoning_overrides: { "gpt-5-4": "xhigh" } } },
        slug: "openai:gpt-5.4",
      }).level,
    ).toBe("xhigh");
  });

  it("falls back to the global level for a model with no override", () => {
    expect(resolveHermesReasoningFromConfig({ config, slug: "openai:gpt-5.6" })).toEqual({
      level: "medium",
      source: "global",
    });
  });

  it("reports a disabled override as a level-less per-model setting, not as unset", () => {
    expect(
      resolveHermesReasoningFromConfig({
        config: { agent: { reasoning_effort: "high", reasoning_overrides: { "gpt-5.4": false } } },
        slug: "openai:gpt-5.4",
      }),
    ).toEqual({ level: null, source: "per-model" });
  });

  it("reads an absent, empty, or non-object config as unset", () => {
    for (const value of [null, undefined, "", 7, [], {}, { agent: null }, { agent: {} }]) {
      expect(resolveHermesReasoningFromConfig({ config: value, slug: "openai:gpt-5.4" })).toEqual({
        level: null,
        source: "unset",
      });
    }
  });
});

describe("readHermesConfigSync", () => {
  it("reads a missing or unparseable config as null", () => {
    withTempDir((dir) => {
      const file = NodePath.join(dir, "config.yaml");
      expect(readHermesConfigSync(file)).toBeNull();
      NodeFS.writeFileSync(file, "agent:\n  reasoning_effort: [unclosed\n", "utf8");
      expect(readHermesConfigSync(file)).toBeNull();
    });
  });

  it("reads a well-formed config as plain data", () => {
    withTempDir((dir) => {
      const file = NodePath.join(dir, "config.yaml");
      NodeFS.writeFileSync(file, "agent:\n  reasoning_effort: high\n", "utf8");
      expect(readHermesConfigSync(file)).toEqual({ agent: { reasoning_effort: "high" } });
    });
  });
});

describe("hermesReasoningOverrideKey", () => {
  it("writes under the model without its provider prefix", () => {
    expect(hermesReasoningOverrideKey("openai:gpt-5.4")).toBe("gpt-5.4");
    expect(hermesReasoningOverrideKey("openrouter:moonshotai/kimi-k2")).toBe("moonshotai/kimi-k2");
    expect(hermesReasoningOverrideKey("  ")).toBeNull();
  });
});

describe("writeHermesReasoningOverride", () => {
  const write = (configFile: string, slug: string, level: "high" | "xhigh" | null) =>
    writeHermesReasoningOverride({ configFile, slug, level });

  it.effect("adds an override to a config that has none, keeping unrelated keys and comments", () =>
    withConfigFile(
      [
        "# my hermes config",
        "model:",
        "  default: openai:gpt-5.4",
        "agent:",
        "  temperature: 0.3",
        "",
      ].join("\n"),
      (configFile) =>
        Effect.gen(function* () {
          const outcome = yield* write(configFile, "openai:gpt-5.4", "xhigh");
          expect(outcome).toEqual({ _tag: "written", level: "xhigh" });

          const text = NodeFS.readFileSync(configFile, "utf8");
          expect(text).toContain("# my hermes config");
          expect(text).toContain("temperature: 0.3");
          expect(readHermesConfigSync(configFile)).toEqual({
            model: { default: "openai:gpt-5.4" },
            agent: { temperature: 0.3, reasoning_overrides: { "gpt-5.4": "xhigh" } },
          });
        }),
    ),
  );

  it.effect("creates the config when it does not exist yet", () =>
    withConfigFile(null, (configFile) =>
      Effect.gen(function* () {
        expect(yield* write(configFile, "openai:gpt-5.4", "high")).toEqual({
          _tag: "written",
          level: "high",
        });
        expect(readHermesConfigSync(configFile)).toEqual({
          agent: { reasoning_overrides: { "gpt-5.4": "high" } },
        });
      }),
    ),
  );

  it.effect("leaves the global level alone when it writes a per-model override", () =>
    withConfigFile("agent:\n  reasoning_effort: low\n", (configFile) =>
      Effect.gen(function* () {
        yield* write(configFile, "openai:gpt-5.4", "high");
        expect(readHermesConfigSync(configFile)).toEqual({
          agent: { reasoning_effort: "low", reasoning_overrides: { "gpt-5.4": "high" } },
        });
      }),
    ),
  );

  it.effect("does not rewrite the file when the level already matches", () =>
    withConfigFile("agent:\n  reasoning_overrides:\n    gpt-5.4: high\n", (configFile) =>
      Effect.gen(function* () {
        const before = NodeFS.statSync(configFile).mtimeMs;
        expect(yield* write(configFile, "openai:gpt-5.4", "high")).toEqual({ _tag: "unchanged" });
        expect(NodeFS.statSync(configFile).mtimeMs).toBe(before);
      }),
    ),
  );

  it.effect("clears an override and prunes the containers it created", () =>
    withConfigFile("agent:\n  reasoning_overrides:\n    gpt-5.4: high\n", (configFile) =>
      Effect.gen(function* () {
        expect(yield* write(configFile, "openai:gpt-5.4", null)).toEqual({
          _tag: "written",
          level: null,
        });
        expect(readHermesConfigSync(configFile)).toEqual({});
      }),
    ),
  );

  it.effect("keeps a sibling override and a populated agent block when clearing", () =>
    withConfigFile(
      "agent:\n  reasoning_effort: low\n  reasoning_overrides:\n    gpt-5.4: high\n    gpt-5.6: xhigh\n",
      (configFile) =>
        Effect.gen(function* () {
          yield* write(configFile, "openai:gpt-5.4", null);
          expect(readHermesConfigSync(configFile)).toEqual({
            agent: { reasoning_effort: "low", reasoning_overrides: { "gpt-5.6": "xhigh" } },
          });
        }),
    ),
  );

  it.effect("does not create a config just to record the default", () =>
    withConfigFile(null, (configFile) =>
      Effect.gen(function* () {
        expect(yield* write(configFile, "openai:gpt-5.4", null)).toEqual({ _tag: "unchanged" });
        expect(NodeFS.existsSync(configFile)).toBe(false);
      }),
    ),
  );

  it.effect("refuses to write a config it could not parse", () =>
    withConfigFile("agent:\n  reasoning_effort: [unclosed\n", (configFile) =>
      Effect.gen(function* () {
        const outcome = yield* write(configFile, "openai:gpt-5.4", "high");
        expect(outcome._tag).toBe("parseFailed");
        expect(NodeFS.readFileSync(configFile, "utf8")).toBe(
          "agent:\n  reasoning_effort: [unclosed\n",
        );
      }),
    ),
  );

  it.effect("replaces the file atomically, leaving no scratch files behind", () =>
    withConfigFile("agent:\n  temperature: 0.3\n", (configFile) =>
      Effect.gen(function* () {
        yield* write(configFile, "openai:gpt-5.4", "high");
        expect(NodeFS.readdirSync(NodePath.dirname(configFile))).toEqual(["config.yaml"]);
      }),
    ),
  );

  it.effect("ignores a slug it cannot key an override by", () =>
    withConfigFile("agent:\n  temperature: 0.3\n", (configFile) =>
      Effect.gen(function* () {
        expect(yield* write(configFile, "   ", "high")).toEqual({ _tag: "unchanged" });
      }),
    ),
  );
});

describe("buildHermesModelCapabilities", () => {
  const cache = modelsDevCache({
    openai: [
      ["gpt-5.4", true],
      ["gpt-4o", false],
      ["gpt-5.6-luna", true],
    ],
  });
  const context = { cache, config: { agent: { reasoning_effort: "high" } }, configFile: "/x" };

  it("offers and accepts reasoning for a custom proxy model", () => {
    const slug = "cliproxyapi:gpt-5.6-luna";
    const descriptor = buildHermesModelCapabilities({ slug, context }).optionDescriptors?.[0];
    expect(descriptor?.type === "select" && descriptor.options.map((option) => option.id)).toEqual([
      HERMES_REASONING_DEFAULT_CHOICE_ID,
      ...GPT_56_LADDER,
    ]);
    expect(descriptor?.currentValue).toBe("high");
    for (const [value, expected] of [
      ["max", "max"],
      ["default", null],
      ["ultra", undefined],
    ] as const) {
      expect(
        resolveHermesReasoningSelection({
          slug,
          cache,
          selections: [{ id: HERMES_REASONING_OPTION_ID, value }],
        }),
      ).toBe(expected);
    }
    expect(
      buildHermesModelCapabilities({ slug: "cliproxyapi:gpt-4o", context }).optionDescriptors,
    ).toEqual([]);
  });

  it("offers the ladder plus a way back to the Hermes default", () => {
    const descriptor = buildHermesModelCapabilities({ slug: "openai:gpt-5.4", context })
      .optionDescriptors?.[0];
    expect(descriptor?.id).toBe(HERMES_REASONING_OPTION_ID);
    expect(descriptor?.type === "select" && descriptor.options.map((option) => option.id)).toEqual([
      HERMES_REASONING_DEFAULT_CHOICE_ID,
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // The global level is what Hermes resolves for this model today.
    expect(descriptor?.currentValue).toBe("high");
  });

  it("shows the Hermes default when the configured level is off this model's ladder", () => {
    const descriptor = buildHermesModelCapabilities({
      slug: "openai:gpt-5.4",
      context: { ...context, config: { agent: { reasoning_effort: "ultra" } } },
    }).optionDescriptors?.[0];
    expect(descriptor?.currentValue).toBe(HERMES_REASONING_DEFAULT_CHOICE_ID);
  });

  it("omits the selector entirely when there is no ladder to offer", () => {
    for (const input of [
      { slug: "openai:gpt-4o", context },
      { slug: "openai:gpt-6", context },
      { slug: "openai:gpt-5.4", context: { ...context, cache: null } },
    ]) {
      expect(buildHermesModelCapabilities(input).optionDescriptors).toEqual([]);
    }
  });
});

describe("resolveHermesReasoningSelection", () => {
  const cache = modelsDevCache({
    openai: [
      ["gpt-5.4", true],
      ["gpt-4o", false],
    ],
  });
  const select = (value: string) => [{ id: HERMES_REASONING_OPTION_ID, value }];

  it("resolves a level the model offers", () => {
    expect(
      resolveHermesReasoningSelection({
        slug: "openai:gpt-5.4",
        selections: select("high"),
        cache,
      }),
    ).toBe("high");
  });

  it("resolves the default choice to clearing the override", () => {
    expect(
      resolveHermesReasoningSelection({
        slug: "openai:gpt-5.4",
        selections: select(HERMES_REASONING_DEFAULT_CHOICE_ID),
        cache,
      }),
    ).toBeNull();
  });

  it("ignores a sticky selection above this model's ceiling", () => {
    expect(
      resolveHermesReasoningSelection({
        slug: "openai:gpt-5.4",
        selections: select("ultra"),
        cache,
      }),
    ).toBeUndefined();
  });

  it("ignores a selection for a model with no ladder, and an unknown level", () => {
    expect(
      resolveHermesReasoningSelection({ slug: "openai:gpt-4o", selections: select("high"), cache }),
    ).toBeUndefined();
    expect(
      resolveHermesReasoningSelection({
        slug: "openai:gpt-5.4",
        selections: select("turbo"),
        cache,
      }),
    ).toBeUndefined();
  });

  it("ignores selections that do not mention reasoning at all", () => {
    expect(
      resolveHermesReasoningSelection({ slug: "openai:gpt-5.4", selections: [], cache }),
    ).toBeUndefined();
    expect(
      resolveHermesReasoningSelection({
        slug: "openai:gpt-5.4",
        selections: [{ id: "somethingElse", value: "high" }],
        cache,
      }),
    ).toBeUndefined();
  });
});

describe("applyHermesReasoningSelection", () => {
  /**
   * The returned level is what tells the adapter a running Hermes session needs
   * its agent rebuilt, so "wrote nothing" and "wrote a level" must stay
   * distinguishable even when the write fails.
   */
  const withHermesHome = <A>(
    files: Readonly<Record<string, string>>,
    run: (environment: NodeJS.ProcessEnv) => Effect.Effect<A, never, NodeServices.NodeServices>,
  ) =>
    Effect.gen(function* () {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-home-"));
      for (const [name, contents] of Object.entries(files)) {
        NodeFS.writeFileSync(NodePath.join(home, name), contents, "utf8");
      }
      return yield* run({ HERMES_HOME: home }).pipe(
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }).pipe(Effect.provide(NodeServices.layer));

  const cacheFile = JSON.stringify(modelsDevCache({ openai: [["gpt-5.4", true]] }));
  const selections = [{ id: HERMES_REASONING_OPTION_ID, value: "high" }];

  it.effect("writes the level and reports it", () =>
    withHermesHome({ "models_dev_cache.json": cacheFile }, (environment) =>
      Effect.gen(function* () {
        const level = yield* applyHermesReasoningSelection({
          model: "openai:gpt-5.4",
          selections,
          environment,
        });
        expect(level).toBe("high");
        expect(
          readHermesConfigSync(NodePath.join(environment["HERMES_HOME"]!, "config.yaml")),
        ).toEqual({ agent: { reasoning_overrides: { "gpt-5.4": "high" } } });
      }),
    ),
  );

  it.effect("reports the default choice as a level of its own so a rebuild still happens", () =>
    withHermesHome(
      {
        "models_dev_cache.json": cacheFile,
        "config.yaml": "agent:\n  reasoning_overrides:\n    gpt-5.4: high\n",
      },
      (environment) =>
        Effect.gen(function* () {
          expect(
            yield* applyHermesReasoningSelection({
              model: "openai:gpt-5.4",
              selections: [
                { id: HERMES_REASONING_OPTION_ID, value: HERMES_REASONING_DEFAULT_CHOICE_ID },
              ],
              environment,
            }),
          ).toBeNull();
        }),
    ),
  );

  it.effect("reports nothing when the selection says nothing about this model", () =>
    withHermesHome({ "models_dev_cache.json": cacheFile }, (environment) =>
      Effect.gen(function* () {
        for (const input of [
          { model: "openai:gpt-5.4", selections: [] },
          { model: "openai:gpt-5.4", selections: [{ id: "somethingElse", value: "high" }] },
          { model: "", selections },
          // Unknown to the catalogue, so there is no ladder to validate against.
          { model: "openai:gpt-6", selections },
        ]) {
          expect(yield* applyHermesReasoningSelection({ ...input, environment })).toBeUndefined();
        }
        expect(NodeFS.existsSync(NodePath.join(environment["HERMES_HOME"]!, "config.yaml"))).toBe(
          false,
        );
      }),
    ),
  );

  it.effect("reports nothing when the config could not be parsed, so no rebuild is claimed", () =>
    withHermesHome(
      {
        "models_dev_cache.json": cacheFile,
        "config.yaml": "agent:\n  reasoning_effort: [unclosed\n",
      },
      (environment) =>
        Effect.gen(function* () {
          expect(
            yield* applyHermesReasoningSelection({
              model: "openai:gpt-5.4",
              selections,
              environment,
            }),
          ).toBeUndefined();
        }),
    ),
  );
});
