/**
 * theme-extra/colors.ts — 从**皮肤文件的 `vars`** 里取扩展自己的颜色。
 *
 * ## 为什么要有这个模块（2026-10-12，pi 1.2.0）
 *
 * 本仓三套皮肤一直往 `colors` 里塞三个 pi 官方 schema 没有的 token：
 * `bashOutput`（bash 输出正文的独立灰，用户 2026-10-06 定）与 `toolDiffAddedBg` /
 * `toolDiffRemovedBg`（`tool-diff.ts` 的整行 diff 底色）。在 pi ≤ 1.1.0 这能生效，是因为
 * 那几版的 `colors` 校验**不设 `additionalProperties: false`**（只查类型，未知键原样放行），
 * `createTheme()` 再把它们收进前景表供 `getFgAnsi()` 查。
 *
 * **pi 1.2.0 把主题 schema 改成 strict 了**（`theme-schema.js` 的 `colors` /
 * `export` / 顶层全部 `additionalProperties: false`，`main.js` 在启动期就装上校验器），
 * 于是多一个键的皮肤整份作废、回退 `system` 主题。官方口径（`docs/themes.md`）是
 * 「自定义颜色放进 `vars`」—— `vars` 是 `Record(string, ColorValue)`，无键名限制。
 *
 * 但 `vars` 只参与**解析**：`createTheme()` 只把 `colors` 里的键收进查色表，`vars` 里的
 * 条目不进 `getFgAnsi()` / `theme.colors`（2026-10-12 实测：schema PASS、`getFgAnsi`
 * 仍抛 `Unknown theme color`）。所以扩展要拿回这几个色，只能自己读 `vars` —— 这就是本模块。
 *
 * ## 取色链路与「色值必须逐字节不变」的保证
 *
 *     skin.json 的 vars[name]  →  ops.parseColor  →  ops.fgAnsi/bgAnsi(…, theme.getColorMode())
 *
 * 这与 pi 内部给 `colors` 里的键生成转义走的是**同一对函数**（`Theme` 构造里的
 * `foregroundAnsi(parseColor(value), mode)`），所以同一色值出来的 SGR 逐字节相同 ——
 * truecolor / 256color 两种模式都验过（28 组，见 `colors.test.ts` 里的等价性用例）。
 *
 * ## 读文件的三个边界
 *
 * 1. **`theme.sourcePath` 是皮肤文件路径**（1.2.0 实测：用户皮肤与内置 dark / light 都有）。
 *    文件按 mtime 缓存；主题对象换掉（换皮肤 / `/reload`）时 `WeakMap` 自然失效，
 *    读到的也是新文件。内置 dark / light 的 `vars` 里没有这三个名字 → 返回 undefined
 *    → 调用方走各自的原兜底（`toolOutput` / `toolSuccessBg` / `toolErrorBg`），
 *    与「别的皮肤不定义 = 零影响」的老约定完全一致。
 * 2. **值必须是真色值**（带 `#` / `oklch()` / `okhsl()` / 整数索引）。`vars` 允许引用别的
 *    变量名，但本模块不做链式解析，`parseColor` 对非色值会抛 → catch → 走兜底。
 * 3. **`PI_THEME_VARS=off` 关掉整条读取**。皮肤与扩展是两份独立拷贝（`~/.pi/agent/` 与仓库
 *    快照），极端情况下可能出现「新扩展 + 旧皮肤」，那时读到的 `vars` 会指向已被删掉的
 *    变量名。这不会崩（有兜底），但需要一个一键退回 pi 原生兜底的开关。
 */

import fs from "node:fs";

/** 扩展自用色的注入面：真实现来自 `@earendil-works/pi-tui`（与 pi 内部同一对函数）。 */
export interface ColorOps {
	parseColor(value: string | number): unknown;
	/** 与 `Theme` 构造里给前景 token 生成转义用的同一条函数。 */
	fgAnsi(color: unknown, mode: string): string;
	/** 同上，背景侧。 */
	bgAnsi(color: unknown, mode: string): string;
}

/**
 * 从 `@earendil-works/pi-tui` 的**命名空间对象**里组一份 ops；三个函数缺任何一个就返回 undefined。
 *
 * 为什么不在扩展里直接 `import { parseColor } from "@earendil-works/pi-tui"`：ESM 的**静态命名
 * 导入在链接期就被检查**，缺失的导出会让**整个扩展加载失败**（不是这个特性失效、是 bash 工具
 * 的渲染器一起没了）。这几个函数是较新的 pi-tui 才导出的（本机 `~/.pi/agent/npm` 那份 pi 0.87.1
 * 的副本就没有它们，同目录的 `animation-frames.ts` 记录过同类坑），而扩展拷贝可能与不同版本的
 * pi 共存。命名空间导入 + 运行期判定则只会让这个特性退回 pi 原生兜底。
 */
export function colorOpsFrom(tui: unknown): ColorOps | undefined {
	const candidate = tui as Partial<{
		parseColor: ColorOps["parseColor"];
		foregroundAnsi: ColorOps["fgAnsi"];
		backgroundAnsi: ColorOps["bgAnsi"];
	}> | null | undefined;
	const parseColor = candidate?.parseColor;
	const fgAnsi = candidate?.foregroundAnsi;
	const bgAnsi = candidate?.backgroundAnsi;
	if (typeof parseColor !== "function" || typeof fgAnsi !== "function" || typeof bgAnsi !== "function") return undefined;
	return { parseColor, fgAnsi, bgAnsi };
}

/** `vars` 里的名字：`bashOutput` / `toolDiffAddedBg` / `toolDiffRemovedBg`。 */
export type ExtraColorName = string;

/** `fg` = 前景（`\x1b[38;…m`），`bg` = 背景（`\x1b[48;…m`）。 */
export type ExtraColorSlot = "fg" | "bg";

interface ParsedSkin {
	mtimeMs: number;
	vars: Record<string, unknown>;
}

/** 皮肤文件解析缓存（按路径 + mtime）。路径数量是个位数，不需要淘汰策略。 */
const skinCache = new Map<string, ParsedSkin>();
/** 已解析的转义缓存：主题对象 → (名字:槽位 → 转义)。主题被换掉时自然失效。 */
const ansiCache = new WeakMap<object, Map<string, string>>();

/** 纯函数：读 `vars[name]`，按槽位转成 ANSI；拿不到（没这个变量 / 不是色值 / 文件读不了 / 没 ops）返回 undefined。 */
export function skinVarAnsi(
	skinJson: unknown,
	name: ExtraColorName,
	slot: ExtraColorSlot,
	mode: string,
	ops: ColorOps | undefined,
): string | undefined {
	if (ops === undefined) return undefined;
	const vars = (skinJson as { vars?: unknown } | null | undefined)?.vars;
	if (vars === null || typeof vars !== "object") return undefined;
	const value = (vars as Record<string, unknown>)[name];
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	try {
		const color = ops.parseColor(value);
		return slot === "bg" ? ops.bgAnsi(color, mode) : ops.fgAnsi(color, mode);
	} catch {
		return undefined;
	}
}

/** 读皮肤文件（带 mtime 缓存）。读不了 / 不是 JSON 都返回 undefined。 */
function readSkin(sourcePath: string): unknown | undefined {
	try {
		const stat = fs.statSync(sourcePath);
		const cached = skinCache.get(sourcePath);
		if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) return { vars: cached.vars };
		const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as { vars?: Record<string, unknown> };
		const vars = parsed?.vars !== null && typeof parsed?.vars === "object" ? (parsed.vars as Record<string, unknown>) : {};
		skinCache.set(sourcePath, { mtimeMs: stat.mtimeMs, vars });
		return { vars };
	} catch {
		return undefined;
	}
}

/** 主题对象上可用的最小字段（结构化，避免 import pi 的类型）。 */
interface ThemeLike {
	sourcePath?: string;
	getColorMode?: () => string;
}

/**
 * 取扩展自用色：`theme` 当前皮肤文件的 `vars[name]` → ANSI 转义；拿不到返回 undefined。
 *
 * 结果按主题对象缓存（渲染路径上每次调都会走到这里），所以文件只读一次、转义只算一次。
 */
export function themeVarAnsi(
	theme: ThemeLike | undefined,
	name: ExtraColorName,
	slot: ExtraColorSlot,
	ops: ColorOps | undefined,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (ops === undefined) return undefined;
	if ((env.PI_THEME_VARS ?? "").trim().toLowerCase() === "off") return undefined;
	const key = `${name}:${slot}`;
	if (theme !== null && typeof theme === "object") {
		const cached = ansiCache.get(theme as object)?.get(key);
		if (cached !== undefined) return cached;
	}
	const sourcePath = typeof theme?.sourcePath === "string" ? theme.sourcePath : undefined;
	if (sourcePath === undefined || sourcePath === "") return undefined;
	const skin = readSkin(sourcePath);
	if (skin === undefined) return undefined;
	const mode = typeof theme?.getColorMode === "function" ? theme.getColorMode() : "truecolor";
	const ansi = skinVarAnsi(skin, name, slot, mode, ops);
	if (ansi !== undefined && theme !== null && typeof theme === "object") {
		let perTheme = ansiCache.get(theme as object);
		if (perTheme === undefined) {
			perTheme = new Map<string, string>();
			ansiCache.set(theme as object, perTheme);
		}
		perTheme.set(key, ansi);
	}
	return ansi;
}

/** 清掉文件缓存（测试用；扩展运行期不需要）。 */
export function resetSkinCacheForTesting(): void {
	skinCache.clear();
}
