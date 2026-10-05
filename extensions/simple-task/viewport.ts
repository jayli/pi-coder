/**
 * viewport.ts — 任务清单的滚动视口。
 *
 * 为什么需要它：widget 一帧最多画 8 条任务项（用户 2026-10-02 定；原为 pi-tasks 的
 * `DEFAULT_MAX_VISIBLE_TASKS` = 10），于是超过 8 条的清单里第 9 条起永远看不见。
 * 用户 2026-10-02 的要求：执行到第 9 项时列表要**跟着往下滚**，让当前项进入视口，
 * 而不是把新的部分藏在 `… and N more` 后面。
 *
 * 三条规则：
 *   - **锚点 = 第一个未完成项**（`in_progress` 或 `pending`）。它不需要先被标成
 *     in_progress —— 前 8 项全完成的那一刻，第 9 项（此时还是 pending）就该露出来。
 *   - **最小位移**：锚点已经在窗口内就不动（不为了把锚点居中而滚，那会让用户在
 *     连续完成几项时看到列表无谓地跳动）；越出下沿才下滚到锚点正好落在窗口末行。
 *   - **全部完成时停在末尾**：没有未完成项就没有锚点，窗口贴住最后 8 条。
 *     若退回开头，收尾那一刻列表会突然跳回 #1，把刚做完的几项又推到屏幕外。
 *
 * 窗口里**永远是最多 maxVisible 条任务项**；两侧的 `… N more` 提示行由渲染方另加，
 * 不占这 8 个名额 —— 用户明确要求「视口范围内的项数就是视口大小」。
 *
 * 本文件不 import pi / pi-tui（与 gap.ts 同一约定），可直接 `node --test`。
 */

import type { Task } from "./types.ts";

/** 视口大小。用户 2026-10-02 从 pi-tasks 的 `DEFAULT_MAX_VISIBLE_TASKS`（10）改成 8。 */
export const MAX_VISIBLE = 8;

export interface Viewport {
	/** 窗口起止下标（`end` 为开区间，即 `tasks.slice(start, end)`）。 */
	start: number;
	end: number;
	/** 窗口上方 / 下方被折叠掉的条数，供渲染方写 `… N more`。 */
	head: number;
	tail: number;
}

/**
 * 算出当前这一帧要显示哪一段任务。
 *
 * @param tasks      全量任务（顺序即用户看到的顺序）
 * @param maxVisible 视口大小，默认 {@link MAX_VISIBLE}
 */
export function computeViewport(tasks: readonly Task[], maxVisible: number = MAX_VISIBLE): Viewport {
	const total = tasks.length;
	const size = Math.min(maxVisible, total);

	const lastStart = total - size;
	// 锚点：第一个非 done 项。没有（全做完）就贴住末尾 —— 见文件头的第三条规则。
	const anchor = tasks.findIndex((task) => task.status !== "done");
	// 让锚点落在窗口**末行**（`anchor - size + 1`），再夹在 [0, lastStart] 里：
	// 锚点本来就在窗口内时这个值 <= 0，被夹回 0 也就是「窗口不动」。
	const start = Math.max(0, Math.min(anchor < 0 ? lastStart : anchor - size + 1, lastStart));
	const end = start + size;

	return { start, end, head: start, tail: total - end };
}
