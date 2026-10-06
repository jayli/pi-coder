/**
 * explored-group / registry —— 「当前正在收集的只读分组」的共享状态 + 断组规则。
 *
 * ## 一个不间断的只读序列 = 一个分组（不按类别拆，也不按消息拆）
 *
 * 用户 2026-10-06 的目标形态里，`Search` 行与 `Read` 行共存在同一棵树里，所以
 * 「连续只读」就是分组的充分条件 —— 类别与工具名只影响**行的格式**（连续 read 合并成一行、
 * 行内按来源切段，见 `render.ts`），不影响分组边界。
 *
 * 2026-10-06 第二轮（用户实测后）：**跨消息也要合并**。旧实现把「家族不同」与「新的一条
 * assistant 消息」都当断组条件，于是实测下来满屏都是只有一行的 `Explored` 块。现在只保留
 * 用户列的那四条：旁白、Thinking、不可折叠工具、用户消息。
 *
 * ## 为什么是 `globalThis` 单例
 *
 * 三个扩展文件要读同一份状态：`bash-command-collapse.ts`（bash 块）、`read-path-collapse.ts`
 *（read 块）、以及本目录的 `index.ts`（原生 grep/find/ls 块 + 事件接线）。pi 的加载器
 * **不保证**给它们同一个模块实例（各扩展各自 import），所以状态挂在 `globalThis` 上 ——
 * 与 `sandbox-mode.ts` / `allowlist.ts` 同一手法，`/reload` 之后也还是同一份。
 *
 * ## 时机：为什么是「渲染驱动登记 + 事件驱动断组」
 *
 * 实测（`ToolExecutionComponent.updateArgs` → `updateDisplay` → `renderCall`）：**`renderCall`
 * 在流式期间就会被调用，早于 `tool_call` / `tool_execution_start`**。所以：
 *
 *   - **登记**放 `renderCall`（`ensureRegistered`）：本块第一次渲染时就确定自己的分组，
 *     当组长就画树、当成员就投 0 行 —— 不会「先按普通块渲染一帧再跳成分组」。
 *   - **断组**放事件（`replayMessage` / `noteToolCall`）：thinking、旁白、用户消息、
 *     不可折叠工具都得断，这些只在事件里看得到。
 *
 * 两条路都调 `register()`，而它是**幂等**的（id 已在 `byId` 里就返回同一个组），所以谁先跑
 * 结果都一样；登记顺序 == 内容顺序（两条路都按 content 数组顺序走），行序因此稳定。
 *
 * ## 断组规则（用户 2026-10-06 定）
 *
 * 一个分组 = **不被打断的最长连续只读序列**（可跨 assistant 消息）。以下任一出现即封口：
 *
 *   - `thinking` 块
 *   - assistant 的**非空** `text`（旁白）
 *   - `user` 消息
 *   - 任何**不可折叠**的 tool 调用（写 / 执行 / 其他工具）
 *
 * **不在列表里的一律不断** —— 类别不同不断、工具名不同不断、换了 assistant 消息也不断。
 *
 * ## 幂等重放：靠**内容指纹**而非消息对象
 *
 * `message_update` 会随流式推进**反复**触发，内容数组是**追加**的。如果每次都从头重放，
 * 一个 `[thinking, toolCallA, toolCallB]` 的消息会在第三次更新时把 thinking 又断一次，
 * 于是 A 与 B 被拆成两组 —— 错。**pi 每个更新发的是 `{...partialMessage}`（新对象）**，
 * 所以不能拿消息对象当键（试过，永远命中不了 —— 那就是用户看到的「相邻两个 Explored」）。
 * 现在用**内容指纹**（`content.length` + 最后一个块的 id）推进游标，详见 `replayMessage`。
 *
 * ## 为何要 armed 闸
 *
 * 分组靠「渲染层按 toolCallId 查表 → 命中就投 0 行」，而那张表是 `globalThis` 单例、
 * **跨会话存活**。若不禁用，任何只拿固定 id 反复渲染组件的代码（其他扩展的渲染测试就是
 * 这么写的）只要撞上曾经登记过的 id，那个块就静默变成 0 行。真会话里 id 唯一所以碰不到，
 * 但那是运气不是设计 —— 所以加一道「见过会话事件才 enable」的闸（`arm` / `isArmed`）。
 */

import { classifyToolCall, isPendingArgs, type FoldKind } from "./classify.ts";

/** 分组里的一行（一个成员）。 */
export interface GroupMember {
	/** toolCallId。 */
	id: string;
	/** 折叠类别（`read` / `search` / `list` / `git`）—— 只影响**行格式**（见 `render.ts`），不影响分组边界。 */
	kind: FoldKind;
	/** 工具名。`read` 与 bash 转义的 Read 靠它区分：决定该行是否加粗（见 `render.ts`）。 */
	toolName: string;
	args: unknown;
	/** 该成员此刻的状态（渲染圆点用）。 */
	status: "running" | "ok" | "error";
	/**
	 * 参数是否已经吐完（可以进树了）。**没 ready 的成员一行都不画**。
	 *
	 * 用户 2026-10-07 定：「bash 指令被吐完后（进入执行阶段），直接输出为折叠后的 Search」。
	 * 不遮的话行内文字会跟着模型的 token 一点点长（`└ bash` → `Search "auth"` →
	 * `Search "authorization" in proxy/`），仍然是「先看到流式文本」，只是换到了树里。
	 * 置位时机见 `markMessageReady`。
	 */
	ready: boolean;
}

export interface Group {
	/** 组长块的 toolCallId。 */
	leaderId: string;
	members: GroupMember[];
}

interface RegistryState {
	/** 当前打开的分组；`null` = 下一个只读块要开新分组。 */
	open: Group | null;
	/** id → 所属分组，渲染层 O(1) 查。 */
	byId: Map<string, Group>;
	/** 组长 id → 触发它重渲的函数（`renderCall` 时登记，加成员后调用）。 */
	leaderInvalidate: Map<string, () => void>;
	/**
	 * 已经「吐完参数」的 toolCallId 集合（见 `markMemberReady`）。
	 *
	 * 需要它而不只看成员上的 `ready`：就绪信号走**事件侧**（`message_end`），
	 * 而注册既可能早于它（实时流：`message_update` 先到），也可能晚于它
	 *（`/resume`：`hydrateFromHistory` 先跑，组件后构造）。迟注册的成员
	 * 在 `register()` 里从这个集合补上就绪位。
	 */
	readyIds: Set<string>;

	/**
	 * 当前正在追的 assistant 消息：见 `replayMessage` 的注释。
	 *
	 * - `contentKey`：已处理到的那一段的**内容指纹**（长度 + 最后一个块的 id）
	 * - `done`：处理到第几个块
	 * - `lastKey`：**第 `done` 个块**的身份，用于区分「同一条消息的追加」与「一条新消息」
	 *
	 * 不能用消息对象当键 —— pi 每次都发新对象（`{...partialMessage}`）。
	 */
	cursor: { contentKey: string; done: number; lastKey: string } | null;
	/**
	 * 本扩展是否已经接手（见过会话事件）。
	 *
	 * **没接手之前一律不分组** —— 见文件头「为何要 armed」—— 否则任何直接构造
	 * `ToolExecutionComponent` 的代码（比如其他扩展的渲染测试）只要 toolCallId 撞上
	 * 曾经登记过的值，就会静默地渲染 0 行。
	 */
	armed: boolean;
}

const STATE_KEY = "pi-explored-group-state";

function getState(): RegistryState {
	const host = globalThis as unknown as Record<string, RegistryState | undefined>;
	let state = host[STATE_KEY];
	if (!state) {
		state = { open: null, byId: new Map(), leaderInvalidate: new Map(), armed: false, cursor: null, readyIds: new Set() };
		host[STATE_KEY] = state;
	}
	return state;
}

/**
 * 标记本扩展已接手（收到第一个会话事件时调用）。
 *
 * 为什么需要这道闸：分组靠「渲染层按 id 查表」实现，而 `byId` 是**进程级**的
 *（`globalThis` 单例，跨 `/reload`、跨 session 存活）。若不禁用，任何只拿一个固定
 * toolCallId 反复渲染组件的代码（其他扩展的渲染测试就是这样）会撞上曾经登记过的 id，
 * 于是那个块静默变成 0 行 —— 真正的会话里 id 唯一所以碰不到，但这是运气不是设计。
 *
 * 闸门是「见过会话事件」：真实运行一定会收到 `session_start` 或 `message_*`，
 * 而单纯加载扩展、手搓组件不会。
 */
export function arm(): void {
	getState().armed = true;
}

/** 本扩展是否已接手（渲染层据此决定要不要走分组）。 */
export function isArmed(): boolean {
	return getState().armed;
}

/** 浅比较 args（流式里每次 `updateArgs` 都会给一个新对象，但内容常常没变）。 */
function sameArgs(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	const ka = Object.keys(a as object);
	const kb = Object.keys(b as object);
	if (ka.length !== kb.length) return false;
	for (const k of ka) {
		if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
	}
	return true;
}

/** 供测试：整块重置（含 armed 标志）。 */
export function resetForTesting(): void {
	const host = globalThis as unknown as Record<string, unknown>;
	delete host[STATE_KEY];
}

/**
 * 封口：当前分组到此为止，下一个只读块另开新组。
 *
 * `tool_call` 之类的事件里发起 —— 加成员之后要叫醒组长重渲，但**封口本身不需要重渲**
 *（已画出来的行不受影响）。
 */
export function beginBreak(): void {
	const state = getState();
	state.open = null;
}

/**
 * 登记一个可折叠成员（**幂等**）。
 *
 * - 已经登记过 → **刷新 args** 后返回它原有的分组（见下）
 * - 当前没有打开的组 → 开新组（本块当组长）
 * - 否则并进当前组
 *
 * **为什么已经登记过还要刷新 args**：`renderCall` 在工具参数**还在流式到达**时就会被调用，
 * 所以第一次登记常常只拿到一个**空 args**。如果就此定下，后面真实的 `path` / `command`
 * 就永远不进来了 —— 短语算不出来（`phraseForToolCall` 返回 null）于是回退成工具名，
 * 屏幕上出现 `└ Read read` 这种。实测遇到的观感 Bug 就是这个（用户 2026-10-06 报）。
 *
 * 刷新只在**真的不同**时写，否则每次 `renderCall` 都改对象会让下游缓存白失效。
 */
export function register(id: string, toolName: string, args: unknown): Group | null {
	const state = getState();
	const existing = state.byId.get(id);
	if (existing) {
		const member = existing.members.find((m) => m.id === id);
		if (member && args !== undefined && !sameArgs(member.args, args)) member.args = args;
		return existing;
	}

	const verdict = classifyToolCall(toolName, args);
	if (verdict.pending || !verdict.kind) return null;

	// 类别与工具名都**不**拆组：原生 `read` 与 bash 转义的 Read 现在同组，靠行内
	// 按来源切段来保住「加粗 = 原生工具」的语义（见 `render.ts` 的 `buildEntries`）。
	if (!state.open) {
		state.open = { leaderId: id, members: [] };
	}
	state.open.members.push({
		id,
		kind: verdict.kind,
		toolName,
		args,
		status: "running",
		// 迟到的注册要从集合里补就绪位（注册与就绪信号谁先谁后不固定，见 `readyIds`）。
		ready: state.readyIds.has(id),
	});
	state.byId.set(id, state.open);
	return state.open;
}

/**
 * 渲染层入口：确保本块已登记，并回报它在哪一组。
 *
 * 由三个 renderer 的 `renderCall` 第一时间调用 —— 返回值决定「画树 / 投 0 行 / 走原有逻辑」。
 * **未 arm 时一律返回 null**（走原有渲染），见 `arm` 的说明。
 *
 * 参数还没到齐时也返回 `null`（这一帧按普通块渲染）—— 下一帧 `renderCall` 会再来一次，
 * 那时 args 已全，就能正常入组。代价是块首帧可能按普通形态闪一下，但比错拆一组安全。
 */
export function ensureRegistered(id: string, toolName: string, args: unknown): Group | null {
	if (!isArmed()) return null;
	const verdict = classifyToolCall(toolName, args);
	if (verdict.pending || !verdict.kind) return null;
	return register(id, toolName, args);
}

/**
 * 参数还没到齐时，本块应当**一行都不画**（而不是退回内置渲染）。
 *
 * ## 为什么需要单独一个判定
 *
 * `ensureRegistered` 返回 `null` 有两种截然不同的含义，而渲染器需要分开处理：
 *
 *   1. **参数还在流**（`pending`）—— 这是**暂时**的，下一帧就会入组。此时若退回内置渲染，
 *      屏幕上就先画出一帧原生块：`grep // in .` / `• Read ...`，等 args 齐了又跳成
 *      `• Explored`。用户 2026-10-06 报的「先流出一段灰文本、随后立即折叠成 Explored 里的一条」
 *      就是这个（实测四张帧：grep / find / ls / read 全部中招）。
 *   2. **确实不可折叠**（如读 `SKILL.md`）—— 这时**应该**退回内置渲染（它的 `[skill]` 紧凑
 *      形态才是正确观感），而且这个判定不会再变。
 *
 * 所以只有第 1 种才抑制输出。判定用 `isPendingArgs`（看必填参数到没到）而**不是**
 * `argsComplete`：后者只在实时流里置位，`/resume` 重建历史时从不调（see `classify.ts`）。
 * 未 arm 时一律返回 `false` —— 本扩展没接管，就不该遮任何东西。
 *
 * **还必须带上 `isPartial`**：被 Esc 中断的块永远拿不到完整 args，只看 pending 会让它
 * 永久隐身（连报错都看不到）。详见函数内的注释。
 */
export function shouldHideWhilePending(toolName: string, args: unknown, isPartial: boolean): boolean {
	// 必须**两个条件同时成立**：
	//   - `isPendingArgs`：必填参数还没到（到了就直接画 `Explored`，不再遮）
	//   - `isPartial`：结果还没回来。pi 在 message_end(aborted / error) 时对每个尚未完成的块
	//     调 `updateResult({...}, false)`，**不置 argsComplete、也不补 args** ——
	//     只看 pending 的话，被 Esc 中断的块会永久隐身，连那条报错都看不到。
	//     bash 侧从一开始就是这个口径（`!streaming && !argsComplete && isPartial`，注释写
	//     「能看到被中断的是什么命令，比只显示一行报错更有用」），这里对齐它。
	return isArmed() && isPartial && isPendingArgs(toolName, args);
}

/** 本块属于哪个分组（未登记 → `undefined`）。 */
export function groupOf(id: string): Group | undefined {
	return getState().byId.get(id);
}

/** 本块是不是组长。组长负责画整棵 `Explored` 树，其余成员投 0 行。 */
export function isLeader(id: string): boolean {
	const group = getState().byId.get(id);
	return group !== undefined && group.leaderId === id;
}

/**
 * 组长登记「重渲我自己」的回调。
 *
 * 成员增加后要立刻反映到屏幕上 —— 但重渲只能由 pi 的渲染循环驱动，扩展不能自己去调
 * `render()`。`renderCall` 拿到的 `context.invalidate()` 正是那个入口（它内部会
 * `this.invalidate(); this.ui.requestRender()`）。
 */
export function setLeaderInvalidate(id: string, fn: () => void): void {
	getState().leaderInvalidate.set(id, fn);
}

/** 加成员后叫醒组长重渲（组长还没渲染过时回调不存在 —— 那次渲染自然会带上最新列表）。 */
export function notifyLeader(group: Group): void {
	getState().leaderInvalidate.get(group.leaderId)?.();
}

/**
 * 标记一个成员的参数已吐完（可以进树了）。**只在第一次置位时**叫醒组长重渲。
 *
 * 用户 2026-10-07 的事实要求：命令行没吐完就不该在树里出现 —— 否则行内文字会跟着 token
 * 一点点变长（`└ bash` → `Search "auth"` → …），观感与之前的「原生帧闪烁」同类。
 *
 * 谁调：`index.ts` 的 `message_end` 处理器（经 `markMessageReady`）。**刻意不放在
 * `renderCall` 里判 `argsComplete`**：那会把就绪与否绑在「这个块自己渲染过几次」上，
 * 而画树的是**组长** —— 两者不一定同步，成员自己没被渲染过就永远不会 ready。
 * `/resume` 重建历史时 `message_end` 不会重发，但那时 `hydrateFromHistory` 已重放一遍
 * （同一套路径），就绪位照常置上。
 */
export function markMemberReady(id: string): void {
	const state = getState();
	// 先记下意图，再管已注册的成员 —— 两者顺序与注册时机无关（见 `readyIds`）。
	state.readyIds.add(id);
	const group = state.byId.get(id);
	if (!group) return;
	const member = group.members.find((m) => m.id === id);
	if (!member || member.ready) return;
	member.ready = true;
	notifyLeader(group);
}

/**
 * 一条 assistant 消息**流完了** → 它里面所有工具调用的参数都收齐了，全部进树。
 *
 * 这是主信号：用户 2026-10-07 要的正是「指令被吐完后直接输出为折叠后的 Search」。
 * pi 的时序是「消息流完 → 再执行工具」，所以 `message_end` 就是「命令吐完」那一刻。
 * 用事件侧而不是在 `renderCall` 里判 `argsComplete`：后者把就绪与否绑在了
 * 「这个块自己渲染过几次」上，而树是由**组长**渲染的 —— 两者不一定同步。
 */
export function markMessageReady(message: unknown): void {
	const msg = message as { role?: string; content?: unknown } | null | undefined;
	if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return;
	const state = getState();
	state.readyIds = state.readyIds ?? new Set();
	for (const block of msg.content) {
		const b = block as { type?: string; id?: string } | null;
		if (b?.type === "toolCall" && typeof b.id === "string") markMemberReady(b.id);
	}
}

/** 该成员是否已吐完参数（未登记 → 视为已就绪，不影响调用方）。 */
export function isMemberReady(id: string): boolean {
	return getState().byId.get(id)?.members.find((m) => m.id === id)?.ready ?? true;
}

/**
 * 渲染时的开闸兜底：pi 一定会把**结果**或**终态**交给渲染器，那一刻参数必然已定。
 *
 * 主信号是 `message_end`（见 `markMessageReady`），但实测有两条路径拿不到它：
 *   - Esc 中断 / 模型报错：`message_end` 到了但参数可能永远是半截的，之后不再有事件；
 *   - 只有 `tool_execution_end` 而没有 `message_end` 的路径。
 * 两者都不开闸的话那个块会**永久隐身**（连报错都看不到）。判据 `isPartial !== true` 与
 * bash 侧隐藏逻辑的第二个条件同源 —— 结果都回来了，就没有「还在流」可言了。
 */
export function markReadyIfSettled(id: string, argsComplete: boolean, isPartial: boolean): void {
	if (argsComplete || !isPartial) markMemberReady(id);
}

/** 更新成员状态（`tool_execution_end` 时置 ok/error）。状态变了才重渲。 */
export function setMemberStatus(id: string, status: GroupMember["status"]): void {
	const state = getState();
	const group = state.byId.get(id);
	if (!group) return;
	const member = group.members.find((m) => m.id === id);
	if (!member || member.status === status) return;
	member.status = status;
	notifyLeader(group);
}

/**
 * 一个 toolCall 到达时的登记 + 断组入口（事件侧，`tool_call`）。
 *
 * 返回 `true` = 可折叠（已被分组纳管）；`false` = 不可折叠，**已经**顺手封口。
 * 参数还没到齐时返回 `false` **但不断组**（见 `classify` 的 `pending`）。
 */
export function noteToolCall(id: string, toolName: string, args: unknown): boolean {
	const verdict = classifyToolCall(toolName, args);
	if (verdict.pending) return false;
	if (!verdict.kind) {
		beginBreak();
		return false;
	}
	const group = register(id, toolName, args);
	if (group) notifyLeader(group);
	return true;
}

/**
 * 按**内容顺序**重放一条 assistant 消息里**尚未处理过**的块 —— 断组与登记的权威来源。
 *
 * 逐块语义：
 *
 * | 块 | 动作 |
 * |---|---|
 * | `thinking` | `beginBreak()` |
 * | 非空 `text` | `beginBreak()` |
 * | 可折叠 `toolCall` | `register()` + 叫醒组长 |
 * | 不可折叠 `toolCall` | `beginBreak()` |
 *
 * ## 去重为什么不能只依靠消息对象计数（踩过的坑）
 *
 * pi 在每一个 `message_update` 里发的是 `{...partialMessage}` —— **每次都是新对象**
 *（`dist/bundle` 的流式循环里那个 spread）。所以拿消息对象当键的 `WeakMap` 永远命中不了：
 * 第二次更新又被当成一条新消息，从 `content[0]` 重新跑一遍。而每个 assistant 消息都以一个
 * `thinking` 块开头，于是**每次 token 更新都会再断一次组** —— 屏幕上表现为`每个工具块自成
 * 一个 Explored`（用户 2026-10-06 报的第二、三个问题就是这个）。
 *
 * 所以去重键用**内容指纹**而不是对象身份：`content.length + 最后一个块的 id`。同一个消息的
 * 后续更新只会**追加**块，指纹因此单调前进；换了新消息（不同 `last id`）就重新开始。
 * 指纹相同 = 已经处理过这一段，直接返回。
 *
 * 这条设计同时保住了另外一个性质：**登记顺序 == 内容顺序**（`renderCall` 与事件两条路
 * 都按同一序走），行序因此稳定。
 */
/** 内容指纹：长度 + 最后一个块的 id（工具块）或其类型（thinking / text）。 */
function contentKey(content: unknown[]): string {
	return `${content.length}:${blockKey(content[content.length - 1])}`;
}

/** 单个块的身份：工具块用 id，其余用类型。 */
function blockKey(block: unknown): string {
	const b = block as { id?: string; type?: string } | undefined;
	return b?.id ?? b?.type ?? "";
}

export function replayMessage(message: unknown): number {
	const msg = message as { role?: string; content?: unknown } | null | undefined;
	if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return 0;
	arm();
	const state = getState();
	const key = contentKey(msg.content);
	// 指纹相同 = 同一条消息的那一段已经处理过
	if (state.cursor && state.cursor.contentKey === key) return 0;
	// 判断「这是同一条消息的追加」还是「一条新消息」。
	// 指纹已经不同了，所以只能靠**已处理过的那个前缀**来认：把上次游标位置的块拿出来对一下，
	// 对得上就是同一条消息又长长了；对不上（或者消息已经缩短）就是新消息。
	// 只比 `length >= done` 是不够的 —— 新消息如果比上一条长，会被误当成追加。
	const prev = state.cursor;
	const sameMessage =
		prev !== null &&
		prev.done <= msg.content.length &&
		blockKey(msg.content[prev.done - 1]) === prev.lastKey;
	let index = sameMessage ? prev!.done : 0;
	const from = index;
	// 新的一条 assistant 消息**不**断组：用户 2026-10-06 定，连续探查要跨消息合并
	//（「只要没有被旁白、非折叠工具、Thinking 加塞，Explored 就都合并展示」）。
	// `sameMessage` 本身仍然要算 —— 它管的是「流式重复更新不重复断组」，与分组边界无关。
	for (; index < msg.content.length; index++) {
		const block = msg.content[index] as { type?: string; name?: string; id?: string; arguments?: unknown; text?: string } | null;
		if (!block) continue;
		if (block.type === "thinking") {
			beginBreak();
			continue;
		}
		if (block.type === "text") {
			if (typeof block.text === "string" && block.text.trim() !== "") beginBreak();
			continue;
		}
		if (block.type === "toolCall" && typeof block.name === "string" && typeof block.id === "string") {
			const verdict = classifyToolCall(block.name, block.arguments);
			// 参数还没到齐：**什么都不做** —— 不断组、也不入组，等下一个更新（那时 args 就全了）。
			// 这里若当成「不可折叠」而断组，就正好把用户见到的「连续调用没合并」造出来。
			if (verdict.pending) continue;
			if (!verdict.kind) {
				beginBreak();
				continue;
			}
			const group = register(block.id, block.name, block.arguments);
			if (group) notifyLeader(group);
		}
	}
	state.cursor = { contentKey: key, done: index, lastKey: blockKey(msg.content[index - 1]) };
	return index - from;
}

/** `user` 消息也要断组（新一轮提问之后不该和上一轮的探索并在一起）。 */
export function noteUserMessage(): void {
	arm();
	beginBreak();
}
