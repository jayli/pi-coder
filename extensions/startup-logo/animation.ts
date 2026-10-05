/**
 * animation.ts — 启动 logo 入场动画的纯逻辑：时间轴、逐格相位、起始色相槽的挑选。
 *
 * 需求（用户 2026-10-05 定）：启动时 logo 用 **1 秒**做完一段入场动画 —— 对角波自右向左
 * 扫过 4×4 格子，被扫到的格子从**另一个色相**渐显到 `accent`；右侧那两行文字（标题行与
 * cwd）跟着**自己所在行**一起渐显。落定态与旧的静态 logo **逐字节相同**（不是「看起来
 * 一样」，是走同一条 `theme.fg("accent", …)` 路径，见 `index.ts` 里的 settled 短路）。
 *
 * 本模块**不 import pi / pi-tui**（与同目录的 `logo.ts` 一个约定），所以 `node --test` 能直接
 * 跑：时间轴的每条不变量 —— 0 时刻什么都不画、最后一格恰好在 1000ms 落定、16 格延迟互不
 * 相同、相位单调、波头右→左且逐行左移 —— 全部在 `animation.test.ts` 里钉住。颜色怎么算、
 * ANSI 怎么拼留在 `index.ts`；这里只管「第 (row, col) 格在 elapsed 毫秒时该有多亮」与
 * 「起始色相该借哪个主题色槽」。
 *
 * ## 时间轴
 *
 * 一格的动画 = 「被波头点亮」+「用 `CELL_FADE_MS` 渐到 accent」两段，前者由延迟表算出：
 *
 *     延迟(row, col) = (COLS - 1 - col) × COLUMN_STEP_MS + row × ROW_STEP_MS
 *
 * 两项分别是**右→左**（col 越小越晚）与**上→下**（row 越大越晚，于是同一时刻左下角
 * 还没亮）。合起来就是一条从左下向右上倾斜的波前；`ROW_STEP_MS = COLUMN_STEP_MS / 2`
 * 让波前每下移两行才左退一列 —— 4×4 这么小的格子表里这是最接近 45°、也最读得出来的斜度
 * （再斜就几乎是「按列扫」了，见 `animation.test.ts` 里对两条极端格子的断言）。
 *
 * **同一格对角线上会同时点亮**，这是对角波的应有之义而不是巧合：`COLUMN_STEP_MS` 是
 * `ROW_STEP_MS` 的两倍，所以延迟只取决于 `2 × (COLS-1-col) + row` 这一个值 —— 4×4 里
 * 16 格压缩成 **10 条对角线**，`(0,0)` 与 `(3,3)` 都是 480ms（同一条线），真正最早的是
 * 右上角 `(0,3)`，最晚的是左下角 `(3,0)`（720ms）。`animation.test.ts` 钉的就是
 * 「延迟是这条对角线索引的函数」而不是「16 格互不相同」（后者本来就不成立）。
 *
 * 常数之间有一条**推导出来的**硬约束，不是几个独立的魔数：
 *
 *     动画时长 = max(延迟) + CELL_FADE_MS = 3 × COLUMN_STEP_MS + 3 × ROW_STEP_MS + CELL_FADE_MS
 *     结束时刻 = LEAD_IN_MS + 动画时长
 *
 * 取 160 / 80 / 280 正好 = 1000（`animation.test.ts` 拿这条等式当断言，所以以后谁改步长
 * 都会立刻在测试里看到「动画本身不再是 1 秒」）。最后一格（左下的 `(3, 0)`）在动画起点后
 * 720ms 出生、1000ms 落定。
 *
 * **静默期**（`MARK_ANIM_LEAD_IN_MS`，用户 2026-10-05 定 500ms）在这 1 秒之前：header 装上后
 * 先什么都不画 500ms，再开始这 1 秒 —— 所以从装上到落定的总时长是 1500ms。
 *
 * ## 起始色相从哪来
 *
 * 「色相渐变」需要一个**起点颜色**。本仓三套皮肤都是正规调色板，所以起点不自己造色，
 * 而是**借主题自己的一个色槽**（见 `pickStartToken`）—— 这样换肤时整段动画跟着皮肤走，
 * 不会突然冒出一个不属于这套配色的颜色，也不需要在这里造 OKHSL 颜色（那要另写一套色域
 * 映射）。借来的槽再往背景方向压暗一档当真正的起点（在 `index.ts` 做，用 pi-tui 的
 * `mixColors`），于是波形读起来是「暗的异色 → 亮的 accent」。
 *
 * **谁是合法起点是一份白名单**（`MARK_ANIM_START_TOKENS`），不是「离 accent 最远就行」：
 * 拿全套色槽跑最大距离，本机三套皮肤挑出来的分别是 `bashMode`（橙）、`selectedBg`（**背景**色）、
 * `thinkingXhigh`（**灰**）—— 后两个根本没有可见的色相（灰的色相角是任意的、背景色又暗到看不见），
 * 实测就是这么翻车的。所以先按白名单筛掉背景 / 灰 / 状态灯，只在**有色的前景槽**里比距离。
 */

import { MARK_COLS, MARK_ROWS } from "./logo.ts";

/**
 * 起跑前的**静默期**（毫秒）：用户 2026-10-05 定「启动后 500ms 再开始做动画」。
 *
 * 与 `MARK_ANIM_TOTAL_MS` 是两笔账：前者是「什么都不画、只有静态 logo」的等待，后者是动画
 * 本身的时长。两段相加才是从 header 装上到落定的总时长（1500ms）。分开记是因为下游的语义
 * 不同 —— 静默期里**每一格都是 0 相位**（与动画没开始时逐字节相同，所以首帧不会先闪一下），
 * 而动画期里那些格子正在渐显。
 *
 * 为什么要静默一下：动画原来在 header 装上的那一瞬间就开跑，而 header 恰好与 pi 启动时的
 * 其它绘制撞在一起（内置 header 的替换、已加载资源清单的填充），那一段的入场根本看不全 ——
 * 实测 tmux 取样里前 0.8s 捕到的都是静止帧，动起来时已经跑掉一半。
 */
export const MARK_ANIM_LEAD_IN_MS = 500;

/** 动画本身的时长（毫秒）。用户要求「一秒钟做完」，落定后不再画任何一帧。 */
export const MARK_ANIM_TOTAL_MS = 1000;

/** 相邻两列之间的延迟：右端先亮，每往左一列晚这么多。 */
export const MARK_ANIM_COLUMN_STEP_MS = 160;

/** 相邻两行之间的延迟：每往下一行晚这么多（= 列步长的一半 → 波前约 45°）。 */
export const MARK_ANIM_ROW_STEP_MS = 80;

/** 单格从「刚被点亮」到「完全落定成 accent」的时长。 */
export const MARK_ANIM_CELL_FADE_MS = 280;

/**
 * 定时器节拍（毫秒）。20fps：60fps 在这个只画 4 行的 header 上只是白烧 CPU，50fps 也无意义；
 * 33ms(30fps) 与 50ms 的观感差异在 1 秒的动画里看不出来，但定时器多跑 60% —— 取 50。
 */
export const MARK_ANIM_TICK_MS = 50;

/**
 * 可以作为起点色相的**白名单**（有序：距离并列时靠前的先选）。
 *
 * 只收「有色相、够亮、是前景」的槽。刻意不收的三类，都是实测挑出来过或一眼会翻车的：
 *   - **背景槽**（`selectedBg` / `*Bg`）：暗到读不出颜色，波形会像「没亮」；
 *   - **灰 / 注释槽**（`muted` / `dim` / `syntaxComment` / `thinking*` / `thinkingXhigh`）：
 *     近中性色的色相角是任意的，拿它当起点等于随机挑色相；
 *   - **状态灯 / diff 底色**（`success` 之外的那些 `*Bg`）：它们是给行底色用的，不是给人看的字。
 *
 * `success` 留在名单里（绿色，很多皮肤离 accent 很远），`error` 也留（红，同样常被选中）——
 * 这两个是用户天天在界面里看到的颜色，拿来当入场色不突兀。
 */
export const MARK_ANIM_START_TOKENS: readonly string[] = [
	"syntaxKeyword",
	"syntaxType",
	"syntaxFunction",
	"mdLink",
	"syntaxNumber",
	"warning",
	"mdHeading",
	"toolDiffAdded",
	"syntaxString",
	"success",
	"toolDiffRemoved",
	"error",
	"bashMode",
	"syntaxVariable",
	"toolTitle",
];

/** 起点色相与 accent 至少要差这么多度才值得借（差太少等于「亮度渐变」，不如不借）。 */
export const MARK_ANIM_MIN_HUE_DISTANCE = 60;

/**
 * 起点色相与 accent 的**目标**距离（度）。
 *
 * 不是「越远越好」：实测拿最大距离挑，1337 会选中 mdHeading（橙，178° 远），于是从橙到青的
 * 色相弧在相位中段穿过**纯绿**（`#507351`）—— 绿色在本套皮肤里是「新增行」的语义色，出现在
 * 启动画面上既不搭调也容易被读成“编辑中”。改成瞄一个 70° 的目标后，三套皮肤分别落在
 * 83° / 62° / 70°，中段是青绿、黄绿、蓝紫 —— 都是各自配色里本来就有的过渡带。
 */
export const MARK_ANIM_TARGET_HUE_DISTANCE = 70;

/** 夹到 [0, 1]；NaN 也当 0（时间戳算出 NaN 时宁可什么都不画，也不要抛穿渲染路径）。 */
const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/**
 * 缓动：smoothstep。线性渐显的起止两端在终端里能看出「啪」地亮起来，smoothstep 两端导数为 0，
 * 观感是「渐亮」而不是「切换」。相位本身仍单调递增，测试拿它做断言。
 *
 * 静默期内的负进度先夹到 0，所以缓动不必知道 `MARK_ANIM_LEAD_IN_MS` 的存在；但**夹取本身**
 * 就是「静默期里一格都不画」的实现 —— 它没有别的地方可落。
 */
export function easePhase(t: number): number {
	const p = clamp01(t);
	return p * p * (3 - 2 * p);
}

/** 第 (row, col) 格的出生时刻（毫秒，相对**动画起点**，不含静默期）。越界按行列钳制，不抛。 */
export function cellDelayMs(row: number, col: number): number {
	const r = Math.min(Math.max(Math.floor(row), 0), MARK_ROWS - 1);
	const c = Math.min(Math.max(Math.floor(col), 0), MARK_COLS - 1);
	return (MARK_COLS - 1 - c) * MARK_ANIM_COLUMN_STEP_MS + r * MARK_ANIM_ROW_STEP_MS;
}

/** 动画已经跑了多久（毫秒）：把静默期减掉并夹到 >= 0。**所有按格的函数都走这里**。 */
export function animationProgressMs(elapsedMs: number): number {
	return Math.max(0, (Number.isFinite(elapsedMs) ? elapsedMs : 0) - MARK_ANIM_LEAD_IN_MS);
}

/** 延迟表里最晚的那一格（动画的总步进时间，不含单格的渐显时长）。 */
export function lastCellDelayMs(): number {
	return (MARK_COLS - 1) * MARK_ANIM_COLUMN_STEP_MS + (MARK_ROWS - 1) * MARK_ANIM_ROW_STEP_MS;
}

/** 动画结束时刻（自 header 装上起算）= 静默期 + 动画本身。取的就是这条推导，不是另写一个 1500。 */
export function markAnimationEndMs(): number {
	return MARK_ANIM_LEAD_IN_MS + lastCellDelayMs() + MARK_ANIM_CELL_FADE_MS;
}

/** 是否还在**静默期**内（动画没开始；调用方据此判断「是否已经该起表」）。 */
export function isInLeadIn(elapsedMs: number): boolean {
	return elapsedMs < MARK_ANIM_LEAD_IN_MS;
}

/** 第 (row, col) 格的**缓动后**相位：0 = 还没出生（什么都不画），1 = 已落定成 accent。 */
export function cellPhase(row: number, col: number, elapsedMs: number): number {
	return easePhase((animationProgressMs(elapsedMs) - cellDelayMs(row, col)) / MARK_ANIM_CELL_FADE_MS);
}

/** 还没缓动的原始进度（测试与「是否需要继续画」的判定用它，观感用 `cellPhase`）。 */
export function cellProgress(row: number, col: number, elapsedMs: number): number {
	return clamp01((animationProgressMs(elapsedMs) - cellDelayMs(row, col)) / MARK_ANIM_CELL_FADE_MS);
}

/**
 * 第 `row` 行右侧文字**还剩多少淡化量**：1 = 完全看不见（还没轮到这一行），0 = 正常颜色。
 *
 * 与印记共用同一条时间轴：文字在「波头到达本行右端」时开始淡入（延迟 = `row × 行步长`，
 * 因为最右一列的列步长为 0），用同一个 `CELL_FADE_MS` 淡完 —— 用户选的「跟随扫过渐显」。
 * 静默期内进度被夹到 0 → 返回 1（文字仍该是「看不见」），否则会先亮一下再等动画开始。
 */
export function sideFadeAmount(row: number, elapsedMs: number): number {
	const r = Math.min(Math.max(Math.floor(row), 0), MARK_ROWS - 1);
	const delay = r * MARK_ANIM_ROW_STEP_MS;
	const progressed = easePhase((animationProgressMs(elapsedMs) - delay) / MARK_ANIM_CELL_FADE_MS);
	return 1 - progressed;
}

/** 动画是否已经结束（结束即落定，调用方不再重绘、不再起定时器）。 */
export function isMarkAnimationOver(elapsedMs: number): boolean {
	return elapsedMs >= markAnimationEndMs();
}

/**
 * sRGB 十六进制 → OKLab 色相角（度，0~360）。非 `#rgb` / `#rrggbb` 返回 undefined。
 *
 * 自己实现而不 import pi-tui 的 `colorToOklch`：本模块的约定是零依赖（见文件头），而这里
 * 只需要一个**用来挑槽的**相对量 —— 与 pi-tui 的口径一致性已在本机对照过三套皮肤的全部
 * 色槽（逐槽比对 OKLCH 色相，最大偏差 < 1°，见 `animation.test.ts` 里那条对照用例
 * 引用的实测）。色相用的是 OKLab 的极角，OKLCH / OKHSL 共用同一个角。
 *
 * **灰阶的色相角是没有意义的**（`a`、`b` 都近似 0，`atan2` 给出来的是数值噪声：实测
 * `#ffffff` 与 `#6d6d6d` 都落在 89.88°，黑色落在 0°）。所以「挑一个有色的起点槽」不能
 * 只靠色相距离，这就是 `MARK_ANIM_START_TOKENS` 白名单存在的原因；需要程序化判断一个
 * 颜色到底有没有色相时用 `hexToChroma`（< 0.02 就可以当灰）。
 */
export function hexToHue(hex: string): number | undefined {
	const lab = hexToOklab(hex);
	if (lab === undefined) return undefined;
	const hue = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
	return (hue + 360) % 360;
}

/**
 * sRGB 十六进制 → OKLab 色度（颜色的「彩度」有多大，0 = 纯灰）。
 *
 * 用来把「这个颜色到底有没有色相」变成可判定的：色相角对灰阶是噪声（见 `hexToHue`），
 * 但色度对灰阶稳定为 ~0 —— 本机实测 `#6d6d6d` / `#696969` / `#ffffff` 都在 0.005 以下，
 * 而三套皮肤的彩色槽都 > 0.03（`animation.test.ts` 拿它当白名单合理性的断言）。
 */
export function hexToChroma(hex: string): number | undefined {
	const lab = hexToOklab(hex);
	return lab === undefined ? undefined : Math.hypot(lab.a, lab.b);
}

/** 十六进制 → OKLab 三通道（内部分解，也是上面两个公开函数的共同实现）。 */
function hexToOklab(hex: string): { l: number; a: number; b: number } | undefined {
	const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!match?.[1]) return undefined;
	const digits = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
	const value = Number.parseInt(digits, 16);
	const channel = (shift: number): number => {
		const raw = ((value >> shift) & 0xff) / 255;
		// sRGB 传输函数 → 线性光
		return raw <= 0.04045 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
	};
	const r = channel(16);
	const g = channel(8);
	const b = channel(0);
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return {
		l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	};
}

/** 两个色相角之间的最短距离（0~180 度）。 */
export function hueDistance(first: number, second: number): number {
	const diff = Math.abs(((first % 360) + 360) % 360 - (((second % 360) + 360) % 360));
	return diff > 180 ? 360 - diff : diff;
}

/** 候选色槽：token 名 + 它的具体色值（hex）。 */
export interface HueToken {
	readonly token: string;
	readonly hex: string;
}

/**
 * 从候选里挑一个色相当起点的槽：取**白名单里距离最接近 `MARK_ANIM_TARGET_HUE_DISTANCE`**
 * 的那个（至少要差 `minDistance` 才合格）；都不合格（或解析不出色相）返回 undefined。
 *
 * 返回 undefined 不是错误：调用方退回「只用亮度渐变」（起点 = accent 压暗），动画照做，
 * 只是没有色相位移 —— 单色主题（或 NO_COLOR 环境下所有槽都解析不出颜色）走的就是这条。
 *
 * 距离并列时按 `MARK_ANIM_START_TOKENS` 的顺序打破。为什么瞄目标而不是取最远，见
 * `MARK_ANIM_TARGET_HUE_DISTANCE` 的实测账。
 */
export function pickStartToken(
	accentHex: string,
	candidates: readonly HueToken[],
	minDistance = MARK_ANIM_MIN_HUE_DISTANCE,
	targetDistance = MARK_ANIM_TARGET_HUE_DISTANCE,
): string | undefined {
	const accentHue = hexToHue(accentHex);
	if (accentHue === undefined) return undefined;
	let best: { token: string; offset: number; rank: number } | undefined;
	candidates.forEach((candidate) => {
		const rank = MARK_ANIM_START_TOKENS.indexOf(candidate.token);
		if (rank === -1) return;
		const hue = hexToHue(candidate.hex);
		if (hue === undefined) return;
		const distance = hueDistance(hue, accentHue);
		if (distance < minDistance) return;
		const offset = Math.abs(distance - targetDistance);
		if (best === undefined || offset < best.offset || (offset === best.offset && rank < best.rank)) {
			best = { token: candidate.token, offset, rank };
		}
	});
	return best?.token;
}
