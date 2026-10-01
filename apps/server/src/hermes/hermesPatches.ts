/**
 * The Hermes patches this server ships, and the git calls that read and change
 * them in a Hermes checkout.
 *
 * State is read with `git apply --check` in both directions rather than
 * recorded anywhere, so it is right no matter who touched the checkout last:
 * T3 Code, `hermes update`'s autostash, or someone at a terminal.
 */
import { HermesPatchId, type HermesPatch, type HermesPatchState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";

import { spawnAndCollect } from "../provider/providerSnapshot.ts";
import { HERMES_PATCH_FILES } from "./hermesPatchFiles.generated.ts";

export interface HermesPatchDefinition {
  readonly id: HermesPatchId;
  readonly title: string;
  readonly neededFor: string;
  /** Patch text, as `git apply` reads it. */
  readonly content: string;
}

/** A file under `infra/hermes`; empty when it is missing, which a test catches. */
const bundledPatch = (file: string) => HERMES_PATCH_FILES[file] ?? "";

export const HERMES_PATCHES: ReadonlyArray<HermesPatchDefinition> = [
  {
    id: HermesPatchId.make("acp-central-ssh-execution"),
    title: "Central SSH execution",
    neededFor:
      "Hermes instances that run tools on an SSH host without copying credentials, skills, or cache to it.",
    content: bundledPatch("0002-acp-central-ssh-execution.patch"),
  },
  {
    id: HermesPatchId.make("acp-delegation-progress"),
    title: "Live subagent progress",
    neededFor:
      "Live progress and background results for subagents Hermes delegates to. Without it, background subagents show as idle once dispatched.",
    content: bundledPatch("0003-acp-delegation-progress.patch"),
  },
  {
    id: HermesPatchId.make("acp-background-reports"),
    title: "Background process reports",
    neededFor:
      "Monitoring status while Hermes's background processes run, and waking the agent when they finish. Without it, a background command reads as finished the moment it starts, and the agent never hears that it is done.",
    content: bundledPatch("0004-acp-background-reports.patch"),
  },
  {
    id: HermesPatchId.make("gateway-multiplex-webhook-session-close"),
    title: "Finished webhook runs in profiles",
    neededFor:
      "Multi-profile gateways, so webhook runs in a profile are marked finished. Without it, T3 Code shows those runs as failed after two hours.",
    content: bundledPatch("0005-gateway-multiplex-webhook-session-close.patch"),
  },
  {
    id: HermesPatchId.make("acp-durable-completion-receipts"),
    title: "Durable subagent completion receipts",
    neededFor:
      "Apply after Live subagent progress and Background process reports. Keeps child results pending until the parent saves them, and recovers undelivered results after ACP reconnects.",
    content: bundledPatch("0006-acp-durable-completion-receipts.patch"),
  },
];

/**
 * The git checkout a Hermes executable was installed from, or null.
 *
 * A source install puts the binary at `<checkout>/venv/bin/hermes`. Nix,
 * Docker, apt and pip installs have no checkout beside them; `hermes update`
 * refuses those too.
 */
export const resolveHermesGitCheckout = Effect.fn("resolveHermesGitCheckout")(function* (
  realCommandPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkoutRoot = path.dirname(path.dirname(path.dirname(realCommandPath)));
  const isGitCheckout = yield* fileSystem
    .exists(path.join(checkoutRoot, ".git"))
    .pipe(Effect.orElseSucceed(() => false));
  return isGitCheckout ? checkoutRoot : null;
});

/**
 * Runs git in the checkout. Inherited repository bindings (a server started
 * from a git hook, say) would otherwise point git at a different repository.
 */
const runGit = (checkoutRoot: string, args: ReadonlyArray<string>) =>
  spawnAndCollect(
    "git",
    ChildProcess.make("git", args, {
      cwd: checkoutRoot,
      env: {
        ...process.env,
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_COMMON_DIR: undefined,
        GIT_INDEX_FILE: undefined,
        GIT_OBJECT_DIRECTORY: undefined,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
      },
    }),
  );

/** Writes patches to a scoped temp directory for `git apply` to read. */
const writePatchFiles = Effect.fn("writeHermesPatchFiles")(function* (
  patches: ReadonlyArray<HermesPatchDefinition>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hermes-patches-" });
  const files = new Map<HermesPatchId, string>();
  for (const patch of patches) {
    const file = path.join(directory, `${patch.id}.patch`);
    yield* fileSystem.writeFileString(file, patch.content);
    files.set(patch.id, file);
  }
  return files;
});

const readPatchState = Effect.fn("readHermesPatchState")(function* (
  checkoutRoot: string,
  patchFile: string,
) {
  // Reverse first: a checkout that already has the change must read as
  // applied, not as a conflict of the forward patch with itself.
  const reverse = yield* runGit(checkoutRoot, ["apply", "--check", "-R", patchFile]);
  if (reverse.code === 0) return "applied" satisfies HermesPatchState;
  const forward = yield* runGit(checkoutRoot, ["apply", "--check", patchFile]);
  return (forward.code === 0 ? "notApplied" : "doesNotApply") satisfies HermesPatchState;
});

export const readHermesPatches = Effect.fn("readHermesPatches")(function* (
  checkoutRoot: string,
  patches: ReadonlyArray<HermesPatchDefinition> = HERMES_PATCHES,
) {
  const files = yield* writePatchFiles(patches);
  const statuses: HermesPatch[] = [];
  for (const patch of patches) {
    const file = files.get(patch.id) ?? "";
    statuses.push({
      id: patch.id,
      title: patch.title,
      neededFor: patch.neededFor,
      state: yield* readPatchState(checkoutRoot, file),
    });
  }
  return statuses;
}, Effect.scoped);

/** True when HEAD is not on a branch, which `hermes update` cannot move. */
export const isHermesCheckoutDetached = (checkoutRoot: string) =>
  runGit(checkoutRoot, ["symbolic-ref", "--quiet", "HEAD"]).pipe(
    Effect.map((result) => result.code !== 0),
  );

/**
 * Applies (`forward`) or removes (`reverse`) one patch, returning whether git
 * accepted it. `git apply` is all-or-nothing, so a refusal leaves the checkout
 * untouched.
 */
export const changeHermesPatch = Effect.fn("changeHermesPatch")(function* (
  checkoutRoot: string,
  patch: HermesPatchDefinition,
  direction: "forward" | "reverse",
) {
  const files = yield* writePatchFiles([patch]);
  const file = files.get(patch.id) ?? "";
  const result = yield* runGit(
    checkoutRoot,
    direction === "forward" ? ["apply", file] : ["apply", "-R", file],
  );
  return { ok: result.code === 0 } as const;
}, Effect.scoped);
