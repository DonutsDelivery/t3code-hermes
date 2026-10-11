# T3 Hermes

A fork of [T3 Code](https://github.com/pingdotgg/t3code) that adds
[Hermes Agent](https://github.com/NousResearch/hermes-agent) as a first-class provider. Drive
Hermes, alongside Claude Code, Codex, Cursor, Grok Build, OpenCode, Antigravity, and the rest of
upstream's providers, from one desktop, web, and mobile app.

T3 Hermes installs beside upstream T3 Code instead of replacing it. It has its own app, its own
`t3-hermes` CLI, and its own data in `~/.t3-hermes`, so existing T3 Code threads and settings in
`~/.t3` are left alone.

> [!IMPORTANT]
> Upstream's install channels (`t3.codes/install.sh`, winget, Scoop, Homebrew, the AUR, the App
> Store, and Google Play) install **upstream T3 Code, not this fork**. Use the instructions below.

## What the fork adds

- **Hermes as a provider** over ACP, with streaming, tool calls, approvals, steering, session
  resume, model switching, and delegated child agents.
- **Hermes panels** for [scheduled tasks](./docs/user/hermes-tasks.md),
  [memory and Hindsight](./docs/user/hermes-memory.md), [skills](./docs/user/hermes-skills.md),
  [reasoning effort](./docs/user/hermes-reasoning.md), and [patches](./docs/user/hermes-patches.md),
  on desktop, web, and mobile.
- **Hermes runs mirrored as threads**, so cron and delivery runs show up next to your other work.
- **Fixes that help any single-provider host**, such as a configurable bootstrap provider and a model
  picker that falls back to a provider with models.

[FORK.md](./FORK.md) lists every change with the files it touches.

## Install

Install and sign in to at least one provider on the machine where agents will run. For Hermes, that
means Hermes Agent with its ACP adapter. [FORK.md](./FORK.md#requirements) has a one-line check
that it works.

### Desktop app

Download the installer for your OS from
[Releases](https://github.com/NateWeav/t3code-hermes/releases): macOS (Apple Silicon and Intel),
Windows, Linux AppImage, or `.deb`. The app bundles its own server and updates itself from this
fork's releases.

### Command line

```bash
npx t3-hermes@nightly
```

This starts the server and opens the local web app. The fork only publishes nightlies, so always
ask for `@nightly`. npm's `latest` tag for `t3-hermes` points at an old build.

To run it as an always-on server (systemd on Linux, launchd on macOS) and pair a phone over
Tailscale:

```bash
npx t3-hermes@nightly service install
npx t3-hermes@nightly pair --tailscale
```

See [FORK.md](./FORK.md#install) for binding, updates, and security notes.

### Mobile

Each release includes a sideloadable iOS `.ipa` and an Android `.apk`:

- **iOS:** install the `.ipa` with Feather, AltStore, or Sideloadly. To get updates, add this
  source to Feather or AltStore:
  `https://raw.githubusercontent.com/NateWeav/t3code-hermes/ipa-source/source.json`
- **Android:** install the `.apk`, or track the repo's releases with
  [Obtainium](https://github.com/ImranR98/Obtainium).

The phone connects to a server on another machine; see
[remote access](./docs/user/remote-access.md). T3 Connect is disabled in fork builds, so pair over
your LAN or Tailscale.

## Enable Hermes

The Hermes provider ships disabled. Open **Settings → Providers**, enable **Hermes**, and set
**Binary path** if `hermes` is not on the host's `PATH`. It is often at
`~/.hermes/hermes-agent/venv/bin/hermes`. Models come from your Hermes configuration, so the
providers you have credentials for in `~/.hermes/.env` are the ones that appear in the picker.

Other providers are set up the same way as upstream; see
[Install and first run](./docs/user/install.md#providers).

## Documentation

User and developer docs live in [docs/](./docs/README.md). Fork-specific setup, known limitations,
and how the fork follows upstream are in [FORK.md](./FORK.md).

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Run as a background service](./docs/user/background-service.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)

## Staying current with upstream

A scheduled workflow merges `pingdotgg/t3code` `main` into this fork every few hours and ships a new
nightly when upstream changes. The fork uses merges, never rebases, so clones and forks of this repo
stay valid. See [Tracking upstream](./FORK.md#tracking-upstream).

## Building from source

T3 Hermes uses [Vite+](https://viteplus.dev/guide/). Install the `vp` CLI, then the dependencies:

```bash
curl -fsSL https://vite.plus | bash   # Windows: irm https://vite.plus/ps1 | iex
git clone https://github.com/NateWeav/t3code-hermes
cd t3code-hermes && vp i
```

Start with the [development runbook](./docs/operations/development.md) and the
[architecture overview](./docs/internals/overview.md).

## Issues

File Hermes-specific bugs and fork packaging problems in
[this repo's issues](https://github.com/NateWeav/t3code-hermes/issues). If a bug also happens in
stock T3 Code, report it [upstream](https://github.com/pingdotgg/t3code/issues) under
[their contribution policy](./CONTRIBUTING.md) so every fork benefits.

## Credits and license

T3 Code is built by the [T3 Code team](https://github.com/pingdotgg/t3code) and its contributors. Hermes Agent is
built by [Nous Research](https://github.com/NousResearch). This fork is MIT licensed, like upstream;
see [LICENSE](./LICENSE).
