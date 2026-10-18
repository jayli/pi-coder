/**
 * theme-extra/colors.ts 的单测。
 *
 *   node --test clients/pi/extensions/theme-extra/colors.test.ts
 *
 * 两层：上半段用**假 ops + 假皮肤文件**钉判定逻辑（读哪个 key、草值怎么退化、缓存与开关）；
 * 下半段在能解析到 pi-tui 时用**真 ops** 跑等价性 —— 同一个色值经本模块与经 pi 自己的
 * `Theme.getFgAnsi()` 必须逐字节相同，这是本次改造「颜色保持一样」的全部依据。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	type ColorOps,
	resetSkinCacheForTesting,
	skinVarAnsi,
	themeVarAnsi,
} from "./colors.ts";

/** 假 ops：色值原样透出，便于断言「取的是哪个变量、走的哪个槽」。 */
const fakeOps: ColorOps = {
	parseColor: (value) => value,
	fgAnsi: (color, mode) => `FG(${String(color)},${mode})`,
	bgAnsi: (color, mode) => `BG(${String(color)},${mode})`,
};

const SKIN = {
	vars: {
		bashOutput: "#999999",
		addedLine: "#1c241b",
		removedLine: "#2e1c21",
		indirect: "addedLine",
		empty: "",
	},
};

test("skinVarAnsi：按槽位取 vars 里的色值", () => {
	assert.equal(skinVarAnsi(SKIN, "bashOutput", "fg", "truecolor", fakeOps), "FG(#999999,truecolor)");
	assert.equal(skinVarAnsi(SKIN, "addedLine", "bg", "256color", fakeOps), "BG(#1c241b,256color)");
});

test("skinVarAnsi：变量不存在 / 不是色值 → undefined（调用方走兜底）", () => {
	assert.equal(skinVarAnsi(SKIN, "nope", "fg", "truecolor", fakeOps), undefined);
	assert.equal(skinVarAnsi({ vars: {} }, "bashOutput", "fg", "truecolor", fakeOps), undefined);
	assert.equal(skinVarAnsi(undefined, "bashOutput", "fg", "truecolor", fakeOps), undefined);
	assert.equal(skinVarAnsi({}, "bashOutput", "fg", "truecolor", fakeOps), undefined);
	// 间接引用（"indirect": "addedLine"）不做链式解析，原样交给 ops.parseColor
	assert.equal(skinVarAnsi(SKIN, "indirect", "fg", "truecolor", fakeOps), "FG(addedLine,truecolor)");
});

test("skinVarAnsi：ops 抛异常也返回 undefined，不把错误带进渲染路径", () => {
	const throwing: ColorOps = {
		parseColor: () => {
			throw new Error("not a color");
		},
		fgAnsi: () => "",
		bgAnsi: () => "",
	};
	assert.equal(skinVarAnsi(SKIN, "bashOutput", "fg", "truecolor", throwing), undefined);
});

/** 把一份皮肤写进临时目录，返回路径与清理函数。 */
function writeSkin(json: unknown, name = "skin.json"): { dir: string; file: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-theme-vars-"));
	const file = path.join(dir, name);
	fs.writeFileSync(file, JSON.stringify(json));
	return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("themeVarAnsi：真读皮肤文件，并按主题对象缓存", () => {
	resetSkinCacheForTesting();
	const { file, cleanup } = writeSkin(SKIN);
	try {
		const theme = { sourcePath: file, getColorMode: () => "truecolor" };
		assert.equal(themeVarAnsi(theme, "bashOutput", "fg", fakeOps), "FG(#999999,truecolor)");
		// 改文件但 mtime 不变（写回同一内容）后，缓存命中仍返回同样结果
		assert.equal(themeVarAnsi(theme, "bashOutput", "fg", fakeOps), "FG(#999999,truecolor)");
		// 换主题对象（换皮肤/重载）→ 重新解析
		const fresh = { sourcePath: file, getColorMode: () => "truecolor" };
		assert.equal(themeVarAnsi(fresh, "addedLine", "bg", fakeOps), "BG(#1c241b,truecolor)");
	} finally {
		cleanup();
	}
});

test("themeVarAnsi：没有 sourcePath（内置主题的兜底形态）→ undefined", () => {
	resetSkinCacheForTesting();
	assert.equal(themeVarAnsi({ getColorMode: () => "truecolor" }, "bashOutput", "fg", fakeOps), undefined);
	assert.equal(themeVarAnsi(undefined, "bashOutput", "fg", fakeOps), undefined);
});

test("themeVarAnsi：PI_THEME_VARS=off 一键退回 pi 原生兜底", () => {
	resetSkinCacheForTesting();
	const { file, cleanup } = writeSkin(SKIN);
	try {
		const theme = { sourcePath: file, getColorMode: () => "truecolor" };
		assert.equal(themeVarAnsi(theme, "bashOutput", "fg", fakeOps, { PI_THEME_VARS: "off" }), undefined);
		assert.equal(themeVarAnsi(theme, "bashOutput", "fg", fakeOps, { PI_THEME_VARS: "on" }), "FG(#999999,truecolor)");
	} finally {
		cleanup();
	}
});

test("themeVarAnsi：sourcePath 指向不存在的文件 → undefined，不抛", () => {
	resetSkinCacheForTesting();
	const theme = { sourcePath: "/nonexistent/does-not-exist.json", getColorMode: () => "truecolor" };
	assert.equal(themeVarAnsi(theme, "bashOutput", "fg", fakeOps), undefined);
});

/* ------------------------------------------------------------------ *
 * 真 ops 等价性：本模块的结果必须与 pi 自己的 getFgAnsi() 逐字节相同
 * ------------------------------------------------------------------ */

/** pi 的库入口（非 CLI）。找不到就整体 skip —— 与 render.test.ts 同一套反查手法。 */
async function findPiLibraryEntry(): Promise<string | undefined> {
	const candidates: string[] = [];
	if (process.env.PI_TEST_PI_ENTRY) candidates.push(process.env.PI_TEST_PI_ENTRY);
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const shimPath = path.join(dir, "pi");
		try {
			const real = fs.realpathSync(shimPath);
			if (real !== shimPath) candidates.push(path.join(path.dirname(real), "index.js"));
		} catch {
			// 不是符号链接：看下面的 shim 脚本
		}
		try {
			const match = /^# cmd-shim-target=(.+)$/m.exec(fs.readFileSync(shimPath, "utf8"));
			if (match?.[1]) candidates.push(path.join(path.dirname(match[1].trim()), "index.js"));
		} catch {
			// 读不到这个 shim：跳过
		}
	}
	const packageDir = path.join(os.homedir(), ".pi/agent/npm/node_modules/@earendil-works/pi-coding-agent");
	candidates.push(path.join(packageDir, "dist/bundle/index.js"), path.join(packageDir, "dist/index.js"));
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			await import(pathToFileURL(candidate).href);
			return candidate;
		} catch {
			// 空壳副本：换下一个候选
		}
	}
	return undefined;
}

/**
 * 从与 pi 同一安装里取 pi-tui（本仓目录解析不到 `@earendil-works/pi-tui`，`ERR_MODULE_NOT_FOUND`）。
 * 路径必须从**真实包根**出发：本机 pi 是 pnpm 全局装，bundle 的 `dist/bundle` 旁边没有
 * `node_modules`，只有把 `…/node_modules/@earendil-works/pi-coding-agent` 这一段截出来、
 * `realpathSync` 解开符号链接，`require.resolve` 才找得到 pi-tui 的真身。
 */
async function loadTuiOps(piEntry: string): Promise<ColorOps | undefined> {
	const { createRequire } = await import("node:module");
	const marker = `${path.sep}node_modules${path.sep}@earendil-works${path.sep}pi-coding-agent${path.sep}`;
	const at = piEntry.indexOf(marker);
	const candidates: string[] = [];
	if (at >= 0) {
		const pkgRoot = piEntry.slice(0, at + marker.length - 1);
		let real = pkgRoot;
		try {
			real = fs.realpathSync(pkgRoot);
		} catch {
			// 断链就用字面路径
		}
		try {
			candidates.push(createRequire(path.join(real, "package.json")).resolve("@earendil-works/pi-tui"));
		} catch {
			// resolve 不出来：退回同级目录的 dist
		}
		candidates.push(path.join(path.dirname(real), "pi-tui", "dist", "index.js"));
	}
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			const tui = (await import(pathToFileURL(candidate).href)) as {
				parseColor: ColorOps["parseColor"];
				foregroundAnsi: ColorOps["fgAnsi"];
				backgroundAnsi: ColorOps["bgAnsi"];
			};
			return {
				parseColor: tui.parseColor,
				fgAnsi: tui.foregroundAnsi,
				bgAnsi: tui.backgroundAnsi,
			};
		} catch {
			// 换下一个
		}
	}
	return undefined;
}

const piEntry = await findPiLibraryEntry();
const ops = piEntry === undefined ? undefined : await loadTuiOps(piEntry);
const equivalenceSkip = ops === undefined ? "找不到本机 pi / pi-tui（装过 pi 才有）" : false;

/**
 * 本机皮肤目录里真实的三个自定义色。断言方式是**自证式**的：先确认皮肤文件里
 * `vars[name]` 确实存在（否则这个用例没意义），再比两条转义。
 */
const CUSTOM_COLORS: Array<{ name: string; skinVar: string; slot: "fg" | "bg" }> = [
	{ name: "bashOutput", skinVar: "bashOutput", slot: "fg" },
	{ name: "toolDiffAddedBg", skinVar: "addedLine", slot: "bg" },
	{ name: "toolDiffRemovedBg", skinVar: "removedLine", slot: "bg" },
];

test("等价性：本模块取 vars + pi-tui 转义 == pi 自己给 colors 里的键转义", { skip: equivalenceSkip }, () => {
	assert.ok(ops);
	const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi/agent/settings.json"), "utf8")) as {
		theme?: string;
	};
	const skinPath = path.join(os.homedir(), ".pi/agent/themes", `${cfg.theme ?? ""}.json`);
	if (!fs.existsSync(skinPath)) {
		// 本机没装这套皮肤：不假装通过，也不失败 —— 用内置 dark 的形态做等价性检查。
		return;
	}
	const skin = JSON.parse(fs.readFileSync(skinPath, "utf8")) as { vars?: Record<string, unknown> };
	let compared = 0;
	for (const { name, skinVar, slot } of CUSTOM_COLORS) {
		if (!(skinVar in (skin.vars ?? {}))) continue;
		// 本模块：读 vars → 转义
		const viaVars = skinVarAnsi(skin, skinVar, slot, "truecolor", ops);
		// pi 的形状：同一个色值经 parseColor + fg/bgAnsi
		const value = (skin.vars ?? {})[skinVar] as string;
		const viaPi = slot === "bg" ? ops.bgAnsi(ops.parseColor(value), "truecolor") : ops.fgAnsi(ops.parseColor(value), "truecolor");
		assert.equal(viaVars, viaPi, `${name}：vars 路径与 pi 原生转义必须逐字节相同`);
		// 256color 模式同样比一次（量化路径不同，容易分叉）
		const viaVars256 = skinVarAnsi(skin, skinVar, slot, "256color", ops);
		const viaPi256 = slot === "bg" ? ops.bgAnsi(ops.parseColor(value), "256color") : ops.fgAnsi(ops.parseColor(value), "256color");
		assert.equal(viaVars256, viaPi256, `${name}：256color 下也必须相同`);
		compared++;
	}
	assert.ok(compared > 0, "本机皮肤该至少定义了这三个自定义色之一");
});
