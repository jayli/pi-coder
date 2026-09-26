/**
 * 沙箱运行模式：plan-mode 的三态与沙箱层之间的唯一共享信号。
 *
 * plan-mode 扩展持有三态状态机（dangerous / bypass / plan），而删除拦截的两层
 * （bash 的 seatbelt 包裹在 `bash-command-collapse.ts`，apply_patch 的 tool_call
 * 检查在 `sandbox-boundary/index.ts`）分属另两个扩展文件。它们之间没有别的通道，
 * 所以这里提供一个 `globalThis` 单例：plan-mode 每次切态时 `setSandboxMode`，
 * 两个沙箱消费方在**执行期**（不是注册期）读 `getSandboxMode()` 决定这一刀拦不拦。
 *
 * ## 为什么挂 globalThis 而不是模块级变量
 *
 * 与 `allowlist.ts` 的 store 缓存同一条理由：两个扩展各自 import 本模块，pi 的
 * 加载器不保证给它们同一个模块实例 —— 挂在 globalThis 上则无论实例是否相同，
 * 读到的都是同一份状态（`/reload` 之后也一样）。
 *
 * ## 语义
 *
 *   - `bypass`（默认）：沙箱删除拦截**开启**。这是安全默认 —— plan-mode 没装、
 *     被 `PI_PLAN_MODE=off` 关掉、或还没切过态时，单例永远是 bypass，拦截照旧。
 *   - `dangerous`：沙箱整体关闭 —— bash 不包 seatbelt、apply_patch 删除不检查。
 *     这是 pi 原生的「任意权限」形态，只能由用户 shift+tab 切到。
 *   - `plan`：沙箱层不关心这一态 —— plan 自己的两道闸（工具收拢 + bash 写拦截）
 *     已经禁掉一切写入与删除；这里记下来只是让状态永远与 plan-mode 一致。
 *
 * `PI_SANDBOX=off` 是另一根独立的总闸（env + 平台，注册期读一次）；本模块的
 * dangerous 是运行期的第二道开关，两者取与：任何一道说关就关。
 */

export type SandboxMode = "dangerous" | "bypass" | "plan";

const KEY = "pi-sandbox-mode";

/** 读当前沙箱模式。从未设置过时返回 `"bypass"`（安全默认）。 */
export function getSandboxMode(): SandboxMode {
	const host = globalThis as unknown as Record<string, SandboxMode | undefined>;
	return host[KEY] ?? "bypass";
}

/** 写当前沙箱模式。只认三个合法值，其余一律收敛到 `"bypass"`（白名单式，与 plan-mode 的 normalizePhase 同口径）。 */
export function setSandboxMode(mode: unknown): void {
	const host = globalThis as unknown as Record<string, SandboxMode | undefined>;
	host[KEY] = mode === "dangerous" || mode === "plan" ? mode : "bypass";
}

/** 测试用：清掉单例，让下一次读回到默认 `"bypass"`。 */
export function resetSandboxModeForTesting(): void {
	const host = globalThis as unknown as Record<string, SandboxMode | undefined>;
	delete host[KEY];
}
