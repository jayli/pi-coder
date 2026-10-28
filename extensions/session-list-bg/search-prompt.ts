/**
 * search-prompt.ts — `/resume` 列表顶部**搜索框**的提示符（纯逻辑，不 import pi）。
 *
 * 用户 2026-10-28 定：那个 `> ` 改成 `Search: `。
 *
 * ## 提示符从哪来
 *
 * pi 的 `SessionList`（`components/session-selector.js`，文件内私有类，包根不导出）在构造函数里
 * `new Input()` —— 不带任何 options，所以 pi-tui `Input` 落到自己的默认值 `"> "`（见
 * `pi-tui/dist/components/input.js` 的 `this.prompt = options.prompt ?? "> "`）。渲染时
 * `Input.render` 用 `width - visibleWidth(prompt)` 算可用宽度，再补白铺满整行。
 *
 * 所以换提示符**只有一处**要动：那个 `Input` 实例的 `prompt` 属性。不去重拼渲染出来的行
 * （会动到补白宽度，而且鼠标命中那一列 pi-tui 里是写死的）；改属性后 pi 自己的宽度数学
 * 自动跟着变，整行仍然是终端宽度。`prompt` 在 TS 里是 `private readonly`，运行时就是个普通
 * 类字段，赋值即生效。
 *
 * ## 命中的是谁
 *
 * `SessionList` 与 `searchInput` 都是 `private`，运行时字段名就叫 `sessionList` / `searchInput`。
 * 这里只用「对象上有没有这个字段」判断，任何一环对不上就**安静跳过**（不猜、不抛）——
 * 调用方在渲染 tick 里，异常会把 pi 整个打死（`user-message-bar` 2026-09-20 实测）。
 *
 * ## 覆盖不到 `pi -r`
 *
 * 启动时的 `--resume` 选择器在扩展加载**之前**就构造并画完了（`main.js` 的 `selectSession()`
 * 先于扩展加载），那时补丁还不存在，提示符仍是 pi 的 `> `。与底色补丁同一个限制。
 *
 * ## 开关
 *
 * `PI_SESSION_LIST_PROMPT=<文本>` 换提示符；`off` / `none` / `-` → 保留 pi 自己的 `> `。
 * 值末尾没空格时自动补一个（`Search:` → `Search: `），免得提示符和输入内容粘在一起。
 */

/** 默认提示符（用户 2026-10-28 定）。 */
export const DEFAULT_SEARCH_PROMPT = "Search: ";

/** 关掉本项的值（保留 pi 自己的 `> `）。 */
const DISABLED = new Set(["off", "none", "-"]);

/**
 * 解析提示符：空 / 未设 → 默认 `Search: `；`off` / `none` / `-` → 空串（= 不改）；
 * 其余按原样使用，末尾缺空格时补一个。
 */
export function resolveSearchPrompt(raw: string | undefined): string {
	const value = raw ?? "";
	if (value.trim().length === 0) return DEFAULT_SEARCH_PROMPT;
	if (DISABLED.has(value.trim().toLowerCase())) return "";
	return value.endsWith(" ") ? value : `${value} `;
}

/**
 * 把提示符写到会话选择器的搜索框上。返回**本次有没有真的改**：
 * 已经是目标值、或者对象形状不认识（pi 改了私有字段名 / 不是那个组件）时返回 `false`。
 */
export function applySearchPrompt(selector: unknown, prompt: string): boolean {
	if (prompt.length === 0) return false;
	const list = readProperty(selector, "sessionList");
	const input = readProperty(list, "searchInput");
	if (input === undefined) return false;
	// 已经是目标值就不用重复赋值：渲染每帧都会走一遍，避免多余的写入（也方便测试判断「改过」）。
	if (readProperty(input, "prompt") === prompt) return false;
	try {
		(input as Record<string, unknown>).prompt = prompt;
		return true;
	} catch {
		return false;
	}
}

/** 读一个自有/继承属性；目标不是对象、或取值本身抛（活 Proxy 失效）时返回 `undefined`。 */
function readProperty(target: unknown, key: string): unknown {
	if (target === null || typeof target !== "object") return undefined;
	try {
		return (target as Record<string, unknown>)[key];
	} catch {
		return undefined;
	}
}
