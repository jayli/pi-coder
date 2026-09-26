/**
 * memory/context — 注入块的纯函数部分：纪律文本 + 索引拼装。
 *
 * 纪律文本是 CC auto-memory 提示词的蒸馏，外加本仓库 2026-09-26 讨论得出的
 * 时态判据（过去时观察永不过期 / 现在时状态断言必然腐烂）与读取端核实义务
 * （AGENTS.md `## Verification` 同款：inherited text is untrusted input）。
 *
 * 注入走 `before_agent_start` 改 `systemPromptOptions.sections.memory`：
 * section 进 system message、随 transcript 重放、压缩后存活；索引只在
 * memory_write/forget 时变化，字节天然稳定，不需要 pi-memory 那套快照机制。
 */

import { buildIndex, type MemoryEntry } from "./store.ts";

/** 注入纪律文本（模型每次会话都看到的行为契约）。 */
export const MEMORY_DISCIPLINE = `# auto memory

You have a persistent, file-based memory for this project. The files are lessons
saved from prior sessions; what you save here is all that persists after this
session ends. The index below is loaded every session; read a memory's full body
with memory_read when its line looks relevant.

A good memory is applicable, durable, and legible — save only when all three hold:
- applicable — would directly change your behavior in future sessions: an approach
  the user corrected or steered you away from, or a standing preference they
  expressed. Not ambient code context, and not a finding of your own about the
  code — the lesson must come from the user, not from your own debugging.
- durable — applies to multiple future sessions, not just this one. "Never…",
  "always…", "whenever you…" widen and are durable; "this time…", "for now…"
  narrow. If uncertain whether a lesson is durable, assume it is not and skip it.
- legible — readable without the original session: one topic per memory, full
  sentences, include the **Why:** and **How to apply:**, convert relative dates
  to absolute ones.

Tense rule — the single best staleness filter:
- DO save past-tense observations: measurements you ran, decisions made and
  options rejected (with the reason), corrections the user gave. The past never
  expires.
- DO NOT save present-tense claims about this repo's state: line numbers, config
  values, protocol/interface shapes, task progress. The code is the truth for
  those; a snapshot of it rots within days. If a memory would be wrong because
  the code changed, it should never have been written — read the code instead.

Never save: what the repo already records (architecture, file paths, past fixes,
git history, anything AGENTS.md already says), ephemeral task state, or secrets
and credentials of any kind.

Before recommending from memory: a memory that names a file, function, or flag
claims it existed *when the memory was written*. Verify it still exists (read the
file, grep the symbol) before acting on it. "The memory says X exists" is not the
same as "X exists now."

Check each reply before you send it: did the user's latest message teach a
durable, applicable lesson? If so, save it in that same reply with memory_write.
Doing what the user asked does not discharge the save. When the user says
"remember this", save it immediately. Update an existing memory rather than
creating a near-duplicate; memory_forget what turns out to be wrong.`;

export interface MemoryContextResult {
	/** 注入 sections.memory 的完整文本；空库返回 undefined（不注入）。 */
	text: string | undefined;
	droppedCount: number;
	totalCount: number;
}

/** 纪律 + 索引拼装。无记忆时返回 undefined —— 空库不占上下文。 */
export function buildMemoryContext(entries: MemoryEntry[]): MemoryContextResult {
	if (entries.length === 0) return { text: undefined, droppedCount: 0, totalCount: 0 };
	const index = buildIndex(entries);
	const parts = [MEMORY_DISCIPLINE, "", "## Memory index", "", index.content.trimEnd()];
	if (index.droppedCount > 0) {
		parts.push(
			"",
			`> WARNING: ${index.droppedCount} of ${index.totalCount} memories are over the index read limit and were NOT loaded. Merge or delete stale memories with memory_write / memory_forget.`,
		);
	}
	parts.push(
		"",
		"Use memory_read <name> for a memory's full body, memory_search <query> to find memories by keyword.",
	);
	return { text: parts.join("\n"), droppedCount: index.droppedCount, totalCount: index.totalCount };
}
