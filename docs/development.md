# Development

## Layout rules pi enforces

These come from pi's extension discovery and they decide where a file may live:

| Path | Loaded as an extension? |
| --- | --- |
| `extensions/*.ts`, `extensions/*.js` | **Yes** — top-level files only. |
| `extensions/<dir>/index.ts` or `index.js` | **Yes**. |
| `extensions/<dir>/*.ts` without an `index` | No. Helper modules, imported by other extensions. |
| `extensions/<dir>/<subdir>/*` | No — nested directories are never scanned, which is how `mcp/fixtures/` ships test servers. |
| `extensions/<dir>/*.test.ts` | No — only the directory's `index.ts` is loaded. |
| `extensions/*.test.ts` (top level) | **Yes** — pi would try to load it. Never put tests at the top level. |

`thinking-collapse/`, `tool-diff/`, `prompt-editor/` and `folder-history/` are the helper-only directories here: the matching top-level `.ts` files import them, and pi never loads them directly.

Two consequences worth remembering:

- `recap/index.ts` imports `../simple-task/gap.ts` across directories. Both must ship together.
- `package.json`'s `pi.extensions: ["./extensions"]` resolves a directory with exactly these rules, so the manifest and the convention directory behave identically.

## Tests

```bash
npm test        # node --test — 631 tests, ~34 s
```

Test files run in parallel (`os.availableParallelism()` — 15 on the machine this was written on). Under that load one case is unreliable: the real spawned MCP handshake in `mcp/client.test.ts` intermittently hits its own 5 s handshake budget (seen twice in four full runs here, and never in isolation). The whole suite passes reliably with reduced parallelism at the same wall time:

```bash
node --test --test-concurrency=4      # 631 tests, ~34 s
```

The 5 s budget is inside the snapshot's `client.test.ts`, which this package keeps byte-identical — it belongs upstream in `clients/pi/`, not here.

The pure-logic modules are written so this works: they do not import `@earendil-works/pi-*` at all, take injected dependencies instead (a `widthOf` function, an `exec` function, a minimal theme interface), and are duck-typed against structural interfaces. That is why `thinking-collapse/window.ts`, `statusline/line.ts`, `tool-diff/title-row.ts`, `rewind/checkpoints.ts`, `prompt-editor/bash-prompt.ts` and the rest can run under plain `node --test`. `mcp/` goes further in the same direction: `protocol.ts`, `config.ts`, `client.ts`, `tools.ts` and `headers-command.ts` are pi-free too, so the whole chain — including a **real** spawned stdio server (`fixtures/fake-mcp-server.mjs`) and real `node:http` servers for the HTTP and SSE transports — is covered with no transport mocking.

Two test files go the other way: [`prompt-editor/render.test.ts`](../extensions/prompt-editor/render.test.ts) loads the **real** extension through pi's own loader and asserts the `!` bash-mode render contract line by line and column by column, with only the surroundings faked (a `tui` that has just `terminal.rows` and `requestRender()`, an identity `borderColor`, keybindings that never match); [`user-message-bar/index.test.ts`](../extensions/user-message-bar/index.test.ts) does the same for the message box, comparing patched and unpatched frames of the same text at the same width — which is what proves the prototype patch landed on the class pi actually renders with, the one failure this feature can have. Both locate pi's library entry by reading the `# cmd-shim-target=` line out of the `pi` shim, and both **skip** — rather than failing or faking a pass — when pi cannot be resolved, because the copy under `~/.pi/agent/npm` is often an empty shell after `pi update --extensions`. Point them at a real entry with `PI_TEST_PI_ENTRY=/path/to/index.js`.

**Tests passing is not enough.** pi loads `.ts` with its own loader, and a construct node accepts can still fail there:

> A single invalid annotation (`readonly (readonly 0 | 1)[][]`) left 22 unit tests green while pi raised `ParseError` and refused to load the whole extension.

So every change ends with a real pi start. The cheapest reliable procedure is below.

## Running your checkout against a real pi

The extensions are already in this package, so a plain `pi -e ./path` **collides with any copy in `~/.pi/agent/extensions/`** and aborts:

```
Error: Failed to load extension ".../extensions/bash-command-collapse.ts":
  Tool "bash" conflicts with .../pi-coder/extensions/bash-command-collapse.ts
Hint: Start without extensions using "pi -ne".
```

Isolate the run instead — a scratch agent directory has no global extensions, so only the checkout loads:

```bash
PI_CODING_AGENT_DIR=$(mktemp -d) pi -e /absolute/path/to/pi-coder
```

Then check that all 24 loaded by reading the startup list:

```
[Extensions]
  ask-user-question, auto-default-model, bash-command-collapse.ts, ... working-indicator
```

`/reload` re-reads the checkout, so the loop is: edit → `/reload` → look. That works for `pi -e` runs as well as for an installed package; you do not need to restart pi for extension edits. `settings.json` and `AGENTS.md` are read once at startup, so those do need a restart.

For scripted checks, run pi inside tmux and grep the pane rather than trusting a single screenshot:

```bash
tmux new-session -d -s pi-check -x 200 -y 50 \
  "PI_CODING_AGENT_DIR=$(mktemp -d) pi -e $PWD; sleep 60"
sleep 15
tmux capture-pane -p -t pi-check | grep -i "failed to load\|parseerror"
tmux kill-session -t pi-check
```

## Traps this codebase already paid for

Everything below is documented because it cost real debugging time. The full reasoning is in the file headers named next to each item.

- **A hidden column still accepts the cursor.** `prompt-editor` hides the `!` of bash mode, but `Editor` keeps the cursor column in private state with no public setter, so the extension calls `setCursorCol(1)` directly and degrades to "the cursor stays at column 0" if pi ever renames it — a cosmetic regression only. Letting the cursor sit on the hidden column writes `x!ls` into the text, at which point pi decides it is no longer bash mode.
- **A `ctx` captured before a session replacement goes stale**, and reading `ctx.ui` throws `This extension ctx is stale after session replacement or reload`. The throw happens when you read the property, before any widget `render()` runs, so a `try/catch` inside `render()` cannot catch it. A timer that outlives the session takes the host process down with it (`exit=1`). `simple-task/` and `working-indicator/` therefore all three: catch inside the callback and stop the timer, wrap every `ctx.ui` access, and stop timers in `session_shutdown`. `user-message-bar/` hit the other half of the same hazard: pi invalidates the old `ctx` in its teardown while the previous session's user messages are still mounted and rendering, so a stale-context read from inside a **render tick** — where nothing can catch it — reaches the host's `uncaughtException` and kills pi (`/clear` was the reproduction). It resets its color source on `session_shutdown`, which fires before the invalidation, and reads the theme through a `try/catch`; the worst case is a few frames without the bar.
- **A throwing `renderCall` is silently swallowed** and replaced by `createCallFallback()`: something disappears from the UI and nothing is logged.
- **Tool registration is first-registration-wins per name.** A second extension registering `bash` is ignored without a warning — which is why everything that shapes `bash` rendering lives in one file.
- **Reading pi state at module top level breaks; patching a class prototype does not.** In the bundled CLI, `@earendil-works/pi-coding-agent` resolves through the loader's `virtualModules` to the same chunk `interactive-mode.js` uses — but importing `keyHint`/`keyText` yields another module instance's state (`Theme not initialized`, or an empty string), so key names are read from `~/.pi/agent/keybindings.json` instead. The rule is about *state*, not classes: `statusline/footer-suppress.ts` imports `FooterComponent` from the package root and patches `prototype.render`, and an A/B capture shows the patch landing on the instance pi itself constructs. `startup-logo` still wraps its package-root import in a `try/catch`.
- **Extensions are loaded before pi constructs the TUI.** That ordering is what makes the footer patch above possible at factory time, and it sets the price: anything installed that early must be reversible. `/reload` re-evaluates the module (the patch key is a `Symbol.for` in the global registry so a new instance releases the old one), and the 30 s cap covers the case where the handoff never happens.
- **Patching a pi-tui prototype works; patching the copy in `node_modules` does nothing** — silently. pi's bundled loader points extensions at its own inlined namespace, which is why `fenceless-code-block/` can patch `Markdown.prototype` and `index.test.ts` can assert it with pi's own renderer.
- **`usage.output` is always `0` while streaming**, so token counts must be estimated from streamed characters.
- **`renderResult` receives no `isError`**; read it from `context`. Reading `result.isError` silently paints failures as successes.

## Adding an extension

1. Decide the shape: a single `extensions/<name>.ts`, or `extensions/<name>/index.ts` plus helper modules.
2. Export `default function (pi: ExtensionAPI)`.
3. Put logic that deserves tests in a module that imports nothing from pi, and inject what it needs.
4. Add a header comment: what problem it solves, which pi internals it depends on, what you tried that did not work. These headers are the reason this package is maintainable.
5. `npm test`, then the tmux check above.
6. If the extension has a switch, follow the existing convention: `PI_<NAME>=off` disables it, read on each use rather than cached at load, and document it in the README table and [extensions.md](extensions.md).

A new tool name and a new command name must not collide with any other extension here; the list is in [extensions.md](extensions.md#commands).

## Keeping this package in sync

This package is a distribution copy, not the master copy. The author's live environment is `~/.pi/agent/`, snapshotted into a separate repository under `clients/pi/`; this package was produced by copying that snapshot verbatim (extensions, themes, and the config files) with three deliberate deltas:

1. `config/models.json` and `config/mcp.json` are not shipped, and the three model-selection keys were removed from `config/settings.json` (`defaultProvider`, `defaultModel`, `modelThinkingLevels`). Both excluded files hold machine-local values — gateway registrations and absolute paths of local MCP server executables. See [configuration.md](configuration.md#what-is-not-shipped).
2. `docs/handbook.zh.md` is the snapshot's README, kept verbatim as the Chinese handbook.
3. Everything else under `docs/`, plus `README.md` and `CHANGELOG.md`, is written for this package: extension count, test count and the switch tables have to be updated by hand.

So when the snapshot changes upstream:

```bash
SRC=/Users/bachi/jaylli/litellm-any/clients/pi   # the snapshot the extension lives in
DST=/Users/bachi/jaylli/pi-coder                 # this package
cp -R "$SRC/extensions/." "$DST/extensions/"
cp "$SRC/themes/"*.json "$DST/themes/"
cp "$SRC/AGENTS.md" "$DST/config/AGENTS.md"
cp "$SRC/README.md" "$DST/docs/handbook.zh.md"   # the handbook is the snapshot README, verbatim
diff -r "$SRC/extensions" "$DST/extensions"     # expect: no output
diff -r "$SRC/themes" "$DST/themes"              # expect: no output
diff "$SRC/AGENTS.md" "$DST/config/AGENTS.md"    # expect: no output
npm test
# bump "version" in package.json, add a CHANGELOG entry, update the counts in README.md and docs/
```

Nothing else is copied. `config/settings.json` is the only file in the package that may differ from the snapshot, and `diff` on it is expected to show exactly the three removed model keys.

## Publishing

```bash
npm login                 # first time only
npm pack --dry-run        # inspect the tarball before publishing
npm publish
```

- The name is scoped, so `publishConfig.access: "public"` is already set — without it npm refuses to publish a scoped package publicly on a free account.
- `keywords` includes `pi-package`, which is what makes the package appear in the [pi.dev gallery](https://pi.dev/packages). Keep it.
- `files` decides the tarball contents; nothing else is uploaded. `.git` and `node_modules` are never included.
- Bump `version` before each publish (npm rejects re-publishing an existing version) and add the corresponding `CHANGELOG.md` entry.
- To test the exact artifact that would be published, pack it and install the **extracted directory** — pi treats a file path as a single extension, so a `.tgz` path fails with `Unknown file extension ".tgz"`:

  ```bash
  npm pack
  mkdir -p /tmp/pi-pkg && tar -xzf bachi-pi-coder-1.0.0.tgz -C /tmp/pi-pkg
  PI_CODING_AGENT_DIR=$(mktemp -d) pi install /tmp/pi-pkg/package
  ```

## How the package appears on pi.dev

The [package catalog](https://pi.dev/packages) is indexed from npm — there is no submission form or upload endpoint (`/api/*` answers `501 API routes are reserved for future features`). Publishing to npm with `pi-package` in `keywords` is the whole mechanism; the crawl picks the package up within minutes and it appears in the *Recently published* feed and in the full list.

The **detail page renders this README as its body**, so `README.md` is the gallery landing page, not just npm metadata:

- Relative links (`docs/extensions.md`, `extensions/tool-diff.ts`) are rewritten against the `repository` field, so they resolve in the gallery — both `https://github.com/jayli/pi-coder/blob/main/docs/...` and a jsDelivr CDN form are used.
- The page leads with the description, badges, and any `pi.image` / `pi.video` preview, then the README.
- Resource chips (`extension`, `theme`, …) come from the `pi` manifest, so an accurate manifest is also accurate marketing.
- The catalog adds a `report` link to `earendil-works/pi` issues automatically.

### Post-publish checklist

```bash
npm view @bachi/pi-coder version --registry=https://registry.npmjs.org   # the version you just pushed
curl -s -o /dev/null -w '%{http_code}\n' https://pi.dev/packages/@bachi/pi-coder   # 404 before indexing, 200 after
pi install npm:@bachi/pi-coder
```

Once the package exists on npm, two optional additions become safe (they render as broken until then):

1. **Badges** at the top of the README, as the reference packages do:

   ```markdown
   ![npm](https://img.shields.io/npm/v/@bachi/pi-coder?style=for-the-badge)
   ![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)
   ![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-blue?style=for-the-badge)
   ```

2. **A preview asset** — done: `package.json` declares `pi.image` pointing at `assets/demo-server-https.gif`, and the README links that capture instead of embedding it — GitHub proxies every off-domain image through camo, which answers `Content length exceeded` above 5 MiB (measured: 4.26 MB renders, 5.29 MB does not), and the capture is 7.3 MB. The README embeds `assets/ayu1.png` (1502×1690) at `width="700"` and links `assets/pi-coder-palettes.html`, a self-contained palette page, from its first line, its theme section and its documentation table. That one link goes through `raw.githack.com` rather than jsDelivr: jsDelivr serves every `.html` file as `text/plain`, so a browser shows the markup instead of the page ([jsdelivr#18111](https://github.com/jsdelivr/jsdelivr/issues/18111)). The assets live in `assets/`, which is not in the npm `files` list, so they stay out of the tarball. They are served through jsDelivr (`https://cdn.jsdelivr.net/gh/jayli/pi-coder@main/assets/...`) rather than `raw.githubusercontent.com`, which timed out intermittently from this machine; either form needs `assets/` to be on `main`. jsDelivr is not a guarantee of edge service either: an uncached blob answers 301 to `raw.githubusercontent.com`, and branch pointers (`@main`) are cached for 12 h, so a pushed replacement can stay invisible for a while (purge it with `https://purge.jsdelivr.net/gh/jayli/pi-coder@main/...`). jsDelivr does not serve GitHub files over 20 MB, so anything near that size has to be compressed first — the capture is a 30.8 s, 1002×563, 30 fps recording encoded with `ffmpeg` (`scale=1002:563`, `palettegen`/`paletteuse` with `dither=none`) and then `gifsicle -O3 --lossy=20`, which takes it from 12.6 MB to 7.3 MB (0.98 SSIM at 600 px display width). To use a video instead, upload an MP4 (a `github.com/user-attachments/...` URL works) and declare `pi.video`:

   ```json
   "pi": {
     "extensions": ["./extensions"],
     "themes": ["./themes"],
     "video": "https://github.com/user-attachments/assets/..."
   }
   ```

   `video` takes precedence over `image` when both are set; on desktop the video autoplays on hover and opens fullscreen on click. Re-publish after changing the manifest.
