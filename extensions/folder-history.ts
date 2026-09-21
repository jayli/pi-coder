/**
 * Folder-based Command History（本地改版，源自 npm:pi-command-history@0.2.0）
 *
 * 按工作目录持久化命令历史，跨会话复用。历史文件：~/.pi/folder-history/<path-with-dashes>.jsonl
 * 文件名规则在 `./folder-history/path.ts`：`/` 和 `\` 都换成 `-`，去掉 `:`。
 * 只替换 `/` 时 Windows cwd（`D:\foo`）会拼出 `~/.pi/folder-history\D:\foo.jsonl`，ENOENT。
 *
 * 与上游最大的差别：**不再注册任何快捷键**。
 * 上游用 ctrl+up / ctrl+down，在 macOS 上被系统 Mission Control 抢走（终端收不到），
 * 而且和 pi 内置的 tui.altScreen.previousPrompt / nextPrompt 撞键（启动时刷 conflict 警告）。
 *
 * 现在的做法是把跨 session 的历史注入编辑器自身的 history 列表，于是**原生 ↑ / ↓ 直接跨 session 翻历史**：
 *   - pi-tui Editor.history 里 history[0] = 最新，索引越大越旧；↑ 在第一视觉行时往旧翻，↓ 往新翻；
 *   - pi 启动时只把「当前会话」的用户消息灌进 history（renderInitialMessages → populateHistory），
 *     所以原生 ↑/↓ 原本只能翻当前会话；
 *   - 我们把旧 session 的记录**追加到 history 数组尾部**（尾部 = 更旧），顺序变成
 *     [当前会话最新…最旧, 上个会话最新…最旧, 更早…]，↑ 一路往旧翻，↓ 一路往新翻。
 *
 * 为什么用「注入 history」而不是注册 up/down 快捷键：扩展快捷键在 CustomEditor.handleInput 的
 * 最前面被检查（onExtensionShortcut first），注册 "up" 会吃掉多行输入框的光标上移，
 * 以及所有选择器（模型选择、/resume 列表…）的 ↑/↓ 导航。注入 history 则完全保留原生语义：
 * 多行 prompt 里 ↑/↓ 照常移动光标，只有光标在第一视觉行（或正在翻历史）时才翻历史。
 *
 * 实现要点：ctx.ui.getEditorComponent() 返回的是**工厂函数**（EditorFactory），不是编辑器实例，
 * 所以拿不到 history 数组 —— 只能包一层工厂，在实例化时注入。
 * 扩展按文件名顺序加载（folder-history.ts 排在 prompt-editor.ts 之前），prompt-editor 会在
 * session_start 里 setEditorComponent 覆盖掉我们的工厂，因此这里同步包一次 + setTimeout(0) 再包一次
 * （此时所有 session_start handler 都已跑完），并用 symbol 标记避免重复嵌套包装。
 *
 * 可调环境变量：
 *   PI_FOLDER_HISTORY_INJECT  注入编辑器 history 的最大条数，默认 100（= pi-tui 内置 history 上限）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { historyFileName } from "./folder-history/path.ts";

const HISTORY_DIR = join(homedir(), ".pi", "folder-history");
const MAX_HISTORY = 500; // 历史文件里保留的条数上限
// 注入上限默认 100：pi-tui Editor.addToHistory 在 history 超过 100 条时会 pop 掉最旧的一条，
// 注入更多只会在后续提交时被逐条裁掉，所以和内置上限保持一致。
const MAX_INJECT = Number(process.env.PI_FOLDER_HISTORY_INJECT || 100);
const WRAPPED = Symbol.for("pi.folder-history.wrapped");

function getHistoryFile(cwd: string): string {
	return join(HISTORY_DIR, `${historyFileName(cwd)}.jsonl`);
}

/** 返回 oldest-first 的去重历史（按文件里的写入顺序）。 */
function loadHistory(cwd: string): string[] {
	const file = getHistoryFile(cwd);
	if (!existsSync(file)) return [];

	try {
		const lines = readFileSync(file, "utf-8")
			.split("\n")
			.filter((l) => l.trim());

		const entries: string[] = [];
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.text && entry.cwd === cwd) {
					entries.push(entry.text);
				}
			} catch {
				// skip malformed lines
			}
		}

		// Deduplicate keeping last occurrence, then trim to max
		const seen = new Map<string, number>();
		entries.forEach((text, i) => seen.set(text, i));
		const unique = [...seen.entries()]
			.sort((a, b) => a[1] - b[1])
			.map(([text]) => text);

		return unique.slice(-MAX_HISTORY);
	} catch {
		return [];
	}
}

function appendHistory(cwd: string, text: string): void {
	mkdirSync(HISTORY_DIR, { recursive: true });
	const file = getHistoryFile(cwd);
	const entry = JSON.stringify({ cwd, text, ts: Date.now() });
	appendFileSync(file, entry + "\n", "utf-8");
}

/** 当前会话已有的用户输入（避免 resume 时把同一条记录重复注入成两份）。 */
function collectSessionTexts(sessionManager: unknown): Set<string> {
	const texts = new Set<string>();
	try {
		const entries = (sessionManager as { getEntries?: () => unknown[] })?.getEntries?.() ?? [];
		for (const entry of entries as Array<Record<string, any>>) {
			if (entry?.type !== "message") continue;
			const message = entry.message;
			if (message?.role !== "user") continue;
			const content = message.content;
			if (typeof content === "string") {
				const trimmed = content.trim();
				if (trimmed) texts.add(trimmed);
			} else if (Array.isArray(content)) {
				const text = content
					.filter((block: any) => block?.type === "text" && typeof block.text === "string")
					.map((block: any) => block.text)
					.join("\n")
					.trim();
				if (text) texts.add(text);
			}
		}
	} catch {
		// sessionManager shape changed — just skip dedupe
	}
	return texts;
}

/**
 * 注入到编辑器 history：history[0] = 最新，索引越大越旧，
 * 所以旧记录追加到**尾部**，且追加顺序必须是 newest-first。
 */
function injectIntoEditor(
	editor: unknown,
	entriesOldestFirst: string[],
	exclude: Set<string>,
): number {
	if (!editor || typeof editor !== "object") return 0;

	const existing = (editor as { history?: unknown }).history;
	const injectOldestFirst = entriesOldestFirst.filter(
		(text) => !exclude.has(text) && !(Array.isArray(existing) && existing.includes(text)),
	).slice(-MAX_INJECT);
	if (injectOldestFirst.length === 0) return 0;

	if (!Array.isArray(existing)) {
		// 兜底：编辑器没有 history 数组时用公开 API 逐条加（oldest-first → 最新的落在 history[0]）
		const addToHistory = (editor as { addToHistory?: (t: string) => void }).addToHistory;
		if (typeof addToHistory !== "function") return 0;
		for (const text of injectOldestFirst) addToHistory.call(editor, text);
		return injectOldestFirst.length;
	}

	existing.push(...injectOldestFirst.slice().reverse());
	return injectOldestFirst.length;
}

export default function (pi: ExtensionAPI) {
	let currentCwd = "";
	let sessionTexts = new Set<string>();

	/** 包一层编辑器工厂，在实例化时注入跨 session 历史。 */
	function installEditorWrapper(ctx: any): boolean {
		if (!ctx?.hasUI) return false;

		const previous = ctx.ui.getEditorComponent();
		if (previous && (previous as any)[WRAPPED]) return false; // 已经是我们的包装，别嵌套

		ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => {
			const editor = previous
				? previous(tui, theme, keybindings)
				: new CustomEditor(tui, theme, keybindings);
			injectIntoEditor(editor, loadHistory(currentCwd), sessionTexts);
			return editor;
		});

		const installed = ctx.ui.getEditorComponent();
		if (installed) (installed as any)[WRAPPED] = true;
		return true;
	}

	pi.on("session_start", (_event, ctx) => {
		currentCwd = ctx.cwd;
		sessionTexts = collectSessionTexts((ctx as any).sessionManager);

		// 同步包一次；如果别的扩展（如 prompt-editor）之后又覆盖了工厂，
		// 下面的 macrotask 会在所有 session_start handler 跑完后再包一次。
		installEditorWrapper(ctx);
		setTimeout(() => {
			try {
				installEditorWrapper(ctx);
			} catch {
				// ctx 可能已经因为 reload / 换 session 失效
			}
		}, 0);
	});

	// 只负责持久化：编辑器 history 由 pi 自己在提交时 addToHistory，不要重复加
	pi.on("input", (event, _ctx) => {
		const text = event.text?.trim();
		if (!text || !currentCwd) return;

		appendHistory(currentCwd, text);
		return { action: "continue" as const };
	});
}
