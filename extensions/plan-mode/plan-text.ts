/**
 * plan-mode 的文本层：注入给模型的上下文、批准对话框的计划截断。
 *
 * 不 import pi / pi-tui，所以能直接单测。
 *
 * ## 计划的形状：一份 markdown，不是一串步骤
 *
 * `exit_plan_mode` 的参数与 Claude Code 的 `ExitPlanMode(plan)` 同形 —— 模型交上来的是
 * 它想给用户看的**完整方案文本**。2026-09-24 之前这里是 `steps: [{text}]`，那是「扩展
 * 持有执行进度」时代的产物：步骤要镜像进任务清单、要按序号记 `[DONE:n]`、要在状态行上
 * 报 `▶ n/N`。进度交还给模型之后，结构化步骤只剩展示这一个用途（文档名 slug 改由
 * `exit_plan_mode` 的 `slug` 参数提供，不再从计划文本里抽），
 * 而这两个用途一段 markdown 都能满足 —— 留着它只会让模型把方案拆成一句话一句话的清单，
 * 丢掉背景与取舍（正是计划文档要保住的东西）。
 *
 * ## 为什么不做「从回复的散文里抽计划」
 *
 * 官方 plan-mode 示例会从回复里认 `Plan:` 段落抽编号清单，本扩展不这么做：计划的唯一
 * 入口是 `exit_plan_mode` 工具参数。工具调用是明确的信号，多一次调用换掉一整类误判值得。
 */

import type { PlanDocMode } from "./plan.ts";

// =============================================================================
// 批准对话框的计划截断
// =============================================================================

/**
 * 对话框除计划正文外固定占用的行数。实测 `ExtensionSelectorComponent.render(100)`
 * 的输出：上下边框 2 + 空行 4 + 标题 1 + 选项行 + 快捷键提示 1。三选一比两选一多一行，
 * 所以基数是 **11**。终端窄于 `NARROW_COLUMNS` 时提示行折成两行，再多 1 行
 * （实测 W=40 → 12）。
 */
const DIALOG_CHROME_LINES = 11;
const DIALOG_CHROME_LINES_NARROW = 12;
const NARROW_COLUMNS = 50;

/**
 * 对话框**下方**还要留出的行数：statusline 两行（主线 + extension statuses）+
 * belowEditor widget 一行 + 余量两行。
 *
 * 为什么要预留：pi 用的是主屏渲染（`tui-main-screen.js`），每次重绘都把视口钉在
 * `bufferLength - height`，也就是**永远只显示最后 height 行**。对话框在组件树里位于
 * `editorContainer`，它下面还有 `widgetContainerBelow` 与 `footerContainer` —— 这些
 * 占多少行，对话框就只剩多少行能露出来。不预留就会把对话框顶部（也就是计划的开头）
 * 顶出屏幕。
 */
const BELOW_DIALOG_RESERVE = 5;

/** `Text` 的左右内边距（构造时 `paddingX = 1`），正文可用宽度 = 终端列数 - 2。 */
const DIALOG_PADDING_X = 1;

/** 截断后追加的提示行占 1 行。 */
const HINT_LINES = 1;

/** 对话框的度量与渲染能力（由调用方注入，本模块不 import pi-tui）。 */
export interface DialogMetrics {
	/** 终端行数（`process.stdout.rows`，与 pi-tui `terminal.js` 同源）。 */
	rows: number;
	/** 终端列数（`process.stdout.columns`）。 */
	columns: number;
}

/** 折行能力：注入 pi-tui 的 `wrapTextWithAnsi` 就能得到与对话框完全一致的行数。 */
export type WrapFn = (text: string, width: number) => string[];

/** 对话框留给计划正文的行数预算与正文可用列宽。 */
export function dialogPlanBudget(metrics: DialogMetrics): { budget: number; contentWidth: number } {
	const contentWidth = Math.max(8, metrics.columns - DIALOG_PADDING_X * 2);
	const chrome = metrics.columns < NARROW_COLUMNS ? DIALOG_CHROME_LINES_NARROW : DIALOG_CHROME_LINES;
	return { budget: metrics.rows - chrome - BELOW_DIALOG_RESERVE, contentWidth };
}

/**
 * 把计划全文截到批准对话框一屏放得下的高度。
 *
 * ## 为什么要截断
 *
 * `ctx.ui.select(title, options)` 在 pi 里就是 `ExtensionSelectorComponent`，它把
 * 「标题 + 正文」整个塞进**一个不可滚动的 `Text`**，`handleInput` 只认 ↑↓/enter/esc，
 * 没有任何滚动键位；主屏渲染又把视口钉在底部。于是长计划必然看不全 —— 这不是 bug，
 * 是那个组件的设计边界。
 *
 * 截断后配合「弹窗期间冻结重绘」（working-indicator 订阅 `ui_prompt_start`），被截掉的
 * 部分仍然写进了终端缓冲区（`render()` 不按屏高裁剪），用户可以用终端自己的回滚看全文。
 *
 * ## 行数怎么算
 *
 * 不自己估折行 —— `wrap` 由调用方注入 pi-tui 的 `wrapTextWithAnsi`，得到的行数与对话框
 * 真实渲染逐字一致（CJK 逐字断行、长词硬断都算得准）。本模块因此仍然不 import pi-tui，
 * 单测里注入一个简单折行器即可。
 *
 * 计划是 markdown，所以**按行**累计高度（一行至少占一行，空行也占一行 —— 段落间距是
 * 可读性的一部分，压掉反而更难读）。
 */
export function truncatePlanForDialog(plan: string, metrics: DialogMetrics, wrap: WrapFn): string {
	const lines = plan.replace(/\r\n/g, "\n").split("\n");
	const { budget, contentWidth } = dialogPlanBudget(metrics);
	const heights = lines.map((line) => Math.max(1, wrap(line, contentWidth).length));
	const total = heights.reduce((sum, height) => sum + height, 0);

	// 塞得下就原样返回 —— 短计划走这条路，一个字符都不动。
	if (total <= budget) return lines.join("\n");

	// 预算连「一行 + 提示行」都放不下（终端极矮）：只给提示行，保证不超预算。
	if (budget <= HINT_LINES) return `… 计划共 ${lines.length} 行（终端太矮放不下，上翻终端可看全文）`;

	const usable = budget - HINT_LINES;
	const kept: string[] = [];
	let used = 0;
	let fullyKept = 0;

	for (let index = 0; index < lines.length; index++) {
		const height = heights[index]!;
		if (used + height > usable) {
			// 第一行就装不下（它自己折行后比 usable 还高）：按宽度截到能显示，别给用户一个空框。
			if (kept.length === 0) {
				kept.push(truncateToColumns(lines[index]!, usable * contentWidth, wrap));
				fullyKept = 1;
			}
			break;
		}
		kept.push(lines[index]!);
		used += height;
		fullyKept += 1;
	}

	const hidden = lines.length - fullyKept;
	if (hidden > 0) kept.push(`… 还有 ${hidden} 行（上翻终端可看完整计划）`);
	return kept.join("\n");
}

/** 按列宽截断：用注入的 wrap 取前 N 行再拼回，末尾补省略号。 */
function truncateToColumns(text: string, maxColumns: number, wrap: WrapFn): string {
	if (maxColumns <= 0) return "…";
	const wrapped = wrap(text, Math.max(1, maxColumns));
	const first = wrapped[0] ?? "";
	return first.length > 0 ? `${first}…` : "…";
}

// =============================================================================
// 提示词
// =============================================================================

/**
 * plan 阶段每轮注入的上下文（`display: false`，用户看不到、模型看得到）。
 *
 * 写清楚三件事：现在是只读阶段、能做什么、最后必须调 `exit_plan_mode` 提交。不写
 * 「禁止改动」这类抽象要求，而是直接给出该走的路（读代码 → 用工具问用户 → 提交计划）。
 */
export function buildPlanModeContext(cwd: string): string {
	return `[PLAN MODE]

你现在处于 plan mode：只读探索阶段。改动类工具（edit / write）已从你的工具表里摘掉，
bash 里的写操作（重定向、rm / mv / sed -i / git commit / npm install 等）会被拦下并把
原因回给你。这不代表你卡住了 —— 它代表现在应该先把方案想清楚。

工作目录：${cwd}

在 plan mode 里：
- 尽管读：read / grep / find / ls / 只读 bash 都是通的，需要多少上下文就读多少
- 需要用户拍板的选择用 ask_user_question 问，不要自己替他决定
- 不要试图绕过限制（换个写法写文件、用 git 提交、装依赖都不行）

方案想清楚后，调用 exit_plan_mode 提交，参数 plan 是**给用户看的完整方案**（markdown）：
要解决什么问题、现状与约束、打算改哪些文件各改什么、怎么验证。用户会拿它决定批准还是
打回，所以别只写一串光秃秃的步骤标题 —— 把你探索到的背景写进去。同时给一个 slug
（小写英文短名，3~5 个词，如 \`m5-entity-runtime\`），批准后计划文档会以它命名。
提交后由用户决定；批准前你不会拿到写权限，所以不要提前说"我已经改好了"。`;
}

// =============================================================================
// 写文档子态
// =============================================================================

/**
 * 写文档子态每轮注入的上下文（`display: false`）。
 *
 * 用户在审批框里选了带文档的路线，模型现在要把已提交的方案**落成文件**。这一段是整条
 * 路线唯一的强制点 —— 文档内容全靠它驱动，所以要把三件事说到没有歧义：
 *
 *   1. **写到哪**：`docPath` 是扩展算好的绝对路径（`.pi/plans/YYYY-MM-DD-<slug>.md`），
 *      模型不该自己另选路径 —— `tool_call` 钩子只放行这一个路径，写别处会被拒。
 *   2. **写什么**：把 `plan` 全文整理成文档。读者是「零上下文的执行者」（可能是新会话、
 *      可能是别人），所以探索期读到的背景、涉及文件、每步怎么验证都要在，而不是把方案
 *      压缩成一句话步骤。
 *   3. **写完就结束**：不需要再调任何工具。扩展在 `tool_result` 里看到这次 write 成功
 *      就自动收尾（回进入前的模式、还原写权限），并把收尾指令交给模型。
 *
 * 还要写清楚**边界没变**：仍然是只读阶段，bash 的写操作照旧被拦，能写的只有这一个
 * 计划文件（用 write 工具）。否则模型会以为「批准了」而顺手开始改代码 —— 而 doc-only
 * 路线根本不该执行。
 */
export function buildDocWriteContext(docPath: string, plan: string, summary?: string): string {
	const summaryLine = typeof summary === "string" && summary.trim() !== "" ? summary.trim() : "（未提供总结）";
	return `[WRITE PLAN DOC]

用户批准了这个方案，并要求先把它落成一份计划文档。

**目标文件（就用这个路径，不要另选）**：\`${docPath}\`
用 write 工具写它。这是本阶段唯一允许写入的文件 —— 其余仍是只读阶段：edit 不可用，
bash 里的写操作（重定向、rm / mv / sed -i / git commit / npm install 等）照旧会被拦下。
**不要开始改代码**，尤其不要以为「写了文档就等于开始实施」。

方案总结：${summaryLine}

你提交的方案全文（整理成文档，不要压缩掉背景与取舍）：

${plan}

文档的读者是**零上下文的执行者**（可能是一个新会话，也可能是别人），所以结构大致是：

\`\`\`markdown
# <方案标题>

## 总结
<一段话说清楚要解决什么问题、怎么解决>

## 背景
<探索期查到的现状：相关文件现在怎么工作、为什么需要改、有哪些约束或坑>

## 涉及文件
<逐个列出要改/要建的文件，各一句说明它负责什么>

## 实施步骤
<按顺序写清楚每一步做什么：改哪个函数、加什么字段、边界怎么处理>

## 验证
<怎么确认做完了：测试命令、期望看到什么、手工验证步骤>

## 风险与未决
<已知取舍、没定的点、可能踩的坑；没有就写「无」>
\`\`\`

写完这一次 write 就结束 —— **不需要再调 exit_plan_mode 或任何别的工具**，扩展看到文件
写出来会自动收尾并把下一步指令交给你。`;
}

// =============================================================================
// 收尾指令
// =============================================================================

/**
 * 计划文档落盘后交给模型的收尾指令（工具结果文本）。
 *
 * 两条路线的差别只在「接下来做不做」，但**都必须把文档路径报出来** —— 那是这次规划
 * 唯一的持久产物，用户要能一眼看到它在哪。
 *
 * `doc-only` 的措辞要格外硬：收尾时写权限已经恢复（离开 plan 态是还原工具表的唯一
 * 时机），模型完全有能力顺手开始改代码，而用户明确选了「只写文档」。所以这里不是
 * 「建议不要」，而是「停下来」。
 *
 * `execute-with-doc` 则明确**不要求**建任务清单：进度归模型自己判断（这是本次改动的
 * 核心 —— 扩展不再镜像步骤、不再持有进度）。只告诉它文档在哪、可以回查。
 */
export function buildDocWrittenMessage(docMode: PlanDocMode, docPath: string): string {
	if (docMode === "doc-only") {
		return `计划文档已写好：\`${docPath}\`

用户选的是**只写文档、不实施**。写权限虽然已经恢复，但**现在就停下来**：把文档路径报告
给用户，不要开始改任何代码、不要建任务清单、不要继续往下做。要实施的话用户会自己说。`;
	}
	return `计划文档已写好：\`${docPath}\`

用户已批准，写权限恢复。现在按这份文档实施：
- 文档是这次规划的权威依据，需要回查背景、取舍理由或验证方式时读它（它不受上下文压缩影响）
- 要不要建任务清单（\`task_set\`）由你自己判断：多步骤、跨文件、需要让用户看到进度时建，
  一两步就能做完的事不必建
- 做完按文档的「验证」一节确认，然后报告结果`;
}

/**
 * 用户打回计划时交给模型的指令（工具结果文本）。
 *
 * 留在 plan 态（只读），等用户下一条反馈。措辞与 Claude Code 一致：不是「失败了」，
 * 而是「用户有意见，按意见改」。
 */
export function buildRejectedMessage(): string {
	return `用户没有批准这个计划，仍在 plan mode（只读）。请根据用户的下一条反馈调整方案；
改好后再调用 exit_plan_mode 提交。`;
}
