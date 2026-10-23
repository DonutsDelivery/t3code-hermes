import packageJson from "../../package.json" with { type: "json" };
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

export type ServicePreflightResult =
  | {
      readonly status: "ready";
      readonly version: string;
      readonly launcherProtocol: typeof SERVICE_LAUNCHER_PROTOCOL;
    }
  | {
      readonly status: "blocked";
      readonly version: string;
      readonly reason: string;
    };

export function runServicePreflight(input: {
  readonly databasePath: string;
  readonly launcherProtocol: number;
  readonly version?: string;
}): ServicePreflightResult {
  const version = input.version ?? packageJson.version;
  if (input.launcherProtocol !== SERVICE_LAUNCHER_PROTOCOL) {
    return {
      status: "blocked",
      version,
      // A stale `t3-hermes` earlier on PATH (an old npm/nvm global) makes
      // `t3-hermes service install` reinstall itself and report success, so name the
      // exact install and the path check. The fork ships through npm, not t3.codes/install.sh.
      reason: [
        `The installed service launcher speaks protocol ${input.launcherProtocol}, but t3-hermes@${version} requires protocol ${SERVICE_LAUNCHER_PROTOCOL}.`,
        `On the server machine, run this exact CLI: \`npx t3-hermes@${version} service install\`.`,
        `If you use an installed \`t3-hermes\` instead, check that \`t3-hermes --version\` prints ${version} and that \`which -a t3-hermes\` lists no older t3-hermes (such as an npm or nvm install) first.`,
        "Updating the desktop app does not update this CLI, and `t3-hermes service update` only repairs the service with whichever CLI runs it.",
      ].join(" "),
    };
  }

  return { status: "ready", version, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL };
}

export function decodeServicePreflightResult(value: unknown): ServicePreflightResult | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status === "ready" &&
    record.launcherProtocol === SERVICE_LAUNCHER_PROTOCOL &&
    typeof record.version === "string"
  ) {
    return {
      status: "ready",
      version: record.version,
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    };
  }
  if (
    record.status === "blocked" &&
    typeof record.version === "string" &&
    typeof record.reason === "string"
  ) {
    return { status: "blocked", version: record.version, reason: record.reason };
  }
  return undefined;
}
