/**
 * explored-group / classify —— 判断一次工具调用**是否属于「只读探查」**，以及它归哪一类。
 *
 * 纯函数，零 pi 依赖（`node --test` 能直跑，不需要加载器）。三个消费方：
 *   - `registry.ts`：决定一个 tool 块要不要投 0 行、并进当前分组
 *   - `phrases.ts`：决定这一行说什么（分类 → 短语动词）
 *   - `index.ts`：决定一个 tool 调用要不要**打断**当前分组（不可折叠 = 断）
 *
 * ## 三类可折叠来源
 *
 * | 来源 | 折叠条件 |
 * |---|---|
 * | `read` | 永远（读文件就是读文件） |
 * | 原生 `grep` / `find` / `ls` | 永远 |
 * | `bash` | **全只读**：命令里每个有效段的首个动词都在只读白名单里，且没有写重定向 |
 *
 * 「全只读」这条是刻意的**保守**判定 —— 宁可少折叠也不要折叠错：
 *
 *   - `cd X && grep -n foo a.ts | head -20`         → fold（`grep`/`head` 都在白名单）
 *   - `node --test index.test.ts 2>&1 | grep -E …`  → **不 fold**（`node` 不在白名单）
 *   - `cat > /tmp/x.mjs <<'EOF' … EOF`              → **不 fold**（写重定向）
 *   - `cd X && python3 - <<'PY' … open(p,"w") …`   → **不 fold**（`python3` 不在白名单）
 *
 * 也就是说：**「跑了个东西，只是顺带 grep 了一下」不算泛读**，它是要看输出的真实执行。
 * 目标 session 里 `node --test … | grep -E '^ℹ'` 这类占了不少，折叠它们会让「我跑了测试」
 * 这件事从屏幕消失 —— 那是错的。
 *
 * ## heredoc 必须先剥掉
 *
 * `cat > f <<'EOF' … EOF` 的正文会被按行切成 shell 段，里面 `import` / `const` / `}` 之类
 * 全被当命令。`stripHeredocBodies` 先去掉正文再切段；**同时保留**命令头（含 `cat > f`），
 * 于是写重定向照样能命中 → 不可折叠。
 */

/** 只读动词白名单：出现即算「这一段的意图是看」。 */
const READ_VERBS = new Set([
	// 内容检索
	"grep", "egrep", "fgrep", "rg", "ag", "ack",
	// 路径列举 / 元信息
	"ls", "find", "fd", "tree", "eza", "du", "stat", "realpath", "readlink",
	"which", "type", "mdfind", "locate", "dirname", "basename",
	// 读内容 / 计数 / 比较
	"cat", "bat", "head", "tail", "less", "more", "nl", "tac",
	"cut", "tr", "wc", "diff", "comm", "jq", "yq", "file",
	"sort", "uniq", "column", "fold", "md5", "shasum", "sha256sum", "xxd", "od", "strings",
	// sed / awk 默认只读（`sed -i` 由 in-place 判定单独拦，见下）
	"sed", "awk", "gawk", "perl",
]);

/** `git` 的只读子命令。其余（add/commit/push/checkout/…）一律不可折叠。 */
const GIT_READ_SUBCOMMANDS = new Set([
	"status", "log", "diff", "show", "branch", "rev-parse", "config",
	"ls-files", "blame", "cat-file", "describe", "shortlog", "remote", "grep",
]);

/** 纯导航/输出动词：不影响判定，直接跳过。 */
const NOOP_VERBS = new Set([
	"cd", "pushd", "popd", "echo", "printf", "export", "set", "unset", "source", ".",
	"true", "false", ":", "pwd", "sleep", "wait", "test", "[", "[[", "date", "uname",
]);

/** 命令包装器：跳过它们取真正的动词。 */
const WRAPPERS = new Set(["sudo", "env", "nohup", "command", "exec", "builtin", "time", "xargs"]);

export type FoldKind = "read" | "search" | "list" | "git" | null;

/**
 * pi 的「紧凑形态」判定里属于 `skill` 的那一类 —— `read` 一个 `SKILL.md`。
 *
 * 照抄 pi `read.js` 的 `getCompactReadClassification`（模块私有，只能复刻）：文件名是
 * `SKILL.md` 就是 skill 形态，标签取**所在目录名**（`…/skills/commit/SKILL.md` → `commit`）。
 *
 * 为什么这一条要在 classify 层（而不是渲染层）判：用户 2026-10-06 报「读 Skill 文件都变成了
 * `└ Read …/skills/systematic-debugging/SKILL.md`」，要求恢复 pi 原来的
 * `• [skill] commit (ctrl+o to expand)`。分组是在 `renderCall` 里**最先**做的（命中就投 0 行、
 * 由组长画树），它一旦接手，pi 渲染器里那个 `[skill]` 分支就永远跑不到 —— 所以豁免必须发生在
 * 「这个块要不要入组」这一层，而不是渲染层改个字。
 *
 * 实测规模（全库 440 个会话、2613 次 read）：`SKILL.md` **332 次**、pi 自带
 * docs/examples 194 次、`AGENTS.md`/`CLAUDE.md` 88 次 —— 三种紧凑形态都真实高频。
 * 但**只豁免 SKILL.md**（用户 2026-10-06 定）：`read docs` / `read resource` 仍在折叠范围内，
 * 因为用户点名的只有 skill 这一种观感，而「读了一遍 pi 的文档」与「读了一遍项目文件」
 * 在探索语境里没有区别。
 */
export function isSkillRead(toolName: string, args: unknown): boolean {
	if (toolName !== "read") return false;
	const pathArg = (args as { path?: unknown } | null | undefined)?.path;
	if (typeof pathArg !== "string" || pathArg === "") return false;
	// 只需要认「最后一段是不是 SKILL.md」。两种分隔符都收（与 pi 的 basename 同义），
	// 不做 resolve —— 判定只依赖文件名本身，路径解析失败（读一个不存在的文件）时行为一致。
	const trimmed = pathArg.replace(/[/\\]+$/, "");
	const lastSegment = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
	return lastSegment === "SKILL.md";
}

export interface FoldVerdict {
	/** 可折叠时非 null —— 同时就是这一行短语的类别。 */
	kind: FoldKind;
	/**
	 * **参数还没到齐，现在不能下结论**（见 `isPendingArgs`）。
	 *
	 * 与 `kind: null` 是两件完全不同的事：`pending` 是「等会儿再说」，`null` 是「确定不可折叠」。
	 * 把它当成后者就会在参数到达之前就断组 —— 那正是用户看到的「连续调用没合并」。
	 */
	pending?: boolean;
	/** 不可折叠的原因（只用于日志/调试，不参与判定）。 */
	reason?: string;
}

/**
 * 去掉 heredoc 正文，保留命令头。
 *
 * 支持 `<<EOF` / `<<'EOF'` / `<<"EOF"` / `<<-EOF`（缩进版本：终止行允许前导 tab）。
 * 终止行按**去空白后完全相等**匹配（`<<-` 语义里 tab 会被剥掉，这里统一 trim 更宽松，
 * 代价只是正文里恰好出现同名的一行会提前结束 —— 那种脚本极少，而且判定方向只会更保守）。
 */
export function stripHeredocBodies(command: string): string {
	const lines = command.split("\n");
	const out: string[] = [];
	let pending: string | null = null;
	for (const line of lines) {
		if (pending !== null) {
			if (line.trim() === pending) pending = null;
			continue;
		}
		const match = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
		out.push(line);
		if (match) pending = match[2]!;
	}
	return out.join("\n");
}

/**
 * 按 shell 分隔符切段：`;` `\n` `&&` `||` `|` `&`。
 *
 * **引号内的分隔符不切**（`grep -n 'a;b' f` 是一段），heredoc 正文早已剥掉。
 * `>&2` / `2>&1` 这类 fd 复制先抹平成空格 —— 否则 `&` 会把一段切成两段。
 */
export function splitShellSegments(command: string): string[] {
	// 只抹平 fd 复制（`2>&1` / `>&2`）—— 里面的 `&` 会被当成段分隔符。
	// **不能**在这里剥重定向目标：分类要靠它判断「有没有写出去」，剥了 `>/tmp/x` 就永远
	// 判不出写。取词那一侧用 `stripRedirects` 单独处理。
	const stripped = stripHeredocBodies(command).replace(/\d?>&\d?/g, " ");
	const out: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < stripped.length; i++) {
		const ch = stripped[i]!;
		if (quote) {
			current += ch;
			if (ch === quote && stripped[i - 1] !== "\\") quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "\n" || ch === ";" || ch === "|" || ch === "&") {
			if ((ch === "|" || ch === "&") && stripped[i + 1] === ch) i++;
			out.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	out.push(current);
	return out.map((s) => s.trim()).filter(Boolean);
}

/** 取一段的首个「真」动词，跳过 `VAR=…` 前缀与 `sudo/env/…` 包装。 */
export function segmentVerb(segment: string): { verb: string | null; args: string[] } {
	const tokens = segment.split(/\s+/).filter(Boolean);
	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i]!;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || /^[({!]$/.test(token)) {
			i++;
			continue;
		}
		const base = token.split("/").pop()!;
		if (WRAPPERS.has(base)) {
			i++;
			continue;
		}
		return { verb: base, args: tokens.slice(i + 1) };
	}
	return { verb: null, args: [] };
}

/** 写重定向（`>` / `>>`），排除 `/dev/null` 与 fd 复制。 */
function hasWriteRedirect(segment: string): boolean {
	return /(^|[^>0-9])>>?\s*(?!\/dev\/null|&\d)\S/.test(segment.replace(/\d?>&\d?/g, " "));
}

/**
 * 剥掉重定向部分，供**取词**使用（分类那边保留原样，见 `splitShellSegments` 的注释）。
 *
 * 不剥的话 `ls -la dir 2>/dev/null` 的位置参数里会出现 `2>/dev/null`，短语就成了
 * `List 2>/dev/null` —— 实测踩过。
 */
export function stripRedirects(segment: string): string {
	return segment
		// `2>/dev/null` / `>/tmp/x` / `>>log`：`\d?` 必须包住那个 fd 数字，
		// 否则 `2>` 里的 `2` 会被当成位置参数（曾经把 `ls -la dir 2>/dev/null` 说成 `List 2>/dev/null`）。
		.replace(/\d?>>?\s*&?\d?\s*\S*/g, " ")
		// `< file` 输入重定向同理
		.replace(/\d?<\s*\S+/g, " ")
		.trim();
}

/** `sed -i` / `perl -i` —— 就地改写，不是读。 */
function isInPlaceEdit(segment: string): boolean {
	return /\b(sed|perl)\b[^;|&]*?\s-[a-zA-Z]*i/.test(segment);
}

/**
 * 把一段归类；返回 `null` 表示这一段不可折叠（于是整条命令不可折叠）。
 *
 * 一条命令里可以有多个类别（`grep … | head`），由 `classifyBash` 做优先级归并。
 */
function classifySegment(segment: string): FoldKind | "native" | null {
	if (hasWriteRedirect(segment)) return null;
	if (isInPlaceEdit(segment)) return null;
	const { verb, args } = segmentVerb(segment);
	if (!verb || NOOP_VERBS.has(verb)) return "native"; // 跳过，不影响
	if (verb === "git") {
		const sub = args.find((t) => !t.startsWith("-")) ?? "";
		return GIT_READ_SUBCOMMANDS.has(sub) ? "git" : null;
	}
	if (verb === "sed" || verb === "awk" || verb === "gawk" || verb === "perl") return "read";
	if (verb === "grep" || verb === "egrep" || verb === "fgrep" || verb === "rg" || verb === "ag" || verb === "ack") {
		return "search";
	}
	if (verb === "ls" || verb === "find" || verb === "fd" || verb === "tree" || verb === "eza" || verb === "du" ||
		verb === "stat" || verb === "realpath" || verb === "readlink" || verb === "which" || verb === "type" ||
		verb === "mdfind" || verb === "locate" || verb === "dirname" || verb === "basename") {
		return "list";
	}
	if (READ_VERBS.has(verb)) return "read";
	return null;
}

/**
 * 判定一条 bash 命令是否可折叠，并给出它的类别。
 *
 * 类别取**第一个有效段**的类别（与短语行取的也是第一条短语同源）—— 这样屏幕上看到的
 * 那一行动词就等于它的类别，两者不会相互矛盾。（**家族归属另算**：只有原生 `read` 工具
 * 单独一族，bash 转义出来的 read 归入 Search / List / Git 那一族，见 `registry.familyOf`。）
 *
 * 为什么不是「所有段里优先级最高的那个」：一条命令常常同时含 `sed`（读）与 `grep`（检索），
 * 比如 `… ; sed -n '1,60p' CHANGELOG.md; echo …; grep -n version package.json`。
 * 旧口径按 list > search > git > read 取最高，于是它被归成 search，屏幕上那行却写着
 * `Read CHANGELOG.md 1-60` —— 短语动词与类别对不上（2026-10-06 报的第三个例子）。
 * 改成「首动词定类别」后两边一致。
 */
export function classifyBash(command: string): FoldVerdict {
	const segments = splitShellSegments(command);
	let significant = 0;
	for (const segment of segments) {
		const kind = classifySegment(segment);
		if (kind === "native") continue; // 导航/输出动词，跳过
		if (kind === null) return { kind: null, reason: segment.slice(0, 60) };
		significant++;
		// 第一个有效段就是这条命令的”主谓“ —— 它就是这一行的动词 / 类别
		if (significant === 1) return { kind };
	}
	return { kind: null, reason: "no significant verb" };
}

/**
 * 参数是否还没到齐 —— 到了的话**能**判断折叠，没到就**别**判。
 *
 * pi 在 `content_block_start` 时把工具参数播种为 `{}`（`event.content_block.input ?? {}`），
 * 之后每个 `input_json_delta` 才把真正的值解析进去（见 `anthropic-messages` 的流累加）。
 * 所以一个工具块**刚出现的那一刻，它的参数是空的**。
 *
 * 拿空参数去分类：`classifyBash("")` 会就着「没有有效动词」回 `null`，于是这个块被当成
 * 「不可折叠」而**断组** —— 可它其实只是还没填完。用户看到的「明明连续调用却没有合并」
 *（2026-10-06 报）就是这个：前一个 `read` 已入组，后一个 `bash` 因为参数尚空而把它踢开。
 *
 * 判定口径按「这个工具的必填参数到没到」来：
 *
 *   - `bash` —— `command` 必须是非空**字符串**；`undefined` / `""` 都算没到
 *   - `read` —— `path` 必须是非空字符串
 *   - `grep` / `find` —— `pattern` 必须是非空字符串
 *   - `ls` —— **从不 pending**：`path` 在它的 schema 里是可选的（缺省 = 当前目录），
 *     缺参数就是它正常的一种取值，不是「还没到」
 *
 * 注意 `""` 也算 pending（而不是「确定不可折叠」）：真实的 bash 命令不会是空串，拿到空串只可能
 * 是还在流。就算真的永远为空，代价也只是这个块不入组（原样渲染），比错误断组安全得多。
 */
export function isPendingArgs(toolName: string, args: unknown): boolean {
	const obj = (args ?? {}) as Record<string, unknown>;
	const isFilled = (v: unknown): boolean => typeof v === "string" && v.length > 0;
	switch (toolName) {
		case "bash":
			return !isFilled(obj.command);
		case "read":
			return !isFilled(obj.path);
		case "grep":
		case "find":
			return !isFilled(obj.pattern);
		default:
			return false;
	}
}

/** 一次工具调用是不是「只读探查」；是的话给出类别。 */
export function classifyToolCall(toolName: string, args: unknown): FoldVerdict {
	// 参数没到齐就**不下结论** —— 交给调用方等下一帧，别用猜测去断组
	if (isPendingArgs(toolName, args)) return { kind: null, pending: true, reason: "args pending" };
	// 读 SKILL.md 不折叠：pi 对它有专门的 `[skill] <目录名>` 紧凑形态（用户 2026-10-06 定），
	// 理由与实测规模见 `isSkillRead`。放在 `read` 分支**之前**，且**不是** pending ——
	// 它是个确定的「不可折叠」，会照常触发断组（读 skill 前后的探查不该被并成一组）。
	if (isSkillRead(toolName, args)) return { kind: null, reason: "skill read" };
	if (toolName === "read") return { kind: "read" };
	if (toolName === "grep") return { kind: "search" };
	if (toolName === "find" || toolName === "ls") return { kind: "list" };
	if (toolName === "bash") {
		const command = typeof (args as { command?: unknown } | null | undefined)?.command === "string"
			? (args as { command: string }).command
			: "";
		return classifyBash(command);
	}
	return { kind: null, reason: `tool ${toolName}` };
}
