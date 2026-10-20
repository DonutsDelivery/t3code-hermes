/**
 * The Hermes patches this server ships, and the git calls that read and change
 * them in a Hermes checkout.
 *
 * Each patch ships several versions, each made for a different Hermes commit
 * (`infra/hermes/patches.json`), because users' checkouts sit anywhere along
 * Hermes `main`. State is read with `git apply --check` in both directions
 * rather than recorded anywhere, so it is right no matter who touched the
 * checkout last: T3 Code, `hermes update`'s autostash, or someone at a terminal.
 */
import {
  HermesPatchId,
  type HermesPatch,
  type HermesPatchMisfitReason,
  type HermesPatchState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";

import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { HERMES_PATCH_FILES } from "./hermesPatchFiles.generated.ts";

export interface HermesPatchVersion {
  /** The Hermes commit this version was made and verified against. */
  readonly hermesCommit: string;
  readonly hermesCommitDate: string;
  /** Patch text, as `git apply` reads it. */
  readonly content: string;
}

export interface HermesPatchDefinition {
  readonly id: HermesPatchId;
  readonly title: string;
  readonly neededFor: string;
  /** Newest first. */
  readonly versions: ReadonlyArray<HermesPatchVersion>;
}

/** Serializes everything that changes a Hermes checkout: updates and patches. */
export const HERMES_UPDATE_LOCK_KEY = "hermes";

/** Applying it also opts CLIProxyAPI endpoints in (`hermesFastModeConfig.ts`). */
export const HERMES_FAST_MODE_PATCH_ID = HermesPatchId.make("acp-fast-mode");

export const HERMES_PATCHES: ReadonlyArray<HermesPatchDefinition> = HERMES_PATCH_FILES.map(
  (patch) => ({
    id: HermesPatchId.make(patch.id),
    title: patch.title,
    neededFor: patch.neededFor,
    versions: patch.versions.map(({ hermesCommit, hermesCommitDate, content }) => ({
      hermesCommit,
      hermesCommitDate,
      content,
    })),
  }),
);

/**
 * The non-test source files the patches touch, relative to the checkout.
 * A running gateway that started before one of them last changed still runs
 * the code from before the change.
 */
export const hermesPatchedSourceFiles = (
  patches: ReadonlyArray<HermesPatchDefinition> = HERMES_PATCHES,
): ReadonlyArray<string> => {
  const files = new Set<string>();
  for (const patch of patches) {
    for (const version of patch.versions) {
      for (const match of version.content.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) {
        const file = match[2]!;
        if (!file.startsWith("tests/")) files.add(file);
      }
    }
  }
  return [...files];
};

/** A launcher is a few lines of shell; anything larger is the program itself. */
const LAUNCHER_MAX_BYTES = 64 * 1024;
const LAUNCHER_MAX_HOPS = 3;
const LAUNCHER_EXEC = /^\s*exec\s+["']?(\/[^\s"']+)/m;

/**
 * The git checkout a Hermes executable was installed from, or null.
 *
 * A source install puts the binary at `<checkout>/venv/bin/hermes`, or at
 * `<checkout>/.hermes/bin/hermes` behind a `sh` launcher on PATH that `exec`s
 * it, so launchers are followed. Nix, Docker, apt and pip installs have no
 * checkout beside them; `hermes update` refuses those too.
 */
export const resolveHermesGitCheckout = Effect.fn("resolveHermesGitCheckout")(function* (
  realCommandPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let candidate = realCommandPath;
  for (let hop = 0; hop <= LAUNCHER_MAX_HOPS; hop++) {
    const checkoutRoot = path.dirname(path.dirname(path.dirname(candidate)));
    const isGitCheckout = yield* fileSystem
      .exists(path.join(checkoutRoot, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isGitCheckout) return checkoutRoot;
    const script = yield* fileSystem.stat(candidate).pipe(
      Effect.flatMap((info) =>
        info.type === "File" && Number(info.size) <= LAUNCHER_MAX_BYTES
          ? fileSystem.readFileString(candidate)
          : Effect.succeed(""),
      ),
      Effect.orElseSucceed(() => ""),
    );
    const target = script.startsWith("#!") ? LAUNCHER_EXEC.exec(script)?.[1] : undefined;
    if (target === undefined) return null;
    candidate = yield* fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => target));
  }
  return null;
});

/**
 * Runs git in the checkout. Inherited repository bindings (a server started
 * from a git hook, say) would otherwise point git at a different repository.
 */
const runGit = (
  checkoutRoot: string,
  args: ReadonlyArray<string>,
  env: { readonly GIT_INDEX_FILE?: string } = {},
) =>
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
        ...env,
      },
    }),
  );

/** Writes every version of the given patches to a scoped temp directory for `git apply`. */
const writePatchFiles = Effect.fn("writeHermesPatchFiles")(function* (
  patches: ReadonlyArray<HermesPatchDefinition>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hermes-patches-" });
  const files = new Map<HermesPatchId, ReadonlyArray<string>>();
  for (const patch of patches) {
    const versionFiles: string[] = [];
    for (const [index, version] of patch.versions.entries()) {
      const file = path.join(directory, `${patch.id}.${index}.patch`);
      yield* fileSystem.writeFileString(file, version.content);
      versionFiles.push(file);
    }
    files.set(patch.id, versionFiles);
  }
  return files;
});

// The ways of taking other applied patches out that are tried when picking
// the applied version: one per combination of their reversing versions.
const MAX_OTHER_COMBINATIONS = 16;

// Every patch is read at once, so this keeps a full read to a few dozen git
// processes however many versions the manifest retains.
const GIT_CHECK_CONCURRENCY = 4;

/**
 * The version files, newest first, that git accepts. `--check` only reads, so
 * the versions are checked side by side rather than one git process after
 * another.
 */
const fitting = (
  checkoutRoot: string,
  versionFiles: ReadonlyArray<string>,
  args: ReadonlyArray<string>,
  env?: { readonly GIT_INDEX_FILE: string },
) =>
  Effect.forEach(versionFiles, (file) => runGit(checkoutRoot, [...args, file], env), {
    concurrency: GIT_CHECK_CONCURRENCY,
  }).pipe(Effect.map((results) => versionFiles.filter((_, index) => results[index]?.code === 0)));

/**
 * Every repository path a patch reads or writes, from its `diff --git`,
 * `rename`/`copy`, and `---`/`+++` headers: a rename's source as well as its
 * destination.
 */
const patchFilePaths = (content: string): ReadonlySet<string> => {
  const paths = new Set<string>();
  const header =
    /^(?:diff --git a\/(\S+) b\/(\S+)|(?:rename|copy) (?:from|to) (.+)|(?:---|\+\+\+) [ab]\/(.+))$/gm;
  for (const match of content.matchAll(header)) {
    for (const path of match.slice(1)) if (path !== undefined) paths.add(path);
  }
  return paths;
};

/**
 * Which of the versions that reverse cleanly is the one applied in the working
 * tree, or null when none can be told to be. A version reverses cleanly too
 * when upstream already carries its change, and two versions can patch
 * different upstream text into the same result, or the same text in different
 * places; reversing the wrong one would write the wrong text back.
 *
 * The applied one is a version that, applied to HEAD, gives exactly the files
 * the checkout has now once the other applied patches are taken back out:
 * patches can share a file, and their changes are not this one's. Failing
 * that (the user also edited those files), a lone version that applies to
 * HEAD. Each check runs in its own
 * scratch index, so the checkout's own index is untouched. When neither picks
 * out exactly one, there is no telling, so null: the patch still reads as
 * applied, and Remove refuses rather than guess.
 */
const pickAppliedVersion = Effect.fn("pickHermesAppliedVersion")(function* (
  checkoutRoot: string,
  candidates: ReadonlyArray<string>,
  allOthers: ReadonlyArray<ReadonlyArray<string>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hermes-index-" });
  const pathsOf = (files: ReadonlyArray<string>) =>
    Effect.forEach(files, (file) =>
      fileSystem.readFileString(file).pipe(Effect.map(patchFilePaths)),
    ).pipe(Effect.map((sets) => sets.flatMap((set) => [...set])));
  // Compared over every path any candidate touches, both sides of a rename
  // included: a version that changes fewer files would otherwise match while
  // another's change sits elsewhere. Only other patches' versions sharing one
  // of those files matter; the rest, and any edit in their files, have no
  // bearing on this patch.
  const candidatePaths = new Set(yield* pathsOf(candidates));
  if (candidatePaths.size === 0) return null;
  // Each other patch sharing a file with the candidates may have one of its
  // versions applied, or none: its change can be upstream's own, or absent.
  // Every way of choosing is tried.
  const choices: ReadonlyArray<string | null>[] = [];
  for (const versionFiles of allOthers) {
    const options: (string | null)[] = [null];
    // Only versions that share a file and reverse from the working tree can
    // be the applied one, so only those count toward the cap below.
    const sharing: string[] = [];
    for (const file of versionFiles) {
      const touched = yield* pathsOf([file]);
      if (touched.some((path) => candidatePaths.has(path))) sharing.push(file);
    }
    options.push(...(yield* fitting(checkoutRoot, sharing, ["apply", "--check", "-R"])));
    if (options.length > 1) choices.push(options);
  }
  const combinations = choices.reduce<ReadonlyArray<ReadonlyArray<string>>>(
    (acc, options) =>
      acc.flatMap((combo) => options.map((file) => (file === null ? combo : [...combo, file]))),
    [[]],
  );
  if (combinations.length > MAX_OTHER_COMBINATIONS) return null;
  // Per choice, the working tree over the candidates' paths and the chosen
  // versions' own, as a tree, with the chosen versions reversed out. Built
  // through a scratch index so files a patch added, which `git apply` leaves
  // untracked, count too; a plain `git diff` would skip them. Paths no
  // chosen version touches stay at HEAD, so edits there have no bearing.
  const normalized = new Set<string>();
  for (const [index, combo] of combinations.entries()) {
    const env = { GIT_INDEX_FILE: path.join(directory, `index-worktree-${index}`) };
    const paths = new Set([...candidatePaths, ...(yield* pathsOf(combo))]);
    if ((yield* runGit(checkoutRoot, ["read-tree", "HEAD"], env)).code !== 0) continue;
    const staged = yield* runGit(
      checkoutRoot,
      ["update-index", "--add", "--remove", "--", ...paths],
      env,
    );
    if (staged.code !== 0) continue;
    let reversedAll = true;
    for (const file of combo) {
      if ((yield* runGit(checkoutRoot, ["apply", "--cached", "-R", file], env)).code !== 0) {
        reversedAll = false;
        break;
      }
    }
    if (!reversedAll) continue;
    const tree = yield* runGit(checkoutRoot, ["write-tree"], env);
    if (tree.code === 0) normalized.add(tree.stdout.trim());
  }
  const checks = yield* Effect.forEach(
    candidates,
    (file, index) =>
      Effect.gen(function* () {
        const env = { GIT_INDEX_FILE: path.join(directory, `index-${index}`) };
        const missing = { file, onHead: false, tree: null, matches: false } as const;
        if ((yield* runGit(checkoutRoot, ["read-tree", "HEAD"], env)).code !== 0) return missing;
        if ((yield* runGit(checkoutRoot, ["apply", "--cached", file], env)).code !== 0) {
          return missing;
        }
        const written = yield* runGit(checkoutRoot, ["write-tree"], env);
        const tree = written.code === 0 ? written.stdout.trim() : null;
        return { file, onHead: true, tree, matches: tree !== null && normalized.has(tree) };
      }),
    { concurrency: GIT_CHECK_CONCURRENCY },
  );
  // A version that rebuilds the checkout exactly also undoes back to HEAD.
  // Several can, once the other patches are taken out more than one way;
  // they are interchangeable only when they build the same tree.
  const exact = checks.filter((check) => check.matches);
  if (exact.length > 0) {
    return exact.every((check) => check.tree === exact[0]!.tree) ? exact[0]!.file : null;
  }
  // Failing that (the user also edited those files), only a lone version is
  // taken, and only if it applies to HEAD but does not also reverse from HEAD
  // itself. With several versions that reverse, an edit can make one fit
  // where another was applied, so none is proven. HEAD can also hold a
  // patch's before and after text in different places, so it fits both ways
  // without having been applied, and reversing would rewrite upstream text.
  if (candidates.length !== 1) return null;
  const onHead = checks.filter((check) => check.onHead);
  if (onHead.length !== 1) return null;
  const headEnv = { GIT_INDEX_FILE: path.join(directory, "index-head") };
  if ((yield* runGit(checkoutRoot, ["read-tree", "HEAD"], headEnv)).code !== 0) return null;
  const reversesOnHead = yield* runGit(
    checkoutRoot,
    ["apply", "--check", "--cached", "-R", onHead[0]!.file],
    headEnv,
  );
  return reversesOnHead.code === 0 ? null : onHead[0]!.file;
}, Effect.scoped);

/**
 * Which of several versions that all apply is the one for this checkout: the
 * newest made for a commit HEAD already contains. Older versions can still fit
 * a newer checkout when they touch other occurrences of the same text, so
 * manifest order alone could apply the wrong one. When no recorded commit is
 * known here, the versions are still interchangeable if they all produce the
 * same tree from HEAD; otherwise null, and Apply refuses rather than guess.
 */
const pickForwardVersion = Effect.fn("pickHermesForwardVersion")(function* (
  checkoutRoot: string,
  candidates: ReadonlyArray<{ readonly file: string; readonly hermesCommit: string }>,
) {
  for (const candidate of candidates) {
    const contained = yield* runGit(checkoutRoot, [
      "merge-base",
      "--is-ancestor",
      candidate.hermesCommit,
      "HEAD",
    ]);
    if (contained.code === 0) return candidate.file;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hermes-index-" });
  const trees = yield* Effect.forEach(
    candidates,
    (candidate, index) =>
      Effect.gen(function* () {
        const env = { GIT_INDEX_FILE: path.join(directory, `index-${index}`) };
        if ((yield* runGit(checkoutRoot, ["read-tree", "HEAD"], env)).code !== 0) return null;
        const applied = yield* runGit(checkoutRoot, ["apply", "--cached", candidate.file], env);
        if (applied.code !== 0) return null;
        const tree = yield* runGit(checkoutRoot, ["write-tree"], env);
        return tree.code === 0 ? tree.stdout.trim() : null;
      }),
    { concurrency: GIT_CHECK_CONCURRENCY },
  );
  const first = trees[0];
  return first != null && trees.every((tree) => tree === first) ? candidates[0]!.file : null;
}, Effect.scoped);

/**
 * Where one patch stands, and the version file that got it there: the version
 * whose change the checkout contains, or the one that applies cleanly. A null
 * file means the state is known but not which version made it, and changing it
 * is refused.
 */
const resolvePatchState = Effect.fn("resolveHermesPatchState")(function* (
  checkoutRoot: string,
  patch: HermesPatchDefinition,
  files: ReadonlyMap<HermesPatchId, ReadonlyArray<string>>,
) {
  const versionFiles = files.get(patch.id) ?? [];
  const others = [...files].filter(([id]) => id !== patch.id).map(([, other]) => other);
  const result = (state: HermesPatchState, file: string | null) => ({ state, file });
  // Reverse first, over every version: a checkout that already has a change
  // must read as applied, not as a conflict of a forward patch with itself.
  // Even a lone candidate is checked against HEAD: a change upstream now
  // carries reverses cleanly too, and removing it would rewrite upstream code.
  const reverse = yield* fitting(checkoutRoot, versionFiles, ["apply", "--check", "-R"]);
  if (reverse.length > 0) {
    return result("applied", yield* pickAppliedVersion(checkoutRoot, reverse, others));
  }
  const forward = yield* fitting(checkoutRoot, versionFiles, ["apply", "--check"]);
  if (forward.length === 1) return result("notApplied", forward[0]!);
  if (forward.length > 1) {
    const candidates = forward.map((file) => ({
      file,
      hermesCommit: patch.versions[versionFiles.indexOf(file)]?.hermesCommit ?? "",
    }));
    return result("notApplied", yield* pickForwardVersion(checkoutRoot, candidates));
  }
  return result("doesNotApply", null);
});

/** Repository paths a patch version changes, from its `--- a/` and `+++ b/` headers. */
const hermesPatchPaths = (content: string): ReadonlyArray<string> => {
  const paths = new Set<string>();
  for (const line of content.split("\n")) {
    const match = /^(?:---|\+\+\+) [ab]\/(.+)$/.exec(line);
    if (match?.[1] !== undefined) paths.add(match[1]);
  }
  return [...paths];
};

/** Paths every version of a patch touches. */
const patchPaths = (patch: HermesPatchDefinition) =>
  new Set(patch.versions.flatMap((version) => hermesPatchPaths(version.content)));

/**
 * Paths with uncommitted changes, untracked files included: those are what
 * `hermes update`'s autostash would sweep away.
 */
export const readHermesDirtyPaths = Effect.fn("readHermesDirtyPaths")(function* (
  checkoutRoot: string,
) {
  const result = yield* runGit(checkoutRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const paths = new Set<string>();
  const fields = result.stdout.split("\0");
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index]!;
    if (entry.length < 4) continue;
    paths.add(entry.slice(3));
    // A rename or copy carries its source path as the next field.
    if (entry[0] === "R" || entry[0] === "C") {
      const source = fields[++index];
      if (source) paths.add(source);
    }
  }
  return paths;
});

/**
 * Paths whose content differs from HEAD with the given applied versions on
 * top. Built in a scratch index, so the checkout's own index is untouched.
 * Null when the versions do not stack there.
 */
const readPathsBeyondVersions = Effect.fn("readHermesPathsBeyondVersions")(function* (
  checkoutRoot: string,
  versionFiles: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hermes-index-" });
  const env = { GIT_INDEX_FILE: path.join(directory, "index") };
  if ((yield* runGit(checkoutRoot, ["read-tree", "HEAD"], env)).code !== 0) return null;
  for (const file of versionFiles) {
    if ((yield* runGit(checkoutRoot, ["apply", "--cached", file], env)).code !== 0) return null;
  }
  const diff = yield* runGit(checkoutRoot, ["diff", "--name-only", "-z"], env);
  if (diff.code !== 0) return null;
  return new Set(diff.stdout.split("\0").filter((entry) => entry.length > 0));
}, Effect.scoped);

/**
 * The user's own uncommitted edits: dirty paths no applied patch touches, and
 * paths an applied patch touches whose content goes beyond what that patch
 * changed. When the applied versions cannot be replayed, a file an applied
 * patch touches is taken to hold only that patch's change.
 */
const readUserEdits = Effect.fn("readHermesUserEdits")(function* (
  checkoutRoot: string,
  allApplied: ReadonlyArray<{
    readonly patch: HermesPatchDefinition;
    readonly file: string | null;
  }>,
) {
  const dirty = yield* readHermesDirtyPaths(checkoutRoot);
  // A patch HEAD already holds explains nothing in the working tree, and
  // cannot be replayed onto HEAD either, so it takes no part here.
  const inHead = yield* readHermesPatchesInHead(
    checkoutRoot,
    allApplied.map(({ patch }) => patch),
  );
  const applied = allApplied.filter(({ patch }) => !inHead.has(patch.id));
  const touched = new Set(applied.flatMap(({ patch }) => [...patchPaths(patch)]));
  // An applied patch whose version cannot be told cannot be replayed either.
  const files = applied.flatMap(({ file }) => (file === null ? [] : [file]));
  const beyond =
    files.length === applied.length && [...dirty].some((path) => touched.has(path))
      ? yield* readPathsBeyondVersions(checkoutRoot, files)
      : null;
  return new Set([...dirty].filter((path) => !touched.has(path) || (beyond?.has(path) ?? false)));
});

/**
 * The user's own uncommitted edits in the checkout, told apart from the
 * changes of the given patches wherever those are applied.
 */
export const readHermesUserEdits = Effect.fn("readHermesUserEditsForPatches")(function* (
  checkoutRoot: string,
  patches: ReadonlyArray<HermesPatchDefinition>,
) {
  const files = yield* writePatchFiles(patches);
  const resolved = yield* Effect.forEach(
    patches,
    (patch) =>
      resolvePatchState(checkoutRoot, patch, files).pipe(
        Effect.map((result) => ({ patch, ...result })),
      ),
    { concurrency: "unbounded" },
  );
  return yield* readUserEdits(checkoutRoot, appliedVersions(resolved));
}, Effect.scoped);

/**
 * The given patches whose change sits in HEAD itself (committed, or carried
 * upstream) rather than only in the working tree: some version reverses
 * against HEAD in a scratch index. Removing one of those would leave a
 * reverse diff behind, not a clean tree.
 */
export const readHermesPatchesInHead = Effect.fn("readHermesPatchesInHead")(function* (
  checkoutRoot: string,
  patches: ReadonlyArray<HermesPatchDefinition>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = yield* writePatchFiles(patches);
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hermes-index-" });
  const env = { GIT_INDEX_FILE: path.join(directory, "index") };
  if ((yield* runGit(checkoutRoot, ["read-tree", "HEAD"], env)).code !== 0) {
    return new Set<HermesPatchId>();
  }
  const inHead = yield* Effect.forEach(
    patches,
    (patch) =>
      fitting(
        checkoutRoot,
        files.get(patch.id) ?? [],
        ["apply", "--check", "--cached", "-R"],
        env,
      ).pipe(Effect.map((reversing) => (reversing.length > 0 ? [patch.id] : []))),
    { concurrency: "unbounded" },
  );
  return new Set(inHead.flat());
}, Effect.scoped);

/** The applied ones, in manifest order, which is the order they stack in. */
const appliedVersions = (
  resolved: ReadonlyArray<{
    readonly patch: HermesPatchDefinition;
    readonly state: HermesPatchState;
    readonly file: string | null;
  }>,
) => resolved.flatMap(({ patch, state, file }) => (state === "applied" ? [{ patch, file }] : []));

/** The checkout's HEAD, abbreviated, or null in a repository without commits. */
export const readHermesHeadCommit = (checkoutRoot: string) =>
  runGit(checkoutRoot, ["rev-parse", "--short", "HEAD"]).pipe(
    Effect.map((result) => (result.code === 0 ? result.stdout.trim() || null : null)),
  );

const isAncestor = (checkoutRoot: string, ancestor: string, descendant: string) =>
  runGit(checkoutRoot, ["merge-base", "--is-ancestor", ancestor, descendant]).pipe(
    Effect.map((result) => result.code === 0),
  );

/**
 * Whether HEAD is older than a version's Hermes commit, so updating Hermes
 * moves toward it. Ancestry decides when the commit is known locally,
 * including a HEAD whose local commits sit on an older base; a commit the
 * checkout has never fetched falls back to comparing HEAD's committer date
 * with the recorded commit date.
 */
const isHeadOlderThan = Effect.fn("isHermesHeadOlderThan")(function* (
  checkoutRoot: string,
  version: HermesPatchVersion,
) {
  const known = yield* runGit(checkoutRoot, ["cat-file", "-e", `${version.hermesCommit}^{commit}`]);
  if (known.code === 0) {
    // Checked first so HEAD at the version's own commit reads as not older.
    if (yield* isAncestor(checkoutRoot, version.hermesCommit, "HEAD")) return false;
    if (yield* isAncestor(checkoutRoot, "HEAD", version.hermesCommit)) return true;
    // Diverged: local commits on an older upstream base, which `hermes update`
    // rebases forward. The version is ahead whenever it lies past the point
    // the two lines split, however recent the local tip is.
    const base = yield* runGit(checkoutRoot, ["merge-base", "HEAD", version.hermesCommit]);
    if (base.code === 0) return base.stdout.trim() !== "";
  }
  const headDate = yield* runGit(checkoutRoot, ["log", "-1", "--format=%cI", "HEAD"]);
  const head = Date.parse(headDate.stdout.trim());
  const recorded = Date.parse(version.hermesCommitDate);
  return Number.isFinite(head) && Number.isFinite(recorded) && head < recorded;
});

/**
 * Why a patch that applies in neither direction does not fit, which decides
 * what the user can do about it. `userEdits` are the user's own edits, apart
 * from the changes of patches that are applied.
 */
const classifyHermesPatchMisfit = Effect.fn("classifyHermesPatchMisfit")(function* (
  checkoutRoot: string,
  patch: HermesPatchDefinition,
  userEdits: ReadonlySet<string>,
) {
  for (const path of patchPaths(patch)) {
    if (userEdits.has(path)) return "localChanges" satisfies HermesPatchMisfitReason;
  }
  const newest = patch.versions[0];
  if (newest === undefined) return "awaitingPatchUpdate" satisfies HermesPatchMisfitReason;
  const reason: HermesPatchMisfitReason = (yield* isHeadOlderThan(checkoutRoot, newest))
    ? "hermesTooOld"
    : "awaitingPatchUpdate";
  return reason;
});

export const readHermesPatches = Effect.fn("readHermesPatches")(function* (
  checkoutRoot: string,
  patches: ReadonlyArray<HermesPatchDefinition> = HERMES_PATCHES,
) {
  const files = yield* writePatchFiles(patches);
  // Patches are read independently, so read them all at once.
  const resolved = yield* Effect.forEach(
    patches,
    (patch) =>
      resolvePatchState(checkoutRoot, patch, files).pipe(
        Effect.map((result) => ({ patch, ...result })),
      ),
    { concurrency: "unbounded" },
  );
  const userEdits = resolved.some(({ state }) => state === "doesNotApply")
    ? yield* readUserEdits(checkoutRoot, appliedVersions(resolved))
    : null;
  const statuses: HermesPatch[] = [];
  for (const { patch, state } of resolved) {
    const status: HermesPatch = {
      id: patch.id,
      title: patch.title,
      neededFor: patch.neededFor,
      state,
    };
    statuses.push(
      state === "doesNotApply" && userEdits !== null
        ? { ...status, reason: yield* classifyHermesPatchMisfit(checkoutRoot, patch, userEdits) }
        : status,
    );
  }
  return statuses;
}, Effect.scoped);

/**
 * Applies (`forward`) or removes (`reverse`) one patch, returning whether git
 * accepted it. Applying uses the newest version that fits the checkout;
 * removing reverses whichever version is applied. `git apply` is
 * all-or-nothing, so a refusal leaves the checkout untouched. `patches` is
 * every patch that may be applied alongside, so their changes in shared files
 * are told apart from this one's.
 */
export const changeHermesPatch = Effect.fn("changeHermesPatch")(function* (
  checkoutRoot: string,
  patch: HermesPatchDefinition,
  direction: "forward" | "reverse",
  patches: ReadonlyArray<HermesPatchDefinition> = HERMES_PATCHES,
) {
  const files = yield* writePatchFiles([
    patch,
    ...patches.filter((other) => other.id !== patch.id),
  ]);
  const { state, file } = yield* resolvePatchState(checkoutRoot, patch, files);
  const expected: HermesPatchState = direction === "forward" ? "notApplied" : "applied";
  if (state !== expected || file === null) return { ok: false } as const;
  const result = yield* runGit(
    checkoutRoot,
    direction === "forward" ? ["apply", file] : ["apply", "-R", file],
  );
  return { ok: result.code === 0 } as const;
}, Effect.scoped);
