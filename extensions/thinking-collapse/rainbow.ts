/**
 * rainbow.ts — thinking 滚动行的彩虹着色（单位切分 + 着色组装 + `/rainbow` 的配置 IO）。
 *
 * 与 `window.ts` 同一套约定：本模块**不 import pi / pi-tui**，颜色转义与环境色都靠注入
 * （`RainbowPaint`），所以 `node --test` 能直接跑它：
 *
 *     node --test clients/pi/extensions/thinking-collapse/rainbow.test.ts
 *
 * 目录与 `thinking-collapse.ts` 同名且没有 index.ts，不会被 pi 的扩展加载器当成扩展
 * （理由见 window.ts 头部）。
 *
 * ## 着色单位（用户 2026-10-10 定）
 *
 *   - **英文按空白分词**：一个词（含它后面拖着的空白与标点）是一个单位；
 *   - **中/日/韩文字每个字一个单位**（它们没有空白可依，整句一色就没彩虹可言了）；
 *   - 只由标点/空白组成的段落**并进前一个单位**，免得 `段，` 的逗号白白吃掉一格色相。
 *
 * 色相按**单位在整行里的绝对序号**每步前进 `HUE_STEP_DEG`（默认 60°，6 个单位转完一圈）。
 * 「绝对序号」是要点：头部截断（`…` 往前挤）只改变可见窗口，不改变单位的序号，所以
 * 同一批字在滚动过程中**颜色不变**，不会每来一个 token 整行换色闪一下。
 *
 * ## 着色怎么和环境色共存（这条最容易写错）
 *
 * pi 是把**每个文本 token** 整体套一层 `thinkingText` 前景色的（`applyDefaultStyle`），
 * 我们自己插进去的 `\x1b[38;2;…m` 会一直生效到下一次设色或 `39m` 为止。所以：
 *
 *   - 连续着色单位之间**直接换色**（SGR 38 覆盖上一个，不必中间插重置）；
 *   - 离开着色区时（碰到 code span、或到窗口末尾）补发一次环境色（`paint.ambient`，由
 *     调用方用 `theme.getFgAnsi("thinkingText")` 拿到，与 pi 同一串），把颜色交还回去
 *     —— 否则那段 code span 残余或后续填充会沿用最后一个彩虹色。
 *
 * 斜体（`\x1b[3m`）不受前景色影响，不会被这一步弄丢。
 *
 * 着色**不改变可见文本**（只在单位前后插转义），所以宽度口径、头部截断、折行判定全部
 * 照旧走纯文本那一套 —— window.ts 因此可以先在纯文本空间里算完，再调用着色。
 *
 * ## code span 不着色
 *
 * `` `code` `` 是「原本就带颜色的关键字」，要保留它自己的 `mdCode` 颜色，所以落在 code span
 * 里的单位一律原样输出。code span 的配对规则由调用方用 window.ts 的 `findCodeSpanEnd`
 * 算好后传进来（对齐 marked 的判定），本模块只做区间判断。
 *
 * ## 配置
 *
 * `~/.pi/agent/rainbow.json`（`PI_RAINBOW_CONFIG` 可改路径）：`{ "enabled": true }`。
 * 任何读取问题都退回默认值，写盘用临时文件 + rename 的原子写。`PI_RAINBOW=off` 是
 * 独立于本文件的总闸（在扩展入口读一次）。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 每单位前进的色相（度）。60° = 6 个单位走完一圈 360°。 */
export const HUE_STEP_DEG = 60;

/** 深色底 / 浅色底两种皮肤下的饱和度与亮度档位（okhsl 的 s / l，都是 0-1）。 */
export const OKHSL_TUNING = {
	dark: { saturation: 0.85, lightness: 0.66 },
	light: { saturation: 0.9, lightness: 0.42 },
} as const;

/** 一个着色单位在整行纯文本里的位置。`text` 恒等于 `[start, end)` 那一段。 */
export interface RainbowUnit {
	readonly text: string;
	readonly start: number;
	readonly end: number;
}

/** 一段 code span 的区间（`[start, end)`，含两侧反引号）。 */
export interface Span {
	readonly start: number;
	readonly end: number;
}

/** 着色所需的两串转义，都由调用方按当前皮肤 / 终端色彩模式解析好。 */
export interface RainbowPaint {
	/** 第 `index` 个单位的前景色转义（未上色的裸序列，形如 `\x1b[38;2;r;g;bm`）。 */
	fg(index: number): string;
	/** 恢复环境色（pi 的 `thinkingText` 前景色）的转义，每个单位着色后补发一次。 */
	ambient: string;
}

/**
 * 全角字母 / 数字（`ＡＢＣ` `１２３`）：它们在 CJK 区里，但**不是表意文字**，按「字母数字
 * 是词」处理，所以 `ＡＢＣ` 是一个单位而不是三个。全角标点仍在 `isCjkPunctCodePoint` 里。
 */
function isFullWidthAlnum(code: number): boolean {
	return (code >= 0xff10 && code <= 0xff19) || (code >= 0xff21 && code <= 0xff3a) || (code >= 0xff41 && code <= 0xff5a);
}

/** 中/日/韩文字（含假名与 CJK 标点）：每个码点算一个单位。口径与 window.ts 的 `isWideChar` 同源。 */
function isCjkCodePoint(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) || // 含 CJK 标点 0x3000-0x303f 与假名
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		((code >= 0xff00 && code <= 0xff60) && !isFullWidthAlnum(code)) ||
		(code >= 0xffe0 && code <= 0xffe6)
	);
}

function isSpaceCodePoint(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x2000 && code <= 0x200a) || code === 0x3000;
}

/**
 * CJK 标点（`，。、；：？！「」『』《》【】…` 及全角/半角形式）。
 *
 * 与 `isCjkCodePoint` 的差别是要点：那个函数把**表意文字**也算 CJK（每个字一个单位），
 * 这个只认标点 —— 否则「中文」里的每个字都会被当成标点并进同一个单位，整句一色。
 */
function isCjkPunctCodePoint(code: number): boolean {
	if (code >= 0x3000 && code <= 0x303f) return true; // CJK 符号与标点
	if (code >= 0xfe30 && code <= 0xfe6f) return true; // 竖排/小型形式
	if (code >= 0xff61 && code <= 0xff65) return true; // 半角片假名标点
	if (code < 0xff01 || code > 0xff60) return false; // 全角形式区（含全角字母数字）
	const digit = code >= 0xff10 && code <= 0xff19;
	const upper = code >= 0xff21 && code <= 0xff3a;
	const lower = code >= 0xff41 && code <= 0xff5a;
	return !digit && !upper && !lower;
}
/** 标点 / 符号（不含字母数字）：单位若**只由标点与空白组成**就并进前一个，不单独吃一格色相。 */
function isPunctLikeCodePoint(code: number): boolean {
	if (code >= 0x80) return isCjkPunctCodePoint(code);
	// ASCII：字母数字以外都算标点（`_` 归标点，反正它总是夹在词里）
	return !(
		(code >= 0x30 && code <= 0x39) ||
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x61 && code <= 0x7a) ||
		code === 0x5f
	);
}

/** 码点宽度（代理对占 2 个 UTF-16 单元）。 */
function codePointSize(code: number): number {
	return code > 0xffff ? 2 : 1;
}

/**
 * 把一个码点归到一个类别。只有「整单位都是标点/空白」时才需要再判断是否并入前一个单位，
 * 所以这里的标点判定只需覆盖常见的 ASCII 与 CJK 标点。
 */
function isPunctLike(text: string, start: number, end: number): boolean {
	for (let i = start; i < end; ) {
		const code = text.codePointAt(i) ?? 0;
		const size = codePointSize(code);
		if (!(isPunctLikeCodePoint(code) || isSpaceCodePoint(code))) return false;
		i += size;
	}
	return true;
}

/**
 * 把整行切成着色单位。返回的区间**连续覆盖**整串文本（相邻单位首尾相接，无空洞），
 * 所以调用方可以按任意 `[from, to)` 切片重组成着色后的同一段文字。
 *
 * 规则见文件头「着色单位」一节。空串返回空数组。
 */
export function splitRainbowUnits(text: string): RainbowUnit[] {
	const units: Array<{ start: number; end: number }> = [];
	let i = 0;
	while (i < text.length) {
		const code = text.codePointAt(i) ?? 0;
		const size = codePointSize(code);

		// 空白单独处理：并进**前一个**单位。空白没有可见颜色，挂在谁身上都一样，但口径要
		// 统一：空白永远不开启新单位（除非它就在行首）—— 否则「个 file」里的空格会变成
		// ` file` 这种以空白开头的单位。
		if (isSpaceCodePoint(code)) {
			let j = i;
			while (j < text.length) {
				const next = text.codePointAt(j) ?? 0;
				if (!isSpaceCodePoint(next)) break;
				j += codePointSize(next);
			}
			if (units.length > 0) units[units.length - 1].end = j;
			else units.push({ start: i, end: j });
			i = j;
			continue;
		}

		let end: number;
		if (isCjkCodePoint(code)) {
			end = i + size;
		} else {
			// 非 CJK：吃到空白或 CJK 为止（一个「词」）。空白交给下一轮统一吸收。
			let j = i + size;
			while (j < text.length) {
				const next = text.codePointAt(j) ?? 0;
				if (isCjkCodePoint(next) || isSpaceCodePoint(next)) break;
				j += codePointSize(next);
			}
			end = j;
		}
		// 只由标点组成的单位并进前一个（`段，` 里的逗号不该单独吃一格色相）。
		if (units.length > 0 && isPunctLike(text, i, end)) units[units.length - 1].end = end;
		else units.push({ start: i, end });
		i = end;
	}
	return units.map((u) => ({ start: u.start, end: u.end, text: text.slice(u.start, u.end) }));
}

/** 区间是否与任一 code span 相交。 */
function overlapsSpan(start: number, end: number, spans: readonly Span[]): boolean {
	for (const span of spans) {
		if (span.start < end && start < span.end) return true;
	}
	return false;
}

function isDropped(index: number, dropped: readonly number[]): boolean {
	return dropped.length > 0 && dropped.includes(index);
}

/**
 * 把 `line` 的 `[from, to)` 这段按单位着色后返回（**不含** `…`，那是窗口层加的）。
 *
 *   - 单位的序号 `index` 是**整行里**的下标（不是窗口内下标），色相因此绝对稳定；
 *   - 与 code span 相交的单位原样输出（保留它自己的 `mdCode` 色）；
 *   - `dropped` 里列出的原字符（窗口内落单的反引号）**不输出** —— 着色层的合约是「可见
 *     文本与窗口层已经过 `stripUnpairedBackticks` 的那段逐字相同」；
 *   - 连续着色单位之间直接换色（SGR 38 会覆盖上一个），只在**离开着色区**时（遇到
 *     code span 或到窗口末尾）补一次 `paint.ambient`，把颜色交还给 pi 的 `thinkingText`。
 *     为什么需要这一下：pi 是每个文本 token 只套一次环境色，而我们插进去的颜色会一直
 *     生效到下一次设色或 `39m` 为止 —— 末尾不收尾的话，同一 token 里排在后面的内容
 *     （被截断的 code span 残余、以及意料之外的填充）会沿用最后一个彩虹色。
 *
 * 这是扩展入口直接拿去当 `ColorizeFn` 用的函数。
 */
export function paintRainbow(
	line: string,
	units: readonly RainbowUnit[],
	from: number,
	to: number,
	paint: RainbowPaint,
	spans: readonly Span[] = [],
	dropped: readonly number[] = [],
): string {
	let out = "";
	let colored = false;
	/** 离开着色区时把颜色交还给环境色（幂等：没在着色就什么都不做）。 */
	const restore = (): void => {
		if (!colored) return;
		out += paint.ambient;
		colored = false;
	};

	for (let index = 0; index < units.length; index++) {
		const unit = units[index];
		if (unit.end <= from) continue;
		if (unit.start >= to) break;
		const start = Math.max(unit.start, from);
		const end = Math.min(unit.end, to);
		if (end <= start) continue;

		let chunk = "";
		for (let i = start; i < end; i++) {
			if (isDropped(i, dropped)) continue;
			chunk += line[i];
		}
		if (chunk === "") continue;

		if (overlapsSpan(start, end, spans)) {
			// code span 是「原本就带颜色的关键字」：先把手上的彩虹色交还回去，再原样输出。
			restore();
			out += chunk;
			continue;
		}
		out += paint.fg(index) + chunk;
		colored = true;
	}

	restore();
	return out;
}

// =============================================================================
// `/rainbow` 的配置 IO（`~/.pi/agent/rainbow.json`）
// =============================================================================

export const RAINBOW_CONFIG_FILENAME = "rainbow.json";

export interface RainbowConfig {
	/** 流式过程中给 thinking 单词上彩虹色。默认开（用户 2026-10-10 定）。 */
	readonly enabled: boolean;
}

export const DEFAULT_RAINBOW_CONFIG: RainbowConfig = { enabled: true };

/** pi 的 agent 目录（`PI_CODING_AGENT_DIR` 可覆盖，与 voice/controller.ts 同款）。 */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const envDir = env.PI_CODING_AGENT_DIR;
	if (envDir && envDir.length > 0) {
		return envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
	}
	return join(homedir(), ".pi", "agent");
}

/** 配置文件路径（`PI_RAINBOW_CONFIG` 优先）。 */
export function rainbowConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_RAINBOW_CONFIG;
	if (override && override.length > 0) {
		return override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
	}
	return join(agentDir(env), RAINBOW_CONFIG_FILENAME);
}

/** 读配置。文件不存在 / JSON 坏了 / 字段类型不对 → 一律退回默认值（不抛）。 */
export function loadRainbowConfig(configFile: string): RainbowConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configFile, "utf8"));
	} catch {
		return { ...DEFAULT_RAINBOW_CONFIG };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_RAINBOW_CONFIG };
	const enabled = (raw as Record<string, unknown>).enabled;
	return { enabled: typeof enabled === "boolean" ? enabled : DEFAULT_RAINBOW_CONFIG.enabled };
}

/** 写配置（`/rainbow on|off` 用）。原子写：先写同目录临时文件再 rename 覆盖。 */
export function saveRainbowConfig(configFile: string, patch: Partial<RainbowConfig>): RainbowConfig {
	const next = { ...loadRainbowConfig(configFile), ...patch };
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
