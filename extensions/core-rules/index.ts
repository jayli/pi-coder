/**
 * core-rules — 把全局 AGENTS.md 的核心铁律在会话中途重新推到上下文末尾。
 *
 * ## 要解决的问题
 *
 * pi 的全局 `~/.pi/agent/AGENTS.md` 是**用户级**的：它被 `renderProjectContext`
 * （dist/core/system-prompt.js）拼进 system prompt 的 `<project_context>` 段，
 * 排在 preamble / tools / rules / docs 之后，而且全局块后面还紧跟项目 AGENTS.md
 * （本仓库是 105KB）。于是它坐在 index 0 的一个 124KB 大 blob 中间 —— 每请求都发，
 * 从不丢失，但位置永远在最前面，随对话增长 recency 越来越差，指令遵循强度就衰减。
 *
 * ## Codex 是怎么解的（本扩展照它做）
 *
 * Codex 的 AGENTS.md **不在 system prompt 里**，而是 world state 的一个 section：
 *
 *   - `context/user_instructions.rs`：`role: "user"`，包在 `# AGENTS.md instructions`
 *     … `</INSTRUCTIONS>` 标记里，带目录标签。base instructions 才走 `role: "developer"`。
 *   - `context/world_state/agents_md.rs`：`AgentsMdState` 实现 `WorldStateSection`
 *     （ID = `agents_md`），`render_diff` 拿当前快照和 baseline 比，**不变就什么都不发**，
 *     变了才发并带上 `REPLACEMENT_NOTICE`（"These AGENTS.md instructions replace all
 *     previously provided AGENTS.md instructions."）。
 *   - `compact.rs`：压缩后 `reference_context_item` 被清空 → 下一轮
 *     `should_inject_full_context` 为真 → 全量重注入，且
 *     `insert_initial_context_before_last_real_user_or_summary` 把它插到**最后一条真实
 *     user 消息之前**（近末尾，高 recency）。
 *
 * 所以 Codex 的触发点是三个：会话开始、每次压缩之后的第一轮、内容真的变了。
 * 其余轮次不重复注入。本扩展用**一个判定**覆盖这三个（`decision.ts`）：
 * 扫模型可见投影里有没有自己的消息 —— 没有 = 会话开始或已被压缩掉；有但 hash 不同 =
 * 内容变了；hash 相同 = 跳过。
 *
 * ## pi 侧的落点
 *
 * `before_agent_start` 返回的 message 会被 pi 追加成 `role: "custom"` 的
 * custom_message 条目，**持久化进 session**，而且在 `agent-session.js` 里 user message
 * 先 push、hook message 后 push —— 所以它落在**用户消息之后**，比 Codex 的
 * 「插在最后一条 user 消息之前」位置还要靠后，recency 更好。
 *
 * 压缩后旧条目自动出投影（`buildContextEntries` 从 `firstKeptEntryId` 起算），
 * 于是「投影里没有」这个条件天然覆盖了 Codex 的压缩重注入时机，不需要另挂
 * `session_compact` 钩子。
 *
 * ## 注入什么
 *
 * 不是 27KB 的全局 AGENTS.md 全文，而是蒸馏版 `~/.pi/agent/AGENTS.core.md`（约 7KB）：
 * 破坏性动作三规则、blast radius 分级、授权范围、计划门、委派纪律、技能触发规则、git/shell 底线。
 * 全文仍在 system prompt 里，这份只是把最不能衰减的那几条推到末尾。
 * 文件缺失就静默跳过（不报错、不注入）—— 它是可选增强，不该让 pi 启动变吵。
 *
 * `PI_CORE_RULES=off` 整体关闭。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { decideInjection, renderBody, type PriorHashes } from "./decision.ts";

/** 注入消息的 customType，也是扫描投影时的识别标记。 */
export const CORE_RULES_TYPE = "core-rules";

/** 规则文件名（放在 pi 的 agent 目录下）。 */
export const RULES_FILENAME = "AGENTS.core.md";

/** pi 的 agent 目录（`PI_CODING_AGENT_DIR` 可覆盖，否则 `~/.pi/agent`）。 */
export function resolveAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	return envDir ? (envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir) : join(homedir(), ".pi", "agent");
}

/** 读规则文件；缺失或读不到返回 undefined（调用方据此静默跳过）。 */
export function loadRules(agentDir: string): string | undefined {
	try {
		const text = readFileSync(join(agentDir, RULES_FILENAME), "utf-8");
		return text.trim() === "" ? undefined : text;
	} catch {
		return undefined;
	}
}

/** 内容 hash，作为「内容变没变」的判定依据（Codex 用的是结构化快照比较）。 */
export function hashRules(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * 从模型可见投影里取出已有 core-rules 消息的 hash，按出现顺序。
 *
 * 只认 `custom_message` 条目（`before_agent_start` 返回的 message 就是这个类型）；
 * `details.hash` 缺失记为 undefined —— 对应 Codex 的 `PreviousSectionState::Unknown`：
 * 知道有前文但不知道内容，保守地重注入。
 */
export function collectPriorHashes(entries: readonly unknown[]): PriorHashes {
	const hashes: PriorHashes = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as { type?: unknown; customType?: unknown; details?: unknown };
		if (record.type !== "custom_message" || record.customType !== CORE_RULES_TYPE) continue;
		const details = record.details as { hash?: unknown } | undefined;
		hashes.push(typeof details?.hash === "string" ? details.hash : undefined);
	}
	return hashes;
}

export default function coreRules(pi: ExtensionAPI): void {
	if (process.env.PI_CORE_RULES === "off") return;

	pi.on("before_agent_start", async (_event, ctx) => {
		const agentDir = resolveAgentDir();
		const text = loadRules(agentDir);
		const currentHash = text === undefined ? undefined : hashRules(text);
		const decision = decideInjection(currentHash, collectPriorHashes(ctx.sessionManager.buildContextEntries()));
		if (decision.action === "skip" || text === undefined) return undefined;

		return {
			message: {
				customType: CORE_RULES_TYPE,
				content: renderBody(text, decision.replacement),
				display: false,
				details: { hash: currentHash },
			},
		};
	});
}
