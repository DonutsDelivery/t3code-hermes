// @effect-diagnostics nodeBuiltinImport:off - Hermes's control socket is a unix socket; Effect has no client for one.
/**
 * Reads the gateway serving a Hermes home to tell whether it predates a patch. An `identify` answer
 * on its control socket proves liveness; `gateway.pid`'s mtime is its start time. Verified against
 * hermes-agent `8d30c4eaab` (`gateway/control_socket.py`, protocol 1).
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

const IDENTIFY_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

export interface HermesGatewayIdentity {
  readonly pid: number;
  /**
   * How the gateway was launched: `systemd`, `launchd`, `desktop`, `external`,
   * or `manual` for `hermes gateway run` in a terminal.
   */
  readonly supervisor: string;
}

export interface RunningHermesGateway extends HermesGatewayIdentity {
  readonly startedAtMs: number;
}

async function resolveControlSocketPath(home: string): Promise<string | null> {
  const direct = NodePath.join(home, "gateway.sock");
  if (await exists(direct)) return direct;
  const pointer = await NodeFSP.readFile(NodePath.join(home, "gateway.sock.path"), "utf8").catch(
    () => "",
  );
  const target = pointer.replace(/^\uFEFF/, "").trim();
  return target !== "" && (await exists(target)) ? target : null;
}

const exists = (path: string) =>
  NodeFSP.stat(path).then(
    () => true,
    () => false,
  );

function requestLine(socketPath: string, request: string): Promise<string | null> {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const socket = NodeNet.createConnection(socketPath);
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(IDENTIFY_TIMEOUT_MS, () => finish(null));
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline !== -1) finish(buffer.slice(0, newline));
      else if (buffer.length > MAX_RESPONSE_BYTES) finish(null);
    });
    socket.on("end", () => finish(buffer === "" ? null : buffer));
    socket.on("error", () => finish(null));
  });
}

/** Asks the gateway serving `home` who it is, or null when none answers. */
async function identifyHermesGateway(home: string): Promise<HermesGatewayIdentity | null> {
  const socketPath = await resolveControlSocketPath(home);
  if (socketPath === null) return null;
  const line = await requestLine(
    socketPath,
    `${JSON.stringify({ verb: "identify", id: 1, protocol: 1 })}\n`,
  );
  if (line === null) return null;
  try {
    const response: unknown = JSON.parse(line);
    if (typeof response !== "object" || response === null) return null;
    const { ok, result } = response as { ok?: unknown; result?: unknown };
    if (ok !== true || typeof result !== "object" || result === null) return null;
    const { pid, supervisor } = result as { pid?: unknown; supervisor?: unknown };
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    return { pid, supervisor: typeof supervisor === "string" ? supervisor : "manual" };
  } catch {
    return null;
  }
}

/**
 * The live gateway serving `home` and when it started, or null when none
 * answers or its `gateway.pid` belongs to another process.
 */
export async function readRunningHermesGateway(home: string): Promise<RunningHermesGateway | null> {
  const identity = await identifyHermesGateway(home);
  if (identity === null) return null;
  const pidFile = NodePath.join(home, "gateway.pid");
  const [content, stat] = await Promise.all([
    NodeFSP.readFile(pidFile, "utf8").catch(() => null),
    NodeFSP.stat(pidFile).catch(() => null),
  ]);
  if (content === null || stat === null) return null;
  if (recordedPid(content) !== identity.pid) return null;
  return { ...identity, startedAtMs: stat.mtimeMs };
}

function recordedPid(content: string): number | null {
  const trimmed = content.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  try {
    const record: unknown = JSON.parse(trimmed);
    const pid =
      typeof record === "object" && record !== null ? (record as { pid?: unknown }).pid : null;
    return typeof pid === "number" ? pid : null;
  } catch {
    return null;
  }
}

/** Latest mtime among `files` (relative to `checkoutRoot`) that exist, or null. */
export async function latestModifiedMs(
  checkoutRoot: string,
  files: ReadonlyArray<string>,
): Promise<number | null> {
  const times = await Promise.all(
    files.map((file) =>
      NodeFSP.stat(NodePath.join(checkoutRoot, file)).then(
        (stat) => stat.mtimeMs,
        () => null,
      ),
    ),
  );
  const known = times.filter((time) => time !== null);
  return known.length === 0 ? null : Math.max(...known);
}

/** Bounded, plain-text tail of a failed `hermes gateway restart`. */
export function describeRestartOutput(stdout: string, stderr: string): string | null {
  // eslint-disable-next-line no-control-regex -- Strips ANSI escapes from the gateway's terminal output.
  const plain = `${stdout}\n${stderr}`.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  const lines = plain
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const tail = lines.slice(-3).join(" ");
  if (tail === "") return null;
  return tail.length > 400 ? `…${tail.slice(-399)}` : tail;
}
