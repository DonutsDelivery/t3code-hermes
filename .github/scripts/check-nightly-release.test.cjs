const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertCommitOnDefaultBranch,
  assertReleaseSource,
  shouldReleaseNightly,
} = require("./check-nightly-release.cjs");

const now = Date.parse("2026-09-05T12:00:00Z");
const hour = 60 * 60 * 1000;
const nightly = (hoursAgo, overrides = {}) => ({
  tag_name: "v1.0.1-nightly.20260905.123",
  draft: false,
  published_at: new Date(now - hoursAgo * hour).toISOString(),
  ...overrides,
});

function releaseSourceFixture({
  comparisonStatus = "ahead",
  eventName = "workflow_dispatch",
  ref = "refs/heads/main",
  sha = "candidate",
} = {}) {
  const calls = [];
  return {
    calls,
    options: {
      context: {
        eventName,
        payload: { repository: { default_branch: "main" } },
        ref,
        repo: { owner: "example", repo: "app" },
        sha,
      },
      github: {
        rest: {
          repos: {
            async compareCommitsWithBasehead(params) {
              calls.push(params);
              return { data: { status: comparisonStatus } };
            },
          },
        },
      },
    },
  };
}

test("allows preview releases from any branch without consulting main", async () => {
  const { options, calls } = releaseSourceFixture({ ref: "refs/heads/feature" });
  await assertReleaseSource({ ...options, releaseChannel: "preview" });
  assert.equal(calls.length, 0);
});

for (const releaseChannel of ["stable", "nightly"]) {
  test(`rejects a manual ${releaseChannel} release from a feature branch`, async () => {
    const { options, calls } = releaseSourceFixture({ ref: "refs/heads/feature" });
    await assert.rejects(
      assertReleaseSource({ ...options, releaseChannel }),
      new RegExp(`${releaseChannel} releases must be dispatched from main`),
    );
    assert.equal(calls.length, 0);
  });
}

for (const comparisonStatus of ["behind", "diverged"]) {
  test(`rejects a release commit that is ${comparisonStatus} from main`, async () => {
    const { options } = releaseSourceFixture({ comparisonStatus, eventName: "push" });
    await assert.rejects(
      assertCommitOnDefaultBranch({ ...options, sha: "release-commit" }),
      new RegExp(`not contained in main \\(${comparisonStatus}\\)`),
    );
  });
}

function fixture({ releases = [nightly(7)], comparisonStatus = "ahead" } = {}) {
  const calls = [];
  return {
    calls,
    options: {
      now,
      context: { repo: { owner: "example", repo: "app" }, sha: "new" },
      core: { info() {} },
      github: {
        rest: {
          repos: {
            listReleases() {},
            async compareCommitsWithBasehead(params) {
              calls.push(params);
              return { data: { status: comparisonStatus } };
            },
          },
        },
        async paginate() {
          return releases;
        },
      },
    },
  };
}

test("releases the first nightly when no nightly is published", async () => {
  const { options } = fixture({
    releases: [nightly(0, { tag_name: "v1.0.0" }), nightly(0, { draft: true })],
  });
  assert.equal(await shouldReleaseNightly(options), true);
});

test("uses publication time, not release order or the tagged commit date", async () => {
  const { options } = fixture({
    releases: [nightly(10), nightly(1), nightly(20, { tag_name: "nightly-v0.9.0" })],
  });
  assert.equal(await shouldReleaseNightly(options), false);
});

test("ignores stable releases and drafts when checking the gap", async () => {
  const { options } = fixture({
    releases: [nightly(0, { tag_name: "v1.0.0" }), nightly(0, { draft: true }), nightly(7)],
  });
  assert.equal(await shouldReleaseNightly(options), true);
});

test("fails instead of releasing when GitHub cannot supply release state", async () => {
  const { options } = fixture();
  options.github.paginate = async () => {
    throw new Error("GitHub unavailable");
  };
  await assert.rejects(shouldReleaseNightly(options), /GitHub unavailable/);
});

for (const status of ["behind", "diverged"]) {
  test(`skips a candidate commit that is ${status} relative to the last nightly`, async () => {
    const { options } = fixture({ comparisonStatus: status });
    assert.equal(await shouldReleaseNightly(options), false);
  });
}

const { resolveLatestNightlyCommit } = require("./check-nightly-release.cjs");

function nightlyCommitFixture({ releases, commitSha = "abc123" }) {
  const refs = [];
  const { options } = fixture({ releases });
  options.github.rest.repos.getCommit = async ({ ref }) => {
    refs.push(ref);
    return { data: { sha: commitSha } };
  };
  return { options, refs };
}

test("stable releases resolve the commit of the newest published nightly", async () => {
  const { options, refs } = nightlyCommitFixture({
    releases: [
      nightly(10, { tag_name: "v1.0.1-nightly.20260905.100" }),
      nightly(1, { tag_name: "v1.0.1-nightly.20260905.123" }),
      nightly(0, { tag_name: "v1.0.0" }),
      nightly(0, { draft: true, tag_name: "v1.0.1-nightly.20260905.999" }),
    ],
    commitSha: "deadbeef",
  });
  assert.deepEqual(await resolveLatestNightlyCommit(options), {
    tag: "v1.0.1-nightly.20260905.123",
    sha: "deadbeef",
    version: "1.0.1",
  });
  assert.deepEqual(refs, ["v1.0.1-nightly.20260905.123"]);
});

test("stable releases derive the version from legacy nightly tags", async () => {
  const { options } = nightlyCommitFixture({
    releases: [nightly(1, { tag_name: "nightly-v0.9.0-nightly.20260905.5" })],
  });
  assert.equal((await resolveLatestNightlyCommit(options)).version, "0.9.0");
});
const { shouldFollowUpstreamNightly } = require("./check-nightly-release.cjs");

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

// `merged` and `shipped` describe containment of the sync snapshot.
// "missing" means GitHub cannot resolve it in the fork.
function followFixture({
  upstreamSha = "a".repeat(40),
  forkReleases = [nightly(8, { tag_name: "v1.0.1-nightly.20260905.10" })],
  merged = "ahead",
  shipped = "behind",
} = {}) {
  const calls = [];
  const options = {
    upstreamSha,
    context: { repo: { owner: "fork", repo: "app" }, sha: "main-sha" },
    core: { info() {} },
    github: {
      rest: {
        repos: {
          listReleases() {},
          async getCommit({ owner, ref }) {
            assert.equal(owner, "pingdotgg");
            assert.equal(ref, upstreamSha);
            return { data: { sha: upstreamSha } };
          },
          async compareCommitsWithBasehead(params) {
            calls.push(params);
            assert.equal(params.owner, "fork");
            const status = params.basehead.endsWith("...main-sha") ? merged : shipped;
            if (status === "missing") throw notFound();
            return { data: { status } };
          },
        },
      },
      async paginate() {
        return forkReleases;
      },
    },
  };
  options.github.rest.repos.listReleases = async () => {
    throw new Error("The upstream release calendar must not affect sync releases.");
  };
  return { options, calls };
}

test("releases merged upstream commits absent from the last fork nightly", async () => {
  const { options, calls } = followFixture();
  assert.equal(await shouldFollowUpstreamNightly(options), true);
  assert.deepEqual(
    calls.map((call) => call.basehead),
    [`${"a".repeat(40)}...main-sha`, `${"a".repeat(40)}...v1.0.1-nightly.20260905.10`],
  );
});

test("releases unshipped upstream commits even without a new upstream nightly", async () => {
  const { options } = followFixture();
  assert.equal(await shouldFollowUpstreamNightly(options), true);
});

test("ignores fork previews and drafts when checking already shipped commits", async () => {
  const { options } = followFixture({
    forkReleases: [nightly(0, { tag_name: "v1.0.1-preview.1" }), nightly(0, { draft: true })],
    shipped: "ahead",
  });
  assert.equal(await shouldFollowUpstreamNightly(options), true);
});

test("skips while the captured upstream commit is not merged into main", async () => {
  for (const merged of ["missing", "behind", "diverged"]) {
    const { options, calls } = followFixture({ merged });
    assert.equal(await shouldFollowUpstreamNightly(options), false);
    assert.equal(calls.length, 1);
  }
});

test("skips when a fork nightly already shipped the upstream commit", async () => {
  for (const shipped of ["ahead", "identical"]) {
    const { options } = followFixture({ shipped });
    assert.equal(await shouldFollowUpstreamNightly(options), false);
  }
});

test("releases when the previous nightly cannot resolve the upstream commit", async () => {
  const { options } = followFixture({ shipped: "missing" });
  assert.equal(await shouldFollowUpstreamNightly(options), true);
});

test("follows without any prior fork nightly", async () => {
  const { options, calls } = followFixture({ forkReleases: [] });
  assert.equal(await shouldFollowUpstreamNightly(options), true);
  assert.equal(calls.length, 1);
});

test("rejects missing or malformed upstream snapshots before API calls", async () => {
  for (const upstreamSha of ["", "main", "a".repeat(39), "A".repeat(40)]) {
    const { options, calls } = followFixture({ upstreamSha });
    await assert.rejects(shouldFollowUpstreamNightly(options), /requires a full lowercase/);
    assert.equal(calls.length, 0);
  }
});

test("rejects commits that do not exist upstream", async () => {
  const { options } = followFixture();
  options.github.rest.repos.getCommit = async () => {
    throw notFound();
  };
  await assert.rejects(shouldFollowUpstreamNightly(options), /Not Found/);
});

test("a queued duplicate skips after the preceding run publishes", async () => {
  const { options } = followFixture();
  assert.equal(await shouldFollowUpstreamNightly(options), true);
  options.github.rest.repos.compareCommitsWithBasehead = async () => ({
    data: { status: "ahead" },
  });
  assert.equal(await shouldFollowUpstreamNightly(options), false);
});

test("fails instead of releasing when GitHub errors for another reason", async () => {
  const { options } = followFixture();
  options.github.rest.repos.compareCommitsWithBasehead = async () => {
    throw Object.assign(new Error("Server Error"), { status: 500 });
  };
  await assert.rejects(shouldFollowUpstreamNightly(options), /Server Error/);
});
