/**
 * plan-mode 的 keybinding 改绑逻辑（纯函数）。
 *
 * 单独成文件的原因有两个：一是 `index.ts` 要 import pi-tui（`visibleWidth`），
 * 在仓库里没有 node_modules 的情况下无法被测试直接 import；二是「不该覆盖用户配置」
 * 这条规则值得单独钉死 —— 一个扩展悄悄改掉别人的键位而不加护栏，是很讨厌的行为。
 *
 * ## 背景
 *
 * shift+tab 被 pi 内置的 `app.thinking.cycle` 占着。plan mode 要它，于是本扩展
 * 在按键到达编辑器之前拦下并 consume，同时把思考等级循环**改绑到 ctrl+shift+t**，
 * 让用户的功能一个不丢。
 *
 * 改绑的边界：只在 `app.thinking.cycle` **没有任何显式配置**时写入（也就是它还在
 * 吃 pi 的默认值 shift+tab）。用户自己配过（不管是这个键还是别的键），一律不动 ——
 * 他自己的配置显然比扩展的偏好重要。
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** 思考等级循环的新绑定位（shift+tab 让给 plan mode）。 */
export const THINKING_FALLBACK_KEY = "ctrl+shift+t";

/** 被抢占的键位说明（提示文案里用，测试也引用它）。 */
export const THINKING_KEYBINDING_ID = "app.thinking.cycle";

export interface RebindOutcome {
	/** 是否需要写文件。 */
	changed: boolean;
	path: string;
	/** 没改动时的原因（给用户看的提示）；改动时为空。 */
	reason?: string;
	/**
	 * 需要用户手动处理吗（配置坏了、不敢改）？
	 * 与 `reason` 分开：`reason` 是给日志/排查看的，`needsAttention` 决定要不要提示用户。
	 * 「已有绑定」属于后者 —— 那正是我们想要的状态，提示只会变成噪音。
	 */
	needsAttention?: boolean;
}

export function keybindingsPath(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "keybindings.json");
}

/**
 * 给定 keybindings.json 的原文，返回「应该写成什么」+「为什么」。
 *
 * - 文件不存在 / 空：生成只含这一项的新配置
 * - 合法 JSON 对象且没有 `app.thinking.cycle`：补上，其余键原样保留
 * - 已经有 `app.thinking.cycle`（用户自己配的，或本扩展上次改的）：**一个字都不动**
 * - 不是合法 JSON / 不是对象：不动（宁可不改，也不要破坏用户的配置文件）
 */
export function rebindThinkingKey(raw: string, path = keybindingsPath()): { value: string; outcome: RebindOutcome } {
	let config: Record<string, unknown> = {};

	if (raw.trim() !== "") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { value: raw, outcome: { changed: false, path, reason: "config is not valid JSON, left untouched", needsAttention: true } };
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {
				value: raw,
				outcome: { changed: false, path, reason: "config is not a JSON object, left untouched", needsAttention: true },
			};
		}
		config = parsed as Record<string, unknown>;
	}

	if (config[THINKING_KEYBINDING_ID] !== undefined) {
		// 已经绑过了 —— 无论是本扩展上次写的还是用户自己配的，这正是我们想要的状态：
		// 不写文件、也不提示（每次启动都提醒会变成噪音）。
		return {
			value: raw,
			outcome: { changed: false, path, reason: `${THINKING_KEYBINDING_ID} is already bound, leaving it alone` },
		};
	}

	config[THINKING_KEYBINDING_ID] = THINKING_FALLBACK_KEY;
	return { value: `${JSON.stringify(config, null, 2)}\n`, outcome: { changed: true, path } };
}
