/**
 * brainstorm.ts — brainstorming ↔ plan mode 二选一的纯判定。
 *
 * 用户 2026-09-26 定：superpowers 的 brainstorming 技能自带「澄清 → 方案 → 批准 →
 * 设计文档 → writing-plans 实施计划」全流程，与 plan mode 的设计→批准→文档流程完全
 * 重叠。两者**二选一**：本次 run 已加载 brainstorming（read 过它的 SKILL.md）就全程
 * 按它走，不再进 plan mode；未加载时 plan gate 照常。
 *
 * 本模块只做判定，不发事件、不碰 pi —— `node --test` 可直测（与 verify-loop/gate.ts
 * 同风格）。拦截点在 index.ts 的 `enter_plan_mode` execute 最前面（同意弹框之前），
 * 只拦模型路径；用户手动进 plan（shift+tab / /plan / --plan）不经过这里。
 *
 * ## 「本次 run」与「加载过」的口径
 *
 * - run 窗口 = 分支里**最后一条 `role:"user"` 消息之后**的所有消息（verify-loop
 *   gate.ts 的既有口径）。下一条新 prompt 若没加载 brainstorming，豁免不继承 ——
 *   这是用户选定的「仅本次 run」语义。
 * - 「加载」= assistant 消息的 `toolCall` 块里 `name === "read"` 且规范化后的
 *   `arguments.path` 含 `/brainstorming/`。用路径片段而非绝对路径：本机技能库是
 *   `~/.agents/skills/superpowers` → `~/.codex/superpowers/skills` 的符号链接链，
 *   路径可能变，片段匹配兼容搬家。
 * - 已知边界：模型用 bash `cat` 读 SKILL.md 不算加载 —— 与 verify-loop 的词法口径
 *   同级，是写进文档的边界；实际加载技能走 `read` 工具，误报面≈0。
 */

/** 分支消息的最小结构鸭子类型（不 import pi，保持可单测）。 */
export interface RunMessage {
	role?: unknown;
	content?: unknown;
}

/** 会话分支原始条目的最小鸭子类型（`getBranch()` 返回的 `SessionEntry`）。 */
export interface BranchEntry {
	type?: unknown;
	message?: unknown;
}

interface ToolCallBlock {
	type?: unknown;
	name?: unknown;
	arguments?: unknown;
}

/**
 * 把 `getBranch()` 的原始条目收敛成消息数组（只取 `type:"message"` 的那层里的 message）。
 *
 * 这是 `buildSessionProjection()` 不可用时的兜底口径：分支条目是
 * `{type:"message", message:{role, content}}`，而判定函数要的是 message 本身。
 * 两者的差别只在压缩（compaction）：投影是压缩后的模型可见消息，分支是全量历史。
 * 对本判定无实质影响 —— run 窗口只看最后一条 user 之后，压缩几乎不会落在窗口内。
 */
export function messagesFromBranch(entries: readonly BranchEntry[]): RunMessage[] {
	const messages: RunMessage[] = [];
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message && typeof message === "object") messages.push(message as RunMessage);
	}
	return messages;
}

/**
 * run 窗口起点：最后一条 `role:"user"` 消息的下标（不含它自己）。
 * 没有 user 消息时返回 -1（整个分支都算窗口）。
 *
 * 注意：扩展注入的是 `role:"custom"`，**不算** user，所以续跑链共用一个窗口。
 */
export function findRunStart(messages: readonly RunMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i].role === "user") return i;
	}
	return -1;
}

/**
 * 本次 run 里有没有 read 过 brainstorming 的 SKILL.md。
 *
 * 只认 run 窗口内的 assistant `toolCall` 块；路径反斜杠转正斜杠后做片段匹配
 * （`/brainstorming/`），前后带斜杠保证不会误中 `brainstorming2/` 之类的邻居目录。
 */
export function brainstormingLoadedInRun(messages: readonly RunMessage[]): boolean {
	const from = findRunStart(messages) + 1;
	for (let i = from; i < messages.length; i += 1) {
		const message = messages[i];
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			const call = block as ToolCallBlock;
			if (call?.type !== "toolCall" || call.name !== "read") continue;
			const args = call.arguments as { path?: unknown } | undefined;
			if (typeof args?.path !== "string") continue;
			if (args.path.replaceAll("\\", "/").includes("/brainstorming/")) return true;
		}
	}
	return false;
}
