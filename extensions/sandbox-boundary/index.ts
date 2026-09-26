/**
 * Sandbox Boundary —— 给**不走 shell 的文件工具**补上 bash 沙箱管不到的那部分：删除。
 *
 * ## 为什么需要它
 *
 * bash 命令已经被 seatbelt 沙箱包住了（见 `bash-command-collapse/sandbox.ts`），但 pi 的
 * `write` / `edit` 工具**不走 shell** —— 它们是扩展进程里的直接 `fs` 调用，沙箱管不到。
 * 沙箱那边收回的能力只有一项（边界外的 `file-write-unlink`），所以这里也只需要补同一项：
 * **删除**边界外的文件才问，写入不问。
 *
 * ## 口径（用户 2026-09-24 定）
 *
 * > 写入目标在可写边界之外，不需要弹框提醒；只有删除的文件在沙箱之外才提醒。
 *
 * 于是：
 *
 * - `write` / `edit` / `multiedit` —— 一律放行，不看边界。它们只会创建或覆盖内容，
 *   不会让任何 inode 消失；覆盖前的旧内容属于「可逆性」范畴，由 git 与 AGENTS.md
 *   的 `## Destructive actions` 纪律负责，不是这道闸的职责。
 * - `apply_patch` —— 只检查 `*** Delete File: <path>` 行里的路径。`Update File` /
 *   `Add File` 是写入，放行。
 *
 * ## 三档授权（与 bash 沙箱同一套，用户 2026-09-24 定，同日新增「永不删除」档）
 *
 * 边界外的删除按目标路径分三档，判定核心是 `sandbox.ts` 的 `classifyOutsidePaths`，
 * 记忆落在 `allowlist.ts` 的同一个 globalThis 单例上 —— 所以 bash 侧记住的目录，
 * 这里立刻生效，反之亦然，两边口径不会漂移：
 *
 * - **永不删除**（身份 / 凭据 / 手写配置：`~/.zshrc`、`~/.ssh`、`~/.gnupg`…）：
 *   **不弹框、无任何放行选项**，直接 fail-closed。白名单 / 会话豁免 /
 *   `PI_SANDBOX_EXTRA_WRITE` 都压不过。整份 patch 一起拒。
 *   用户 2026-09-25 把 `~/.config`、`~/.pi`、`~/.claude`、`~/.codex` 移出本档 ——
 *   它们是工具状态目录（含 lock / 缓存 / 会话日志），走下面的普通档。
 * - **危险路径**（系统根 / bin / 应用安装目录 / `~/Library` / 含 `.git`）：每次都问，
 *   只支持会话级豁免（`Allow for this session`），重启 pi 后恢复。
 * - **普通路径**：问一次，`Allow for this session（并记住该目录）` 后把目录范围写进持久白名单，
 *   以后（含 headless）不再问。
 *
 * 与 bash 侧的一个区别：`apply_patch` 是 `tool_call` 钩子，**执行前**就能拦，且它知道
 * 全部目标路径（不像 bash 要先失败再从 stderr 里抽）。所以这里没有「命令重跑一次」的代价，
 * `Allow once` 就是单纯放行这一次、不记忆。
 *
 * ## 与 plan-mode 三态的关系（用户 2026-09-27 定）
 *
 * plan-mode 扩展持有三个权限模式（dangerous / bypass / plan），通过
 * `bash-command-collapse/sandbox-mode.ts` 的 globalThis 单例告知本扩展：
 *
 * - **bypass**（默认）：本扩展正常生效。
 * - **dangerous**：pi 原生的任意权限形态 —— 删除拦截整体关闭，`*** Delete File:`
 *   不检查、不弹框（包括永不删除档）。只能由用户 shift+tab 切到，没有命令也没有
 *   模型路径能进去，所以「关掉保护」永远是用户自己的决定。
 * - **plan**：本扩展不关心这一态 —— plan 自己的两道闸已经禁掉一切写入与删除。
 *
 * plan-mode 没装、或被 `PI_PLAN_MODE=off` 关掉时，单例永远是默认的 bypass，
 * 本扩展行为与三态化之前完全一致（fail-safe）。
 *
 * ## 体验
 *
 * 写入**一次都不弹窗**，边界内（含可再生缓存 `~/.cache`、`~/Library/Caches` 等）的删除
 * 也不弹 —— 这是绝大多数操作。只有删边界外的文件才问。
 * 命中持久白名单时静默放行，但补一行 `notify`（否则会疑惑「怎么不问了」）。
 * 非交互环境（`pi -p`、subagent）：持久白名单**生效**（授权本来就是交互时给的），
 * 危险目录与未授权的普通目录 fail-closed 直接拒 —— 没有人在屏幕前，"默认同意"等于没有边界。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	boundaryFromEnv,
	classifyOutsidePaths,
	isSandboxEnabled,
	memoryScopeFor,
	memoryScopesFor,
	neverDeleteReasonFor,
	sessionScopeFor,
	writableRoots,
	type PathEnv,
	type WriteBoundary,
} from "../bash-command-collapse/sandbox.ts";
import { getAllowlistStore, getSessionScopes } from "../bash-command-collapse/allowlist.ts";
import { getSandboxMode } from "../bash-command-collapse/sandbox-mode.ts";

/**
 * 可能携带删除意图的工具。
 *
 * `write` / `edit` / `multiedit` 刻意**不在**这个集合里 —— 它们只写不删（见文件头口径）。
 * `apply_patch` 的 `*** Delete File:` 是唯一一个「非 shell 工具也能删文件」的形状。
 */
const GUARDED_TOOLS = new Set(["apply_patch"]);

/**
 * 从工具入参里取出**要删除**的路径。
 *
 * `apply_patch` 的形状是 `patch` 文本，路径在 `*** Delete File: <path>` 行里。
 * `Update File` / `Add File` 是写入，按口径放行，所以这里不提取。
 * 认不出来就交给"无目标 → 放行"：bash 沙箱与 AGENTS.md 纪律仍在，
 * 不该为了一个形状猜错而拦住正常写入。
 */
function deleteTargetPaths(input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const obj = input as Record<string, unknown>;
	const out: string[] = [];

	if (typeof obj.patch === "string" && obj.patch) {
		for (const line of obj.patch.split("\n")) {
			const m = /^\*\*\* Delete File: (.+)$/.exec(line.trim());
			if (m?.[1]) out.push(m[1].trim());
		}
	}

	// 少数实现把删除目标单独放在字段里，一并认。
	for (const key of ["deletePaths", "deletedPaths"]) {
		const value = obj[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string" && item) out.push(item);
			}
		}
	}

	return out;
}

export default function (pi: ExtensionAPI) {
	// 与 bash 沙箱共用同一个开关：PI_SANDBOX=off 时两边一起关，不会出现
	// "bash 有边界、apply_patch 没边界"这种半开状态。
	// 注册期读一次（env + 平台）；plan-mode 的 dangerous 模式是**执行期**的第二道闸，
	// 同样两边一起关 —— 见下面 `sandboxActive()`。
	const envEnabled = isSandboxEnabled();
	/**
	 * 这一刀拦不拦：env 总闸与运行期模式取与。
	 * dangerous（plan-mode 三态之一，只能由用户 shift+tab 切到）= pi 原生任意权限，
	 * apply_patch 的 `*** Delete File:` 不检查、不弹框。plan-mode 没装时单例恒为
	 * 默认的 bypass，这里永远为 true。
	 */
	const sandboxActive = (): boolean => envEnabled && getSandboxMode() !== "dangerous";
	const allowlistPath = process.env.PI_SANDBOX_ALLOWLIST?.trim() || join(getAgentDir(), "sandbox-allowlist.json");
	const sessionScopes = getSessionScopes();
	// 路径分类需要的 IO（realpath / isDirectory）由这里注入，sandbox.ts 保持纯逻辑。
	const pathEnv: PathEnv = {
		home: homedir(),
		realpath: (p) => {
			try {
				return realpathSync(p);
			} catch {
				return undefined;
			}
		},
		isDirectory: (p) => {
			try {
				return statSync(p).isDirectory();
			} catch {
				return false;
			}
		},
	};
	const allowlist = () => getAllowlistStore(allowlistPath, pathEnv);
	let stats = { checked: 0, remembered: 0, confirmed: 0, blocked: 0 };

	pi.on("tool_call", async (event, ctx) => {
		if (!sandboxActive()) return undefined;
		if (!GUARDED_TOOLS.has(event.toolName)) return undefined;

		const paths = deleteTargetPaths(event.input);
		// 认不出删除目标就放行：这不是"漏网"，而是这个工具形状没有删除动作可判。
		// 真正的兜底是 bash 沙箱（删除最终都要落到某个路径上）。
		if (paths.length === 0) return undefined;

		const boundary: WriteBoundary = boundaryFromEnv(ctx.cwd ?? process.cwd());
		stats.checked += paths.length;
		const classification = classifyOutsidePaths(paths, {
			boundary,
			allowedRoots: allowlist().roots(),
			sessionRoots: sessionScopes.roots(),
			env: pathEnv,
		});

		const pending = [...classification.dangerous.map((d) => d.path), ...classification.ordinary];

		// 永不删除档：不弹框、无任何放行选项，直接 fail-closed。
		// 整份 patch 一起拒（与「全部命中才放行」同一口径）—— 否则一份 patch 里
		// 混一个 `*** Delete File: ~/.ssh/id_rsa` 会被其余合法操作带着放行。
		if (classification.blocked.length > 0) {
			stats.blocked += classification.blocked.length;
			return {
				block: true,
				reason:
					`以下路径是永不删除的身份/凭据/手写配置，任何授权方式都不放行：\n` +
					classification.blocked.map((d) => `  ${d.path}（${d.reason}）`).join("\n") +
					`\n如确需删除，请自己在终端执行（或 PI_SANDBOX=off 整体关掉这一层）。`,
			};
		}

		if (pending.length === 0) {
			// 全部命中边界内 / 持久白名单 / 会话豁免。命中白名单时补一行 notify，
			// 否则用户会疑惑「怎么不问了」。（边界内的删除不 notify —— 那是绝大多数操作。）
			if (classification.covered.length > 0 && ctx.hasUI) {
				ctx.ui.notify(`删除目标已在白名单内，放行：${classification.covered.join("、")}`, "info");
			}
			return undefined;
		}

		const roots = writableRoots(boundary).join("、");

		// 非交互环境：持久白名单已在上面 classify 时生效（命中的进了 covered），
		// 能走到这里说明没命中 → fail-closed。
		if (!ctx.hasUI) {
			stats.blocked += pending.length;
			return {
				block: true,
				reason:
					`删除目标在可删边界之外且未授权，非交互环境不予放行。\n` +
					`目标：${pending.join("、")}\n可删边界：${roots}\n` +
					`持久白名单：${allowlist().roots().length} 条（交互会话里 /sandbox-boundary allow <目录> 可预授权）`,
			};
		}

		const foldPaths = (list: readonly string[], limit = 3): string => {
			const shown = list.slice(0, limit).map((p) => `  ${p}`);
			if (list.length > limit) shown.push(`  …还有 ${list.length - limit} 处`);
			return shown.join("\n");
		};
		const hasDangerous = classification.dangerous.length > 0;
		const ordinaryScopes = memoryScopesFor(classification.ordinary, pathEnv, boundary.cwd);
		const dangerousScopes = classification.dangerous.map((d) => sessionScopeFor(d.path, pathEnv, boundary.cwd));

		let choice: string | undefined;
		if (hasDangerous) {
			const lines = [
				"⚠️ 删除目标在可删边界之外（危险目录）",
				"",
				"危险路径（每次删除都会问，只能会话级豁免）：",
				foldPaths(classification.dangerous.map((d) => `${d.path}（${d.reason}）`)),
			];
			if (classification.ordinary.length > 0) {
				lines.push("", "同批还有普通边界外路径（本次批准，不记住）：", foldPaths(classification.ordinary));
			}
			lines.push("", `可删边界：${roots}`, "", "选 Deny 不会删任何东西。");
			// pi 的 select 只有 (title, options)：正文必须拼进 title（destructive-guard 同一做法）。
			choice = await ctx.ui.select(lines.join("\n"), ["Deny", "Allow once", "Allow for this session"]);
		} else {
			const lines = [
				"⚠️ 删除目标在可删边界之外",
				"",
				"要删：",
				foldPaths(classification.ordinary),
				"",
				ordinaryScopes.length > 0
					? `将记住：${ordinaryScopes.join("、")}（以后这些目录下的删除不再询问）`
					: "这些路径算不出可安全记住的范围，只能逐次批准。",
				"",
				`可删边界：${roots}`,
				"",
				"选 Deny 不会删任何东西。",
			];
			choice = await ctx.ui.select(lines.join("\n"), [
				"Deny",
				"Allow for this session（并记住该目录）",
				"Allow once",
			]);
		}

		if (choice === undefined || choice === "Deny") {
			stats.blocked += pending.length;
			return {
				block: true,
				reason: `用户拒绝删除可删边界之外的路径：${pending.join("、")}（可删边界：${roots}）`,
			};
		}

		if (choice === "Allow for this session（并记住该目录）") {
			const remembered = allowlist().remember(ordinaryScopes, "confirm", pathEnv);
			stats.remembered += remembered.length;
			if (remembered.length > 0)
				ctx.ui.notify(
					`已永久记住 ${remembered.length} 个目录（重启后仍生效），以后其下的删除不再询问`,
					"info",
				);
		} else if (choice === "Allow for this session") {
			// 危险分支的会话级豁免：不落盘，重启 pi 即失效。
			sessionScopes.add(dangerousScopes);
		}
		// `Allow once`：什么都不记，直接放行这一次。

		stats.confirmed += pending.length;
		return undefined;
	});

	pi.registerCommand("sandbox-boundary", {
		description: "显示可删边界与白名单；forget <path> 移除一条，clear 清空，allow <path> 预授权",
		handler: (args, ctx) => {
			if (!envEnabled) {
				ctx.ui.notify("边界检查已关闭（PI_SANDBOX=off 或非 macOS 平台）。", "info");
				return;
			}
			if (getSandboxMode() === "dangerous") {
				ctx.ui.notify(
					"当前是 ☢ dangerous 模式：删除拦截整体关闭（任意权限）。shift+tab 回 ⏵ bypass 后边界与白名单重新生效。",
					"warning",
				);
				return;
			}
			const boundary = boundaryFromEnv(ctx.cwd ?? process.cwd());
			const [sub, ...rest] = args.trim().split(/\s+/);
			const store = allowlist();

			if (sub === "forget") {
				const target = rest.join(" ");
				if (!target) {
					ctx.ui.notify("用法：/sandbox-boundary forget <path>", "warning");
					return;
				}
				const removed = store.forget(target);
				ctx.ui.notify(removed ? `已移除白名单条目：${target}` : `白名单里没有这个条目：${target}`, removed ? "info" : "warning");
				return;
			}
			if (sub === "clear") {
				const n = store.clear();
				ctx.ui.notify(n > 0 ? `已清空白名单（${n} 条）` : "白名单本来就是空的", "info");
				return;
			}
			if (sub === "allow") {
				const target = rest.join(" ");
				if (!target) {
					ctx.ui.notify("用法：/sandbox-boundary allow <path>", "warning");
					return;
				}
				const scope = memoryScopeFor(target, pathEnv, boundary.cwd);
				if (!scope) {
					const never = neverDeleteReasonFor(target, pathEnv);
					ctx.ui.notify(
						never
							? `这是永不删除的身份/凭据/手写配置，不能预授权：${target}`
							: `这个路径算不出可安全记住的范围（太浅或本身危险）：${target}`,
						"warning",
					);
					return;
				}
				const remembered = store.remember([scope], "command", pathEnv);
				ctx.ui.notify(
					remembered.length > 0 ? `已预授权：${scope}` : `${scope} 已在白名单里，或被安全闸挡下`,
					"info",
				);
				return;
			}

			const entries = store.entries();
			const lines = [
				`可删边界：${writableRoots(boundary).join("、")}`,
				`本会话计数：检查 ${stats.checked}，记住 ${stats.remembered}，确认 ${stats.confirmed}，拒绝 ${stats.blocked}`,
				"",
				`持久白名单（${store.filePath}）：${entries.length} 条`,
				...(entries.length > 0 ? entries.map((e) => `  ${e.path}（${e.source}，${e.addedAt.slice(0, 10)}）`) : ["  （无）"]),
				"",
				`会话级豁免（重启失效）：${sessionScopes.roots().length ? sessionScopes.roots().join("、") : "（无）"}`,
				"",
				"危险目录（系统根 / bin / 应用安装目录 / ~/Library / 含 .git）每次删除都问，只能会话级豁免。",
				"永不删除（~/.zshrc、~/.ssh、~/.gnupg 等身份/凭据/手写配置）不弹框、无任何放行选项。",
				"写入不拦（write / edit 边界外也放行）；bash 命令由 seatbelt 沙箱强制同一道删除边界。",
				"子命令：forget <path> 移除一条 · clear 清空 · allow <path> 预授权。PI_SANDBOX=off 整体关闭。",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
