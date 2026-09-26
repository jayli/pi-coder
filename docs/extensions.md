# Extensions reference

29 extensions load from this package. Twelve are single files in `extensions/`, seventeen are directories whose entry point is `index.ts`. Five more directories (`thinking-collapse/`, `tool-diff/`, `prompt-editor/`, `bash-command-collapse/`, `read-path-collapse/`) contain pure-logic modules and tests only — they have no `index.ts`, so pi never loads them as extensions, but the top-level files import them or their tests cover them.

Every extension is also documented in its own header comment (Chinese, except `rewind/`): the pi internals it relies on, the failure that motivated it and the trade-offs that are not visible in the code. This page is the map.

## Commands

| Command | Extension | Arguments |
| --- | --- | --- |
| `/ask` | `ask-user-question` | — Previews the questionnaire with a demo question. |
| `/bash-preview` | `bash-command-collapse` | `off` \| `<1-50>` — Output preview lines; `off` restores pi's built-in preview. |
| `/bash-timeout` | `bash-command-collapse` | — Prints the default, maximum and env-overridden bash timeout. |
| `/clear` | `clear-command` | — Alias of `/new`. |
| `/destructive-guard` | `destructive-guard` | — Prints the current mode and this session's counts (checked / blocked / confirmed / allowed / notified). |
| `/exit` | `exit-command` | — Alias of `/quit` (the argument-free form of the quit words). |
| `/goal` | `verify-loop` | `<condition>` \| `clear` — Sets a completion condition evaluated after every turn by an independent model call; without arguments prints the active goal, `clear` (also `stop` / `off` / `reset` / `none` / `cancel`) removes it. |
| `/init` | `init-command` | `[file.md] [extra instructions]` |
| `/mcp` | `mcp` | — Status of every configured server: transport, tool count, protocol version, config source. |
| `/mcp reload` | `mcp` | — Re-read the config files, reconnect and re-register tools. |
| `/mcp <server>` | `mcp` | — One server's details and its recent diagnostics. |
| `/plan` | `plan-mode` | — Toggle plan mode (same as `shift+tab`). |
| `/plan-status` | `plan-mode` | — Print the current phase and the plan's steps. |
| `/recap` | `recap` | — Summarizes the conversation now. |
| `/rewind` | `rewind` | — Checkpoint menu; also Esc Esc at an empty prompt. |
| `/sandbox-boundary` | `sandbox-boundary` | `forget <path>` \| `clear` \| `allow <path>` — Prints the delete boundary and the persistent allowlist; default form lists both. |
| `/tasks` | `simple-task` | `status` (default) \| `clear` \| `on` \| `off` |
| `/theme` | `theme-command` | `[name]` — Without arguments: picker with live preview. |

## Tool overrides

pi registers one handler per tool name (first registration wins), so each of these owns a builtin tool outright.

### `bash-command-collapse.ts` — the `bash` tool

Collapses the command to **2 visual lines** on a single tree: the first line is a status dot `• ` followed by `Run `, the last row ends in `…`, and a `… +N lines` marker follows when source lines are left over; results hang off the same tree, and `└ ` appears **once**, on the first real output line. Command continuation rows and the truncation marker are indented to the `n` of `Run ` — two spaces while the command is starting, `│ ` once it has finished — and only the word `Run` is bold. The row hard-wraps at the column budget the way CSS `word-break: break-all` does rather than pre-wrapping whole words: a 78-column path fills the line completely and breaks at the edge. Output preview lines default to 3 and the preview always keeps the command's status line. The extension also tree-indents output, syntax-highlights the command line, and can give bash output its own color through the `bashOutput` theme token ([themes.md](themes.md#bashoutput-in-detail)). Since 2026-09-24 it also **wraps the command in a seatbelt profile** — see [`bash-command-collapse/sandbox.ts`](#bash-command-collapsesandboxts--the-seatbelt-delete-boundary) below; the renderer always shows your command, never the `sandbox-exec` prefix.

The block deliberately carries **no background and no boundary blank lines**: the dot at the head of the command row is the only state marker, in `dim` while running, `toolDiffAdded` on success and `toolDiffRemoved` on failure (the logic is the same one the earlier `▎` bar used). The dot column and the result indentation share one constant, so `Run`, `│` and `└` all sit in column 2 and every body column starts at 4; the left margin is drawn by the extension itself, and both sides subtract it from their width budget. **Only bash loses its background** — every other tool keeps pi's default shell.

A failed command is painted `error` rather than success — both the trailing status line and the exit-code footer. That decision reads `isError` **and** matches the status line's shape (`Command exited with code N`, `timed out after N seconds`, `aborted`), because shape alone would repaint a command that merely printed that text. The blank line `appendStatus` writes before the status is dropped instead of rendering as a gap in the tree, the status line is exempt from preview trimming, and blank lines **above** the `└ ` keep the `│ ` bar so the fence does not break.

- `PI_BASH_MIN_TIME_MS` (default `2000`) — only show the elapsed-time footer above this duration.
- `PI_BASH_HIGHLIGHT=off` — disable shell syntax highlighting.
- `PI_BASH_SPINNER=off` — disable the `●` on running rows (implemented in `working-indicator`).

Two details that look simplified but cannot be: it decides "arguments are still streaming" from `!streaming && !argsComplete && isPartial === true` (both thresholds are required, or `/resume` replays lose the command line entirely), and `isError` must be read from `context`, not `result`, because pi's result renderer is called without that field. `PI_BASH_TREE` is gone: the prefix is a tree unconditionally. The shape and its 46 end-to-end assertions are in [`bash-command-collapse/render.test.ts`](../extensions/bash-command-collapse/render.test.ts), which renders through pi's own loader and `ToolExecutionComponent`; 20 of the 46 drive the real sandbox and report themselves as **skipped** when nested `sandbox-exec` is unavailable (which it is inside a pi session). There is no switch for the sandbox here — `PI_SANDBOX=off` turns it off for both routes at once.

### `read-path-collapse.ts` — the `read` tool

Two changes: the title row stays on exactly one line, and the block is shelled like the bash block.

**One-line titles.** Long paths lose their front and keep the informative tail — the file name and last directories — as `Read …@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:62-116`. No folding, no second row. Paths that already fit are left as pi rendered them, apart from one color: the path is painted `text` instead of pi's `accent`, so it does not merge with the `Read` label on themes where `accent` and `toolTitle` are the same palette color (`pi-coder-catppuccin`'s mauve).

**The shell.** `renderShell: "self"` gives the block the same shape as the bash block: **no background** in any of the three states and **no boundary blank lines**, a `• ` dot at column 0 (dim while reading, `toolDiffAdded` on success, `toolDiffRemoved` on failure), `Read` at column 2, and the result body indented to the same column with pi's leading blank line stripped. Only `read` is affected; every other tool keeps pi's default shell, which the test suite asserts with a control case.

`ctrl+o` expansion is handled by the same one-line rule, so the collapsed and expanded views wrap identically. The file name is never split; a path that does not fit even so is cut from the left per grapheme.

**Copying one of pi's functions means copying its signature, not its name.** pi's `resolvePath(input, baseDir)` (`utils/paths.js`) has the **opposite argument order** to node's `resolve(base, target)`. This file aliases node's `resolve` as `resolvePath` to mirror pi's source shape, so `resolvePath(filePath, cwd)` looked identical to pi's line while running node's "base first" semantics: an absolute `filePath` made node return `cwd` and dropped the file itself, so `relative(cwd, cwd)` was `""`, the "inside cwd" test passed, and the label degenerated to `"."` — reading `~/.pi/agent/AGENTS.md` rendered as `Read resource .:67-80` in the narrow-terminal branch (reproduced; it triggers at width ≤ 66). Files inside cwd happened to be correct, which is why only a path **outside** cwd exposes this class of bug; a regression assertion now pins it. Those two lines go through `resolveLikePi(input, baseDir)`.

- `PI_READ_COLLAPSE=off` — restore pi's builtin title row (the uppercase `Read`, the dot and the shell are unaffected). There is no `/read-collapse` command.

### `tool-diff.ts` — the `edit` and `write` tools

Claude Code style diffs: full-line background for added and removed lines (including the line-number gutter), inline highlight of the changed span, and syntax highlighting. Both tools are re-registered with `renderShell: "self"`, which is what makes per-line backgrounds possible — the default shell paints whole blocks by status and would cover them.

The two line backgrounds come from theme tokens that pi's official schema does not define: `toolDiffAddedBg` and `toolDiffRemovedBg`. When a theme omits them, the extension falls back to the much flatter `toolSuccessBg` / `toolErrorBg`. See [themes.md](themes.md#custom-tokens).

### `thinking-collapse.ts` — thinking blocks

Registered as a markdown transformer for `assistant-thinking`. Every thinking block renders as **one continuous line**, no matter how many paragraphs, list items or fenced blocks the model wrote:

```
Think: …latest token keeps appending at the end
```

- Nothing is line-wrapped. When the line exceeds the terminal width, characters are dropped **from the front** and a leading `…` is added, so the end of the line is always the newest token.
- At paragraph seams (blank lines in the original) a Chinese comma is inserted between two Chinese paragraphs; a paragraph that already ends in punctuation is left alone, and Latin text keeps the space rule.
- There is deliberately no "backfill to fill the row" logic, and no `… (N tokens hidden)` notice — the spinner below already counts tokens.
- No command, no environment switch. The only form is this one.

### `fenceless-code-block/` — markdown code blocks

Removes code fences, including the language label, and lays the code out with pi's own indentation and syntax colors — no background is added. It works by patching `Markdown.prototype.renderToken` at module evaluation time, which is effective because pi's bundled loader points extensions at its own inlined `@earendil-works/pi-tui` namespace. Installing twice (after `/reload`) wraps only once.

- `PI_FENCELESS_CODE=off` — keep the fences.

## TUI chrome

### `statusline/` — the footer

Replaces pi's footer with one status line and one status row:

```
⚡️ qwen3.8-flash/xhigh | Ctx 0.0% | ᗌ main | (+0,-0)
📁 /Users/you/project
```

The main row shows model/thinking level, context usage, git branch and diff stat; when the working directory is not a git repository it says `no git`. The branch icon is `ᗌ` (U+15CC, CANADIAN SYLLABICS CARRIER RE — a glyph that happens to fork) — one column wide and East Asian Width Neutral, so a CJK-configured terminal cannot render it double-width, and deliberately **not** a Nerd Font glyph, so no patched font is needed. No font in the author's Ghostty stack covers U+15CC (`Lyth Mono Term`, `JetBrainsMonoNL Nerd Font Mono`, `Maple Mono SC NF`), so it is drawn through system fallback (`Euphemia UCAS`, `Noto Sans CanAborig` on macOS); two earlier icons were `⎇` (U+2387) and `⑂` (U+2442, OCR FORK). The second row renders whatever other extensions pass to `ctx.ui.setStatus()`, in the order given by `statusline/line.ts`'s `STATUS_PRIORITY`: `plan-mode`'s mode indicator **first**, then the rest in registration order (`cwd-statusline`'s path, `rewind`'s `◆ N checkpoints`), capped at 5 entries. The mode indicator wins the first slot on purpose: the second row truncates instead of wrapping, so an indicator that trails a growing path can be pushed out of sight, and registration order alone depends on directory names. `simple-task` is no longer one of these — see [below](#simple-task--task-list). Lines are truncated, never wrapped. Git reads happen on a debounced background path (400 ms after `turn_end`/`agent_end`/`tool_execution_end`, immediately on branch change, with a 30 s fallback poll) so the render path is a map lookup.

- `PI_STATUSLINE_FREEZE=off` — disable the footer freeze. On every session switch pi unconditionally restores its builtin footer and clears all `setStatus` values, and no extension hook runs before that frame. The guard replays the previous frame's lines instead, which removes a visible flash. Turning it off restores the flash.
- `PI_STATUSLINE_BOOT_SUPPRESS=off` — disable boot-window suppression. pi's built-in footer exists before the first extension runs (measured on this setup: its first frame lands at ~480 ms, this statusline at ~1.2 s), so without it you see the default state line and then watch the statusline replace it. [`statusline/footer-suppress.ts`](../extensions/statusline/footer-suppress.ts) patches `FooterComponent.prototype.render` at **extension-factory time** — before pi's TUI is constructed — to return zero lines, and releases it the moment our footer is installed. A 30 s cap releases it anyway when the handoff never happens (an extension error, or a non-TUI mode), so the bottom is never left permanently empty. The two windows have independent switches because they need different remedies: this one has no previous frame to replay, the freeze above has one.
- No config file. Colors come from `theme.fg(...)`, so `/theme` repaints on the next frame.

### `cwd-statusline.ts` — full working directory

Prints the complete `ctx.cwd` as an extension status line, deliberately uncompressed: no `~` shortening, no truncation of middle segments. Only terminal width truncates it, with an ellipsis, never a wrap.

- `PI_CWD_STATUSLINE=off`, `PI_CWD_ICON` (default ` 📁`).

### `startup-logo/` — the header

Replaces pi's header with a static pi logo, the version and the working directory (shortened to `~/...` inside the home directory), keeping the compact key hints below so no information is lost. It also prunes the `[Context]`, `[Prompts]` and `[Themes]` sections from the startup resource list — those three carry no information — while keeping `[Skills]`, `[Extensions]` and every diagnostic section. Pruning works by locating the mounted header component, so it only happens when the logo is installed.

The logo is static by design: no frame table, no timers, no `requestRender`. Narrow terminals degrade to a single-line wordmark.

- `PI_LOGO=off` — do not install the header.
- `header-guard.ts` freezes the header across session switches for the same reason the statusline freeze exists: pi restores its builtin header first, and that frame is visible.

### `below-editor-after-statusline.ts` — widget placement

pi mounts `belowEditor` widgets between the editor and the footer, which pushes the statusline to the very bottom of the screen. `pi-subagents`' fleet status line is registered that way. This extension finds the container holding the probe widget by object identity (never by index) and moves it to the end, so the fleet line sinks below the statusline and the editor keeps the statusline next to it.

The probe must be registered with `placement: "belowEditor"`. Omitting it silently moves the *upper* container instead, with no runtime error. Nothing happens if the container cannot be found.

- `PI_BELOW_EDITOR_AFTER_STATUSLINE=off`.

### `prompt-editor.ts` — the input box

Three changes to the editor.

**A `❯ ` gutter.** The real editing area is narrowed and the gutter is re-added per line, so cursor placement, IME positioning and mouse clicks all stay correct.

**A blank line** between a visible autocomplete list and the statusline, added only when the list is actually rendered (judged by the public `isShowingAutocomplete()`), so the static layout is unchanged.

**`!` bash mode**, matching Claude Code: when the prompt starts with `!` the gutter shows `!` instead of `❯` and the `!` you typed is hidden, so the body reads as the command itself. The mode is render-only — not a single character of the text changes. Detection copies pi's own (`text.trimStart().startsWith("!")`, the same flag that colors the editor border), and Enter submission, ↑ history and Esc clearing keep going through pi's own paths, so there is nothing to keep in sync. Hiding a column has two consequences: the body shifts one column left, so mouse clicks count one extra column, and the cursor has to be pushed off column 0 — otherwise the reverse-video cursor lands on the blank column, and typing there would inject `x!ls` into the text and drop pi out of bash mode. Leaving the mode needs no code: backspacing over the `!`, submitting, or Esc all make pi's own `isBashMode` false again and the next frame draws `❯`. `PI_EDITOR_PROMPT` changes the `❯` but not the bash `!`.

- `PI_EDITOR_PROMPT` (default `❯`), `PI_EDITOR_AUTOCOMPLETE_GAP=off`, `PI_EDITOR_AUTOCOMPLETE_SHIFT` (default 1 column).
- Pure logic lives in [`prompt-editor/bash-prompt.ts`](../extensions/prompt-editor/bash-prompt.ts); the render contract is covered by [`prompt-editor/render.test.ts`](../extensions/prompt-editor/render.test.ts), which loads the real extension through pi's own loader.

### `user-message-bar/` — the user message box

Puts a `▎` and one space at the start of **every** line of a user message box, including the blank padding lines above and below the text, so the body sits two half-width columns in:

```
▎
▎ body text
▎
```

The glyph occupies the one column of left padding that `Box` already reserves, and the extra indent column is taken back out of the line's **trailing** padding — so the background, the line width and the wrap positions stay exactly as they were. That is not a cosmetic preference: pi-tui's main-screen renderer throws `Rendered line N exceeds terminal width` as soon as one line is a column too wide, which takes the whole TUI down, so a bar drawn *next to* the padding is not an option. A line with no column to spare degrades to bar-without-indent, and a line with nothing to spare loses its bar rather than growing past the edge.

The glyph deliberately stays inside the box's `theme.bg("userMessageBg", …)` span so the background block's left edge is continuous. An earlier revision emitted `49m` before the glyph and restored the background after it to leave that one cell bare; it notched the block's left edge and was reverted. Do not reintroduce it — the tests assert exactly one `49m` per line, the trailing one.

The color is the theme's `accent` — the skin's emphasis color — with `selectedBg`, `toolDiffAdded` and `text` as fallbacks for themes that leave it undefined. `PI_USER_MESSAGE_BAR_COLOR=toolDiffAdded` restores the added-line-number green this extension used before.

pi's extension API reaches user messages only through `registerMarkdownTransformer`, which is string-level and never sees the box a message is rendered into, so the bar is drawn by patching `UserMessageComponent.prototype.render`. The patch goes in while the module is evaluated (before any frame is rendered, so resumed sessions get bars too) and is handed the live theme proxy on `session_start`, which is what makes it follow `/theme`. That source has to be dropped again on `session_shutdown`: when the session is replaced (`/clear`, `/new`, `/resume`, `/fork`, `/reload`) pi invalidates the old `ctx` while the previous session's user messages are still mounted and being rendered, and a stale-context read from inside a render tick — where no `try/catch` of ours can catch it — reaches pi's `uncaughtException` and kills the process. The event fires before the invalidation, and reading the theme is wrapped in a `try/catch` on top of that, so the worst case is a few frames without the bar; the next `session_start` restores it. The logic lives in [`user-message-bar/bar.ts`](../extensions/user-message-bar/bar.ts), which takes both the component and the theme as arguments; [`user-message-bar/index.test.ts`](../extensions/user-message-bar/index.test.ts) renders through pi's own `UserMessageComponent`, including the two regressions for the invalidated-`ctx` window.

- `PI_USER_MESSAGE_BAR=off` — leave user message boxes as they are.
- `PI_USER_MESSAGE_BAR_COLOR` (default `accent`) — theme slot to take the color from; a background slot such as `selectedBg` is converted to a foreground.

### `working-indicator/` — the working message

Replaces the fixed `Working` loader with a semantic label, a token count for the current segment and an elapsed time:

```
Tools Calling (↓ 70 tokens · 10s)      Editing (↓ 40 tokens · 3s)
Writing (↓ 120 tokens · 8s)            Reading (↓ 12 tokens · 1s)
Thinking (↓ 900 tokens · 22s)          Working (5s)
```

The token count is **per segment**, not per turn: each reasoning segment and each tool-argument segment starts from zero, so a `bash` command's count reflects that command. Body text is deliberately not counted. `usage.output` is always `0` while streaming, so counts are estimated from streamed characters. Elapsed time is `42s`, `1m 23s` or `1h 23m 32s`. The label uses the normal foreground color while the statistics stay muted, which requires composing everything into the single string pi receives.

The same extension draws the `●` on a running bash row.

- `PI_BASH_SPINNER=off`, `PI_SPINNER_RAINBOW=off`, `PI_SPINNER_COLOR_HOLD` (default `19` frames per color).
- `PI_WORKING_SUMMARY=off` — disable the prompt summary line entirely.
- `PI_WORKING_SUMMARY_LLM=off` — truncate long prompts instead of asking a model to compress them.
- `PI_WORKING_SUMMARY_TRIGGER` (default `1`) — ask for a summary as soon as the prompt does not fit the available width. Raising it tolerates truncation up to that multiple (`1.2` ≈ give up the last fifth, `2` ≈ give up half), which is what you want if you do not care to spend a request on every prompt that overflows by a column.
- `PI_WORKING_SUMMARY_RETRY_MS` (default `3000`) — a failed request (error, timeout, or a response with no text) is retried once after this delay; two attempts per prompt is the cap, and a new prompt or the end of the turn cancels the pending retry.
- `PI_WORKING_SUMMARY_MODEL` — `provider/modelId` for that request; defaults to the session model so a typo can only cost the summary, never the request.
- `PI_WORKING_SUMMARY_GAP` (default `1`).

## Workflow

### `simple-task/` — task list

A lightweight task list: `task_set`, `task_update`, `task_get` and `/tasks`. Three states (`pending`, `in_progress`, `done`), no blocks, no dependency graph, no notes, no title-length validation.

State is written with `pi.appendEntry()`, so it rides the session log and **nothing is written into your repository** — no `.pi/tasks/*.json` to gitignore. Rebuilding reads `ctx.sessionManager.getBranch()`, not `getEntries()`, so branch navigation cannot resurrect a discarded branch's tasks.

Since 2026-09-24 the list is **independent of plan mode**: an approved plan is a document, progress is the model's own business, and the mirror contract, the separate id space and the header suppression that went with it have all been deleted. `/tasks` with no argument or `status` prints the list, `clear` empties it, `on` / `off` toggle the widget.

The widget is the whole feature: the packed `✔ n/N` status it used to also write into the statusline's second row was a duplicate of it, and that slot now belongs to `plan-mode`'s mode indicator. Do not add a second copy of the same information back.

All three tools are registered with `renderShell: "self"`, which gives their blocks the same shell as the bash and read blocks: **no background** in any of the three states and **no boundary blank lines**, because pi's default shell is a `Box(1, 1, bgFn)` and `selfRenderContainer` is a plain `Container` that `bgFn` cannot attach to. Unlike bash and read there is no hand-drawn left margin to keep aligned — `renderCall` / `renderResult` return `new Text(…, 1, 0)`, whose `paddingX = 1` puts back the single column of left margin the default `Box(1, 1)` used to draw (one leading space per line, not flush-left) while `paddingY = 0` keeps the top and bottom blank lines away and no `bgFn` means nothing to wrap in a `Box`. The shape is pinned by 3 end-to-end cases in [`simple-task/render.test.ts`](../extensions/simple-task/render.test.ts), which run through pi's own loader and `ToolExecutionComponent` and include a control asserting other tools keep their background.

### `recap/` — conversation summary

`/recap` summarizes the conversation on demand; the same summary appears automatically above the editor after **10 seconds of idling** with no new input, and disappears as soon as you type.

The delay is the point: the recap exists to tell you what a session was doing when you come back to the window, so it is idle-based rather than turn-based. The timer first asks whether any subagent is still running (an in-process RPC to `pi-subagents`, no file import — a missing package is treated as "no subagents") so a background delegation is never summarized as finished.

Deliberately not implemented: no local storage, no session entry, no configuration. The summary lives in memory only, so `/new` or `/resume` does not restore it and it is never sent to the model as context. The summary text itself is **generated in Chinese** (the prompt is hardcoded), which is worth knowing if you do not read Chinese.

`/recap` is **idempotent**: when a summary for the current exchange already exists and is on screen, running it again returns immediately — no model call, no widget reset, no notice. A second run would produce the same summary, and a *failed* second run would replace the summary you already have with a "could not generate" notice. The fingerprint is the last user+assistant pair plus the model, computed in one place (`latestExchange()`) and shared with the automatic path's de-duplication, so a new exchange re-opens the gate.

### `rewind/` — checkpoints and `/rewind`

Claude Code style checkpointing. Before every prompt that starts a turn, the working tree is snapshotted into a **shadow git repository** under `~/.pi/agent/rewind/<project-hash>/git` with `GIT_DIR` pointed at it and `GIT_WORK_TREE` at your project. Your repository's HEAD, index, refs and status are never touched, and this works in directories that are not git repositories at all.

Files the snapshot cannot see — anything `edit`/`write` touches outside the project root, inside it but `.gitignore`d, or inside a nested repository — are covered by lazy pre-image mirroring driven by tool-call events, with blobs addressed by content.

`/rewind`, or Esc Esc at an empty prompt, opens a menu: restore code and conversation, conversation only, code only, summarize from here, or never mind. Conversation restore uses pi's native session-tree navigation, which drops the selected user message and puts its text back into the editor.

- **Requires `doubleEscapeAction: "none"`** in `settings.json`. The extension warns once at session start if the built-in tree navigator would fire instead. It consumes the second Esc (the selector takes focus synchronously, so letting it through would cancel the menu it just opened) while leaving the first Esc alone, so Esc still aborts streaming.
- Known limits: only the `edit` and `write` tools are tracked (`bash` writes outside the root cannot be parsed), and files larger than 8 MB are not copied.

### `init-command.ts` — `/init`

Claude Code style repository memory file generation. Target selection looks only at `ctx.cwd`:

1. `CLAUDE.md` exists → update `CLAUDE.md`
2. else `AGENTS.md` exists → update `AGENTS.md`
3. else create `AGENTS.md`

`/init <file.md> [extra instructions]` overrides the target and appends your requirements. The extension writes nothing itself: it resolves the target and sends a prompt as a user message, so the model's own `read`/`write`/`edit` calls do the work and you can watch and correct them. It waits for the current turn to finish before sending.

### `theme-command.ts` — `/theme`

A one-step theme picker with live preview. Arrow keys preview, Enter persists, Esc cancels. `/theme <name>` switches and persists directly.

The preview works because `ctx.ui.setTheme()` has two distinct paths: passing a **Theme object** only recolors the running UI (`setThemeInstance()`), while passing a **name** applies it and immediately writes `settings.json` (`setThemeName()`). So browsing never touches your settings, and only Enter does. A `Spacer(1)` separates the theme list from the color swatches — both are multi-line blocks and read as one region when they touch. In non-TUI modes the command notifies instead of silently failing.

### `folder-history.ts` — cross-session command history

Persists command history per working directory in `~/.pi/folder-history/<path-with-dashes>.jsonl` and injects previous sessions' entries into the editor's own history array, which makes the **native ↑/↓** walk across sessions.

The mechanism matters: previous sessions' entries are appended to the tail of `Editor.history` (tail = older), so ↑ goes further back in time. No shortcut is registered — a registered `up` key would swallow cursor movement in multi-line prompts and arrow navigation in every selector. `PI_FOLDER_HISTORY_INJECT` (default `100`) caps how many entries come from earlier sessions.

### `clear-command.ts` — `/clear`

Alias of `/new` implemented through `ctx.newSession()` — the same replacement flow the builtin uses, so behavior and on-disk format match. It calls `ctx.waitForIdle()` first so an in-flight turn (including retries and auto-compaction) is never racing the session swap.

### `exit-command.ts` — quit words

Typing `exit`, `quit` or `bye` as the entire prompt quits pi cleanly (sessions are saved; `session_shutdown` still runs). Matching is exact and case-insensitive, so "exit the loop and print a summary" is untouched, and messages with attachments pass through. It only applies in TUI mode: in `--print`, `--mode json` and RPC mode these remain ordinary prompts. Also registers `/exit` as an alias of `/quit`.

- `PI_EXIT_WORDS="exit,quit"` — replace the words; `off` disables the interception.

## Model and tooling

### `plan-mode/` — Claude Code style plan mode

Two phases: `bypass` → `plan` (read-only exploration, the model writes a plan). **There is no execute phase.** Approval restores write access and returns to `bypass`; "now implement what you just planned" is a one-shot instruction handed to the model, and progress is the model's own business — it builds a task list with `task_set` if it judges the work warrants one. Plan state lives in the session log (`pi.appendEntry("plan-mode")`, not in the model's context), and the plan document is written into `.pi/plans/` in the working directory.

Until 2026-09-24 this was three phases (`bypass` → `plan` → `execute`), where approval mirrored the steps into `simple-task` and tracked `[DONE:n]` markers against them. That whole "the extension owns the progress" mechanism is gone — the mirror contract, the markers, the step widget and the per-turn injection with it — because Claude Code's own `ExitPlanMode(plan)` takes a complete plan text and leaves the task list to the model.

Four ways in: `shift+tab`, `/plan`, `--plan` at startup, and the model's own `enter_plan_mode` tool.

**The model's way in asks for consent first (Claude Code's mechanism).** `enter_plan_mode` no longer enters directly: it opens a two-option `select` — `进 plan mode（只读探索）` (the default, so Enter accepts the model's request) and `直接实施`. Choosing the second, or pressing Esc, does not enter plan mode; the tool result tells the model the user chose to implement directly and not to call the tool again, so it acts on the instruction in the same turn. Three deliberate points: Esc counts as a refusal (Claude Code's "must consent to entering plan mode"), which also makes "too much friction, skip it" a single keystroke; the dialog is **only on the model path** — `shift+tab` / `/plan` / `--plan` go through `enter(ctx, "user")` and are already the user's own decision; and a headless run (`pi -p`) skips it and enters, keeping the previous behaviour where nobody is interrupted.

**All the routing criteria live in the tool description (also Claude Code's shape).** `enter_plan_mode`'s `description` carries 7 positive conditions (a new feature / several viable approaches / changing existing behaviour or structure / an architectural tradeoff / **more than 2–3 files** / unclear requirements / a fork the user's preference decides — the last one spelled out as "if you were about to ask with `ask_user_question`, use this tool instead"), 4 exemptions (a one-or-two-line fix / a single function with clear requirements / **the user already gave specific detailed instructions** / **pure research, exploration or review**), and GOOD/BAD examples. The global `AGENTS.md`'s `## Uncertainty` keeps a single pointer to it instead of a second copy — Claude Code's system prompt likewise contains no plan rule at all. Criteria in the tool description are read at exactly the moment the model decides whether to call the tool, and they cannot drift away from `AGENTS.md`. This is why the criteria can afford to be loose: a misjudgement costs the user one keystroke at the consent dialog, not a forced round of plan → proposal → approval → document.

**Submitting and approving.** `exit_plan_mode` takes `plan` (the complete markdown for the user — this is what the approval dialog renders), a **required `slug`** (lowercase English plus digits and hyphens, 3–5 words, e.g. `m5-entity-runtime`; the document becomes `.pi/plans/<date>-<slug>.md`, so CJK and punctuation are folded away and a purely Chinese name falls back to `plan`), and an optional `summary` (one line, display only). The dialog offers three answers — **write the plan document and implement it**, **write the document only**, or **reject**. On the first two the model writes the file with the `write` tool while a `tool_call` hook pins that tool to the single approved path, so "plan mode" cannot be used to write anywhere else; a `tool_result` hook notices the successful write and closes the phase itself.

The dialog is **truncated to one screen** (`truncatePlanForDialog`), and the height is computed with pi-tui's own `wrapTextWithAnsi`, so it matches the real render including CJK line-breaking; the overflow line reports how many steps are left and points at the terminal scrollback, while the plan text handed to the model is never truncated. This is not cosmetic: pi pins the viewport to the bottom on every repaint and the confirm dialog is a non-scrollable `Text`, so a long plan is guaranteed to be cut off and manually scrolling up is undone by the next repaint.

**The mode indicator has a fixed slot**: the head of the statusline's second row, with text in both phases — `⏵ bypass` (painted `toolDiffRemoved`, i.e. the delete-line red, so "full permissions" is visible at a glance) and `⏸ plan` / `⏸ plan · 4 steps` (`warning`). See [`statusline/`](#statusline--the-footer) for why the slot is pinned.

**Two independent gates, not one:**

1. **The tool set.** Entering plan mode removes `edit`, `write` and `powershell` from the active tools and restores the set **exactly as it was** on exit. The set is snapshotted rather than hardcoded because this environment has twenty-odd extension-registered tools (`mcp__*`, `ask_user_question`, `task_set` …) that a whitelist would silently drop.
2. **A `tool_call` hook.** `bash` stays available, so write-shaped commands (redirection, `rm` / `mv` / `sed -i`, `git commit`, `npm install`, `sudo` …) are rejected there and the reason is returned to the model as a tool error. The judgement is made per simple command, so `cat a.txt && rm -rf b` still has its `rm` caught; heredoc bodies are stripped first, and fd duplications (`2>&1`) and `/dev/null` targets pass.

**This is a guardrail for a cooperative model, not a sandbox.** Two shapes are deliberately allowed through: `$(...)` command substitution inside double quotes, and `npm run <script>`, whose side effects live in the script. Blocking those would block ordinary exploration; real protection needs an OS-level sandbox.

`shift+tab` is taken from pi's built-in `app.thinking.cycle`. A conflicting `registerShortcut` is skipped by pi's runner, so the key is intercepted with `ctx.ui.onTerminalInput` **before** the editor sees it (only in TUI mode, while idle, and with no extension dialog open) and consumed. Because that displaces the thinking-level cycle, the extension rewrites `app.thinking.cycle` to `ctrl+shift+t` in `~/.pi/agent/keybindings.json` — and only when the key has no binding at all; a user-configured binding is left alone. Matching the key must go through pi-tui's `matchesKey`, not a string compare: `shift+tab` arrives as bare CSI (`\x1b[Z`), as the Kitty protocol's CSI-u (`\x1b[9;2u`) or as xterm's modifyOtherKeys, and pi turns the Kitty protocol on at startup, so a real terminal sends the second form. Pressing `shift+tab` while streaming still cycles the thinking level — plan mode only switches when you are stopped.

Restoring state on startup reads `ctx.sessionManager.getBranch()`, **not** `getEntries()`: the latter returns every entry in the file including branches discarded by `rewind` / fork / branch navigation, so a plan dropped on another branch would come back to life (observed: no plan on the active branch, yet the statusline showed `▶ 0/1 executing`). A stored `normal` (the old name of `bypass`) is normalized through a whitelist, so an existing session's phase field cannot bring back a phase that no longer exists.

- `PI_PLAN_MODE=off` — disable the extension entirely.
- `PI_PLAN_MODE_AUTO=off` — keep `shift+tab` and `/plan`, drop the model's `enter_plan_mode` tool.
- `PI_PLAN_MODE_CONSENT=off` — keep the tool, drop its consent dialog (back to "calling it enters plan mode").

### `destructive-guard/` — pre-execution delete gate (**retired**)

> **Retired from the author's live environment on 2026-09-24**, replaced by the seatbelt capability boundary described below. The file, its README and its 109 assertions stay in the package as the reference implementation of the lexical route; nothing else here depends on it, and `PI_DESTRUCTIVE_GUARD=off` disables it if you do not want two delete gates answering at once.

A `tool_call` hook that inspects arguments **before** the tool runs and rejects dangerous deletes. It exists because a one-line `fs.rmSync(path.dirname(s.log[0]?.x ?? "/tmp"), { recursive: true, force: true })` destroyed most of this machine's writable paths: the property did not exist, `??` substituted an innocuous-looking default, and `dirname("/tmp")` reduced it to `/`. The prose rules in `AGENTS.md` were already in place and did not help — they constrain what the model decides, not what a script it wrote earlier does at runtime.

**Three gates:**

1. **Delete-shaped commands** (`bash` / `powershell`). Targets are extracted from `rm` / `unlink` / `shred` / `truncate`, `find … -delete` and `find … -exec rm`, `git clean -fdx`, `rsync --delete` and PowerShell `Remove-Item`, skipping command wrappers (`sudo`, `env`, `nice` …) and descending into inline code (`node -e …`, `sh -c …`, a heredoc fed to an interpreter), then judged in four tiers: **block** (fewer than two path components, a protected root such as `/System`, `/Library`, `/Applications`, `/Users`, `/usr`, `/bin`, `/etc`, `/opt`, `$HOME`, or an ancestor of one; plus the guard's own directory, `~/.pi/agent/AGENTS.md` and the `extensions` / `sessions` / `rewind` subtrees — `self-protection`), **confirm** (inside a system tree, a VCS store root like `.git`, a target carrying a fallback `??` / `||` / `${X:-y}`, a target computed by `dirname()` / `$(…)` / a variable, a target inside `$HOME` but outside the working directory — `outside-workdir`, the rule the second incident needed — and `git reset --hard` / `checkout --` / `restore` / `stash drop|clear` / `branch -D` — `vcs-history-loss`), and **ok** for everything else. `/Users/bachi/x/dist`, `/tmp/scratch` and `/usr/local/bin/tsc` all pass.
2. **Delete code inside written content** (`write` / `edit` / `multiedit` / `apply_patch`). The dangerous line is often written into a file long before it runs, and the run itself looks harmless (`node verify.mjs`) — gate 1 cannot see it. This gate checks the content being written for the same shapes: a delete API with a fallback target, a target from path arithmetic, a bare root or `..` climb, a shell-variable target, a recursive PowerShell delete with a non-literal target. Comment lines do not count, since they do not execute.
3. **Before running a script** (`node verify-a.mjs`, `bash deploy.sh`, `./x.mjs`), the **file is read** and put through the same checks. This is the only place that one-line incident could have been caught: "run a script" looks harmless from the command word alone.

A `block` verdict is refused outright and the reason is returned to the model as a tool error. A `confirm` verdict asks once in the TUI (in plain language — fixed title, the resolved paths, the command it came from and why it was caught; targets past three fold into "and N more") and **fails closed without one** — a non-interactive environment refuses rather than proceeding. A third option asks the model to list the exact paths with a read-only command first.

The judgement is lexical and deliberately does not follow symlinks or do dataflow analysis: it wants to be deterministic, testable and side-effect free. A target passed across functions (`const t = compute(); rmSync(t)`) is not caught, and that residue is what the `AGENTS.md` discipline covers — it is also the reason the live environment moved to an OS-enforced boundary. `targets.test.ts` treats the "must allow" cases as seriously as the "must block" ones: 23 everyday commands are regression cases, because a guard that prompts constantly is a guard nobody keeps on.

- `PI_DESTRUCTIVE_GUARD=block` — refuse the confirm tier too.
- `PI_DESTRUCTIVE_GUARD=notify` — report what it would have caught without blocking; the recommended first day of use.
- `PI_DESTRUCTIVE_GUARD=off` — disable the gate.
- `/destructive-guard` — current mode plus this session's checked / blocked / confirmed / allowed / notified counts.

### `bash-command-collapse/sandbox.ts` — the seatbelt delete boundary

The replacement for the lexical route. The insight is that **enumerating dangerous commands is the wrong shape**: the incident was one line in a generated script, and the space of ways to delete something is unbounded. So the boundary is drawn the other way round — the command runs inside `sandbox-exec` with a deny-default profile, and what is *allowed* is enumerated instead:

- reads and network: unrestricted;
- writes (`file-write*`): globally allowed — a write cannot make an inode disappear, and the reversibility of an overwrite belongs to git and the `AGENTS.md` discipline;
- **deletes (`file-write-unlink`): denied first, then allowed for the delete roots only** — the project directory, the temp roots (`/tmp`, `/private/tmp`, `/var/folders`, `/private/var/folders`, `/var/tmp`, `/private/var/tmp`), the regenerable caches (`SAFE_CACHE_HOME_DIRS`: `~/.cache`, `~/.npm`, `~/.gradle/caches`, `~/.m2/repository`, `~/.cargo/registry`, `~/.bun/install/cache`, `~/.node-gyp`, `~/.Trash`, `~/Library/Caches`, `~/Library/Developer/Xcode/DerivedData`) and whatever `PI_SANDBOX_EXTRA_WRITE` lists.

A delete outside those roots is refused by the **kernel** (`EPERM`), not by a pattern match, so no command shape escapes it: `rm`, a `node` script, `git clean`, a compiled binary — all hit the same wall. `rename` is covered too, because it unlinks the destination. `/var/tmp` is in the boundary because it is macOS's built-in bash 3.2 heredoc temp directory, hard-coded at compile time (`TMPDIR` cannot move it) — without it every heredoc inside the sandbox fails 100% and leaks a `sh-thd-*` file. One consequence is deliberate: a command that tries to delete outside the boundary **fails and has to be rerun**, which is why the extension only asks once per command per session and warns the model that a retry is coming. Non-interactive environments fail closed.

`classifyOutsidePaths` is the one judgement both routes share. It sorts a target into five mutually-exclusive verdicts — **blocked** (never-delete), covered by the persistent allowlist or a session exemption, **dangerous**, **ordinary**, or inside the boundary. The three authorization tiers, in the order they are judged:

- **never-delete** (`NEVER_DELETE_HOME_FILES` / `NEVER_DELETE_HOME_DIRS`): identity, credentials and hand-written config — `~/.zshrc`, `~/.gitconfig`, `~/.env`, `~/.bash_history`, `~/.envrc`, `~/.tool-versions` and 43 other home-level files, plus the `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.docker`, `~/.azure`, `~/.gcloud`, `~/.terraform.d`, `~/.helm`, `~/.minikube`, `~/.password-store` subtrees (21 entries). Entries may carry a slash: `~/.config/gh` (GitHub token in `hosts.yml`) and `~/.config/gcloud` (credential store) are nested entries that fish the real credentials back out of `~/.config` after that subtree left this tier. **Deliberately absent**: `~/.config`, `~/.pi`, `~/.claude`, `~/.codex` — tool-state directories holding locks, caches and session logs that need routine cleanup; locking the whole subtree made even pi's own stale-lock cleanup fail with kernel `EPERM` (`pi update --extensions` exited 1). They fall to the ordinary tier: dialog, rememberable. The trade-off is stated: the guard's self-protection (`extensions/`, `AGENTS.md`, `sessions/`, `rewind/`, the allowlist file all live under `~/.pi`) drops from "kernel refuses unconditionally" to "dialog + explicit consent". **No dialog, no way to allow it** for what remains in the tier: the allowlist, a session exemption and `PI_SANDBOX_EXTRA_WRITE` all lose to it, because the profile emits a `deny file-write-unlink` line *after* the allow lines and seatbelt lets the later rule win. Judged first and ahead of the boundary, except under the project directory (so working inside `~/.pi/agent/extensions/x` can still delete its own files).
- **dangerous**: a system root, a `bin` directory, an application install directory, `~/Library`, or anything containing a VCS store. Asked about **every time**; only a session-scoped exemption (`Allow for this session`) is offered.
- **ordinary**: asked once; `Allow for this session（并记住该目录）` writes the directory range into the persistent allowlist.

The dialogs are three-way: dangerous paths get `Deny` / `Allow once` / `Allow for this session`; ordinary paths get `Deny` / `Allow for this session（并记住该目录）` / `Allow once`. When a delete is refused the extension extracts the blocked paths from the failure output by **exclusion** (it keeps the in-line absolute-path scan and only skips lines containing `here document` and lines whose leading program is a shell or `sandbox-exec`) rather than by a program-name allowlist, which would silently drop the python3 `PermissionError`, `find:` and `ln:` shapes. **If it cannot extract a path it does not prompt** — it reports the original error plus a `[沙箱]` line pointing at `/sandbox-boundary allow <directory>`; the old "ask once per whole command, then rerun outside the sandbox" fallback is gone. An approved delete reruns **inside** the sandbox with the approved range widened, so the rest of the command stays supervised.

- `PI_SANDBOX=off` — disable both the profile and the `apply_patch` gate (also automatic off macOS, where there is no `sandbox-exec`).
- `PI_SANDBOX_EXTRA_WRITE` — colon-separated extra delete roots, `~` expanded, like `PATH`.

### `bash-command-collapse/allowlist.ts` — the persistent allowlist

`~/.pi/agent/sandbox-allowlist.json` holds the directories the user has confirmed safe (`PI_SANDBOX_ALLOWLIST` moves the file). Remembering a directory means adding it to the profile's `file-write-unlink` allow list, so the delete simply succeeds inside the sandbox while the rest of the command stays supervised.

The store is a `globalThis` singleton on purpose: the bash route and the `apply_patch` route share it, so remembering a directory on one side takes effect on the other in the same session, and the two can never drift into different boundaries. It is **global rather than per-project** — a directory approved in project A is approved in project B — which is the stated intent, not an oversight. Three defences keep it honest: `remember()` only accepts roots that pass `isSafeAllowlistRoot` (never `/`, `$HOME`, a never-delete path such as `~/.ssh` or `~/.zshrc`, anything containing `.git`, or an ancestor of any **dangerous** root — the ancestor gate checks the dangerous tier only, since the never-delete list gained nested entries like `~/.config/gh` and checking it there would make `~/.config` unrememberable forever; safety is unaffected because the kernel deny lines reclaim never-delete subtrees after the allow lines), `memoryScopeFor` never stores a range shallower than `MIN_ALLOWLIST_DEPTH` (so one confirmation cannot hand over a whole home directory), and the file is filtered again on load, so a hand-edited `"/"` cannot get in. Writes are atomic (temp file + rename). A corrupt, unreadable or unknown-version file degrades to an empty allowlist and **never throws**: the failure direction of a gate whose job is to prompt less must be "ask once more".

### `sandbox-boundary/` — the non-shell half of the boundary

The same boundary for tools that never touch a shell. `write` / `edit` are direct `fs` calls inside the extension process, so no shell profile reaches them — but the only capability the seatbelt profile takes away is `file-write-unlink` outside the boundary, and `write` / `edit` cannot unlink anything. So the boundary only needs one thing here, and only one tool has it: `apply_patch`'s `*** Delete File:` lines. `Update File` and `Add File` are writes and pass.

Two differences from the bash side matter. It runs on the `tool_call` hook, so it rejects **before** execution and knows every target path up front — there is no "run the command, fail, ask, rerun" cost, so `Allow once` is simply a pass without remembering. And because it shares `classifyOutsidePaths`, the same allowlist and the same session exemptions with the bash side, remembering on either side covers both. A never-delete path in a patch is refused outright — the **whole** patch is rejected, with no option to approve the rest, so one `*** Delete File: ~/.ssh/id_rsa` cannot ride along with legitimate operations.

When a target is already covered by the allowlist it passes silently but emits a `notify`, so "why did it not ask?" has an answer on screen.

- `/sandbox-boundary` prints the delete boundary and the allowlist; `forget <path>` removes one entry, `clear` empties the list, `allow <path>` pre-authorizes a directory.
- `PI_SANDBOX=off` disables it together with the bash profile, so there is never a state where one side is bounded and the other is not.

### `core-rules/` — keeping the core rules in context

`~/.pi/agent/AGENTS.md` is a **user-level** file that pi renders into `<project_context>` in the system prompt, after the preamble, tools, rules and docs — and in this setup it is followed by a 105 KB project `AGENTS.md`. It is sent on every request and never lost, but it sits in the middle of a giant blob at the very front, so its instruction-following strength decays as the conversation grows. Nothing about it fails; it just gets quieter.

This extension pushes the distilled core back to the end. Codex solves the same problem in a different way, and the design is copied from there: `~/.pi/agent/AGENTS.core.md` is not part of the system prompt but a world-state section, injected as a user-role message, re-sent when it changes, re-injected after a compaction, and placed near the end. In pi the landing spot is even better: a message returned from `before_agent_start` is appended **after** the user message and persisted into the session, so it is the most recent thing in context — closer to the end than Codex's "before the last real user message".

One decision (`decision.ts`) covers all three Codex triggers: scan the model-visible projection for this extension's own messages — absent means the session just started or compaction dropped it, present with a different hash means the content changed, same hash means skip. Nothing is sent when nothing changed. The file is read on every `before_agent_start`, so editing it takes effect on the next prompt — no `/reload`, no restart.

The injected body is the distilled ~7 KB core, not the ~27 KB file: persistence, the destructive-action rules, the blast-radius table, authorization, the plan gate, delegation (including the orchestration trigger — direct `{ agent, task }` for one bounded child, one top-level `workflowScript` call for keyed children / sequencing / fanout / steering / retry / aggregation), the skill-trigger rules, communication and the git/shell bottom line. The full rules stay in the system prompt; this is the part that must not decay. **A missing `AGENTS.core.md` makes the extension skip silently** — it is an optional enhancement and should not make pi noisy at startup. It is shipped as [`config/AGENTS.core.md`](../config/AGENTS.core.md).

- `PI_CORE_RULES=off` — disable the extension.

### `verify-loop/` — the verification gate and `/goal`

Completion claims used to rest entirely on the model's own report: it edits files, says "done, tests pass", and pi ends the turn with nothing checking that sentence. This extension turns that discipline into code, mirroring two Claude Code mechanisms on pi's `agent_before_settle` boundary — "the final actionable boundary: it can append entries and request one continuation".

**(1) The gate** (Claude Code's `type: "command"` Stop hook). On every settle — only `outcome === "completed"`; abort and error skip, matching CC's Stop / StopFailure split — it scans the current run (everything after the last user message): if files were changed (`edit` / `write` / `apply_patch` / `multiedit`, non-document paths) but **no bash command ran after the change**, it appends a `display: true` injection message (visible to the user, like CC's "Stop hook feedback", and entering the model context as a user-role message) and returns `continue: true` to force one more turn.

The block count is **not an in-memory counter**: it counts this extension's already-injected messages in the model-visible projection. `agent_start` re-fires on every boundary continuation (`runAgentLoopContinue` emits it), so a reset hooked to it would zero the counter mid-chain and defeat the cap; counting from the projection is branch-correct, survives resume, needs no mutable state, and the injected messages are `role: "custom"` (not user), so they do not cut the run window — the whole continuation chain shares one window, exactly CC's "consecutive blocks within one turn" semantics. The cap defaults to 2 (`PI_VERIFY_LOOP_CAP`; CC's generic 8 is for arbitrary user hooks).

**The verification criterion is any bash call.** The first live smoke test (2026-09-25) measured a false positive: after editing `probe.js` the model ran `node --input-type=module -e "import('./probe.js')…"` — genuine evidence, but matching no test-runner shape, so the gate blocked a second time. A lexical gate cannot judge whether a command is a *relevant* test (that is the evaluator's job), so the gate only asks whether the actual state was observed after the change. `PI_VERIFY_PATTERN=strict` restores the test/build/lint-only pattern, or supply a custom regexp. The known cost, stated rather than fixed: an `ls` passes the gate — CC's command-type Stop hook is equally coarse.

**(2) `/goal`** (CC's session-level prompt evaluator: set by hand, evaluated automatically afterwards). `/goal <condition>` (≤ 4000 characters, CC's limit) persists via `appendEntry` and immediately starts a turn with the condition as the instruction; on every later settle it first asks whether a subagent is still running (if so the turn is skipped — CC's "background work defers evaluation", reusing `recap/subagents.ts`'s RPC), then makes one **tool-less** independent model call (condition + `serializeConversation(convertToLlm(projection))` tail-truncated to 120k characters by default) and parses a three-verdict JSON (`met` / `not_met` / `impossible`, bare or fenced): not met → the reason is injected and the turn continues; met or impossible → an entry is recorded and the goal cleared. **Fail-open**: an evaluation failure, timeout or unparseable answer passes the turn through (CC's hooks likewise never block on their own failure). No-progress detection (2 consecutive continuations with zero tool calls → stop the loop, keep the goal — CC: "stops the loop … with the goal still set") and the 8-continuation cap (`PI_GOAL_CAP`, CC's number) are counted from the projection the same way. Resume restores an active goal but resets the turn count (CC: "carries the condition over but resets the turn count"); met / impossible goals are not restored. The evaluator model is `PI_VERIFY_EVALUATOR_MODEL=provider/modelId`, defaulting to `litellm-any/qwen3.8-flash` and falling back to the current session model.

**The one deliberate divergence from CC**: CC ships no hooks by default (the user configures them in settings.json); pi has no hooks configuration layer, so the gate is **on (`block`) by default** with its trigger narrowed as far as it goes, and `PI_VERIFY_LOOP=off|notify|block` switches it. While a goal is active the statusline's second row shows `◎ /goal active` (key `verify-goal`).

91 `node --test` cases: `gate.test.ts` (24), `goal.test.ts` (23) and `evaluator.test.ts` (23) are pure logic; `index.test.ts` (21) loads the real extension through pi's loader with a fake subagent bus and a fake model registry.

- `PI_VERIFY_LOOP=off|notify|block` — the gate's force; default `block`.
- `PI_VERIFY_LOOP_CAP` — consecutive-block cap; default `2`.
- `PI_VERIFY_PATTERN=strict|<regexp>` — what counts as verification; default: any bash call.
- `PI_VERIFY_DOC_EXT` — extensions whose edits are not mutations; default `.md,.txt` (empty string disables the exclusion).
- `PI_GOAL_CAP` — `/goal` continuation cap; default `8`.
- `PI_VERIFY_EVALUATOR_MODEL` — evaluator model `provider/modelId`; default `litellm-any/qwen3.8-flash`, then the session model.
- `PI_GOAL_CONTEXT_CHARS` — conversation character budget for the evaluator; default `120000`.
- `PI_GOAL_TIMEOUT_MS` — evaluation call timeout; default `45000`.

### `auto-default-model/` — persistent model switches

pi's `/model` picker only changes the current session; persisting it takes a separate Ctrl+S (`setModel(model, { persist: true })`). This extension performs that step automatically on every model switch — the picker, Ctrl+P cycling, a subagent profile switch, anything that calls `pi.setModel()`.

It writes through pi's own `SettingsManager`, so it uses the same file lock as pi (`proper-lockfile`), merges only the changed fields into the newest on-disk content, and therefore cannot clobber concurrent `/theme` or `/settings` writes. It skips session restore (`source === "restore"`) and skips no-op writes. Failures are notified; successes are silent, because the model name is already visible in the statusline.

- `PI_AUTO_DEFAULT_MODEL=off`.

### `ask-user-question/` — the `ask_user_question` tool

A Claude Code style structured question tool. The model asks instead of guessing; a questionnaire appears in the terminal with up to **4 questions**, each with **2–4** described options, a free-text row appended automatically, Space to multi-select, ↑/↓ to navigate and Esc to abandon the whole questionnaire. Answers return to the model as structured text.

The labels `Other` and `Type something.` are reserved — validation rejects them — and the number of questions and options is enforced by the tool's TypeBox schema, while string length limits are enforced by runtime truncation. Non-TUI hosts (RPC, print) fall back to sequential `select`/`input` dialogs. The tool removes itself in child sessions where `ctx.hasUI` is false.

- `PI_ASK_USER_QUESTION=off` — do not register the tool.
- `/ask` previews the dialog with a demo questionnaire.

### `mcp/` — MCP servers as tools

Every MCP tool is registered as a pi tool directly, named `mcp__<server>__<tool>` — Claude Code's convention, so prompts, skills and permission rules written for it keep working. There is deliberately no single "mcp" proxy tool: direct tools are friendlier to the model, and the only cost is a longer system prompt.

Configuration follows Claude Code's `.mcp.json` shape, read from two places: the global `~/.pi/agent/mcp.json`, plus the **first** `.mcp.json` found walking up from the working directory (at most 32 levels). Project entries override global ones by name, so an existing repo-local `.mcp.json` works as it is.

| Field | Transport | Notes |
| --- | --- | --- |
| `command` / `args` / `env` / `cwd` / `timeout` | stdio | `timeout` is the per-call budget in milliseconds (default `120000`). |
| `url` / `headers` | HTTP | Streamable HTTP, or legacy HTTP+SSE when `type: "sse"`. |
| `headersCommand` | HTTP | Dynamic auth headers: the command's output becomes headers. |
| `enabled: false`, `disabled: true` | either | Keep the entry for `/mcp`, do not connect. |

String fields expand `${VAR}` and `${VAR:-default}`. Sessions connect every enabled server in parallel at `session_start` and close them at `session_shutdown`; handshakes have their own 20 s cap and a server that fails costs one warning, not the session.

**`headersCommand`** is the cheap half of OAuth: most SaaS MCP servers also accept a static token (a GitHub PAT, `CONTEXT7_API_KEY`, a Sentry or Figma token), so fetching one with a command avoids implementing OAuth 2.1. Three output shapes are accepted — a flat JSON object, a `{"headers": {...}}` wrapper, or `Name: Value` lines — and `headersHelper` (Claude Code) and `http_headers_helper` (Codex) are aliases, so a copied config needs no field edits. `headersCommandTimeout` defaults to 10 s.

Four semantics worth knowing:

- It runs **once per connection**, merged over the static `headers` — the dynamic value is the fresher credential and wins. HTTP protocol headers (`content-type`, `accept`, `mcp-protocol-version`, `mcp-session-id`) cannot be set from config.
- A **401/403 re-runs the command once, but the request is retried only if the headers actually changed**, so a command that returns the same token does not pay for a second round trip. On the legacy SSE transport only the POST is rebuilt, not the GET stream.
- **Failure is not fatal.** A timeout, a non-zero exit or unparseable output falls back to the static headers and is recorded in the diagnostics; a later genuine rejection carries that reason in its error message, so a dead command is not mistaken for an expired token.
- **Header values are never logged or displayed.** Diagnostics name headers only, and a parse failure does not echo the command output, which may be a secret in full. `/mcp <server>` shows the command from your config, not what it returned.

The wire layer is implemented here (`protocol.ts`, `client.ts`) and does not use `@modelcontextprotocol/sdk` — the extension directory has no `node_modules`. Only `initialize`, `notifications/initialized`, `tools/list` and `tools/call` are implemented; OAuth, sampling, elicitation, progress and `tools/list_changed` are deliberately absent, and server-to-client requests are answered `-32601` instead of being left to hang. Tool output is truncated at pi's built-in 50 KB / 2000-line limit, and MCP `resource`, `resource_link` and `audio` blocks degrade to a text note, because pi's tool content accepts only text and images.

Diagnostics go to a per-server in-memory ring buffer (20 lines kept, the most recent 8 printed by `/mcp <server>`) and never to stdout or stderr, which in an interactive session would land on top of the editor — the reason `subagent-log-guard/` exists. There is no environment switch: with no config file the extension loads, registers nothing and says so in `/mcp`.

### `subagent-log-guard/` — stderr guard

`pi-subagents` prints launch diagnostics such as `[pi-subagents] Agent 'researcher': host runtime tool availability omitted [...]` with `console.warn`. In interactive mode pi does not take over stdout/stderr, so that text is written straight into the alternate screen at the hardware cursor — right on top of the editor row — and the differential renderer will not repaint it. The result is permanent garbage across the input box.

This extension wraps `process.stderr.write` in processes that have a UI and stops lines beginning with `[pi-subagents]` from reaching the terminal. Only that prefix is filtered; everything else writes through untouched. Processes without a UI (RPC, print, subagent runners) are not patched at all, which is why background subagent diagnostics still land in `runner.stderr.log`.

- `PI_SUBAGENT_LOG_GUARD=notify` — route the messages through `ctx.ui.notify(..., "warning")` instead of dropping them.
- `PI_SUBAGENT_LOG_GUARD=off` — remove the guard (useful when tracing who printed a line).

## Environment switches

Every switch is an environment variable read at use time, not cached at load, so it can be scoped per project or set in a shell alias. An unset variable means "on"; `off` always disables.

| Variable | Default | Owning extension | Effect |
| --- | --- | --- | --- |
| `PI_ASK_USER_QUESTION=off` | on | `ask-user-question` | Do not register the `ask_user_question` tool. |
| `PI_AUTO_DEFAULT_MODEL=off` | on | `auto-default-model` | Do not persist model switches to `settings.json`. |
| `PI_BASH_HIGHLIGHT=off` | on | `bash-command-collapse` | Disable shell syntax highlighting in bash title rows. |
| `PI_BASH_MIN_TIME_MS` | `2000` | `bash-command-collapse` | Only show the elapsed-time footer above this duration. |
| `PI_BASH_PREVIEW` | `3` | `bash-command-collapse` | bash output preview lines (1–50); `off` restores pi's built-in preview. |
| `PI_BASH_SPINNER=off` | on | `working-indicator` | Disable the `●` spinner on running bash rows. |
| `PI_BASH_STREAM=on` | off | `bash-command-collapse` | Use pi's native streaming for bash instead of the collapse path. |
| `PI_BASH_TREE=off` | on | `bash-command-collapse` | Disable tree indentation (`│`/`└`) for bash output. **Retired** — the prefix is always a tree, the switch is no longer read. |
| `PI_BELOW_EDITOR_AFTER_STATUSLINE=off` | on | `below-editor-after-statusline` | Leave `belowEditor` widgets where pi puts them. |
| `PI_CORE_RULES=off` | on | `core-rules` | Do not re-inject the distilled global rules into the context. |
| `PI_CWD_ICON` | ` 📁` | `cwd-statusline` | Icon used by the cwd status line. |
| `PI_CWD_STATUSLINE=off` | on | `cwd-statusline` | Do not print the cwd status line. |
| `PI_DESTRUCTIVE_GUARD` | `on` | `destructive-guard` | `block` refuses the confirm tier too; `notify` reports what it would have caught without blocking; `off` disables the gate. |
| `PI_EDITOR_AUTOCOMPLETE_GAP=off` | on | `prompt-editor` | Do not add the blank line under the autocomplete list. |
| `PI_EDITOR_AUTOCOMPLETE_SHIFT` | `1` | `prompt-editor` | Columns to shift the autocomplete list left. |
| `PI_EDITOR_PROMPT` | `❯` | `prompt-editor` | Editor prompt character. The bash-mode `!` is not affected. |
| `PI_EXIT_WORDS` | `exit,quit,bye` | `exit-command` | Comma-separated quit words; `off` disables the input interception. |
| `PI_FENCELESS_CODE=off` | on | `fenceless-code-block` | Keep Markdown code fences. |
| `PI_FOLDER_HISTORY_INJECT` | `100` | `folder-history` | History entries injected from previous sessions. |
| `PI_GOAL_CAP` | `8` | `verify-loop` | `/goal` continuation cap (CC's number). |
| `PI_GOAL_CONTEXT_CHARS` | `120000` | `verify-loop` | Conversation character budget sent to the `/goal` evaluator. |
| `PI_GOAL_TIMEOUT_MS` | `45000` | `verify-loop` | `/goal` evaluation call timeout. |
| `PI_LOGO=off` | on | `startup-logo` | Do not install the startup header. |
| `PI_PLAN_MODE=off` | on | `plan-mode` | Disable plan mode entirely. |
| `PI_PLAN_MODE_AUTO=off` | on | `plan-mode` | Do not register the model's `enter_plan_mode` tool; `shift+tab` and `/plan` still work. |
| `PI_PLAN_MODE_CONSENT=off` | on | `plan-mode` | Do not ask for consent before the model's `enter_plan_mode` enters plan mode. |
| `PI_READ_COLLAPSE=off` | on | `read-path-collapse` | Keep pi's built-in `read` title row. |
| `PI_SANDBOX=off` | on | `bash-command-collapse`, `sandbox-boundary` | Disable the delete boundary: no seatbelt profile wraps `bash`, and `apply_patch` deletes are not checked. Also off automatically on platforms without `sandbox-exec`. |
| `PI_SANDBOX_ALLOWLIST` | `~/.pi/agent/sandbox-allowlist.json` | `bash-command-collapse`, `sandbox-boundary` | Path of the persistent allowlist both sides share. |
| `PI_SANDBOX_EXTRA_WRITE` | — | `bash-command-collapse` | Colon-separated extra delete roots, `~` expanded, like `PATH`. |
| `PI_SPINNER_COLOR_HOLD` | `19` | `working-indicator` | Frames per color in the spinner cycle. |
| `PI_SPINNER_RAINBOW=off` | on | `working-indicator` | Disable the rainbow spinner. |
| `PI_STATUSLINE_BOOT_SUPPRESS=off` | on | `statusline` | Do not silence pi's built-in footer during the boot window, before this statusline is installed. |
| `PI_STATUSLINE_FREEZE=off` | on | `statusline` | Disable the footer freeze that hides the one-frame flash on session switch. |
| `PI_VERIFY_DOC_EXT` | `.md,.txt` | `verify-loop` | File extensions whose edits do not count as mutations for the gate; an empty string disables the exclusion. |
| `PI_VERIFY_EVALUATOR_MODEL` | `litellm-any/qwen3.8-flash` | `verify-loop` | Evaluator model for `/goal` as `provider/modelId`; falls back to the current session model. |
| `PI_VERIFY_LOOP` | `block` | `verify-loop` | The verification gate's force: `off` disables it, `notify` reports without forcing a continuation, `block` (default) injects and continues. |
| `PI_VERIFY_LOOP_CAP` | `2` | `verify-loop` | Consecutive gate blocks before the turn is let through. |
| `PI_VERIFY_PATTERN` | any bash call | `verify-loop` | `strict` only accepts test/build/lint shapes; any other value is compiled as a case-insensitive regexp. |
| `PI_SUBAGENT_LOG_GUARD` | `drop` | `subagent-log-guard` | `notify` shows the diagnostics through `ctx.ui.notify`; `off` disables the guard. |
| `PI_USER_MESSAGE_BAR=off` | on | `user-message-bar` | Do not draw the `▎` bar into user message boxes. |
| `PI_USER_MESSAGE_BAR_COLOR` | `accent` | `user-message-bar` | Theme slot the bar takes its color from (fallbacks `selectedBg` → `toolDiffAdded` → `text`); a background slot such as `selectedBg` is converted to a foreground. `PI_USER_MESSAGE_BAR_COLOR=toolDiffAdded` restores the added-line green. |
| `PI_WORKING_SUMMARY=off` | on | `working-indicator` | Disable the prompt summary line. |
| `PI_WORKING_SUMMARY_GAP` | `1` | `working-indicator` | Minimum blank columns between the working label and the summary. |
| `PI_WORKING_SUMMARY_LLM=off` | on | `working-indicator` | Truncate the summary instead of asking a model to compress it. |
| `PI_WORKING_SUMMARY_MODEL` | session model | `working-indicator` | `provider/modelId` used for the summary request. |
| `PI_WORKING_SUMMARY_RETRY_MS` | `3000` | `working-indicator` | Delay before the single retry after a failed summary request. |
| `PI_WORKING_SUMMARY_TRIGGER` | `1` | `working-indicator` | Request a summary once the prompt exceeds this multiple of the available width. |

## Extension interactions

- **Esc Esc is shared.** `rewind` replaces pi's built-in double-Escape action and needs `doubleEscapeAction: "none"`; see above.
- **`shift+tab` is shared.** `plan-mode` consumes it before the editor sees it and rebinds the thinking-level cycle to `ctrl+shift+t`; while a turn is streaming the key still reaches `app.thinking.cycle`.
- **The `bash` tool can only be registered once.** Everything that shapes its rendering lives in `bash-command-collapse.ts` for that reason — a second file registering `bash` would be ignored silently.
- **`recap` imports `simple-task/gap.ts`.** The neighbour-gap heuristic is shared rather than duplicated, so `recap` and `simple-task` must be installed together. In this package they always are; if you copy extensions individually, copy both.
- **`verify-loop` imports `recap/subagents.ts`.** The `/goal` evaluator skips its turn while a subagent is still running (CC's "background work defers evaluation"), and that probe is the pi-subagents in-process RPC `recap` already implements; the probe fails open, but `verify-loop` should not be installed without `recap`.
- **`sandbox-boundary` imports `bash-command-collapse/sandbox.ts` and `allowlist.ts`.** The bash seatbelt profile and the `apply_patch` gate are two halves of one boundary and share one judgement plus one allowlist singleton, so those three must be installed together; installing `sandbox-boundary` alone would leave it with no boundary and no memory.
- **`plan-mode` and `simple-task` are independent.** Until 2026-09-24 they shared the `plan-mirror.ts` contract and had to be installed together; an approved plan is now a document and progress is the model's own business, so nothing links them. `plan-mode` still writes the plan file with the `write` tool while its `tool_call` hook pins that path.
- **Three `tool_call` hooks coexist.** `plan-mode` rejects write-shaped commands while planning and pins the `write` tool to the approved plan path; `sandbox-boundary` checks `apply_patch` deletes; `destructive-guard` judges delete targets at all times. They are independent gates with different scopes, and a command can be refused by any of them. The lexical gate and the OS boundary overlap on purpose where they do — one is a pattern match that runs anywhere, the other only exists on macOS.
- **The theme preview and the theme files are coupled.** `/theme` persists the name it previewed, and the name must match the `theme` field's expectations in [themes.md](themes.md).
- **MCP tool names are namespaced.** `mcp__<server>__<tool>` collides with neither the builtins nor the extensions' own tools; names past 64 characters are truncated with a hash suffix, which stays inside the tool-name limit the model APIs enforce while keeping truncated names distinguishable.
- **Three extensions read theme tokens that pi's schema does not define** (`toolDiffAddedBg`, `toolDiffRemovedBg`, `bashOutput`) and degrade quietly when a theme omits them.

## State on disk

| Location | Written by | Contents |
| --- | --- | --- |
| `~/.pi/agent/settings.json` | `auto-default-model` | `defaultProvider` / `defaultModel` on every model switch. |
| `~/.pi/agent/rewind/<project-hash>/git` | `rewind` | Shadow git repository with pre-turn snapshots. Never touched by your repository. |
| `~/.pi/folder-history/<path-with-dashes>.jsonl` | `folder-history` | Command history per working directory. |
| Session log (via `appendEntry`) | `simple-task` | Task list state; discarded with the session, never written to the repo. |
| Session log (via `appendEntry`) | `plan-mode` | Plan phase and the plan text; same lifetime, never written to the repo. |
| Session log (via `appendEntry`) | `verify-loop` | The active `/goal` (condition, status, evaluated turns, last verdict), rebuilt from `getBranch()` on `session_start` — resume restores it, a new session starts clean. The counters (gate blocks, goal continuations, no-progress turns) are **neither persisted nor in memory**: they are counted from the injected `verify-loop` messages in the model-visible projection, because `agent_start` re-fires on every boundary continuation and would zero an in-memory counter. |
| `.pi/plans/<date>-<slug>.md` | `plan-mode` | The approved plan document, written into the project by the model (pinned to that one path by a `tool_call` hook). Upstream adds `.pi/` to the project's `.gitignore` — a plan is a working artefact. |
| `~/.pi/agent/sandbox-allowlist.json` | `bash-command-collapse`, `sandbox-boundary` | The persistent delete allowlist. Machine-local state, an authorization decision rather than configuration, so it is deliberately not in any snapshot. |
| In memory only | `core-rules` | Nothing — the injected message goes into the session log, and the only in-memory state is the content hash scan. |
| In memory only | `recap` | The current summary; lost on `/new` or `/resume` by design. |
| In memory only | `mcp` | Per-server status, the registered tool table and a 20-line diagnostic ring buffer per server. Config files are read, never written. |
| Nothing | everything else | The remaining extensions are pure display or event wiring. |

## Adding, disabling and removing extensions

- **Disable one** — `pi config` lists every resource from packages and local directories with an on/off toggle, in global or project scope. Or set the switch listed above when the extension has one.
- **Remove one** — delete its file (or its directory) from the package, or copy the ones you want into `~/.pi/agent/extensions/` and stop installing the package. Deleting subdirectories is safe except for the directories other files import: the helper-only `thinking-collapse/`, `tool-diff/` and `prompt-editor/`, plus `simple-task/` (whose `gap.ts` is imported by `recap`), `recap/` (whose `subagents.ts` is imported by `verify-loop`) and `bash-command-collapse/` (whose `sandbox.ts` and `allowlist.ts` are imported by `sandbox-boundary`).
- **Edit one** — work in a checkout and run pi against it; see [development.md](development.md).
