import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  SecretRef,
  SecretRequestError,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";

import * as PaperclipService from "../../../integrations/paperclip/PaperclipService.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as PaperclipHandlers from "./handlers.ts";
import { PaperclipToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:paperclip");
const REF = SecretRef.make("secretref_paperclip");
const KEY = "pcp_board_from_secret_prompt";

const layerFor = (consumed: Ref.Ref<ReadonlyArray<string>>) =>
  McpToolAccess.HandlersLayer.layer(PaperclipHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        PaperclipService.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment:paperclip"),
          requestNamespace: "provider:paperclip",
          thread: {
            threadId,
            providerSessionId: "provider:paperclip",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
        }),
        Layer.mock(SecretRequests.SecretRequests)({
          consume: (input) =>
            input.ref === REF && input.projectId === ProjectId.make("project:mcp-test")
              ? Ref.update(consumed, (refs) => [...refs, input.ref]).pipe(Effect.as(KEY))
              : Effect.fail(new SecretRequestError({ reason: "ref_unavailable" })),
        }),
      ),
    ),
    // The service is real; nothing answers on this URL, so connect reports offline.
    Layer.provideMerge(Settings.layerTest()),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.fail(new Error("connect ECONNREFUSED") as never)),
      ),
    ),
  );

const call = (name: "paperclip_connect", input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const toolkit = yield* PaperclipToolkit;
    const results = yield* toolkit
      .handle(name, input as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return results.at(-1)?.result;
  });

it.effect("saves the key from a secretRef without ever returning it", () =>
  Effect.gen(function* () {
    const consumed = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* Effect.gen(function* () {
      const result = yield* call("paperclip_connect", {
        baseUrl: "http://127.0.0.1:3100",
        secretRef: REF,
      });
      expect(result).toMatchObject({ status: { availability: "offline" } });
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(yield* Ref.get(consumed)).toEqual([REF]);

      const saved = (yield* (yield* Settings.ServerSettingsService).getSettings).integrations
        .paperclip;
      expect(saved).toMatchObject({ enabled: true, baseUrl: "http://127.0.0.1:3100", apiKey: KEY });
    }).pipe(Effect.provide(layerFor(consumed)));
  }),
);

it.effect("leaves settings alone when the secretRef is not usable", () =>
  Effect.gen(function* () {
    const consumed = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* Effect.gen(function* () {
      const result = yield* call("paperclip_connect", {
        baseUrl: "http://127.0.0.1:3100",
        secretRef: SecretRef.make("secretref_other"),
      });
      expect(result).toMatchObject({ code: "invalid_request" });
      const saved = (yield* (yield* Settings.ServerSettingsService).getSettings).integrations
        .paperclip;
      expect(saved.enabled).toBe(false);
      expect(saved.apiKey).toBeUndefined();
    }).pipe(Effect.provide(layerFor(consumed)));
  }),
);
