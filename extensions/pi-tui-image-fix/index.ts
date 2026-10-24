/**
 * index.ts — pi 启动时自动给 bundle 打「内联图不要整屏重画」补丁。
 *
 * 修的 bug：regular（非全屏）模式下 transcript 一旦超过一屏，**每出现一张新的内联图
 * 就闪一次** —— 屏幕先跳一下、随即回到底部，同时终端 scrollback 被真的抹掉。根因是
 * pi-tui `TuiMainScreen.doRender()` 里那段 kitty 图片预清理守卫：图片块只要有一部分
 * 落在视口底边之外就走 `fullRender(true)`（写 `\x1B[2J\x1B[H\x1B[3J`）。实现细节与
 * 改法见 `patch.ts` 顶部。
 *
 * ## 为什么是「扩展改 bundle」而不是「扩展改行为」
 *
 * `read` 的图片由 pi 自己的 `Image` 组件绘制，`ToolRenderContext.showImages` 只读，
 * 工具渲染器拿不到图片绘制权 ⇒ 没有任何扩展层的接缝能改这件事。唯一可行的位置是
 * runtime 真正执行的那份 bundle chunk。
 *
 * ## 自愈语义（这是关键——回答了「pi update 之后要不要重跑」）
 *
 * `pi update --self` 会换掉整个 `dist/bundle/chunks/`。本扩展**每次启动**都检查一次：
 *
 *   - 缺补丁 → 补上，并 `notify` 一行；
 *   - 已打过 → 静默（不打扰）；
 *   - 锚点找不到（上游改了这段代码，或已经自己修好了）→ **什么都不做**，只在中枢日志
 *     记一句；宁可不修，也不要往陌生代码里塞字符串。
 *
 * 所以升级后**不需要手动重跑**：下一次启动 pi 就自动补回。代价是升级后那一会话仍用旧
 * 代码（从第二次启动起恢复正常）。
 *
 * ## 关掉
 *
 * `PI_TUI_IMAGEFIX=off` 完全停用（连状态检查都不跑）。想恢复上游原始字节：
 * `node cli.ts --restore`。
 */

import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyPatch, describeStatus, status } from "./patch.ts";

/**
 * 诊断日志。**不用 console.***：扩展的 stderr 会干扰 TUI（alt-screen 里冒一行会打乱
 * 布局）。写文件而不是写屏幕，出问题时可查。
 */
function log(line: string): void {
	try {
		const dir = `${process.env.HOME}/.pi/agent`;
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(`${dir}/pi-tui-image-fix.log`, `[${new Date().toISOString()}] ${line}\n`);
	} catch {
		// 记不下就算了：这个扩展失败绝不能让 pi 起不来。
	}
}

export default function (pi: ExtensionAPI) {
	if ((process.env.PI_TUI_IMAGEFIX ?? "").toLowerCase() === "off") {
		log("disabled via PI_TUI_IMAGEFIX=off");
		return;
	}

	// 扩展加载期就修：此刻 bundle 已经加载完，但这一帧还没开始画，顺序上是安全的。
	let notice: string | undefined;
	try {
		const before = status();
		const result = applyPatch();
		if (!result.ok) {
			log(`apply failed (${result.reason}): ${result.detail}`);
		} else if (result.changed) {
			log(`applied to ${result.relative} (backup ${result.backup})`);
			notice = "内联图闪烁修复已重新应用（pi 升级后自愈）";
		} else if (result.reason === "already-patched") {
			log(`already patched: ${describeStatus(result.status)}`);
		} else {
			// anchor-missing 等：不打扰用户，只留痕迹。
			log(`skipped (${result.reason}): ${describeStatus(before)}`);
		}
	} catch (error) {
		log(`unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	}

	if (notice) {
		// 只有真的改了文件才提示 —— 每次启动都弹一行会很烦。
		pi.on("session_start", (_event, ctx) => {
			try {
				ctx.ui.notify(notice, "info");
			} catch {
				// stale ctx / 非交互模式：忽略。
			}
		});
	}
}
