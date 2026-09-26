/**
 * memory — pi 的类 CC auto-memory 扩展（方案 C：索引 + 正文，索引机械派生）。
 *
 * 设计：docs/superpowers/specs/2026-09-26-pi-memory-design.md
 *
 * 存储布局（per-project，CC 式 slug）：
 *
 *   ~/.pi/agent/memory/<project-slug>/
 *   ├── MEMORY.md        索引，扩展机械生成（模型不手写，永不忘更新）
 *   ├── <name>.md        一条记忆一个文件，CC 兼容 frontmatter
 *   └── .disabled        存在即关闭本项目记忆（/memory 切换）
 *
 * 注入：before_agent_start 改 systemPromptOptions.sections.memory ——
 * 纪律文本 + 索引。section 进 system message、随 transcript 重放、压缩后存活；
 * 索引只在写入时变化，字节天然稳定，不需要 pi-memory 的快照机制。
 *
 * 与 pi-memory@0.4.2（日志+便签范式）的关键差异见设计文档末尾对照表。
 *
 * 开关：PI_MEMORY=off 整体关闭；PI_MEMORY_DIR 覆盖记忆根（测试隔离）。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { buildMemoryContext } from "./context.ts";
import {
	DISABLED_MARKER,
	INDEX_FILENAME,
	MEMORY_TYPES,
	type MemoryEntry,
	type MemoryType,
	buildIndex,
	findProjectRoot,
	isValidMemoryName,
	loadMemories,
	resolveMemoryDir,
	searchMemories,
	serializeMemoryFile,
} from "./store.ts";

const SECTION_NAME = "memory";
const SEARCH_SNIPPET_CHARS = 240;

function isDisabled(dir: string): boolean {
	try {
		fs.statSync(path.join(dir, DISABLED_MARKER));
		return true;
	} catch {
		return false;
	}
}

function setDisabled(dir: string, disabled: boolean): void {
	const marker = path.join(dir, DISABLED_MARKER);
	if (disabled) {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(marker, new Date().toISOString(), "utf-8");
	} else {
		try {
			fs.unlinkSync(marker);
		} catch {
			// 本来就没有，忽略
		}
	}
}

/** 原子写：临时文件 + rename（同目录，POSIX 原子）。目录不存在时先建（首次写入）。 */
function writeFileAtomic(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, content, "utf-8");
	fs.renameSync(tmp, filePath);
}

/** 从全部正文文件重建索引；内容没变不落盘（保持 mtime / 缓存稳定）。 */
function rebuildIndex(dir: string): { droppedCount: number; totalCount: number } {
	const entries = loadMemories(dir);
	const index = buildIndex(entries);
	const indexPath = path.join(dir, INDEX_FILENAME);
	let current = "";
	try {
		current = fs.readFileSync(indexPath, "utf-8");
	} catch {
		current = "";
	}
	if (current !== index.content) {
		fs.mkdirSync(dir, { recursive: true });
		writeFileAtomic(indexPath, index.content);
	}
	return { droppedCount: index.droppedCount, totalCount: index.totalCount };
}

/** 读一个记忆正文；不存在返回 undefined。 */
function readMemory(dir: string, name: string): MemoryEntry | undefined {
	return loadMemories(dir).find((entry) => entry.name === name);
}

function textResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

export default function memory(pi: ExtensionAPI): void {
	if (process.env.PI_MEMORY === "off") return;

	const dirFor = (ctx: ExtensionContext): string => resolveMemoryDir(ctx.cwd);

	// --- 注入：纪律 + 索引（空库 / disabled 时不注入） ---
	pi.on("before_agent_start", async (event, ctx) => {
		const dir = dirFor(ctx);
		if (isDisabled(dir)) return;
		// 手改正文文件后索引自动跟上（幂等：内容一致不落盘）
		await withFileMutationQueue(path.join(dir, INDEX_FILENAME), async () => {
			rebuildIndex(dir);
		});
		const context = buildMemoryContext(loadMemories(dir));
		if (context.text === undefined) return;
		event.systemPromptOptions.sections[SECTION_NAME] = context.text;
	});

	// --- memory_write：写正文 + 机械重建索引 ---
	pi.registerTool({
		name: "memory_write",
		label: "Memory Write",
		description: [
			"Save or update one durable memory for this project (one topic per memory).",
			"Use when the user says 'remember this', or when the user's latest message taught a durable, applicable lesson (a correction, a confirmed approach, a standing preference, a decision with its reason).",
			"Save past-tense observations (measurements, decisions, rejected options) — never present-tense claims about this repo's current state (line numbers, config values, task progress), and never secrets.",
			"Updating an existing name overwrites that memory; check memory_read first to avoid near-duplicates.",
		].join("\n"),
		promptSnippet: "Save or update one durable memory for this project.",
		parameters: Type.Object({
			name: Type.String({ description: "short-kebab-case-slug, e.g. gitlab-push-rule" }),
			description: Type.String({ description: "One specific line (~150 chars) used to decide relevance in future sessions" }),
			type: Type.Union(MEMORY_TYPES.map((t) => Type.Literal(t)), {
				description: "user | feedback | project | reference",
			}),
			content: Type.String({ description: "The memory body: fact, then **Why:** and **How to apply:** lines; absolute dates" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const dir = dirFor(ctx);
			if (isDisabled(dir)) return textResult("Memory is disabled for this project (run /memory to enable).", { action: "blocked" });
			const name = String(params?.name ?? "").trim();
			const description = String(params?.description ?? "").trim();
			const type = String(params?.type ?? "") as MemoryType;
			const content = String(params?.content ?? "").trim();
			if (!isValidMemoryName(name)) {
				return textResult(`Invalid memory name "${name}": use short-kebab-case (a-z, 0-9, hyphens).`, { action: "rejected", name });
			}
			if (!MEMORY_TYPES.includes(type)) {
				return textResult(`Invalid type "${type}": one of ${MEMORY_TYPES.join(", ")}.`, { action: "rejected", name });
			}
			if (!description || !content) {
				return textResult("Both description and content are required.", { action: "rejected", name });
			}
			const existing = readMemory(dir, name);
			const result = await withFileMutationQueue(path.join(dir, INDEX_FILENAME), async () => {
				const filePath = path.join(dir, `${name}.md`);
				writeFileAtomic(
					filePath,
					serializeMemoryFile({ name, description, type, modified: new Date().toISOString(), body: content }),
				);
				return rebuildIndex(dir);
			});
			const verb = existing ? "Updated" : "Saved";
			return textResult(`${verb} memory "${name}" (${type}). Index: ${result.totalCount} memories.`, {
				action: existing ? "updated" : "created",
				name,
				type,
				totalCount: result.totalCount,
			});
		},
	});

	// --- memory_read：读正文 / 列全部 ---
	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description: [
			"Read one memory's full body by name, or list all memories when name is omitted.",
			"The injected index only carries one-line descriptions; read the body before acting on a memory.",
		].join("\n"),
		promptSnippet: "Read one memory body, or list all memories.",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Memory name from the index; omit to list all" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const dir = dirFor(ctx);
			const name = String(params?.name ?? "").trim();
			const entries = loadMemories(dir);
			if (!name) {
				if (entries.length === 0) return textResult("No memories saved yet for this project.", { action: "list", count: 0 });
				const lines = entries.map((e) => `- ${e.name} (${e.type}${e.modified ? `, ${e.modified.slice(0, 10)}` : ""}) — ${e.description}`);
				return textResult(lines.join("\n"), { action: "list", count: entries.length });
			}
			const entry = entries.find((e) => e.name === name);
			if (!entry) return textResult(`No memory named "${name}". Call memory_read without a name to list all.`, { action: "not_found", name });
			const head = `name: ${entry.name}\ntype: ${entry.type}\nmodified: ${entry.modified || "unknown"}\ndescription: ${entry.description}\n\n`;
			return textResult(head + entry.body, { action: "read", name, type: entry.type });
		},
	});

	// --- memory_forget：删除 + 索引更新 ---
	pi.registerTool({
		name: "memory_forget",
		label: "Memory Forget",
		description:
			"Delete one memory that turned out wrong, obsolete, or superseded. Prefer updating (memory_write with the same name) unless nothing in it is worth keeping.",
		promptSnippet: "Delete one obsolete or wrong memory.",
		parameters: Type.Object({
			name: Type.String({ description: "Memory name to delete" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const dir = dirFor(ctx);
			const name = String(params?.name ?? "").trim();
			const entry = readMemory(dir, name);
			if (!entry) return textResult(`No memory named "${name}" — nothing deleted.`, { action: "not_found", name });
			await withFileMutationQueue(path.join(dir, INDEX_FILENAME), async () => {
				fs.unlinkSync(path.join(dir, entry.filename));
				rebuildIndex(dir);
			});
			return textResult(`Deleted memory "${name}".`, { action: "deleted", name });
		},
	});

	// --- memory_search：零依赖关键词检索 ---
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Keyword search across all memories (names, descriptions, bodies). Use when the injected index does not obviously contain what you need.",
		promptSnippet: "Keyword search across all memories.",
		parameters: Type.Object({
			query: Type.String({ description: "Search terms" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const dir = dirFor(ctx);
			const query = String(params?.query ?? "").trim();
			if (!query) return textResult("Empty query.", { action: "search", count: 0 });
			const hits = searchMemories(loadMemories(dir), query);
			if (hits.length === 0) return textResult(`No memories match "${query}".`, { action: "search", count: 0 });
			const blocks = hits.map((e) => {
				const snippet = e.body.replace(/\s+/g, " ").trim().slice(0, SEARCH_SNIPPET_CHARS);
				return `## ${e.name} (${e.type})\n${e.description}\n${snippet}${e.body.length > SEARCH_SNIPPET_CHARS ? "…" : ""}`;
			});
			return textResult(blocks.join("\n\n"), { action: "search", count: hits.length });
		},
	});

	// --- /memory：唯一用户交互面（对标 CC 三项 + 索引显示） ---
	pi.registerCommand("memory", {
		description: "Auto-memory: status, open folder, show index, toggle",
		async handler(_args, ctx) {
			const dir = dirFor(ctx);
			const disabled = isDisabled(dir);
			const entries = loadMemories(dir);
			const status = `Auto-memory: ${disabled ? "off" : "on"} · ${entries.length} memories · ${dir}`;

			if (!ctx.hasUI) {
				ctx.ui.notify(status, "info");
				return;
			}

			const choice = await ctx.ui.select("Memory", [
				status,
				"Open memory folder",
				"Show memory index",
				disabled ? "Enable auto-memory" : "Disable auto-memory",
			]);
			if (!choice || choice === status) return;

			if (choice === "Open memory folder") {
				fs.mkdirSync(dir, { recursive: true });
				const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
				try {
					spawn(opener, [dir], { stdio: "ignore", detached: true }).unref();
				} catch {
					ctx.ui.notify(dir, "info");
				}
				return;
			}

			if (choice === "Show memory index") {
				if (entries.length === 0) {
					ctx.ui.notify("No memories saved yet for this project.", "info");
					return;
				}
				const index = buildIndex(entries);
				const lines = index.content.trimEnd().split("\n").slice(0, 40);
				if (index.droppedCount > 0) lines.push(`… +${index.droppedCount} over the index limit`);
				ctx.ui.setWidget("memory-index", lines);
				return;
			}

			// Enable / Disable
			setDisabled(dir, !disabled);
			ctx.ui.notify(`Auto-memory ${!disabled ? "disabled" : "enabled"} for this project.`, "info");
		},
	});
}
