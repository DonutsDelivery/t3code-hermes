import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PaperclipService from "../../../integrations/paperclip/PaperclipService.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { PaperclipToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(PaperclipToolkit, {
  paperclip_overview: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const paperclip = yield* PaperclipService.PaperclipService;
      return yield* paperclip.overview({});
    }),
  ),
  paperclip_connect: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const secretRequests = yield* SecretRequests.SecretRequests;
      const settings = yield* Settings.ServerSettingsService;
      const paperclip = yield* PaperclipService.PaperclipService;

      const save = Effect.gen(function* () {
        const { caller } = yield* check;
        // A secretRef is bound to the project it was asked for in.
        if (caller === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "target_required",
            message:
              "paperclip_connect needs a calling thread: its secretRef belongs to a project.",
          });
        }
        const apiKey = yield* secretRequests
          .consume({ ref: input.secretRef, projectId: caller.projectId })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
            ),
          );
        yield* settings
          .updateSettings({
            integrations: {
              paperclip: {
                enabled: true,
                baseUrl: input.baseUrl,
                apiKey,
                companyId: input.companyId ?? "",
              },
            },
          })
          .pipe(Effect.mapError(unavailable));
      });
      yield* scope.thread === undefined ? save : executor.withLock(scope.thread.threadId, save);

      const result = yield* paperclip.overview({});
      return {
        status: result.status,
        viewer: result.viewer,
        companyName: result.company?.name ?? null,
      };
    }),
  ),
});
