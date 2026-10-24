/**
 * boot-suppress.ts — 启动窗口内「关掉」pi 内置 header（那只 `▀▀█ v1.4.0` 的默认 logo）
 *
 * 要解决的问题：pi 起 TUI 的顺序是「扩展工厂（此时 TUI 还没 new 出来）→ `new InteractiveMode`
 * → `init()` 里先装内置 header 并 `ui.requestRender()` → 等终端报色 → `ensureTool("fd"/"rg")`
 * → `rebindCurrentSession()` → **才** emit `session_start`」（`interactive-mode.js` 的 `init()`）。
 * 扩展要拿到 `ctx.ui.setHeader()` 只能等到最后一步，于是内置 header 一定会先出至少一帧：
 * 本机 pty 实测（2026-10-22，130 列）内置 logo 在 ~1.05s 出现、我们定制的 logo 到 ~2.4s，
 * 中间 1.3 秒屏幕上是一只 pi 默认印记 + `▀▀█ v1.4.0`，随后整块换成定制 logo。
 * 用户看到的就是「先默认、后扩展」闪一下。
 *
 * 为什么只能在原型上解决：扩展能拿到 TUI 的最早时刻就是 `session_start`；但扩展的**模块求值 /
 * 工厂**发生在 TUI 创建之前（扩展由 `createAgentSessionServices` → `resourceLoader.reload()`
 * 加载，InteractiveMode 之后才 new）。所以这里在工厂里就把 `shouldShowStartupHeader()` 换掉：
 * 启动那一刻返回 false，pi 于是压根不建内置 header，只挂一个空 `Text("", 0, 0)`
 * （`interactive-mode.js` 的 `if (this.shouldShowStartupHeader()) { … } else { minimal header }`），
 * 顶部在那 1.3 秒里是空白 —— 而不是先画一只马上要被换掉的默认印记。
 *
 * 为什么只拦这一个方法：`init()` 里读它的地方只有一处（建内置 header），而「已加载资源清单」
 * 读的是 `shouldShowStartupDetails()` —— 那个**不动**，所以诊断段（`[Extension issues]` 之类）
 * 照旧会出现，本扩展的 `loaded-sections.ts` 也照旧只剪那五段。
 *
 * `--verbose` 不拦：那是用户显式要求看完整启动帮助（`shouldShowStartupHeader` 的原实现里
 * `options.verbose === true` 优先），拦掉就把展开帮助一起吞了。这种情况下接受那一次闪。
 *
 * 为什么打得中：bundle 运行时，扩展解析 `@earendil-works/pi-coding-agent` 走 loader 的
 * `virtualModules`，与 `interactive-mode.js` 内部用的是同一个类对象 —— 与
 * `statusline/footer-suppress.ts` 打 `FooterComponent.prototype` 是同一个前提（那边实测过
 * 补丁真的落在 pi 自己 new 的实例上）。万一打不中也只是退回原样（照旧闪一下），不会坏。
 *
 * 约束：
 *   - 只换原型方法，不碰实例、不碰 pi 内部状态，也不动 children；
 *   - 幂等且可解除：`/reload` 会重新求值模块，新实例先解开旧实例的接管再打自己的；
 *   - 任何一步抛错都当作「没打上」，绝不把异常漏给宿主。
 *
 * 代价（与 statusline 的 footer-suppress 同形）：内置 header 一旦在 `init()` 里被换成空
 * `Text`，这个进程后续 `resetExtensionUI()` 还原出来的也是那个空 Text —— 所以换会话窗口
 * 顶部同样是空白（`header-guard.ts` 在那里重放上一帧，比空白更好看，两条互不冲突）。
 * 另一个代价是**本扩展若在打完补丁之后加载失败**，那次运行的顶部会一直是空白；
 * 所以补丁在工厂的**最后一步**才打（前面任何一步抛错都不会留下这个状态）。
 * `PI_LOGO_BOOT_SUPPRESS=off` 可关。
 */

/** 挂在原型上的接管记录键（全局符号注册表：`/reload` 后新扩展实例也能看到旧实例的接管）。 */
export const HEADER_SUPPRESS_KEY: symbol = Symbol.for("litellm-any.pi-startup-logo.bootSuppress");

/**
 * 「本进程的 pi 已经因为静音跳过内置 header」这个事实挂在 `globalThis` 上（全局符号键）。
 *
 * 为什么不能只信 `suppressed` getter：`/clear`（与 `/new`、`/resume`、fork、rewind 一样）会
 * **重新加载扩展模块**、新建一个扩展实例，而 `interactive-mode.js` 的 `init()` 早就在旧实例的
 * 生命周期里跑完了 —— 新实例自己的 getter 永远是 `false`（它的 wrapper 一次都没被问过），
 * 于是「要不要补顶部那条空行」判错，印记又贴回终端顶边（用户 2026-10-22 实测：1.4.0 上
 * 启动正常、`/clear` 之后少一行）。
 *
 * 事实属于**进程**而不是某个扩展实例，所以落在 `globalThis` 上：`/reload` 与 `pi update`
 * 都不清它，`PI_LOGO_BOOT_SUPPRESS=off` 那条路压根不写它。
 */
export const BOOT_SUPPRESSED_KEY: symbol = Symbol.for("litellm-any.pi-startup-logo.bootSuppressed");

/** 本进程的 pi 是否已经因为静音跳过内置 header（跨扩展实例可见）。 */
export function isBuiltInHeaderSuppressed(): boolean {
	try {
		return (globalThis as { [BOOT_SUPPRESSED_KEY]?: unknown })[BOOT_SUPPRESSED_KEY] === true;
	} catch {
		return false;
	}
}

/** 记下「本进程的 pi 已经跳过内置 header」（幂等）。 */
function markBuiltInHeaderSuppressed(): void {
	try {
		(globalThis as { [BOOT_SUPPRESSED_KEY]?: unknown })[BOOT_SUPPRESSED_KEY] = true;
	} catch {
		// 全局对象被冻 / 代理拦：`suppressed` getter 仍准，只是跨实例那条路失效。
	}
}

/** 本模块用到的 `InteractiveMode` 形状（不 import pi，单测直接塞假类）。 */
export interface HeaderSuppressClassLike {
	prototype: { shouldShowStartupHeader(): boolean };
}

interface SuppressRecord {
	release: () => void;
}

/**
 * 接管记录挂在哪：优先 `target.prototype`（真正被改的那个对象），退而求其次用 target 自身。
 * 传类或传原型都能用；形状对不上返回 undefined（那就什么都不做）。
 */
export function suppressTarget(target: unknown): { shouldShowStartupHeader(): boolean } | undefined {
	const kind = typeof target;
	if (target === null || (kind !== "object" && kind !== "function")) return undefined;
	for (const candidate of [(target as { prototype?: unknown }).prototype, target]) {
		if (
			candidate !== null &&
			typeof candidate === "object" &&
			typeof (candidate as { shouldShowStartupHeader?: unknown }).shouldShowStartupHeader === "function"
		) {
			return candidate as { shouldShowStartupHeader(): boolean };
		}
	}
	return undefined;
}

/** 解除 `target` 上现有的接管（可能是别的扩展实例遗留的）。返回是否解掉了什么。 */
export function releaseHeaderSuppressor(target: unknown): boolean {
	try {
		const holder = suppressTarget(target) as { [HEADER_SUPPRESS_KEY]?: SuppressRecord } | undefined;
		const record = holder?.[HEADER_SUPPRESS_KEY];
		if (!record || typeof record.release !== "function") return false;
		record.release();
		return true;
	} catch {
		return false;
	}
}

/**
 * 把 `shouldShowStartupHeader` 换成「启动时不装内置 header」，返回解除函数（幂等）。
 *
 * 解除后原型恢复原样（调用方再问就是 pi 自己的答案）；重复接管会先交还上一次，不会叠 wrapper。
 * 形状不对 / 原型只读时返回 undefined（调用方按「没打上」处理，行为退回原样）。
 *
 * 返回值上挂一个 `suppressed` getter：本进程里 pi **真的**因此走了 minimal 分支才为 true
 * （即 wrapper 至少被问过一次、且那次给出的是 false）。扩展要靠它决定要不要自己补
 * 顶部那条空行 —— `--verbose` 或跑在非交互模式下 pi 仍走正常分支，自带那条 `Spacer(1)`
 * 还在，再补一条就变成两条空行。
 *
 * getter 的口径是**本进程**而不是本实例：`/clear` 之后扩展模块会重新求值、拿到新实例，
 * 而 pi 的 `init()` 早已跑完 —— 只信实例状态会让新实例漏掉那条空行（见 `BOOT_SUPPRESSED_KEY`）。
 */
export interface HeaderSuppressor {
	(): void;
	/** pi 是否因为本补丁在启动时跳过了内置 header（也会跳掉它上方那条 `Spacer(1)`）。 */
	readonly suppressed: boolean;
}

export function suppressBuiltInHeader(headerClass: unknown): HeaderSuppressor | undefined {
	const target = suppressTarget(headerClass);
	if (!target) return undefined;
	// 先解除已有接管（自己重入 / 上一个扩展实例遗留），拿到的才是真原版。
	releaseHeaderSuppressor(target);

	const original = target.shouldShowStartupHeader;
	const hadOwnMethod = Object.prototype.hasOwnProperty.call(target, "shouldShowStartupHeader");
	const state: { released: boolean; suppressed: boolean; record?: SuppressRecord } = {
		released: false,
		suppressed: false,
	};

	const release = (): void => {
		if (state.released) return;
		state.released = true;
		try {
			const holder = target as { [HEADER_SUPPRESS_KEY]?: SuppressRecord };
			if (state.record && holder[HEADER_SUPPRESS_KEY] === state.record) delete holder[HEADER_SUPPRESS_KEY];
			if (hadOwnMethod) target.shouldShowStartupHeader = original;
			else delete (target as { shouldShowStartupHeader?: unknown }).shouldShowStartupHeader;
		} catch {
			// 原型只读 / 已被换掉：wrapper 自己会因 released 标志透传。
		}
	};

	const wrapper = function (this: unknown): boolean {
		if (state.released) return original.call(this);
		// `--verbose` 是显式要求看完整启动帮助，别吞（见文件头）。
		const verbose = (this as { options?: { verbose?: boolean } } | undefined)?.options?.verbose;
		if (verbose === true) return original.call(this);
		// 到这里就是「pi 因为本补丁没建内置 header」—— 记下来，供 `suppressed` 查询。
		state.suppressed = true;
		markBuiltInHeaderSuppressed();
		return false;
	};

	try {
		target.shouldShowStartupHeader = wrapper;
		state.record = { release };
		(target as { [HEADER_SUPPRESS_KEY]?: SuppressRecord })[HEADER_SUPPRESS_KEY] = state.record;
	} catch {
		return undefined;
	}

	const suppressor = release as HeaderSuppressor;
	Object.defineProperty(suppressor, "suppressed", {
		// 本实例被问过、**或**本进程里已有别的实例被问过（`/clear` 之后的新实例走这条）。
		get: () => state.suppressed || isBuiltInHeaderSuppressed(),
		enumerable: true,
	});
	return suppressor;
}
