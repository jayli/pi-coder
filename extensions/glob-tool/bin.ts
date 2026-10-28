/**
 * glob-tool / bin —— 找外部可执行文件（`rg` / `fd` / `git`）。零 pi 依赖。
 *
 * ## 顺序按用户 2026-10-26 定的口径
 *
 * 1. `PI_GLOB_RG` / `PI_GLOB_FD`（显式覆盖，测试与 A/B 用）；
 * 2. **pi 的 bin 目录**（`<agentDir>/bin/rg`）—— pi 自己就用这个位置放它下载的
 *    `rg` / `fd`（bundle 里的 `getBinDir()`），所以跟随它比跟随 `PATH` 更可靠：
 *    本机 `which rg` **找不到**，而 `~/.pi/agent/bin/rg` 一直在。
 * 3. `PATH`。
 *
 * 找不到就返回 `undefined`，调用方**静默降级**到 git / 走查档 —— 定位失败绝不能让一次
 * 查询失败。
 */

import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** `agentDir` 的解析与 pi 自己一致：`PI_CODING_AGENT_DIR` 可覆盖，默认 `~/.pi/agent`。 */
function resolveAgentDir(): string {
	const raw = process.env.PI_CODING_AGENT_DIR;
	if (raw === undefined || raw.trim() === "") return join(homedir(), ".pi", "agent");
	const trimmed = raw.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	return trimmed;
}

/** 文件存在且可执行？ */
function isExecutable(candidate: string): boolean {
	try {
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** 在 `PATH` 里找；`windows` 下补 `.exe`（本仓库只在 macOS / Linux 上跑，这里只为不留坑）。 */
function searchPath(name: string): string | undefined {
	const raw = process.env.PATH;
	if (raw === undefined) return undefined;
	const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	for (const directory of raw.split(delimiter)) {
		if (directory === "") continue;
		for (const suffix of suffixes) {
			const candidate = join(directory, name + suffix);
			if (isExecutable(candidate)) return candidate;
		}
	}
	return undefined;
}

export interface BinaryLookupEnv {
	/** 读取一个环境变量；缺省 `process.env`，测试可注入。 */
	readEnv?: (name: string) => string | undefined;
	/** 覆盖 agent 目录（测试隔离）。 */
	agentDir?: string;
}

/**
 * 按「env → agentDir/bin → PATH」三层找一个可执行文件。
 *
 * `envVar` 的值如果是裸名字（不含路径分隔符），就继续按后两层解析 —— 这样
 * `PI_GLOB_RG=rg` 这种写法与"没设"等价，不会因为写了个名字就找不到。
 *
 * **显式路径也要验可执行**：写错一个 `/nonexistent/rg` 就该按“定位不到”处理、走降级，
 * 而不是把一次查询变成一条 spawn 报错。
 */
export function locateBinary(name: string, envVar: string, env: BinaryLookupEnv = {}): string | undefined {
	const readEnv = env.readEnv ?? ((key: string) => process.env[key]);
	const override = readEnv(envVar)?.trim();
	if (override !== undefined && override !== "" && override.includes("/")) {
		return isExecutable(override) ? override : undefined;
	}

	const agentBin = join(env.agentDir ?? resolveAgentDir(), "bin", name);
	if (isExecutable(agentBin)) return agentBin;

	return searchPath(override !== undefined && override !== "" ? override : name);
}

/** `rg` 的定位（`PI_GLOB_RG`）。 */
export function locateRipgrep(env: BinaryLookupEnv = {}): string | undefined {
	return locateBinary("rg", "PI_GLOB_RG", env);
}

/** `fd` 的定位（`PI_GLOB_FD`）。 */
export function locateFd(env: BinaryLookupEnv = {}): string | undefined {
	return locateBinary("fd", "PI_GLOB_FD", env);
}
