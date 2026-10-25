import * as Effect from "effect/Effect";

import * as HermesChatService from "../../../hermes/HermesChatService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { HermesChatToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(HermesChatToolkit, {
  hermes_chat_list: McpToolAccess.reads((input) =>
    HermesChatService.HermesChatService.pipe(Effect.flatMap((chat) => chat.list(input))),
  ),
  hermes_chat_read: McpToolAccess.reads((input) =>
    HermesChatService.HermesChatService.pipe(Effect.flatMap((chat) => chat.transcript(input))),
  ),
});
