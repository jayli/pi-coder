/**
 * codemode-tree — codemode 工具块的树形展示（接线）
 *
 * 把 pi 内置 `codemode` 工具块的观感改造成与 `bash-command-collapse.ts` / `read-path-collapse.ts`
 * 同一套：`• ` 开头、`│ ` 续段、`└ ` 只出现一次的树，**没有底色、没有上下边界空行**。
 * 形状与列位规则全在 `render.ts`（不 import pi，`node --test` 能直跑），本文件只做三件事：
 * 捕获内置工具定义、委托内置渲染器、把它们的行重排成树。
 *
 * ## 怎么拿到 codemode 的**执行逻辑**（不复制一份）
 *
 * `codemode` 是 pi 的**内置扩展**（`builtin:codemode`），不是内置工具 —— 没有
 * `createCodemodeToolDefinition()` 这种"只给定义"的导出口径（`createCodemodeExtension` 是唯一
 * 入口，它内部才调 `createCodemodeToolDefinition`）。所以这里用同一个工厂**捕获**它注册的定义：
 * 传一个只拦截 `registerTool` 的 Proxy，其余属性一律转发给真 `pi`（`getSettings` / `appendEntry` /
 * `getAllTools` 都是工厂闭包里用到的，且要在**调用时**读到实时值 —— 比如 `getMode()` 每轮读
 * `pi.getSettings().codemode.mode`）。用 Proxy 而不是手写 stub：pi 以后往工厂里加新的 `pi.*` 调用
 * 时不会因为漏转发而崩，也不会在加载期抛异常。
 *
 * 实测（真 CLI，2026-10-01）：捕获到的定义的 `parameters` 与 pi 自己那份**是同一个对象引用**
 * （`===` 成立）。这一点是必须的 —— MCP 扩展的 `isCodemodeTool()` 正是靠 schema 引用相等来认
 * "这是本包的 codemode"，据此决定要不要把 codemode 工具自动激活；换成自己写一份 schema 会让
 * 那个自动激活静默失效（只剩 `MCP tools are only reachable from the codemode or tool_search tool…`
 * 那条告警）。
 *
 * ## 内置在 settings 里被显式禁用（用户 2026-10-01 决定）
 *
 * `codemode` 是 pi 内置扩展里**声明了 `replaceable: true`** 的那一类（与 `tool-search` / `mcp` 同）：
 * 另一个扩展注册了同名工具时，pi 会把内置**整个不加载**，并在启动时打一条 warning
 *（`registers tool `codemode`, so built-in extension `codemode` was not loaded`）。这条 warning 是**预期的**，
 * 不是错误 —— 它就是在说“内置那份已经让位”。但 pi 启动时会把它渲染在**两处**（`[Extension issues]` 块
 * + `Warning: Extension package …` 行），且没有任何开关能关掉（`quietStartup` 只影响资源清单，不影响 diagnostics）。
 *
 * 用户决定在 settings.json 写 `extensions: ["-builtin:codemode"]`（2026-10-01），让内置直接不加载，
 * 两条提示从此消失（SDK 实测：warnings 清零、codemode 仍由本扩展提供）。代价：`PI_CODEMODE_TREE=off`
 * 的回退不再成立 —— off 时本扩展不注册、内置又被 settings 禁掉，codemode 工具会**整个消失**
 *（此前 off 意味着“内置顶上”）。想恢复内置观感得先把 settings 里那条删掉。
 *
 * ## 整块的壳：`renderShell: "self"` + 自绘左边距
 *
 * `renderShell: "self"` 让 pi 不再给整块套 `contentBox`（`Box(1, 1, bgFn)`），于是
 * ① **没有底色**（pending / 成功 / 失败三种底都不画；是"不去画"而不是"画上再擦"）、
 * ② **没有上下两条边界空行** —— 与 bash / read 块同一手法（见 README「两个块共用同一套壳」）。
 *
 * 代价得说清楚：pi 的默认壳正是用 `toolErrorBg`（红底）表达「这个工具失败了」的，底色去掉之后
 * 那一层信号就没了 —— 所以**圆点必须承担结局灯**：执行中白（`text`）/ 成功绿（`toolDiffAdded`，
 * 与 bash 同色）/ 失败红（`toolDiffRemoved`），外加正文里 `Script error:` 那几行的红字。
 *
 * 左边距（首行 `• `、其余行按 `render.ts` 的规则）全由本扩展自己画：self 模式下
 * `ToolExecutionComponent` 直接渲染 `selfRenderContainer`、**没有任何 padding**，所以两个渲染器
 * 拿到的都是整宽，得自己按 `contentWidth()` 扣回 4 列再交给子组件。
 *
 * ## 委托内置渲染器时必须传对的一处
 *
 * 两个内置渲染器都是 `const component = context.lastComponent ?? new Container(); component.clear();`
 * 的形态 —— `lastComponent` 必须是**它们自己上次返回的那个内层组件**。把我们的 wrapper（没有
 * `clear()` / `addChild()`）传进去会抛 `TypeError`，而 `updateDisplay()` 的 try/catch 会**静默退回**
 * 内置 fallback：看不出是渲染坏了，只是形状回到默认。所以内层组件存在 `context.state` 里跨次复用
 * （`read-path-collapse.ts` 踩过同一个坑）。
 *
 * `PI_CODEMODE_TREE=off` 关闭（注册期读一次，与 `PI_FENCELESS_CODE` / `PI_READ_COLLAPSE` 同一约定）：
 * 关闭时本扩展不注册 `codemode`。注意：settings 里已有 `-builtin:codemode`（见上），内置不会顶上，
 * codemode 工具会整个消失 —— 这个 env 现在只是“关掉”开关，不再是“恢复内置观感”开关。
 */

import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { contentWidth, shapeResultLines, stateDotSlot, withCallGutter } from "./render.ts";

/** 只拦截 `registerTool` 的 Proxy：其余 `pi.*` 一律转发给真 API（见文件头）。 */
function captureCodemodeDefinition(pi: ExtensionAPI): ToolDefinition<any, any, any> {
	let captured: ToolDefinition<any, any, any> | undefined;
	const capture = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (definition: ToolDefinition<any, any, any>) => {
					captured = definition;
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
	// 与 pi 内置加载它时一样的调用方式（不传 options = `models: true`、mode / inlineBudget 走设置）
	createCodemodeExtension()(capture);
	if (!captured) {
		throw new Error("codemode-tree: 没能从 createCodemodeExtension() 捕获到 codemode 工具定义");
	}
	return captured;
}

/** 把子组件渲染出来的行拼成一维数组（内置渲染器返回的是 `Container`）。 */
function childrenLines(component: any, width: number): string[] {
	const children: any[] | undefined = component?.children;
	if (!Array.isArray(children) || children.length === 0) {
		return typeof component?.render === "function" ? component.render(width) : [];
	}
	const lines: string[] = [];
	for (const child of children) {
		if (typeof child?.render === "function") lines.push(...child.render(width));
	}
	return lines;
}

/**
 * 按**宽度 + 形状键**缓存行数组：`render(width)` 每帧都调，两条路径都不便宜
 * （代码高亮 / 折行 / 预览组件）。键里必须带上「命令侧用哪套缩进」这个状态 ——
 * `updateDisplay()` 在一次调用里先渲染 renderCall、再渲染 renderResult，所以结果到达那一刻
 * 命令行的 `│ ` 与两格缩进会切一次，只按宽度缓存会把这半帧的形状钉死。
 */
function createCachedComponent(render: (width: number) => string[], cacheKey: () => string, invalidateInner?: () => void) {
	let cachedWidth: number | undefined;
	let cachedKey: string | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width: number): string[] {
			const key = cacheKey();
			if (cachedLines === undefined || cachedWidth !== width || cachedKey !== key) {
				cachedWidth = width;
				cachedKey = key;
				cachedLines = render(width);
			}
			return cachedLines;
		},
		invalidate() {
			cachedWidth = undefined;
			cachedKey = undefined;
			cachedLines = undefined;
			invalidateInner?.();
		},
	};
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_CODEMODE_TREE?.trim().toLowerCase() === "off") return;

	const base = captureCodemodeDefinition(pi);

	pi.registerTool({
		// 展开而不是逐字段抄：`execute` / `prepareLoadout`（工具描述靠它按 callable 工具实时生成）/
		// `description` / `parameters` / `promptSnippet` / `promptGuidelines` / `constrainedSampling` /
		// `exposure` / `defaultActive` 全部原样继承 —— prompt 元数据不会自动继承，必须显式带上。
		...base,
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state as { innerCall?: any; innerResult?: any };
			// 传给内置实现的 lastComponent 必须是**内层**组件（见文件头）
			const inner =
				base.renderCall?.(args, theme, { ...context, lastComponent: state.innerCall }) ??
				({ render: () => [], invalidate() {} } as any);
			state.innerCall = inner;
			return createCachedComponent(
				(width) => {
					// 圆点三态（用户 2026-10-01 定）：执行中白（`text`）/ 成功绿（`toolDiffAdded`，**与 bash
					// 成功圆点同色**）/ 失败红（`toolDiffRemoved`）。槽位选择在纯逻辑里（`stateDotSlot`）。
					const dot = theme.fg(stateDotSlot(context.isPartial === true, context.isError === true), "•");
					const pipe = theme.fg("muted", "│ ");
					// 「树接上了没有」看 `state.innerResult`：`updateDisplay()` 先跑 renderCall、再跑
					// renderResult，但两个组件真正 `render()` 是在之后的容器渲染里 —— 那时本帧的
					// innerResult 已经就位，所以命令侧与结果侧在**同一帧**切到 `│ `（没有半帧的错位，
					// 也不需要像 bash 那样在 renderResult 里提前置位）。
					const connected = state.innerResult !== undefined;
					return withCallGutter(inner.render(contentWidth(width)), dot, pipe, connected);
				},
				// 缓存键必须带上「哪个状态」：圆点的颜色与续行前缀都随状态变，只按宽度缓存会把上一帧
				// 的颜色 / 形状钉死。
				() => `${state.innerResult === undefined ? "loose" : "connected"}:${stateDotSlot(context.isPartial === true, context.isError === true)}`,
				() => inner.invalidate?.(),
			);
		},
		renderResult(result, options, theme, context) {
			const state = context.state as { innerResult?: any };
			const inner =
				base.renderResult?.(result, options, theme, { ...context, lastComponent: state.innerResult }) ??
				({ render: () => [], invalidate() {} } as any);
			state.innerResult = inner;
			return createCachedComponent(
				(width) => shapeResultLines(childrenLines(inner, contentWidth(width)), theme),
				() => "result",
				() => inner.invalidate?.(),
			);
		},
	});
}
