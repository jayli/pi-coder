# Changelog

All notable changes to this package. The extensions themselves are snapshot copies from the author's pi environment; their individual histories live in that repository.

## Unreleased

### Fixed

- **`folder-history.ts`** — Windows `cwd` (`D:\Program Files\tty7`) was joined into `~/.pi/folder-history\D:\Program Files\tty7.jsonl` because only `/` was replaced, so `appendFileSync` threw ENOENT on every prompt. Filename sanitization now matches upstream `pi-command-history`: replace `[\\/]+` with `-` and strip `:`. Logic lives in `folder-history/path.ts` (no `index.ts`, so pi does not load the directory as an extension). Suite grows 624 → 631.

## 2.0.4 — 2026-09-20

Snapshot sync: the statusline branch icon moved to a code point no font on this machine covers, all three themes dropped their pending-card background, and `pi-coder-catppuccin` joined the other two on the neutral grey thinking border. The `tool-pending-bar` extension that briefly marked pending cards landed upstream and was reverted before this sync, so it is not part of the snapshot.

### Changed

- **`statusline/`** — the git-branch icon is now `ᗌ` (U+15CC, CANADIAN SYLLABICS CARRIER RE), replacing `⑂` (U+2442, OCR FORK) and, before that, the Powerline / Nerd Font glyph U+E0A0 and `⎇` (U+2387). U+15CC is present in **none** of the three fonts in the author's Ghostty stack (`Lyth Mono Term`, `JetBrainsMonoNL Nerd Font Mono`, `Maple Mono SC NF`) and is drawn through system fallback — macOS covers it with `Euphemia UCAS` (advance ≈ 0.98 of a cell) and `Noto Sans CanAborig`, so it does not degrade to a missing-glyph box; the fractional advance does not affect alignment because the terminal places glyphs on fixed cells. On an environment without such a fallback, the previous `⑂` (present in `Lyth Mono Term`) is the one to go back to. Width is unchanged: one column, East Asian Width Neutral, so the truncation budget does not move.
- **`themes/pi-coder-summer-night.json`** — `toolPendingBg` is now the empty string, so a tool card that is still running keeps the terminal's default background. A pending card carries no badge or tint either, so nothing changes at the moment it finishes; the card's colors switch only on success or failure. `vars.pendingCard` (`#101017`) is left in the file unreferenced.
- **`themes/pi-coder-catppuccin.json`** — same `toolPendingBg` change (it moved `pendingPanel` → `""` on top of the earlier hex conversion of upstream's 256-color index), and `thinkingXhigh` / `thinkingMax` leave the palette's `blue` for a neutral grey added as `vars.thinkingGrey` (`#626262`) — the value `pi-coder-ayu` and `pi-coder-summer-night` already use, so all three themes now paint the two highest thinking levels the same grey. `vars.pendingPanel` (`#0b151f`) is left in the file unreferenced.
- **`themes/pi-coder-ayu.json`** — same `toolPendingBg` change; `vars.toolPendingBg` (`#171717`) is left in the file unreferenced. The file is otherwise byte-identical to 2.0.2.
- Documentation resynced: [docs/themes.md](docs/themes.md) (the blank `toolPendingBg` in all three themes, catppuccin's `thinkingGrey` deviation, the `vars` counts), [docs/extensions.md](docs/extensions.md) (the branch icon and its font coverage) and [docs/handbook.zh.md](docs/handbook.zh.md) (the same three theme passages, now on the upstream no-background reading).

### Unchanged

The test suite stays at **624 tests**, and no color value moved apart from the three `toolPendingBg` entries and catppuccin's new `thinkingGrey`: the `statusline` change is comments plus one exported constant, and `line.test.ts` pins the new code point.

## 2.0.2 — 2026-09-20

Snapshot sync: a new extension, a resynced palette page, a rebuilt `pi-coder-summer-night` palette whose added-line color is now green, a re-tuned pending-card background in `pi-coder-ayu`, a shorter `recap` idle delay, a session-replacement crash fix in `user-message-bar` and a `statusline/` branch icon that no longer needs a Nerd Font.

### Added

- **`user-message-bar/`** — a `▏` at the head of every line of a user message box, including the blank padding lines above and below the text. It replaces the single column of left padding `Box` already reserves, so the background, the line width and the wrap positions are unchanged — a bar drawn next to the padding would make pi-tui's renderer throw `Rendered line N exceeds terminal width` and take the TUI down. The color is the theme's `toolDiffAdded` (with `selectedBg` / `accent` / `text` as fallbacks); `PI_USER_MESSAGE_BAR=off` disables the bar and `PI_USER_MESSAGE_BAR_COLOR=<slot>` picks another slot, converting a background slot such as `selectedBg` to a foreground. The patch on `UserMessageComponent.prototype.render` goes in at module-evaluation time and receives the live theme on `session_start`, so it follows `/theme`; `bar.ts` holds the pi-free logic and `index.test.ts` loads the extension through pi's own loader to compare patched and unpatched frames — that test is what proves the patch landed on the class pi actually renders with.

### Changed

- **`themes/pi-coder-summer-night.json`** — resynced. The Tokyo Night base stays (`night` / `panel` / `select` / `find`), while foregrounds and lines now come from [iceberg.vim](https://github.com/cocopon/iceberg.vim): `fg` `#c6c8d1`, `muted` `#818596`, `dim` and `Think:` `#6b7089`, with red / green / yellow / magenta taken from its terminal palette. `text` points at `fg` instead of the terminal default, `bashOutput` is defined (`#818596`, a variable of its own, equal to `muted`), and no literal color value is left anywhere in the file — `export` included. The variables are renamed to Tokyo Night's names, so a local edit to the previous file's `bg` / `verdigris` / `fernMist` will not apply here. `toolDiffAdded` (added diff lines: their line numbers and `+`, and the default color of `user-message-bar`'s bar) also moved, from `teal` `#89b8c2` to a new variable `addedGreen` `#8bc391` — the conventional green: 7.83:1 on the `addedLine` background (was 7.36:1), and 4.96:1 for body text over the 30% inline tint `tool-diff.ts` lays down. It no longer matches `success`, which stays `teal`. The file is now 40 `vars`.
- **`themes/pi-coder-ayu.json`** — `toolPendingBg` moved from `#1b1c1d` to `#1f1f1f`, so a running tool card no longer shares the background of a user message. Only that token moved: `userMessageBg` and `customMessageBg` keep `#1b1c1d`.
- **`working-indicator/`** — the prompt summary is now requested for any prompt that does not fit (`PI_WORKING_SUMMARY_TRIGGER` default `1.2` → `1`; raise it to tolerate truncation, `2` means giving up half the prompt first), and a failed request — error, 45 s timeout, or a reply with no text — is retried once after `PI_WORKING_SUMMARY_RETRY_MS` (new switch, `3000` ms) instead of being dropped. Two attempts per prompt is the cap; a new prompt, the end of the turn or a session replacement cancels the pending retry.
- **`recap/`** — the automatic summary now appears after **10 seconds** of idling instead of 30 (`IDLE_MS` `30_000` → `10_000`, still hardcoded and still without any switch). The three guards around it are unchanged: a subagent that is still running blocks generation, a finished one is not summarized immediately, and the generation timeout stays at 45 s. Its real-timer end-to-end test is the suite's long pole and now runs in ~30 s (30.5 s in isolation here), which is essentially the whole of the suite's wall-time drop below.
- **`statusline/`** — the git-branch icon is now `⑂` (U+2442, OCR FORK) instead of the Powerline / Nerd Font private-use glyph U+E0A0, so the line no longer needs a patched font; the first version of it used `⎇` (U+2387). The replacement is one column wide with East Asian Width = Neutral, so the truncation budget does not move and a CJK-configured terminal cannot render it two columns wide. Font coverage was measured with fontTools on the author's stack: U+2442 is present in the first font of Ghostty's stack (`Lyth Mono Term`) and in neither Nerd Font fallback, so it is drawn through font fallback.
- **`assets/pi-coder-palettes.html`** — the palette reference resynced: it now reads the skin variables instead of hand-copied hex, the three main-color blocks and the thinking-level ladder are gone (123 lines fewer), the summer-night description is half its former length, and the `addedGreen` swap is reflected in its variable table and counts.
- Documentation resynced: [README](README.md), [docs/extensions.md](docs/extensions.md), [docs/themes.md](docs/themes.md), [docs/development.md](docs/development.md), [docs/installation.md](docs/installation.md) and [docs/handbook.zh.md](docs/handbook.zh.md).
- The suite grows from **596 to 624 tests** (the new extension, the summary retry path and the two `user-message-bar` regressions), and its wall time falls from ~73 s to ~34 s with the `recap` change.

### Fixed

- **`user-message-bar/`** — replacing the session (`/clear`, `/new`, `/resume`, `/fork`, `/reload`) could kill pi with `exit=1`. pi invalidates the old `ctx` while the previous session's user messages are still mounted and rendering, and the style source this extension had captured on `session_start` was read from inside a render tick, where the `This extension ctx is stale …` throw reaches pi's `uncaughtException` with nothing to catch it. The source is now reset on `session_shutdown` — which pi emits before the invalidation — and reading the theme is wrapped in a `try/catch`, so the worst case is a few frames drawn without the bar until the next `session_start`. Two regression tests cover both: rendering under an invalidated `ctx` neither throws nor draws, and rendering after shutdown never touches the old `ctx`. Both, plus a loader assertion that the `session_shutdown` hook is registered at all, fail against the previous revision.

### Not included

- `config/settings.json` and `config/models.json`. The snapshot's `defaultProvider`, `defaultModel` and `modelThinkingLevels` keys stay out for the same reason as the gateway's provider registrations: they are machine-specific.

## 2.0.0 — 2026-09-19

Snapshot sync: the three themes were renamed with a `pi-coder-` prefix, so their names cannot collide with themes from another installed package.

### Changed

- **`themes/`** — `summer-night.json`, `catppuccin.json` and `ayu.json` became `pi-coder-summer-night.json`, `pi-coder-catppuccin.json` and `pi-coder-ayu.json`; each file's `name` field followed, and `config/settings.json` now selects `pi-coder-summer-night`.
- Theme names resolve through the `name` field, not the file name, so **an installed `settings.json` that still says `"theme": "summer-night"` silently falls back to pi's built-in `dark`** until it is updated — `/theme` writes the new value. That is why this is a major release.
- References updated: the comments in `bash-command-collapse.ts`, `read-path-collapse.ts`, `tool-diff.ts`, `working-indicator/index.ts`, `working-indicator/spinner-frames.ts` and `spinner-frames.test.ts`, plus [README](README.md), [docs/themes.md](docs/themes.md), [docs/configuration.md](docs/configuration.md), [docs/development.md](docs/development.md) and [docs/handbook.zh.md](docs/handbook.zh.md). Palette names (`ayu-dark`, Catppuccin Mocha, Ayu) are untouched.

### Unchanged

- No color value moved: the three theme files are byte-identical to 1.1.1 apart from the `name` field, and the extension sources differ only in those comment lines.
- The test suite stays at 596 tests.

## 1.1.1 — 2026-09-19

Snapshot sync: the bash and read display toggles were cut back to a fixed default plus environment variables.

### Changed

- **`bash-command-collapse.ts`** — folding is always on and always keeps 3 visual lines. The `/bash-collapse` command is gone (it switched folding off and also set the line budget), and with it the `enabled` / `maxLines` variables and the cache-key fields they fed. `ctrl+o` still expands the command in full.
- **`bash-command-collapse.ts`** — tree indentation and streaming lost their commands as well (`/bash-tree`, `/bash-stream`); both are now read-only startup switches (`PI_BASH_TREE=off`, `PI_BASH_STREAM=on`), so their mutable state became `const`. `/bash-preview` and `/bash-timeout` are the only commands this extension still registers.
- **`read-path-collapse.ts`** — `/read-collapse` removed; `PI_READ_COLLAPSE=off` is now the only way to keep pi's built-in title row. The startup default is unchanged.
- Documentation resynced to match: the command list in [README](README.md), the command table and both tool sections in [docs/extensions.md](docs/extensions.md), the post-install checklist in [docs/installation.md](docs/installation.md), and the one stale `/bash-stream on` sentence in [docs/handbook.zh.md](docs/handbook.zh.md).

### Unchanged

- Defaults before and after this sync are identical: folding on at 3 lines, tree indentation on, streaming off, `read` path collapse on.
- The test suite stays at 596 tests; the removed command handlers were not covered.

## 1.1.0 — 2026-09-18

Snapshot sync: the environment gained an MCP client and a startup fix for pi's built-in footer, and the `ayu` theme was resynced.

### Added

- **`mcp/`** — MCP servers registered directly as pi tools (`mcp__<server>__<tool>`, Claude Code's naming). Config follows Claude Code's `.mcp.json` shape: global `~/.pi/agent/mcp.json` plus the nearest project `.mcp.json`. Three transports, implemented without `@modelcontextprotocol/sdk`: stdio, streamable HTTP and legacy HTTP+SSE. `${VAR}` / `${VAR:-default}` expansion, and `headersCommand` (aliases `headersHelper` / `http_headers_helper`) for dynamic auth headers. Commands: `/mcp`, `/mcp reload`, `/mcp <server>`. Diagnostics stay in an in-memory ring buffer rather than on stderr.
- **`statusline/footer-suppress.ts`** — pi's built-in footer is patched to render zero lines during the boot window, so it no longer paints its default state line before this statusline is installed. `PI_STATUSLINE_BOOT_SUPPRESS=off` disables it.
- Two `ayu` captures in the README, and a `pi.image` gallery preview in `package.json`.

### Changed

- `themes/ayu.json` resynced: `userMessageText` now points at a new `textColor` var (`#dbdbdd`), and `toolPendingBg` now matches `userMessageBg` (`#1b1c1d`).
- The suite grows from **454 to 596 tests**.

### Not included

- `config/mcp.json` — the snapshot's entries hold absolute paths of local MCP server executables, the same class of machine-specific value as `models.json`'s gateway registrations. `config/models.json` and the three model-selection keys in `config/settings.json` remain out as well.

## 1.0.0 — 2026-09-18

First release. A complete pi coding-agent environment packaged for npm.

### Added

- **22 extensions** under `extensions/`, copied verbatim from the author's `~/.pi/agent/extensions/`:
  - Tool rendering: `bash-command-collapse.ts`, `read-path-collapse.ts`, `tool-diff.ts`, `thinking-collapse.ts`, `fenceless-code-block/`
  - TUI chrome: `statusline/`, `cwd-statusline.ts`, `startup-logo/`, `below-editor-after-statusline.ts`, `prompt-editor.ts`, `working-indicator/`
  - Workflow: `simple-task/`, `recap/`, `rewind/`, `init-command.ts`, `theme-command.ts`, `folder-history.ts`, `clear-command.ts`, `exit-command.ts`
  - Model and tooling: `auto-default-model/`, `ask-user-question/`, `subagent-log-guard/`
- **3 themes** under `themes/`: `summer-night` (default), `catppuccin`, `ayu` — including the two custom diff-background tokens and `bashOutput`.
- **Global config files** under `config/`: `AGENTS.md`, `settings.json`, `web-search.json`, `pi-statusline.json`.
- **454 unit tests** runnable with `npm test`, plus the pure-logic module split that makes them possible.
- English documentation: [installation](docs/installation.md), [configuration](docs/configuration.md), [extensions](docs/extensions.md), [themes](docs/themes.md), [development](docs/development.md).
- The original Chinese handbook, kept verbatim as [docs/handbook.zh.md](docs/handbook.zh.md).

### Not included

- `config/models.json`, and the `defaultProvider` / `defaultModel` / `modelThinkingLevels` keys in `config/settings.json`. Provider registrations point at a local gateway and are machine-specific.
