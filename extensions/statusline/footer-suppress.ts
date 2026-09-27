/**
 * footer-suppress.ts — 启动窗口内「关掉」pi 内置 footer
 *
 * 要解决的问题：pi 起 TUI 的顺序是 `ui.start()`（内置 footer 早已挂在 footer 容器里）→
 * `ensureTool("fd"/"rg")` → `rebindCurrentSession()` → 才 emit `session_start`
 * （`interactive-mode.js` 的 `init()`）。扩展拿到 ctx、能 `setFooter()` 只能等到最后一步，
 * 而 Runner 的 `emit()` 是**串行 await** 每个扩展的 handler，排在 `statusline` 前面的扩展
 * （本机是 `mcp`，握手要连 MCP server）还会再往后推一点。实测本机冷启动：内置 footer 在
 * ~480ms 出第一帧，我们的 statusline 到 ~1.2s 才装上 —— 中间那 ~0.7s 底部是 pi 默认状态行
 * （`~/path` + `0.0%/1.0M (auto) ... deepseek-flash • max`），然后整块换成 `🅼 ...`。
 * 用户看到的就是「先默认、后扩展」闪一下。
 *
 * 为什么只能在原型上解决：扩展能拿到 TUI 的最早时刻就是 `session_start`；但扩展的**模块求值 /
 * 工厂**发生在 TUI 创建之前（扩展由 `createAgentSessionServices` → `resourceLoader.reload()`
 * 加载，InteractiveMode 之后才 new）。所以这里在工厂里就把 `FooterComponent.prototype.render`
 * 换掉：窗口内内置 footer 渲染 0 行（底部空着等我们的 statusline），而不是先画一个马上要变的
 * 默认状态行。
 *
 * 为什么打得中：bundle 运行时，扩展解析 `@earendil-works/pi-coding-agent` 走 loader 的
 * `virtualModules`（`dist/bundle/index.js`），与 `interactive-mode.js` 内部用的是同一个类对象
 * （同一个 chunk）—— 和 `fenceless-code-block` 打 `Markdown.prototype` 是同一个前提；
 * 万一打不中也只是退回原样（照旧闪一下），不会坏。
 *
 * 约束：
 *   - 只换 `prototype.render`，不碰实例、不碰 pi 内部状态，也不动 children；
 *   - 幂等且可解除：`/reload` 会重新求值模块，新实例先解开旧实例的接管再打自己的；
 *   - `maxAgeMs` 兜底：万一我们的 footer 始终没装上（扩展报错、非 TUI 模式），到点自动交还，
 *     回到 pi 默认行为，不会让底部永远空着；
 *   - 任何一步抛错都当作「没打上」，绝不把异常漏给宿主。
 */

/** 挂在 footer 原型上的接管记录键（全局符号注册表：`/reload` 后新扩展实例也能看到旧实例的接管）。 */
export const FOOTER_SUPPRESS_KEY: symbol = Symbol.for("litellm-any.pi-statusline.footerSuppress");

/**
 * 兜底时长：正常 `session_start` 远早于它解除，只有交接失败才会走到这里。
 * 取 30s 是因为我们排在别的扩展后面 —— `Runner.emit()` 串行 await，`mcp`（字母序在前）
 * 只在握手全部结束后才轮到我们，握手本身的上限就是 20s。
 */
export const FOOTER_SUPPRESS_MAX_AGE_MS = 30_000;

/** 本模块用到的 `FooterComponent` 形状（不 import pi，单测直接塞假类）。 */
export interface FooterClassLike {
	prototype: { render(width: number): string[] };
}

interface SuppressRecord {
	release: () => void;
}

/**
 * 接管记录挂在哪：优先 `target.prototype`（真正被改的那个对象），退而求其次用 target 自身。
 * 传类或传原型都能用；形状对不上返回 undefined（那就什么都不做）。
 */
export function suppressTarget(target: unknown): { render(width: number): string[] } | undefined {
	const kind = typeof target;
	if (target === null || (kind !== "object" && kind !== "function")) return undefined;
	for (const candidate of [(target as { prototype?: unknown }).prototype, target]) {
		if (
			candidate !== null &&
			typeof candidate === "object" &&
			typeof (candidate as { render?: unknown }).render === "function"
		) {
			return candidate as { render(width: number): string[] };
		}
	}
	return undefined;
}

/** 解除 `target` 上现有的接管（可能是别的扩展实例遗留的）。返回是否解掉了什么。 */
export function releaseFooterSuppressor(target: unknown): boolean {
	try {
		const holder = suppressTarget(target) as { [FOOTER_SUPPRESS_KEY]?: SuppressRecord } | undefined;
		const record = holder?.[FOOTER_SUPPRESS_KEY];
		if (!record || typeof record.release !== "function") return false;
		record.release();
		return true;
	} catch {
		return false;
	}
}

/**
 * 把 `footerClass.prototype.render` 换成「返回 0 行」，返回解除函数（幂等）。
 *
 * 解除（或超过 `maxAgeMs`）后原型恢复原样，渲染透传；重复接管会先交还上一次，不会叠 wrapper。
 * 形状不对 / 原型只读时返回 undefined（调用方按「没打上」处理，行为退回原样）。
 */
export function suppressBuiltInFooter(
	footerClass: unknown,
	options: { maxAgeMs?: number; now?: () => number } = {},
): (() => void) | undefined {
	const target = suppressTarget(footerClass);
	if (!target) return undefined;
	// 先解除已有接管（自己重入 / 上一个扩展实例遗留），拿到的才是真原版。
	releaseFooterSuppressor(target);

	const originalRender = target.render;
	const maxAgeMs = options.maxAgeMs ?? FOOTER_SUPPRESS_MAX_AGE_MS;
	const now = options.now ?? Date.now;
	const armedAt = now();
	const hadOwnRender = Object.prototype.hasOwnProperty.call(target, "render");
	const state: { released: boolean; record?: SuppressRecord } = { released: false };

	const release = (): void => {
		if (state.released) return;
		state.released = true;
		try {
			const holder = target as { [FOOTER_SUPPRESS_KEY]?: SuppressRecord };
			if (state.record && holder[FOOTER_SUPPRESS_KEY] === state.record) delete holder[FOOTER_SUPPRESS_KEY];
			if (hadOwnRender) target.render = originalRender;
			else delete (target as { render?: unknown }).render;
		} catch {
			// 原型只读 / 已被换掉：wrapper 自己会因 released 标志透传，不再屏蔽。
		}
	};

	const wrapper = function (this: unknown, width: number): string[] {
		if (state.released) return originalRender.call(this, width);
		if (now() - armedAt > maxAgeMs) {
			release();
			return originalRender.call(this, width);
		}
		return [];
	};

	try {
		target.render = wrapper;
		state.record = { release };
		(target as { [FOOTER_SUPPRESS_KEY]?: SuppressRecord })[FOOTER_SUPPRESS_KEY] = state.record;
	} catch {
		return undefined;
	}
	return release;
}
