import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HermesChatHubService from "../../../hermes/HermesChatHubService.ts";
import * as HermesChatService from "../../../hermes/HermesChatService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { HermesChatToolkit } from "./tools.ts";

/** The thread a link tool acts on: the named hub's, else the calling thread. */
const resolveLinkThread = Effect.fn("HermesChatMcp.resolveLinkThread")(function* (
  hub: string | undefined,
) {
  if (hub === undefined) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const thread = yield* McpInvocationContext.requireThreadScope(scope, "Linking without a hub");
    return thread.thread.threadId;
  }
  const service = yield* HermesChatHubService.HermesChatHubService;
  const { hubs } = yield* service.listHubs;
  const key = hub.toLowerCase();
  const match =
    hubs.find((candidate) => candidate.id.toLowerCase() === key) ??
    hubs.find((candidate) => candidate.name.toLowerCase() === key);
  if (match === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `No hub named ${hub}. hermes_hub_list lists them.`,
    });
  }
  if (match.threadId === null) {
    return yield* new OrchestratorMcpFailure({
      code: "target_required",
      message: `Hub ${match.name} has no thread yet. Pick one in Settings › Integrations › External thread hubs.`,
    });
  }
  return match.threadId satisfies ThreadId;
});

export const layer = McpToolAccess.toLayer(HermesChatToolkit, {
  hermes_chat_list: McpToolAccess.reads((input) =>
    HermesChatService.HermesChatService.pipe(Effect.flatMap((chat) => chat.list(input))),
  ),
  hermes_chat_read: McpToolAccess.reads((input) =>
    HermesChatService.HermesChatService.pipe(Effect.flatMap((chat) => chat.transcript(input))),
  ),
  hermes_hub_list: McpToolAccess.reads(() =>
    HermesChatHubService.HermesChatHubService.pipe(Effect.flatMap((hubs) => hubs.listHubs)),
  ),
  hermes_chat_link: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const threadId = yield* resolveLinkThread(input.hub);
      const service = yield* HermesChatHubService.HermesChatHubService;
      return yield* service.link({ sessionKey: input.sessionKey, threadId });
    }),
  ),
  hermes_chat_unlink: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const threadId = yield* resolveLinkThread(input.hub);
      const service = yield* HermesChatHubService.HermesChatHubService;
      return yield* service.unlink({ sessionKey: input.sessionKey, threadId });
    }),
  ),
});
