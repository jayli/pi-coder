- **[Themes Live Demo](https://jayli.github.io/1d/pi-coder-palettes.html)**
- **[Architecture](https://jayli.github.io/1d/extensions-architecture.html)**

# @bachi/pi-coder

A complete [Pi](https://pi.dev) coding-agent environment packaged for npm: **32 extensions**, **5 themes**, a theme-authoring skill, and the global config files that make them work together.

This is a working setup, not a collection of demos. Every extension is used daily, and each one documents the pi internals it depends on in its own file header — including the failure that motivated it and the things that look like they could be simplified but cannot be.

- Repository: <https://github.com/jayli/pi-coder>
- Issues: <https://github.com/jayli/pi-coder/issues>

**Watch it work** — [demo-server-https.gif](https://cdn.jsdelivr.net/gh/jayli/pi-coder@main/assets/demo-server-https.gif): a four-item task list worked end to end, with the thinking line, collapsed bash runs, inline diff and statusline progress. GitHub will not embed it (7.3 MB, over the 5 MiB limit of the image proxy it routes every off-domain image through), so the link opens it in the browser.

## What it looks like

A startup header, a one-line statusline, a `❯` prompt, and a diff renderer that paints whole lines.

The header's title line is `pi v0.99.2 (deepseek-flash-qd with max effort)` — the version followed by the **current model and thinking level**, read live so `/model` and `shift+tab` are reflected on the next frame.

The startup list is pruned **entirely** — `[Context]`, `[Skills]`, `[Prompts]`, `[Extensions]` and `[Themes]` are all dropped, leaving nothing above the transcript. The statusline's second line is written by other extensions (`plan-mode` first, then `cwd-statusline` and `rewind`) through `ctx.ui.setStatus()`, so it grows with whatever you have installed.

Colors come from the active theme rather than from hardcoded values, so `/theme` repaints everything on the next frame.

### The `pi-coder-ayu` theme

<img src="https://cdn.jsdelivr.net/gh/jayli/pi-coder@main/assets/ayu1.png" alt="pi-coder-ayu theme" width="700">

## Install

```bash
pi install npm:@bachi/pi-coder
```

Extensions and themes are loaded straight from the package (see the `pi` manifest in `package.json`) — there is nothing to configure. Restart pi, then check `pi list` or run `pi config` to see every resource with its enable/disable toggle.

### Companion packages

This environment is built around three packages that are deliberately **not** bundled — they are heavy, they have their own release cycles, and `pi-subagents` needs `settings.json` entries that only make sense once it is installed:

```bash
pi install npm:pi-web-access              # pi_web_search / fetch_content / source_check / get_search_content
pi install npm:pi-subagents               # subagent / bg_wait / scripted workflows
pi install git:github.com/jayli/superpowers   # the skills the global AGENTS.md and plan mode refer to
```

All three are already listed in the shipped `config/settings.json`'s `packages` array, which is what pi reads to install them.

**`superpowers` is a pi package, not a skills directory.** It carries both an extension (a one-time persistent injection of the `using-superpowers` bootstrap) and 15 skills (`brainstorming`, `systematic-debugging`, `test-driven-development`, `writing-plans`, …), and pi pulls it to `~/.pi/agent/git/github.com/jayli/superpowers/`. That **replaced** the older manual arrangement — skills copied into `~/.agents/skills/` and found by pi's native scan — so there is nothing to copy by hand any more. Two extensions behave differently without it: `plan-mode`'s brainstorming mutual-exclusion gate can never fire (it detects a `read` of a `brainstorming/SKILL.md` path), and `verify-loop`'s completion discipline has no `verification-before-completion` skill to point at.

Without `pi-web-access` and `pi-subagents` two more degrade instead of failing: `recap` cannot tell whether a background subagent is still running (it treats the failed probe as "none"), and `below-editor-after-statusline` usually has nothing to move.

## What you get

### Extensions

| Extension | What it does |
| --- | --- |
| [`bash-command-collapse.ts`](extensions/bash-command-collapse.ts) | Overrides `bash`: a `• ` status dot (dim while running, green on success, red on failure), then the command behind a `Run ` prefix on at most 2 visual lines ending in `…`, with results hanging off the same tree and a single `└ ` on the first real output line (a failed command's `Command exited with code N` is detected by shape and painted `error`, expanded or not). No background and no boundary blank lines, hard-wrap at the column budget, shell syntax highlighting. **Long paths are abbreviated in the collapsed state only** — and only on `cat` / `cd` / `ls` / `ln` arguments and `NAME=<path>` assignments, never on a form that would need evaluation (variables, backticks, globs, quotes, `~`), so `import … from "/Users/…"` is left alone; the threshold is 40% of the command's usable columns and only the middle is elided (`<head>…/<tail>`, tail layers first). `ctrl+o` shows the command whole. The shape and its render assertions are in [`bash-command-collapse/render.test.ts`](extensions/bash-command-collapse/render.test.ts). |
| [`read-path-collapse.ts`](extensions/read-path-collapse.ts) | Overrides `read`'s title row: the same `• ` dot and no-background shell as the bash block, results indented to the `Read` column, and long paths on one line with the ellipsis at the front and the file name kept whole. |
| [`tool-diff.ts`](extensions/tool-diff.ts) | Overrides `edit`/`write`: Claude Code style full-line diff backgrounds, line-number gutter, inline and syntax highlighting. |
| [`thinking-collapse.ts`](extensions/thinking-collapse.ts) | Thinking blocks render as one continuous horizontally scrolling line labelled `Think: `. |
| [`user-message-bar/`](extensions/user-message-bar/) | A `▏` (U+258F) plus one space at the head of every line of a user message box, including the blank padding lines, in the theme's `accent` color. The glyph replaces the one column of left padding and the extra indent is taken back out of the trailing padding, so background, width and wrap positions stay as they were. |
| [`prompt-editor.ts`](extensions/prompt-editor.ts) | A `❯ ` gutter in the editor, Claude Code style `!` bash mode, plus a blank line between the autocomplete list and the statusline. |
| [`fenceless-code-block/`](extensions/fenceless-code-block/) | Markdown code blocks lose their fences (syntax colors kept, no background added). |
| [`codemode-tree/`](extensions/codemode-tree/) | Renders the built-in `codemode` tool block as the same tree the bash and read blocks use: `• codemode` → syntax-highlighted script on `│ ` → result tree with one `└ `. The dot is three-state (white running, green success, red failure) and is the only outcome lamp now that the background is gone. It gets codemode's execution logic by running pi's own `createCodemodeExtension()` against a `Proxy` that captures the registered definition, so the schema stays the same object reference pi's MCP extension checks. Needs pi **0.99.1** and the shipped `settings.json`'s `-builtin:codemode` + `+codemode` pair. `PI_CODEMODE_TREE=off` removes the tool entirely rather than restoring the built-in. |
| [`statusline/`](extensions/statusline/) | Replaces the footer: model/thinking level, context usage, git branch and diff stat, plus a second line for extension statuses and a reserved last line for the background-task dock. The main line's last segment has four priority-ordered states: the `reporting` lamp while a spoken summary is in flight ([`voice/`](extensions/voice/)) first, then the running tool name, then `thinking`, then nothing. |
| [`startup-logo/`](extensions/startup-logo/) | Header logo whose title line carries the version, the **current model and thinking level** (`pi v0.99.2 (deepseek-flash-qd with max effort)`, read live so `/model` and `shift+tab` follow on the next frame) and the shortened cwd, every line indented one column and width-clamped because pi-tui throws on an over-wide line; prunes the **entire** startup resource list (`[Context]`/`[Skills]`/`[Prompts]`/`[Extensions]`/`[Themes]`). It fades in **silently after 500 ms with a 1 s diagonal wave** sweeping the 4×4 mark right-to-left, the title line and cwd fading in with it; the settled frame is byte-identical to the old static logo. Interpolation is in **OKLCH**, not sRGB — a plain sRGB ramp would pass through the theme's “added line” green on some palettes, which reads wrong on a startup screen. `PI_LOGO=off` skips all of it. |
| [`working-indicator/`](extensions/working-indicator/) | Semantic working message (`Tools Calling`, `Editing`, `Writing`, `Reading`, `Thinking`) with per-segment token counts and elapsed time, plus a `Subagent watchdog reviewing` message for the window where `pi-subagents`' watchdog blocks after `agent_end` and the spinner would otherwise turn unexplained. |
| [`simple-task/`](extensions/simple-task/) | Task list driven by `task_set` / `task_update` / `task_get` and `/tasks`; state rides the session log, never the repo. All three tools use `renderShell: "self"`, so their blocks carry no background and no boundary blank lines, with one leading space per line — the same shell as the bash and read blocks. The widget draws at most **8 rows and scrolls with progress**: the anchor is the first unfinished task, the window moves the minimum amount, and a fully finished list stays at its end. `… N more` appears above only when earlier rows scrolled off; `… and N more` below. |
| [`recap/`](extensions/recap/) | `/recap` (idempotent: re-running it while the summary is on screen does nothing), plus an automatic summary above the editor after 10s of idling. |
| [`rewind/`](extensions/rewind/) | Shadow-git checkpoints and `/rewind` (or Esc Esc) to restore code and/or conversation. |
| [`ask-user-question/`](extensions/ask-user-question/) | An `ask_user_question` tool: up to 4 questions with 2–4 described options plus a free-text row, answered in the terminal. Its block uses `renderShell: "self"`, so it carries no background and no boundary blank lines. |
| [`auto-default-model/`](extensions/auto-default-model/) | Writes every model switch to `settings.json` — the Ctrl+S step, automated. |
| [`subagent-log-guard/`](extensions/subagent-log-guard/) | Stops `[pi-subagents]` stderr diagnostics from corrupting the TUI. |
| [`cwd-statusline.ts`](extensions/cwd-statusline.ts) | Prints the full working directory as a second statusline line. |
| [`below-editor-after-statusline.ts`](extensions/below-editor-after-statusline.ts) | Moves `belowEditor` widgets underneath the statusline. |
| [`folder-history.ts`](extensions/folder-history.ts) | Persists command history per working directory and injects it into the editor's native ↑/↓. |
| [`theme-command.ts`](extensions/theme-command.ts) | `/theme` with live preview: arrow keys preview, Enter persists, Esc cancels. |
| [`plan-mode/`](extensions/plan-mode/) | Claude Code style plan mode plus a **three-state permission mode** (`dangerous` / `bypass` / `plan`). `shift+tab` walks the fixed cycle `dangerous → bypass → plan → dangerous`; `/plan` only ever toggles `plan` (never lands on `dangerous`), `--plan` starts in it. `dangerous` switches the seatbelt delete boundary **off** at runtime, `bypass` (the default) keeps it on, `plan` is read-only exploration with `edit`/`write` dropped and write-shaped `bash` blocked. The model's own `enter_plan_mode` carries all the routing criteria in its tool description, asks for **consent first** — a two-option dialog where `直接实施` (or Esc) skips planning — and is skipped entirely when the `brainstorming` skill was already loaded this run. `exit_plan_mode` submits the plan for approval — full markdown, a `slug` that names the document and an optional summary — and the three-way dialog either writes `.pi/plans/<date>-<slug>.md` and implements it, writes the document only, or rejects. There is no execute phase and no progress table of its own; the model builds a task list itself if one is warranted. |
| [`memory/`](extensions/memory/) | Claude Code style auto-memory: `memory_write` / `memory_read` / `memory_forget` / `memory_search` plus `/memory` (status, open folder, show index, per-project toggle). One file per memory under `~/.pi/agent/memory/<project-slug>/` with CC-compatible frontmatter, and a `MEMORY.md` index the extension **derives mechanically** after every write — the model never hand-maintains it, so "wrote a memory but never updated the index" cannot happen. Injected through `systemPromptOptions.sections.memory` (discipline text + index), which survives compaction. `PI_MEMORY=off` disables it. |
| [`background-tasks/`](extensions/background-tasks/) | Minimal `run_in_background` for pi, which ships no background-execution primitive: `run_in_background` / `background_output` (incremental reads) / `background_kill` plus `/background` (list, details + log tail, kill). A terminal state injects a `<background-task-notification>` and wakes the model — no polling. Tasks live and die with the pi session (`killAll()` on shutdown; `detached` only to kill the whole process group). Running tasks also get a dock line at the very bottom of the footer (`⚙ bg_1 running 12s · command…`), which freezes while a prompt is open so it cannot drag your scrollback down. **Background commands bypass the seatbelt delete boundary** the foreground `bash` tool runs inside — the tool descriptions and `/background` say so. `PI_BACKGROUND_TASKS=off` disables it, `PI_BACKGROUND_TASKS_DOCK=off` only the dock line. |
| [`core-rules/`](extensions/core-rules/) | Re-pushes the distilled global rules (`~/.pi/agent/AGENTS.core.md`, shipped as [`config/AGENTS.core.md`](config/AGENTS.core.md)) to the **end** of the context at session start, after a compaction and whenever the content changed — the full `AGENTS.md` sits at the front of the system prompt, where its recency decays. Nothing is injected when nothing changed. |
| [`verify-loop/`](extensions/verify-loop/) | Verification discipline as code, mirroring two Claude Code mechanisms on pi's `agent_before_settle` boundary. **The gate**: when a turn settles after file changes with no bash command run after them, it injects a visible message and forces one more turn (cap 2, counted from the projection, not memory). **`/goal`**: a completion condition evaluated after every turn by one tool-less model call (`met` / `not_met` / `impossible`, fail-open), with no-progress detection, an 8-continuation cap and resume support. `PI_VERIFY_LOOP=off\|notify\|block` switches the gate. |
| [`sandbox-boundary/`](extensions/sandbox-boundary/) | The non-shell half of the delete boundary: `bash` runs inside a seatbelt profile, but `write` / `edit` are direct `fs` calls, so `apply_patch`'s `*** Delete File:` lines are checked on the `tool_call` hook instead. Shares one whitelist and one persistent allowlist with the bash side. |
| [`init-command.ts`](extensions/init-command.ts) | Claude Code style `/init`: update `CLAUDE.md`, else `AGENTS.md`, else create `AGENTS.md`. |
| [`clear-command.ts`](extensions/clear-command.ts) | `/clear` as an alias of `/new`. |
| [`web-search-tree/`](extensions/web-search-tree/) | Renders `pi-web-access`'s three self-rendering tool blocks (`pi_web_search`, `fetch_content`, `get_search_content`) as the same tree as the bash / read / codemode blocks — same column table, three-state dot, children rendered at `width - 4`. Unlike the others, `└ ` hangs on the **last** line, because that is where the `ctrl+o` hint to the full sources lives. It captures the package's own definitions through a `registerTool`-only `Proxy`, so routing, storage and the model-visible text are untouched; `source_check` and `web_enable` are deliberately left alone. Requires the shipped `settings.json`'s object-form `pi-web-access` entry with `"extensions": []` — the package also registers those three names, and pi resolves that as a conflict. `PI_WEB_SEARCH_TREE=off` disables it; with the package filtered, `pi_web_search` then disappears entirely. |
| [`voice/`](extensions/voice/) | Speaks the final conclusion aloud on `turn_end` (with `agent_settled` as a fallback), so you can hear the answer instead of reading it. Markdown is flattened into speakable prose — code blocks, tables, URLs, file paths and emoji dropped, over-long text cut at a sentence boundary — then rewritten by a **fixed fast model** (`deepseek-flash-qd`, low effort) into a 1–3 sentence spoken script, because stripping markup cannot shorten the content itself. The summary caps are hard: **100 chars, and never longer than the source**. Uses macOS `say`; give it an Aliyun key (`/voice key sk-xxx`) and it switches to `qwen-audio-3.1-tts-flash`, where `aliyunInstruction` can ask for any accent (the shipped `config/voice.json` asks for Chongqing). Interruptible from four places (`agent_start`, interactive `input`, `session_shutdown`, and **Esc — swallowed**, so stopping the speech does not also interrupt the turn); single-slot background playback never blocks the turn; every failure falls back to `say` or to the locally trimmed text. `/voice` shows status and drives `on` / `off` / `summary` / `test` / `voices` / `stop`; `PI_VOICE=off` disables it. |
| [`exit-command.ts`](extensions/exit-command.ts) | `exit`, `quit` or `bye` on an otherwise empty prompt quits pi; `/exit` too. |

### Themes

Five themes ship with this package: `pi-coder-1337` (the default here, ported from Codex CLI's built-in `1337`), `pi-coder-catppuccin`, `pi-coder-ayu`, and the two newest — `pi-coder-coffee` (from `coffee.vim`) and `pi-coder-nightfox` (from `nightfox.nvim`). They are reference-only palettes whose `colors` entries point at `vars`, plus two custom diff-background tokens that [`tool-diff.ts`](extensions/tool-diff.ts) reads. `vars` keeps only what a slot still references. Details in [docs/themes.md](docs/themes.md).

All five are laid out side by side in the [palette reference](https://raw.githack.com/jayli/pi-coder/main/assets/pi-coder-palettes.html): every variable and slot assignment, plus a terminal preview you can switch between the themes.

**A sixth is one skill away.** [`skills/pi-theme-from-palette/`](skills/pi-theme-from-palette/) turns any existing palette — a vim colorscheme, a tmTheme plist, a Codex theme export, or a bare list of hex values — into a pi theme file: the 22 primary slots are re-derived from your colors, the other 37 are copied byte-for-byte from `pi-coder-1337`, and it carries the verification script (pi's own loader, both `truecolor` and `256color`, asserting the secondary slots did **not** move). It is a package resource, so installing the package brings it along. This is how `pi-coder-coffee` and `pi-coder-nightfox` were built.

### Commands

`/ask` `/background` `/bash-preview` `/bash-timeout` `/clear` `/exit` `/goal` `/init` `/memory` `/plan` `/plan-status` `/recap` `/rewind` `/sandbox-boundary` `/tasks` `/theme` `/voice`

`/mcp` is **not** one of them: MCP is pi's own built-in extension (`builtin:mcp`) since pi 0.99.1, and this package no longer ships an MCP extension of its own — the retired implementation conflicted with the built-in over the `/mcp` registration. See [docs/extensions.md](docs/extensions.md#mcp-servers--pis-built-in-extension-not-this-packages).

Esc Esc opens `/rewind` (requires `doubleEscapeAction: "none"`, which the shipped config sets).

### Environment switches

Every switch is an environment variable, so it can be scoped per project or set in a shell alias. An unset variable means "on"; `off` always disables. The full table is in [docs/extensions.md](docs/extensions.md#environment-switches) — highlights:

| Variable | Default | Effect |
| --- | --- | --- |
| `PI_AUTO_DEFAULT_MODEL=off` | on | Do not persist model switches to `settings.json`. |
| `PI_BACKGROUND_TASKS=off` | on | Disable the background-task tools and `/background`; `PI_BACKGROUND_TASKS_DIR` moves the log root (used for test isolation), `PI_BACKGROUND_TASKS_DOCK=off` removes only the statusline dock line, `PI_BACKGROUND_TASKS_WORKTREE=off` runs every task in the working directory instead of an isolated git worktree. |
| `PI_BASH_STREAM=on` | off | Use pi's native streaming for bash instead of the collapse path. |
| `PI_CODEMODE_TREE=off` | on | Do not register `codemode`; with the shipped `-builtin:codemode` setting this removes the tool entirely rather than restoring pi's built-in rendering. |
| `PI_CORE_RULES=off` | on | Do not re-inject the distilled global rules into the context. |
| `PI_VOICE=off` | on | Disable spoken conclusions entirely; `PI_VOICE_CONFIG` moves `voice.json`, and `PI_VOICE_TTS_ENDPOINT` / `PI_VOICE_AFPLAY_BIN` swap the TTS endpoint and player (used by the tests). |
| `PI_DESTRUCTIVE_GUARD` | `on` | `block` rejects the confirm tier too, `notify` only reports what it would have caught, `off` disables the gate. |
| `PI_FENCELESS_CODE=off` | on | Keep Markdown code fences. |
| `PI_LOGO=off` | on | Do not install the startup header. |
| `PI_MEMORY=off` | on | Disable auto-memory entirely; `PI_MEMORY_DIR` moves the memory root (used for test isolation). |
| `PI_PLAN_MODE=off` | on | Disable plan mode entirely (`PI_PLAN_MODE_AUTO=off` only disables the model's `enter_plan_mode` tool, `PI_PLAN_MODE_CONSENT=off` only its consent dialog). |
| `PI_READ_COLLAPSE=off` | on | Keep pi's built-in `read` title row. |
| `PI_SANDBOX=off` | on | Disable the delete boundary (both the bash seatbelt profile and the `apply_patch` gate); also off automatically off macOS. `PI_SANDBOX_EXTRA_WRITE` adds delete roots, `PI_SANDBOX_ALLOWLIST` moves the persistent allowlist file. |
| `PI_SUBAGENT_LOG_GUARD=notify` | `drop` | Show `[pi-subagents]` diagnostics through `ctx.ui.notify` instead of dropping them. |
| `PI_VERIFY_LOOP` | `block` | The verification gate's force: `off` disables it, `notify` reports without forcing a continuation. `PI_VERIFY_PATTERN=strict` narrows "verification" to test/build/lint shapes; `PI_VERIFY_EVALUATOR_MODEL` picks the `/goal` evaluator model. |
| `PI_WEB_SEARCH_TREE=off` | on | Do not take over `pi-web-access`'s three tool blocks; with the shipped `packages` filter this removes `pi_web_search` rather than restoring the package's own rendering. |

## Global config files

Five files in [`config/`](config) are not package resources — pi reads them from `~/.pi/agent/`, so copy the ones you want by hand. pi installs the package under `~/.pi/agent/npm/node_modules/@bachi/pi-coder` (project installs go to `.pi/npm/node_modules/`):

```bash
PKG=~/.pi/agent/npm/node_modules/@bachi/pi-coder

cp "$PKG/config/AGENTS.md"          ~/.pi/agent/AGENTS.md          # global working rules
cp "$PKG/config/AGENTS.core.md"     ~/.pi/agent/AGENTS.core.md     # the distilled core `core-rules` re-injects; missing means it silently does nothing
cp "$PKG/config/settings.json"      ~/.pi/agent/settings.json      # read this first!
cp "$PKG/config/web-search.json"    ~/.pi/agent/web-search.json    # required by pi-web-access
mkdir -p ~/.pi/agent/themes
cp "$PKG/themes/"*.json             ~/.pi/agent/themes/            # optional: also shipped as a package theme
```

> **If you already copied these extensions into `~/.pi/agent/extensions/`, remove that copy first.** pi loads both sources, the second registration of `bash`, `read`, `edit`, `write` and the rest conflicts, and pi refuses to start with `Tool "bash" conflicts with ...`.

**Read [`config/settings.json`](config/settings.json) before copying it.** It overwrites your settings wholesale, and two of its entries are machine-specific:

- `npmCommand` pins `pnpm --config.node-linker=hoisted`. Remove it if you do not have pnpm, or `pi install` will fail.
- `doubleEscapeAction: "none"` hands Esc-Esc to the `rewind` extension instead of pi's built-in tree navigator.

`config/models.json` and `config/mcp.json` are **not** shipped: provider registrations point at a local gateway and the MCP file holds absolute paths of local server executables, so both belong to the machine that runs them. MCP servers are configured in `~/.pi/agent/mcp.json` or a project `.pi/mcp.json`, which pi's built-in `builtin:mcp` reads. See [docs/configuration.md](docs/configuration.md).

## Requirements

- pi **0.85.1** or newer (the extensions are written against this version's internals), Node **22.19+**. 30 of the 32 entries load with `errors: []` through pi's own loader on 0.85.1 and 0.87.1; all 32 do on 0.99.1 and 0.99.2. The one that needs 0.99.1 is `codemode-tree/`, which captures the built-in `codemode` tool through `createCodemodeExtension()` — a function that only exists from 0.99.1 on, so on an older pi that single entry fails to load and the rest are unaffected.
- `voice/` needs macOS for playback — the local engine shells out to `say` and the Aliyun path plays through `afplay`. Synthesis itself is plain HTTP, but with no player present it reports the failure once and stays silent rather than failing to load.
- MCP needs pi **0.99.1**, which is where `builtin:mcp` arrived. This package no longer ships an MCP extension, so on an older pi there are simply no MCP tools.
- macOS or Linux. Nothing is Windows-specific, but it is untested there.
- Optional but assumed by a few extensions: `pi-web-access` (the web tools), `pi-subagents` (subagent events, fleet status line) and `superpowers` (the skills `plan-mode`'s `brainstorming` gate and `verify-loop`'s completion discipline refer to). All three are listed in the shipped `config/settings.json`'s `packages` array.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/installation.md](docs/installation.md) | Install, verify, upgrade, uninstall, and the local-checkout workflow. |
| [docs/configuration.md](docs/configuration.md) | Every shipped config file, what was removed from the snapshot, and why. |
| [docs/extensions.md](docs/extensions.md) | Reference for all 32 extensions: commands, switches, caveats, storage. |
| [docs/themes.md](docs/themes.md) | Theme files, the custom tokens, and the rules that make them load. |
| [Palette reference](https://raw.githack.com/jayli/pi-coder/main/assets/pi-coder-palettes.html) | **Chinese.** Every variable and slot assignment for the themes, with a terminal preview that switches between them. |
| [docs/development.md](docs/development.md) | Running the 1662 unit tests, verifying against a real pi, publishing. |
| [docs/handbook.zh.md](docs/handbook.zh.md) | **Chinese.** The original handbook this package was extracted from: the author's machine, gateway setup, and the full rationale behind every design decision. |

## Development

```bash
npm test        # node --test, 1662 tests
```

The pure-logic modules are deliberately free of `@earendil-works/pi-*` imports so they run under plain `node --test`; see [docs/development.md](docs/development.md) for the layout rules, the tmux verification procedure and the traps this codebase documents.

## License

MIT — see [LICENSE](LICENSE).
