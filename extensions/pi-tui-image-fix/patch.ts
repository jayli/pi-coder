/**
 * patch.ts — 给 pi 的 bundle 打「内联图不要整屏重画」补丁的**纯逻辑 + 文件 IO**。
 *
 * 本模块不 import pi / pi-tui，`node --test` 可直接跑（与 `rewind/checkpoints.ts`
 * 同一套取舍）。
 *
 * ## 要修的是什么
 *
 * regular（非全屏）模式下 pi 用 `TuiMainScreen` 直接画在主屏 + 终端 scrollback 上。
 * 增量渲染遇到 kitty 内联图时有一段「预清理」：先清掉图片将占用的那几行，再把图片
 * 序列贴回图片块起始行。但它前面有个守卫：
 *
 *     if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
 *         fullRender(true);   // 写 \x1B[2J \x1B[H \x1B[3J
 *         return;
 *     }
 *
 * `fullRender(true)` 清屏、**清掉整个 scrollback**、再从 buffer 第一行整份重画。而新图
 * 永远追加在 buffer 末尾：只要 transcript 超过一屏，图片块必然有一部分落在视口底边之外
 * ⇒ 守卫必然触发 ⇒ **每出现一张内联图就闪一次**（实测 10 张图 = 10 次 wipe、累计重写
 * 23.6 MB）。上游已知：earendil-works/pi #6050、#7304；PR #8727 明确把「跨视口的 kitty
 * 图」继续留作 full redraw，所以 1.4.0 未修。
 *
 * ## 怎么修
 *
 * 不取消预清理（终端语义不变：仍是「先清行再贴回」），只把「跨界」这一种情况的前置动作
 * 从「清整屏 + 抹 scrollback」换成「滚动，把图片滚进屏幕」。用的正是同一个函数里既有、
 * 已在用的滚动手法（`moveTargetRow > prevViewportBottom` 分支就是 `"\r\n".repeat(scroll)`）：
 *
 *     \x1B[999B                  移到屏幕末行（换行本身不滚屏）
 *     \r\n × deficit             真正滚动 deficit 行
 *     \x1B[{R-1}A                回到图片块起始行
 *     —— 此后原预清理照旧执行 ——
 *
 * 滚完图片正好落在屏幕底部 R 行（`i - viewportTop === height - R`），原预清理只清屏幕内
 * 的行、不再滚屏；视口之上的历史随终端滚动进入 scrollback，**既不被抹掉也不整份重画**。
 *
 * 两个边界情形保持原样（宁可不修，也不能弄坏）：
 *   - `imageReservedRows > height`（图片比屏幕还高）：放不进屏幕，仍 fullRender。
 *   - `imageStartScreenRow < 0`（图片块起点在视口之上）：仍 fullRender。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** 补丁锚点前半：守卫条件（只改这里的判定，不碰紧随其后的 fullRender）。 */
const ANCHOR_HEAD_EXACT =
	"if(imageStartScreenRow<0||imageStartScreenRow+imageReservedRows>height){";

/**
 * 守卫体的固定尾巴。锚点就是 `ANCHOR_HEAD_EXACT` 到 `ANCHOR_TAIL_EXACT` 这一段：
 * 用两个**字面量**定位而不是正则 —— 压缩代码里到处是反引号、`$` 和括号，
 * 正则一不小心就被某个 `.` 或转义吃掉（实测：`logRedraw` 的反引号被 `.` 匹配后
 * 整条锚点静默失效）。
 */
const ANCHOR_TAIL_EXACT =
	"`),fullRender(!0);return}";

/** 补丁标记：改写后必然出现、且只出现一次。 */
export const PATCH_MARK = "kitty image scroll-into-view";
/** 改写后的守卫条件（幂等判定用）。 */
export const PATCHED_GUARD = "if(imageStartScreenRow<0||imageReservedRows>height){";

/**
 * 追加到守卫后面的 `else if`：只处理「跨界但仍能整个放进屏幕」这一种情况。
 * 写完这段之后，紧随其后的原预清理语句照常执行。
 */
const SCROLL_BRANCH =
	"else if(imageStartScreenRow+imageReservedRows>height){" +
	// 换行本身不滚屏：先把光标推到屏幕末行，否则随后 deficit 个 \r\n 有一部分落在屏内空行、滚不够。
	'output.append("\\x1B[999B");' +
	'for(let fixScroll=0;fixScroll<imageStartScreenRow+imageReservedRows-height;fixScroll++)output.append("\\r\\n");' +
	// 索引空间同步平移：终端滚了 N 行 ⇒ buffer 顶部 N 行进入 scrollback。
	"prevViewportTop+=imageStartScreenRow+imageReservedRows-height," +
	"viewportTop+=imageStartScreenRow+imageReservedRows-height," +
	// 光标回到图片块起始行（现在是 height-R），交给原预清理逐行清空。
	'output.append("\\x1B["+(imageReservedRows-1)+"A"),' +
	"logRedraw(`" + PATCH_MARK + " (${imageStartScreenRow} + ${imageReservedRows} > ${height})`)}";

export interface PatchTarget {
	file: string;
	relative: string;
	hits: number;
}

export type Status =
	| { state: "unpatched"; file: string; relative: string }
	| { state: "patched"; file: string; relative: string }
	| { state: "not-found"; searched: string }
	| { state: "ambiguous"; file: string; relative: string; hits: number };

export const BACKUP_PATH = path.join(os.homedir(), ".pi", "agent", "pi-tui-image-fix.bak");

/**
 * 从正在运行的入口脚本定位 pi 的 bundle 目录。
 *
 * 为什么用 `process.argv[1]`：`pi` 跑的是 `<package>/dist/bundle/cli.js`，内联的 pi-tui 在
 * `<package>/dist/bundle/chunks/*.js`（bundle 形态下扩展 import 的 `@earendil-works/pi-tui`
 * 也被 virtualModules 指到这份）。而 `node_modules/@earendil-works/pi-tui/dist/...` 是另一个
 * 模块实例 —— **改它无效**（见 clients/pi/README.md 那条「不是同一份」）。
 */
export function findBundleDir(argv: readonly string[] = process.argv): string | undefined {
	const entry = argv[1];
	if (!entry) return undefined;
	const resolved = path.resolve(entry);
	if (path.basename(resolved) !== "cli.js") return undefined;
	const dir = path.dirname(resolved);
	if (path.basename(dir) !== "bundle") return undefined;
	return fs.existsSync(path.join(dir, "chunks")) ? dir : undefined;
}

/** 补丁自己留下的临时文件后缀。扫描时必须排除，否则会把半成品当成 chunk。 */
const TEMP_MARK = ".imagefix-";

function listChunks(bundleDir: string): string[] {
	try {
		return fs
			.readdirSync(path.join(bundleDir, "chunks"))
			.filter((name) => name.endsWith(".js") && !name.includes(TEMP_MARK))
			.map((name) => path.join(bundleDir, "chunks", name));
	} catch {
		return [];
	}
}

/**
 * 删文件但绝不抛。沙箱（seatbelt 只允许在可删边界内 unlink）里删不掉是正常情况，
 * 不能让它把「打补丁」这件正事一起带崩。
 */
function removeQuietly(file: string): void {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// 忽略：下次 apply 的 cleanupStaleTemps 还会再试一次
	}
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/** 在 chunk 目录里找出承载补丁锚点的文件（chunk 名带哈希，跨版本会变）。 */
export function locateChunk(bundleDir: string): PatchTarget | undefined {
	for (const file of listChunks(bundleDir)) {
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const hits = countOccurrences(text, ANCHOR_HEAD_EXACT);
		if (hits > 0) return { file, relative: path.relative(bundleDir, file), hits };
	}
	return undefined;
}

function findPatchedChunk(bundleDir: string): PatchTarget | undefined {
	for (const file of listChunks(bundleDir)) {
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		if (text.includes(PATCH_MARK) && text.includes(PATCHED_GUARD)) {
			return { file, relative: path.relative(bundleDir, file), hits: 1 };
		}
	}
	return undefined;
}

/** 只读检查，不改任何文件。 */
export function status(bundleDir?: string): Status {
	const dir = bundleDir ?? findBundleDir();
	if (!dir) return { state: "not-found", searched: "argv[1] 不是 <...>/dist/bundle/cli.js" };
	const unpatched = locateChunk(dir);
	const patched = findPatchedChunk(dir);
	if (unpatched) {
		return unpatched.hits > 1
			? { state: "ambiguous", file: unpatched.file, relative: unpatched.relative, hits: unpatched.hits }
			: { state: "unpatched", file: unpatched.file, relative: unpatched.relative };
	}
	if (patched) return { state: "patched", file: patched.file, relative: patched.relative };
	return { state: "not-found", searched: path.join(dir, "chunks") };
}

/** 纯函数：把源码里那段守卫改写成「跨界则滚动」版本。锚点不匹配时返回 undefined。 */
export function rewrite(source: string): string | undefined {
	const start = source.indexOf(ANCHOR_HEAD_EXACT);
	if (start === -1) return undefined;
	// 多于一处的锚点不碰（`applyPatch` 会报 ambiguous，宁可不修也不要误伤）。
	if (source.indexOf(ANCHOR_HEAD_EXACT, start + ANCHOR_HEAD_EXACT.length) !== -1) return undefined;
	const tailStart = source.indexOf(ANCHOR_TAIL_EXACT, start);
	if (tailStart === -1) return undefined;
	// 尾巴必须在合理距离内（防止把相隔很远的另一段代码一起吞进来）。
	if (tailStart - start > 400) return undefined;
	const end = tailStart + ANCHOR_TAIL_EXACT.length;
	const body = source.slice(start + ANCHOR_HEAD_EXACT.length, end);
	const replacement = PATCHED_GUARD + body + SCROLL_BRANCH;
	return source.slice(0, start) + replacement + source.slice(end);
}

export type ApplyResult =
	| { ok: true; changed: false; reason: "already-patched" | "anchor-missing"; status: Status }
	| { ok: true; changed: true; file: string; relative: string; backup: string; atomic: boolean }
	| { ok: false; reason: "ambiguous" | "not-found" | "verify-failed"; detail: string };

/**
 * 打补丁。可重复调用：已打过原样返回（`changed:false`）。
 *
 * 写入走「同目录临时文件 + rename」；rename 前跑 `verifyPatch`，不通过就不落盘。
 */
export function applyPatch(
	options: { bundleDir?: string; backupPath?: string } = {},
): ApplyResult {
	const dir = options.bundleDir ?? findBundleDir();
	if (!dir) {
		return { ok: false, reason: "not-found", detail: "定位不到 dist/bundle（argv[1] 形态不符）" };
	}
	const current = status(dir);
	if (current.state === "patched") {
		return { ok: true, changed: false, reason: "already-patched", status: current };
	}
	if (current.state === "ambiguous") {
		return { ok: false, reason: "ambiguous", detail: `${current.relative} 里锚点出现 ${current.hits} 次` };
	}
	if (current.state !== "unpatched") {
		return { ok: true, changed: false, reason: "anchor-missing", status: current };
	}

	const original = fs.readFileSync(current.file, "utf8");
	const patched = rewrite(original);
	if (patched === undefined || !verifyPatch(original, patched)) {
		return { ok: false, reason: "verify-failed", detail: "改写后文本自检未通过，未落盘" };
	}

	// 只在第一次备份（保留上游原始字节；重复 apply 不得用已打补丁的内容覆盖备份）。
	const backup = options.backupPath ?? BACKUP_PATH;
	if (!fs.existsSync(backup)) {
		fs.mkdirSync(path.dirname(backup), { recursive: true });
		fs.writeFileSync(backup, original);
	}

	// 临时文件必须带 .js 后缀：`node --check` 拒绝未知扩展名（ERR_UNKNOWN_FILE_EXTENSION）。
	const tmp = `${current.file}.imagefix-${process.pid}.tmp.js`;
	fs.writeFileSync(tmp, patched);
	if (!syntaxOk(tmp)) {
		removeQuietly(tmp);
		return { ok: false, reason: "verify-failed", detail: "改写后 `node --check` 不通过，未落盘" };
	}

	// 首选 rename（原子的）。但在沙箱里 rename 会被当成「源路径 unlink」而拒（EPERM），
	// 那时回退成原地覆写 —— 内容已经过 `node --check`，只是失去崩溃原子性。
	let atomic = true;
	try {
		fs.renameSync(tmp, current.file);
	} catch {
		atomic = false;
		fs.writeFileSync(current.file, patched);
		removeQuietly(tmp);
	}
	cleanupStaleTemps(current.file);
	return { ok: true, changed: true, file: current.file, relative: current.relative, backup, atomic };
}

/**
 * 清掉以前跑失败留下的临时文件。只匹配本补丁自己的命名，且刻意容错：
 * 删不掉（比如在沙箱里）不能影响打补丁这件正事。
 */
function cleanupStaleTemps(chunkFile: string): void {
	const dir = path.dirname(chunkFile);
	const prefix = `${path.basename(chunkFile)}.imagefix-`;
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith(".tmp.js")) continue;
		removeQuietly(path.join(dir, name));
	}
}

/**
 * 权威门：让 node 自己解析一遍改写结果。比手写括号配平可靠（压缩代码里字符串字面量
 * 里全是 `[`，按字符数配平必然误判）。
 */
export function syntaxOk(file: string): boolean {
	const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
	return result.status === 0;
}

/**
 * 自检改写结果（纯文本层）：原始锚点消失、改写后的守卫出现、补丁标记恰好一次。
 * 语法层由 `syntaxOk` 在 apply 时另行把关。
 */
export function verifyPatch(original: string, patched: string): boolean {
	if (patched === original) return false;
	if (patched.includes(ANCHOR_HEAD_EXACT)) return false;
	if (!patched.includes(PATCHED_GUARD)) return false;
	return countOccurrences(patched, PATCH_MARK) === 1;
}

export type RestoreResult =
	| { ok: true; restored: true; file: string }
	| { ok: true; restored: false; reason: "no-backup" }
	| { ok: false; reason: "not-found"; detail: string };

/** 用备份恢复上游原始字节。备份不存在时什么也不做。 */
export function restorePatch(
	options: { bundleDir?: string; backupPath?: string } = {},
): RestoreResult {
	const backup = options.backupPath ?? BACKUP_PATH;
	if (!fs.existsSync(backup)) return { ok: true, restored: false, reason: "no-backup" };
	const dir = options.bundleDir ?? findBundleDir();
	if (!dir) return { ok: false, reason: "not-found", detail: "定位不到 dist/bundle" };
	const current = status(dir);
	const file =
		current.state === "patched" || current.state === "unpatched" ? current.file : undefined;
	if (!file) return { ok: false, reason: "not-found", detail: "找不到承载守卫的 chunk，版本结构可能已变" };
	const original = fs.readFileSync(backup, "utf8");
	const tmp = `${file}.imagefix-${process.pid}.tmp.js`;
	fs.writeFileSync(tmp, original);
	try {
		fs.renameSync(tmp, file);
	} catch {
		fs.writeFileSync(file, original);
		removeQuietly(tmp);
	}
	cleanupStaleTemps(file);
	return { ok: true, restored: true, file };
}

/** 供 CLI / 扩展用的单行描述。 */
export function describeStatus(s: Status): string {
	switch (s.state) {
		case "patched":
			return `已打补丁：${s.relative}`;
		case "unpatched":
			return `未打补丁：${s.relative}`;
		case "ambiguous":
			return `锚点出现 ${s.hits} 次，拒绝自动改写：${s.relative}`;
		case "not-found":
			return `未找到补丁锚点（pi 可能已修好，或这段代码结构变了）：${s.searched}`;
	}
}
