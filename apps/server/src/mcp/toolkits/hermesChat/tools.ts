import {
  HermesChatListInput,
  HermesChatListResult,
  HermesChatTranscript,
  HermesChatTranscriptInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as HermesChatService from "../../../hermes/HermesChatService.ts";
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

export const HermesChatToolkit = Toolkit.make(HermesChatListTool, HermesChatReadTool);
