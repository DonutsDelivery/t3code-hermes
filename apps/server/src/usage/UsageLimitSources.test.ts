import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { ServerConfigStreamEvent, UsageLimitSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

const hub = (managementKey: string, enabled = true) => ({
  hub: { kind: "cliproxy", url: "http://hub.test:8317", managementKey, enabled },
});

describe("UsageLimitSources", () => {
  it.effect("keeps malformed source URLs encodable for config subscribers", () =>
    Effect.gen(function* () {
      const sources = yield* UsageLimitSources.make;
      yield* sources.refresh;
      const snapshots = yield* sources.current;
      expect(snapshots.map((source) => source.label)).toEqual([
        "local-hub",
        "opaque-hub",
        "Named hub",
        "hub.test:8317",
        "Usage limit source",
      ]);
      expect(() =>
        encodeConfigEvent({
          version: 1,
          type: "usageLimitSourcesUpdated",
          payload: { sources: snapshots },
        }),
      ).not.toThrow();
      expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
        true,
      );
    }).pipe(
      Effect.provide([
        ServerSettings.layerTest({
          usageLimitSources: {
            [UsageLimitSourceId.make("local-hub")]: {
              kind: "cliproxy",
              url: "localhost:8317",
              managementKey: "",
              enabled: true,
            },
            [UsageLimitSourceId.make("opaque-hub")]: {
              kind: "cliproxy",
              url: "file:///tmp/hub",
              managementKey: "",
              enabled: true,
            },
            [UsageLimitSourceId.make("named-hub")]: {
              kind: "cliproxy",
              url: "localhost:8317",
              label: "Named hub",
              managementKey: "",
              enabled: true,
            },
            [UsageLimitSourceId.make("valid-hub")]: {
              kind: "cliproxy",
              url: "https://hub.test:8317",
              managementKey: "",
              enabled: true,
            },
            [UsageLimitSourceId.make(" ")]: {
              kind: "cliproxy",
              url: "localhost:8317",
              managementKey: "",
              enabled: true,
            },
          },
        }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected network request")),
        ),
        NodeCrypto.layer,
      ]),
      Effect.scoped,
    ),
  );

  it.effect("does not retry a rejected management key until the source changes", () => {
    const attempts: Array<string | undefined> = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        attempts.push(request.headers.authorization);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ error: "invalid management key" }, { status: 401 }),
        );
      }),
    );
    return Effect.gen(function* () {
      const sources = yield* UsageLimitSources.UsageLimitSources;
      const settings = yield* ServerSettings.ServerSettingsService;

      yield* sources.refresh;
      yield* sources.refresh;
      expect(attempts).toEqual(["Bearer wrong"]);
      expect((yield* sources.current)[0]?.error).toContain("rejected the management key");

      yield* settings.updateSettings({ usageLimitSources: hub("fixed") });
      yield* sources.refresh;
      expect(attempts).toEqual(["Bearer wrong", "Bearer fixed"]);

      // Turning the source off and on is the way to retry an unchanged key.
      yield* settings.updateSettings({ usageLimitSources: hub("fixed", false) });
      yield* sources.refresh;
      yield* settings.updateSettings({ usageLimitSources: hub("fixed") });
      yield* sources.refresh;
      expect(attempts).toEqual(["Bearer wrong", "Bearer fixed", "Bearer fixed"]);
    }).pipe(
      Effect.provide(
        UsageLimitSources.layer.pipe(
          Layer.provideMerge(ServerSettings.layerTest({ usageLimitSources: hub("wrong") })),
          Layer.provide(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
          Layer.provide(NodeCrypto.layer),
        ),
      ),
    );
  });
});
