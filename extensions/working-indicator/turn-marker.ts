/**
 * turn-marker.ts — 回合结束后取代 spinner 的那一行「结束符」的纯文本逻辑。
 *
 * 需求（用户 2026-10-07 定）：一轮对话跑完，spinner 直接消失、不留痕迹；想让它原地变成
 * 一条「这个回合跑了多久、几点结束」的静态行，形如
 *
 *     ✻ Churned for 3m 37s · done 11:52 PM
 *
 * 落点在 `working-indicator/index.ts`（它持有回合时钟 `turnStartedAt`）；本文件只管
 * **文本**，不碰 UI、不 import 任何 pi / pi-tui 模块，所以 `node --test` 能直接跑：
 *
 *     node --test clients/pi/extensions/working-indicator/turn-marker.test.ts
 *
 * 四个决定（都是用户选的，改之前先看这里）：
 *   - **词随机取**：十个词的表，每回合随机一个（不是轮换、不是固定）；
 *   - **行首 `✻`**：Claude Code 回合结束行同款六角星（不是字面 `*`、不是 recap 的 `✦`）；
 *   - **颜色 dim**：整行（含 `✻`）走 `dim`，与 recap 行里 `Recap:` 标签同档 —— 比摘要
 *     正文（`text`）与 `✦`（`accent`）都安静，符合「痕迹」而不是「结论」的定位；
 *   - **只在正常完成时出**：`outcome === "completed"` 才画，ESC / 报错保持现状。
 *
 * 时长不在这里格式化：复用 index.ts 的 `formatDuration`（与 spinner 上的读秒同一套文案，
 * `<60s`→`42s`、`≥60s`→`1m 23s`、`≥1h`→`1h 23m 32s`），由调用方算好传进来 —— 两个
 * 数字口径同源，用户看到的结束时长不会和 spinner 最后一帧对不上。
 */

/**
 * 结束符词表。用户给的十个词，按原文顺序（含 `Ping-ponging` 的连字符写法）；
 * 大小写、词形（`Churned` 与 `Grinding` 混用）都照抄，不做归一。
 */
export const TURN_MARKER_VERBS = [
	"Churned",
	"Spun",
	"Thrashed",
	"Grinding",
	"Chugging",
	"Ping-ponging",
	"Looping",
	"Fizzling",
	"Flickering",
	"Stalled",
] as const;

/** 行首标记：Claude Code 回合结束行同款的六角星（用户 2026-10-07 定）。 */
export const TURN_MARKER_GLYPH = "✻";

/**
 * 结束符的 widget key。落在编辑器上方的 widget 区（与 recap 摘要 / 任务清单同一个区，
 * pi 会给这个区补一个前导空行），位置就是 spinner 原来看得见的那一行。
 */
export const TURN_MARKER_WIDGET_KEY = "turn-end";

/** `Math.random` 兼容的取数函数；单测里喂固定值把边界钉死。 */
export type RandomFn = () => number;

/**
 * 随机取一个词。`random()` 按约定返回 `[0, 1)`，但注入的假函数（或将来有人换实现）可能
 * 给出 1 —— 下标夹住，绝不让它越界成 `undefined`：结束符是一个回合的最后一笔，不该
 * 因为一个随机数在渲染层炸掉。
 */
export function pickTurnVerb(random: RandomFn = Math.random): string {
	const raw = Math.floor(random() * TURN_MARKER_VERBS.length);
	const index = Math.min(TURN_MARKER_VERBS.length - 1, Math.max(0, raw));
	return TURN_MARKER_VERBS[index];
}

/**
 * 结束时刻：`11:52 PM`（12 小时制、分钟补零、`AM`/`PM` 大写）。
 *
 * 刻意手写而不走 `toLocaleTimeString`：需求就这一个形状，手写不受 ICU / 语言环境影响
 * （本机 `zh-CN` 会给出 `23:52`，而状态行的其余文案全是英文）。0 点 / 12 点按惯例显示
 * `12:00 AM` / `12:00 PM`（`hours % 12 === 0` 特判成 12）。
 */
export function formatEndClock(date: Date): string {
	const hours = date.getHours();
	const minutes = date.getMinutes();
	const period = hours < 12 ? "AM" : "PM";
	const hour12 = hours % 12 === 0 ? 12 : hours % 12;
	return `${hour12}:${String(minutes).padStart(2, "0")} ${period}`;
}

/**
 * 整行形状：`✻ <词> for <时长> · done <时刻>`。
 * 三段都是调用方算好的现成文本（词来自 `pickTurnVerb`、时长来自 `formatDuration`、
 * 时刻来自 `formatEndClock`），这里只负责把它们按固定形状拼起来 —— 形状本身有单测。
 */
export function formatTurnMarker(verb: string, duration: string, clock: string): string {
	return `${TURN_MARKER_GLYPH} ${verb} for ${duration} · done ${clock}`;
}
