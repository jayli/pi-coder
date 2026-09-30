/**
 * loaded-sections.ts — 启动时把「已加载资源」清单整份剪掉（`[Context]` / `[Skills]` / `[Prompts]` / `[Extensions]` / `[Themes]`）
 *
 * pi 启动后会在 header 下面打一份「已加载资源」清单（`interactive-mode.js` 的 `showLoadedResources`，
 * 每段 = 一个 `ExpandableText` 标题行 + 一行内容 + 一个 `Spacer(1)`）：
 * `[Context]`（AGENTS.md 等上下文文件）、`[Skills]`、`[Prompts]`（斜杠模板）、`[Extensions]`、`[Themes]`。
 * 这五段对使用者都没有信息量（每次启动都一样、主题文件也没人会去数），留着只是白占屏幕，
 * 所以这里在**它们进容器之前**就丢掉（用户 2026-09-29 定：只留 `[Skills]`；2026-09-30 改定：
 * `[Skills]` 也不要 —— 剪完只剩它一段孤零零地挂在顶上反而难看）。
 *
 * **诊断段不剪**：`[Skill conflicts]` / `[Prompt conflicts]` / `[Extension issues]` / `[Theme conflicts]`
 * 不在名单里，它们才是这份清单剪完之后唯一还可能出现的东西（也正是真正需要看见的东西）。
 *
 * 剪完最后一段时连同 pi 在 `[Context]` 前面额外插的那个 `Spacer(1)` 一起收掉（header 容器自己
 * 已经带一个尾部空行），否则清单位置会剩一行无主的留白。
 *
 * 为什么不用 pi 自己的 `quietStartup`：那个开关除了清单还会一并关掉内置 header 与模型 scope 提示行
 * （`interactive-mode.js` 的 `init()` 里三处都读它），而本扩展的 logo header 正是接在内置 header 的位置上；
 * 这里要的只是剪清单，所以自己在容器层动手。
 * 清单是 pi 在 `bindCurrentSessionExtensions()` 里 `session_start` **之后**才填的
 * （`showLoadedResources` 紧跟 `await session.bindExtensions(...)`），所以扩展在 `session_start` 里
 * 接管容器的 `addChild` 就赶得上：被隐藏的段一次都不会进容器，也就不存在「先画出来再抹掉」的闪帧。
 *
 * 怎么认出「已加载资源」那个容器：pi 的 `documentContainer` 固定按
 * `[headerContainer, loadedResourcesContainer, chatContainer]` 顺序挂子节点（`interactive-mode.js`
 * 构造函数），所以从**已挂载的 header 组件**反查出 header 容器（`findRenderContainer`），再往上找它的
 * 父容器、取紧随其后的那个兄弟容器即可。认不出就**什么都不做**（清单照旧显示），不猜下标、不抛错。
 *
 * 判定与剪枝都是内容驱动的，跟容器认的是谁无关：只有「渲染出来的第一行恰好是名单里某个 `[Name]`」
 * 的组件才会被丢，所以万一 pi 挪了容器位置、我们摸到了别的容器（例如 chatContainer），
 * 最多是白接管一次，不会误删别的东西。任何一步抛错都当作「不是要剪的段」，一律放行。
 *
 * 全部是纯逻辑（容器只要求 `children` 数组 + `addChild`），不 import pi / pi-tui，`node --test` 直接跑。
 */

/** 要剪掉的段名（与 pi 的 `addLoadedSection("Context"…)` 逐字一致，大小写敏感）。诊断段不在其中。 */
export const HIDDEN_SECTION_NAMES: readonly string[] = ["Context", "Skills", "Prompts", "Extensions", "Themes"];

/** 接管记录挂在容器上的符号键（全局符号注册表：`/reload` 后的新实例能看到并解除旧实例的接管）。 */
export const SECTION_PRUNER_KEY: symbol = Symbol.for("litellm-any.pi-startup-logo.sectionPruner");

/**
 * 判定用的渲染宽度。标题行只有 `[Context]` 这么长（9 列），远小于任何终端宽度，不会因折行而认不出；
 * 取一个固定值是因为 `addChild` 那一刻还不知道真实宽度（`render` 才带宽度）。
 */
export const DETECT_WIDTH = 200;

/** pi-tui `Container` 里本模块用到的那部分结构（`children` / `addChild` 都是公开的）。 */
export interface PrunableContainer {
	children: unknown[];
	addChild?(child: unknown): void;
	render?(width: number): string[];
}

interface PrunerRecord {
	release: () => void;
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/** 组件渲染出来的第一行（原样返回，可能是 undefined / 非字符串）。 */
function firstRenderedLine(component: unknown, width: number): unknown {
	try {
		if (component === null || typeof component !== "object") return undefined;
		const render = (component as { render?: unknown }).render;
		if (typeof render !== "function") return undefined;
		const lines = (render as (w: number) => unknown).call(component, width);
		if (!Array.isArray(lines) || lines.length === 0) return undefined;
		return lines[0];
	} catch {
		return undefined;
	}
}

/** 剥掉 ANSI、去掉首尾空白后，这一行是不是 `[Name]` 形状；是就返回名字。 */
export function sectionTitleOfLine(line: unknown): string | undefined {
	if (typeof line !== "string") return undefined;
	const plain = line.replace(ANSI_PATTERN, "").trim();
	// 名字里可以带空格（`[Skill conflicts]` 这种诊断段），但不允许嵌套方括号。
	const match = /^\[([^[\]]+)\]$/.exec(plain);
	const title = match?.[1].trim();
	return title ? title : undefined;
}

/** 这个组件的第一行是不是某个被隐藏的段标题。 */
export function isHiddenSection(
	component: unknown,
	names: readonly string[] = HIDDEN_SECTION_NAMES,
	width: number = DETECT_WIDTH,
): boolean {
	const title = sectionTitleOfLine(firstRenderedLine(component, width));
	return title !== undefined && names.includes(title);
}

/** 这个组件是不是「一行空行」——`addLoadedSection` 每段后面那个 `Spacer(1)` 就是这个形状。 */
export function isBlankLineComponent(component: unknown, width: number = DETECT_WIDTH): boolean {
	try {
		if (component === null || typeof component !== "object") return false;
		const render = (component as { render?: unknown }).render;
		if (typeof render !== "function") return false;
		const lines = (render as (w: number) => unknown).call(component, width);
		return Array.isArray(lines) && lines.length === 1 && lines[0] === "";
	} catch {
		return false;
	}
}

/**
 * 容器里是不是「只剩一个空行」——那就是 pi 在 `[Context]` 前面插的那个额外 `Spacer(1)`。
 *
 * 剪掉第一段时顺手把它也收掉，否则整份清单剪完会在原位置剩一行无主的留白。只认「恰好一个空行」
 * 这个形状：保留段（诊断段）自己的分隔空行旁边还站着它的主人，不会被误删。
 */
function isLoneLeadingBlank(container: PrunableContainer, width: number): boolean {
	return container.children.length === 1 && isBlankLineComponent(container.children[0], width);
}

/**
 * 把 `container` 里现有的隐藏段（连同它后面那个分隔空行）直接删掉，返回删掉的段数。
 *
 * 正常路径用不到它（`addChild` 接管在前面就拦住了），留着是为了「接管装晚了」的情况 ——
 * 例如 `/reload` 之后清单已经填好才轮到新实例。
 */
export function pruneHiddenSections(
	container: unknown,
	names: readonly string[] = HIDDEN_SECTION_NAMES,
	width: number = DETECT_WIDTH,
): number {
	const target = container as PrunableContainer | undefined;
	if (!target || !Array.isArray(target.children)) return 0;
	const children = target.children;
	let removed = 0;
	// 倒着走：删掉下标 i 之后，原 i+1（紧跟的空行）正好落到 i 上。
	for (let i = children.length - 1; i >= 0; i--) {
		if (!isHiddenSection(children[i], names, width)) continue;
		try {
			children.splice(i, 1);
			removed++;
			if (i < children.length && isBlankLineComponent(children[i], width)) children.splice(i, 1);
		} catch {
			// 数组只读之类：能删多少算多少，不再往下试。
			break;
		}
	}
	// 剪过东西之后如果只剩那个前置空行，一并收掉。
	if (removed > 0 && isLoneLeadingBlank(target, width)) {
		try {
			children.splice(0, 1);
		} catch {
			// 同上：只读数组就算了。
		}
	}
	return removed;
}

/** 解除 `container` 上现有的接管（可能是别的扩展实例遗留的）。返回是否解掉了什么。 */
export function releaseHiddenSectionPruner(container: unknown): boolean {
	try {
		const record = (container as { [SECTION_PRUNER_KEY]?: PrunerRecord } | undefined)?.[SECTION_PRUNER_KEY];
		if (!record || typeof record.release !== "function") return false;
		record.release();
		return true;
	} catch {
		return false;
	}
}

function isPrunableContainer(value: unknown): value is PrunableContainer {
	return (
		value !== null &&
		typeof value === "object" &&
		Array.isArray((value as PrunableContainer).children) &&
		typeof (value as PrunableContainer).addChild === "function"
	);
}

/**
 * 接管 `container.addChild`：隐藏段（以及它后面那个分隔空行）直接不放进去，其余一律透传。
 * 返回解除函数（幂等）；容器不可用时返回 undefined。
 *
 * 幂等：重复调用先解除上一次接管再装新的，不会叠 wrapper；`/reload` 后新实例能解除旧实例的接管。
 */
export function installHiddenSectionPruner(options: {
	container: unknown;
	names?: readonly string[];
	width?: number;
}): (() => void) | undefined {
	if (!isPrunableContainer(options.container)) return undefined;
	const container = options.container;
	releaseHiddenSectionPruner(container);

	const names = options.names ?? HIDDEN_SECTION_NAMES;
	const width = options.width ?? DETECT_WIDTH;
	// 装晚了（清单已经填好）时先把现有的剪掉。
	pruneHiddenSections(container, names, width);

	const originalAddChild = container.addChild!;
	const state: { released: boolean; record?: PrunerRecord } = { released: false };
	let dropNextBlank = false;

	const release = (): void => {
		if (state.released) return;
		state.released = true;
		try {
			const holder = container as { [SECTION_PRUNER_KEY]?: PrunerRecord };
			// 已经被别的实例的新接管顶掉：只管让自己的 wrapper 失效，别去拆新的那个。
			if (state.record && holder[SECTION_PRUNER_KEY] !== state.record) return;
			delete holder[SECTION_PRUNER_KEY];
			container.addChild = originalAddChild;
		} catch {
			// 容器只读 / 已被替换：wrapper 自己会因 released 标志透传。
		}
	};

	const wrapper = (child: unknown): void => {
		if (state.released) {
			originalAddChild.call(container, child);
			return;
		}
		try {
			if (isHiddenSection(child, names, width)) {
				// 段后面紧跟的就是它自己的 Spacer(1)，一起收掉，免得留下多余空行。
				dropNextBlank = true;
				// 剪掉的是第一段时，容器里只剩 pi 在 `[Context]` 前插的那个空行，一并收掉。
				if (isLoneLeadingBlank(container, width)) container.children.splice(0, 1);
				return;
			}
			if (dropNextBlank) {
				dropNextBlank = false;
				if (isBlankLineComponent(child, width)) return;
			}
		} catch {
			// 判定失败：按普通 child 放行。
		}
		originalAddChild.call(container, child);
	};

	try {
		container.addChild = wrapper;
		state.record = { release };
		(container as { [SECTION_PRUNER_KEY]?: PrunerRecord })[SECTION_PRUNER_KEY] = state.record;
	} catch {
		return undefined;
	}
	return release;
}

/**
 * 在 `root` 的子树里找「直接装着 `headerContainer` 的那个容器」，再取它**后面**那个兄弟容器 ——
 * 就是 pi 的 `loadedResourcesContainer`。认不出返回 undefined。
 */
export function findLoadedResourcesContainer(options: {
	root: unknown;
	headerContainer: unknown;
	maxDepth?: number;
}): PrunableContainer | undefined {
	const { root, headerContainer } = options;
	if (!headerContainer) return undefined;
	const maxDepth = options.maxDepth ?? 6;
	const seen = new Set<unknown>();

	const walk = (node: unknown, depth: number): unknown => {
		if (depth > maxDepth || node === null || typeof node !== "object" || seen.has(node)) return undefined;
		seen.add(node);
		const children = (node as { children?: unknown }).children;
		if (!Array.isArray(children)) return undefined;
		const index = children.indexOf(headerContainer);
		if (index >= 0) return children[index + 1];
		for (const child of children) {
			const found = walk(child, depth + 1);
			if (found !== undefined) return found;
		}
		return undefined;
	};

	try {
		const sibling = walk(root, 0);
		return isPrunableContainer(sibling) ? sibling : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 找到「已加载资源」容器并装上剪枝接管。返回是否装上了（找不到容器 / 容器形状不对 → false，界面照旧）。
 */
export function hideLoadedSections(options: {
	root: unknown;
	headerContainer: unknown;
	names?: readonly string[];
}): boolean {
	const container = findLoadedResourcesContainer({ root: options.root, headerContainer: options.headerContainer });
	if (!container) return false;
	return installHiddenSectionPruner({ container, names: options.names }) !== undefined;
}
