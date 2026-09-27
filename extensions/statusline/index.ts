/**
 * statusline — 极简 statusline（替代 npm:@narumitw/pi-statusline）
 *
 * 只有一主行 + 一状态行（沿用原 pi-statusline 的两行结构），无配置文件、无 powerline 块、
 * 无 palette：颜色全走 `theme.fg(<语义色>)`，因此自动跟随当前主题（`theme` 是 pi 内部的
 * live Proxy 单例，`/theme` 换肤后下一次渲染即生效）。
 *
 * 主行形态：
 *
 *   🅼 qwen3.8-flash/xhigh | Ctx 0.0% | ᗌ main | (+0,-0)
 *   🅼 qwen3.8-flash/xhigh | Ctx 0.0% | ᗌ main | (+0,-0) | thinking   ← 生成中
 *   🅼 qwen3.8-flash/xhigh | Ctx 0.0% | ᗌ no git | (no git)          ← 不在 git 仓库
 *
 * 行首的 `🅼`（U+1F17C）是模型段图标（`line.ts` 的 `MODEL_ICON`，取代早期的 `Model:` 文字
 * 标签，省 4 列；再早一版是 `⚡️`）。它不是 RGI emoji，pi-tui 量 1 列（Ambiguous），终端同口径。
 * 模型段本体是 `ctx.model.id` + `ctx.thinkingLevel`
 * （live getter）拼成的 `<id>/<推理强度>`（level 读不到时只报 id）。刻意不加 `[1m]`
 * 那种上下文窗口后缀 —— 那是 Claude Code 的写法，pi 用不着。
 *
 * 换行策略：宁可截断也不折行 —— 每行都过 `truncateToWidth(..., width, "…")`；行首恒留一个
 * 空格，不顶格。
 *
 * 拆四个模块：`line.ts`（纯格式化）+ `git.ts`（读 diff，注入 exec）+ `footer-guard.ts`
 * （换会话期间冻结 footer，防默认 footer 闪一帧）+ 本文件（pi 事件接线）。
 * 前三个都不 import pi / pi-tui，所以 `node --test clients/pi/extensions/statusline/*.test.ts`
 * 能直接跑。
 *
 * git 读取一律在后台做（渲染路径上只有一次 Map 查找）：`turn_end` / `agent_end` /
 * `tool_execution_end` 防抖 400ms 刷一次，分支变化立即刷，另有 30s 兜底轮询。
 *
 * 换会话（`/new`、`/clear`、`/resume`、fork、rewind）时 pi 会先把 footer 还原成内置那只、
 * 清掉所有 `setStatus`，新会话 `session_start` 才让我们重装 —— 中间那几十毫秒会真的出帧，
 * 于是底部「闪」一下。本扩展用 `footer-guard.ts` 在渲染路径上把这段窗口冻住（重放上一帧的
 * 行），原因与约束见那个文件的头注释；关掉它只需把 `PI_STATUSLINE_FREEZE` 设为 `off`。
 *
 * 启动那一段（进程刚起来、`session_start` 还没轮到我们）走的是另一条路：`footer-suppress.ts`
 * 在扩展工厂里就把 `FooterComponent.prototype.render` 换成返回 0 行，内置 statusline 一帧
 * 都不出现（原因、时机与兜底见那个文件的头注释）。它由 `PI_STATUSLINE_BOOT_SUPPRESS=off` 关闭。
 */

import { FooterComponent as PiFooterComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readGitDiffStat } from "./git.ts";
import { findRenderContainer, freezeFooterContainer, releaseFooterGuard } from "./footer-guard.ts";
import { suppressBuiltInFooter } from "./footer-suppress.ts";
import {
	STATUSLINE_KEY,
	ELLIPSIS,
	type StatuslineState,
	composeFooterLines,
} from "./line.ts";

const GIT_POLL_INTERVAL_MS = 30_000;
const GIT_DEBOUNCE_MS = 400;
const FROZEN_DISABLED = (process.env.PI_STATUSLINE_FREEZE ?? "").trim().toLowerCase() === "off";
const BOOT_SUPPRESS_DISABLED = (process.env.PI_STATUSLINE_BOOT_SUPPRESS ?? "").trim().toLowerCase() === "off";

/** footer 容器要的是这个组件对象；只要 render/dispose 形状，便于在守卫里按身份比对。 */
interface FooterComponent {
	render(width: number): string[];
	dispose(): void;
	invalidate(): void;
}

export default function statusline(pi: ExtensionAPI) {
	// 工厂在 TUI 创建之前跑，所以这里就能把内置 footer 静音：窗口内它渲染 0 行，
	// 等下面 `installFooter` 把我们的组件挂上去再交还（见 footer-suppress.ts）。
	const releaseBuiltInFooter: (() => void) | undefined = BOOT_SUPPRESS_DISABLED
		? undefined
		: suppressBuiltInFooter(PiFooterComponent);
	let generation = 0;
	let activeTarget: { cwd: string; generation: number } | undefined;
	let requestRender: (() => void) | undefined;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let abortController: AbortController | undefined;
	let refreshInFlight = false;
	let refreshQueued = false;

	const state: StatuslineState = {
		streaming: false,
		activeTools: new Map<string, number>(),
		diffStat: undefined,
	};

	// 冻结窗口要用的四样：TUI 根（找容器）、当前 footer 组件、它的容器、上一帧渲染出的行。
	let tuiHandle: unknown;
	let footerComponent: FooterComponent | undefined;
	let footerContainer: unknown;
	let lastFooterLines: string[] | undefined;
	let guardRelease: (() => void) | undefined;

	const render = () => requestRender?.();

	const refreshDiffStat = async (target: { cwd: string; generation: number }) => {
		if (target !== activeTarget) return;
		if (refreshInFlight) {
			refreshQueued = true;
			return;
		}
		refreshInFlight = true;
		abortController?.abort(new DOMException("Statusline Git refresh replaced", "AbortError"));
		const controller = new AbortController();
		abortController = controller;
		try {
			const next = await readGitDiffStat(
				(command, args, options) => pi.exec(command, args, options),
				target.cwd,
				controller.signal,
			);
			if (target !== activeTarget || controller.signal.aborted) return;
			state.diffStat = next;
			render();
		} catch {
			if (target === activeTarget) {
				state.diffStat = undefined;
				render();
			}
		} finally {
			if (abortController === controller) abortController = undefined;
			refreshInFlight = false;
			if (refreshQueued && target === activeTarget) {
				refreshQueued = false;
				void refreshDiffStat(target);
			}
		}
	};

	const scheduleDiffRefresh = (delayMs: number) => {
		const target = activeTarget;
		if (!target) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		if (delayMs <= 0) {
			debounceTimer = undefined;
			void refreshDiffStat(target);
			return;
		}
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			void refreshDiffStat(target);
		}, delayMs);
	};

	const cancelDiffRefresh = () => {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = undefined;
		}
		abortController?.abort(new DOMException("Statusline Git refresh cancelled", "AbortError"));
		refreshQueued = false;
	};

	const resetState = () => {
		state.streaming = false;
		state.activeTools.clear();
		state.diffStat = undefined;
	};

	const installFooter = (ctx: ExtensionContext) => {
		// 先交还上一段换会话窗口的冻结再装新 footer：两步在同一个同步块里，中间出不了帧。
		guardRelease?.();
		guardRelease = undefined;
		cancelDiffRefresh();
		generation += 1;
		resetState();
		// print / rpc / json 模式没有 footer，别白跑 git。
		activeTarget = ctx.mode === "tui" ? { cwd: ctx.cwd, generation } : undefined;
		ctx.ui.setStatus(STATUSLINE_KEY, undefined);
		if (!activeTarget) {
			requestRender = undefined;
			// print / rpc 模式没有 footer，不会有人来装，直接交还内置那只。
			releaseBuiltInFooter?.();
			return;
		}
		const target = activeTarget;

		// 挂上我们的组件前先交还内置那只：两条语句之间是同一个同步块，出不了帧。
		// 放在 `setFooter` 之前（而不是之后）是为了万一它抛错也不会让底部空着。
		releaseBuiltInFooter?.();
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			tuiHandle = tui;
			const unsubscribeBranch = footerData.onBranchChange(() => {
				state.diffStat = undefined;
				tui.requestRender();
				scheduleDiffRefresh(0);
			});
			const clock = setInterval(() => scheduleDiffRefresh(0), GIT_POLL_INTERVAL_MS);

			const component: FooterComponent = {
				dispose() {
					unsubscribeBranch();
					clearInterval(clock);
					// 只有仍属当前会话时才清，避免旧 footer 的 dispose 抹掉新会话的状态。
					if (target === activeTarget) {
						activeTarget = undefined;
						state.diffStat = undefined;
						requestRender = undefined;
					}
				},
				invalidate() {},
				render(width: number): string[] {
					// 截断 / 缩进 / 不折行的约定在 line.ts 里，统一由单测覆盖。
					const lines = composeFooterLines(theme, ctx, footerData, state, width, truncateToWidth);
					// 换会话时按身份比对我们是否还在容器里，不在就拿这份行重放（见 footer-guard.ts）。
					lastFooterLines = lines;
					return lines;
				},
			};
			footerComponent = component;
			return component;
		});

		// 组件此刻已被 pi 挂进 footer 容器（`setFooter` 是同步的），按对象身份认出那个容器；
		// 换会话时冻结要用。顺手解除别的扩展实例遗留的接管（`/reload` 之后可能有一次）。
		footerContainer = findRenderContainer(tuiHandle, footerComponent);
		if (footerContainer) releaseFooterGuard(footerContainer);
		scheduleDiffRefresh(0);
	};

	/**
	 * 换会话窗口内把 footer 钉在上一帧：pi 紧接着（在我们的 `session_shutdown` 回调之后）会
	 * 还原内置 footer 并清空 statuses，此时接管容器渲染，默认 footer 一帧都不会出。
	 */
	const freezeFooter = () => {
		if (FROZEN_DISABLED || !footerContainer || !footerComponent) return;
		const component = footerComponent;
		const lines = lastFooterLines;
		guardRelease = freezeFooterContainer({
			container: footerContainer,
			ownComponent: component,
			frozenRender: (width) =>
				lines
					? lines.map((line) => truncateToWidth(line, width, ELLIPSIS))
					: component.render(width),
		});
	};

	const releaseFooter = (ctx: ExtensionContext) => {
		generation += 1;
		cancelDiffRefresh();
		activeTarget = undefined;
		resetState();
		requestRender = undefined;
		ctx.ui.setFooter(undefined);
		ctx.ui.setStatus(STATUSLINE_KEY, undefined);
		freezeFooter();
	};

	const bumpTool = (toolName: string, delta: number) => {
		const next = (state.activeTools.get(toolName) ?? 0) + delta;
		if (next <= 0) state.activeTools.delete(toolName);
		else state.activeTools.set(toolName, next);
	};

	pi.on("session_start", (_event, ctx) => {
		installFooter(ctx);
	});

	// resume / fork / rewind 会换掉会话对象，footer 得按新 ctx 重装
	pi.on("session_tree", (_event, ctx) => {
		installFooter(ctx);
		render();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		releaseFooter(ctx);
	});

	pi.on("model_select", () => render());

	pi.on("thinking_level_select", () => render());

	pi.on("agent_start", () => {
		state.streaming = true;
		render();
	});

	pi.on("turn_start", () => {
		state.streaming = true;
		render();
	});

	pi.on("agent_end", () => {
		state.activeTools.clear();
		scheduleDiffRefresh(GIT_DEBOUNCE_MS);
		render();
	});

	// agent_end 之后 pi 还可能自动重试 / 压缩 / 跑排队消息，settled 才算真停
	pi.on("agent_settled", () => {
		state.streaming = false;
		state.activeTools.clear();
		render();
	});

	pi.on("turn_end", () => {
		scheduleDiffRefresh(GIT_DEBOUNCE_MS);
		render();
	});

	pi.on("tool_execution_start", (event) => {
		bumpTool(event.toolName, 1);
		render();
	});

	pi.on("tool_execution_end", (event) => {
		bumpTool(event.toolName, -1);
		scheduleDiffRefresh(GIT_DEBOUNCE_MS);
		render();
	});
}
