import {
  HermesChatHubsResult,
  HermesChatLinksResult,
  HermesChatListInput,
  HermesChatListResult,
  HermesChatTranscript,
  HermesChatTranscriptInput,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as HermesChatHubService from "../../../hermes/HermesChatHubService.ts";
import * as HermesChatService from "../../../hermes/HermesChatService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, HermesChatService.HermesChatService],
};

const HermesChatListTool = Tool.make("hermes_chat_list", {
  ...shared,
  description:
    "List recent Hermes gateway conversations (Discord and other messaging platforms Hermes answers on), newest activity first: sessionKey, channel or thread name, who Hermes talks to, last activity, and a preview. Read-only. availability says why the list is empty when it is not 'ready'.",
  parameters: HermesChatListInput,
  success: HermesChatListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const HermesChatReadTool = Tool.make("hermes_chat_read", {
  ...shared,
  description:
    "Read one Hermes gateway conversation by its sessionKey (from hermes_chat_list), across every Hermes session under that key, oldest first. Returns the newest messages up to limit (default and max 500); truncated says older ones exist. Tool activity comes as one-line 'tool' messages. Read-only: nothing here can reply on the platform.",
  parameters: HermesChatTranscriptInput,
  success: HermesChatTranscript,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const hubShared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    HermesChatHubService.HermesChatHubService,
  ],
};

/** Link tools check the caller's write access, which reads its thread. */
const linkShared = {
  ...hubShared,
  dependencies: [...hubShared.dependencies, ThreadManagementService.ThreadManagementService],
};

const HermesHubListTool = Tool.make("hermes_hub_list", {
  ...hubShared,
  description:
    "List the external thread hubs configured in this environment: each hub's id, name, pinned threadId (null while it has none), the Discord channel ids it collects, whether new conversations link automatically, the cap, and how many conversations are linked now. Read-only.",
  success: HermesChatHubsResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const HermesChatLinkTargetInput = Schema.Struct({
  sessionKey: TrimmedNonEmptyString,
  /** Hub id or name; omit to target the calling thread. */
  hub: Schema.optional(TrimmedNonEmptyString),
});

const HermesChatLinkTool = Tool.make("hermes_chat_link", {
  ...linkShared,
  description:
    "Link a Hermes gateway conversation (sessionKey from hermes_chat_list) into a thread, so its card appears in that thread's timeline and is refreshed as the conversation moves. Links to the calling thread, or with hub (id or name from hermes_hub_list) to that hub's thread. Returns every link that holds afterwards.",
  parameters: HermesChatLinkTargetInput,
  success: HermesChatLinksResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const HermesChatUnlinkTool = Tool.make("hermes_chat_unlink", {
  ...linkShared,
  description:
    "Detach a linked Hermes gateway conversation from the calling thread, or with hub (id or name) from that hub's thread. Existing cards stay in the timeline; they just stop updating. Returns every link that holds afterwards.",
  parameters: HermesChatLinkTargetInput,
  success: HermesChatLinksResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const HermesChatToolkit = Toolkit.make(
  HermesChatListTool,
  HermesChatReadTool,
  HermesHubListTool,
  HermesChatLinkTool,
  HermesChatUnlinkTool,
);
