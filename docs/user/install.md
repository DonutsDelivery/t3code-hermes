# Install T3 Hermes

T3 Hermes is a separate app with the T3 nightly artwork against a teal sky. It can run beside T3 Code and keeps its
own projects, settings, and sign-ins in `~/.t3-hermes/userdata`. Existing T3 Code data stays in
place. Hermes's default desktop capture shortcut is **Ctrl+Alt+Shift+H**; change it in Settings.

T3 Hermes runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

`npx t3` needs Node.js only to run npm itself; the CLI it installs is a
self-contained executable. SSH hosts and WSL backends need Node.js 22.16+
(22.x), 23.11+ (23.x), or 24.10 and later. The native desktop app includes its
server runtime.

You need an installed, authenticated provider before starting a thread. You can
launch T3 Hermes and configure providers afterwards.

## Run without installing

```bash
npx t3-hermes@nightly
```

This starts the server and opens the local web app. Run
`npx t3-hermes@nightly --help` for command-line options. T3 Hermes publishes
only nightly builds, so always ask for `@nightly`. To keep a server running
after you log out, use the [background service](./background-service.md).

Run `npx t3-hermes@nightly help` for the same reference. To start in a new
working directory, use an explicit path such as `npx t3-hermes@nightly ./my-project`.
A bare directory name is accepted only if it already exists.

If `t3-hermes` or `t3-hermes start` reports an already running server, connect
to that server instead. Stop it before starting a replacement, or use a
different `--base-dir` for an independent server.

To return freed database space to disk, run `npx t3-hermes@nightly doctor`
(see [Reclaim database space](./background-service.md#reclaim-database-space)).

The executable is built for Apple Silicon Macs, Linux, and Windows. There is
no Intel Mac build of it, because Node cannot produce a single executable for
that platform; the Intel desktop app is unaffected. To run a standalone server
on an Intel Mac, build it from source. You need Node.js 24 and `vp` (see
[Install vp](https://github.com/pingdotgg/t3code#install-vp)):

```bash
git clone https://github.com/NateWeav/t3code-hermes
cd t3code-hermes && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

A server run this way is a plain Node program: `t3-hermes update` and the
background service do not apply, so update it with `git pull` and a rebuild,
and start it however you run other Node processes.

## Desktop app

Download a release from [GitHub Releases](https://github.com/NateWeav/t3code-hermes/releases),
using the installer for your operating system. On Debian or Ubuntu, install the `.deb` with
`sudo apt install ./T3-Hermes-*.deb`. Upstream T3 Code package-manager entries install
the upstream app, not Hermes.

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

### The `t3-hermes` command

The desktop app includes the `t3-hermes` command-line tool. To run it from any
terminal, open **Settings → General → About** and choose **Install** next to
**t3-hermes command**. On macOS and Linux it adds a `t3-hermes` link to a folder on your
`PATH`; on Windows it adds the app's command folder to your `PATH`. Open a new
terminal afterwards. **Remove** takes it off again. If you already have
`t3-hermes` from npm, it stays as it is.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install Node.js and provider CLIs inside that distro. T3 Hermes installs its
matching server runtime there automatically; the first launch after an app
update can take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
npx t3-hermes app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `npx t3-hermes app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

Install a T3 Hermes iOS or Android build from your distributor. It installs alongside the official
T3 Code mobile app and has its own sign-ins and saved connections.
The phone connects to a server on another machine. Follow
[remote access](./remote-access.md) to link it through T3 Connect or a pairing URL.

The store apps work with both stable and Nightly servers. Test builds are optional:

- **iPhone and iPad:** TestFlight is invite-only.
- **Android:** download an APK from the
  [Android beta release](https://github.com/pingdotgg/t3code/releases/tag/android-beta).

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| Hermes      | Install [Hermes Agent](https://github.com/NousResearch/hermes-agent); credentials are read from `~/.hermes/.env`.                                         |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from T3 Code's provider settings.                                                                                         |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |

Provider CLIs must be on the server's `PATH`. If T3 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.
Hermes' executable is `hermes`; enable its provider card after installation.

T3 Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the
CLI's own update command when T3 Code cannot tell. Update a CLI installed with
mise through mise. Cursor and Antigravity update with T3 Code. Homebrew installs
compare against the version Homebrew offers, which can trail the npm release by
a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T3 Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Pi](./providers-pi.md), and
[Muse Code](./providers-muse.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating T3 Code](./updating.md): update the app and connected servers.
