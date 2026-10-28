/**
 * auto-default-model — 换模型时顺手把它写成「启动默认模型」，省掉那次 Ctrl+S。
 *
 * 为什么需要它：pi 的 `/model` 选择器**只改当前会话**的模型，想让下次启动停在某个模型上，
 * 必须额外按一次 Ctrl+S（`app.models.save` → `setModel(model, {persist: true})` →
 * `settingsManager.setDefaultModelAndProvider`，写 `~/.pi/agent/settings.json` 的
 * `defaultProvider` / `defaultModel`）。这是上游刻意的行为（CHANGELOG：「Fixed `/model` and
 * `/thinking` selections being persisted globally unless explicitly saved with Ctrl+S」），
 * 但对单人机器是多余的仪式：换完模型常常忘了按 Ctrl+S，下次启动又回到旧模型。
 * 本扩展把这一步自动化 —— 任何一次模型切换（`/model` 选择器、Ctrl+P 循环、
 * `pi-subagents` 的 profile 切换这类 `pi.setModel()` 调用）都立刻落盘。
 *
 * 落盘走的是 **pi 自己的公开 API**（`SettingsManager`，从 `@earendil-works/pi-coding-agent`
 * 导入，加载器对这个 specifier 做了 alias / virtualModules 映射，所以扩展里 on-demand import 它
 就是 pi 自己那份实现），也就是和 Ctrl+S 完全相同的那条持久化路径：
 * `FileSettingsStorage` + proper-lockfile 文件锁 + 「只把本次改动的字段合并进磁盘上最新内容」的
 * 读改写。所以①settings.json 里的其它字段（包括本扩展不认识的未来字段）不会被覆盖，
 * ②和 pi 自己的写入共用同一把锁，不会互相丢更新。**刻意不自己 `fs.writeFile`**：那样就会绕过
 * 那把锁，在用户同时改设置（`/theme`、`/settings`）时丢掉对方刚写进去的内容。
 *
 * 三个刻意的取舍：
 *   - `source === "restore"` **不落盘**。恢复会话时 pi 会把模型带回该会话自己的那条，
 *     那是「打开旧会话」而不是「我换了个模型」，让它改写全局默认会很意外。
 *     （pi 0.85.1 只在 `setModel()` / `cycleModel()` 里发 `model_select`，恢复走的是直接设
 *      `agent.state.model`，所以当前版本这个分支根本不会触发；写在这里是为了将来 pi 把
 *     `restore` 接上以后，语义仍然明确。）
 *   - 值没变就不写。选中同一个模型、或 pi 自己已经 persist 过一次（Ctrl+S、`/login` 后自动选
 *     该 provider 的默认模型）时 `model_select` 也会触发，重复写只会白白动 settings.json。
 *   - 只在失败时提示（`ctx.ui.notify`），成功不打扰：当前模型名在 statusline 上本来就看得见，
 *     换模型时再弹一条通知是噪音。
 *
 * 关掉：`PI_AUTO_DEFAULT_MODEL=off`（每次切换时读，不缓存）。
 */

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ModelSelectEvent } from "@earendil-works/pi-coding-agent";

type PersistOutcome = "written" | "unchanged" | "failed";
type PersistResult = { outcome: PersistOutcome; detail?: string };

function isDisabled(): boolean {
	return (process.env.PI_AUTO_DEFAULT_MODEL ?? "").trim().toLowerCase() === "off";
}

function modelLabel(event: ModelSelectEvent): string {
	return `${event.model.provider}/${event.model.id}`;
}

function notify(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "warning");
}

/**
 * 把 `provider/modelId` 写成全局启动默认模型。返回 "unchanged" 表示磁盘上已经是它。
 */
async function persistAsStartupDefault(cwd: string, provider: string, modelId: string): Promise<PersistResult> {
	const settings = SettingsManager.create(cwd);
	// 比的是**全局**设置而不是合并后的值：项目级 `.pi/settings.json` 里的 defaultProvider /
	// defaultModel 会盖过全局值（那条启动路径本扩展也管不了），拿合并值去比会误判成「已经写过了」。
	const global = settings.getGlobalSettings();
	if (global.defaultProvider === provider && global.defaultModel === modelId) {
		return { outcome: "unchanged" };
	}
	settings.setDefaultModelAndProvider(provider, modelId);
	await settings.flush();
	// settings.json 解析失败 / 写不进去时 `save()` 是**静默跳过**的（`globalSettingsLoadError`
	// 直接 return，`enqueueWrite` 的 catch 只记错误），`flush()` 也不抛 —— 结果只能从
	// `drainErrors()` 里读，否则扩展会假装写成功了。错误原文一并带出去，警告才有诊断价值。
	const failure = settings.drainErrors()[0];
	if (failure) return { outcome: "failed", detail: failure.error.message };
	return { outcome: "written" };
}

export default function (pi: ExtensionAPI) {
	pi.on("model_select", async (event, ctx) => {
		if (isDisabled()) return;
		if (event.source === "restore") return;
		try {
			const result = await persistAsStartupDefault(ctx.cwd, event.model.provider, event.model.id);
			if (result.outcome === "failed") {
				notify(ctx, `${modelLabel(event)} could not be written as the startup default model: ${result.detail ?? "reading or writing settings.json failed"}`);
			}
		} catch (error) {
			notify(ctx, `Failed to write the startup default model: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}
