#!/usr/bin/env node
/**
 * cli.ts — 手动查看 / 打补丁 / 回滚「内联图不要整屏重画」补丁。
 *
 * 扩展（`index.ts`）已经会在每次启动时自动打补丁，这个 CLI 是给「想立刻确认」「想立刻
 * 回滚」「不想重启 pi」这三种情况用的。
 *
 *   node cli.ts --status      # 只看，不改任何文件
 *   node cli.ts --apply       # 打补丁（已打过则 no-op）
 *   node cli.ts --restore     # 用备份恢复上游原始字节
 *
 * 定位方式：本脚本通过 `process.argv[1]` 找不到 pi 的 bundle（它指向自己），所以显式
 * 走「找当前 PATH 里的 pi → 读 shim 里的 cli.js 路径」这条路。
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { applyPatch, describeStatus, findBundleDir, restorePatch, status } from "./patch.ts";

/**
 * 定位 pi 的 bundle 目录。
 *
 * 本脚本从 `process.argv[1]` 拿到的是**自己**（cli.ts），所以 `findBundleDir()` 在这里
 * 永远返回 undefined；而 `pnpm` 写的 `pi` shim 里路径带 shell 变量
 * （`$basedir/../global/v11/.../dist/bundle/cli.js`），不能直接拿来当路径用。
 * 所以走两条真实可行并逐条验证存在的候选：
 *   1. `PI_TUI_IMAGEFIX_BUNDLE`（自己指定，测试用）；
 *   2. `pnpm root -g` 下每个 `@earendil-works/pi-coding-agent*` 目录。
 */
function resolveBundleDir(): string | undefined {
	const direct = findBundleDir();
	if (direct) return direct;

	const override = process.env.PI_TUI_IMAGEFIX_BUNDLE;
	if (override) {
		const dir = findBundleDir([process.execPath, path.join(override, "cli.js")]);
		if (dir) return dir;
	}

	const candidates: string[] = [];
	// `pnpm root -g` 返回的是 pnpm 全局**虚拟仓**（`.../global/v11`），真正的包在它下面的
	// 一个个哈希目录里（`<hash>/node_modules/@earendil-works/...`），所以要扫一层。
	const addFromScope = (scope: string) => {
		let names: string[];
		try {
			names = fs.readdirSync(scope);
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.startsWith("pi-coding-agent")) continue;
			candidates.push(path.join(scope, name, "dist", "bundle"));
		}
	};
	try {
		const root = execFileSync("pnpm", ["root", "-g"], { encoding: "utf8" }).trim();
		if (root) {
			addFromScope(path.join(root, "@earendil-works"));
			for (const entry of fs.readdirSync(root)) {
				addFromScope(path.join(root, entry, "node_modules", "@earendil-works"));
			}
		}
	} catch {
		// 没有 pnpm 或不在 PATH：继续试后面的候选
	}
	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, "chunks"))) return dir;
	}
	return undefined;
}

const dir = resolveBundleDir();
const flag = process.argv[2] ?? "--status";

if (!dir) {
	console.error("找不到 pi 的 dist/bundle（PATH 里没有 pi？）");
	process.exit(1);
}

switch (flag) {
	case "--status": {
		const st = status(dir);
		console.log(describeStatus(st));
		if (st.state === "unpatched") console.log("→ 下次启动 pi 会自动补；也可以现在跑 `node cli.ts --apply`");
		break;
	}
	case "--apply": {
		const result = applyPatch({ bundleDir: dir });
		if (!result.ok) {
			console.error(`失败（${result.reason}）：${result.detail}`);
			process.exit(1);
		}
		if (result.changed) {
			console.log(`已打补丁：${result.relative}`);
			console.log(`备份：${result.backup}`);
			console.log("→ 重启 pi 生效");
		} else if (result.reason === "already-patched") {
			console.log("已经是打过补丁的状态，未改动任何文件");
		} else {
			console.log(`跳过（${result.reason}）：${describeStatus(result.status)}`);
			console.log("→ 上游可能已经修好，或这段代码结构变了；本扩展不会硬改");
		}
		break;
	}
	case "--restore": {
		const result = restorePatch({ bundleDir: dir });
		if (!result.ok) {
			console.error(`失败（${result.reason}）：${result.detail}`);
			process.exit(1);
		}
		console.log(result.restored ? `已恢复上游原始字节：${result.file}` : "没有备份，未改动任何文件");
		console.log("→ 重启 pi 生效（注意：扩展下次启动还会把补丁打回来；要永久停用请设 PI_TUI_IMAGEFIX=off）");
		break;
	}
	default:
		console.error(`未知参数 ${flag}；可用：--status | --apply | --restore`);
		process.exit(1);
}
