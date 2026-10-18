/**
 * Thinking Window Extension（文件名沿用 thinking-collapse.ts）
 *
 * 把 assistant 的 thinking 块渲染成**一条连续横向滚动的行**，避免大段推理刷屏。
 * 纯显示层：session / 模型上下文里的原文完全不变。
 *
 * 形状永远是：
 *
 *     Think: …最新写下的 token 一直追加在行尾
 *
 * 设计意图是「一条不间断的 token 流」：
 *   - **不分段、不换行**：thinking 里所有换行（模型自己折的行、空行分段、列表项、代码围栏内）
 *     全部拼进这同一条行 —— 上一段结束后，下一段直接接续在上一段的结尾，**不另起一行**。
 *     于是 Think 区域从头到尾只有一行在滚动，不会看到「换行重新起头」的动作。
 *   - **段落接缝（原文空行处）中文 ↔ 中文补一个逗号**，免得两段无缝粘连读起来像一句话
 *     （`第一段，第二段`）；上一段末尾本来就有标点时不重复补，英文 / 中英混排仍按空格规则。
 *     段内折行（没有空行）不补逗号 —— 否则模型自己折的每一行都会多一个。
 *   - 整行超出终端宽度时从**头部**丢掉溢出字符、行首补一个 `…`，行尾永远是最新写下的 token；
 *     放得下就全量显示，不补 `…`。
 *   - 行首带 `Think: ` 标签（顶格，无竖线 gutter），始终钉在这一行最前面。
 *
 * 这里**没有**「短段回填补满整行」的逻辑：曾经有过（最后一段太短时把被顶出去的开头拉回来
 * 拼满行，还配过 `isStreaming` 闸门只在定型后补），但它会不断改变整行构成、打断「token 持续
 * 流动」的观感，已整体移除。现在短 thinking 就是短，行尾留白，不补。
 *
 * 标签用 `\x1b[23m` 关掉斜体再 `\x1b[3m` 打开，于是标签是正常字形、正文仍是 pi 给 thinking
 * 块的斜体 + thinkingText 颜色（终端不支持 ANSI 时不夹这对控制码）。
 *
 * 刻意**不再**输出 `… (123 tokens hidden)` 提示行：底部 spinner 已经在数 token 了。
 *
 * ## 硬性不折行（本扩展的核心约束）
 *
 * 本扩展输出的行必须**恰好一行**，绝不允许被 pi 二次折行 —— thinking 内容不会被仔细阅读，
 * 格式整洁比内容完整更重要，所以宁可截掉字符（补 `…`）也不折行。全行拼接、头部截断、
 * 反引号配对、**marked 转义钩子**（防 email / 未配对 `](` 规则吃掉我们插入的颜色转义 ——
 * 那是用户 2026-10-12 报的折行真因，与彩虹开关无关）、出口兜底截断的全部实现与理由
 * 都在 `./thinking-collapse/window.ts`
 * （那个模块**不 import pi / pi-tui**，宽度函数注入，因此 `node --test` 能直接跑它；彩虹着色的
 * `./thinking-collapse/rainbow.ts` 同一套约定，颜色转义与环境色都靠注入）。
 *
 * 行宽度量用 pi-tui 的 `visibleWidth`（和 pi 自己的渲染器同一套实现），所以本扩展预裁出来的
 * 行在 pi 那边不会再被二次折行。
 *
 * **只有一个状态，且归用户**：`/rainbow on|off` 开关「流式过程中给 thinking 单词上彩虹色」
 * （默开，状态落盘在 `~/.pi/agent/rainbow.json`）。窗口本身没有第二种形态、没有需要调的
 * 参数 —— 曾经有过 `/thinking-collapse off | on | <n>`，已移除。
 *
 * ## `/rainbow`：只在滚动时炫彩，定型即回灰
 *
 * 着色是**纯显示层**：会话 / 模型上下文里的原文一个字不改，改的只是这一行出口文本的颜色转义。
 *
 *   - **只在 thinking 块自己的流式期间着色**。分界线是流式事件里的 `thinking_end`（上游
 *     Anthropic 协议的 `content_block_stop`），不是整条消息的 `message_end` —— 后者会把
 *     回答正文、工具调用全算进去，于是 thinking 早早写完了那一行还亮着彩虹（用户
 *     2026-10-10 报的正是这个）。所以本扩展自己监听 `message_update` 维护一个
 *     `thinkingStreaming` 标志，**不用** `context.isStreaming`（那是整条消息的粒度）。
 *   - **只在窗口内着色**，`Think: ` 标签、`…` 省略号、代码 span 全部保持原色：代码 span 是
 *     「原本就带颜色的关键字」，要保留它自己的 `mdCode` 色（判定见 `rainbow.ts` 头部）。
 *   - 颜色跟着**词**走，不跟着屏幕位置走：色相按单位在整行里的绝对序号算，头部截断把字挤出视口
 *     时，同一批字的颜色不变（否则每来一个 token 整行都会闪一次色的变化）。
 *   - 色板用 pi-tui 的 okhsl 生成（深/浅底色两档亮度），转义走 `foregroundAnsi`，所以
 *     truecolor 与 256 色终端都对得上。
 *   - `PI_RAINBOW=off` 关掉整个扩展的着色面（不注册 `/rainbow`，也不着色）。
 *
 * 主题是**每次渲染现取**的（`ctx.ui.theme` 是读 `globalThis` 的代理，换皮肤立刻生效）——
 * 环境色 `thinkingText` 也要跟着皮肤走：pi 是每个文本 token 只套一次前景色，我们插进去的
 * 颜色会一直生效到下一次设色，所以离开着色区时要补发一次环境色把颜色交还回去
 * （细节见 `rainbow.ts` 头部「怎么和环境色共存」）。
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, okhslColor, visibleWidth } from "@earendil-works/pi-tui";

import {
	HUE_STEP_DEG,
	OKHSL_TUNING,
	RAINBOW_CONFIG_FILENAME,
	type RainbowPaint,
	loadRainbowConfig,
	paintRainbow,
	rainbowConfigPath,
	saveRainbowConfig,
	splitRainbowUnits,
} from "./thinking-collapse/rainbow.ts";
import { buildThinkingWindow, findCodeSpans, type ColorizeFn } from "./thinking-collapse/window.ts";

/** 色相循环长度：`HUE_STEP_DEG` 走满 360° 需要几个单位。同一个余数的单位颜色相同。 */
const HUE_CYCLE = Math.round(360 / HUE_STEP_DEG);

/** 终端明显不支持 ANSI 时不要夹控制码，否则会把 `\x1b[23m` 当字面字符画出来。 */
function ansiCapable(): boolean {
	return process.env.TERM !== "dumb" && !process.env.NO_COLOR;
}

export default function (pi: ExtensionAPI) {
	// `PI_RAINBOW=off`：连 `/rainbow` 一起不注册（与 `PI_LOGO=off` / `PI_VOICE=off` 同一个约定）。
	const disabledByEnv = process.env.PI_RAINBOW === "off";

	let configFile = rainbowConfigPath();
	let enabled = disabledByEnv ? false : loadRainbowConfig(configFile).enabled;

	/**
	 * 最近一次拿到的 ctx。transform 回调只给 markdown 与宽度，没有 ctx，而主题要从
	 * `ctx.ui.theme` 取 —— 于是这里借着 session_start / turn_start 把它记下来。
	 * `ui.theme` 读的是 `globalThis` 上的当前皮肤（不是快照），所以记下的 ctx 不会把皮肤
	 * 钉在会话开始那一刻：换肤后下一次渲染就用新色。
	 */
	let latestCtx: ExtensionContext | undefined;

	/**
	 * 当前这一轮 thinking 是否**仍在流式输出**。
	 *
	 * 为什么不用 `context.isStreaming`：那个标志属于**整条 assistant 消息**，要到
	 * `message_end`（回答正文、工具调用全部写完）才翻假 —— 于是 thinking 早早写完了，
	 * 那一行还一直亮着彩虹，要等整轮结束才变灰（用户 2026-10-10 报的正是这个）。
	 * thinking 自己的边界在流式事件里：`thinking_end`（上游 Anthropic 协议的
	 * `content_block_stop`，本机网关实测会在正文/工具调用之前发）。
	 *
	 * 事件顺序上这个标志天然来得及：`agent-session.js` 先 `await _emitExtensionEvent(...)`
	 * 再 `_emit(...)` 通知 UI，所以本处理器总是在 pi 重渲染（每个 message_update 都调
	 * `updateContent` + `requestRender`）**之前**把它改好，那一帧就不会再着色。
	 *
	 * 只用一个布尔量：同一消息里“thinking → 正文 → 又 thinking”（交错思考）时，先写完的那个
	 * 块在第二个块流式期间会被重新着色。要精确到块得拿 markdown 文本去和 contentIndex 对，
	 * 一旦对不上就是**完全不着色**（比这个边缘情形差得多），所以不做。
	 */
	let thinkingStreaming = false;

	if (!disabledByEnv) {
		pi.on("session_start", async (_event, ctx) => {
			latestCtx = ctx;
			// 每开一个新会话重读一次配置：外面手改了 rainbow.json 不必重启 pi。
			configFile = rainbowConfigPath();
			enabled = loadRainbowConfig(configFile).enabled;
		});
		pi.on("turn_start", async (_event, ctx) => {
			latestCtx = ctx;
		});

		// thinking 块的起止（着色只活在两者之间）。
		pi.on("message_start", async (event) => {
			if (event.message.role === "assistant") thinkingStreaming = false;
		});
		pi.on("message_end", async () => {
			thinkingStreaming = false;
		});
		pi.on("message_update", async (event) => {
			switch (event.assistantMessageEvent?.type) {
				case "thinking_start":
				case "thinking_delta":
					thinkingStreaming = true;
					break;
				// thinking_end 是正常收尾；text_* / toolcall_* 是兼底 —— 个别后端不发 thinking_end
				// （pi 自带的 pi-messages provider 实测一个都没有），不能让彩虹一直亮着。
				case "thinking_end":
				case "text_start":
				case "text_delta":
				case "toolcall_start":
				case "toolcall_delta":
					thinkingStreaming = false;
					break;
			}
		});

		pi.registerCommand("rainbow", {
			description: "Rainbow coloring for streaming thinking text (on | off)",
			handler: async (args, ctx) => {
				const arg = args.trim().toLowerCase();
				if (arg === "on" || arg === "off") {
					const next = arg === "on";
					try {
						saveRainbowConfig(configFile, { enabled: next });
					} catch (err) {
						ctx.ui.notify(`彩虹开关没能落盘（${err instanceof Error ? err.message : String(err)}），本次仍然生效`, "warning");
					}
					enabled = next;
					ctx.ui.notify(next ? "彩虹特效：开（流式 thinking 着色）" : "彩虹特效：关", "info");
					return;
				}
				if (arg !== "" && arg !== "status") {
					ctx.ui.notify(`用法：/rainbow on | off（当前：${enabled ? "on" : "off"}）`, "warning");
					return;
				}
				ctx.ui.notify(
					`彩虹特效：${enabled ? "开" : "关"}（${RAINBOW_CONFIG_FILENAME}: ${configFile}）`,
					"info",
				);
			},
		});
	}

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant-thinking") return markdown;
		const useAnsi = ansiCapable();
		// 只在 thinking **还在流式输出**时着色：写完就回灰（`thinking_end`），不等整条消息结束。
		// `context.isStreaming` 作为第二道兼底：它假说明整条消息已定型，那一定不该着色。
		const colorize =
			enabled && thinkingStreaming && context.isStreaming && useAnsi ? makeColorize(latestCtx) : undefined;
		return buildThinkingWindow(markdown, context.availableWidth, visibleWidth, useAnsi, colorize);
	});
}

/**
 * 按当前皮肤拼出着色函数；拿不到主题（非 TUI / 皮肤未初始化）就返回 undefined —— 这一帧
 * 不着色，而不是抛给宿主把整个 thinking 块弄没。
 */
function makeColorize(ctx: ExtensionContext | undefined): ColorizeFn | undefined {
	let theme: Theme;
	try {
		theme = (ctx?.ui as { theme?: Theme } | undefined)?.theme as Theme;
		if (!theme || typeof theme.getFgAnsi !== "function") return undefined;
	} catch {
		return undefined;
	}

	let paint: RainbowPaint;
	try {
		paint = buildPaint(theme);
	} catch {
		return undefined;
	}

	return (line, from, to, dropped) => {
		try {
			const units = splitRainbowUnits(line);
			if (units.length === 0) {
				let out = "";
				for (let i = from; i < to; i++) {
					if (!dropped.includes(i)) out += line[i];
				}
				return out;
			}
			return paintRainbow(line, units, from, to, paint, findCodeSpans(line), dropped);
		} catch {
			// 渲染路径上的异常一律吞掉：退回不带颜色的窗口文本（宽度口径不变）。
			let out = "";
			for (let i = from; i < to; i++) {
				if (!dropped.includes(i)) out += line[i];
			}
			return out;
		}
	};
}

/**
 * 由皮肤造出 `RainbowPaint`。
 *
 *   - **色彩模式**走 `theme.getColorMode()`（与 `theme.fg` 同一条），256 色终端上由
 *     `foregroundAnsi` 做索引近似；
 *   - **明暗**走 `theme.appearance`：深浅底色用 `OKHSL_TUNING` 的两档饱和度/亮度，
 *     浅底上用深色档，否则浅黄白一片看不清；
 *   - **环境色**是 `thinkingText` 的前景色转义，与 pi 自己套在 thinking 文本上的那一串
 *     完全同一个来源，所以补发之后回到的正是「原来的灰色」；
 *   - 色相只与 `index % HUE_CYCLE` 有关，所以缓存长度就是一圈的档数（长 thinking 不会
 *     反复重算颜色）。
 */
function buildPaint(theme: Theme): RainbowPaint {
	const mode = typeof theme.getColorMode === "function" ? theme.getColorMode() : "truecolor";
	const tuning = OKHSL_TUNING[theme.appearance === "light" ? "light" : "dark"];
	const ambient = theme.getFgAnsi("thinkingText");
	const cache = new Map<number, string>();
	return {
		ambient,
		fg(index: number): string {
			const slot = ((index % HUE_CYCLE) + HUE_CYCLE) % HUE_CYCLE;
			const cached = cache.get(slot);
			if (cached !== undefined) return cached;
			const ansi = foregroundAnsi(okhslColor(slot * HUE_STEP_DEG, tuning.saturation, tuning.lightness), mode);
			cache.set(slot, ansi);
			return ansi;
		},
	};
}
