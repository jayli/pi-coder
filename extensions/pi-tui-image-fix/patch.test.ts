/**
 * patch.test.ts — `patch.ts` 的回归测试。
 *
 * 三层：
 *   1. **纯文本层**：锚点识别、幂等、锚点缺失时是 no-op、备份不被覆盖、restore 还原。
 *      全用临时目录 + 假 chunk 文件，不碰真安装。
 *   2. **真实安装**：装了 pi 才有意义；锚点找不到（上游改了这段代码）就 skip —— 那是
 *      环境状况，不是回归。
 *   3. **行为层**：拿真实 pi-tui 的 `TuiMainScreen` 驱动真 chunk，钉住三件事 ——
 *      补丁后不再出现 `\x1B[3J`、图片落在屏幕底部、图片比屏幕高时仍回退整屏重画。
 *      真 chunk 在「锚点不存在」时同样 skip。
 *
 * 运行：`node --test clients/pi/extensions/pi-tui-image-fix/patch.test.ts`
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
	BACKUP_PATH,
	PATCHED_GUARD,
	PATCH_MARK,
	applyPatch,
	locateChunk,
	restorePatch,
	rewrite,
	status,
	verifyPatch,
} from "./patch.ts";

const REPO = path.resolve(import.meta.dirname, "../../../..");

// ---------------------------------------------------------------------------
// 假 chunk：形状与 pi 的真实压缩代码一致，只保留补丁锚点那一段
// ---------------------------------------------------------------------------

const FAKE_GUARD =
	"if(imageReservedRows>1){let imageStartScreenRow=i-viewportTop;" +
	"if(imageStartScreenRow<0||imageStartScreenRow+imageReservedRows>height){" +
	"logRedraw(`kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`),fullRender(!0);return}" +
	'output.append("\\x1B[2K");for(let row=1;row<imageReservedRows;row++)output.append(`\\r\\n\\x1B[2K`);' +
	'output.append(`\\x1B[${imageReservedRows-1}A`),output.append(line),output.append(`\\x1B[${imageReservedRows-1}B`),i+=imageReservedRows-1;continue}';

/** 锚点 + 尾巴（真实 chunk 里锚点后面紧跟预清理，不含 `continue`，那个在外层循环体末尾）。 */
const FAKE_GUARD_HEAD_ONLY =
	"if(imageStartScreenRow<0||imageStartScreenRow+imageReservedRows>height){" +
	"logRedraw(`kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`),fullRender(!0);return}";

function makeFakeBundle(
	root: string,
	// 必须带一个 for 循环：改写后的分支里只留 `"A"`，外层 `continue` 要落在循环体里才是合法语法
	source = `var x=1;function r(){for(let i=0;i<9;i++){${FAKE_GUARD}}}\n`,
): string {
	const bundle = path.join(root, "dist", "bundle");
	const chunks = path.join(bundle, "chunks");
	fs.mkdirSync(chunks, { recursive: true });
	fs.writeFileSync(path.join(bundle, "cli.js"), "#!/usr/bin/env node\n");
	fs.writeFileSync(path.join(chunks, "chunk-AAAAAAAA.js"), source);
	fs.writeFileSync(path.join(chunks, "chunk-BBBBBBBB.js"), "var other=1;\n");
	return bundle;
}

function tmpRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-tui-image-fix-"));
}

// ---------------------------------------------------------------------------
// 1. 纯文本层
// ---------------------------------------------------------------------------

test("rewrite: 把跨界守卫改写成「滚动让位」，原预清理一字不动", () => {
	const source = `var x=1;function r(){for(let i=0;i<9;i++){${FAKE_GUARD}}}\n`;
	const out = rewrite(source);
	assert.ok(out, "锚点存在时必须能改写");
	assert.equal(out!.includes("imageStartScreenRow+imageReservedRows>height){logRedraw"), false);
	assert.ok(out!.includes(PATCHED_GUARD), "守卫条件应改成只挡「图片比屏幕高」");
	assert.ok(out!.includes(PATCH_MARK), "应写入补丁标记");
	// 原预清理语句必须原样保留 —— 语义没变，只是前置动作换了
	assert.ok(out!.includes('output.append("\\x1B[2K");for(let row=1;row<imageReservedRows;row++)'));
	assert.ok(out!.includes("i+=imageReservedRows-1;continue}"));
});

test("rewrite: 锚点不存在时返回 undefined（上游改了这段代码就什么都不做）", () => {
	assert.equal(rewrite("var x=1;"), undefined);
	assert.equal(rewrite("if(imageStartScreenRow<0){fullRender(!0)}"), undefined);
});

test("verifyPatch: 拒绝没改/改错/标记重复的结果", () => {
	const source = `var x=1;function r(){for(let i=0;i<9;i++){${FAKE_GUARD}}}\n`;
	const good = rewrite(source)!;
	assert.equal(verifyPatch(source, good), true);
	assert.equal(verifyPatch(source, source), false, "没改过不算通过");
	assert.equal(verifyPatch(source, source.replace("imageReservedRows>1", "imageReservedRows>2")), false);
	assert.equal(verifyPatch(source, good + good), false, "标记重复不算通过");
});

test("applyPatch: 打补丁 + 幂等 + 备份只写一次", () => {
	const root = tmpRoot();
	const bundle = makeFakeBundle(root);
	const backup = path.join(root, "backup.bak");
	const original = fs.readFileSync(path.join(bundle, "chunks", "chunk-AAAAAAAA.js"), "utf8");

	const first = applyPatch({ bundleDir: bundle, backupPath: backup });
	assert.equal(first.ok, true);
	assert.equal(first.changed, true);
	assert.equal(fs.readFileSync(backup, "utf8"), original, "备份必须是上游原始字节");

	const patchedText = fs.readFileSync(path.join(bundle, "chunks", "chunk-AAAAAAAA.js"), "utf8");
	assert.notEqual(patchedText, original);

	// 第二次：识别成已打补丁，不动文件、不覆盖备份
	const second = applyPatch({ bundleDir: bundle, backupPath: backup });
	assert.equal(second.ok, true);
	assert.equal(second.changed, false);
	assert.equal(second.reason, "already-patched");
	assert.equal(fs.readFileSync(path.join(bundle, "chunks", "chunk-AAAAAAAA.js"), "utf8"), patchedText);
	assert.equal(fs.readFileSync(backup, "utf8"), original, "备份不能被已打补丁的内容覆盖");

	// status 报 patched，且指向同一个 chunk
	const st = status(bundle);
	assert.equal(st.state, "patched");
	assert.ok(st.state === "patched" && st.relative.endsWith("chunk-AAAAAAAA.js"));
});

test("applyPatch: 锚点缺失时 no-op，不写文件、不留备份", () => {
	const root = tmpRoot();
	const bundle = makeFakeBundle(root, "var nothing=1;\n");
	const backup = path.join(root, "backup.bak");
	const result = applyPatch({ bundleDir: bundle, backupPath: backup });
	assert.equal(result.ok, true);
	assert.equal(result.changed, false);
	assert.equal(result.reason, "anchor-missing");
	assert.equal(fs.existsSync(backup), false);
	assert.equal(fs.readFileSync(path.join(bundle, "chunks", "chunk-AAAAAAAA.js"), "utf8"), "var nothing=1;\n");
});

test("applyPatch: 锚点出现两次时拒绝改写（ambiguous）", () => {
	const root = tmpRoot();
	const bundle = makeFakeBundle(
		root,
		`var a=function(){for(let i=0;i<9;i++){${FAKE_GUARD}}};var b=function(){for(let j=0;j<9;j++){${FAKE_GUARD}}};\n`,
	);
	const result = applyPatch({ bundleDir: bundle, backupPath: path.join(root, "b.bak") });
	assert.equal(result.ok, false);
	assert.equal(result.reason, "ambiguous");
});

test("restorePatch: 用备份还上游原始字节；没有备份时是 no-op", () => {
	const root = tmpRoot();
	const bundle = makeFakeBundle(root);
	const backup = path.join(root, "backup.bak");
	const original = fs.readFileSync(path.join(bundle, "chunks", "chunk-AAAAAAAA.js"), "utf8");

	const before = restorePatch({ bundleDir: bundle, backupPath: backup });
	assert.deepEqual({ ok: before.ok, restored: before.restored }, { ok: true, restored: false });

	applyPatch({ bundleDir: bundle, backupPath: backup });
	assert.notEqual(fs.readFileSync(path.join(bundle, "chunks", "chunk-AAAAAAAA.js"), "utf8"), original);

	const restored = restorePatch({ bundleDir: bundle, backupPath: backup });
	assert.equal(restored.ok, true);
	assert.equal(restored.restored, true);
	assert.equal(fs.readFileSync(path.join(bundle, "chunks", "chunk-AAAAAAAA.js"), "utf8"), original);
	assert.equal(status(bundle).state, "unpatched");
});

test("locateChunk: 按内容找，不按文件名（chunk 名带哈希、跨版本会变）", () => {
	const root = tmpRoot();
	const bundle = makeFakeBundle(root);
	const target = locateChunk(bundle);
	assert.ok(target);
	assert.ok(target!.file.endsWith("chunk-AAAAAAAA.js"));
	assert.equal(target!.hits, 1);
});

// ---------------------------------------------------------------------------
// 2/3. 真实安装：装了 pi 才跑，锚点不存在就 skip（环境状况，不是回归）
// ---------------------------------------------------------------------------

/**
 * 找本机真实的 pi bundle。`PI_TUI_IMAGEFIX_BUNDLE` 可直接指向 `dist/bundle`；
 * 否则扫 pnpm 的全局虚拟仓（`<root>/<hash>/node_modules/@earendil-works/...`）。
 */
function realBundleDir(): string | undefined {
	const direct = process.env.PI_TUI_IMAGEFIX_BUNDLE;
	if (direct && fs.existsSync(path.join(direct, "chunks"))) return direct;
	const roots = [
		path.join(os.homedir(), "Library/pnpm/global/v11"),
		path.join(os.homedir(), ".local/share/pnpm/global/5"),
	];
	for (const root of roots) {
		let entries: string[];
		try {
			entries = fs.readdirSync(root);
		} catch {
			continue;
		}
		const scopes = [path.join(root, "@earendil-works")].concat(
			entries.map((e) => path.join(root, e, "node_modules", "@earendil-works")),
		);
		for (const scope of scopes) {
			let names: string[];
			try {
				names = fs.readdirSync(scope);
			} catch {
				continue;
			}
			for (const name of names) {
				if (!name.startsWith("pi-coding-agent")) continue;
				const dir = path.join(scope, name, "dist", "bundle");
				if (fs.existsSync(path.join(dir, "chunks"))) return dir;
			}
		}
	}
	return undefined;
}

const realBundle = realBundleDir();
// The patched install may already carry the mark; `locateChunk` only finds the ORIGINAL anchor,
// so resolve the chunk we would act on through `status()` instead.
const realStatus = realBundle ? status(realBundle) : undefined;
const realAnchor = realStatus && (realStatus.state === "unpatched" || realStatus.state === "patched")
	? { file: realStatus.file, relative: realStatus.relative, hits: 1 }
	: undefined;
const hasReal = Boolean(realAnchor);
const skipReal = hasReal ? false : "本机 pi 的 bundle 里没有补丁锚点（上游可能已修，或版本结构变了）";

/** 取上游原始字节：优先用备份，备份不在就要求现在是未打补丁状态。 */
function pristineSource(): string | undefined {
	if (fs.existsSync(BACKUP_PATH)) return fs.readFileSync(BACKUP_PATH, "utf8");
	const st = status(realBundle!);
	if (st.state === "unpatched") return fs.readFileSync(st.file, "utf8");
	return undefined;
}

test("真实 pi：rewrite 后的 chunk 能过 node --check，且不再含原始锚点", { skip: skipReal }, () => {
	const source = pristineSource();
	if (source === undefined) return; // 已打补丁且备份缺失：无从取原始字节
	const out = rewrite(source);
	assert.ok(out, "真实 chunk 里应能找到锚点");
	assert.equal(verifyPatch(source, out!), true);
	// 写临时文件让 node 自己解析一遍（压缩代码里字符串字面量满是方括号，手写配平不可靠）
	const dir = tmpRoot();
	const file = path.join(dir, "chunk-check.js");
	fs.writeFileSync(file, out!);
	const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
	assert.equal(result.status, 0, `改写结果必须有合法语法：${result.stderr}`);
});

test("真实 pi：补丁后落点/无 wipe/回退 三项行为", { skip: skipReal }, async () => {
	const source = pristineSource();
	if (source === undefined) return;
	const patched = rewrite(source)!;

	// 把整个 chunks 目录复制到临时目录，只替换目标 chunk —— 这样 import 解析不到别的东西。
	const root = tmpRoot();
	const workChunks = path.join(root, "chunks");
	fs.cpSync(path.join(realBundle!, "chunks"), workChunks, { recursive: true });
	const chunkFile = path.join(workChunks, path.basename(realAnchor!.file));
	fs.writeFileSync(chunkFile, patched);

	const { TuiMainScreen } = await import("file://" + chunkFile + "?test=" + Date.now());

	const HEIGHT = 40;
	const makeTui = () => {
		const written: string[] = [];
		const terminal = {
			columns: 120,
			rows: HEIGHT,
			write(d: string) { written.push(d); },
			start() {}, stop() {}, hideCursor() {}, showCursor() {}, restoreOnExit() {},
		};
		const tui = new (TuiMainScreen as new (t: unknown) => any)(terminal);
		const lines: string[] = [];
		tui.addChild({ render: () => lines, invalidate() {} });
		return { tui, lines, written };
	};
	const kitty = (rows: number, id = 9) =>
		[`\x1b_Ga=T,f=100,q=2,C=1,c=48,r=${rows},i=${id};AAAA\x1b\\`, ...Array(rows - 1).fill("")];

	for (const rows of [3, 12, 20]) {
		const { tui, lines, written } = makeTui();
		for (let i = 0; i < 200; i++) lines.push(`h${i}`);
		tui.doRender();
		written.length = 0;
		const wipesBefore = tui.fullRedraws;
		lines.push("READROW", "", ...kitty(rows));
		tui.doRender();
		const out = written.join("");

		assert.equal(tui.fullRedraws - wipesBefore, 0, `rows=${rows}: 不应整屏重画`);
		assert.equal(out.includes("\x1b[3J"), false, `rows=${rows}: 不应抹 scrollback`);
		// 预清理仍会清掉屏幕底部那 rows 行（语义没变）
		assert.ok(out.includes("\x1b[2K"), `rows=${rows}: 预清理应保留`);
	}

	// 图片比屏幕还高：放不进屏幕，必须回退整屏重画
	{
		const { tui, lines, written } = makeTui();
		for (let i = 0; i < 200; i++) lines.push(`h${i}`);
		tui.doRender();
		written.length = 0;
		const wipesBefore = tui.fullRedraws;
		lines.push("READROW", "", ...kitty(HEIGHT + 4));
		tui.doRender();
		assert.equal(tui.fullRedraws - wipesBefore, 1, "图片高于屏幕时必须回退 fullRender");
		assert.ok(written.join("").includes("\x1b[3J"), "回退时才会出现 3J");
	}
});

test("真实 pi：一轮多图会话里 0 次 wipe（原版同场景是每图一次）", { skip: skipReal }, async () => {
	const source = pristineSource();
	if (source === undefined) return;
	// 整个 chunks 目录复制到临时目录，只替换目标 chunk（chunk 之间是相对 import）
	const workRoot = tmpRoot();
	const workChunks = path.join(workRoot, "chunks");
	fs.cpSync(path.join(realBundle!, "chunks"), workChunks, { recursive: true });
	const chunkFile = path.join(workChunks, path.basename(realAnchor!.file));
	fs.writeFileSync(chunkFile, rewrite(source)!);

	const { TuiMainScreen, Image, Container, Spacer } = await import("file://" + chunkFile + "?s=" + Date.now());
	const HEIGHT = 40;
	const written: string[] = [];
	const terminal = {
		columns: 140, rows: HEIGHT,
		write(d: string) { written.push(d); },
		start() {}, stop() {}, hideCursor() {}, showCursor() {}, restoreOnExit() {},
	};
	const tui = new (TuiMainScreen as new (t: unknown) => any)(terminal);
	const root = new Container();
	tui.addChild(root);
	// 每条 transcript entry 一个组件，按顺序追加（pi 的 document 容器就是这个形状）
	const addText = (text: string) => {
		const entry = { lines: [text], render: () => entry.lines, invalidate() {} };
		root.addChild(entry);
	};

	for (let i = 0; i < 30; i++) addText(`● bash  step-${i}`);
	tui.doRender();

	// 一个 1x1 PNG 就够触发 kitty 图片路径（尺寸不影响判据）
	const tinyPng =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
	let wipes = 0;
	for (let k = 0; k < 6; k++) {
		addText(`● read  /tmp/shot-${k}.png`);
		const result = new Container();
		result.addChild(new Spacer(1));
		result.addChild(new Image(tinyPng, "image/png", { fallbackColor: (t: string) => t }, { maxWidthCells: 60 }));
		root.addChild(result);
		written.length = 0;
		const before = tui.fullRedraws;
		tui.doRender();
		if (tui.fullRedraws > before) wipes++;
		for (let i = 0; i < 10; i++) addText(`assistant: found it in shot-${k} (${i})`);
		written.length = 0;
		const before2 = tui.fullRedraws;
		tui.doRender();
		if (tui.fullRedraws > before2) wipes++;
	}
	assert.equal(wipes, 0, "打补丁后一轮多图会话不应再有整屏重画/抹 scrollback");
});

test("仓库镜像与安装副本一致（改了这边就要 cp 过去）", () => {
	const installed = path.join(os.homedir(), ".pi/agent/extensions/pi-tui-image-fix");
	const mirror = path.join(REPO, "clients/pi/extensions/pi-tui-image-fix");
	if (!fs.existsSync(installed)) return; // 没装就不管（测试机）
	for (const name of ["patch.ts", "index.ts", "cli.ts"]) {
		const a = path.join(mirror, name);
		const b = path.join(installed, name);
		if (!fs.existsSync(a) || !fs.existsSync(b)) continue;
		assert.equal(
			fs.readFileSync(b, "utf8"),
			fs.readFileSync(a, "utf8"),
			`${name}：安装副本与仓库镜像不一致，跑 cp -R clients/pi/extensions/pi-tui-image-fix ~/.pi/agent/extensions/`
		);
	}
});
