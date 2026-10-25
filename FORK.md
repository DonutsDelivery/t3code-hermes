# T3 Code — Hermes fork

A fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) that adds
[Hermes Agent](https://github.com/NousResearch/hermes-agent) as a first-class provider, so you can
drive Hermes from T3 Code's web, desktop, and mobile clients instead of `hermes-webui`.

Upstream is MIT licensed; that license is retained verbatim in [LICENSE](./LICENSE). Everything in
[docs/](./docs) still applies — this file only covers what is specific to the fork.

## What this fork changes

| Change                                                                                                     | Where                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate install: T3 Hermes app, CLI, and data                                                             | `t3-hermes` CLI, `~/.t3-hermes` / `T3HERMES_HOME` (`apps/server/src/os-jank.ts`), `apps/desktop/package.json`, `apps/mobile/app.config.ts`, `assets/hermes/`                                                                                                                                                                 |
| `hermes` provider (ACP over stdio)                                                                         | `apps/server/src/provider/{,Drivers/,acp/}Hermes*.ts`, `apps/server/src/orchestration-v2/Adapters/HermesAdapterV2.ts`                                                                                                                                                                                                        |
| Hermes delegated child agents                                                                              | `apps/server/src/provider/acp/HermesDelegation.ts`, optional live-progress patch in `infra/hermes/`                                                                                                                                                                                                                          |
| Hermes text generation (titles, commit messages, …)                                                        | `apps/server/src/textGeneration/HermesTextGeneration.ts`                                                                                                                                                                                                                                                                     |
| `HermesSettings` + driver registration                                                                     | `packages/contracts/src/{settings,model}.ts`, `provider/builtInDrivers.ts`, `orchestration-v2/builtInProviderAdapterDrivers.ts`                                                                                                                                                                                              |
| Hermes provider icon in the clients                                                                        | `apps/web/src/components/Icons.tsx`, `apps/mobile/src/components/ProviderIcon.tsx`                                                                                                                                                                                                                                           |
| Auto-bootstrap default provider is overridable                                                             | `apps/server/src/serverRuntimeStartup.ts`                                                                                                                                                                                                                                                                                    |
| Model picker falls back to a populated provider                                                            | `apps/web/src/components/chat/ModelPickerContent.tsx`                                                                                                                                                                                                                                                                        |
| ACP `usage_update` and advertised slash commands                                                           | `packages/provider-acp/src/server/{runtimeModel,AcpSessionRuntime}.ts`                                                                                                                                                                                                                                                       |
| Shared slash-command dedupe (was Claude-private)                                                           | `packages/provider-core/src/server/slashCommands.ts`                                                                                                                                                                                                                                                                         |
| Hermes panel on mobile                                                                                     | `apps/mobile/src/features/hermes/`, `apps/mobile/src/state/hermes*.ts`                                                                                                                                                                                                                                                       |
| Hermes Skills panel ([guide](./docs/user/hermes-skills.md))                                                | `apps/server/src/hermes/HermesSkillsService.ts`, `packages/contracts/src/hermesSkills.ts`                                                                                                                                                                                                                                    |
| Hermes Tasks and delivery notifications ([guide](./docs/user/hermes-tasks.md))                             | `apps/server/src/hermes/{HermesCronService,hermesCron*}.ts`, `packages/contracts/src/hermesCron.ts`, `apps/web/src/components/hermes/`                                                                                                                                                                                       |
| Hermes runs mirrored as threads ([guide](./docs/user/hermes-tasks.md#follow-runs-as-threads))              | `apps/server/src/hermes/{HermesRunService,hermesRun*}.ts`, `packages/contracts/src/hermesRuns.ts`, `hermesRun` on the V2 thread in `orchestration-v2/{Orchestrator,ProjectionStore}.ts`, `apps/web/src/components/settings/HermesRunsSettings.tsx`                                                                           |
| Hermes Memory: built-in notes and Hindsight ([guide](./docs/user/hermes-memory.md))                        | `apps/server/src/hermes/HermesMemoryService.ts`, `apps/server/src/integrations/hindsight/`, `packages/contracts/src/{hermesMemory,hindsight}.ts`, `apps/web/src/components/settings/MemorySettings.tsx`                                                                                                                      |
| Hindsight memory for every agent ([guide](./docs/user/hermes-memory.md#give-every-agent-hindsight-memory)) | `apps/server/src/integrations/hindsight/HindsightAgentMemory.ts`, `apps/web/src/components/settings/HindsightAgentMemorySettings.tsx`                                                                                                                                                                                        |
| Read-only Paperclip surface ([guide](./docs/user/paperclip.md))                                            | `apps/server/src/integrations/paperclip/`, `packages/contracts/src/paperclip.ts`, `apps/web/src/components/paperclip/`, `apps/server/src/mcp/toolkits/paperclip/`                                                                                                                                                            |
| Hermes conversation surface, thread links and hubs ([guide](./docs/user/hermes-conversations.md))          | `apps/server/src/hermes/{HermesChatService,HermesChatHubService,hermesChatHubs,hermesChatState}.ts`, `packages/contracts/src/hermesChat.ts`, `apps/web/src/components/hermes/{HermesChatPanel,HermesChatCardRow}.tsx`, `apps/web/src/components/settings/HermesHubsSettings.tsx`, `apps/server/src/mcp/toolkits/hermesChat/` |
| Reasoning-effort selector ([guide](./docs/user/hermes-reasoning.md))                                       | `apps/server/src/hermes/hermesReasoning*.ts`                                                                                                                                                                                                                                                                                 |
| Hermes Patches tab ([guide](./docs/user/hermes-patches.md))                                                | `apps/server/src/hermes/{HermesPatchService,hermesPatches}.ts`, `infra/hermes/patches.json`, `scripts/generate-hermes-patches.ts`                                                                                                                                                                                            |
| Hermes usage totals                                                                                        | `apps/server/src/usage/usageHermes.ts`                                                                                                                                                                                                                                                                                       |
| Opt-in skill and memory rows in the work log                                                               | `packages/client-runtime/src/work-log/agentActivity.ts`                                                                                                                                                                                                                                                                      |
| Sidebar cards outlined with their status                                                                   | `apps/web/src/components/ThreadStatusRing.tsx`                                                                                                                                                                                                                                                                               |
| Opt-in tab status dots with an arrival blink                                                               | `apps/web/src/threadNotifications.ts`, `apps/web/src/components/ThreadNotificationCoordinator.tsx`                                                                                                                                                                                                                           |
| OpenCode Go usage limits                                                                                   | `packages/provider-opencode/src/server/openCodeGo*.ts`                                                                                                                                                                                                                                                                       |
| Model hub settings on mobile                                                                               | `apps/mobile/src/features/settings/EnvironmentHubSettings.tsx`                                                                                                                                                                                                                                                               |
| Triage and telemetry point at the fork                                                                     | `apps/server/src/cli/triagePrompt.ts`, `apps/server/src/telemetry/AnalyticsService.ts`                                                                                                                                                                                                                                       |

Upstream hardcodes `codex` as the provider stamped onto auto-bootstrapped projects, and the model
picker opens on whatever instance the thread is bound to. On a machine with no Codex CLI that gives
a project wired to a provider with no models, and a picker that says "No models found" with no hint
that other providers are populated. Those two rows fix that for any single-provider host; set
`T3CODE_BOOTSTRAP_PROVIDER_INSTANCE` and `T3CODE_BOOTSTRAP_MODEL` to choose the bootstrap pair.
Headless `serve`, which the background service runs, never auto-bootstraps. The ACP
and slash-command rows are not Hermes-specific either: the other ACP agents pick them up for free.

The Hermes adapter builds on the shared ACP adapter (`packages/provider-acp/src/server/adapter.ts`
over `packages/provider-acp/src/server/`) that also backs Grok, Antigravity, and ACP registry agents, so
it inherits streaming, tool-call cards, approvals, steering, session resume, and model switching.
See [docs/internals/providers.md](./docs/internals/providers.md).

## Requirements

- **A host the CLI is built for:** Linux x64/arm64, Apple Silicon macOS, or Windows. The CLI is a
  self-contained executable; Node.js is only needed to run `npx`. The background service needs
  systemd user services (Linux) or launchd (macOS).
- **Hermes Agent with the ACP adapter.** The ACP adapter was verified against **v0.20.0 (2026.8.3)**;
  cron files and execution ledgers were verified against **v0.20.2**. The adapter lives
  in the `acp_adapter` package of the Hermes checkout and needs the `acp` Python dependency.

Confirm Hermes can speak ACP before touching T3 Code. This should log
`ACP client connected` / `Initialize from unknown (protocol v1)` on stderr:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}}}}' \
  | hermes acp
```

If `hermes` is not on your `PATH` it is usually at `~/.hermes/hermes-agent/venv/bin/hermes`.

## Install

For a desktop install, download the app from
[Releases](https://github.com/NateWeav/t3code-hermes/releases); see
[docs/user/install.md](./docs/user/install.md). It bundles its own server. The rest of this section
is for an always-on server.

```bash
npx t3-hermes@nightly service install   # install and start the background service
npx t3-hermes@nightly pair --tailscale  # publish it on your tailnet and print a pairing link
```

Always ask for `@nightly`. The fork publishes only nightlies, and npm's `latest` tag for
`t3-hermes` is an old build that nothing updates.

`service install` downloads the matching CLI release into `~/.t3-hermes/runtime/versions/`,
writes a `t3-hermes.service` systemd user unit (a launchd agent on macOS), enables lingering so it
survives logout and reboot, and starts it. It runs the release, not the npx cache, so nothing else
needs to stay installed. State lives in `~/.t3-hermes/userdata`, separate from upstream T3 Code's
`~/.t3`.

| Task                    | Command                                   |
| ----------------------- | ----------------------------------------- |
| Status and log location | `npx t3-hermes@nightly service status`    |
| Move to a newer nightly | `npx t3-hermes@nightly update`            |
| Restart                 | `npx t3-hermes@nightly service restart`   |
| Remove                  | `npx t3-hermes@nightly service uninstall` |
| New pairing link        | `npx t3-hermes@nightly pair --tailscale`  |

Connected clients also offer **Update server** when the host is behind. The service runs headless
`serve`, so it does not auto-create a project. Add one from the client. See
[docs/user/background-service.md](./docs/user/background-service.md) for troubleshooting. To work
on the fork itself, see [docs/operations/development.md](./docs/operations/development.md).

**Reaching it.** The service listens on `127.0.0.1:4773`. `pair --tailscale` fronts it with
Tailscale Serve over HTTPS, and that mapping survives restarts. To bind a LAN or tailnet address
directly instead, add a drop-in, which `service install` leaves alone:

```bash
mkdir -p ~/.config/systemd/user/t3-hermes.service.d
printf '[Service]\nEnvironment=T3CODE_HOST=<private-ip>\n' \
  > ~/.config/systemd/user/t3-hermes.service.d/host.conf
systemctl --user daemon-reload && npx t3-hermes@nightly service restart
npx t3-hermes@nightly pair
```

T3 Connect is unavailable: fork builds ship with it disabled (see "CI on the fork").

**Bind deliberately.** The server controls agents on the host, which is remote code execution by
design. Bind to a private interface: a Tailscale address, or loopback behind a reverse proxy.
Do not bind `0.0.0.0` on a machine with a public IP, and do not put it behind Tailscale Funnel.

**Migrating from a source-checkout unit.** Older versions of this file had you hand-roll a
`t3code.service` that ran `apps/server/src/bin.ts`. It uses the same `~/.t3-hermes` data, so
threads carry over:

```bash
systemctl --user disable --now t3code.service
rm ~/.config/systemd/user/t3code.service
systemctl --user daemon-reload
npx t3-hermes@nightly service install
```

## Enable the Hermes provider

**The driver ships disabled.** It does not probe for a Hermes binary until you turn it on. From any
connected client, open **Settings → Providers**, enable **Hermes**, and set **Binary path** if
`hermes` is not on the host's login-shell `PATH`. On a host with no client yet, write
`~/.t3-hermes/userdata/settings.json` instead. The server picks up edits without a restart:

```json
{
  "providers": {
    "hermes": {
      "enabled": true,
      "binaryPath": "/home/you/.hermes/hermes-agent/venv/bin/hermes"
    }
  }
}
```

A working setup shows the Hermes version and a populated model list on the provider card; the same
probe result is cached in `~/.t3-hermes/caches/hermes.json`.

Models are discovered over ACP from Hermes's own configuration, so whatever providers you have
credentials for in `~/.hermes/.env` are what appear in the picker. Until the first ACP handshake
completes, the snapshot shows a single placeholder slug; that is expected.

## Hindsight memory (optional)

If Hermes already uses [Hindsight](https://github.com/vectorize-io/hindsight), the Memory tab picks
up Hermes's own Hindsight config with no setup. To point it elsewhere or switch it off, use
**Settings → Integrations → Memory**. See [docs/user/hermes-memory.md](./docs/user/hermes-memory.md).

## Known limitations

- **Live delegation progress needs the carried Hermes patch.** Stock synchronous delegation results
  appear as individual subagents. Current Hermes dispatches top-level delegations in the background,
  but stock ACP never sends their terminal results; these show idle with a completion-unavailable
  note instead of a false success or endless busy indicator. Apply
  [`0003-acp-delegation-progress.patch`](./infra/hermes/README.md#0003-acp-delegation-progresspatch)
  (the Hermes panel's Patches tab applies it) for live child progress and background completion.
  Updates require the original ACP process to remain connected; results missed after it exits are
  not recovered from Hermes transcripts.
- **Central SSH execution needs the carried Hermes patch.** Stock Hermes's SSH backend copies
  credential, skill, and cache files into the target's `~/.hermes`, and ACP replaces a configured
  remote cwd with T3's local project path. Apply
  [`0002-acp-central-ssh-execution.patch`](./infra/hermes/README.md#0002-acp-central-ssh-executionpatch)
  (also from the Patches tab) and set `TERMINAL_SSH_SYNC_FILES=false` on the remote provider
  instance. The target then runs only shell and file operations; T3, Hermes, provider credentials,
  memories, and conversation state stay on the central host.
- **Session modes are best-effort.** The adapter sends `session/set_mode` through the generic ACP
  request escape hatch and only logs a warning if Hermes rejects it. Approval enforcement is done
  by the adapter's own permission gate, so behaviour is correct either way.
- **`auth.status` is inferred, not introspected.** Hermes authenticates from its own
  `~/.hermes/.env`, which T3 Code never reads. A completed ACP handshake that returned a non-empty
  model list is reported as `authenticated`, since Hermes only lists models whose upstream it
  resolved credentials for. A handshake that reports no models is `unauthenticated`.
- **Task, skill, and memory authoring stays in chat.** Tasks can be paused, resumed, and muted but
  not created or edited; asking Hermes in natural language is the better interface. Skills are
  read-only. Hindsight memories can be recalled, retained, and reflected on, but not edited or
  deleted. Profile management is not exposed; use the `hermes` CLI.
- **Task data is read from Hermes's own state files**, because `hermes cron` has no JSON output.
  Fixture-pinned tests fail loudly if a Hermes upgrade changes those shapes; see
  `apps/server/src/hermes/hermesCronState.ts`.
- **Reasoning effort needs Hermes v0.21.4 or newer.** Older Hermes ignores the level on the ACP
  surface, so the selector appears but changes nothing. See
  [docs/user/hermes-reasoning.md](./docs/user/hermes-reasoning.md).
- **`respondToUserInput` is unimplemented.** Hermes has no equivalent ACP extension, so nothing
  ever opens such a request.

## Tracking upstream

Syncing is **merge-based, not rebase-based**: this fork's history is public, so rewriting it would
break every clone. [`.github/workflows/sync-upstream.yml`](./.github/workflows/sync-upstream.yml)
runs hourly at :50 (`workflow_dispatch` also works) and follows upstream's nightlies, not its
`main`. It merges the commit upstream's newest nightly was built from: that commit passed upstream's
release, while `main` can sit between commits that only work together. The merge goes onto an
`automation/sync-upstream/<run>` branch, which gets a PR with auto-merge (merge commit) enabled.
While that PR is open, a newer upstream nightly is merged into it instead of opening another.

GitHub holds CI on a PR opened with `GITHUB_TOKEN` until a maintainer approves the runs, so the
sync opens its PR through a GitHub App instead. Create a private app on your account with
**Contents**, **Pull requests**, and **Workflows** set to read and write, install it on this
repository, and set the `SYNC_APP_CLIENT_ID` variable and `SYNC_APP_PRIVATE_KEY` secret. Without
them the sync falls back to `GITHUB_TOKEN`, each sync PR waits for **Approve workflows to run**, and
upstream workflow edits have to be merged by hand. CI's
[`release-runners`](./.github/scripts/release-runners.test.cjs) check keeps a sync from moving a
release job onto a runner the fork lacks (upstream uses Blacksmith), which would otherwise queue
for a day and hold every later nightly behind it. `release.yml` runs the same check first.

Each run also checks whether upstream history merged into `main` has shipped in a fork nightly
yet, and if not dispatches `release.yml` with `follow_upstream`, which checks again under the
nightly concurrency lock. So an upstream nightly reaches a fork nightly about an hour after its
sync PR merges. A release that fails before publishing is retried by the next run; one that
published and then failed a later job, like the IPA, counts as shipped. `release.yml` has no
schedule of its own.

Four kinds of issue come out of it:

- **`upstream-sync-conflict`**: the merge conflicted and was aborted, so `main` is untouched. The
  issue lists the conflicted files (from `git ls-files -u`) and the run fails. Outside this repo,
  the Hermes `upstream-sync` profile receives the issue by webhook, merges upstream in an isolated
  worktree, opens a `hermes/upstream-sync-<sha>` PR, merges it (merge commit, never squash) once CI
  is green, and re-dispatches the sync so the release follows. Where upstream now covers something
  the fork built, the resolver takes upstream's version and re-applies only the Hermes behavior it
  lacks. It must merge the commit the issue names, not `upstream/main`. Later runs leave the issue
  alone until a newer upstream nightly appears, then retry and comment with the new commit.
- **`upstream-sync-stuck`**: a sync PR has been open for over three hours, so its checks failed or
  are blocked. Upstream's nightly already passed its own release, so the cause is usually in the
  fork. Filed once per PR.
- **`hermes-parity-review`**: advisory, filed once the sync PR is open. It fires when the incoming
  upstream commits touched two or more sibling provider adapters
  (`{provider/Drivers,orchestration-v2/Adapters}/{Claude,Codex,Cursor,Grok,OpenCode}*.ts`), the
  shared ACP adapter, or anything under `provider/acp/`, because
  upstream has fixed a bug across every sibling adapter in a commit that merged cleanly while
  leaving the Hermes copy broken. Git cannot see that kind of drift; a human has to check
  `HermesAdapterV2.ts`, `HermesDriver.ts`, `HermesAcpSupport.ts`, and `HermesTextGeneration.ts`.
- **`upstream-sync-failed`**: the run failed for any reason other than a conflict, such as a
  rejected push or a `gh` outage.

To sync by hand, merge the commit a conflict issue names, or upstream's newest nightly:

```bash
git remote add upstream https://github.com/pingdotgg/t3code
git fetch upstream
tag=$(gh release list --repo pingdotgg/t3code --exclude-drafts --json tagName,publishedAt \
  --jq '[.[] | select(.tagName | test("^v.*-nightly\\."))] | max_by(.publishedAt) | .tagName')
git merge "$(gh api "repos/pingdotgg/t3code/commits/$tag" --jq .sha)"
```

The Hermes driver is additive (new files plus registration lines), so conflicts are usually
limited to `builtInDrivers.ts`, `settings.ts`, and the client branding lists. Resolve
`apps/web/src/components/chat/ChatComposer.tsx`, `apps/web/src/components/ChatView.tsx`, and both
`usageProviders.ts` files (`apps/web/src/components/usage/`, `apps/mobile/src/features/usage/`) by
reading both sides rather than taking one wholesale.

**Keeping patches current.** The Hermes patches in [`infra/hermes/`](./infra/hermes) follow Hermes
`main`, not T3 Code upstream. [`hermes-patches.yml`](./.github/workflows/hermes-patches.yml) checks
them against it every three hours at :20 and files a **`hermes-patch-drift`** issue when one stops
applying, stacking, or passing its tests, or becomes obsolete. The same `upstream-sync` profile
answers it with a `hermes/patch-drift-<sha>` PR that adds rebased versions, and merges it once CI is
green. See [`infra/hermes/README.md`](./infra/hermes/README.md#versions).

## CI on the fork

Upstream's workflows target paid Blacksmith runners that only exist in its org, and several deploy
upstream-only infrastructure. This fork therefore diverges in `.github/workflows/` as follows.

- **Runners.** Fork jobs run on GitHub-hosted runners, free on this public repo: `ubuntu-24.04`,
  `ubuntu-24.04-arm`, `windows-latest`, `windows-11-arm`, `macos-14`, `macos-26`, and
  `macos-latest`. Only `macos-self-hosted-build.yml` (every push to `main`) and the iOS half of
  `mobile-showcase-screenshots.yml` use the self-hosted Apple Silicon laptop
  (`[self-hosted, macOS, ARM64, t3code-mac-arm64]`, declared in `.github/actionlint.yaml`); those
  jobs queue while it is offline. `desktop-macos-preview*.yml` (the `preview:mac` label) and
  `windows-tests.yml` (dispatch only) still name Blacksmith runners and would wait forever here.
- **Guarded workflows.** `deploy-relay.yml`, `mobile-eas-preview.yml`, `mobile-eas-production.yml`,
  `web-preview.yml`, `publish-aur.yml`, `pr-vouch.yml`, and `issue-labels.yml`, plus `release.yml`'s
  `publish_aur` and `deploy_marketing` jobs, carry `github.repository == 'pingdotgg/t3code'`, so
  they skip here and still work if this fork is ever merged back. The reverse guard
  (`!= 'pingdotgg/t3code'`) keeps the fork-only jobs inert upstream: `sync-upstream.yml`, the mobile
  builds, fork release notes, and failure reporting. `publish_cli` only runs in
  `NateWeav/t3code-hermes`.
- **Nightly release.** `release.yml` is dispatched by the upstream sync (see "Tracking upstream").
  It builds macOS dmg/zip (arm64 and x64), Linux AppImage and `.deb`, and Windows nsis, each for
  x64 and arm64, plus the updater manifests and CLI archives, attached to a GitHub prerelease. Its
  notes list the upstream commits it ships (`.github/scripts/fork-release-notes.cjs`). Everything
  that needs upstream credentials degrades instead of failing: the T3 Connect config resolves to
  empty values (so builds ship with T3 Connect disabled), and the Vercel deploy, the version-bump
  commit, and the Discord announcement skip when their secrets are absent. Windows code signing
  degrades to unsigned; macOS builds are signed with the stable self-signed identity in
  `MACOS_SELF_SIGNED_P12` when set, so in-app updates pass Squirrel.Mac's same-signer check (see
  [self-signed fallback](./docs/operations/release.md#self-signed-fallback)). The desktop updater
  feed is derived from `GITHUB_REPOSITORY`, so fork builds self-update from fork releases.
  Dispatching `release.yml` by hand defaults to the `preview` channel, which nothing installs
  unless asked for by name.
- **npm.** The CLI publishes as the `t3-hermes` launcher under the `nightly` dist-tag, through
  trusted publishing, after the GitHub Release. On first run it downloads its version's CLI archive
  from this fork's releases into `~/.t3-hermes/runtime/versions/` (`scripts/npm-launcher/t3.mjs`).
  The old per-platform packages (`t3-hermes-<platform>`, `nateweav-hermes-winbin-<arch>`) get no
  new versions. Intel macOS has no CLI archive. Use `npx t3-hermes@nightly`: nightlies never move
  `latest`.
- **Mobile builds.** After each nightly and stable release, `release.yml` calls `mobile-ipa.yml`
  and `mobile-apk.yml` directly, because releases published with `GITHUB_TOKEN` never fire the
  `release` trigger. `mobile-ipa.yml` builds an unsigned, sideloadable `.ipa` on hosted macOS; Feather,
  AltStore, and Sideloadly re-sign on install. Tagged builds also refresh an AltStore-format source
  on the `ipa-source` branch so Feather can offer updates. `mobile-apk.yml` builds an arm64 `.apk`
  signed with the release keystore in the `ANDROID_KEYSTORE_*` / `ANDROID_KEY_*` secrets, which
  Obtainium can track. Dispatch either with a `tag` to attach a build to that release, or without
  one for a workflow artifact.
