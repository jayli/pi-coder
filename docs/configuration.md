# Configuration

`@bachi/pi-coder` ships extensions and themes as package resources, which pi loads by itself. It also ships the **global config files** the environment was built with, because those are files pi reads from `~/.pi/agent/` and no package can install them for you.

| In this package | Destination | Purpose |
| --- | --- | --- |
| `config/AGENTS.md` | `~/.pi/agent/AGENTS.md` | The agent's global working rules: persistence, authorization, destructive-action care, shell hygiene, editing and verification rules, communication style. |
| `config/AGENTS.core.md` | `~/.pi/agent/AGENTS.core.md` | The ~7 KB distilled core (`core-rules` re-injects it into the context mid-session). The extension **does nothing, silently**, when this file is missing. |
| `config/settings.json` | `~/.pi/agent/settings.json` | Everything in the key table below. |
| `config/web-search.json` | `~/.pi/agent/web-search.json` | `pi-web-access` configuration; one required key (see below). |
| `config/pi-statusline.json` | `~/.pi/agent/pi-statusline.json` | Legacy. See [pi-statusline.json](#pi-statuslinejson-is-legacy). |

Copy commands are in [installation.md](installation.md#apply-the-global-config-files).

## Read `settings.json` before copying it

`cp` overwrites your file completely — there is no merge. Two entries are specific to the author's machine:

### `npmCommand` pins pnpm

```json
"npmCommand": ["pnpm", "--config.node-linker=hoisted"]
```

This routes every pi npm operation (install, remove, dependency install for git packages) through pnpm with a hoisted layout. **If you do not have pnpm installed, `pi install` will fail.** Delete the key to use plain npm, or replace it with your own wrapper, e.g.:

```json
"npmCommand": ["mise", "exec", "node@20", "--", "npm"]
```

### `doubleEscapeAction` hands Esc-Esc to `rewind`

```json
"doubleEscapeAction": "none"
```

pi's default is `"tree"` (the built-in session-tree navigator). The `rewind` extension takes over the double-Escape gesture and consumes the second press, so with `"tree"` you would get rewind's menu and never pi's tree. `"none"` states that intent explicitly. To go back: remove `extensions/rewind/` and set the value to `"tree"`.

## What each `settings.json` key does

| Key | Value here | Notes |
| --- | --- | --- |
| `lastChangelogVersion` | `"0.85.1"` | Internal marker for "last changelog the user saw". It only suppresses a changelog notice; harmless to keep or delete. |
| `theme` | `"pi-coder-1337"` | Must equal the `name` field inside `themes/pi-coder-1337.json`, not just the file name. |
| `defaultThinkingLevel` | `"xhigh"` | Startup thinking level. Not available on every model; see `thinkingLevelMap` in your `models.json`. |
| `compaction.enabled` / `reserveTokens` / `keepRecentTokens` | `true` / `52429` / `20000` | `keepRecentTokens` is pi's default; `reserveTokens` is raised well above pi's `16384` default because this setup's models stream long thinking blocks. |
| `npmCommand` | `["pnpm", "--config.node-linker=hoisted"]` | See above. Machine-specific. |
| `extensions` | `[]` | No explicit extension paths — auto-discovery of `~/.pi/agent/extensions/` and package resources only. The author's real file pointed at a telemetry extension from another tool; that absolute path was intentionally dropped. |
| `tuiMode` | `"regular"` | pi's default, written out explicitly. |
| `packages` | `["npm:pi-web-access", "npm:pi-subagents"]` | The two companion packages. This array is exactly what `pi install` writes. |
| `steeringMode` | `"one-at-a-time"` | pi's default, explicit. |
| `markdown.mermaid` | `"streaming"` | pi's default, explicit. |
| `doubleEscapeAction` | `"none"` | See above. |
| `subagents.watchdog` | `{ "enabled": true }` | A `pi-subagents` setting: the opt-in second-model reviewer. On every turn that changed the repository it feeds that turn's diff plus the user's scope to an independent reviewer model looking for missed constraints, correctness risks, test gaps, unsafe changes and drift; clean turns are silent, `high` findings are pushed back into the model's context, `low` / `medium` are shown to the user only, and three identical warnings in a row are judged a deadlock and stop it. `/subagents-watchdog on\|off\|status` drives it inside a session; `settings.json` is read at startup, so an edit takes effect next session. The snapshot also sets `main.model`, which is machine-specific and removed here — see below. |
| `subagents.agentOverrides` | `researcher` / `delegate` / `worker` → `tools: "inherit"` | A `pi-subagents` setting, not a pi core one. |

### Why `tools: "inherit"` on three subagents

`pi-subagents` filters a child agent's tools against a strict whitelist. Core builtins that the host lacks are removed with a warning; **non-core names are passed through and validated by the child session's own registry** — so a tool silently disappears when its name does not exist there.

That is exactly what happens with the built-in `researcher` agent: its frontmatter asks for `web_search`, while `web-search.json` renames that tool to `pi_web_search`. The child registry has no `web_search`, so the tool is dropped and the subagent cannot search at all.

`inherit` deletes the whitelist entirely (`applyToolsOverride` does `delete target.tools`), and the subagent gets every tool the child registry has. It is applied only to the three **write-capable** agents:

- `researcher`, `delegate`, `worker` — they already may write, so nothing is lost.
- Read-only agents (`scout`, `reviewer`, `oracle`) must **not** get `inherit`: it would hand them `write`, `edit` and `bash` and break their read-only contract. `evidence-auditor` has a whitelist of the same broken shape, but inheriting it would silently grant write access, so it is left alone.

Interaction tools need no exclusion: `ask_user_question` checks `ctx.hasUI` and removes itself from child sessions.

## What is not shipped

### `config/settings.json` and `config/AGENTS.md`

`config/settings.json` holds the two machine-specific entries above; everything else in it is portable. `config/AGENTS.md` is the agent's global working rules and is not machine-specific at all; `config/AGENTS.core.md` is its distilled core and equally portable, but remember it is **load-bearing**: `core-rules` injects it, and a missing file means that extension is silently absent from a session.

`config/models.json` and `config/mcp.json` are **not** shipped: provider registrations point at a local gateway and the MCP file holds absolute paths of local server executables, so both belong to the machine that runs them. MCP servers are configured in `~/.pi/agent/mcp.json` or a project `.mcp.json`.

Provider and model registrations are machine-specific: this setup's `litellm-any` provider points at a LiteLLM gateway on `127.0.0.1:996` (LAN address on other machines), carries a compat configuration, and registers six model ids that must match the gateway's routes exactly. Shipping it would be wrong on every other machine, so it is excluded.

The settings keys that select a model were removed along with it:

| Removed key | Why |
| --- | --- |
| `defaultProvider: "litellm-any"` | The provider only exists in the excluded `models.json`. |
| `defaultModel: "deepseek-flash"` | Depends on that provider. |
| `modelThinkingLevels` | Pins `deepseek-flash` and `deepseek-flash-qd` to `max`; model ids again. |
| `subagents.watchdog.main.model` | `"litellm-any/deepseek-flash-qd"` — the same provider. Omitting it makes the watchdog inherit the current session model, which is the documented fallback; the author's choice is a speed pick (~1.4 s through the gateway), not a requirement. |

Everything else in `settings.json` is byte-for-byte the author's file. If you run your own gateway you can add them back:

```json
"defaultProvider": "<provider>",
"defaultModel": "<model-id>",
"modelThinkingLevels": { "<provider>/<model-id>": "max" }
```

and merge a `main` block into the `subagents.watchdog` object that is already there (it sits beside `agentOverrides`, so do not replace the whole `subagents` key):

```json
"subagents": {
  "watchdog": { "enabled": true, "main": { "model": "<provider>/<model-id>" } },
  "agentOverrides": { "...": "..." }
}
```

A configured reviewer model must be fully qualified as `provider/model` and authenticated in your registry; an unavailable one is **reported, not silently replaced**. Omitting `main.model` altogether inherits the current session model and thinking level, which is what this package relies on. Three sub-switches stay off here as they do upstream — `children` (review subagents), `clarification` (an extra review per prompt) and `cadence` (review every N tool calls) — and `agentEndTimeoutMs` defaults to 30000, after which the review is abandoned rather than blocking the turn. Findings carry an `importance` of `low` / `medium` / `high`: only `high` is steered back into the model's context and triggers a continuation, `low` and `medium` are persisted for the user alone, and a clean review shows nothing. `stalemateRepeats` defaults to 3 — after that many identical warnings in a row the finding is shown as `stalemate`, no continuation is triggered and the turn ends, with your next prompt resetting the count. Its Test Gap category overlaps the `verify-loop` gate on purpose: the gate is deterministic and free, the watchdog is a model judgement that costs a call, so one catches "nothing ran" and the other catches drift and missed edits.

For how providers and thinking levels work, see pi's own `docs/models.md` and `docs/custom-provider.md`.

### `mcp.json`

The MCP server list is machine-specific in the same way: the snapshot's only entry points at the absolute path of a local server executable, which exists on one machine only.

MCP servers are configured in `~/.pi/agent/mcp.json` and/or the nearest project `.mcp.json`, in Claude Code's shape. Neither file is shipped. With no config at all the `mcp/` extension loads, registers no tools and says so in `/mcp`. The format — including `headersCommand` for dynamic auth headers — is documented in [extensions.md](extensions.md) and, in more detail, in the [Chinese handbook](handbook.zh.md).

So two snapshot config files are deliberately left out of this package: `models.json` (gateway registrations) and `mcp.json` (paths of local MCP server executables). `AGENTS.md` and `settings.json` are shipped, and `settings.json` is the only shipped config file that differs from the snapshot — the four removed model selections in the table above.

### `pi-statusline.json` is legacy

This file configures `npm:@narumitw/pi-statusline`, a package this environment no longer uses — `extensions/statusline/` replaced it. The local statusline reads **no config file at all**: colors come from `theme.fg(...)`, so it follows whatever theme is active, and the second line comes from other extensions calling `ctx.ui.setStatus()`.

The file is kept only so you can switch back to the npm package without re-deriving the palette (it holds a Tokyo Night palette, segment order and per-extension status icons). Nothing in this package reads it.

## `web-search.json` — one key, and it is required

```json
{ "toolNames": { "webSearch": "pi_web_search" } }
```

pi registers the `pi-web-access` search tool as `web_search` by default. A LiteLLM Anthropic→OpenAI translation layer treats **any tool literally named `web_search`** as Anthropic's built-in web search (`_is_web_search_tool`), strips it from `tools`, and substitutes an empty `web_search_options: {}` — which the backend rejects. The result is not an error: the request succeeds and the tool simply does not exist for the model.

Renaming the tool changes the same request from `tools=7` to `tools=8` in the gateway log (and to `tools=0` when only `web_search` was sent). If you are not routing through such a gateway, the rename is still harmless.

> When a tool vanishes like this, do not trust the model's own explanation — it will guess from the stale `promptSnippet` still present in the system prompt. Count `tools=N` in the gateway log instead.

## Machine-local files that are intentionally not in the package

| File | Why not |
| --- | --- |
| `~/.pi/agent/auth.json` | Credentials. |
| `~/.pi/agent/trust.json` | Per-machine project trust decisions, keyed by absolute path. |
| `~/.pi/agent/models-store.json` | Cache of pi's built-in model catalog. |
| `~/.pi/agent/sessions/` | Session transcripts. |
| `~/.pi/agent/missions/`, `run-history.jsonl` | `pi-subagents` mission and run history. |
| `~/.pi/agent/rewind/` | The `rewind` extension's shadow snapshot repositories. |
| `~/.pi/agent/npm/`, `bin/` | Installed packages (use `pi install`) and pi's bundled `fd`/`rg`. |
| `~/.pi/agent/web-search-cache/`, `~/.pi/folder-history/*.jsonl` | Runtime caches and history. |

The [Chinese handbook](handbook.zh.md) documents the same list with the reasoning behind each entry, plus the gateway and model routing this environment was tuned for.
