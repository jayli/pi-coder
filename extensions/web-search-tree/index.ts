/**
 * web-search-tree — pi-web-access 工具块的树形展示（接线）
 *
 * 把 `pi-web-access` 的三个块改造成与 `bash-command-collapse.ts` / `codemode-tree/` /
 * `read-path-collapse.ts` 同一套：`• ` 开头、`│ ` 续段、`└ ` 只出现一次的树，**没有底色、没有
 * 上下边界空行**（用户 2026-10-02 的三条诉求）。形状与列位规则全在 `render.ts`（不 import pi，
 * `node --test` 能直跑），本文件只做三件事：捕获包注册的工具定义、委托包自带渲染器、把它们的行
 * 重排成树。
 *
 * ## 接管哪些（用户 2026-10-02 定）
 *
 * | 工具 | 包自带渲染器 | 处理 |
 * | --- | --- | --- |
 * | `pi_web_search` | 有 | **接管**（首轮做的） |
 * | `fetch_content` | 有 | **接管** |
 * | `get_search_content` | 有 | **接管** |
 * | `source_check` | **无**（走 pi 通用 fallback） | 原样注册 |
 * | `web_enable` | **无** | 原样注册 |
 *
 * 只收自带渲染器的那三个：它们与我们一样是「委托包渲染器 + 重排行」，改动面小且风格能对齐；
 * `source_check` / `web_enable` 没有渲染器，接管等于**从零自绘**（颜色、截断、展开态都要自己定），
 * 那是另一件事，不混进来。
 *
 * ## 怎么拿到这几个工具的**执行逻辑**（不复制一份）
 *
 * `pi-web-access` 是个 pi 包（`npm:pi-web-access`）。它没有「只给定义」的导出口径 —— 默认导出
 * 就是那个 `ExtensionFactory`，工具定义在工厂闭包里，只能靠**捕获**。做法与 `codemode-tree/`
 * 完全相同：传一个只拦截 `registerTool` 的 Proxy，其余 `pi.*` 一律转发给真 `pi`。
 *
 * 用 Proxy 而不是手写 stub 有两个必须的理由：
 *   ① 工厂闭包里大量用到 `pi.*`（`getSettings` / `appendEntry` / `events` / `getAllTools` /
 *      `registerCommand` / `registerShortcut` / `on(...)`），漏转发一个就在**加载期**抛异常，
 *      而扩展加载失败是静默少这几个工具的；
 *   ② pi 以后往工厂里加新的 `pi.*` 调用时不会崩（Proxy 自动转发）。
 *
 * 实测（SDK，2026-10-02）：捕获到 5 个工具定义，`execute` / `parameters` / `description` /
 * `promptSnippet` 全部是包自己那份的**同一个对象引用** —— 所以路由、存储、curator、模型可见的
 * 描述文本全都没动，本扩展只换渲染器。
 *
 * ## 为什么要把包从「自动加载扩展」里摘掉（settings 里的一条过滤）
 *
 * 光在扩展里捕获 + 重新注册是不够的：包自己也会在 `~/.pi/agent/extensions/` **之前**加载并注册
 * 这 5 个工具，于是同名注册变成 **conflict**，pi 会在启动时把 `Tool "pi_web_search" conflicts
 * with …` 打进 `[Extension issues]`（5 个工具 = 5 条）。而 `renderShell` / `renderCall` 是
 * `ToolDefinition` 的字段，pi **没有**「事后替换某个已注册工具的渲染器」这种机制 —— 想接管就
 * 只能同名注册，只能让包先别自动加载。
 *
 * 开关是 `settings.json` 里 `packages` 的**对象形式 + 空数组过滤**（pi 官方文档
 * `docs/packages.md`「Select package resources」：`[]` = 该类型一个都不加载）：
 *
 * ```json
 * "packages": [
 *   { "source": "npm:pi-web-access", "extensions": [] },
 *   "npm:pi-subagents",
 *   "git:github.com/jayli/superpowers"
 * ]
 * ```
 *
 * **包本身仍然登记在 `packages` 里** —— 所以 `pi update --extensions` 照常提示并升级它，
 * 与 `-builtin:codemode` 那种「禁用加载单元但不禁用包」是同一个手法（用户 2026-10-02 明确要求
 * 「升级还是正常升级」）。升级后本扩展不用改：捕获的是**当次运行**的包定义，包升级即跟着变；
 * 渲染器里没有任何一份复制的包逻辑。
 *
 * 实测（SDK，2026-10-02）：该过滤生效后 `pi-web-access` 不再自动加载、本扩展的 5 个工具
 * 照常注册，而启动诊断 **errors: [] / warnings: []**（对比：不过滤时是 5 条 conflict errors）。
 *
 * ## 包不在时的行为（fail-soft，不能把 pi 拖崩）
 *
 * 包没装（换机器、`packages` 里手动删了）时本扩展**什么都不注册**，这几个工具就整个不存在 ——
 * 与「包没装」时的原生行为一致。不抛异常：扩展加载期抛异常同样是静默少工具，还更难查。
 *
 * ## 包路径的解析（三条候选，按可靠性排）
 *
 * ① `PI_WEB_ACCESS_EXTENSION` 环境变量（测试与特殊布局用）；
 * ② **裸说明符 `import("pi-web-access")`** —— 扩展是被 jiti 加载的，解析基准是**扩展文件自己
 *    的目录**（`~/.pi/agent/extensions/web-search-tree/`），向上查 `~/.pi/agent/node_modules/`。
 *    这个位置存在时是首选（跟着包的安装位置走，不猜）。本机实测**不存在**，但留着 —— 别的布局
 *    下可能命中，且命中时最准。
 * ③ `~/.pi/agent/npm/node_modules/pi-web-access/dist/index.js`（pi 的 npm 安装落点；node
 *    `--test` 环境实测**可以**直接 import 进 ESM，readpath 是 bin 时不行 —— 见 index.test.ts 的说明）。
 *
 * **不做 `createRequire` 那套**：`.pnpm` 的 hoisted 布局里 `pi-web-access` 只作为 symlink 存在，
 * `require.resolve("pi-web-access")` 实测抛 `MODULE_NOT_FOUND`（它不在 `node_modules/.pnpm/node_modules`
 * 下，也不是本包的依赖）—— 三条候选里已经覆盖了它真实所在的两个位置，再加一条只会误导。
 *
 * `PI_WEB_SEARCH_TREE=off` 关闭（注册期读一次，与 `PI_CODEMODE_TREE` / `PI_READ_COLLAPSE` 同一约定）。
 * 注意关闭后这些工具会**整个消失**（包已被 settings 过滤掉、本扩展又不注册）——
 * 要恢复原生观感得先把 settings 里那条过滤删掉。这条代价与 `codemode-tree` 的 `PI_CODEMODE_TREE`
 * 完全同形，README 里一并记着。
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
	colorizeErrorLines,
	contentWidth,
	isFailureResult,
	recolorSuccessToFailure,
	shapeResultLines,
	stateDotSlot,
	trimTrailingBlanks,
	withCallGutter,
} from "./render.ts";

/** 接管的工具名 —— 三个都自带渲染器，改造成本与 search 同构（见文件头表格）。 */
const MANAGED_TOOLS = new Set(["pi_web_search", "fetch_content", "get_search_content"]);

/** 包 npm 安装落点里的扩展入口。 */
function npmPackageEntry(): string {
	return join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-web-access", "dist", "index.js");
}

/**
 * 解析 pi-web-access 的工厂函数（候选见文件头）。全部失败返回 undefined —— 调用方据此静默退出。
 *
 * 裸说明符那个候选**故意放在绝对路径之前**：它命中时才是「包现在装在哪」，绝对路径只是兜底。
 */
async function resolvePackageFactory(): Promise<((pi: unknown) => unknown) | undefined> {
	const candidates: string[] = [];
	const override = process.env.PI_WEB_ACCESS_EXTENSION?.trim();
	if (override) candidates.push(override);
	candidates.push("pi-web-access");
	candidates.push(npmPackageEntry());

	for (const candidate of candidates) {
		try {
			const loaded = await import(candidate);
			const factory = (loaded as { default?: unknown }).default;
			if (typeof factory === "function") return factory as (pi: unknown) => unknown;
		} catch {
			// 这个候选不可用：试下一个
		}
	}
	return undefined;
}

/**
 * 用包自己的工厂**捕获**它注册的工具定义（只拦截 `registerTool`，其余 `pi.*` 转发给真 API）。
 *
 * 注意包是**异步**工厂（pi 的 `initializeExtension` 里 `await factory(...)`），所以这里也必须
 * await —— 不等的话捕获到的会是空集合。
 */
async function capturePackageTools(pi: ExtensionAPI, factory: (pi: unknown) => unknown): Promise<ToolDefinition<any, any, any>[]> {
	const captured: ToolDefinition<any, any, any>[] = [];
	const capture = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (definition: ToolDefinition<any, any, any>) => {
					captured.push(definition);
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
	await factory(capture);
	return captured;
}

/** 包自带渲染器返回的可能是 `Container`（带 children）也可能是单个组件 —— 统一成行数组。 */
function componentLines(component: any, width: number): string[] {
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

/** 从工具的 result 里取出正文行（模型可见那份）—— 同步可得，不需要宽度。 */
function contentLines(result: { content?: unknown }): string[] {
	const blocks = Array.isArray(result.content) ? result.content : [];
	return blocks
		.filter((block): block is { type: string; text?: string } => !!block && typeof block === "object")
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.flatMap((block) => block.text!.split("\n"));
}

/**
 * 按**宽度 + 形状键**缓存行数组：`render(width)` 每帧都调，而两个渲染器都不便宜（包自带的
 * `renderResult` 要拼 preview / 扫 content）。键里必须带上状态 —— 圆点颜色、命令行续段前缀
 * 都随状态变，只按宽度缓存会把上一帧的形状钉死（`codemode-tree` 踩过同一个坑）。
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

/**
 * 给**一个**被接管的工具定义接上树形外壳。
 *
 * 三个工具共用同一套变换（用户 2026-10-02 定：只收自带渲染器的那三个，所以这条路径对三者都成立）——
 * 差异只在包自己的渲染器产出的行，形状与列位全在 `render.ts` 里统一。
 */
function withTreeShell(target: ToolDefinition<any, any, any>): ToolDefinition<any, any, any> {
	return {
		// 展开而不是逐字段抄：`execute` / `parameters` / `description` / `promptSnippet` /
		// `promptGuidelines` / `constrainedSampling` / `exposure` / `defaultActive` / `annotations`
		// 全部原样继承（prompt 元数据不会自动继承，必须显式带上）。
		...target,
		// `renderShell: "self"`：让 pi 不再套 `contentBox`（`Box(1, 1, bgFn)`）—— 于是
		// ① **没有底色**（pending / 成功 / 失败三种底都不画），② **没有上下两条边界空行**。
		// 与 bash / read / codemode 块同一手法。
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state as { innerCall?: any; innerResult?: any; failed?: boolean };
			// 传给包自带渲染器的 `lastComponent` 必须是**它们自己上次返回的那个内层组件**：
			// 包自带的 `renderResult` 里有 `context.lastComponent ?? …` 的复用逻辑，把我们的
			// wrapper（没有 `clear()` / `addChild()`）传进去会抛 `TypeError`，而 pi 的
			// `updateDisplay()` 会**静默**退回 fallback —— 形状悄悄变回默认，没有任何报错。
			const inner =
				target.renderCall?.(args, theme, { ...context, lastComponent: state.innerCall }) ??
				({ render: () => [], invalidate: () => {} } as any);
			state.innerCall = inner;
			return createCachedComponent(
				(width) => {
					// 圆点色彩读 `state.failed` 而不是 `context.isError`：包有若干失败路径是**正常返回**
					// 一个带 `details.error` 的对象（不是 throw），pi 不会把它标成 isError，只看
					// `context.isError` 会让那些路径永远显示绿点。`state.failed` 由 renderResult 写入
					// —— `updateDisplay()` 先 call 后 result，但两个组件的 `render()` 都在这之后才
					// 跑，所以同一帧里读得到（与下面 `state.innerResult` 判「树接上没有」同一套时点）。
					const dot = theme.fg(stateDotSlot(context.isPartial === true, state.failed === true), "\u2022");
					const pipe = theme.fg("muted", "\u2502 ");
					const connected = state.innerResult !== undefined;
					return withCallGutter(componentLines(inner, contentWidth(width)), dot, pipe, connected);
				},
				() =>
					`${state.innerResult === undefined ? "loose" : "connected"}:${stateDotSlot(context.isPartial === true, state.failed === true)}`,
				() => inner.invalidate?.(),
			);
		},
		renderResult(result, options, theme, context) {
			const state = context.state as { innerResult?: any; failed?: boolean };
			// 失败判定必须**在这里同步算完**（不能推进下面的懒渲染闭包）：`updateDisplay()` 先跑
			// renderCall、再跑本函数，而容器渲染时两个组件的 `render()` 是**先 call 后 result** ——
			// 把判定放在下面的闭包里，renderCall 那颗圆点就会看到上一帧的（未置位的）`state.failed`，
			// 于是失败块显示绿点（实测踩到）。判定读原始 `result`（正文文本 / details / isError）
			// 而不是渲染后的行，所以同步算得出来，也不需要宽度。
			const failed = isFailureResult(context.isError === true, contentLines(result), result.details);
			state.failed = failed;
			// 同一个 `lastComponent` 契约（见 renderCall 里的说明）。
			const inner =
				target.renderResult?.(result, options, theme, { ...context, lastComponent: state.innerResult }) ??
				({ render: () => [], invalidate: () => {} } as any);
			state.innerResult = inner;
			return createCachedComponent(
				(width) => {
					const lines = trimTrailingBlanks(componentLines(inner, contentWidth(width)));
					if (!failed) return shapeResultLines(lines, theme);
					// 失败：① 包的状态行是无条件 `success` 绿的（它不知道这次失败了），换成失败红，
					// 否则会出现「红圆点 + 绿状态行」的自相矛盾；② `Error:` 行也染红。
					return shapeResultLines(recolorSuccessToFailure(colorizeErrorLines(lines, theme), theme), theme);
				},
				() => `result:${failed ? "err" : "ok"}:${options.expanded ? "expanded" : "collapsed"}`,
				() => inner.invalidate?.(),
			);
		},
	};
}

export default async function (pi: ExtensionAPI): Promise<void> {
	if (process.env.PI_WEB_SEARCH_TREE?.trim().toLowerCase() === "off") return;

	const factory = await resolvePackageFactory();
	if (!factory) {
		// 包不在：什么都不注册（见文件头「包不在时的行为」）。不抛异常 —— 加载期抛异常同样是
		// 静默少工具，只是更难查。
		return;
	}
	const captured = await capturePackageTools(pi, factory);
	if (captured.length === 0) return;

	for (const definition of captured) {
		// 自带渲染器的三个套上树形外壳；其余（source_check / web_enable，无渲染器）原样注册 ——
		// 观感不变是用户明确划定的范围（见文件头表格）。
		pi.registerTool(MANAGED_TOOLS.has(definition.name) && definition.renderCall ? withTreeShell(definition) : definition);
	}
}
