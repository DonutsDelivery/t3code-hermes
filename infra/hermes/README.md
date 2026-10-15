# Hermes patches

Patches this fork carries against [Hermes Agent](https://github.com/NousResearch/hermes-agent)
itself, for behaviour T3 Code depends on that stock Hermes does not provide. They are here rather
than vendored because Hermes is a separate project on its own release cadence; drop each one once
upstream carries the change.

The server embeds them, and the Hermes panel's Patches tab applies and removes them for you.

## Versions

`hermes update` follows Hermes `main`, so users' checkouts sit anywhere along it, and one patch
text stops fitting within days. Each patch therefore ships several versions, one directory per
patch, listed in [`patches.json`](./patches.json). Each version records the Hermes commit it was
made and verified against: applied there alone and together with the other patches, and its tests
passed. The server reverses an applied version, or applies the newest version that fits the
checkout, so an older checkout keeps working with an older version. Whenever the manifest changes,
every version other than a patch's newest whose `hermesCommitDate` is more than 30 days old is
deleted.

[`hermes-patches.yml`](../../.github/workflows/hermes-patches.yml) keeps the newest versions
current. Every three hours it checks each one against Hermes `main`: it must apply (alone, or on
the patches before it when it builds on them), must not
reverse-apply (which means upstream now carries it), must stack in manifest order, and must not
fail a patch-relevant Hermes test that passes on unpatched `main`. Drift files a
`hermes-patch-drift` issue, and the maintainer's Hermes resolver answers it with
a PR that adds a rebased version, or deletes a patch upstream made obsolete, and applies the 30-day
rule. To run the same check locally against a clean Hermes checkout outside `~/.hermes` (Hermes's
test guard fails tests run from under it):

```bash
node .github/scripts/hermes-patch-drift.cjs check --hermes <checkout> --state /tmp/state.json
(cd <checkout> && uv sync --locked --python 3.14 --extra all --group dev)
node .github/scripts/hermes-patch-drift.cjs test --hermes <checkout> --state /tmp/state.json \
  --python <checkout>/.venv/bin/python
node .github/scripts/hermes-patch-drift.cjs report --state /tmp/state.json --body /tmp/drift.md
```

Skip the two middle commands for an apply-only check; `report` then reports no test results.

To add a version, rebase the patch onto a newer Hermes commit, save it as
`<patch-id>/<first 12 characters of the commit>.patch`, and list it first under that patch in
`patches.json` with the commit and its UTC committer date
(`TZ=UTC git log -1 --format=%cd --date=format-local:%Y-%m-%dT%H:%M:%SZ <commit>`). A new patch also
needs its id, title, and `neededFor` text there; patch order is the order the tab shows and the
order the patches stack in. Then run `node scripts/generate-hermes-patches.ts`, which rejects an
inconsistent manifest; a server test fails until the generated file matches.

The Patches tab picks the version for you, and is the easier way. To apply one by hand, go through
the versions listed in `patches.json` in order and use the first that both fits and has a
`hermesCommit` your checkout already contains:

```bash
cd ~/.hermes/hermes-agent
git merge-base --is-ancestor <hermesCommit> HEAD && echo contained
git apply --check /path/to/t3code/infra/hermes/<patch-id>/<version>.patch
git apply /path/to/t3code/infra/hermes/<patch-id>/<version>.patch
```

If no version passes both checks, apply a version only when it is the one version that passes
`--check`. When several pass, they can be changing different code, so use the Patches tab,
which refuses when it can't tell them apart.

## `acp-central-ssh-execution`

**Needed by:** a single central T3/Hermes server that executes terminal and file tools on a remote
SSH host without launching T3 or Hermes on that target.

Hermes already has an SSH terminal backend, but its default behavior mirrors local credentials,
skills, and cache into the remote user's `~/.hermes`. This patch adds
`terminal.ssh_sync_files: false`, which keeps those files on the central Hermes host. It also makes
ACP honor `terminal.cwd` as the remote project root instead of replacing it with T3's local project
placeholder.

Example central provider-instance environment:

```text
TERMINAL_ENV=ssh
TERMINAL_SSH_HOST=192.168.1.5
TERMINAL_SSH_USER=aeris
TERMINAL_SSH_KEY=/home/aeris/.ssh/id_ed25519_aeris_core_fleet
TERMINAL_CWD=/home/aeris/meridian-news-v3-standalone
TERMINAL_SSH_SYNC_FILES=false
```

The remote target needs only SSH, Bash, and the project toolchain (not even `scp`). It does not need
Node, T3, the Hermes binary, provider credentials, memories, or a `.hermes` directory.

Upstream already carries half of this: `SSHEnvironment` takes `sync_files`, used by Hermes's own SSH
workspace browser. The patch exposes it as config and roots ACP tools at the remote cwd.

Restart the T3 Code server after applying the patch. Configure each approved SSH target as a
separate Hermes provider instance; do not change the default Hermes instance away from local
execution.

## `acp-delegation-progress`

**Needed by:** live progress and background results for the subagents Hermes delegates to. Without
it, stock Hermes suppresses `delegate_task`'s structured arguments and results and never reports
child progress over ACP, so T3 Code parses the readable text and shows background subagents as idle
once dispatched.

The patch keeps the existing human-readable content while exposing `rawInput` arguments, parsed
`rawOutput` results, and bounded per-child snapshots in `rawOutput.hermesDelegation`. Child progress
routes through the executor's copied context variables, never goals, task indices, or FIFO order:
overlapping delegations can have identical goals and batch-local indices, and unknown or conflicting
ownership is dropped. Registry-forced stalls and worker crashes report through the same child relay,
so detached work cannot stay falsely active. A parent result with `status: "dispatched"` only
acknowledges launch; child lifecycle events settle each subagent. The original ACP process must stay
connected unless `acp-durable-completion-receipts` is also applied, which recovers missed results
from disk.

Restart the T3 Code server after applying the patch so provider sessions spawn patched Hermes. No
configuration changes are required.

The patch's `tests/acp_adapter/test_delegation_progress.py` and `test_delegation_finalization.py`
drive the real executor, child relays, stale monitor, and background worker. Run them with
`tests/acp_adapter/test_tools.py` and `test_events.py` in a scratch checkout with an isolated
`HERMES_HOME` and `PYTHONDONTWRITEBYTECODE=1`, never in the live install.

## `acp-background-reports`

**Needed by:** the sidebar's Monitoring status for background processes Hermes starts, such as a CI
watcher, and the agent picking its work back up when they finish. Stock Hermes reports a background
`terminal` call as finished the moment the process starts and says nothing when it exits, so T3 Code
cannot tell the work is still running, and the agent never hears that it is done.

The patch adds two ACP extension notifications. `_hermes/process` reports a background process left
running by a `terminal` call, keyed by that tool call, and again when it exits, with its exit code.
`_hermes/notification` carries the text Hermes's CLI injects as the next turn when background work
finishes (process completions, watch matches, heartbeats, background subagent results), sent once the
session is idle. Stock ACP never drains those events, so an agent that promised to report back never
heard that its work had finished. ACP turns stay client-driven: Hermes reports, and the client decides
whether to prompt. T3 Code prompts with the notification once no turn is running, unless the user
pressed Stop, in which case it waits for their next message. Clients that do not know the methods
ignore them.

Restart the T3 Code server after applying the patch. `display.background_process_notifications: off`
in Hermes's `config.yaml` still suppresses process notifications; process status is always reported.

The patch's `tests/acp_adapter/test_background_reports.py` spawns real processes against an isolated
process registry. Run it with the rest of `tests/acp_adapter/` in a scratch checkout, as for `acp-delegation-progress`.

## `acp-fast-mode`

**Needed by:** the Fast Mode toggle for Hermes models. Stock Hermes applies `/fast` only in its CLI,
TUI, and gateway, never in ACP sessions, and sends fast-mode parameters only to the first-party
endpoints that bill for them, so a proxy that forwards `service_tier` (such as CLIProxyAPI) never
gets it.

The patch adds a per-session `fast_mode` ACP config option (`on`/`off`), applied through the same
gate as `/fast` and re-pinned before every turn because `session/set_model` rebuilds the agent. It
is deliberately not advertised in `configOptions`, since Zed would render it in place of the model
picker; instead, picker rows whose route takes fast mode carry `_meta.hermes.fastMode: true`, which
is how T3 Code knows where to offer the toggle. It also lets a custom endpoint opt in:

```yaml
custom_providers:
  - name: cliproxyapi
    base_url: http://localhost:8317/v1
    capabilities:
      fast_mode: true
```

Applying the patch from T3 Code's Patches tab writes that opt-in for every custom endpoint whose
root identifies as CLIProxyAPI (an unauthenticated `GET /` answering `"CLI Proxy API Server"`), with
a trailing `# added by T3 Code` marker; removing the patch deletes only marked flags. Applying it
with `git apply` leaves `config.yaml` alone.

The opt-in covers `service_tier: priority` (OpenAI and xAI models) only. Anthropic's `speed: fast`
is a Messages API parameter, and custom endpoints speak chat completions, so Claude models behind a
proxy stay ungated.

Restart the T3 Code server after applying the patch. The patch's
`tests/acp_adapter/test_fast_mode.py` drives the real config, gate, and ACP server with a stubbed
agent; run it with the rest of `tests/acp_adapter/` in a scratch checkout, as for
`acp-delegation-progress`.

## `acp-durable-completion-receipts`

**Needed by:** background results that survive the trip to the agent. Stock Hermes (with
`acp-delegation-progress` and `acp-background-reports`) counts a finished subagent's result as
delivered the moment it writes `_hermes/notification`, so a result is lost if T3 Code restarts, the
ACP process reconnects, or the wake turn fails before the agent sees it.

T3 Code advertises `_meta["hermes.backgroundNotifications"]` during `initialize`; Hermes keeps
clients without it on synchronous delegation. Capable clients receive stable `notificationIds` with
each detached result and hand them back in the wake turn's `session/prompt` `_meta` under
`hermes.notificationIds`. Hermes settles a receipt only for its owning session, after that prompt
finished uninterrupted and its history was saved. Until then the result stays pending: a reconnect
restores it from disk, and a previous ACP delivery claim is reclaimed only when its process is
demonstrably dead. A sent receipt is not re-sent within one Hermes process, only restored after a
reconnect. T3 Code drops a re-sent notice while its ids are queued or prompting and reopens them once
the wake prompt settles, because its stop reason does not say whether Hermes settled them.

Verified against hermes-agent `4d3555e5ca`, `af8839df10` (`main`, 2026-10-04), and `5575a0859d`
(2026-10-14) after
`acp-delegation-progress` and `acp-background-reports`, with or without `acp-fast-mode` in either
order. It edits `acp_adapter/background.py`, which `acp-background-reports` creates, so it applies
only on top of the patches before it, never to stock Hermes alone.

Restart the T3 Code server after applying the patch. Run the patch's
`tests/acp_adapter/test_background_reports.py` and `tests/tools/test_async_delegation.py` in a
scratch checkout, as for `acp-delegation-progress`.
