# Installation

## Requirements

- pi **0.85.1** or newer. The extensions hook into pi internals (extension UI containers, renderer signatures, `SettingsManager`), so a much older pi may load them and behave oddly.
- Node **22.19+** (pi's own requirement).
- macOS or Linux. The delete boundary (`bash-command-collapse/sandbox.ts`, `sandbox-boundary/`) needs macOS's `sandbox-exec`; elsewhere it turns itself off with `PI_SANDBOX=off` semantics, and `destructive-guard` is the only remaining delete protection.

## Install the package

```bash
pi install npm:@bachi/pi-coder
```

Extensions and themes come from the package automatically — `package.json` declares them:

```json
"pi": {
  "extensions": ["./extensions"],
  "themes": ["./themes"]
}
```

Nothing else is needed. Restart pi so the extensions are loaded, and confirm with `pi list` (the package appears under installed packages) or `pi config`, which lists every resource with an enable/disable toggle.

### Try it without installing

```bash
pi -e npm:@bachi/pi-coder
```

This installs into a temporary directory for that run only.

### Project-local install

```bash
pi install -l npm:@bachi/pi-coder
```

The entry goes into `.pi/settings.json`, which is meant to be committed for a team. Project resources load only after the folder is trusted.

## Verify that everything loaded

pi loads `.ts` extensions directly, and a syntax error makes it skip the whole file silently — the only reliable signal is a real start:

1. Start pi.
2. Look at the top of the transcript and the bottom line.

Expected visible results of a successful load:

- The header is replaced by a logo with the version and the shortened working directory (`startup-logo`).
- The footer is a single statusline line (`statusline`), plus a second line with the working directory (`cwd-statusline`).
- The editor shows a `❯ ` prompt (`prompt-editor`).
- A user message has a `▎ ` at the head of every line, including the blank lines above and below the text, in the theme's `accent` color (`user-message-bar`).
- A bash run starts with a `• ` dot followed by `Run `, with **no background** behind the block (`bash-command-collapse`); pressing `shift+tab` cycles the permission mode and the statusline's second line shows `⏵ bypass` → `⏸ plan` → `☢ dangerous` (`plan-mode`).
- `/theme`, `/tasks`, `/recap`, `/rewind`, `/init`, `/clear`, `/exit`, `/ask`, `/mcp`, `/memory`, `/plan`, `/plan-status`, `/goal`, `/sandbox-boundary`, `/destructive-guard` and the `/bash-*` family (`/bash-preview`, `/bash-timeout`) all exist. Type `/` and scroll the command list.
- `/sandbox-boundary` prints the delete boundary (project directory, the temp roots `/tmp` / `/var/folders` / `/var/tmp`, the regenerable caches) and a `持久白名单` line, and `~/.pi/agent/AGENTS.core.md` exists — `core-rules` does nothing, silently, without it.
- `/destructive-guard` prints `模式：on` and a line of zeros for this session's counts. That extension is **retired upstream** and shipped here as a reference implementation; it stays quiet unless it has something to say.

If something is missing, start pi and search the screen for `Failed to load extension` — a parse error in one file does not stop the others.

Editing the sources of an installed copy is not the intended workflow; edit your checkout and run it with `pi -e /absolute/path/to/pi-coder` (see [development.md](development.md)).

## Apply the global config files

> **If you already copied these extensions into `~/.pi/agent/extensions/`, remove that copy first.** pi loads both sources, the second registration of `bash`, `read`, `edit`, `write`, `task_set`, `ask_user_question` and the rest conflicts, and pi refuses to start:
>
> ```
> Error: Failed to load extension "~/.pi/agent/extensions/bash-command-collapse.ts":
>   Tool "bash" conflicts with .../pi-coder/extensions/bash-command-collapse.ts
> Hint: Start without extensions using "pi -ne".
> ```
>
> The same applies in reverse: while the package is installed, do not copy the extensions into the auto-discovery directory.

pi reads these from `~/.pi/agent/`, not from packages, so copy the ones you want. The package lands in `~/.pi/agent/npm/node_modules/@bachi/pi-coder` for a user install (`.pi/npm/node_modules/` for a project install):

```bash
PKG=~/.pi/agent/npm/node_modules/@bachi/pi-coder

cp "$PKG/config/AGENTS.md"       ~/.pi/agent/AGENTS.md          # global working rules for the agent
cp "$PKG/config/AGENTS.core.md"  ~/.pi/agent/AGENTS.core.md     # the distilled core `core-rules` re-injects; missing means the extension silently does nothing
cp "$PKG/config/web-search.json" ~/.pi/agent/web-search.json    # required by pi-web-access
mkdir -p ~/.pi/agent/themes
cp "$PKG/themes/"*.json          ~/.pi/agent/themes/            # optional: themes are already loaded from the package
```

`config/mcp.json` is **not** shipped, for the same reason as `config/models.json`: its entries are absolute paths of local MCP server executables. To use MCP servers, create `~/.pi/agent/mcp.json` (global) or a project `.mcp.json` yourself — the `mcp/` extension reads both, and registers no tools until one exists. See [configuration.md](configuration.md#mcpjson).

`config/settings.json` also overwrites your settings wholesale — read [configuration.md](configuration.md) first, because it pins `pnpm` in `npmCommand` and disables pi's built-in double-Escape action.

Then restart pi. Extensions are hot-reloadable in their auto-discovery directories (`/reload`), but `settings.json`, `AGENTS.md` and themes are read once at startup. `AGENTS.core.md` is the exception: `core-rules` reads it on every prompt, so an edit takes effect on the next message.

## Companion packages

The environment assumes two packages the extensions integrate with:

```bash
pi install npm:pi-web-access   # pi_web_search / fetch_content / source_check / get_search_content
pi install npm:pi-subagents    # subagent / bg_wait / subagent_supervisor
```

If you copied the shipped `config/settings.json`, both are already listed in its `packages` array — running the two commands above is still the reliable way to make sure they exist on disk, since it is exactly the action that writes those entries.

Two extensions behave differently without them:

- `recap` probes `pi-subagents` over its in-process event bus to avoid summarizing a conversation that still has background subagents running. Without the package the probe fails and is treated as "no subagents".
- `below-editor-after-statusline` exists to move `pi-subagents`' fleet status line under the statusline. Without the package there is usually nothing to move.

## Upgrade

```bash
pi update npm:@bachi/pi-coder     # one package
pi update --extensions            # all packages
```

Set `PI_CODING_AGENT_DIR` if you want a scratch agent directory instead of `~/.pi/agent`, which is useful for testing a release without touching your real setup:

```bash
PI_CODING_AGENT_DIR=/tmp/pi-scratch pi install npm:@bachi/pi-coder
```

## Uninstall

```bash
pi remove npm:@bachi/pi-coder
```

Then, if you copied them, delete the config files you applied (`~/.pi/agent/AGENTS.md`, `web-search.json`, `settings.json`) and the theme files you copied into `~/.pi/agent/themes/`. State written by individual extensions lives elsewhere and is never removed automatically — see the storage table in [extensions.md](extensions.md#state-on-disk).

`pi remove` only rewrites settings; it does not delete your config.
