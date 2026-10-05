/**
 * startup-logo — 启动时顶部显示一个 pi logo（1 秒入场动画），并剪掉启动清单里的全部五段
 *
 * pi 的内置 header（`interactive-mode.js`）只有 `pi vX.Y.Z` 一行加几条快捷键提示，没有图形。
 * 本扩展用 `ctx.ui.setHeader()` 换掉它：顶部一只 pi.dev 印记（形 `npm:pi-claude-code-tui`
 * 的字形数据，但**不装那个包**，理由见 `logo.ts` 与 README），右侧挂标题行与当前目录
 * （家目录内显示成 `~/...`），下面仍是内置那套紧凑快捷键提示，所以换掉 header 不丢信息。
 * 标题行是 `pi vX.Y.Z (deepseek-flash-qd with max effort)`：**版本号后面跟当前模型与推理档位**
 * （用户 2026-10-01 定），模型 id 从 `ctx.model?.id`、档位从 `ctx.thinkingLevel` 现取，
 * 两条都是 live getter，所以 `/model` 换模型、shift+tab 换档位之后下一帧即跟随。
 *
 * **每一行都不顶格**（用户 2026-10-01 定）：印记行、提示行、说明行统一缩进一格（`MARK_INDENT`），
 * 与印记左边对齐。缩进在 `composeHeaderLines` 里统一补，`index.ts` 这边不需要另管。
 *
 * **印记下方留一条空行；提示行与说明段之间不留**（用户 2026-10-05 定，含一次纠偏）：印记 →（空行）
 * → 快捷键提示 → 说明段。大 logo 与下面文字之间那口气要保留，去掉的只是提示行与 `@bachi/pi-coder`
 * 字形之间那一条 —— 第一次改的时候把两处一起删了，用户当场指出「大 logo 下面的空行要保留」。
 * 两处空行是两条独立规则，`composeHeaderLines` 只补「印记段 → 文字段」那一条缝。
 *
 * **说明段的尾部是 `pi-coder` 的字形块**（用户 2026-10-05 定）：`This pi harness is powered by latest
 * @bachi/` 后面不再跟 `pi-coder.`，而是三行字形（`┏┓•  ┏┓   ┓` / `┃┃┓━━┃ ┏┓┏┫┏┓┏┓` / `┣┛┗  ┗┛┗┛┗┻┗ ┛`），
 * 句子本身保持 `dim`、字形走 `accent`（与顶部印记同色）；装不下（< 60 列）就整块退回原来那一整句，
 * 不把方块字形截成残片。布局与两种形态都在 `logo.ts` 的 `poweredByLines`，这里只负责取宽度。
 * 它不在入场动画的时间轴上（动画只扫 4×4 印记格），提示行与说明段一直是静态文字。
 *
 * logo **常开**：没有 `/logo` 开关命令（也不再在说明行里提它），`PI_LOGO=off` 是唯一的口子。
 *
 * ## 入场动画（用户 2026-10-05 定）
 *
 * 启动时先**静默 500ms**（用户 2026-10-05 定：动画起太快，要等启动稳定后再开始），再用
 * **1 秒**做完一段入场：对角波自右向左扫过 4×4 格子，被扫到的格子从**另一个色相**
 * 渐显到 `accent`；右侧那两行文字（标题行 / cwd）跟着自己所在行一起渐显。时间轴与逐格相位在
 * `animation.ts`（零 pi 依赖、直接可单测），色相插值与两种降级在 `animation-frames.ts`。
 *
 * 三条设计要点：
 *   1. **落定帧与动画前的静态 logo 逐字节相同**。不是靠「颜色算回 accent」，而是结算后就
 *      **不走进动画路径**（下面的 `settled` 短路）：`theme.fg("accent", …)` 与动画期间的颜色
 *      两条路分开，所以旧观感一字未改。`index.test.ts` 拿真主题钉住这条。
 *   2. **只跑一次，跑完停表**。每次会话替换（`/new`、`/clear`、`/resume`、fork、rewind）重来
 *      一遍；`session_shutdown` 再兜一道。静默期只排一个一次性定时器（那 500ms 里每帧都
 *      一模一样，没必要起节拍），静默期一过才换成 50ms（20fps）的节拍，只调
 *      `tui.requestRender()` —— 本仓库在 `simple-task/`、`working-indicator/` 上踩过
 *      「活过会话的定时器把宿主带崩」，所以这里刻意没有常驻节拍。
 *   3. **两侧都能降级**：拿不到 accent 的具体颜色（token 是空串 / 终端没报色）就退回
 *      `theme.fg("accent", …)` 的开关两态；选不出起点色相（单色皮肤）就退化成「整块印记逐格
 *      亮起」。两条都不是错误路径，动画照做。
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
 * 已挂载的 header 组件去认容器）；`PI_LOGO_ANIMATION=off` 只关入场动画（logo 仍装，静态显示）。
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint, keyText, rawKeyHint, VERSION } from "@earendil-works/pi-coding-agent";
import {
	colorToOkhsl,
	colorToRgb,
	foregroundAnsi,
	mixColors,
	okhslColor,
	truncateToWidth,
	type Color,
	type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { MARK_ANIM_LEAD_IN_MS, MARK_ANIM_TICK_MS, cellPhase, isInLeadIn, isMarkAnimationOver, sideFadeAmount } from "./animation.ts";
import {
	colorForPhase,
	createFadeTheme,
	pickStartColor,
	startColorForAppearance,
	type ColorBag,
	type ColorOps,
} from "./animation-frames.ts";
import {
	MARK_CELL,
	MARK_INDENT,
	MARK_WIDTH,
	attachSideText,
	composeHeaderLines,
	formatTitleLine,
	markLines,
	poweredByLines,
	shortenPath,
	sideTextStartRow,
} from "./logo.ts";
import { findRenderContainer, freezeHeaderContainer, releaseHeaderGuard } from "./header-guard.ts";
import { hideLoadedSections } from "./loaded-sections.ts";

/** 环境变量的值是不是 `off`（大小写 / 空白宽容）。 */
const isOff = (name: string): boolean => (process.env[name] ?? "").trim().toLowerCase() === "off";

/**
 * 两个开关都**在调用时现读**，而不是模块顶部一次性快照。
 *
 * 理由不是「允许中途改」（`session_start` 也不会再发生第二次），而是**可测**：pi 的扩展
 * 加载器会缓存已加载的模块，模块顶部的快照在同一个测试进程里只会取一次，于是
 * 「`PI_LOGO_ANIMATION=off` 就不排帧」这条根本测不出来（本用例实测踩到过）。
 */
const logoEnabled = (): boolean => !isOff("PI_LOGO");

/** 入场动画开关（与 `PI_LOGO` 同款：只有环境变量，没有会话内命令）。 */
const animationEnabled = (): boolean => !isOff("PI_LOGO_ANIMATION");
/** 窄终端阈值：印记右侧至少还要留出这些列才画印记。 */
const MIN_SIDE_COLUMNS = 20;
const SIDE_GAP = 2;
const ELLIPSIS = "…";

/**
 * 颜色运算的真实现。注入（而不是让 `animation-frames.ts` 自己 import pi-tui）是本仓的约定：
 * 那个模块因此能 `node --test` 直接跑，而真实现只有这一份 —— 不会出现「测试用假色彩、线上
 * 用另一套」的口径漂移。
 */
const COLOR_OPS: ColorOps = {
	toOkhsl: (color: Color) => colorToOkhsl(color),
	fromOkhsl: (h: number, s: number, l: number) => okhslColor(h, s, l),
	mixOklch: (from: Color, to: Color, amount: number) => mixColors(from, to, amount, "oklch"),
	toRgb: (color: Color) => colorToRgb(color),
	fgAnsi: (color: Color, mode: TerminalColorMode) => foregroundAnsi(color, mode),
};

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

	// 入场动画的三样：开始时刻、节拍定时器、起点色缓存（换肤 / 换会话会重建）。
	let animationStartedAt: number | null = null;
	// 同一个槽位先后装两种定时器：静默期用 `setTimeout`（一次性）、动画期用 `setInterval`（节拍）。
	let animationTimer: ReturnType<typeof setInterval> | null = null;
	let startColorCache: { accentHex: string; appearance: string; color: Color | undefined } | undefined;

	/**
	 * 当前动画已走过多少毫秒（自 header 装上起算）；没在跑（或已过点）返回 null。
	 *
	 * **没减静默期** —— 静默期里仍返回一个数字（0~500），因为调用方要的就是「现在还在动画
	 * 窗口里」（渲染走动画路径、定时器还接着跑），而相位/淡化那几个纯函数自己会把静默期减掉
	 * （`animationProgressMs`）。两边的分工在 `animation.ts` 里是一条硬约定。
	 */
	const animationElapsed = (): number | null => {
		if (animationStartedAt === null) return null;
		const elapsed = Date.now() - animationStartedAt;
		return isMarkAnimationOver(elapsed) ? null : elapsed;
	};

	/** 停表（幂等）：跑完、换会话、shutdown 都走这里（一次性定时器与节拍是同一个槽位）。 */
	const stopAnimationTimer = (): void => {
		if (animationTimer !== null) {
			clearInterval(animationTimer);
			animationTimer = null;
		}
	};

	/** 请求一帧重绘（拿不到 tui 时静默跳过：非 TUI 模式 / 假 ctx）。 */
	const requestFrame = (): void => {
		try {
			(tuiHandle as { requestRender?: () => void } | undefined)?.requestRender?.();
		} catch {
			// 拿不到 tui：这一帧就算了，不能把异常漏给宿主。
		}
	};

	/**
	 * 起跑一段入场动画（静默 500ms 后再动），到点自己停表并补画最后一帧。
	 *
	 * **静默期内不起节拍**：那 500ms 里每一帧渲染出来都一模一样（全 0 相位、文字全淡），
	 * 10 次重绘纯属白烧。所以这里先排一个一次性定时器（到点也只补一帧，把从「首帧」到
	 * 「动画起步」之间的那点时间差盖掉），静默期一过再换成节拍。
	 *
	 * 重入是常态（`session_start` 与 `session_tree` 可能连着来），所以**先清旧定时器再起新的** ——
	 * 否则两个 interval 会同时推进（本仓库在 voice 的 ESC 监听上踩过同形的重入坑）。定时器
	 * `unref`：1.5 秒的入场不该把 pi 进程的退出拖住。
	 */
	const startAnimation = (): void => {
		if (!logoEnabled() || !animationEnabled()) return;
		stopAnimationTimer();
		animationStartedAt = Date.now();
		startColorCache = undefined;
		const elapsedNow = (): number | null => animationElapsed();
		// 静默期结束的回调（也负责把节拍换成 interval）；`animationElapsed() === null` 只可能是
		// 「过点了」或「已被换会话 / shutdown 作废」，两种都该停。
		const arm = (): void => {
			const elapsed = elapsedNow();
			if (elapsed === null) {
				stopAnimationTimer();
				animationStartedAt = null;
				requestFrame();
				return;
			}
			if (isInLeadIn(elapsed)) {
				animationTimer = setTimeout(arm, MARK_ANIM_LEAD_IN_MS - elapsed);
				animationTimer.unref?.();
				return;
			}
			requestFrame();
			animationTimer = setInterval(() => {
				if (elapsedNow() === null) {
					// 到点：停表 + 补一帧，把落定态画上（此后走静态路径，逐字节等于动画前的 logo）。
					stopAnimationTimer();
					animationStartedAt = null;
					requestFrame();
					return;
				}
				requestFrame();
			}, MARK_ANIM_TICK_MS);
			animationTimer.unref?.();
		};
		arm();
	};

	/** 中途放弃动画（换会话 / 退出）：停表并让渲染立即回到静态路径。 */
	const abandonAnimation = (): void => {
		stopAnimationTimer();
		animationStartedAt = null;
	};

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

	/** `theme.colors` 那一层（只依赖「键 → 颜色」的形状）。
	 *
	 * 两重容忍是必须的：假主题（单测）根本没有 `colors`，而真主题在极端情况下也可能拿到
	 * 非对象（`setTerminalColors` 之前的部分构造）。返回空对象 → `pickStartColor` 挑不出
	 * 起点 → 走降级路径，不会把渲染弄挂。
	 */
	const colorsOf = (theme: Theme): ColorBag => {
		try {
			const colors = theme.colors as unknown;
			if (colors === null || typeof colors !== "object") return {};
			return colors as ColorBag;
		} catch {
			return {};
		}
	};

	/** 皮肤明暗（决定起点色往背景压还是往白底抬）。拿不到就当暗色。 */
	const appearanceOf = (theme: Theme): "dark" | "light" => {
		try {
			return theme.appearance === "light" ? "light" : "dark";
		} catch {
			return "dark";
		}
	};

	/**
	 * 淡化时要拉向的背景色。
	 *
	 * 先找 `background`（主题可选槽），再退到两个暗背景槽；都拿不到返回 undefined —— 那时
	 * 宁可不淡化（原样显示），也不要拉向一个猜出来的颜色。
	 */
	const fadeFallbackColor = (theme: Theme): Color | undefined => {
		const colors = colorsOf(theme);
		return colors.background ?? colors.toolPendingBg ?? colors.toolSuccessBg;
	};

	/** 具体颜色 → `#rrggbb`（缓存键；拿不到返回空串，不影响正确性）。 */
	const hexOf = (color: Color): string => {
		try {
			const rgb = colorToRgb(color);
			const channel = (n: number): string =>
				Math.min(255, Math.max(0, Math.round(n)))
					.toString(16)
					.padStart(2, "0");
			return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
		} catch {
			return "";
		}
	};

	/**
	 * 动画起点色（按主题缓存：一帧里要问十几次，而它要遍历全部颜色槽）。
	 *
	 * 缓存键是 accent 的具体色值 + 皮肤明暗 —— 两者变了一定是换了主题，重建即可。换肤时
	 * pi 会调 `invalidate()`，那里也会把缓存清掉（双保险）。
	 */
	const startColorFor = (theme: Theme, accent: Color): Color | undefined => {
		const accentHex = hexOf(accent);
		const appearance = appearanceOf(theme);
		if (startColorCache && startColorCache.accentHex === accentHex && startColorCache.appearance === appearance) {
			return startColorCache.color;
		}
		const picked = pickStartColor(colorsOf(theme), accent, COLOR_OPS);
		const color = picked === undefined ? undefined : startColorForAppearance(picked, appearance, COLOR_OPS);
		startColorCache = { accentHex, appearance, color };
		return color;
	};

	/**
	 * 动画中的逐格画笔：相位 0 什么都不画（还没出生），相位 1 就是 accent。
	 *
	 * 起点色与 accent 在**一次渲染里只取一次**（`startColorFor` 有缓存，`colorsOf` 是现取），
	 * 所以这个闭包里不重复算。
	 */
	const buildPainter =
		(theme: Theme, elapsedMs: number) =>
		(filled: boolean, row: number, col: number): string => {
			if (!filled) return " ".repeat(MARK_CELL.length);
			const phase = cellPhase(row, col, elapsedMs);
			// 还没出生：格子先空着（**不画半透明的色块** —— 静态 logo 在这一刻就是没有它）
			if (phase <= 0) return " ".repeat(MARK_CELL.length);
			const accent = colorsOf(theme).accent;
			// 降级 1：拿不到 accent 的具体颜色 —— 退回开关两态（相位过半即算亮），波形仍在
			if (accent === undefined) {
				return phase >= 0.5 ? theme.fg("accent", MARK_CELL) : " ".repeat(MARK_CELL.length);
			}
			// 降级 2：选不出起点色相 —— 起点 = accent，于是全程 accent（整块印记逐格亮起）
			const start = startColorFor(theme, accent) ?? accent;
			const color = colorForPhase(start, accent, phase, COLOR_OPS);
			return `${foregroundAnsi(color, modeOf(theme))}${MARK_CELL}\x1b[39m`;
		};

	/** 主题的颜色模式（与 `theme.fg` 同一条，落定帧的转义才对得上）。 */
	const modeOf = (theme: Theme): TerminalColorMode => {
		try {
			return typeof theme.getColorMode === "function" ? theme.getColorMode() : "truecolor";
		} catch {
			return "truecolor";
		}
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

	/**
	 * 动画期间的侧栏淡化主题：第 `row` 行的文字按「波头到达本行右端」的进度往背景色淡。
	 *
	 * 只拦上色、不动文字，所以布局与静态路径一致；`amount = 0` 时 `createFadeTheme` 会原样
	 * 转发 `theme.fg`，那一行就与静态路径逐字节相同。
	 */
	const sideThemeFor = (theme: Theme, row: number, elapsedMs: number) => {
		const amount = sideFadeAmount(row, elapsedMs);
		if (amount <= 0) return theme;
		const background = fadeFallbackColor(theme);
		if (background === undefined) return theme;
		return createFadeTheme(theme, { colors: colorsOf(theme), fadeTo: background, amount, ops: COLOR_OPS });
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
		const elapsed = animationElapsed();
		// 两行侧栏**各自按自己的行**淡入（标题在第 1 行、cwd 在第 2 行，后者晚 80ms 起淡）——
		// 「跟着扫过渐显」说的就是这件事，两行共用一个淡化量会让它们一起亮、看着像一块遮板。
		const rowTheme = (row: number) => (elapsed === null ? theme : sideThemeFor(theme, row, elapsed));
		const titleRow = sideTextStartRow(2);
		const wordmark = formatTitleLine(rowTheme(titleRow), VERSION, model, level);
		const where = rowTheme(titleRow + 1).fg("muted", shortenPath(ctx.cwd, homeDir()));
		const hints = buildHints(theme);
		const onboarding = poweredByLines(theme, width);

		// 提示行 / 说明段也过一遍截断：提示行本体 53 列、说明段（前缀 44 + 字形 15 = 59 列）更宽，
		// 加上 `MARK_INDENT` 那一格后在 53 / 59 列的终端上都会刚好超宽 —— 而 pi-tui 对超宽的行是
		// 直接抛错（整个 TUI 挂掉）。口径按**含缩进**的整行算（先扣掉那一格再裁），所以
		// 「每一帧都不超宽」不依赖终端多宽。说明段已经按整块退回句子，这里的截断只是兵底。
		const clampText = (line: string): string => truncateToWidth(line, Math.max(1, width - MARK_INDENT.length), ELLIPSIS);
		const clamp = (line: string | undefined): string | undefined => (line === undefined ? undefined : clampText(line));
		const onboardingLines = onboarding.map(clampText);

		// 窄终端：不画印记，退化成单行 wordmark（同样缩进一格，跟印记左边对齐）。
		if (width < MARK_WIDTH + MIN_SIDE_COLUMNS) {
			const room = Math.max(1, width - MARK_INDENT.length);
			return composeHeaderLines({
				logo: [`${MARK_INDENT}${truncateToWidth(wordmark, room, ELLIPSIS)}`],
				hints: clamp(hints),
				onboarding: onboardingLines,
			});
		}
		const sideRoom = Math.max(0, width - MARK_WIDTH - SIDE_GAP);
		// 逐格上色（整行包一层会让行尾的 trimEnd 失效，见 logo.ts 的 markLines）
		// 标题行必须跟 cwd 一样裁：pi-tui 对超出终端宽度的行是**直接抛错**
		// （`Rendered line N exceeds terminal width`），而模型 id 是外部输入、长度无上限。
		const clipped = [truncateToWidth(wordmark, sideRoom, ELLIPSIS), truncateToWidth(where, sideRoom, ELLIPSIS)];

		// 动画中：逐格按对角波相位上色（文字已在上面按行淡过了）。
		// 落定 / 未开动画时走下面那条**与改动前逐字节相同**的静态路径。
		if (elapsed !== null) {
			const logo = attachSideText(markLines(buildPainter(theme, elapsed)), clipped, SIDE_GAP);
			return composeHeaderLines({ logo, hints: clamp(hints), onboarding: onboardingLines });
		}
		const logo = attachSideText(
			markLines((filled) => (filled ? theme.fg("accent", MARK_CELL) : " ".repeat(MARK_CELL.length))),
			clipped,
			SIDE_GAP,
		);
		return composeHeaderLines({ logo, hints: clamp(hints), onboarding: onboardingLines });
	};

	const installHeader = (ctx: ExtensionContext) => {
		// 先交还上一段换会话窗口的冻结再装新 header：两步在同一个同步块里，中间出不了帧。
		guardRelease?.();
		guardRelease = undefined;
		if (ctx.mode !== "tui" || !logoEnabled()) return;

		let component: HeaderComponent | undefined;
		ctx.ui.setHeader((tui, theme) => {
			tuiHandle = tui;
			const own: HeaderComponent = {
				invalidate() {
					// 换肤：accent 的具体值变了，起点色缓存作废。
					startColorCache = undefined;
				},
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
		startAnimation();
	});

	// resume / fork / rewind 会换掉会话对象，header 得按新 ctx 重装（动画也重放一遍）。
	pi.on("session_tree", (_event, ctx) => {
		installHeader(ctx);
		startAnimation();
	});

	// resetExtensionUI 发生在本回调之后：先接管容器渲染，还原内置 header 时就不会出帧。
	// 同时停掉动画节拍 —— 这是「定时器不许活过会话」的那道兜底。
	pi.on("session_shutdown", () => {
		abandonAnimation();
		freezeHeader();
	});
}
