**[Themes Live Demo](https://jayli.github.io/1d/pi-coder-palettes.html)**

# @bachi/pi-coder

A complete [Pi](https://pi.dev) coding-agent environment packaged for npm: **24 extensions**, **3 themes**, and the global config files that make them work together.

This is a working setup, not a collection of demos. Every extension is used daily, and each one documents the pi internals it depends on in its own file header — including the failure that motivated it and the things that look like they could be simplified but cannot be.

- Repository: <https://github.com/jayli/pi-coder>
- Issues: <https://github.com/jayli/pi-coder/issues>

**Watch it work** — [demo-server-https.gif](https://cdn.jsdelivr.net/gh/jayli/pi-coder@main/assets/demo-server-https.gif): a four-item task list worked end to end, with the thinking line, collapsed bash runs, inline diff and statusline progress. GitHub will not embed it (7.3 MB, over the 5 MiB limit of the image proxy it routes every off-domain image through), so the link opens it in the browser.

## What it looks like

A startup header, a one-line statusline, a `❯` prompt, and a diff renderer that paints whole lines.

The startup list loses its `[Context]`, `[Prompts]` and `[Themes]` sections, which carry no information. The statusline's second line is written by other extensions (`cwd-statusline`, `simple-task`, `rewind`) through `ctx.ui.setStatus()`, so it grows with whatever you have installed.

Colors come from the active theme rather than from hardcoded values, so `/theme` repaints everything on the next frame.

### The `pi-coder-ayu` theme

<img src="https://cdn.jsdelivr.net/gh/jayli/pi-coder@main/assets/ayu1.png" alt="pi-coder-ayu theme" width="700">

## Install

```bash
pi install npm:@bachi/pi-coder
```

Extensions and themes are loaded straight from the package (see the `pi` manifest in `package.json`) — there is nothing to configure. Restart pi, then check `pi list` or run `pi config` to see every resource with its enable/disable toggle.

### Companion packages

This environment is built around two packages that are deliberately **not** bundled — they are heavy, they have their own release cycles, and `pi-subagents` needs `settings.json` entries that only make sense once it is installed:

```bash
pi install npm:pi-web-access   # pi_web_search / fetch_content / source_check / get_search_content
pi install npm:pi-subagents    # subagent / bg_wait / scripted workflows
```

Without them two extensions degrade instead of failing: `recap` cannot tell whether a background subagent is still running (it treats the failed probe as "none"), and `below-editor-after-statusline` usually has nothing to move.

## What you get

### Extensions

| Extension | What it does |
| --- | --- |
| [`bash-command-collapse.ts`](extensions/bash-command-collapse.ts) | Overrides `bash`: long commands collapse to 3 visual lines with a `… (N tokens hidden)` hint, hard-wrap at the column budget, shell syntax highlighting, and its own background box. Tree indentation and streaming are startup-only env switches (`PI_BASH_TREE`, `PI_BASH_STREAM`). |
| [`read-path-collapse.ts`](extensions/read-path-collapse.ts) | Overrides `read`'s title row: long paths stay on one line, ellipsis at the front, file name kept whole. |
| [`tool-diff.ts`](extensions/tool-diff.ts) | Overrides `edit`/`write`: Claude Code style full-line diff backgrounds, line-number gutter, inline and syntax highlighting. |
| [`thinking-collapse.ts`](extensions/thinking-collapse.ts) | Thinking blocks render as one continuous horizontally scrolling line labelled `Think: `. |
| [`user-message-bar/`](extensions/user-message-bar/) | A `▏` at the head of every line of a user message box, including the blank padding lines, in the theme's `toolDiffAdded` color. It replaces the one column of left padding, so background, width and wrap positions stay as they were. |
| [`prompt-editor.ts`](extensions/prompt-editor.ts) | A `❯ ` gutter in the editor, Claude Code style `!` bash mode, plus a blank line between the autocomplete list and the statusline. |
| [`fenceless-code-block/`](extensions/fenceless-code-block/) | Markdown code blocks lose their fences (syntax colors kept, no background added). |
| [`statusline/`](extensions/statusline/) | Replaces the footer: model/thinking level, context usage, git branch and diff stat, plus a second line for extension statuses. |
| [`startup-logo/`](extensions/startup-logo/) | Static header logo with version and shortened cwd, and prunes `[Context]`/`[Prompts]`/`[Themes]` from the startup list. |
| [`working-indicator/`](extensions/working-indicator/) | Semantic working message (`Tools Calling`, `Editing`, `Writing`, `Reading`, `Thinking`) with per-segment token counts and elapsed time. |
| [`simple-task/`](extensions/simple-task/) | Task list driven by `task_set` / `task_update` / `task_get` and `/tasks`; state rides the session log, never the repo. |
| [`recap/`](extensions/recap/) | `/recap`, plus an automatic summary above the editor after 10s of idling. |
| [`rewind/`](extensions/rewind/) | Shadow-git checkpoints and `/rewind` (or Esc Esc) to restore code and/or conversation. |
| [`ask-user-question/`](extensions/ask-user-question/) | An `ask_user_question` tool: up to 4 questions with 2–4 described options plus a free-text row, answered in the terminal. |
| [`mcp/`](extensions/mcp/) | MCP servers become pi tools (`mcp__<server>__<tool>`) over stdio, streamable HTTP or legacy SSE, with `/mcp` status commands. |
| [`auto-default-model/`](extensions/auto-default-model/) | Writes every model switch to `settings.json` — the Ctrl+S step, automated. |
| [`subagent-log-guard/`](extensions/subagent-log-guard/) | Stops `[pi-subagents]` stderr diagnostics from corrupting the TUI. |
| [`cwd-statusline.ts`](extensions/cwd-statusline.ts) | Prints the full working directory as a second statusline line. |
| [`below-editor-after-statusline.ts`](extensions/below-editor-after-statusline.ts) | Moves `belowEditor` widgets underneath the statusline. |
| [`folder-history.ts`](extensions/folder-history.ts) | Persists command history per working directory and injects it into the editor's native ↑/↓. |
| [`theme-command.ts`](extensions/theme-command.ts) | `/theme` with live preview: arrow keys preview, Enter persists, Esc cancels. |
| [`init-command.ts`](extensions/init-command.ts) | Claude Code style `/init`: update `CLAUDE.md`, else `AGENTS.md`, else create `AGENTS.md`. |
| [`clear-command.ts`](extensions/clear-command.ts) | `/clear` as an alias of `/new`. |
| [`exit-command.ts`](extensions/exit-command.ts) | `exit`, `quit` or `bye` on an otherwise empty prompt quits pi; `/exit` too. |

### Themes

`pi-coder-summer-night` (the default here), `pi-coder-catppuccin` and `pi-coder-ayu` — reference-only palettes whose `colors` entries point at `vars`, plus two custom diff-background tokens that [`tool-diff.ts`](extensions/tool-diff.ts) reads. Details in [docs/themes.md](docs/themes.md).

All three are laid out side by side in the [palette reference](https://raw.githack.com/jayli/pi-coder/main/assets/pi-coder-palettes.html): every variable and slot assignment, plus a terminal preview you can switch between the three themes.

### Commands

`/ask` `/bash-preview` `/bash-timeout` `/clear` `/exit` `/init` `/mcp` `/recap` `/rewind` `/tasks` `/theme`

Esc Esc opens `/rewind` (requires `doubleEscapeAction: "none"`, which the shipped config sets).

### Environment switches

Every switch is an environment variable, so it can be scoped per project or set in a shell alias. An unset variable means "on"; `off` always disables. The full table is in [docs/extensions.md](docs/extensions.md#environment-switches) — highlights:

| Variable | Default | Effect |
| --- | --- | --- |
| `PI_AUTO_DEFAULT_MODEL=off` | on | Do not persist model switches to `settings.json`. |
| `PI_BASH_STREAM=on` | off | Use pi's native streaming for bash instead of the collapse path. |
| `PI_BASH_TREE=off` | on | Disable tree indentation (`│`/`└`) for bash output. |
| `PI_FENCELESS_CODE=off` | on | Keep Markdown code fences. |
| `PI_LOGO=off` | on | Do not install the startup header. |
| `PI_SUBAGENT_LOG_GUARD=notify` | `drop` | Show `[pi-subagents]` diagnostics through `ctx.ui.notify` instead of dropping them. |

## Global config files

Four files in [`config/`](config) are not package resources — pi reads them from `~/.pi/agent/`, so copy the ones you want by hand. pi installs the package under `~/.pi/agent/npm/node_modules/@bachi/pi-coder` (project installs go to `.pi/npm/node_modules/`):

```bash
PKG=~/.pi/agent/npm/node_modules/@bachi/pi-coder

cp "$PKG/config/AGENTS.md"          ~/.pi/agent/AGENTS.md          # global working rules
cp "$PKG/config/settings.json"      ~/.pi/agent/settings.json      # read this first!
cp "$PKG/config/web-search.json"    ~/.pi/agent/web-search.json    # required by pi-web-access
mkdir -p ~/.pi/agent/themes
cp "$PKG/themes/"*.json             ~/.pi/agent/themes/            # optional: also shipped as a package theme
```

> **If you already copied these extensions into `~/.pi/agent/extensions/`, remove that copy first.** pi loads both sources, the second registration of `bash`, `read`, `edit`, `write` and the rest conflicts, and pi refuses to start with `Tool "bash" conflicts with ...`.

**Read [`config/settings.json`](config/settings.json) before copying it.** It overwrites your settings wholesale, and two of its entries are machine-specific:

- `npmCommand` pins `pnpm --config.node-linker=hoisted`. Remove it if you do not have pnpm, or `pi install` will fail.
- `doubleEscapeAction: "none"` hands Esc-Esc to the `rewind` extension instead of pi's built-in tree navigator.

`config/models.json` and `config/mcp.json` are **not** shipped: provider registrations point at a local gateway and the MCP file holds absolute paths of local server executables, so both belong to the machine that runs them. MCP servers are configured in `~/.pi/agent/mcp.json` or a project `.mcp.json` — the `mcp/` extension reads both. See [docs/configuration.md](docs/configuration.md).

## Requirements

- pi **0.85.1** or newer (the extensions are written against this version's internals), Node **22.19+**.
- macOS or Linux. Nothing is Windows-specific, but it is untested there.
- Optional but assumed by a few extensions: `pi-web-access` (the web tools) and `pi-subagents` (subagent events, fleet status line).

## Documentation

| Document | Contents |
| --- | --- |
| [docs/installation.md](docs/installation.md) | Install, verify, upgrade, uninstall, and the local-checkout workflow. |
| [docs/configuration.md](docs/configuration.md) | Every shipped config file, what was removed from the snapshot, and why. |
| [docs/extensions.md](docs/extensions.md) | Reference for all 24 extensions: commands, switches, caveats, storage. |
| [docs/themes.md](docs/themes.md) | Theme files, the custom tokens, and the rules that make them load. |
| [Palette reference](https://raw.githack.com/jayli/pi-coder/main/assets/pi-coder-palettes.html) | **Chinese.** Every variable and slot assignment for the three themes, with a terminal preview that switches between them. |
| [docs/development.md](docs/development.md) | Running the 631 unit tests, verifying against a real pi, publishing. |
| [docs/handbook.zh.md](docs/handbook.zh.md) | **Chinese.** The original handbook this package was extracted from: the author's machine, gateway setup, and the full rationale behind every design decision. |

## Development

```bash
npm test        # node --test, 631 tests
```

The pure-logic modules are deliberately free of `@earendil-works/pi-*` imports so they run under plain `node --test`; see [docs/development.md](docs/development.md) for the layout rules, the tmux verification procedure and the traps this codebase documents.

## License

MIT — see [LICENSE](LICENSE).
