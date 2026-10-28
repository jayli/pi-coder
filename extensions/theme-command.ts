/**
 * theme-command — /theme 指令：列出全部主题，上下键**实时预览**，回车落盘，Esc 取消。
 *
 * 为什么需要它：内置只有 `/settings` → Theme 这条深路径（还混着 light/dark 自动模式），
 * 想换皮肤要点好几层。`/theme` 是一步直达的选择器，而且带预览。
 *
 * 核心是 `ctx.ui.setTheme()` 的**两条路径语义完全不同**（interactive-mode.js 的 ExtensionUIContext
 * + theme-controller.js）：
 *   - 传 **Theme 对象** → `setThemeInstance()` → 只在内存里换色，**不写 settings.json**；
 *   - 传 **名字字符串** → `setThemeName()` → 应用 **且立刻写 settings.json**（settingsManager.save()）。
 * 所以预览必须走对象路径，只有回车确认才走名字路径 —— Esc 取消后 settings.json 全程没被动过。
 *
 * 交互流程：
 *   - `/theme`            → 打开选择器（SelectList + 色板样本区），上下键即预览
 *   - `/theme <name>`     → 直接切换并落盘（名字不存在就报错并列出可用主题）
 *   - 非 TUI 模式         → 只提示，不做任何切换（print/json 模式下 ctx.ui 是 noOpUIContext，
 *                           setTheme 恒返回 {success:false}，没必要静默失败）
 *
 * 预览的两种呈现（都在同一个选择器里）：
 *   1. **整屏换色**：setThemeInstance 会 ui.invalidate() + 重绘，transcript / 编辑器 / statusline
 *      全部跟着换 —— 这是最真实的预览。选择器自身的 SelectList 配色用的是 `getSelectListTheme()`，
 *      它的回调闭包引用的是 pi 的全局 theme proxy（globalThis 共享），所以列表自己也实时换色。
 *   2. **色板样本区**：用候选主题实例自己的 token 画 5 行样本（核心色 / markdown / 代码+diff+tool /
 *      背景块 / thinking 档位），终端太矮看不出整屏差别时也能直接对比。
 *
 * 已知取舍（都是刻意选的，别"顺手优化"）：
 *   - 取消时也用**对象路径**恢复原主题，而不是名字路径。名字路径会把 `settings.json` 里
 *     `theme: "light/dark"`（自动模式）或未设置（按终端探测）的情况**改写成固定名字**，
 *     这是取消操作不该有的副作用。代价：`setThemeInstance()` 内部会 `stopThemeWatcher()`，
 *     所以预览过又取消之后，本次进程内主题文件的热重载失效（重启 pi 或回车确认即恢复，
 *     因为 `setTheme(name)` 会带 enableWatcher 重新起 watcher）。
 *   - 没预览过就取消（打开后直接 Esc）→ 什么都不做，不动主题也不动 watcher。
 *   - 色板/标题/边框一律**每次 render 现算**（见 LiveText），不把 theme 颜色预烘进缓存 ——
 *     tui.md「Invalidation and Theme Changes」：预烘的 ANSI 串在换主题后不会更新。
 *   - `DynamicBorder` 在 jiti 加载的扩展里必须显式传色函数（它的无参默认值依赖 pi 自己那份
 *     module cache 里的 theme，扩展侧可能是另一个 cache）。
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, truncateToWidth, type Component, type SelectItem } from "@earendil-works/pi-tui";

/** SelectList 一次最多显示几行（色板还要占 5 行，别让选择器顶满屏） */
const MAX_VISIBLE = 8;

type PickerResult = { action: "apply"; name: string } | { action: "cancel"; previewed: boolean };

/**
 * 每次 render 现算文本行的最小组件。
 *
 * pi 的 `Text` 会把内容（含 ANSI）缓存起来，换主题后 `invalidate()` 只清缓存、不会重新着色，
 * 所以预烘过颜色的文本会留着旧主题的颜色。这里干脆不缓存：每帧用当前 theme 重新拼。
 */
class LiveText implements Component {
	constructor(private readonly build: (width: number) => string[]) {}

	render(width: number): string[] {
		return this.build(width);
	}

	invalidate(): void {
		// 无缓存，无需清理
	}
}

/** 色板样本区：用候选主题自己的 token 画几行，覆盖 pi 里最常见的着色场景 */
function swatchLines(theme: Theme, width: number): string[] {
	const row = (...parts: string[]) => truncateToWidth(`  ${parts.join("  ")}`, width);

	return [
		// 核心色
		row(
			theme.fg("accent", "accent"),
			theme.fg("success", "success"),
			theme.fg("warning", "warning"),
			theme.fg("error", "error"),
			theme.fg("muted", "muted"),
			theme.fg("dim", "dim"),
		),
		// markdown
		row(
			theme.fg("mdHeading", "# Heading"),
			theme.fg("mdCode", "`code`"),
			`${theme.fg("mdLink", "[link]")}${theme.fg("mdLinkUrl", "(url)")}`,
			`${theme.fg("mdListBullet", "•")} item`,
			theme.fg("mdQuote", "> quote"),
		),
		// 语法高亮 + diff + 工具名
		row(
			`${theme.fg("syntaxKeyword", "function ")}${theme.fg("syntaxFunction", "name")}${theme.fg("syntaxPunctuation", "(")}${theme.fg("syntaxString", '"str"')}${theme.fg("syntaxPunctuation", ")")} ${theme.fg("syntaxComment", "// note")}`,
			theme.fg("toolDiffAdded", "+added"),
			theme.fg("toolDiffRemoved", "-removed"),
			theme.fg("toolTitle", "tool"),
		),
		// 背景块（bg token 只有这几个，全列出来）
		row(
			theme.bg("userMessageBg", theme.fg("userMessageText", " user ")),
			theme.bg("toolPendingBg", theme.fg("muted", " pending ")),
			theme.bg("toolSuccessBg", theme.fg("toolOutput", " ok ")),
			theme.bg("toolErrorBg", theme.fg("error", " err ")),
			theme.bg("selectedBg", theme.fg("text", " selected ")),
		),
		// thinking 档位（编辑器边框色）
		row(
			theme.fg("thinkingOff", "off"),
			theme.fg("thinkingMinimal", "minimal"),
			theme.fg("thinkingLow", "low"),
			theme.fg("thinkingMedium", "medium"),
			theme.fg("thinkingHigh", "high"),
			theme.fg("thinkingXhigh", "xhigh"),
			theme.fg("thinkingMax", "max"),
		),
	];
}

/** 打开选择器；返回用户的选择（undefined = 组件没能打开） */
async function pickTheme(ctx: ExtensionContext): Promise<PickerResult | undefined> {
	const themes = ctx.ui.getAllThemes();
	const currentName = ctx.ui.theme?.name;
	const items: SelectItem[] = themes.map((t) => ({
		value: t.name,
		label: t.name,
		description: t.name === currentName ? "(current)" : undefined,
	}));

	return ctx.ui.custom<PickerResult>((tui, theme, _keybindings, done) => {
		const container = new Container();

		// 预览状态：色板画哪个主题、以及有没有真的动过全局主题（决定取消时要不要恢复）
		let previewTheme: Theme = ctx.ui.getTheme(currentName ?? "") ?? theme;
		let previewed = false;

		container.addChild(new DynamicBorder((s) => theme.fg("border", s)));
		container.addChild(
			new LiveText((width) => [
				truncateToWidth(
					`  ${theme.bold(theme.fg("accent", "Select theme"))}  ${theme.fg("dim", "↑↓ preview · enter apply · esc cancel")}`,
					width,
				),
			]),
		);

		const selectList = new SelectList(items, Math.min(items.length, MAX_VISIBLE), getSelectListTheme(), {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 32,
		});
		const currentIndex = themes.findIndex((t) => t.name === currentName);
		if (currentIndex !== -1) selectList.setSelectedIndex(currentIndex);

		selectList.onSelectionChange = (item) => {
			// 对象路径 = 内存预览，不写 settings.json
			const instance = ctx.ui.getTheme(item.value);
			if (!instance) return; // 名字在列表里但加载失败：保持当前主题不动
			previewTheme = instance;
			previewed = true;
			ctx.ui.setTheme(instance);
			tui.requestRender();
		};
		selectList.onSelect = (item) => done({ action: "apply", name: item.value });
		selectList.onCancel = () => done({ action: "cancel", previewed });

		container.addChild(selectList);
		// 主题列表与下方色卡之间空一行：两者都是多行块，紧贴在一起分不清两个区域的边界。
		container.addChild(new Spacer(1));
		container.addChild(new LiveText((width) => swatchLines(previewTheme, width)));
		container.addChild(
			new LiveText((width) => [
				truncateToWidth(`  ${theme.fg("dim", `${themes.length} themes · current ${currentName ?? "unknown"}`)}`, width),
			]),
		);
		container.addChild(new DynamicBorder((s) => theme.fg("border", s)));

		// Container 不带 handleInput，键盘要自己转发给 SelectList；鼠标交给 Container 分发
		// （SelectList 自带 handleMouse，点击同样会触发预览/选择）
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
			handleMouse: (event) => container.handleMouse(event),
		};
	});
}

export default function (pi: ExtensionAPI) {
	// 给 `/theme <TAB>` 用的主题名缓存：getArgumentCompletions 没有 ctx，只能靠这里。
	// session_start 会在新建 / resume / fork 时刷新；注意 /reload 重载扩展后缓存会清空，
	// 要等下一次 session_start 或手动跑一次 /theme 才重新有补全。
	let themeNames: string[] = [];

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		themeNames = ctx.ui.getAllThemes().map((t) => t.name);
	});

	pi.registerCommand("theme", {
		description: "Switch pi theme (live preview while browsing)",
		getArgumentCompletions: (prefix: string) => {
			// getArgumentCompletions 只有 prefix、没有 ctx，拿不到 ctx.ui.getAllThemes()，
			// 所以用 session_start / 上次调用时缓存下来的名字（见下方 themeNames）。
			// 缓存为空（例如刚 /reload 还没开新会话）就返回 null，交给内置补全，不瞎猜。
			const items = themeNames
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/theme needs interactive mode", "warning");
				return;
			}

			const themes = ctx.ui.getAllThemes();
			themeNames = themes.map((t) => t.name);
			if (themes.length === 0) {
				ctx.ui.notify("No themes available (was --no-themes passed?)", "warning");
				return;
			}

			const arg = args.trim();
			if (arg) {
				// 直接切换：先精确匹配，再忽略大小写兜底
				const match = themes.find((t) => t.name === arg) ?? themes.find((t) => t.name.toLowerCase() === arg.toLowerCase());
				if (!match) {
					ctx.ui.notify(`Unknown theme "${arg}"; available: ${themes.map((t) => t.name).join(" / ")}`, "error");
					return;
				}
				applyTheme(ctx, match.name);
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					`A picker needs TUI mode; use /theme <name>: ${themes.map((t) => t.name).join(" / ")}`,
					"warning",
				);
				return;
			}

			const originalName = ctx.ui.theme?.name;
			const result = await pickTheme(ctx);
			if (!result) return;

			if (result.action === "cancel") {
				if (!result.previewed) return; // 没动过主题，无需恢复
				// 对象路径恢复：settings.json 全程没写过，所以原样不动（代价见文件头注释）
				const restore = originalName ? ctx.ui.getTheme(originalName) : undefined;
				if (restore) ctx.ui.setTheme(restore);
				else ctx.ui.notify(`Cancelled, but the original theme could not be restored (${originalName ?? "unknown"}); pick again with /theme`, "warning");
				return;
			}

			applyTheme(ctx, result.name);
		},
	});
}

/** 名字路径 = 应用 + 写 settings.json（唯一会落盘的入口） */
function applyTheme(ctx: ExtensionContext, name: string): void {
	const result = ctx.ui.setTheme(name);
	if (!result.success) {
		ctx.ui.notify(`Failed to switch to ${name}: ${result.error}`, "error");
		return;
	}
	ctx.ui.notify(`Switched to ${name}`, "info");
}
