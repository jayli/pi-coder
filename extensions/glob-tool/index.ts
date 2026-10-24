/**
 * glob-tool —— 给 pi 加一个 `glob` 工具：候选集来自**仓库清单**（`git ls-files`），
 * 而不是目录遍历。这是它与内置 `find` 的分界线。
 *
 * ## 为什么要有第二个"按名字找文件"的工具
 *
 * `find` 走的是文件系统视角：`fd --hidden` 全量遍历、忽略规则只在 git 仓库里生效、
 * 没有"这些是项目文件"的概念。当目录里有 `node_modules`、构建产物、临时文件时，模型拿到
 * 的是一堆噪声；而它真正想问的是"这个仓库里有哪些 ts 文件"。
 *
 * `glob` 的候选集取自 `git ls-files`（tracked + untracked 未忽略），于是：
 *
 * - 忽略语义**完整**（嵌套 `.gitignore`、`!` 否定、`.git/info/exclude`、全局 excludes ——
 *   全由 git 自己实现，不用我们复刻）；
 * - 快（本仓库 332 文件 53ms，与仓库大小线性但常数极小）；
 * - 结果里**没有** `node_modules`，除非它真在 index 里。
 *
 * 三档降级（`candidates.ts`）：git 仓库 → 裸仓库兜底（无仓库但有 `.gitignore`）→
 * `opendir` 走查。任何一档失败都静默降级，不向模型报错 —— 结果通常等价，报错只会打断。
 *
 * ## 为什么不需要"持久索引"
 *
 * Claude Code 的 Glob 也不维护磁盘索引文件；它的"快"来自同样的两件事：候选集来自仓库清单、
 * 结果按修改时间排序。实测本仓库全量 `git ls-files` 53ms、3000 文件的全量 `stat` 13ms，
 * 实时枚举已经比一次对话轮次快三个数量级。加缓存只会引入失效正确性问题（`git checkout`、
 * 外部改动、分支切换），换不到可感知的收益。
 *
 * ## 默认排序是路径序，不是 mtime
 *
 * CC 恒按 mtime 倒序（这是它的一个观感特征）。这里默认路径升序：同一查询每次结果逐字节
 * 相同，模型对"上次看到的第 N 个"有可预期性。想按最近修改看，传 `sort_by_mtime: true`。
 *
 * ## 轨道点文件不受 `hidden` 门控
 *
 * `hidden` 只影响**走查档**（那里是 shell 语义，`*` 不列点文件）。git 认得的文件一律参与
 * 匹配 —— `.github/workflows/ci.yml` 是项目的一部分，模型问 `**` + `/` + `*.yml` 时
 * 看不到它属精度坍塌。实现细节见 `match.ts` 的 `unhide`。
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { Type } from "typebox";

import { collectCandidates } from "./candidates.ts";
import { DEFAULT_LIMIT, formatOutput, selectPaths } from "./match.ts";
import { formatGlobBody, formatGlobTitle } from "./render.ts";
import {
	EMPTY_COMPONENT,
	createGroupTree,
} from "../explored-group/render.ts";
import {
	ensureRegistered,
	isLeader,
	markReadyIfSettled,
	setLeaderInvalidate,
	shouldHideWhilePending,
} from "../explored-group/registry.ts";

/** 工具的注册名。小写，与 `read` / `grep` / `find` / `ls` 一致；UI 上显示 `Glob`。 */
const TOOL_NAME = "glob";
const TOOL_LABEL = "Glob";

const globSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern, e.g. '**/*.ts', 'src/**/*.{ts,tsx}', '*.md'. A pattern without '/' searches the whole tree.",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: `Maximum number of results (default: ${DEFAULT_LIMIT})` })),
	include_ignored: Type.Optional(Type.Boolean({ description: "Also search .gitignore'd paths (default: false)" })),
	hidden: Type.Optional(
		Type.Boolean({
			description: "Include dot-paths during directory walks; repository files are always included (default: false)",
		}),
	),
	sort_by_mtime: Type.Optional(Type.Boolean({ description: "Sort by modification time, newest first (default: path order)" })),
});

/**
 * 给模型看的文案。**这三个字符串的辨识度就是这个工具能不能被用上的全部**。
 *
 * 2026-10-26 实测教训：第一版把描述写成了与内置 `find` 几乎逐字相同
 * （`Find files by glob pattern…` vs find 的 `Search for files by glob pattern…`），
 * 于是模型面对两个同义描述只能猜。
 *
 * 2026-10-24 复核（pi 1.4.0）：初版那两条「find 做不到」的论据**都不成立**了 ——
 * `find` 内部会给带 `/` 的模式补上一层递归前缀再交给 `fd --full-path`（实测
 * `gateway/**` 下的 py 正常返回），`*` 也照样列出 `.git/` 与目录。所以文案不再声称
 * find 有缺陷，只讲**两者取候选的来源不同**：glob 读 git 索引，find 走文件系统。
 * 这是唯一稳定成立、且模型能据此判断的差异。
 *
 * 注意：find 在 git 仓库**内**同样遵守 `.gitignore`（实测 `**` + `/*.ts` 那类模式不会返回
 * `dist/` 与 `node_modules/`）；它多出来的只有 `.git/` 内部与**目录条目**（后者只在
 * 无斜杠的模式下出现）。文案的口径按这个事实写，不要夸大差异。
 */
const globPromptContribution = {
	snippet: "List repository files from the git index (tracked + untracked, no .git/ internals)",
	guidelines: [
		"glob and find both answer 'which files are here'. glob reads the git index (tracked + untracked, never .git/ internals); find walks the filesystem and can also return directories.",
		"Use glob when you want project files. Use find when you need directories, or paths the index does not hold (a gitignored build directory, a directory outside the repo).",
	],
};

export interface GlobToolDetails {
	resultLimitReached?: number;
	truncated?: boolean;
}

/** 把 `path` 参数解析成绝对目录（相对 cwd）。 */
function resolveSearchRoot(rawPath: string | undefined, cwd: string): string {
	const target = rawPath === undefined || rawPath.trim() === "" ? "." : rawPath.trim();
	return isAbsolute(target) ? target : resolvePath(cwd, target);
}

/** 把一个可选的 mtime 取法绑到具体搜索根上。 */
function createStatMtime(searchRoot: string): (relativePath: string) => Promise<number | undefined> {
	return async (relativePath: string) => {
		try {
			const entry = await stat(join(searchRoot, relativePath));
			// 目录 / 符号链接指向目录：不该出现在结果里，返回 undefined 让调用方丢弃。
			return entry.isFile() ? entry.mtimeMs : undefined;
		} catch {
			// 并发删除 / 权限：丢弃，不让一次查询失败。
			return undefined;
		}
	};
}

/** 返回一个只有一行 `• Glob <pattern> in <path>` 的自绘组件（不走分组时用）。 */
function createTitleComponent(parts: { pattern: string | null; where: string | null }, theme: any, statusSlot: string) {
	const text = new Text("", 0, 0);
	const dot = `${theme.getFgAnsi(statusSlot)}\u2022\u001b[39m`;
	const verb = theme.fg("toolTitle", theme.bold(TOOL_LABEL));
	const pattern = parts.pattern === null ? theme.fg("muted", "…") : theme.fg("accent", parts.pattern);
	const where = parts.where === null ? "" : theme.fg("toolOutput", ` in ${parts.where}`);
	text.setText(`${dot} ${verb} ${pattern}${where}`);
	return text;
}

/**
 * `app.tools.expand` 的键名文本。
 *
 * **不能 import pi 的 `keyHint` / `keyText`**：扩展里 import 到的 pi-tui 是 loader alias 指向的
 * npm/dist 副本，pi 运行时（bundle）初始化的是另一份 theme / keybindings 单例，实测
 * `keyHint` 直接抛 `Theme not initialized`（整个 renderCall 被 pi 静默 catch，标题全丢）。
 * 所以从 `~/.pi/agent/keybindings.json` 读，读不到就用 `ctrl+o` —— 与
 * `read-path-collapse.ts` / `bash-command-collapse.ts` 同一套做法。
 */
function expandKeyText(): string {
	try {
		const dir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = dir ? (dir.startsWith("~") ? join(homedir(), dir.slice(1)) : dir) : join(homedir(), ".pi", "agent");
		const parsed = JSON.parse(readFileSync(join(agentDir, "keybindings.json"), "utf8")) as Record<string, unknown>;
		const flat = parsed["app.tools.expand"];
		if (typeof flat === "string" && flat.trim() !== "") return flat.trim();
		const nested = (parsed.tools as Record<string, unknown> | undefined)?.expand;
		if (typeof nested === "string" && nested.trim() !== "") return nested.trim();
	} catch {
		// 缺文件 / 解析失败 / 结构不对：用默认值
	}
	return "ctrl+o";
}

/** 把结果正文的每一行上色。首行不带前导空行（pi 的默认壳已经被 `renderShell: "self"` 关掉）。 */
function createBodyComponent(result: any, options: { expanded: boolean }, theme: any) {
	const raw = result?.content?.map((part: any) => part.text ?? "").join("") ?? "";
	const details = result?.details ?? {};
	const parts = formatGlobBody(raw, {
		expanded: options.expanded === true,
		expandKey: expandKeyText(),
		limit: details.resultLimitReached,
		truncated: details.truncated === true,
	});
	const lines: string[] = parts.lines.map((line) => theme.fg("toolOutput", line));
	if (parts.expandHint !== null) lines.push(theme.fg("muted", parts.expandHint));
	if (parts.warning !== null) lines.push(theme.fg("warning", parts.warning));
	const text = new Text("", 0, 0);
	text.setText(lines.join("\n"));
	return text;
}

export function createGlobToolDefinition(cwd: string): ToolDefinition<typeof globSchema, GlobToolDetails | undefined> {
	return {
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			`Find files by walking the repository index instead of the directory tree. ` +
			`Returns paths relative to the search directory, sorted by path. Never returns .git/ internals or ` +
			`directories, and every pattern form works — including ones with '/' such as 'src/**/*.ts'. ` +
			`Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		// `description` 与内置 `find` 的区分点必须**逐字**出现在第一句（见 `globPromptContribution`
		// 上面那段注释）：第一版两者都以 "Find files by glob pattern" 开头，模型只能猜。
		// 注意别把 find 的 `**/` 补全说成缺陷 —— pi 1.4.0 起它支持带 `/` 的模式。
		promptSnippet: globPromptContribution.snippet,
		promptGuidelines: [...globPromptContribution.guidelines],
		parameters: globSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const pattern = typeof params.pattern === "string" ? params.pattern.trim() : "";
			if (pattern === "") throw new Error("glob: pattern is required");

			const searchRoot = resolveSearchRoot(params.path, ctx?.cwd || cwd);
			let rootStat;
			try {
				rootStat = await stat(searchRoot);
			} catch {
				throw new Error(`Path not found: ${searchRoot}`);
			}
			if (!rootStat.isDirectory()) throw new Error(`Path not found: ${searchRoot}`);

			const candidates = await collectCandidates(searchRoot, {
				includeIgnored: params.include_ignored === true,
				hidden: params.hidden === true,
				signal,
			});
			if (signal?.aborted) throw new Error("Operation aborted");

			const selected = await selectPaths({
				candidates,
				pattern,
				limit: params.limit,
				sortByMtime: params.sort_by_mtime === true,
				statMtime: createStatMtime(searchRoot),
			});

			if (selected.paths.length === 0) {
				return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
			}

			const formatted = formatOutput(
				selected.paths,
				{ limitReached: selected.limitReached, skippedNewlines: selected.skippedNewlines },
				(text) => truncateHead(text, { maxLines: Number.MAX_SAFE_INTEGER }),
			);
			const details: GlobToolDetails = {};
			if (formatted.details.resultLimitReached !== undefined) details.resultLimitReached = formatted.details.resultLimitReached;
			if (formatted.details.truncated === true) details.truncated = true;
			return {
				content: [{ type: "text", text: formatted.text }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
		// `renderShell: "self"`：不画底色、不画上下边界空行 —— 与 bash / read / grep / find / ls
		// 同一套观感（默认壳会多出上下两条空行）。
		renderShell: "self",
		renderCall(args, theme, context) {
			// 参数还在流：一行都不画。不遮的话这一帧会先冒出一个 _Glob ..._ 的标题，
			// args 齐了再跳成 `• Explored / └ Glob …` —— 用户报过的闪烁就是这个。
			if (shouldHideWhilePending(TOOL_NAME, args, context.isPartial === true)) return EMPTY_COMPONENT as any;
			// 渲染时开闸兜底（主信号是 `message_end` / `tool_execution_end`）。
			markReadyIfSettled(context.toolCallId, context.argsComplete === true, context.isPartial === true);
			// 「只读探查」分组：glob 是可折叠成员，连续探查会合并成一行 `└ Glob …`。
			const group = ensureRegistered(context.toolCallId, TOOL_NAME, args);
			if (group) {
				if (!isLeader(context.toolCallId)) return EMPTY_COMPONENT as any;
				setLeaderInvalidate(context.toolCallId, () => context.invalidate());
				return createGroupTree({
					groupId: context.toolCallId,
					theme,
					cwd: context.cwd,
					expanded: context.expanded === true,
				}) as any;
			}
			// 未入组：自绘一行标题。圆点色槽：跑着 = dim，出错 = 红，否则绿。
			const statusSlot = context.isPartial === true ? "dim" : context.isError === true ? "toolDiffRemoved" : "toolDiffAdded";
			return createTitleComponent(formatGlobTitle(args ?? {}, (value) => shortenPathForTitle(value, context.cwd)), theme, statusSlot) as any;
		},
		renderResult(result, options, theme, context) {
			// 折叠态下整组（含组长）都不画输出 —— 与 bash / read 侧同一条规则。
			if (!context.expanded && ensureRegistered(context.toolCallId, TOOL_NAME, context.args)) {
				return EMPTY_COMPONENT as any;
			}
			return createBodyComponent(result, { expanded: context.expanded === true }, theme) as any;
		},
	};
}

/**
 * 标题里路径的简写：cwd 之下用相对路径，home 之下用 `~`，其余保留绝对路径。
 *
 * 不复用 pi 的 `shortenPath`（它在 `core/tools/render-utils` 里，不是公开导出），也不做
 * `…` 尾部压缩 —— 模式串与目录名通常短，实测阶段先保持信息完整；真出现超宽再说。
 */
function shortenPathForTitle(value: string | undefined, cwd: string | undefined): string | null {
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (trimmed === "" || trimmed === ".") return ".";
	const home = process.env.HOME;
	if (cwd && (trimmed === cwd || trimmed.startsWith(`${cwd}/`))) {
		return trimmed === cwd ? "." : trimmed.slice(cwd.length + 1);
	}
	if (home && (trimmed === home || trimmed.startsWith(`${home}/`))) {
		return trimmed === home ? "~" : `~/${trimmed.slice(home.length + 1)}`;
	}
	return trimmed;
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool(createGlobToolDefinition(process.cwd()));
}
