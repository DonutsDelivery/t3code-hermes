import {
  OrchestratorMcpFailure,
  PaperclipOverviewResult,
  PaperclipStatus,
  PaperclipViewer,
  SecretRef,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as PaperclipService from "../../../integrations/paperclip/PaperclipService.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PaperclipService.PaperclipService,
    Settings.ServerSettingsService,
    SecretRequests.SecretRequests,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};

const PaperclipOverviewTool = Tool.make("paperclip_overview", {
  ...shared,
  description:
    "Read the Paperclip agent company this environment is connected to: its agents and who they report to, projects, issues (open work first), recent heartbeat runs, activity, and headline counts. Read-only. status.availability says why there is nothing when it is not 'ready'; connect with paperclip_connect.",
  success: PaperclipOverviewResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const PaperclipConnectTool = Tool.make("paperclip_connect", {
  ...shared,
  description:
    "Connect this environment to Paperclip with an API key the user entered through request_secret, so the key never passes through you. Saves the URL and key in this environment's settings, switches the integration on, and returns what the key can see. Recommend a board API key minted by a Paperclip user with the company's viewer role; viewer.readOnly says whether Paperclip itself refuses its writes. Requires a live full-access calling thread.",
  parameters: Schema.Struct({
    baseUrl: TrimmedNonEmptyString.annotate({
      description:
        "Paperclip's address as this environment's server reaches it, e.g. http://host:3100.",
    }),
    secretRef: SecretRef.annotate({
      description: "From request_secret. It works once.",
    }),
    companyId: Schema.optional(TrimmedNonEmptyString).annotate({
      description: "Company to show. Omit for the first company the key can see.",
    }),
  }),
  success: Schema.Struct({
    status: PaperclipStatus,
    viewer: Schema.NullOr(PaperclipViewer),
    companyName: Schema.NullOr(Schema.String),
  }),
}).annotate(Tool.Destructive, true);

export const PaperclipToolkit = Toolkit.make(PaperclipOverviewTool, PaperclipConnectTool);
