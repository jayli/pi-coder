/**
 * thought.ts — thinking 收尾摘要（`Thought for 23s (234 tokens)`）的纯逻辑 + `/think-tail` 的配置 IO。
 *
 * 与 `window.ts` 同一套约定：本模块**不 import pi / pi-tui**（可见宽度函数
 * `widthOf` 由调用方注入），所以 `node --test` 能直接跑它：
 *
 *     node --test clients/pi/extensions/thinking-collapse/thought.test.ts
 *
 * 目录与 `thinking-collapse.ts` 同名且没有 index.ts，不会被 pi 的扩展加载器当成扩展
 * （理由见 window.ts 头部）。
 *
 * ## 它解决的形态
 *
 * thinking 滚动的最后会留下一条「残影」：`Think: …最后那截推理`。用户可以 `/think-tail off`
 * 让滚动结束后**不留残影**，只显示一行摘要 —— **这也是出厂默认**（用户 2026-10-26 定）：
 *
 *     Thought for 23s (234 tokens)
 *
 * 想恢复残影形态就 `/think-tail on`（落盘后长期生效）。
 *
 * 这一行仍然是**斜体**（pi 给 thinking 块的默认样式本来就带 italic，纯文本返回即可），
 * 也仍然**恰好一行**（超窄终端从尾部截断补 `…`，口径同 `window.ts`）。
 *
 * ## 两个数字各自的口径
 *
 *   - **秒数**是「只算 Think 段」的实测值（用户 2026-10-26 选的口径）：从 thinking 段的
 *     `thinking_start` 起算到 `thinking_end`（不发 `thinking_end` 的后端用第一个正文 /
 *     工具增量为界）。扩展入口维护「段键 → 毫秒」那张表，本模块只负责按键查表与兜底。
 *   - **token** 由 thinking 原文**现算**（`estimateThoughtTokens`），不读 `usage`：本机网关
 *     （qoder 系）的 `usage.reasoning` 恒缺，读它只会让数字消失。估算口径与
 *     `working-indicator` 的 spinner 完全一致（宽字符 1 token、窄字符 1/4、向上取整），
 *     而且是可加的 —— 逐 delta 累加与对整段一次性计算等价，所以 live 与恢复会话的数字天然一致。
 *
 * 恢复会话时秒数来自 `AssistantMessage.durationMs`（那是**整条响应**的时长，比 Think 段略长）：
 * 会话文件里没有更细的时间戳，这是唯一能拿到的数；live 那一路才是实测值。
 *
 * ## 段键（为什么不能拿「消息 + 下标」当键）
 *
 * `renderMarkdownTransformer` 的 context 只有 `messageType` / `isStreaming` / `availableWidth`，
 * **没有消息身份、也没有 contentIndex**，所以查表只能按内容找键。pi 把一条消息里连续的
 * thinking 块按 `trim()` 后 `\n\n` 连接成一个 markdown 交给渲染器，`thoughtRunKey` 就按同一
 * 口径归一后再哈希，于是「渲染器拿到的原文」与「流式事件里攒下的段文本」能对上。
 *
 * 两个已知边缘情形（与摘要切换的 `thinkingStreaming` 同一类，刻意的取舍，别为它们引入
 * 更复杂的协议）：
 *
 *   - 同一段 texts 在同一会话里出现两次（模型逐字重复同一段思考）⇒ 两段共用同一个秒数。
 *   - 同一条消息里「thinking → 正文 → 又 thinking」时，第二段流式期间第一段会**重新显示滚动
 *     窗口**而不是它的摘要（查表命中的秒数一样能取到，但正在流式的那一段与第一段争同一个
 *     markdown 字符串；要精确到块得拿 contentIndex 对，那一层信息在这条渲染路径上不存在）。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { ELLIPSIS, truncateTail, type WidthFn } from "./window.ts";

/** 摘要行的第一个词（`Thought for …`）。 */
export const THOUGHT_LABEL = "Thought for";

/** 可用宽度缺失 / 不合理时的兜底（列），与 `window.ts` 同值。 */
const DEFAULT_WIDTH = 80;

/**
 * 时长格式化：<60s → `23s`；≥60s → `1m 3s`；≥1h → `1h 2m 3s`。
 *
 * 与 `working-indicator` 的 `formatDuration` 同形状（用户看惯了这个读法），但刻意**不**
 * 从那里 import：那个文件 import 了 pi，本模块要能在 `node --test` 里直接跑。
 * 负值 / NaN 一律当 0 —— 时钟倒挂时宁可显示 `0s`，也不要把 `NaNs` 印到屏幕上。
 */
export function formatThoughtDuration(ms: number): string {
	const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	return `${minutes}m ${seconds}s`;
}

/**
 * 估算 thinking 的 token 数。**口径与 `working-indicator` 的 spinner 一致**：
 * 宽字符（CJK，终端占 2 列）每字 1 token，窄字符每 4 个 1 token，向上取整。
 *
 * 为什么不读 `usage.reasoning`：本机网关（qoder 系 agent 协议）的用量里根本没有这个字段
 * （`usage` 恒缺或为 0），读它只会让括号里的数字消失。为什么不数 delta：宽/窄字符数是可加的，
 * 对整段一次性计算与逐段累加严格等价，而整段现算不需要任何额外状态 —— 恢复会话时也不会
 * 因为没走流式而显示 0。
 *
 * 为什么不用注入的 `widthOf` 反推：本模块要能在 `node --test` 里不依赖 pi-tui 直接跑，而
 * 估算精度只影响括号里的一个整数（差 1 个 token 无人能察），自己按码点分类更省事。
 */
export function estimateThoughtTokens(text: string): number {
	if (text === "") return 0;
	let wide = 0;
	let narrow = 0;
	for (const ch of text) {
		if (isWideCodePoint(ch.codePointAt(0) ?? 0)) wide += 1;
		else narrow += 1;
	}
	return Math.ceil(wide + narrow / 4);
}

/**
 * 宽字符（终端占 2 列）：与 `window.ts` 的 `isWideChar` 同一张表。
 *
 * 之所以在这里再写一份而不是 import：那张表是 `window.ts` 的私有函数（没导出），而导出它会
 * 把「宽度口径」与「token 口径」耦合成一个公开面。两张表都只覆盖「中日韩正文 + 全角形式」，
 * 差几格最多让估算偏 1 个 token，不影响显示。
 */
function isWideCodePoint(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6)
	);
}

/** 摘要行的纯文本（不含任何终端转义）。 */
export function formatThoughtSummary(durationMs: number, tokens: number): string {
	return `${THOUGHT_LABEL} ${formatThoughtDuration(durationMs)} (${Math.max(0, Math.floor(tokens))} tokens)`;
}

/**
 * 把渲染器拿到的 thinking markdown 归一到 `thoughtRunKey` 的输入口径：pi 是「每块 `trim()`
 * 后 `\n\n` 连接」，所以只要按同一个规则重排，流式事件里攒下的原文与渲染器的入参就能对上
 * （两种来源的块边界都来自上游 SSE，内容逐字一致，差别只在空白）。
 */
export function normalizeThoughtText(markdown: string): string {
	return markdown
		.split(/\r\n|[\n\r]/)
		.map((part) => part.trim())
		.filter((part) => part !== "")
		.join("\n\n");
}

/** FNV-1a（32 位）：段键的哈希，够短、够稳、无依赖。 */
function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * thinking 段的键：归一后的文本 + 长度。长度为的是把哈希碰撞的实际后果压到「几乎不可能」——
 * 碰撞只会让两段共用同一个秒数，不会显示错内容（内容永远来自渲染器自己）。
 */
export function thoughtRunKey(markdown: string): string {
	const normalized = normalizeThoughtText(markdown);
	return `${normalized.length}:${fnv1a(normalized)}`;
}

/**
 * 生成出口的摘要行：**恰好一行**、超窄时从尾部截断补 `…`（口径同 `window.ts` 的兜底截断）。
 *
 * 返回纯文本而不是带转义的行：pi 给 thinking 块的默认样式本来就带 italic + `thinkingText`
 * 颜色，`Think: ` 那种「标签要正体、正文要斜体」的切换在这里不需要。
 */
export function buildThoughtSummary(
	markdown: string,
	durationMs: number,
	availableWidth: number,
	widthOf: WidthFn,
): string {
	const line = formatThoughtSummary(durationMs, estimateThoughtTokens(markdown));
	const width = Math.max(1, Math.floor(availableWidth) || DEFAULT_WIDTH);
	return truncateTail(line, width, widthOf, ELLIPSIS);
}

// =============================================================================
// `/think-tail` 的配置 IO（`~/.pi/agent/think-tail.json`）
// =============================================================================

export const THINK_TAIL_CONFIG_FILENAME = "think-tail.json";

export interface ThinkTailConfig {
	/**
	 * 滚动结束后是否留残影（`Think: …最后那截`）。
	 *
	 * `false`（默认）= 不留残影，只显示一行 `Thought for 23s (234 tokens)`；
	 * `true` = 残留影形态，滚动完把最后那截留在行尾（`/think-tail on` 写盘后才这样）。
	 */
	readonly enabled: boolean;
}

export const DEFAULT_THINK_TAIL_CONFIG: ThinkTailConfig = { enabled: false };

/** pi 的 agent 目录（`PI_CODING_AGENT_DIR` 可覆盖，与 window.ts 同款）。 */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const envDir = env.PI_CODING_AGENT_DIR;
	if (envDir && envDir.length > 0) {
		return envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
	}
	return join(homedir(), ".pi", "agent");
}

/** 配置文件路径（`PI_THINK_TAIL_CONFIG` 优先，其次 `PI_CODING_AGENT_DIR`）。 */
export function thinkTailConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_THINK_TAIL_CONFIG;
	if (override && override.length > 0) {
		return override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
	}
	return join(agentDir(env), THINK_TAIL_CONFIG_FILENAME);
}

/** 读配置。文件不存在 / JSON 坏了 / 字段类型不对 → 一律退回默认值（不抛）。 */
export function loadThinkTailConfig(configFile: string): ThinkTailConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configFile, "utf8"));
	} catch {
		return { ...DEFAULT_THINK_TAIL_CONFIG };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_THINK_TAIL_CONFIG };
	const enabled = (raw as Record<string, unknown>).enabled;
	return { enabled: typeof enabled === "boolean" ? enabled : DEFAULT_THINK_TAIL_CONFIG.enabled };
}

/** 写配置（`/think-tail on|off` 用）。原子写：先写同目录临时文件再 rename 覆盖。 */
export function saveThinkTailConfig(configFile: string, patch: Partial<ThinkTailConfig>): ThinkTailConfig {
	const next = { ...loadThinkTailConfig(configFile), ...patch };
	mkdirSync(dirname(configFile), { recursive: true });
	const tmp = `${configFile}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	try {
		renameSync(tmp, configFile);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// 收不掉就算了：一个 .tmp 不值得再抛一次盖住真正的错误
		}
		throw err;
	}
	return next;
}
