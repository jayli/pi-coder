/**
 * explored-group / render —— `Explored` 分组块的画法。
 *
 * 目标形态（用户 2026-10-06 定，第四轮修订后）：
 *
 *     • Explored
 *       └ Search "bashOutput" in clients/pi
 *         **Read** …/ttt/CLAUDE.md, …/ttt/package.json      ← 加粗 = 原生 read 工具
 *         Read …/bg-tasks/bg_3.log                          ← 不加粗 = bash（cat/tail）
 *
 * ## 加粗 = 原生 `read` 工具（用户 2026-10-06 定）
 *
 * `cat f` 与原生 `read({path: f})` 的短语都是 `Read f`，屏幕上分不出来 —— 而它们是
 * 完全不同的两件事。所以**只有原生 `read` 工具**那一行的动词 `Read` 加粗；bash 转义出来的
 * Read（`cat` / `sed -n` / `head` / `tail` …）**不加粗**。
 *
 * **只加粗 `Read` 这一个词**，其后的路径 / 行号区间一律不带粗体。
 *
 * 这条标记靠 `buildEntries` 的一条硬约束成立：**连续 read 合并时按来源切段** ——
 * 来源一变（原生↔bash）就另起一行，所以**同一行里不可能两种来源混居**，
 * 「这行加粗没有」就是「模型调的是不是原生工具」的完整答案。
 * （2026-10-06 第二轮：分组不再按家族拆，所以这层保证从「不同组」下移到了「不同行」。）
 *
 * ## `└ ` 整块只出现一次（用户 2026-10-06 第三轮定）
 *
 * 只有**第一行**带 `└ `，其后的行（后续成员行，以及同一个 `read` 合并行折出来的续行）
 * 一律四格缩进、不再画拐角 —— 与 bash / codemode / web-search 结果树的
 *「`└ ` 整块只出现一次」同一条语言。
 *
 * ## 行合并：连续的 `read` 按来源分段合成一行
 *
 * 用户明确要求：「一次性读两个文件」显示成 `└ Read a, b`。规则：
 *   - 连续的 **read** 成员（不分来源）合并到同一行，用 `, ` 分隔 —— 但**来源一变就换行**：
 *     `**Read** a, b` 与 `Read c` 各占一行（保住加粗语义，见文件头）
 *   - 其他（search / list / git）**每次调用自成一行**
 *
 * 合并按**宽度**而不是固定个数：装满一行换下一行。装不下而折出的续行**重画 `Read `**
 *（`Read` 是这一行的动词，不重画就成了光秃秃一串路径）但**不重画 `└ `**；续行的 `Read`
 * 同样带粗体（它仍是那个原生调用的动词）。
 *
 * ## 状态只在**组头那颗圆点**上表达
 *
 * 用户 2026-10-06 明确：**行内不打勾、也不带圆点**。整组的状态由组头 `•` 一颗圆点表达：
 *
 *   | 组的状态 | 圆点 |
 *   |---|---|
 *   | 还有成员在跑（`running`） | `text` 槽 —— 白 |
 *   | 全部结束且无错 | `toolDiffAdded` —— 绿 |
 *   | 任一成员出错 | `toolDiffRemoved` —— 红 |
 *
 * 这与「工具块不打勾」是同一条思路：状态光用颜色打，不落成字面标记。
 *
 * ## 展开态
 *
 * `ctrl+o` 展开时不折 `… +N`，显示全部行。**成员块的完整内容**在这一态由各成员自己的
 * 渲染器负责 —— `renderCall` 里判断 `context.expanded`，展开的成员不再投 0 行
 *（接线见 `bash-command-collapse.ts` / `read-path-collapse.ts`）。
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { phraseForToolCall } from "./phrases.ts";
import { groupOf, type Group, type GroupMember } from "./registry.ts";

/** 分组最多画几行成员（超出的折成一行 `… +N`）；展开态不折。 */
export const GROUP_MAX_ROWS = 5;
/** 成员行的前缀：`└ `（树拐角 + 空格 = 2 列）。**整块只出现一次**，挂在第一行上。 */
const ROW_PREFIX = "└ ";
/** 第一行之后的行首缩进：`└ ` 同宽的空白，于是正文列与第一行对齐。 */
const ROW_INDENT = "  ";
/** 合并行里条目之间的分隔符。 */
const JOINER = ", ";
/** 组头文字（用户定：就叫 Explored）。 */
const TITLE = "Explored";

/** 一个什么都不画的组件（成员块用）。 */
export const EMPTY_COMPONENT = {
	render(): string[] {
		return [];
	},
	invalidate(): void {},
};

/** 组状态的圆点颜色槽。 */
export type GroupDotSlot = "text" | "toolDiffAdded" | "toolDiffRemoved";

/**
 * 组的合成状态 → 圆点色槽（用户 2026-10-06 定）：
 * 只要有成员还在跑就是白（`text`），跑完且有错是红，否则绿。
 */
export function groupDotSlot(group: Group): GroupDotSlot {
	if (group.members.some((m) => m.status === "error")) return "toolDiffRemoved";
	if (group.members.some((m) => m.status === "running")) return "text";
	return "toolDiffAdded";
}

/**
 * 该成员此刻的状态（`tool_execution_end` 时由 `index.ts` 写入）。
 *
 * `read` 的路径**不再带 `Read ` 前缀** —— 合并行自己会画一次（`Read a, b`），
 * 每个条目再带一次就成了 `Read a, Read b`。别的类别每行独立，前缀由短语自带。
 */
function labelFor(member: GroupMember, cwd: string | undefined): string {
	const phrase = phraseForToolCall(member.toolName, member.args, cwd) ?? member.toolName;
	if (member.kind === "read" && phrase.startsWith("Read ")) return phrase.slice("Read ".length);
	return phrase;
}

/**
 * 把成员排成「逻辑行」：连续 `read` 各自是一个条目，其余类别一个成员一个条目。
 *
 * 返回的是**条目**而不是最终行 —— 宽度切分在渲染时做（条目可能被拆到多行）。
 */
interface RowEntry {
	text: string;
	/** 该条目是否为 read 合并行（决定换行时是否重画 `Read ` 动词）。 */
	isRead: boolean;
	/**
	 * 该条目对应的成员是不是**原生 `read` 工具** —— 是的话 `Read` 这个词加粗。
	 *
	 * 按**该行自己的来源**算：连续 read 合并时来源一变就另起一行（见 `buildEntries`），
	 * 所以同一行里只会有一种来源，用第一个成员的 `toolName` 判定就够。
	 */
	boldRead: boolean;
}

/** 折行后的最终行。 */
interface OutputRow {
	text: string;
	/** 行首的 `Read ` 是原生工具的动词 → 只把它加粗（路径不加粗）。 */
	boldRead: boolean;
	/** 来自 read 条目（原生或 bash）→ 行号区间要上色（见 `paintReadSpans`）。 */
	isRead: boolean;
}

function buildEntries(group: Group, cwd: string | undefined): RowEntry[] {
	const entries: RowEntry[] = [];
	let reads: string[] = [];
	let readsAreNative = false;
	const flush = () => {
		if (reads.length === 0) return;
		entries.push({ text: `Read ${reads.join(JOINER)}`, isRead: true, boldRead: readsAreNative });
		reads = [];
		readsAreNative = false;
	};
	for (const member of group.members) {
		// 参数还没吐完的成员**不进树**（用户 2026-10-07 定：「bash 指令被吐完后…直接输出为
		// 折叠后的 Search」）。不滤的话，行内文字会跟着模型的 token 一点点长：
		// `└ bash` → `Search "auth"` → `Search "authorization" in proxy/`。
		// 置位见 `markMemberReady`；未 ready 的成员自己的块也投 0 行，所以屏幕上真的一行不出。
		if (!member.ready) continue;
		if (member.kind === "read") {
			const isNative = member.toolName === "read";
			// 来源一变就换行：同一行必须是同一种来源，否则「加粗 = 原生工具」立刻失真
			if (reads.length > 0 && isNative !== readsAreNative) flush();
			if (reads.length === 0) readsAreNative = isNative;
			reads.push(labelFor(member, cwd));
			continue;
		}
		flush();
		entries.push({ text: labelFor(member, cwd), isRead: false, boldRead: false });
	}
	flush();
	return entries;
}

/**
 * 把条目按宽度折成最终行（break-all，与 bash 侧 `hardWrapRows` 同一语义：
 * **装满到恰好放不下再断**，不提前折行，避免「行尾空一大截」）。
 *
 * `read` 合并行（`Read a, b, c`）先剥掉 `Read ` 再按 `, ` 切，逐段排；跨行的续行
 * **重画** `Read `（`Read` 是这一行的动词，不重画就成了光秃秃一串路径）。`└ ` 不在这里画 ——
 * 整块只有第一行带它（见文件头）。
 *
 * 单个条目**自己就超宽**（长路径在窄终端）时走 `hardWrap` 硬折 —— 否则那条会直接超出
 * 终端宽，被 pi 的渲染切掉尾部（实测定宽 40 列时）。
 *
 * **加粗在这里只传递标志、不拼 ANSI**：折行宽度按**剥掉颜色后的可见文本**算，
 * 拼在 `layoutRows` 里会把 ANSI 带进 `visibleWidth` 与 `hardWrap` 的字符循环，
 * 让宽度算法当场失真。上色统一在 `paintRow` 里做。
 */
/**
 * 折行后的中间形态：**保留「它属于哪个文件」**。
 *
 * 直接把每块的折行结果卷平（早先的 `flatMap`）会丢掉归属，于是续块与「下一个文件」
 * 在主循环里长得一模一样 —— 用户 2026-10-07 报的「第一个 Read 折行后，第二行又冒出一个 Read」
 * 就是这个：`cat <77 字文件名>` 在 79 列下折成两块，第二块拿到了自己的 `Read ` 前缀。
 * 同因的第二个症状更隐蔽：条目 A 的尾部碎块会被当成独立条目，与真实的 `b.ts` 用 `, ` 缝成
 * `Read z, b.ts`（看着像读了两个文件，实际是 A 被切断 + 多出一个不存在的名字）。
 */
interface Chunk {
	text: string;
	/** 是不是它所属**文件**的第一块 —— 只有首块带 `Read ` 动词，续块只缩进。 */
	startsItem: boolean;
}

function layoutRows(entries: RowEntry[], budget: number): OutputRow[] {
	const rows: OutputRow[] = [];
	for (const entry of entries) {
		if (!entry.isRead) {
			for (const text of hardWrap(entry.text, budget)) rows.push({ text, boldRead: false, isRead: false });
			continue;
		}
		// 每个文件先各自硬折（区间由 `wrapReadPiece` 整体保留），再逐块贴上首/续标记。
		// 首块总是被 `hardWrap` 填满，所以续块天然拼不上别的东西、必须独占一行。
		const chunks: Chunk[] = entry.text
			.slice("Read ".length)
			.split(JOINER)
			.flatMap((piece) =>
				wrapReadPiece(piece, Math.max(1, budget - "Read ".length), budget)
					.map((text, index) => ({ text, startsItem: index === 0 })));
		let current = "";
		// 当前行要不要画 `Read ` 前缀：只有「本行从一个新文件开始」时才画。
		// 同一个文件的折行续块独占一行且不带前缀（用户 2026-10-07 定）。
		let prefixed = false;
		const flush = () => {
			if (current === "") return;
			rows.push({
				text: prefixed ? `Read ${current}` : current,
				boldRead: prefixed && entry.boldRead,
				isRead: true,
			});
			current = "";
			prefixed = false;
		};
		for (const chunk of chunks) {
			if (!chunk.startsItem) {
				// 续块：先把属于自己的首行收掉，自己独占一行、不带前缀
				flush();
				current = chunk.text;
				prefixed = false;
				continue;
			}
			if (prefixed) {
				const candidate = `${current}${JOINER}${chunk.text}`;
				if (visibleWidth(`Read ${candidate}`) <= budget) {
					current = candidate;
					continue;
				}
			}
			// 来的是新文件：续块行不让它搭车，一律从新的一行（带 Read）开始
			flush();
			current = chunk.text;
			prefixed = true;
		}
		flush();
	}
	return rows;
}

/**
 * 折一个 read 段，**行号区间整体不拆**（`100-169` 被劈成两行就既丢了区间、又只剩半边颜色）。
 *
 * 做法：路径部分照旧 break-all，然后把区间贴到最后一段上；贴不下就给最后一段腾出区间宽度再重折
 * 那一段。区间是这一行唯一的结构化信息，值得为它让出字符级填满的那点收益。
 *
 * 说是「区间」靠行尾的 ` 数字[-数字]` 形状认，与 `paintReadSpans` 同一口径 —— 两处必须一致，
 * 否则会出现「折行认它是区间、上色不认」这种半边处理。代价是名为 `notes 2024`（带空格 + 纯数字、
 * 无扩展名）的文件会被当成带区间（多上点色 / 多折一行，纯观感，实测全库 0 例）。
 */
function wrapReadPiece(piece: string, budget: number, rowBudget: number): string[] {
	const match = piece.match(/ (\d+(?:-\d+)?)$/);
	if (!match || match.index === undefined) return hardWrap(piece, budget);
	const span = match[0];
	const head = piece.slice(0, match.index);
	const room = budget - visibleWidth(span);
	// 终端窄到连「Read + 区间」都放不下（`room <= 0`）→ 退回字符级折行，没有更好的选择
	if (room <= 0 || visibleWidth(`Read ${span}`) > rowBudget) return hardWrap(piece, budget);

	const chunks = hardWrap(head, budget);
	const last = chunks.pop() ?? "";
	if (visibleWidth(last + span) <= budget) {
		chunks.push(last + span);
		return chunks;
	}
	// 最后一段太长、贴上就超宽 → 只把这一段按「留出区间宽度」重折，前面的不动
	const tail = hardWrap(last, room);
	const tailLast = tail.pop() ?? "";
	return [...chunks, ...tail, tailLast + span];
}

/** break-all 硬折（按可见列填满再断）。 */
function hardWrap(text: string, budget: number): string[] {
	if (budget < 1) return [text];
	const out: string[] = [];
	let current = "";
	let used = 0;
	for (const ch of [...text]) {
		const width = visibleWidth(ch);
		if (used + width > budget && current !== "") {
			out.push(current);
			current = "";
			used = 0;
		}
		current += ch;
		used += width;
	}
	if (current !== "" || out.length === 0) out.push(current);
	return out;
}

/**
 * read 行里的行号区间上色：数字 `warning`、中间的横线用**前景色**（用户 2026-10-07 定）。
 *
 * 横线用 `text` 槽 —— 它就是主题的 `fg` 变量（`colors.text: "fg"`），也就是正文本来的颜色；
 * `theme.fg("fg", …)` 会抛 `Unknown theme color: fg`，槽名是 `text`。用户要求从 `dim` 改成前景色，
 * 为的是让那根横线的亮度与路径正文一致（`dim` 是刻意压暗的一档）。
 *
 * 在**纯文本**上做（宽度与折行算法不能被 ANSI 污染，见 `layoutRows` 的注释），
 * 所以上色只发生在这里，不影响任何一行的宽度。
 *
 * 按 `, ` 分段各自处理 —— 合并行 `Read a.ts 100-169, b.ts 1-45` 两段都要上色。
 *
 * 为什么用「行尾模式」而不是把区间当结构化字段传下来：折行是 break-all 的，
 * 一个区间本来就可能被硬折在两行里（窄终端），精确位置在折行后本就不存在。
 * 模式按「空格 + 纯数字」锚定在段尾，所以 `cat v2`（无空格）这类路径不会被误伤。
 */
function paintReadSpans(text: string, theme: any): string {
	return text
		.split(JOINER)
		.map((piece) => {
			const match = piece.match(/ (\d+)(?:(-)(\d+))?$/);
			if (!match || match.index === undefined) return piece;
			const head = piece.slice(0, match.index);
			const start = theme.fg("warning", match[1]!);
			if (match[2] === undefined) return `${head} ${start}`;
			return `${head} ${start}${theme.fg("text", match[2])}${theme.fg("warning", match[3]!)}`;
		})
		.join(JOINER);
}

/**
 * 把一行拼成最终文本：`Read` 是原生工具动词时**只把这两个词**加粗（用户 2026-10-06 定），
 * 路径不加粗；行号区间按上面 `paintReadSpans` 的口径上色（原生与 bash 的 Read 一视同仁）。
 *
 * 上色走 `theme.bold` / `theme.fg`；这里也是整块唯一上色的地方 ——
 * `layoutRows` 只传标志不拼 ANSI（理由见那边的注释）。
 */
function paintRow(row: OutputRow, theme: any): string {
	const text = row.isRead ? paintReadSpans(row.text, theme) : row.text;
	if (!row.boldRead) return text;
	// 只可能是行首那个 `Read `（`layoutRows` 只在 read 条目上置这个标志）
	return `${theme.bold("Read")}${text.slice("Read".length)}`;
}

/**
 * `Explored` 树的组件。
 *
 * 每帧按当前宽度重算（行列表短、纯字符串拼接），所以成员增减与状态变化立刻可见 ——
 * 缓存反而要多一套失效逻辑，不值得。
 *
 * 宽度预算：整块左边距 2 列（`• ` 对齐各工具块），行前缀 `└ ` 再占 2 列。
 */
export function createGroupTree(options: {
	groupId: string;
	theme: any;
	cwd: string | undefined;
	/** `ctrl+o` 展开态：不折 `… +N`。 */
	expanded: boolean;
}) {
	return {
		render(width: number): string[] {
			const group = groupOf(options.groupId);
			if (!group || group.members.length === 0) return [];
			// 一行都还没就绪（参数都在流）→ **连组头都不画**：用户 2026-10-07 要的是「指令吐完后
			// 直接出现」，而不是先冒一个空壳 `• Explored` 再慢慢长行。成员 ready 时会
			// `notifyLeader` 叫醒这里重渲，所以不会漏。
			if (!group.members.some((m) => m.ready)) return [];
			const theme = options.theme;
			const dot = `${theme.getFgAnsi(groupDotSlot(group))}\u2022\u001b[39m`;
			const lines: string[] = [`${dot} ${theme.fg("toolTitle", theme.bold(TITLE))}`];

			const rowBudget = Math.max(1, width - 4); // 左边距 2 + `└ ` 2
			const rows = layoutRows(buildEntries(group, options.cwd), rowBudget);
			const shown = options.expanded ? rows : rows.slice(0, GROUP_MAX_ROWS);
			const hidden = rows.length - shown.length;

			for (const [index, row] of shown.entries()) {
				const prefix = index === 0 ? ROW_PREFIX : ROW_INDENT;
				lines.push(`  ${theme.fg("muted", prefix)}${paintRow(row, theme)}`);
			}
			if (hidden > 0) {
				lines.push(`  ${ROW_INDENT}${theme.fg("muted", `… +${hidden}`)}`);
			}
			return lines;
		},
		invalidate(): void {},
	};
}
