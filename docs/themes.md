# Themes

Five themes ship with this package: `pi-coder-1337` (the one `config/settings.json` selects), `pi-coder-catppuccin`, `pi-coder-ayu`, `pi-coder-coffee` and `pi-coder-nightfox`. All five carry the `pi-coder-` prefix, so their names cannot collide with themes from another installed package. Before 2.0.0 they shipped as `summer-night`, `catppuccin` and `ayu`; `pi-coder-summer-night` (an iceberg.vim palette) existed through 2.0.5 and was replaced by `pi-coder-1337`. The last two were added in 2.4.0, both produced by the [`pi-theme-from-palette`](../skills/pi-theme-from-palette/) skill that ships with this package.

## Switching themes

Two ways, both with the same result:

- `/theme` — the picker from `theme-command.ts`. Arrow keys preview live, Enter persists to `settings.json`, Esc leaves settings untouched. `/theme pi-coder-1337` switches directly.
- `/settings` → Theme — pi's built-in path, which also mixes in the light/dark auto modes.

pi loads themes from three places:

```
~/.pi/agent/themes/*.json      # global
.pi/themes/*.json              # project, after the project is trusted
<package>/themes/*.json        # packages — this is how these five arrive
```

The copy commands in [installation.md](installation.md#apply-the-global-config-files) put them in the global directory as well; that is optional, since the package already provides them.

## The five themes

### `pi-coder-1337`

The current default and the thinnest port: it takes Codex CLI's built-in syntax theme `1337` (Mark Herpich's Sublime palette, one of the 32 themes two-face bundles into the Codex binary; `[tui] theme = "1337"` in `~/.codex/config.toml` selects it). It was re-derived from the theme blob embedded in the local codex executable (a zlib-compressed scope→color table) and reconciled scope by scope against upstream's `1337.tmTheme`: all 48 named scopes matched, 37 of them byte-identical, and the remaining 11 are Codex merging a scope into `None` — neither side ever held two different values for one scope. **It is also the reference all the other themes are built against**: the skill copies the 37 secondary slots from this file byte-for-byte.

1337 defines **code syntax only** — `background` `#191919`, `foreground` `#f8f8f2`, `caret`, `selection` `#515151`, `lineHighlight`, `invisibles` `#3b3a32`, plus those 48 named scope entries in 28 distinct foreground colors. It has no UI slots at all, so of pi's 59 colors the syntax slots translate directly and the UI slots are picked from the same 28 values:

| pi slot | 1337 scope | Value |
| --- | --- | --- |
| `syntaxComment` | `comment` | `#6d6d6d` |
| `syntaxString` | `string` | `#fbe3bf` |
| `syntaxNumber` | `constant.numeric` | `#fdb082` |
| `syntaxVariable` | `variable` | `#e9fdac` |
| `syntaxKeyword` | `keyword` (`storage` and `entity.name.tag` share its value) | `#ff5e5e` |
| `syntaxFunction`, `syntaxType` | `entity.name.function` / `entity.name.class` / `entity.other.inherited-class` (all three same) | `#8cdaff` |
| `syntaxOperator` | no matching scope → falls back to `foreground` | `#f8f8f2` |
| `syntaxPunctuation` | `punctuation.definition.*` | `#ffffff` |

Two merges are deliberate. 1337 splits function/class names (`#8cdaff`) from library functions (`support.function`, `#6699cc`) while pi has one `syntaxFunction`: the shared value wins and `syntaxType` follows it, and `#6699cc` is not wasted — it becomes `mdLink`. And `mdHeading` does **not** take 1337's `markup.heading` (`#75715e`): that value is only 3.58:1 on `#191919`, and pi paints the startup list's `[Skills]` / `[Extensions]` section labels with `mdHeading` too; it uses `constant.language`'s orange `#ff8942` (7.46:1) instead.

The remaining UI slots come from 1337's own palette: `border` / `selectedBg` ← `selection`, `borderMuted` ← `invisibles`, `warning` ← `constant.numeric`, `success` ← git-gutter's insertion green `#a6e22e`, `toolTitle` sharing `#8cdaff`, `toolOutput` ← `variable.parameter.function`, `mdListBullet` ← `storage.type` `#fbdfb5`, `bashMode` ← `variable.parameter`, `customMessageLabel` ← the PHP namespace pink `#ffb2f9`. The thinking ladder follows 1337's own cool→warm order, with the top two levels locked (below).

**Six values are locked to the removed `pi-coder-summer-night`**, not to 1337: `toolDiffAdded` / `toolDiffRemoved` / `toolDiffAddedBg` / `toolDiffRemovedBg` (the diff foregrounds and the full-line backgrounds) and `thinkingXhigh` / `thinkingMax`. One consequence is worth stating: those two line backgrounds were picked for summer-night's `#161616` card (1.14 / 1.12:1) and against this theme's `#202020` success card they are 1.02 / 1.01:1 — nearly flat, so the line background adds almost nothing inside a dark diff block (the foreground green is unaffected at 7.83:1). Making them visible again means changing either `toolSuccessBg` or the two backgrounds; it is not an oversight.

`error` is deliberately **not** 1337's `markup.deleted` (`#f92672`): it shares one `vars.removedRed` (`#e27878`) with `toolDiffRemoved`, so editing one place changes both — 6.02:1 on `#191919` and 6.43:1 on `toolErrorBg`. `#f92672` and 1337's `support.constant` `#ecfdb9` are the only two 1337 values this theme gives up. `accent` / `borderAccent` are `#8cdaff`, the same value as `vars.funcBlue` but a **separate** variable, so tuning the accent does not repaint `syntaxFunction` / `syntaxType` / `toolTitle` with it. `mdCode` is the deep cyan `#0d92c1` (accent's previous value, 4.94:1), kept in its own `vars.mdCodeCyan`.

Four backgrounds are specified rather than derived: `userMessageBg` / `customMessageBg` `#242424`, `toolSuccessBg` `#202020`, `toolErrorBg` `#171010`, and `export.cardBg` `#181825` with `export.pageBg` `#111111`. `toolPendingBg` points at the same `vars.successCard` as `toolSuccessBg`, so a pending card and a finished one share one background — see [pending and success share a background](#pending-and-success-share-a-background).

The file has 35 `vars` and 59 colors, with no `#` literal in `colors` and no empty value. It also defines `bashOutput` (`#999999`, its own variable) where `pi-coder-catppuccin` does not.

### `pi-coder-catppuccin`

A port of Catppuccin Mocha from [bacnh85/pi-extensions](https://github.com/bacnh85/pi-extensions). The palette lives in `vars` (31 of them, of which 20 are upstream Mocha) and `colors` only references it. Two entries are empty strings meaning "terminal default": `text` and `syntaxVariable`. `toolPendingBg` used to be the third (upstream's single 256-color index `toolPendingBg: 233` was converted to hex `#140e1e` and then blanked); it now points at `vars.successPanel` like `toolSuccessBg` does. No color in any of the five themes is an integer — `bgAnsi()` emits `48;5;N` for one, which mixes poorly with a truecolor palette. It is still the only theme without `bashOutput`.

One deliberate deviation from upstream beyond the layout: `thinkingXhigh` and `thinkingMax` leave the palette's `blue` for a neutral grey (`vars.thinkingGrey`, `#626262`), for the reason under `pi-coder-ayu` below. The top two levels are no longer one color across the package: `pi-coder-1337` locks them to `#696969`.

### `pi-coder-ayu`

A port of the official `ayu-dark` palette from [iodic/pi-ayu-themes](https://github.com/iodic/pi-ayu-themes), reformatted to the same four-section shape as `pi-coder-catppuccin.json` and with all 55 colors going through `vars`. Like `pi-coder-1337` — and unlike `pi-coder-catppuccin` — it defines `bashOutput`.

Four deliberate deviations from upstream:

1. **Strings vs. added diff lines.** Upstream points `syntaxString` (strings in code) and `toolDiffAdded` (the foreground of added diff lines, including line numbers and `+`) at the same green `#AAD94C`. Here `syntaxString` points at a darker `stringGreen` (`#67a567`) so code strings and diff additions do not glow identically; diff additions keep the upstream green. Side effect: the new green is close in luminance to `muted`, so strings and comments are told apart mostly by hue.
2. **Thinking borders.** Upstream paints `thinkingXhigh` red (`#D95757`). Here `thinkingXhigh` and `thinkingMax` are both a neutral grey (`#626262`, the same treatment `pi-coder-catppuccin` uses), because the editor border takes the color of the current level and this setup defaults to `xhigh` — a red border reads as an error. The top two levels are now distinguished from each other only by luminance.
3. **Pending tool cards share the success background.** Upstream has `toolPendingBg: #10151F` (darker) and `toolSuccessBg: #171F24` (lighter), so a finished card is the lighter one; this file keeps `toolSuccessBg: #10151F` and points `toolPendingBg` at the same variable, so the two states are one color. The pending value moved several times before settling (`#171F24` → `#191919` → `#1d1c1d` → `#1b1c1d` → `#1f1f1f` → `#171717` → `""` → `toolSuccessBg`), always on a `vars` entry of its own: only `toolPendingBg` changed, while `userMessageBg` / `customMessageBg` keep `#1b1c1d`. The `vars` entries the old values lived on (`pendingCard` `#101017`, `toolPendingBg` `#171717`) are gone along with every other variable no slot references — see the trimming rule below.
4. **User message text has a fixed color.** `userMessageText` points at `textColor` (`#dbdbdd`, a var added for it) rather than `fg`, the terminal's default foreground, so user messages read the same on any terminal.

### Pending and success share a background

All five themes point `toolPendingBg` at the same variable as `toolSuccessBg` (`successCard` `#202020`, `toolSuccessBg` `#10151F`, `successPanel` `#151515`; the two new themes reuse `successCard`), so a tool card does not change color when it finishes. Until 2026-09-28 it was the empty string in all three, which meant "terminal default" — the same visual result (nothing changes at the moment the card finishes) reached from the other side. The change came with the tree-shaped tool blocks: `bash-command-collapse`, `read-path-collapse`, `tool-diff`, `simple-task`, `plan-mode`, `memory`, `background-tasks` and `ask-user-question` all declare `renderShell: "self"`, which bypasses pi's `contentBox` entirely, so **no background is painted for those blocks in any state** and the pending/success question does not arise for them. What is left using pi's default shell is every other tool (`grep`, `glob`, MCP tools, …), and for those a card that keeps one background across the pending→success transition is the calmer of the two options. `pi-coder-catppuccin` still carries the unused `vars.pendingPanel` (`#0b151f`) as a ready value if a distinct pending background ever comes back.

## Anatomy of a theme file

```jsonc
{
  "$schema": "...",
  "name": "pi-coder-1337",     // must equal the file name (minus .json)
  "vars": { "panelBg": "#0e1622", ... },
  "colors": { "bg": "panelBg", ... },
  "export": { "pageBg": "panelBg", "cardBg": "bg", "infoBg": "infoBg" }
}
```

- Every non-`#` value in `colors` is looked up in `vars`. A missing reference throws `Variable reference not found`, **the whole theme fails to load**, and pi falls back to the built-in `dark` theme without an error message. This is the single most common way to break a theme.
- An empty string means "terminal default foreground" — used by `text` and, in pi-coder-catppuccin, `syntaxVariable`.
- `export` only affects HTML produced by `/export`; when it is missing, pi derives those colors from `userMessageBg`. In these files it is set explicitly, and through `vars` references like every other color.
- **`vars` holds only variables a slot still uses**: blanking a color to `""` leaves the variable it pointed at referenced by nothing, and those entries are deleted rather than kept as spares (they cannot break loading either way, but they do read as if something used them). The single exception is `pi-coder-catppuccin`'s `pendingPanel` (`#0b151f`), kept whole as a ready value should the pending background ever come back. So the five files carry 35 / 31 / 27 / 45 / 45 `vars` for 59 / 54 / 55 / 59 / 59 colors.

## Custom tokens

Three tokens in these files are **not** part of pi's official theme schema:

| Token | Read by | Effect |
| --- | --- | --- |
| `toolDiffAddedBg` | `tool-diff.ts` | Full-line background of added diff lines. |
| `toolDiffRemovedBg` | `tool-diff.ts` | Full-line background of removed diff lines. |
| `bashOutput` | `bash-command-collapse.ts` | Foreground of bash output text only. |

All five themes define the two diff backgrounds. All but `pi-coder-catppuccin` also define `bashOutput`.

### Why they work at all

Three things line up:

1. Theme validation uses TypeBox's `Compile().Check()`, which **allows unknown keys** — the `additionalProperties: false` in pi's `theme-schema.json` is not on the executed path.
2. `createTheme()` puts any color that is not one of the seven known background tokens into the `fgColors` table.
3. `getFgAnsi()` looks colors up **by key**, without checking the key against the union type. Since a background SGR is a foreground SGR with `38` replaced by `48`, an unknown token can be resolved and used as a background.

If pi ever validates strictly, these tokens stop resolving. Nothing breaks loudly: `tool-diff` silently falls back to the much flatter `toolSuccessBg` / `toolErrorBg`, and `bash-command-collapse` falls back to `toolOutput`.

### `bashOutput` in detail

pi's built-in bash renderer hardcodes output text to `toolOutput`, a slot shared by every tool (`read`, `grep`, `ls` all use it). To give bash output its own color, `bash-command-collapse.ts` temporarily swaps that one key in the module-level theme singleton while it delegates to the built-in renderer — the swap window must be synchronous, and it can only touch this one key.

The extension probes for the token by calling `getFgAnsi("bashOutput")` and does nothing if it throws `Unknown theme color: ...`. So:

- Themes without `bashOutput` (including pi's built-ins and `pi-coder-catppuccin`) are unaffected — bash output simply uses `toolOutput`.
- To split the color out for any theme, add one `vars` entry and one `colors` line, exactly as `pi-coder-ayu` does.
- `bashOutput` does not appear in the `/theme` preview swatches, which only draw pi's standard token list.

## Editing or porting a theme

Renaming a theme means changing **three** places: the file name, the `name` field inside it, and `theme` in `settings.json`. `loadThemeJson()` resolves `${name}.json`, so a mismatch shows the old name in the picker or leaves `theme` pointing at nothing. If the theme lives in `~/.pi/agent/themes/`, only the file name and `name` field matter; pi matches the setting by name.

A theme cannot verify itself. `toolDiffAddedBg` misspelled is silently ignored, and a bad `vars` reference silently drops you to `dark`. After writing a theme, at minimum:

```js
// parse with pi's own loader and resolve every token
validateThemeJson(path, themeJson)
const theme = loadThemeFromPath(path, "truecolor")   // and "256color"
for (const key of Object.keys(colors)) {
  theme.getFgAnsi(key); theme.getBgAnsi(key)   // throws on a missing vars reference
}
```

If you are porting an upstream theme, parse both files and compare `getFgAnsi()` / `getBgAnsi()` per token name. Identical values mean a faithful port; a difference is either an oversight or a deviation that belongs in a comment.

## Adding a theme

The [`pi-theme-from-palette`](../skills/pi-theme-from-palette/) skill ships with this package and automates exactly the above: it takes a foreign palette (a vim colorscheme, a tmTheme plist, a Codex theme export, or a bare hex list), re-derives the **22 primary slots** from it, copies the other 37 from `pi-coder-1337`, and then runs pi's own loader over both files in `truecolor` **and** `256color`, asserting that the secondary slots did not move (`LEAK` must be `none`) and that no `vars` reference dangles. Two rules it enforces, both learned the hard way:

- A new value gets a **new variable name**. Editing a value on an existing `vars` entry silently repaints every other slot that references it — and the shared variables are not obvious ones (`selection`, `comment`, `funcBlue`, `number`, `softFg`).
- Primary-versus-secondary is judged on the **resolved value**, never on the variable name. Identical names do not prove identical output.

Both `pi-coder-coffee` and `pi-coder-nightfox` were produced this way and verified to differ from `1337` in exactly the 22 primary slots, with zero secondary drift and unchanged `export` and key order.
