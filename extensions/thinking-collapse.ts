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
 *   - 行尾**不顶格**：可见宽度比终端少 3 列（`window.ts` 的 `RIGHT_INSET`，用户 2026-10-27 定：
 *     顶格不好看，要离右边框约 3 个英文字符）。窄到扣完这 3 列就装不下「标签 + `…` + 1 列正文」时不扣。
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
 * 反引号配对、**marked 转义钩子**（防 email / 未配对 `](` 规则吃掉我们自己插入的 ANSI 转义 ——
 * 那是用户 2026-10-12 报的折行真因）、出口兜底截断的全部实现与理由
 * 都在 `./thinking-collapse/window.ts`
 * （那个模块**不 import pi / pi-tui**，宽度函数注入，因此 `node --test` 能直接跑它）。
 *
 * 行宽度量用 pi-tui 的 `visibleWidth`（和 pi 自己的渲染器同一套实现），所以本扩展预裁出来的
 * 行在 pi 那边不会再被二次折行。
 *
 * 窗口本身没有可调的参数 —— 曾经有过 `/thinking-collapse off | on | <n>` 与给 thinking
 * 上彩虹色的 `/rainbow`，都已移除。
 *
 * ## `/think-tail`：滚动结束后留不留残影
 *
 * 默认（off）**不留残影** —— thinking 块一定型就换成一行摘要：
 *
 *     Thought for 23s (234 tokens)
 *
 * `/think-tail on` 之后才把最后那截推理**留在** `Think: ` 后面当残影（滚动过程两边一样）。
 *
 * 仍然是斜体（pi 给 thinking 块的默认样式本来就带 italic）、仍然恰好一行（超窄终端从尾部截断补
 * `…`）。秒数**只算 Think 段**（`thinking_start` → `thinking_end` 的实测值，用户 2026-10-26 选的
 * 口径），token 由 thinking 原文现算；细节、段键与已接受的边缘情形都在 `./thinking-collapse/thought.ts`
 * 头部。这里只负责三件接线的事：
 *
 *   1. **段计时**：`thinking_start` / 首个 `thinking_delta` 起表，`thinking_end` 收表（不发
 *      `thinking_end` 的后端用正文 / 工具增量为界，与摘要切换的分界线同一套判断）。
 *   2. **段键 → 秒数**表：live 收表时写入实测值；`message_end` 给同一条消息里没测到的段补
 *      `durationMs`；（同一消息里连续的 thinking 块会被渲染器拼成一个 markdown，所以还要按组
 *      登记一条求和键）。
 *   3. **恢复会话**：`session_start` 扫一遍 `ctx.sessionManager.getEntries()`，用每条 assistant
 *      消息的 `durationMs` 预填 —— 会话文件里没有更细的时间戳，历史 thinking 只能拿到整条响应的
 *      时长（比 Think 段略长），这是恢复路径唯一能拿到的数。
 *
 * 查不到秒数时**绝不显示摘要**（宁可保持残影形态，也不自造一个数字）。
 *
 * `PI_THINK_TAIL=off` 只改初始值（与出厂默认一致；`/think-tail` 仍注册，用户可以自己开回来）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
	THINK_TAIL_CONFIG_FILENAME,
	buildThoughtSummary,
	loadThinkTailConfig,
	saveThinkTailConfig,
	thinkTailConfigPath,
	thoughtRunKey,
} from "./thinking-collapse/thought.ts";
import { buildThinkingWindow } from "./thinking-collapse/window.ts";

/** 终端明显不支持 ANSI 时不要夹控制码，否则会把 `\x1b[23m` 当字面字符画出来。 */
function ansiCapable(): boolean {
	return process.env.TERM !== "dumb" && !process.env.NO_COLOR;
}

/**
 * 「段键 → 实测毫秒」表的上限。一个会话可以跑几百条消息，每条消息一两段 thinking —— 不封顶
 * 就是一条永远不会收缩的内存。超了丢最老的（Map 保持插入顺序），丢掉的段下一次渲染退回残影形态，
 * 代价只是「很久以前那一段不再显示摘要」。
 */
const RUN_DURATION_LIMIT = 400;

export default function (pi: ExtensionAPI) {
	/**
	 * `/think-tail` 的状态：`false`（默认）= 不留残影，只显示一行 `Thought for 23s (234 tokens)`；
	 * `true` = 滚动结束后把最后那截留在 `Think: ` 后面当残影（`/think-tail on` 写盘后才是这样）。
	 *
	 * `PI_THINK_TAIL=off` 只改初始值（命令仍注册，用户可以自己开回来）。
	 */
	let thinkTailFile = thinkTailConfigPath();
	let thinkTail = process.env.PI_THINK_TAIL === "off" ? false : loadThinkTailConfig(thinkTailFile).enabled;

	/**
	 * 当前这一轮 thinking 是否**仍在流式输出**。
	 *
	 * 为什么不用 `context.isStreaming`：那个标志属于**整条 assistant 消息**，要到
	 * `message_end`（回答正文、工具调用全部写完）才翻假 —— 于是 thinking 早早写完了，
	 * 摘要还要等整轮结束才换上来。thinking 自己的边界在流式事件里：`thinking_end`（上游
	 * Anthropic 协议的 `content_block_stop`，本机网关实测会在正文/工具调用之前发）。
	 *
	 * 事件顺序上这个标志天然来得及：`agent-session.js` 先 `await _emitExtensionEvent(...)`
	 * 再 `_emit(...)` 通知 UI，所以本处理器总是在 pi 重渲染（每个 message_update 都调
	 * `updateContent` + `requestRender`）**之前**把它改好，那一帧就已经是摘要形态。
	 *
	 * 只用一个布尔量：同一消息里“thinking → 正文 → 又 thinking”（交错思考）时，先写完的那个
	 * 块在第二个块流式期间会被当成“仍在流式”。要精确到块得拿 markdown 文本去和 contentIndex 对，
	 * 一旦对不上就是**整段都不换摘要**（比这个边缘情形差得多），所以不做。
	 */
	let thinkingStreaming = false;

	/**
	 * 当前 thinking 段里已经写下的原文（按 contentIndex 分槽）。`thinking_end` 与
	 * `message_end` 都从这里截段文本算段键 —— 与渲染器拿到的 markdown 同一口径（见 `thoughtRunKey`）。
	 *
	 * 用 Map 而不是单个字符串：交错思考同一条消息里会有多个块，收表时得知道是哪一段。
	 */
	const runTexts = new Map<number, string>();
	/** 当前消息里各 thinking 段的表起时刻（毫秒）；`thinking_end` 收表后删掉。 */
	const runStartedAt = new Map<number, number>();
	/**
	 * 当前消息里**已经收表**的段（contentIndex → 毫秒）。`message_end` 靠它给没测到的段补齐、
	 * 并算出「同一消息里连续 thinking 块」的求和键。
	 */
	const runDurations = new Map<number, number>();
	/**
	 * 全局的「段键 → 实测毫秒」表。渲染器只能按内容查（context 里没有消息身份、没有
	 * contentIndex），所以键就是归一后的文本哈希，详见 `thoughtRunKey`。
	 *
	 * 登记的口径只有一种：**渲染器会看到的那一条 markdown**。live 是 `message_end` 时按
	 * 「连续 thinking 块」分组求和；恢复会话是 `hydrateRunDurations` 里同一分组套 `durationMs`。
	 */
	const runDurationsByKey = new Map<string, number>();

	/** 记一条实测（带容量上限：超了丢最老的，Map 保持插入顺序）。 */
	function rememberRun(key: string, ms: number): void {
		runDurationsByKey.delete(key);
		runDurationsByKey.set(key, ms);
		while (runDurationsByKey.size > RUN_DURATION_LIMIT) {
			const oldest = runDurationsByKey.keys().next();
			if (oldest.done) break;
			runDurationsByKey.delete(oldest.value);
		}
	}

	/** 清掉「当前消息」那一层状态（新消息开始 / 消息结束都得清）。 */
	function resetMessageRuns(): void {
		runTexts.clear();
		runStartedAt.clear();
		runDurations.clear();
	}

	/**
	 * 收一段的表：把实测毫秒记进全局表。
	 *
	 * 时钟异常（起点丢了 / 倒挂）时不记：宁可这一段保持残影形态，也不要写一个 0s 进去 ——
	 * 0s 会在屏幕上与真实秒数一样可信。
	 */
	function finishRun(contentIndex: number, now: number): void {
		const startedAt = runStartedAt.get(contentIndex);
		const text = runTexts.get(contentIndex);
		runStartedAt.delete(contentIndex);
		if (startedAt === undefined || text === undefined) return;
		const elapsed = now - startedAt;
		if (!(elapsed >= 0)) return;
		runDurations.set(contentIndex, elapsed);
		rememberRun(thoughtRunKey(text), elapsed);
	}

	/** 逐 delta 累加当前段的原文（`thinking_end` 若给了完整文本，会整段覆盖）。 */
	function appendRunText(contentIndex: number, delta: unknown): void {
		if (typeof delta !== "string" || delta === "") return;
		runTexts.set(contentIndex, (runTexts.get(contentIndex) ?? "") + delta);
	}

	/**
	 * 恢复会话 / 新会话：用每条 assistant 消息的 `durationMs` 预填历史 thinking 的秒数。
	 *
	 * 会话文件里没有 thinking 段的独立时间戳，`durationMs` 是整条响应的时长（比 Think 段略长）
	 * —— 这是恢复路径唯一能拿到的数。登记口径与 live 那一路的 `message_end` 完全一致：
	 * 每组**连续非空** thinking 块拼成一条 markdown（渲染器就这么拼），组键 → `durationMs`。
	 */
	function hydrateRunDurations(ctx: ExtensionContext): void {
		try {
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "message") continue;
				const message = entry.message;
				if (!message || message.role !== "assistant") continue;
				const durationMs = (message as { durationMs?: unknown }).durationMs;
				if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) continue;
				for (const group of thinkingGroups(message.content ?? [])) {
					const joined = group
						.map((item) => item.text)
						.filter((text) => text !== "")
						.join("\n\n");
					if (joined !== "") rememberRun(thoughtRunKey(joined), durationMs);
				}
			}
		} catch {
			// 会话管理不可用 / 条目形状不对：不预填就是了，live 那一路照旧
		}
	}

	/**
	 * 把消息内容切成「连续 thinking 块」的组 —— 渲染器就是这个口径（`assistant-message.js`
	 * 只把相邻的 thinking 块拼成一条 markdown，遇到正文/工具调用就断开）。
	 * `contentIndex` 是块在**整条消息**里的下标，所以组内不能用数组下标去查段时长。
	 */
	function thinkingGroups(
		content: readonly { type?: string; thinking?: string }[],
	): Array<Array<{ contentIndex: number; text: string }>> {
		const groups: Array<Array<{ contentIndex: number; text: string }>> = [];
		let current: Array<{ contentIndex: number; text: string }> = [];
		for (let index = 0; index < content.length; index++) {
			const block = content[index];
			if (block && block.type === "thinking") {
				const text = typeof block.thinking === "string" ? block.thinking.trim() : "";
				current.push({ contentIndex: index, text });
				continue;
			}
			if (current.length > 0) groups.push(current);
			current = [];
		}
		if (current.length > 0) groups.push(current);
		return groups;
	}

	pi.on("session_start", async (_event, ctx) => {
		// `PI_THINK_TAIL=off` 是初始值（与出厂默认一致，写盘值优先 —— 命令永远能自己开回来）。
		thinkTailFile = thinkTailConfigPath();
		thinkTail = process.env.PI_THINK_TAIL === "off" ? false : loadThinkTailConfig(thinkTailFile).enabled;
		resetMessageRuns();
		hydrateRunDurations(ctx);
	});

	// thinking 块的起止（段计时与摘要都在同一条边界上）。
	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant") {
			thinkingStreaming = false;
			resetMessageRuns();
		}
	});

	// 一条消息结束：给同一条消息里没测到 `thinking_end` 的段补 `durationMs`，再把「连续块」
	// 拼成一条 markdown 的组登记秒数（渲染器就是这么把它们拼起来的）。
	pi.on("message_end", async (event) => {
		thinkingStreaming = false;
		const message = event.message.role === "assistant" ? event.message : undefined;
		const durationMs = (message as { durationMs?: unknown } | undefined)?.durationMs;
		const fallback = typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined;

		if (fallback !== undefined) {
			for (const [contentIndex, text] of runTexts) {
				if (!runDurations.has(contentIndex) && text.trim() !== "") {
					runDurations.set(contentIndex, fallback);
					rememberRun(thoughtRunKey(text), fallback);
				}
			}
		}

		// 连续 thinking 块：渲染器把它们按 `trim()` + '\n\n' 拼成一条 markdown，原样重放一遍求键。
		// 组的**段时长之和**才是这一条 markdown 对应的思考耗时；缺任何一段就整组不登记
		// （宁可将这一组退回残影形态，也不拿残缺的和去冒充）。
		for (const group of thinkingGroups(message?.content ?? [])) {
			const timed = group.filter((item) => item.text !== "");
			if (timed.length === 0) continue;
			if (!timed.every((item) => runDurations.has(item.contentIndex))) continue;
			let total = 0;
			for (const item of timed) total += runDurations.get(item.contentIndex) ?? 0;
			rememberRun(
				thoughtRunKey(
					timed
						.map((item) => item.text)
						.join("\n\n"),
				),
				total,
			);
		}

		resetMessageRuns();
	});
	pi.on("message_update", async (event) => {
		const streamEvent = event.assistantMessageEvent;
		const contentIndex = typeof streamEvent?.contentIndex === "number" ? streamEvent.contentIndex : 0;
		switch (streamEvent?.type) {
			case "thinking_start":
			case "thinking_delta":
				thinkingStreaming = true;
				// 段计时：起点只认**第一次**看到这个 contentIndex 的时刻（`thinking_start` 优先，
				// 不发 start 的后端退到第一个 delta）。
				if (!runStartedAt.has(contentIndex)) runStartedAt.set(contentIndex, Date.now());
				if (streamEvent.type === "thinking_delta") appendRunText(contentIndex, streamEvent.delta);
				break;
			// thinking_end 是正常收尾；text_* / toolcall_* 是兼底 —— 个别后端不发 thinking_end
			// （pi 自带的 pi-messages provider 实测一个都没有），不能让摘要一直等下去，
			// 也不能让段的表一直开着。
			case "thinking_end":
				thinkingStreaming = false;
				if (typeof streamEvent.content === "string" && streamEvent.content.trim() !== "") {
					runTexts.set(contentIndex, streamEvent.content);
				}
				finishRun(contentIndex, Date.now());
				break;
			case "text_start":
			case "text_delta":
			case "toolcall_start":
			case "toolcall_delta":
				thinkingStreaming = false;
				// 兼底收表：只收**已经开表但还没收**的那些段，`message_end` 还给没收的补 durationMs。
				for (const index of [...runStartedAt.keys()]) finishRun(index, Date.now());
				break;
		}
	});

	// `/think-tail on|off`：用户自己的显示开关。
	pi.registerCommand("think-tail", {
		description: "Keep the tail of the rolling thinking line after it settles (on | off)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				const next = arg === "on";
				try {
					saveThinkTailConfig(thinkTailFile, { enabled: next });
				} catch (err) {
					ctx.ui.notify(
						`Could not persist the think-tail toggle (${err instanceof Error ? err.message : String(err)}); it still applies for this session`,
						"warning",
					);
				}
				thinkTail = next;
				ctx.ui.notify(
					next ? "Think tail: on (keeps the last stretch after scrolling settles)" : "Think tail: off (only shows Thought for Ns (N tokens))",
					"info",
				);
				return;
			}
			if (arg !== "" && arg !== "status") {
				ctx.ui.notify(`Usage: /think-tail on | off (currently: ${thinkTail ? "on" : "off"})`, "warning");
				return;
			}
			ctx.ui.notify(
				`Think tail: ${thinkTail ? "on" : "off"} (${THINK_TAIL_CONFIG_FILENAME}: ${thinkTailFile})`,
				"info",
			);
		},
	});

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant-thinking") return markdown;

		// 残影关 + thinking 已定型 + 查得到实测秒数 ⇒ 只留一行摘要。
		//
		// 两个条件缺一不可：
		//   - `!thinkingStreaming`：滚动期间仍然是那条滚动行（用户要的就是「滚动不变」）；
		//     这个标志在 `thinking_end` 就翻假，所以摘要**在 thinking 一结束就换上来**，不必等
		//     整条消息（正文还在流的时候就已经是摘要了 —— 用户 2026-10-26 选的口径）；
		//   - `runDurationsByKey` 命中：查不到秒数就**不自造数字**，退回残影形态。
		if (!thinkTail && !thinkingStreaming) {
			const elapsed = runDurationsByKey.get(thoughtRunKey(markdown));
			if (elapsed !== undefined) return buildThoughtSummary(markdown, elapsed, context.availableWidth, visibleWidth);
		}

		const useAnsi = ansiCapable();
		return buildThinkingWindow(markdown, context.availableWidth, visibleWidth, useAnsi);
	});
}
