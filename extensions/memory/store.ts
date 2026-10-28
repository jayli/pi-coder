/**
 * memory/store — 记忆存储层的纯函数部分（无 pi 依赖，node --test 直接测）。
 *
 * 布局（设计见 docs/superpowers/specs/2026-09-26-pi-memory-design.md）：
 *
 *   <baseDir>/<project-slug>/memory/     ← 默认：与 Claude Code 共用的目录
 *   ├── MEMORY.md            索引，两边各自机械生成，模型不手写
 *   ├── <name>.md            一条记忆一个文件，CC 兼容 frontmatter
 *   └── .disabled            存在即关闭本项目记忆（/memory 切换）
 *
 * 默认落在 CC 的 `~/.claude/projects/<slug>/memory/`，两个 agent 读写同一批正文文件，
 * 记忆因此天然互通。`PI_MEMORY_LAYOUT=pi` 退回本扩展自己的旧位置
 * （`<agentDir>/memory/<slug>/`），`PI_MEMORY_DIR` 仍然覆盖「根」。
 *
 * 两边都不把 MEMORY.md 当事实来源：索引由各自的程序从正文 frontmatter 现场重建，
 * 且重建时排除 MEMORY.md 自身，所以索引格式差异（pi 多一段 type）不会互相污染。
 *
 * slug 规则照 CC / pi-claude-memory：项目根绝对路径的 `/` 与 `.` 换成 `-`，
 * 同一 git 仓库的所有 worktree 共享一个记忆目录（slug 取自**主仓库根**，见 `findProjectRoot`）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const INDEX_FILENAME = "MEMORY.md";
export const DISABLED_MARKER = ".disabled";
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25_000;
export const DESCRIPTION_MAX_CHARS = 150;

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryEntry {
	name: string;
	description: string;
	type: MemoryType;
	modified: string;
	body: string;
	filename: string;
}

/** 项目根绝对路径 → slug（`/` 与 `.` 换 `-`）。 */
export function slugifyPath(absPath: string): string {
	return absPath.replace(/[/.]/g, "-");
}

/** 向上找 git 根（`.git` 目录或 worktree 的 `.git` 文件）；找不到返回 cwd 本身。
 *
 * 两处归一化让 slug 与 Claude Code 对得上（CC 2.1.308 实测口径）：
 *
 * 1. **符号链接**：结果先过 `realpath`。CC 用真实路径算 slug，不归一就会出现
 *    `/tmp/x` 落 `-tmp-x`、`/private/tmp/x` 落 `-private-tmp-x` 两份记忆。
 * 2. **worktree**：`.git` 是文件时读里面的 `gitdir:`，再看该 gitdir 有没有
 *    `commondir`（worktree 专属 gitdir 才有，指向主仓库的 `.git`）。有就回推到
 *    主仓库根 —— CC 让主仓库与它所有 worktree 共用一份记忆。没有 `commondir`
 *    的两种情况保持工作目录自身：`git init --separate-git-dir`（gitdir 完全
 *    独立）与 submodule（gitdir 在父仓库下，但语义上是独立仓库，CC 实测也分开）。
 *
 * 回推是**单跳**的：主仓库自己不会是 worktree，不必递归。
 */
export function findProjectRoot(cwd: string): string {
	const start = realpathOrSelf(path.resolve(cwd));
	for (let dir = start; ; ) {
		const gitEntry = path.join(dir, ".git");
		let stat: fs.Stats | undefined;
		try {
			stat = fs.statSync(gitEntry);
		} catch {
			// 继续向上
		}
		if (stat !== undefined) {
			const root = stat.isDirectory() ? dir : (worktreeOwner(gitEntry) ?? dir);
			// 起始路径可能因 realpath 失败（深层目录还不存在）而是软链形式，返回前再归一次
			return realpathOrSelf(root);
		}
		const parent = path.dirname(dir);
		if (parent === dir) return start;
		dir = parent;
	}
}

/** `realpathSync`，路径不存在时退回原值（`realpath` 对不存在的路径会抛）。 */
function realpathOrSelf(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}

/**
 * `.git` 是文件（worktree / separate-git-dir / submodule）时，找出它归属的仓库根。
 *
 * worktree 的 gitdir 里带 `commondir`（内容形如 `../..`，相对 gitdir 解析），
 * 指向主仓库的 `.git`；其余两种情况没有 ⇒ 返回 undefined，调用方保留工作目录自身。
 * 只读两次小文件，不 spawn git。
 */
function worktreeOwner(gitFile: string): string | undefined {
	let pointer: string;
	try {
		pointer = fs.readFileSync(gitFile, "utf-8");
	} catch {
		return undefined;
	}
	const match = pointer.match(/^gitdir:\s*(.+?)\s*$/m);
	if (match === null) return undefined;
	const gitDir = path.resolve(path.dirname(gitFile), match[1]);
	let common: string;
	try {
		common = fs.readFileSync(path.join(gitDir, "commondir"), "utf-8").trim();
	} catch {
		return undefined; // separate-git-dir / submodule：没有 commondir
	}
	if (common === "") return undefined;
	// commondir 是主仓库的 `.git` 目录（worktree 里是 `../..`）；仓库根是它的父目录
	const commonDir = path.resolve(gitDir, common);
	return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
}

/** pi 的 agent 目录（`PI_CODING_AGENT_DIR` 可覆盖，否则 `~/.pi/agent`）。 */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const envDir = env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir.startsWith("~") ? path.join(os.homedir(), envDir.slice(1)) : envDir;
	return path.join(os.homedir(), ".pi", "agent");
}

/**
 * 本项目的记忆目录。
 * `PI_MEMORY_DIR` 覆盖**根**（测试隔离用），slug 仍然生效，所以即使指定了根，
 * 不同项目也各自一个子目录。
 *
 * 两种布局，由 `PI_MEMORY_LAYOUT` 选（默认 `cc`）：
 *   cc —— `<根>/<slug>/memory`，根默认 `~/.claude/projects`（CC 自己的位置，互通）
 *   pi —— `<根>/<slug>`，根默认 `<agentDir>/memory`（本扩展加互通前的旧布局）
 */
export const MEMORY_LAYOUTS = ["cc", "pi"] as const;
export type MemoryLayout = (typeof MEMORY_LAYOUTS)[number];

/** `~` 展开成 home；其余按原串。 */
function expandHome(p: string): string {
	return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** 布局名：只认 MEMORY_LAYOUTS 里的值，其余（含缺失）按默认 `cc`。 */
export function resolveMemoryLayout(env: NodeJS.ProcessEnv = process.env): MemoryLayout {
	const raw = env.PI_MEMORY_LAYOUT;
	return MEMORY_LAYOUTS.includes(raw as MemoryLayout) ? (raw as MemoryLayout) : "cc";
}

export function resolveMemoryDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const layout = resolveMemoryLayout(env);
	const defaultRoot = layout === "cc" ? path.join(os.homedir(), ".claude", "projects") : path.join(resolveAgentDir(env), "memory");
	const root = env.PI_MEMORY_DIR ? expandHome(env.PI_MEMORY_DIR) : defaultRoot;
	const slug = slugifyPath(findProjectRoot(cwd));
	return layout === "cc" ? path.join(root, slug, "memory") : path.join(root, slug);
}

/** 记忆文件名合法性：kebab-case，禁路径成分。 */
export function isValidMemoryName(name: string): boolean {
	return /^[a-z0-9][a-z0-9-]*$/.test(name) && !name.includes("..");
}

/**
 * 极简 YAML frontmatter 解析：只认一层 `key: value` 与 `metadata:` 下的两格缩进键。
 *
 * 没有 frontmatter 的文件是合法记忆（CC 也不给无 frontmatter 的文件补），
 * 但「以 `---` 开头却没有闭合分隔符」是损坏文件，返回 `malformed: true` 让调用方跳过。
 *
 * 本扩展不是 YAML 实现，下面两条只为了同一个目录能被真 YAML 解析器（CC）读懂：
 * - 未加引号的值：第一个 `引号外的 ` #` 起是注释（YAML 规则），丢掉；
 * - 加引号的值：解转义（同 YAML 双引号规则：`\\` `\"` `\n` `\t`），不再认注释。
 */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string; malformed: boolean } {
	const fields: Record<string, string> = {};
	if (!text.startsWith("---")) return { fields, body: text, malformed: false };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return { fields, body: text, malformed: true };
	const block = text.slice(3, end).replace(/^\r?\n/, "");
	let inMetadata = false;
	for (const line of block.split(/\r?\n/)) {
		if (/^metadata:\s*$/.test(line)) {
			inMetadata = true;
			continue;
		}
		const m = inMetadata ? line.match(/^\s{2,}([A-Za-z_][\w-]*):\s*(.*)$/) : line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
		if (m) fields[m[1]] = parseScalar(m[2]);
		if (inMetadata && /^\S/.test(line) && !/^metadata:/.test(line)) inMetadata = false;
	}
	// 闭合分隔符后通常跟一个空行再是正文：剥掉前导空行与尾部空白，保证与序列化往返一致。
	const body = text.slice(end + 4).replace(/^(?:\r?\n)+/, "").trimEnd();
	return { fields, body, malformed: false };
}

/** 单个 frontmatter 值：带引号的解转义，不带引号的剥掉行内注释（仅当行首有空白的 ` #`）。 */
function parseScalar(raw: string): string {
	const value = raw.trim();
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value
			.slice(1, -1)
			.replace(/\\(.)/g, (_, ch: string) => (ch === "n" ? "\n" : ch === "t" ? "\t" : ch));
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/''/g, "'");
	}
	const hash = value.search(/[ \t]#/);
	return (hash >= 0 ? value.slice(0, hash) : value).trimEnd();
}

/**
 * 序列化一个记忆文件（frontmatter + 正文）。
 * `name`/`description` 一律双引号包裹：description 常带 `: ` 与引号，不引就是非法 YAML
 * （真 YAML 解析器直接报 `mapping values are not allowed here`），CC 侧会丢掉这条描述。
 */
export function serializeMemoryFile(entry: Pick<MemoryEntry, "name" | "description" | "type" | "modified" | "body">): string {
	return [
		"---",
		`name: ${yamlString(entry.name)}`,
		`description: ${yamlString(entry.description)}`,
		"metadata:",
		`  type: ${entry.type}`,
		`  modified: ${entry.modified}`,
		"---",
		"",
		entry.body.trim(),
		"",
	].join("\n");
}

/** 生成一个合法的 YAML 双引号标量。 */
export function yamlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
}

/** description 截断到一行（~150 字符，CC 同款）。 */
export function truncateDescription(desc: string, max = DESCRIPTION_MAX_CHARS): string {
	const oneLine = desc.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

/** 读目录里全部记忆（跳过索引与隐藏文件），按 name 排序。损坏文件跳过。 */
export function loadMemories(dir: string): MemoryEntry[] {
	let files: string[] = [];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== INDEX_FILENAME && !f.startsWith("."));
	} catch {
		return [];
	}
	const entries: MemoryEntry[] = [];
	for (const filename of files) {
		try {
			const text = fs.readFileSync(path.join(dir, filename), "utf-8");
			const { fields, body, malformed } = parseFrontmatter(text);
			if (malformed) continue; // 未闭合 frontmatter = 损坏文件，跳过
			const type = MEMORY_TYPES.includes(fields.type as MemoryType) ? (fields.type as MemoryType) : "project";
			entries.push({
				name: fields.name || filename.replace(/\.md$/, ""),
				description: fields.description || "",
				type,
				modified: fields.modified || "",
				body,
				filename,
			});
		} catch {
			// 损坏文件跳过，不让一条坏记忆挡住整个库
		}
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	return entries;
}

export interface IndexBuildResult {
	content: string;
	/** 被上限截断的条目数（>0 时注入里要附警告）。 */
	droppedCount: number;
	totalCount: number;
}

/** 从记忆条目机械生成索引（每条一行）。超 200 行 / 25KB 时截断并报告。 */
export function buildIndex(entries: MemoryEntry[]): IndexBuildResult {
	const lines: string[] = ["# Memory Index", ""];
	let bytes = 0;
	let kept = 0;
	for (const entry of entries) {
		const line = `- [${entry.name}](${entry.filename}) — ${entry.type} — ${truncateDescription(entry.description) || "(no description)"}`;
		const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
		if (kept + 2 > INDEX_MAX_LINES || bytes + lineBytes > INDEX_MAX_BYTES) break;
		lines.push(line);
		bytes += lineBytes;
		kept++;
	}
	return { content: lines.join("\n") + "\n", droppedCount: entries.length - kept, totalCount: entries.length };
}

/** 关键词检索：frontmatter 命中权重 3、正文权重 1，返回 top N。 */
export function searchMemories(entries: MemoryEntry[], query: string, limit = 5): MemoryEntry[] {
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length > 0);
	if (terms.length === 0) return [];
	const scored = entries
		.map((entry) => {
			const head = `${entry.name} ${entry.description}`.toLowerCase();
			const body = entry.body.toLowerCase();
			let score = 0;
			for (const term of terms) {
				if (head.includes(term)) score += 3;
				if (body.includes(term)) score += 1;
			}
			return { entry, score };
		})
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
	return scored.slice(0, limit).map((s) => s.entry);
}
