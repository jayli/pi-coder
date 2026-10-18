/**
 * summary-continuation.ts — 「延续短语」的判定与融合摘要提示词（纯逻辑，不 import pi / pi-tui）。
 *
 * ## 要解决的问题
 *
 * spinner 行尾那一格显示的是**当前回合提示词**的摘要。用户敲一条完整指令时这没问题；但
 * 相当一部分输入是上一轮的**延续短语** —— 「继续」「好的」「ok」「go ahead」—— 它们本身
 * 不含任何任务语义，于是那一格就只显示「继续」两个字，看不出这一轮到底在干什么。
 *
 * 本机语料实测（435 个会话 / 1309 条 user 消息）：≤24 字的短消息占 37%，其中真正的延续
 * 短语约 60 条（`继续` ×36、`同意，继续` ×5、`确认，继续` ×4、`好的，继续`、`go ahead` …），
 * 占总量约 4.6%。为这类输入多发一次摘要请求，成本可以忽略。
 *
 * 同一份语料也给出了**必须避免的误伤**：短 ≠ 延续。`commit and push` 出现 144 次、
 * `推送` / `commit` / `你是什么大模型` 都是独立完整的指令，它们只是恰好很短。所以判定
 * **不能按长度阈值**，只能按词表 —— 取向是「宁可漏判，不可误判」：漏判的后果是退回现状
 * （只显示短语本身），误判的后果是把一条独立指令的摘要写成上一轮的延续，那是错的。
 *
 * ## 判定（`isContinuationPhrase`）
 *
 * 三步，全部确定性、零成本：
 *
 *   1. **归一**：过 `flattenPrompt`（多行折一句、剥 ANSI / 零宽字符 / markdown 噪声），
 *      剥首尾标点与空白，转小写。于是 `OK!` / `好的。` / ` 继续 ` 都能命中。
 *   2. **按标点切段**（`,` `，` `、` `;` `；` `.` `。` `!` `！` `?` `？`），每段查词表：
 *      - 单段：在 `CONTINUE_WORDS ∪ ACK_WORDS` 里即命中；
 *      - 多段：**每段都在并集里**，且**至少一段在 `CONTINUE_WORDS` 里**。
 *   3. 某段查不中时，再试**剥一次前缀填充词**（`那就` / `那么` / `这样的话` / `这样` /
 *      `那` / `就`，最长优先）后重查：`那就继续` → `继续`、`好的，那就继续` 的第二段同理。
 *      两道约束防误伤：**先查表再剥**（`就这样` 本身是词表项，剥掉 `就` 会剩下查不到的
 *      `这样`），且**剥完至少剩 2 个码点**（`就是` 剥掉 `就` 会剩下 `是` —— 它在 ACK 表里，
 *      于是一句正常的话被误判成延续）。填充词表是封闭的，不做通用前缀剥离。
 *
 * 两个词表的分工是这套判定的核心：`CONTINUE_WORDS` 是「要求继续做」（继续 / 接着 /
 * go on / proceed …），`ACK_WORDS` 是「肯定上一轮」（好的 / 嗯 / ok / 同意 / 确认 …）。
 * 多段要求至少一个 CONTINUE，是为了让 `明白，继续` / `好的，那就继续` 命中，同时不让
 * `好的，收到` 这种纯确认被当成「要求做事」。刻意**不按空格切段**：`go ahead` /
 * `keep going` / `do it` 都是多词短语，按空格切会把它们打散成查不到的碎片。
 *
 * 词表外的新短语不覆盖（显示原短语，行为同现状，不劣化）—— 发现一个补一个即可。
 *
 * ## 融合提示词（`buildContinuationSummaryPrompt`）
 *
 * 与 `buildSummaryRequestPrompt` 同一套输出格式约束（单行、目标列数、汉字 2 列 / ASCII
 * 1 列的口径、无引号无 markdown 无标签），差别只在语义：明确告诉模型「新输入是上一任务的
 * 简短跟进，单独看没有意义」，让它把两者**融合成一行**说清现在要干什么，而不是分别复述。
 *
 * 语言跟随**上一任务**而不是新输入：短语是 `ok` 而任务是中文时，给出中文摘要才自然
 * （`buildSummaryRequestPrompt` 的「跟随原文」在这里会跟随到 `ok` 上去）。
 *
 * 上下文由调用方给（`index.ts`：上一回合的摘要优先，没有则退回 session 分支里上一条 user
 * 消息），这里只负责截断到 `MAX_CONTEXT_CHARS` —— 上一轮原文可能是几十 KB 的粘贴，
 * 而「一句话说清干什么」只需要它的开头那段语义。
 *
 * 本文件不 import pi / pi-tui，`node --test` 直跑（用例见 `summary-continuation.test.ts`）。
 */

import { flattenPrompt } from "./working-summary.ts";

/**
 * 「要求继续做」的词。归一后的形态（小写、无首尾标点）；多词短语整体作为一项，
 * 所以切段时**不能**按空格切（见文件头）。
 */
const CONTINUE_WORDS: ReadonlySet<string> = new Set([
	// 中文
	"继续",
	"继续吧",
	"继续继续",
	"请继续",
	"接着",
	"接着来",
	"接着做",
	"下一步",
	"做",
	"做吧",
	"干吧",
	"开始",
	"开始吧",
	"就这样",
	"就这样吧",
	"走起",
	"上吧",
	"来吧",
	"go on",
	"go ahead",
	"proceed",
	"continue",
	"keep going",
	"carry on",
	"do it",
	"do that",
	"make it so",
	"ship it",
	"let's go",
	"lets go",
	"run it",
	"next step",
	"go",
]);

/**
 * 「肯定上一轮」的词。单独出现时也算延续（`好的` = 「好，按你说的做」），但与别的
 * ACK 组合而没有 CONTINUE 时不算（`好的，收到` 只是在确认，没要求做事）。
 */
const ACK_WORDS: ReadonlySet<string> = new Set([
	// 中文
	"好的",
	"好",
	"好嘞",
	"好啊",
	"好呀",
	"好滴",
	"好哒",
	"嗯",
	"嗯嗯",
	"嗯好",
	"嗯好的",
	"对",
	"对的",
	"对对",
	"对对对",
	"是的",
	"是啊",
	"行",
	"行的",
	"可以",
	"可以的",
	"没问题",
	"没毛病",
	"同意",
	"确认",
	"确认了",
	"通过",
	"批准",
	"已批准",
	"收到",
	"明白",
	"明白了",
	"懂了",
	"了解",
	"知道了",
	// 英文
	"ok",
	"okay",
	"okey",
	"okk",
	"k",
	"kk",
	"yes",
	"y",
	"yep",
	"yeah",
	"yup",
	"sure",
	"sure thing",
	"alright",
	"all right",
	"approve",
	"approved",
	"lgtm",
	"sgtm",
	"sounds good",
	"+1",
]);

/**
 * 可剥的前缀填充词，**最长优先**（`那就` 必须排在 `那` 前面，否则先剥掉 `那` 会剩下
 * `就继续`，查不到）；只剥**一次**，且剥完仍要查词表。封闭表：不做通用前缀剥离 ——
 * 剥得越随意，`就是` / `就这样做吧，别的不改` 这类正常句子被剥成词表里某个词的概率越高。
 */
const LEADING_FILLERS: readonly string[] = ["那就", "那么", "这样的话", "这样", "那", "就"];

/** 切段用的标点分隔符。刻意不含空格（多词英文短语会被打散）。 */
const SEGMENT_SEPARATORS = /[,，、;；.。!！?？]+/;

/** 首尾要剥掉的标点与空白（`OK!` / `好的。` / `继续～`）。 */
const EDGE_PUNCTUATION = /^[\s,，、;；.。!！?？~～…·]+|[\s,，、;；.。!！?？~～…·]+$/g;

/**
 * 携带的上一任务上下文上限（码点）。上一轮原文可能是几十 KB 的粘贴，而「一句话说清
 * 干什么」只需要开头那段的语义；请求体越小越快。
 */
export const MAX_CONTEXT_CHARS = 600;

/** 归一：压平 → 剥首尾标点与空白 → 小写。 */
function normalize(text: string): string {
	return flattenPrompt(text).replace(EDGE_PUNCTUATION, "").trim().toLowerCase();
}

/** 这一段属于哪个词表；都不属于返回 null。 */
function classifySegment(segment: string): "continue" | "ack" | null {
	if (CONTINUE_WORDS.has(segment)) return "continue";
	if (ACK_WORDS.has(segment)) return "ack";
	return null;
}

/**
 * 剥一次前缀填充词后重查（`那就继续` → `继续`）。两个约束见文件头第 3 条：
 * 只在**直接查表失败后**才调用（调用方保证），且剥完至少剩 2 个码点。
 */
function classifyAfterFiller(segment: string): "continue" | "ack" | null {
	for (const filler of LEADING_FILLERS) {
		if (!segment.startsWith(filler) || segment.length <= filler.length) continue;
		const rest = segment.slice(filler.length).replace(EDGE_PUNCTUATION, "").trim();
		if ([...rest].length < 2) continue; // `就是` → `是`：单字残骸不认
		const kind = classifySegment(rest);
		if (kind !== null) return kind;
	}
	return null;
}

/**
 * 这条输入是不是「上一任务的延续短语」。传入原文或压平后的文本都可以（内部会再压平一次，
 * `flattenPrompt` 幂等）。空串 / 词表外一律 false —— 漏判的代价只是退回现状。
 */
export function isContinuationPhrase(text: string): boolean {
	const normalized = normalize(text);
	if (normalized === "") return false;

	const segments = normalized
		.split(SEGMENT_SEPARATORS)
		.map((segment) => segment.trim())
		.filter((segment) => segment !== "");
	if (segments.length === 0) return false;

	let sawContinue = false;
	for (const segment of segments) {
		const kind = classifySegment(segment) ?? classifyAfterFiller(segment);
		if (kind === null) return false; // 有一段查不到 → 整条不认（宁漏不误）
		if (kind === "continue") sawContinue = true;
	}
	// 单段时 ACK 就够（`好的` = 「按你说的做」）；多段必须真的有人在要求做事。
	return segments.length === 1 || sawContinue;
}

/** 按码点截断（不切半个代理对），超长补 `…`。与 `summary-request.ts` 同款做法。 */
function clipToPoints(text: string, maxPoints: number): string {
	const points = [...text];
	if (points.length <= maxPoints) return text;
	return `${points.slice(0, maxPoints).join("")}…`;
}

/**
 * 组装「延续短语」的摘要请求提示词。
 *
 * @param phrase    归一前的短语原文（`继续` / `ok`）—— 传原文而不是归一后的形态，
 *                  模型据此判断语气与语言。
 * @param context   上一任务（上一回合的摘要，或上一条 user 消息的截断）。
 * @param targetWidth 要求模型输出的目标宽度（可见列数），与渲染共用同一份数学。
 */
export function buildContinuationSummaryPrompt(phrase: string, context: string, targetWidth: number): string {
	return [
		"You label user prompts in a terminal status bar: say in one short line what the user is asking for.",
		"",
		"The new input below is a brief follow-up to the previous task, so it carries no meaning on its own.",
		"Merge the previous task with the new input and label what the user wants done now.",
		"",
		"Rules:",
		`- Output a single line, at most about ${targetWidth} display columns wide. A CJK/full-width character counts as 2 columns, an ASCII character as 1. Stay clearly under the limit rather than at it.`,
		'- No line breaks, no quotes, no markdown, no label like "Summary:", no explanation — only that line.',
		"- Keep the action and its main object. Drop greetings, background, examples and repeated detail.",
		"- Do not just restate the previous task: reflect what the follow-up changes or continues.",
		"- Write in the same language as the previous task.",
		"",
		"Previous task:",
		clipToPoints(context, MAX_CONTEXT_CHARS),
		"",
		"New input:",
		clipToPoints(phrase, 200),
	].join("\n");
}
