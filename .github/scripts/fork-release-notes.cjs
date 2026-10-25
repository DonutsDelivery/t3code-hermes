#!/usr/bin/env node
// Writes fork release notes: upstream commits the release picks up (linked, without @mentions so
// nightlies never ping upstream), then fork changes. Usage: node
// .github/scripts/fork-release-notes.cjs --previous-tag <tag> --tag <tag> --ref <sha>
// --upstream-ref FETCH_HEAD --upstream-repo pingdotgg/t3code --output release-notes.md

const { execFileSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { parseArgs } = require("node:util");

const FIELD = "\x1f";
const RECORD = "\x1e";

const isSyncTitle = (title) => /^chore\(sync\)/i.test(title);

/**
 * Turns `git log --first-parent --format=%P%x1f%s%x1f%b%x1e` output for the fork's main into change
 * titles. GitHub merge commits contribute their PR title, other merges (upstream syncs) are
 * skipped, and plain commits keep their subject. Sync PRs are dropped because the upstream section
 * already lists what they brought in.
 */
function parseForkChanges(log) {
  return log
    .split(RECORD)
    .map((record) => record.trim())
    .filter(Boolean)
    .flatMap((record) => {
      const [parents = "", subject = "", body = ""] = record.split(FIELD);
      const pullRequest = /^Merge pull request #(\d+) from /.exec(subject);
      if (pullRequest) {
        const title = body
          .split("\n")
          .find((line) => line.trim())
          ?.trim();
        return title ? [`${title} (#${pullRequest[1]})`] : [];
      }
      if (parents.trim().split(/\s+/).length > 1) return [];
      return [subject.trim()];
    })
    .filter((title) => title && !isSyncTitle(title));
}

/**
 * Lists sections oldest first: the desktop update popover shows the last
 * lines of a note as the newest changes, so the fork's own changes go last.
 */
function formatReleaseNotes({ upstreamSubjects, forkChanges, upstreamRepo, compareUrl }) {
  const linkUpstreamPr = (subject) =>
    subject.replace(
      /\(#(\d+)\)/g,
      (_, number) => `([#${number}](https://github.com/${upstreamRepo}/pull/${number}))`,
    );

  const sections = [];
  if (upstreamSubjects.length > 0) {
    sections.push(
      [
        `## Upstream changes (${upstreamRepo})`,
        "",
        ...upstreamSubjects.map((s) => `- ${linkUpstreamPr(s)}`),
      ].join("\n"),
    );
  }
  if (forkChanges.length > 0) {
    sections.push(["## Fork changes", "", ...forkChanges.map((c) => `- ${c}`)].join("\n"));
  }
  sections.push(`**Full Changelog**: ${compareUrl}`);
  return `${sections.join("\n\n")}\n`;
}

function main() {
  const { values } = parseArgs({
    options: {
      "previous-tag": { type: "string" },
      tag: { type: "string" },
      ref: { type: "string" },
      "upstream-ref": { type: "string" },
      "upstream-repo": { type: "string" },
      output: { type: "string" },
    },
  });
  for (const name of ["previous-tag", "tag", "ref", "upstream-ref", "upstream-repo", "output"]) {
    if (!values[name]) throw new Error(`--${name} is required.`);
  }
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

  const previous = values["previous-tag"];
  // The newest upstream commit this release contains, however far upstream
  // has moved on since the sync merged it.
  const upstreamBase = git("merge-base", values.ref, values["upstream-ref"]).trim();

  const upstreamSubjects = git(
    "log",
    "--reverse",
    "--no-merges",
    "--format=%s",
    `${previous}..${upstreamBase}`,
  )
    .split("\n")
    .filter(Boolean);
  const forkChanges = parseForkChanges(
    git(
      "log",
      "--reverse",
      "--first-parent",
      `--format=%P${FIELD}%s${FIELD}%b${RECORD}`,
      `${previous}..${values.ref}`,
      `^${upstreamBase}`,
    ),
  );

  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is not set.");

  writeFileSync(
    values.output,
    formatReleaseNotes({
      upstreamSubjects,
      forkChanges,
      upstreamRepo: values["upstream-repo"],
      compareUrl: `${server}/${repository}/compare/${previous}...${values.tag}`,
    }),
  );
  console.log(
    `Wrote ${values.output}: ${upstreamSubjects.length} upstream, ${forkChanges.length} fork changes.`,
  );
}

if (require.main === module) main();

module.exports = { formatReleaseNotes, parseForkChanges };
