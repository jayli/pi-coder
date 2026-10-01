/**
 * startup-logo — 启动时顶部显示一个静态的 pi logo，并剪掉启动清单里的全部五段
 *
 * pi 的内置 header（`interactive-mode.js`）只有 `pi vX.Y.Z` 一行加几条快捷键提示，没有图形。
 * 本扩展用 `ctx.ui.setHeader()` 换掉它：顶部一只静态的 pi.dev 印记（形 `npm:pi-claude-code-tui`
 * 的字形数据，但**不装那个包**，理由见 `logo.ts` 与 README），右侧挂标题行与当前目录
 * （家目录内显示成 `~/...`），下面仍是内置那套紧凑快捷键提示，所以换掉 header 不丢信息。
 * 标题行是 `pi vX.Y.Z (deepseek-flash-qd with max effort)`：**版本号后面跟当前模型与推理档位**
 * （用户 2026-10-01 定），模型 id 从 `ctx.model?.id`、档位从 `ctx.thinkingLevel` 现取，
 * 两条都是 live getter，所以 `/model` 换模型、shift+tab 换档位之后下一帧即跟随。
 *
 * **每一行都不顶格**（用户 2026-10-01 定）：印记行、提示行、说明行统一缩进一格（`MARK_INDENT`），
 * 与印记左边对齐。缩进在 `composeHeaderLines` 里统一补，`index.ts` 这边不需要另管。
 *
 * logo **常开**：没有 `/logo` 开关命令（也不再在说明行里提它），`PI_LOGO=off` 是唯一的口子。
 *
 * **静态**：上游那只印记是 22 帧动画（三笔推进来 + 底座闪两下再落定），本仓库只要一只静态
 * logo，所以帧表、定时器、`requestRender` 全都没有 —— 每次渲染都是同一张格子表，颜色现取
 * `theme.fg("accent")`，因此 `/theme` 换肤下一帧即跟随。也因此没有「活过会话的定时器把宿主
 * 进程带崩」那一类坑（本仓库在 `simple-task/`、`working-indicator/` 上踩过）。
 *
 * header 只在**启动时**出现在聊天区上方，随滚动离开视野；它不是常驻控件，也不占编辑器区域。
 *
 * header 下面那份「已加载资源」清单同样是 pi 在会话绑定之后才填的，其中
 * `[Context]` / `[Skills]` / `[Prompts]` / `[Extensions]` / `[Themes]` 五段没有信息量，本扩展顺手剪掉
 * （`loaded-sections.ts`）：剪枝看的是**已挂载的 header 组件**所在容器，所以只在 logo 装上的时候生效，
 * 只留 `[Skill conflicts]` / `[Extension issues]` 这类诊断段。
 *
 * 其余三点约束：
 *   1. 只在 TUI 模式装（`ctx.mode === "tui"`）—— print / RPC / JSON 模式没有 header。
 *   2. 换会话（`/new`、`/clear`、`/resume`、fork、rewind）时 pi 会先 `resetExtensionUI()`
 *      还原内置 header，等新会话 `session_start` 才重装；中间那几十毫秒会真的出帧，
 *      于是顶部「闪」回内置 header 并跳一次版式。这段窗口由 `header-guard.ts` 在渲染路径上
 *      冻住（重放上一帧的行），机制与 statusline 的 footer 冻结同源，各持一份、互不依赖。
 *   3. 终端太窄（印记右侧放不下侧栏）时退化成单行 wordmark，不折行。
 *
 * 开关：`PI_LOGO=off` 启动时不装（无配置文件、无侧效；此时启动清单保持 pi 原样，因为剪枝要靠
 * 已挂载的 header 组件去认容器）。
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint, keyText, rawKeyHint, VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import {
	MARK_CELL,
	MARK_INDENT,
	MARK_WIDTH,
	attachSideText,
	composeHeaderLines,
	formatTitleLine,
	markLines,
	shortenPath,
} from "./logo.ts";
import { findRenderContainer, freezeHeaderContainer, releaseHeaderGuard } from "./header-guard.ts";
import { hideLoadedSections } from "./loaded-sections.ts";

const LOGO_DISABLED = (process.env.PI_LOGO ?? "").trim().toLowerCase() === "off";
/** logo 常开（没有会话内开关，`/logo` 已按用户要求去掉）。 */
const ENABLED = !LOGO_DISABLED;
/** 窄终端阈值：印记右侧至少还要留出这些列才画印记。 */
const MIN_SIDE_COLUMNS = 20;
const SIDE_GAP = 2;
const ELLIPSIS = "…";

/** header 容器要的是这个组件对象；只要 render/invalidate 形状，便于在守卫里按身份比对。 */
interface HeaderComponent {
	render(width: number): string[];
	invalidate(): void;
}

export default function startupLogo(pi: ExtensionAPI) {
	// 冻结窗口要用的四样：TUI 根（找容器）、当前 header 组件、它的容器、上一帧渲染出的行。
	let tuiHandle: unknown;
	let headerComponent: HeaderComponent | undefined;
	let headerContainer: unknown;
	let lastLines: string[] | undefined;
	let guardRelease: (() => void) | undefined;

	let home: string | undefined;
	const homeDir = (): string | undefined => {
		if (home === undefined) {
			try {
				home = homedir();
			} catch {
				home = "";
			}
		}
		return home || undefined;
	};

	/**
	 * 与内置 header 同一批键位的紧凑提示行。
	 *
	 * 故意包在 try/catch 里：本仓库在 `bash-command-collapse.ts` 里踩过「扩展 import 到的
	 * `@earendil-works/pi-coding-agent` 副本与 pi 运行时不是同一份单例，`keyHint` 直接抛
	 * `Theme not initialized`、`keyText` 返回空串」（那里只能自己读 keybindings.json 重建）。
	 * 实测在 0.85.1 + pnpm 布局下这里拿到的是同一份、键名与颜色都正常（见 README 该节的
	 * 实测记录），所以用 pi 的 helper；万一将来变成另一份，最多是提示行缺失，不能把整个
	 * header 弄挂（render 里抛错会被 pi 报 extension error）。
	 */
	const buildHints = (theme: Theme): string | undefined => {
		try {
			return [
				keyHint("app.interrupt", "interrupt"),
				rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
				rawKeyHint("/", "commands"),
				rawKeyHint("!", "bash"),
			].join(theme.fg("muted", " · "));
		} catch {
			return undefined;
		}
	};

	/** 一帧的完整行：印记 → 提示行 → 说明行。 */
	const buildLines = (theme: Theme, ctx: ExtensionContext, width: number): string[] => {
		// 模型 id 与档位是 live getter，会话被换掉后旧 ctx 上读它们会抛（同 statusline）；
		// 读不到就省掉标题行里那一截，不能因此把整个 header 弄挂。
		let model: string | undefined;
		let level: string | undefined;
		try {
			model = ctx.model?.id;
			level = ctx.thinkingLevel;
		} catch {
			// stale ctx：标题退回只显示版本号
		}
		const wordmark = formatTitleLine(theme, VERSION, model, level);
		const where = theme.fg("muted", shortenPath(ctx.cwd, homeDir()));
		const hints = buildHints(theme);
		const onboarding = theme.fg("dim", "Pi can explain its own features and look up its docs.");

		// 提示行 / 说明行也过一遍截断：它们本身就有 53 列，加上 `MARK_INDENT` 那一格后在 53 列的
		// 终端上会刚好超宽 —— 而 pi-tui 对超宽的行是直接抛错（整个 TUI 挂掉）。口径按**含缩进**的
		// 整行算（先扣掉那一格再裁），所以「每一帧都不超宽」不依赖终端多宽。
		const clamp = (line: string | undefined): string | undefined =>
			line === undefined ? undefined : truncateToWidth(line, Math.max(1, width - MARK_INDENT.length), ELLIPSIS);

		// 窄终端：不画印记，退化成单行 wordmark（同样缩进一格，跟印记左边对齐）。
		if (width < MARK_WIDTH + MIN_SIDE_COLUMNS) {
			const room = Math.max(1, width - MARK_INDENT.length);
			return composeHeaderLines({
				logo: [`${MARK_INDENT}${truncateToWidth(wordmark, room, ELLIPSIS)}`],
				hints: clamp(hints),
				onboarding: clamp(onboarding),
			});
		}
		const sideRoom = Math.max(0, width - MARK_WIDTH - SIDE_GAP);
		// 逐格上色（整行包一层会让行尾的 trimEnd 失效，见 logo.ts 的 markLines）
		// 标题行必须跟 cwd 一样裁：pi-tui 对超出终端宽度的行是**直接抛错**
		// （`Rendered line N exceeds terminal width`），而模型 id 是外部输入、长度无上限。
		const logo = attachSideText(
			markLines((filled) => (filled ? theme.fg("accent", MARK_CELL) : " ".repeat(MARK_CELL.length))),
			[truncateToWidth(wordmark, sideRoom, ELLIPSIS), truncateToWidth(where, sideRoom, ELLIPSIS)],
			SIDE_GAP,
		);
		return composeHeaderLines({ logo, hints: clamp(hints), onboarding: clamp(onboarding) });
	};

	const installHeader = (ctx: ExtensionContext) => {
		// 先交还上一段换会话窗口的冻结再装新 header：两步在同一个同步块里，中间出不了帧。
		guardRelease?.();
		guardRelease = undefined;
		if (ctx.mode !== "tui" || !ENABLED) return;

		let component: HeaderComponent | undefined;
		ctx.ui.setHeader((tui, theme) => {
			tuiHandle = tui;
			const own: HeaderComponent = {
				invalidate() {},
				render(width: number): string[] {
					const lines = buildLines(theme, ctx, Math.max(1, width));
					// 换会话时按身份比对我们是否还在容器里，不在就拿这份行重放（见 header-guard.ts）。
					lastLines = lines;
					return lines;
				},
			};
			component = own;
			return own;
		});

		// 组件此刻已被 pi 挂进 header 容器（`setHeader` 是同步的），按对象身份认出那个容器；
		// 换会话时冻结要用。顺手解除别的扩展实例遗留的接管（`/reload` 之后可能有一次）。
		if (!component) return;
		headerComponent = component;
		headerContainer = findRenderContainer(tuiHandle, component);
		if (!headerContainer) return;
		releaseHeaderGuard(headerContainer);
		// 已加载资源清单就在 header 容器后面那个兄弟容器里，pi 还没来得及填（本回调跑在
		// `showLoadedResources` 之前），所以这里接管它的 addChild 就能把那五段整段丢掉。
		hideLoadedSections({ root: tuiHandle, headerContainer });
	};

	/** 换会话窗口内把 header 钉在上一帧：内置 header 一帧都不会出现。 */
	const freezeHeader = () => {
		if (!headerContainer || !headerComponent) return;
		const component = headerComponent;
		const lines = lastLines;
		guardRelease = freezeHeaderContainer({
			container: headerContainer,
			ownComponent: component,
			frozenRender: (width) =>
				lines ? lines.map((line) => truncateToWidth(line, width, ELLIPSIS)) : component.render(width),
		});
	};

	pi.on("session_start", (_event, ctx) => {
		installHeader(ctx);
	});

	// resume / fork / rewind 会换掉会话对象，header 得按新 ctx 重装。
	pi.on("session_tree", (_event, ctx) => {
		installHeader(ctx);
	});

	// resetExtensionUI 发生在本回调之后：先接管容器渲染，还原内置 header 时就不会出帧。
	pi.on("session_shutdown", () => {
		freezeHeader();
	});
}
