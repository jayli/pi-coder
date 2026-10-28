/**
 * session-list-bg/row.ts — `/resume` 列表**选中行**的底色重绘（纯逻辑，不 import pi）。
 *
 * ## 要修的是什么
 *
 * 用户 2026-10-28 定：会话内 `/resume` 弹出来的历史会话列表里，选中行要用**用户 prompt
 * 的底色**（主题槽 `userMessageBg`，与补全菜单选中行同一个 surface），不要 pi 原本的
 * `selectedBg`。
 *
 * 顺带修一个真 bug：选中行被缩略成 `…` 之后，`…` 往右的内容（含 `…` 本身与行尾的消息数/
 * 时间）**没有底色**。
 *
 * ## 根因
 *
 * pi 的 `SessionList.render`（`components/session-selector.js`）先截正文、再整行上底色：
 *
 *     const truncatedMsg = truncateToWidth(normalizedMessage, Math.max(10, availableForMsg), "…");
 *     ...
 *     if (isSelected) line = theme.bg("selectedBg", line);
 *     lines.push(truncateToWidth(line, width));
 *
 * 而 `truncateToWidth` 截断时写的是 `prefix + "\x1b[0m" + 省略号 + "\x1b[0m"`
 * （pi-tui `utils.js` 的 `finalizeTruncatedResult`）。`\x1b[0m` 是**全属性复位**，
 * 连整行开着的底色一起清掉 —— 于是省略号与它右边全部变成终端默认背景。
 * 第一次截断（正文那一截）**在任何终端宽度**都会留下那个裸 `\x1b[0m`，所以这条 bug
 * 与宽度无关，只要标题被缩略就出现；第二次 `truncateToWidth`（行已着色之后）只在极窄
 * 终端（`Math.max(10, …)` 兜到 10、行超宽）才再补一刀。
 *
 * ## 怎么修
 *
 * 在**输出层**重绘：不碰 pi 的渲染逻辑，只在这两处会清掉底色的序列后面把底色补回来 ——
 *
 *   - `\x1b[0m`（全复位）→ `\x1b[0m` + 新底色
 *   - `\x1b[49m`（只关背景）→ `\x1b[49m` + 新底色
 *
 * 行尾统一收一个 `\x1b[49m`。**可见字符一个不动、可见宽度不变**（只增删 SGR），所以
 * CJK / emoji / 折行统统不需要重新计算 —— 这也是它比「重新拼一遍这一行」安全的原因。
 *
 * 为什么不去重新实现那一行：行里除了正文还有树前缀、`›` 光标、右对齐的消息数与时间，
 * 重拼等于把 pi 的布局代码抄一遍，一升级就漂。这里只认两个 SGR 序列。
 *
 * ## 怎么认出「选中行」
 *
 * 选中行是**整行**被 `theme.bg("selectedBg", …)` 裹起来的，所以它的字节一定以那个
 * 背景 ANSI 开头；未选中行没有这个前缀。判据只用一个公开事实（主题槽的名字），
 * 不读任何私有字段。
 *
 * ## 第三件事（同日第二轮）：正文去掉加粗，改用强调色
 *
 * 用户 2026-10-28 定：选中行的正文文字**不要加粗**（pi 原样是 `theme.bold(styledMsg)`），
 * 改成 **`accent` 颜色**；而 `11 5h` 这类行尾的消息数/时间保持原来的 `dim`，不跟着变色。
 *
 * 手法同样是输出层重写，原因是这里有一个必须同时成立的约束：**可见宽度一格都不能变**。
 * pi 给 `SessionList.render` 的每一行收尾都调 `truncateToWidth(line, width)`，而它会算出
 * 超宽行时**直接抛**（`Line exceeds width`），所以「把 `[1m` 悄悄删掉」这种只改 SGR 的做法
 * 是唯一安全的路 —— 重排、重算列位都会在 CJK / emoji 上把宽度算错。
 *
 * 具体做法（每一条都对应一个会翻车的细节）：
 *
 *   - `\x1b[1m`（pi 的 `theme.bold` 开门）→ **不输出**，改成强调色 ANSI；
 *   - 粗体区间里 pi 还套着自己的前景色（命名会话是 `warning`、当前会话是 `accent`）——
 *     直接拿强调色**顶掉**它（只改 SGR、不叠加），否则用户看到的还是 warning；
 *   - `\x1b[22m`（关门）→ 先补一个 `\x1b[39m` 收掉强调色，再原样保留 `\x1b[22m`
 *     （**不能一起删**：`22m` 同时也是 `dim` 的 `\x1b[2m` 的关门，删了会让 faint 漏到行尾）；
 *   - 粗体区间里遇到 `\x1b[0m` / `\x1b[49m` → 复位后把**底色 + 强调色**都补回来
 *     （标题被截成 `…` 时 pi 会在粗体区间正中插一个裸 `\x1b[0m`，那一截是这次的 bug 现场）。
 *
 * 行尾的消息数/时间在粗体区间**之外**（`fg("dim", …)` 是单独拼上去的），所以一个字节都不动 ——
 * 这正是用户要求的「除了 `11 5h` 那段，其余全部 accent」。
 *
 * 皮肤没有 `accent` 槽时只去掉粗体、不染新色（宁可少一层观感，也不自造颜色）。
 */

/** 默认新底色：用户 prompt / 用户消息框的底色（用户 2026-10-28 定）。 */
export const DEFAULT_BG_SLOT = "userMessageBg";

/** 选中行正文颜色槽：`accent`（用户 2026-10-28 定）。 */
export const DEFAULT_TITLE_SLOT = "accent";

/** 选中行原本用的底色槽（pi 的 `SessionList.render` 里写死）。 */
export const SELECTED_ROW_SLOT = "selectedBg";

/** 全属性复位：连底色一起清掉。 */
const FULL_RESET = "\x1b[0m";
/** 只关背景（`theme.bg()` 的收尾）。 */
const BG_RESET = "\x1b[49m";
/** 粗体开关（chalk / `theme.bold`）。 */
const BOLD_ON = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
/** 只关前景。 */
const FG_RESET = "\x1b[39m";
/** 一条 SGR 序列。 */
const SGR = /\x1b\[[0-9;]*m/g;

/** 环境变量开关：`off` 关闭，其余（含未设）开启。 */
export function resolveSessionListBgEnabled(raw: string | undefined): boolean {
	return (raw ?? "").trim().toLowerCase() !== "off";
}

/** 解析目标槽位名：空 / 未设 → 默认槽位。 */
export function resolveSessionListBgSlot(raw: string | undefined): string {
	const trimmed = (raw ?? "").trim();
	return trimmed.length > 0 ? trimmed : DEFAULT_BG_SLOT;
}

/**
 * 解析选中行正文的颜色槽：空 / 未设 → `accent`；`off` / `none` / `-` → 空串（只去粗体、不染色）。
 * 返回空串是**有效选择**，与「没配」区分开，所以这里不能用 `??` 兜默认值。
 */
export function resolveSessionListTitleSlot(raw: string | undefined): string {
	const trimmed = (raw ?? "").trim();
	if (trimmed.length === 0) return DEFAULT_TITLE_SLOT;
	const lowered = trimmed.toLowerCase();
	return lowered === "off" || lowered === "none" || lowered === "-" ? "" : trimmed;
}

/**
 * 取色源：pi 的 `Theme` 实例（只用到这两个方法，注入后本模块与 pi 解耦）。
 * 传进来的槽位名不认识时**抛**（pi 的 `Theme.getBgAnsi` / `getFgAnsi` 就是这个行为），调用方兜。
 */
export interface RowColorSource {
	getBgAnsi(slot: string): string;
	getFgAnsi?(slot: string): string;
}

export interface RowPaintOptions {
	/** 选中行原本的底色 ANSI（通常是 `theme.getBgAnsi("selectedBg")`）。 */
	readonly from: string;
	/** 换成的底色 ANSI（通常是 `theme.getBgAnsi("userMessageBg")`）。 */
	readonly to: string;
	/**
	 * 正文的强调色 ANSI（通常是 `theme.getFgAnsi("accent")`）。
	 * 缺省 / 空串 → 只把粗体去掉，正文用皮肤默认前景色。
	 */
	readonly accent?: string;
}

/**
 * 把一条**已着色的选中行**换成另一种底色、并把正文的粗体换成强调色；同色时也把被
 * `\x1b[0m` 冲掉的部分补回来。
 *
 * 不是选中行（不以 `options.from` 开头）→ 返回同一个字符串，调用方据此判断有没有改动。
 * `from` / `to` 任一为空（皮肤没有这个槽）→ 同样原样返回，宁可不改也不要弄坏渲染。
 */
export function repaintSelectedRow(line: string, options: RowPaintOptions): string {
	const { from, to, accent } = options;
	if (from.length === 0 || to.length === 0) return line;
	if (!line.startsWith(from)) return line;
	let body = line.slice(from.length);
	// 行尾那个关背景是我们自己补的，先摘掉，最后统一收一次（否则会多出一对空序列）。
	if (body.endsWith(BG_RESET)) body = body.slice(0, -BG_RESET.length);
	if (body.length === 0) return line;
	const hasBold = body.includes(BOLD_ON);
	// 两处会清掉底色，都在它们**后面**把新底色补回来。
	//
	// `to === from` 时同样要跑：皮肤把 `selectedBg` 配成与 `userMessageBg` 同色时颜色已经对了，
	// 但 pi 截断时插的裸 `\x1b[0m` 照样会把底色清掉 —— 这个补色才是本次要修的那个 bug，
	// 与换不换色无关。真没东西可补（行里既没有两个复位、也没有粗体）且本来就同色时才是真正的空操作。
	if (to === from && !body.includes(FULL_RESET) && !body.includes(BG_RESET) && !hasBold) return line;
	return to + patchBody(body, to, accent ?? "") + BG_RESET;
}

/**
 * 逐个 SGR 走一遍选中行的正文，按终端语义重写。
 *
 * 要处理的取舍都来自 pi 那一行的拼装方式（`SessionList.render`）：
 *
 *     cursor    = fg("accent", "› ")                    // isSelected
 *     prefix    = fg("dim", treePrefix)                 // 树前缀，通常空
 *     styledMsg = messageColor ? fg(messageColor, msg) : msg
 *     styledMsg = bold(styledMsg)                       // isSelected
 *     rightPart = fg("dim", "42 now")
 *     line      = bg("selectedBg", cursor + prefix + styledMsg + 空格 + rightPart)
 *
 * 所以**正文就是那个 `\x1b[1m … \x1b[22m` 区间**（`isSelected && theme.bold`），
 * `› ` 与右对齐的消息数/时间都在它外面、各有自己的颜色 —— 这正是要保住的东西：
 * 用户 2026-10-28 只要求"正文"去粗体换 accent，行尾那截保持 `dim`。
 *
 * 两条规则：
 *
 *   - `\x1b[1m`（region 开门）→**不输出**（粗体去掉）；上了强调色就换成强调色。
 *   - region 内发出**任何** SGR 之后再补一次强调色 —— 因为 `bold(fg(warning, msg))` 里那个
 *     warning 会盖掉我们开的强调色，只有"后说的算"能把它按回去；`\x1b[0m`（pi 截断时插的）
 *     与 `\x1b[39m` 更是直接把它清掉，`…` 往右那截就靠这一下重新上色。
 *
 * region 外只做底色修补（`\x1b[0m` / `\x1b[49m` 会把整行底色清掉）—— 别的字节一律不动。
 * **只重写 SGR，可见字符一个不动**：宽度、折行、CJK 全部不用重算，pi-tui 那边也就不会
 * 因为超宽而抛错。
 */
function patchBody(body: string, bg: string, accent: string): string {
	const accentOn = accent.length > 0;
	let inBold = false;
	/** 强调色此刻是不是"生效中的前景色"（用来避免连续重复输出、也用来判断要不要收）。 */
	let accented = false;
	let out = "";
	let last = 0;

	const applyAccent = (): void => {
		if (!accentOn) return;
		out += accent;
		accented = true;
	};

	for (const match of body.matchAll(SGR)) {
		const token = match[0];
		const index = match.index ?? 0;
		out += body.slice(last, index);
		last = index + token.length;

		if (token === BOLD_ON) {
			// 粗体开门：整段不加粗，改成强调色（`\x1b[22m` 照旧留着当关门，它同时关 dim）。
			inBold = true;
			if (!accented) applyAccent();
			continue;
		}
		if (token === BOLD_OFF) {
			inBold = false;
			if (accented) {
				out += FG_RESET;
				accented = false;
			}
			out += token;
			continue;
		}
		// 正文里 pi 自己的前景色（命名会话是 `warning`、当前会话是 `accent`）：
		// 用户要的是"正文统一 accent"，所以直接用强调色顶掉，不叠两层序列。
		if (accentOn && inBold && isForegroundOnly(token)) {
			if (!accented) applyAccent();
			continue;
		}
		out += token;
		// 复位类序列连前景一起清，强调色与底色都得补回来。
		if (token === FULL_RESET || token === BG_RESET) {
			accented = false;
			out += bg;
			if (inBold && accentOn) applyAccent();
			continue;
		}
		if (token === FG_RESET) {
			accented = false;
			if (inBold && accentOn) applyAccent();
		}
	}
	out += body.slice(last);
	return out;
}

/** 只设置前景色的 SGR（`38;5` / `38;2` / `3x`），其余（`4x` 底色、`1`/`2` 属性）返回 `false`。 */
function isForegroundOnly(token: string): boolean {
	const body = token.slice(2, -1); // 去掉 `\x1b[` 与 `m`
	if (body.startsWith("38;")) return true;
	const parts = body.split(";");
	return parts.length === 1 && /^3[0-79]$/.test(parts[0] ?? "");
}

/**
 * 对一次 `render()` 的所有行做重绘。没有一行被改动时**返回原数组**（差分渲染按引用比较，
 * 每帧造新数组会让它以为整块都变了）。
 */
export function repaintSelectedRows(lines: readonly string[], options: RowPaintOptions): string[] {
	let changed = false;
	const out = lines.map((line) => {
		const next = repaintSelectedRow(line, options);
		if (next !== line) changed = true;
		return next;
	});
	return changed ? out : (lines as string[]);
}

/**
 * 从取色源解析出重绘参数。选中的「旧底色」或目标槽位拿不到时返回 `undefined`
 * （调用方按「这一帧不改」处理，别抛进 pi 的渲染 tick）。
 *
 * 正文强调色是**可缺**的：皮肤没有这个槽（或者显式选了 `off`）时只去粗体、不染色，
 * 不影响底色那半（它们互不依赖）。
 */
export function resolveRowPaintOptions(
	source: RowColorSource | undefined,
	slot: string = DEFAULT_BG_SLOT,
	titleSlot: string = DEFAULT_TITLE_SLOT,
): RowPaintOptions | undefined {
	if (!source) return undefined;
	const from = readSlot(source, SELECTED_ROW_SLOT, "getBgAnsi");
	const to = readSlot(source, slot, "getBgAnsi");
	if (from === undefined || to === undefined) return undefined;
	const accent = titleSlot.length > 0 ? readSlot(source, titleSlot, "getFgAnsi") : undefined;
	return accent === undefined ? { from, to } : { from, to, accent };
}

/** 读一个颜色槽，失败（皮肤没这个槽 / 非 TUI / 读色方法本身可缺）返回 `undefined`。 */
function readSlot(source: RowColorSource, slot: string, method: "getBgAnsi" | "getFgAnsi"): string | undefined {
	try {
		const read = source[method];
		if (typeof read !== "function") return undefined;
		const ansi = read.call(source, slot);
		return typeof ansi === "string" && ansi.length > 0 ? ansi : undefined;
	} catch {
		return undefined;
	}
}
