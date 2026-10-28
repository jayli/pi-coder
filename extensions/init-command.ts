/**
 * /init：仿 Claude Code —— 让模型分析当前仓库，生成或更新「记忆文件」。
 *
 * 目标文件的选取（没显式指定时，只看 `ctx.cwd` 这一层）：
 *   ① 有 `CLAUDE.md` → 更新 `CLAUDE.md`
 *   ② 否则有 `AGENTS.md` → 更新 `AGENTS.md`
 *   ③ 两个都没有 → 新建 `AGENTS.md`
 * 显式指定：`/init <文件.md>`（第一个词以 `.md` 结尾就当路径，其余的当附加要求），
 * 例如 `/init docs/NOTES.md`、`/init /tmp/foo.md`、`/init 重点写构建和测试`。
 *
 * 为什么 CLAUDE.md 优先：这个仓库（以及作者的大部分项目）把 `CLAUDE.md` 当正文、
 * `AGENTS.md` 只是指向它的符号链接 —— 写 `CLAUDE.md` 才不会在复制/打包时丢内容。
 * pi 自己两个名字都认（`docs/usage.md` 的 Context Files：从 cwd 逐层向上加载
 * `AGENTS.md` 或 `CLAUDE.md`，同目录有 `AGENTS.override.md` 时以它为准），所以这个顺序
 * 只决定「往哪个文件写」，不影响它会不会被加载。
 *
 * 扩展自己**不写文件**：只做目标判定 + 把一段提示词当**用户消息**发给模型
 *（`pi.sendUserMessage`），由模型的 read / write / edit 去落盘。这正是 Claude Code
 * `/init` 的形态（一条命令 + 一段提示词），好处是用户能在会话里看到模型的产出过程、
 * 也能中途纠正；扩展不碰文件，就没有「扩展在后台偷偷改仓库」这类意外。
 *
 * 三个刻意的决定：
 *   ① **先 `await ctx.waitForIdle()`** 再判定：agent 正在跑的时候发用户消息要么抛错
 *      （未指定 `deliverAs`），要么被排成 followUp；而目标文件的判定会因此变旧 ——
 *      当前回合可能刚创建/删掉 `CLAUDE.md`，那样就会把内容写进错的记忆文件。
 *      等这轮结束再判定 + 发送，语义最稳（同 `/clear` 先 `waitForIdle` 的理由）。
 *   ② **只认 cwd 这一层，不向上找父目录**：pi 是逐层加载的，用户在子目录里 `/init`
 *      想写的就是这个子目录自己的记忆文件；要写别处直接传路径。向上找会让人在子目录里
 *      一不留神改到仓库根的记忆文件。
 *   ③ **不注册参数补全**：`/init` 的候选只有两个固定名字，补全的收益抵不上一个额外的
 *      pi-tui 依赖面；要指定路径就手敲，反正有 `read`/`write` 的相对路径习惯。
 *
 * `ctx.hasUI` 为 false（print / json 模式）时不 notify —— 那里没有 UI，提示无处可去；
 * 命令本身照常把提示词发出去。
 */

import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 自动判定时的候选顺序：有 `CLAUDE.md` 就写它，否则 `AGENTS.md`。 */
const CANDIDATES = ["CLAUDE.md", "AGENTS.md"];

/** 两个候选都没有时新建哪个。 */
const NEW_FILE = "AGENTS.md";

/** `statSync` 跟随符号链接 —— 本仓库就是 `AGENTS.md -> CLAUDE.md`，两个名字都该算“存在”。 */
function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

interface InitTarget {
	/** 交给模型落盘的**绝对路径**。 */
	path: string;
	/** 提示词里展示用的路径（在项目内用相对路径，否则回落绝对路径）。 */
	display: string;
	exists: boolean;
	/** 用户显式指定的路径（提示词里换一种说法，并提醒别动兄弟文件）。 */
	explicit: boolean;
}

/**
 * 解析 `/init` 的参数：第一个词以 `.md` 结尾就算目标文件，其余文字当附加要求；
 * 没有这样的词就整串当附加要求（`/init 重点写构建和测试`）。
 */
function parseArgs(args: string): { file?: string; extra: string } {
	const trimmed = args.trim();
	if (!trimmed) return { extra: "" };
	const match = /^(\S+\.md)(?:\s+([\s\S]*))?$/i.exec(trimmed);
	if (!match) return { extra: trimmed };
	return { file: match[1], extra: (match[2] ?? "").trim() };
}

/** 项目内显示相对路径（`../x` 这种跳出去的回落绝对路径，免得看不出真写到哪了）。 */
function displayPath(cwd: string, path: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

function resolveTarget(cwd: string, file: string | undefined): InitTarget {
	if (file) {
		const path = isAbsolute(file) ? file : resolve(cwd, file);
		return { path, display: displayPath(cwd, path), exists: isFile(path), explicit: true };
	}
	for (const name of CANDIDATES) {
		const path = resolve(cwd, name);
		if (isFile(path)) return { path, display: name, exists: true, explicit: false };
	}
	return { path: resolve(cwd, NEW_FILE), display: NEW_FILE, exists: false, explicit: false };
}

/**
 * 提示词。要点：
 *   - 把「文件会被之后的每次会话自动加载」说清楚，模型才知道该写什么（写给下一个 agent）。
 *   - 明确**只写验证过的事实**（这个仓库的一贯要求：不臆造命令、不猜路径）。
 *   - 已存在时强调「先 read、保留正确内容、别为重写而重写」，否则模型很容易整篇重写，
 *     把仓库里那些踩坑记录一把抹掉。
 *   - 列出「不要写」的清单（通用建议 / 目录树 / README 复述 / 临时信息）—— 这是
 *     Claude Code 的 /init 提示词里最起作用的那几条，照搬。
 */
function buildPrompt(target: InitTarget, cwd: string, extra: string): string {
	const action = target.exists ? "更新" : "创建";
	const lines = [
		`请分析这个代码库，然后${action}记忆文件 \`${target.display}\`（绝对路径：\`${target.path}\`）。`,
		"",
		"这个文件会被 pi 在**之后的每次会话**自动加载（从工作目录逐层向上读 `AGENTS.md` / `CLAUDE.md`，同目录下有 `AGENTS.override.md` 时以它为准），读者是「下一次在这个仓库里干活的 agent」。",
		`项目根目录：\`${cwd}\``,
		"",
		target.exists
			? "该文件**已存在**：先 read 它，再决定改什么 —— 保留仍然正确的内容、删掉与代码不符的、补上缺的。不要为了重写而重写，也不要丢掉已有的踩坑记录。"
			: "该文件**还不存在**：从零写一份。",
		"",
		"先自己探查仓库（README、依赖与构建清单如 package.json / pyproject.toml / Makefile / Cargo.toml、CI 配置、测试目录、主要源码），**只写你验证过的事实**：命令要真的存在、路径要真的对，没把握就不写，不要臆造。",
		"",
		"要写进去的（按价值排序）：",
		"1. **常用命令**：装依赖 / 构建 / 跑测试（含只跑单个测试的写法）/ lint / 格式化 / 本地起服务；注明在哪个目录执行、有哪些前置条件。命令放代码块，能直接复制。",
		"2. **架构与代码地图**：主要模块各自负责什么、一条典型请求或一次典型构建是怎么流过去的、关键约定与分层、外部依赖、哪些文件是生成物（不要手改）。",
		"3. **这个仓库特有的坑**：非显然的行为、必须遵守的流程（提交信息格式、需要同时改的几处配置、必须保持同步的镜像文件）、容易踩错的地方。",
		"",
		"不要写：",
		"- 通用开发建议（「写单元测试」「不要提交密钥」「给出清晰的报错」这类谁都知道的话）。",
		"- 目录树罗列 / 逐文件清单，或把 README 复述一遍。",
		"- 只跟当前任务有关的临时信息。",
		"",
		"写法：",
		"- 语言与风格跟随该文件现有内容；新文件用中文（除非这仓库的文档清一色是英文）。紧凑，宁缺毋滥。",
	];
	if (!target.explicit) {
		lines.push(
			"- 如果 `AGENTS.md` 与 `CLAUDE.md` 同时存在、或其中一个是另一个的符号链接，**只改上面指定的这一个**，不要把内容抄进另一个。",
		);
	}
	lines.push(
		"- 仓库里若有别的 agent 记忆文件（`.cursorrules` / `.cursor/rules/` / `.github/copilot-instructions.md` / `.claude/`），可以读来补漏，但不要改它们。",
		"- 用 write / edit 工具写到上面那个绝对路径（不要用 bash 的 cat / heredoc 落盘）。",
		"- 完成后用一两句话说明改了什么。",
	);
	if (extra) lines.push("", `这次 /init 的附加要求：${extra}`);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("init", {
		description: "Analyze the repository and create/update the memory file (updates CLAUDE.md when present, otherwise AGENTS.md)",
		handler: async (args, ctx) => {
			const { file, extra } = parseArgs(args);
			// 判定必须发生在「发消息」那一刻：agent 正在跑时先等它结束（见文件头 ①）。
			if (!ctx.isIdle()) {
				if (ctx.hasUI) ctx.ui.notify("Waiting for the current turn to finish before starting /init …", "info");
				await ctx.waitForIdle();
			}
			const target = resolveTarget(ctx.cwd, file);
			if (ctx.hasUI) {
				ctx.ui.notify(`${target.exists ? "Updating" : "Creating"} ${target.display} (${target.path}) …`, "info");
			}
			pi.sendUserMessage(buildPrompt(target, ctx.cwd, extra));
		},
	});
}
