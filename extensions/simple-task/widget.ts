/**
 * widget.ts — 清单渲染，样式参照 @tintinweb/pi-tasks。
 *
 * 照搬的样式要素（pi-tasks `src/ui/task-widget.ts`）：
 *   - 头部一行：`● N tasks (X done, Y in progress, Z open)`，整体 accent 色
 *   - 任务行两空格缩进，格式 `  <符号> <dim 的 #id> <正文>`
 *   - 已完成：success 色符号 + dim 且带删除线的正文
 *   - 进行中：accent 色星形 spinner 帧 + accent 色正文 + 省略号（表示仍在跑）
 *   - 待办：无色符号（◻）+ 普通正文
 *   - 溢出：`    … and N more`，dim
 *   - 整行按终端宽度截断，截断标记用 "..."（三个 ASCII 点）而非 "…" ——
 *     这是 pi-tasks 的 `truncation` 默认值，注释里说明它是 pi-tui 自己的默认。
 *
 * 颜色**全部走 theme.fg()**，一处硬编码颜色都没有 —— 所以跟着 pi 主题走，
 * 换主题就换配色，不需要改这里。
 *
 * 2026-09-24 之前头部在含 plan-mode 镜像条目时不画（那套镜像已随 plan-mode 的
 * execute 态一起删除，头部恢复为永远画）。
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { countByStatus, type State } from "./types.ts";

export const GLYPHS = {
	header: "●",
	pending: "◻",
	inProgress: "◼",
	done: "✔",
	overflow: "…",
	truncation: "...",
} as const;

/** pi-tasks 的星形 spinner 帧序列，原样沿用。 */
// 刻意去掉了 pi-tasks 原序列末尾的 ✽ —— 它比前面几帧粗重，转起来会突兀。
// export const SPINNER = ["+", "✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼"] as const;
// 换成了静态的 “▣”
export const SPINNER = ["▣","▣"] as const;

/** pi-tasks 的 DEFAULT_MAX_VISIBLE_TASKS。超出部分折叠成 "… and N more"。 */
export const MAX_VISIBLE = 10;

export function buildWidgetLines(state: State, frame: number, theme: Theme, width: number): string[] {
	const tasks = state.tasks;
	if (tasks.length === 0) return [];

	const safeWidth = Math.max(1, width);
	const truncate = (line: string): string => truncateToWidth(line, safeWidth, GLYPHS.truncation);

	const { done, inProgress, pending } = countByStatus(state);
	const parts: string[] = [];
	if (done > 0) parts.push(`${done} done`);
	if (inProgress > 0) parts.push(`${inProgress} in progress`);
	if (pending > 0) parts.push(`${pending} open`);
	const noun = tasks.length === 1 ? "task" : "tasks";
	const statusText = `${tasks.length} ${noun} (${parts.join(", ")})`;

	// 头部永远画：它是这一块唯一的总量行。（2026-09-24 之前含 plan-mode 镜像条目时
	// 不画头部，那套镜像已随 plan-mode 的 execute 态一起删除。）
	const lines: string[] = [truncate(`${theme.fg("accent", GLYPHS.header)} ${theme.fg("accent", statusText)}`)];

	const visible = tasks.slice(0, MAX_VISIBLE);
	const hidden = tasks.length - visible.length;

	for (const task of visible) {
		const dimId = theme.fg("dim", `#${task.id}`);

		if (task.status === "done") {
			// 完成项：success 符号 + dim 删除线正文（id 与正文一起划掉）
			const glyph = theme.fg("success", GLYPHS.done);
			lines.push(truncate(`  ${glyph} ${theme.fg("dim", theme.strikethrough(`#${task.id} ${task.text}`))}`));
			continue;
		}

		if (task.status === "in_progress") {
			// 进行中：星形帧随 frame 转动，正文 accent + 省略号表示还没结束
			const glyph = theme.fg("accent", SPINNER[frame % SPINNER.length]);
			lines.push(truncate(`  ${glyph} ${dimId} ${theme.fg("accent", task.text + GLYPHS.overflow)}`));
			continue;
		}

		lines.push(truncate(`  ${GLYPHS.pending} ${dimId} ${task.text}`));
	}

	if (hidden > 0) {
		lines.push(truncate(theme.fg("dim", `    ${GLYPHS.overflow} and ${hidden} more`)));
	}

	return lines;
}

