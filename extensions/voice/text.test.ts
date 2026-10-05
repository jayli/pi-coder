/**
 * voice/text 的测试：纯函数，无 pi 依赖、无 IO。
 *
 *   node --test clients/pi/extensions/voice/text.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_MAX_CHARS,
	DEFAULT_SUMMARY_MAX_CHARS,
	DEFAULT_SUMMARY_MODEL,
	MIN_SPEAKABLE_CHARS,
	SUMMARY_INPUT_CLIP_CHARS,
	SUMMARY_SYSTEM_PROMPT,
	buildSummaryPrompt,
	cleanSummaryText,
	decideSpeak,
	parseVoiceLine,
	parseVoiceList,
	stripFencedCodeBlocks,
	stripSpokenNoise,
	toSpeakable,
	truncateAtSentence,
	truncateWithin,
} from "./text.ts";

// =============================================================================
// 代码块剥离
// =============================================================================

test("stripFencedCodeBlocks: ``` 块整体丢弃，块外内容保留", () => {
	const input = ["前面这句话要念。", "```bash", "npm run restart", "```", "后面这句也要念。"].join("\n");
	assert.equal(stripFencedCodeBlocks(input), "前面这句话要念。\n后面这句也要念。");
});

test("stripFencedCodeBlocks: ~~~ 围栏同样丢弃，info string 不影响", () => {
	const input = ["a", "~~~js title=x", "const x = 1;", "~~~", "b"].join("\n");
	assert.equal(stripFencedCodeBlocks(input), "a\nb");
});

test("stripFencedCodeBlocks: 未闭合围栏 → 到文末全部视为代码", () => {
	const input = ["要念的结论。", "```", "function f() {", "  return 1;", "}"].join("\n");
	assert.equal(stripFencedCodeBlocks(input), "要念的结论。");
});

test("stripFencedCodeBlocks: 不同字符的围栏不能互相闭合", () => {
	// ~~~ 里面的 ``` 只是内容，不能把 ~~~ 这段提前关掉
	const input = ["~~~", "```", "still code", "```", "~~~", "after"].join("\n");
	assert.equal(stripFencedCodeBlocks(input), "after");
	// 反向同理
	assert.equal(stripFencedCodeBlocks(["```", "~~~", "x", "~~~", "```", "after"].join("\n")), "after");
});

test("stripFencedCodeBlocks: 无围栏时原样返回", () => {
	assert.equal(stripFencedCodeBlocks("就一句话。"), "就一句话。");
});

// =============================================================================
// markdown → 播报文本
// =============================================================================

test("toSpeakable: 表格整行丢弃，正文保留", () => {
	const input = ["结论如下：", "| 模型 | 延迟 |", "| --- | --- |", "| a | 1s |", "就这些。"].join("\n");
	assert.equal(toSpeakable(input), "结论如下：\n就这些。");
});

test("toSpeakable: 链接只留文字，URL 丢弃，行内代码去反引号", () => {
	const input = "见 [文档](https://example.com/a/b) 与裸链 https://x.y/z，跑 `npm run restart` 即可。";
	// 中文之间的空隙一并收干净（中文本不用空格分词），拉丁词保留自己的空格
	assert.equal(toSpeakable(input), "见文档与裸链，跑 npm run restart 即可。");
});

test("toSpeakable: 裸 URL 不会因中文标点而吞掉后面的正文", () => {
	assert.equal(toSpeakable("看 https://x.y/z，然后重启。"), "看，然后重启。");
});

test("toSpeakable: 标题/引用/列表标记剥离，正文留下", () => {
	const input = ["## 结论", "> 引用一句", "- 第一点", "1. 第二点", "  - 嵌套点"].join("\n");
	assert.equal(toSpeakable(input), "结论\n引用一句\n第一点\n第二点\n嵌套点");
});

test("toSpeakable: 强调标记剥离", () => {
	assert.equal(toSpeakable("这**很**重要，***非常***重要。"), "这很重要，非常重要。");
	// 删除线保留文字（丢内容比念出一句陈旧信息更危险）
	assert.equal(toSpeakable("~~旧的~~新的。"), "旧的新的。");
	assert.equal(toSpeakable("__粗体__ 保留文字。"), "粗体保留文字。");
});

test("toSpeakable: 单个下划线不当斜体处理（标识符 snake_case 不能改）", () => {
	assert.equal(toSpeakable("改 user_id 这个字段。"), "改 user_id 这个字段。");
});

test("toSpeakable: 中英之间保留必需的空格（不能压成连写）", () => {
	assert.equal(toSpeakable("跑 npm 就行。"), "跑 npm 就行。");
	assert.equal(toSpeakable("见 README 这一节。"), "见 README 这一节。");
});

test("toSpeakable: emoji 与零宽字符去掉", () => {
	assert.equal(toSpeakable("完成了 ✅🎉 这个任务。"), "完成了 这个任务。");
});

test("toSpeakable: 纯图片行消失", () => {
	assert.equal(toSpeakable("![截图](/tmp/a.png)\n真的要念的是这句。"), "真的要念的是这句。");
});

test("toSpeakable: 空输入 → 空输出", () => {
	assert.equal(toSpeakable(""), "");
	assert.equal(toSpeakable("   \n\n  "), "");
});

test("toSpeakable: 只有代码块 → 空输出", () => {
	assert.equal(toSpeakable("```\nconst x = 1;\n```"), "");
});

test("toSpeakable: 行内代码里的 URL 两个反引号必须成对消费（真实案例回归）", () => {
	// 真实数据（2026-10-03 会话）：`https://github.com` 的反引号被 URL 正则吃掉一个，
	// 剩下的孤立反引号会跟后面 apikey.json 的反引号配对，把中间正文当成行内代码。
	const input = "不可达（`https://github.com` 直连超时），`apikey.json` 的 proxy 段是空的。";
	assert.equal(toSpeakable(input), "不可达（直连超时），apikey.json 的 proxy 段是空的。");
});

test("toSpeakable: 行内代码包裹的单个 URL 整体消失，不留残迹", () => {
	assert.equal(toSpeakable("看 `https://x.y` 这个地址。"), "看这个地址。");
});

test("toSpeakable: 奇数个反引号不会跨正文配对", () => {
	assert.equal(toSpeakable("单个反引号 ` 在这里，正文不该变成行内代码。"), "单个反引号在这里，正文不该变成行内代码。");
});

test("toSpeakable: 括号内侧不留 URL 被删后的空格", () => {
	assert.equal(toSpeakable("改好了（见 https://x.y/z 的说明）再重启。"), "改好了（见说明）再重启。");
});

test("toSpeakable: 文件路径去掉（真实语料反推的规则）", () => {
	assert.equal(
		toSpeakable("改了 clients/pi/README.md 和 adapter/index.js。"),
		"改了和。",
	);
	assert.equal(toSpeakable("装在 ~/.pi/agent/extensions/ 下面。"), "装。");
	assert.equal(toSpeakable("错误日志在 /Users/bachi/Library/Logs/。"), "错误日志。");
});

test("toSpeakable: 比率 / 单词对 / git ref / 斜杠命令都不能当路径剥掉", () => {
	// 这四类是真实语料里的误伤高危区（32/32、A/B、origin/main、/reload）
	assert.equal(toSpeakable("测试全过，32/32。"), "测试全过，32/32。");
	assert.equal(toSpeakable("两种形态 A/B 都试过。"), "两种形态 A/B 都试过。");
	assert.equal(toSpeakable("已推到 origin/main。"), "已推到 origin/main。");
	assert.equal(toSpeakable("跑 /reload 就能生效。"), "跑 /reload 就能生效。");
	assert.equal(toSpeakable("进度 107/113。"), "进度 107/113。");
});

test("toSpeakable: 文件路径去掉后不留残骸（真实语料的两种残骸）", () => {
	// ① 空括号：「（clients/pi/extensions/web-search-tree/）」→ 括号连同里面的路径一起去掉
	assert.equal(toSpeakable("新增了（clients/pi/extensions/web-search-tree/）这个扩展。"), "新增了这个扩展。");
	// ② 「路径 的 X」→ 摘路径时连「 的」一起收（真实语料：pnpm-workspace.yaml 的 minimumReleaseAgeExclude）
	assert.equal(
		toSpeakable("按既有做法绕过：`~/.pi/agent/npm/pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 补了一行。"),
		"按既有做法绕过：minimumReleaseAgeExclude 补了一行。",
	);
});

test("toSpeakable: 路径后的行号一起收，裸的「：N」/时间不能收", () => {
	// 行号（真实语料 3%）：`index.js`:644-668
	assert.equal(toSpeakable("见 adapter/index.js:644-668 注册的那段。"), "见注册的那段。");
	// 裸的冒号数字与时间是正常内容，绝不能当行号去掉
	assert.equal(toSpeakable("上限是 4，不是 5。"), "上限是 4，不是 5。");
	assert.equal(toSpeakable("本轮 00:11–00:12 跑的测试。"), "本轮 00:11–00:12 跑的测试。");
});

// =============================================================================
// 截断
// =============================================================================

test("truncateAtSentence: 未超上限原样返回", () => {
	assert.equal(truncateAtSentence("短句。", 100), "短句。");
});

test("truncateAtSentence: 超上限断在句末标点", () => {
	const text = "第一句话在这里。第二句话在这里。第三句话在这里。";
	const out = truncateAtSentence(text, 20);
	assert.ok(out.length <= 21, `截断后不应远超上限：${out.length}`);
	assert.ok(out.endsWith("。"), `应在句末结束：${out}`);
	assert.ok(text.startsWith(out), "截断结果必须是原文前缀（只可能多一个句号）");
});

test("truncateAtSentence: 没有句末标点时退到逗号边界", () => {
	const out = truncateAtSentence("这是一个很长的句子，里面有逗号但没有句号，一直写下去写下去", 20);
	assert.ok(out.length <= 21, `应在上限附近结束：${out}`);
	assert.ok(out.endsWith("。"), out);
});

test("truncateAtSentence: 连软边界都没有时硬截并补句号", () => {
	const out = truncateAtSentence("啊".repeat(100), 10);
	assert.equal(out, `${"啊".repeat(10)}。`);
});

test("toSpeakable: 默认上限生效", () => {
	const out = toSpeakable("这是一句话。".repeat(200));
	assert.ok(out.length <= DEFAULT_MAX_CHARS + 1, `默认应截到 ${DEFAULT_MAX_CHARS} 附近：${out.length}`);
});

// =============================================================================
// 播报判定
// =============================================================================

test("decideSpeak: aborted / error 一律不播", () => {
	assert.deepEqual(decideSpeak({ text: "有话要说。", stopReason: "aborted" }), { speak: false, reason: "aborted" });
	assert.deepEqual(decideSpeak({ text: "有话要说。", stopReason: "error" }), { speak: false, reason: "error" });
});

test("decideSpeak: 空 / 装饰性内容不播", () => {
	assert.deepEqual(decideSpeak({ text: "" }), { speak: false, reason: "empty" });
	assert.deepEqual(decideSpeak({ text: "---" }), { speak: false, reason: "decoration" });
	assert.deepEqual(decideSpeak({ text: "```\ncode\n```", maxChars: 100 }), { speak: false, reason: "empty" });
});

test("decideSpeak: 精简后过短不播", () => {
	assert.deepEqual(decideSpeak({ text: "好。" }), { speak: false, reason: "too-short" });
	assert.ok(MIN_SPEAKABLE_CHARS > 2, "下限应能挡掉『好。』这种");
});

test("decideSpeak: 问句默认播，speakQuestions=false 才跳过（用户 2026-10-04 定）", () => {
	const input = { text: "要我继续吗？", maxChars: 100 };
	// 默认（不传 speakQuestions）= 播 —— 模型回一句反问是最常见的收尾，静默跳过会像坏了。
	const byDefault = decideSpeak(input);
	assert.equal(byDefault.speak, true);
	if (byDefault.speak) assert.equal(byDefault.text, "要我继续吗？");
	// 显式关掉才回到旧行为。
	assert.deepEqual(decideSpeak({ ...input, speakQuestions: false }), { speak: false, reason: "question" });
});

test("decideSpeak: 正常结论 → 播精简后的文本", () => {
	const decision = decideSpeak({
		text: "已经修好了。\n\n```ts\nconst x = 1;\n```\n\n重启即可生效。",
		stopReason: "stop",
	});
	assert.equal(decision.speak, true);
	if (decision.speak) assert.equal(decision.text, "已经修好了。\n重启即可生效。");
});

test("decideSpeak: 工具调用收尾（stopReason=toolUse）也能播", () => {
	const decision = decideSpeak({ text: "先看一下这个文件的结构，然后我改掉那个判断。", stopReason: "toolUse" });
	assert.equal(decision.speak, true);
});

// =============================================================================
// 口播摘要：提示词构建与输出清洗
// =============================================================================

test("buildSummaryPrompt: 原文落在 <final_output> 里，带上字数上限", () => {
	const prompt = buildSummaryPrompt("已经改完了，重启生效。", 120);
	assert.match(prompt, /<final_output>\n已经改完了，重启生效。\n<\/final_output>/);
	assert.match(prompt, /不超过 120 个字/);
});

// 口播人设：中文机器人秘书助手，正常汇报、不称呼用户（2026-10-04 去掉「伙计」）。
test("口播人设：提示词用中文，指名机器人秘书助手、禁止称呼，要求口播稿而非摘要", () => {
	const prompt = buildSummaryPrompt("改完了。");
	assert.match(prompt, /机器人秘书助手/, "提示词要交代说话人身份");
	assert.match(prompt, /不要用任何称呼|称呼/, "提示词要禁止称呼用户");
	assert.ok(!/伙计/.test(prompt), "不该再出现「伙计」这个称呼");
	assert.match(prompt, /口播/, "提示词要说明这段文字是拿去念的");
	assert.match(prompt, /不要显示|不会显示|只.*念/, "提示词要说明这段文字不上屏");
	assert.ok(/[\u4e00-\u9fff]/.test(prompt), "提示词必须是中文");
	assert.ok(!/^You rewrite/.test(prompt), "不该残留英文旧提示词");
	assert.match(SUMMARY_SYSTEM_PROMPT, /机器人秘书助手/, "系统提示词同样要交代说话人身份");
	assert.ok(!/伙计/.test(SUMMARY_SYSTEM_PROMPT), "系统提示词不该残留旧称呼");
});

// 准确的硬要求：编造 / 美化是这类自动播报最危险的失败形态。
test("口播人设：提示词要求准确（不美化、不编造）并允许给建议", () => {
	const prompt = buildSummaryPrompt("改完了。");
	assert.match(prompt, /准确|如实/, "要有准确性要求");
	assert.match(prompt, /不要.*编造|不要编造/, "要禁止编造");
	assert.match(prompt, /建议/, "允许给建议");
});

// 语气的软要求（用户 2026-10-03 定、2026-10-04 重申继续保持）：允许一点点感性的亲切表达，
// 前提是不影响准确性；同时不能又滑回称呼 / 寒暄。
test("口播人设：允许不影响准确性的感性、亲切表达，但不称呼、不寒暄", () => {
	const prompt = buildSummaryPrompt("改完了。");
	assert.match(prompt, /亲切/, "要有亲切表达的口子");
	assert.match(prompt, /不影响准确/, "亲切表达要以不影响准确性为前提");
	assert.match(prompt, /不要寒暄|不要称呼/, "不能又滑回称呼 / 寒暄套话");
});

// 「不要推理，只快速生成摘要」（用户 2026-10-04 重申）：提示词必须禁掉思考过程。
test("口播人设：提示词禁掉推理过程，要求直接出口播稿", () => {
	const prompt = buildSummaryPrompt("改完了。");
	assert.match(prompt, /不要推理过程|不要思考过程/, "要禁掉推理过程");
	assert.match(prompt, /直接输出口播稿正文/, "要直接出口播稿");
});

// 当前字数上限：100（用户 2026-10-04 从 150 收紧），中文按字算。
test("口播摘要上限：默认 100 字，且这个词要写进提示词", () => {
	assert.equal(DEFAULT_SUMMARY_MAX_CHARS, 100);
	assert.match(buildSummaryPrompt("改完了。"), /100 个字/);
});

// 硬要求（用户 2026-10-04）：摘要只能比原文短，绝不能更长。
test("口播摘要：提示词明确要求绝不能比原文长", () => {
	const prompt = buildSummaryPrompt("改完了。");
	assert.match(prompt, /绝不能比原文长/, "这一条要写死在提示词里");
	assert.match(prompt, /只能更短/, "同时给正面表述");
});

// 内容取舍（用户 2026-10-04）：优先讲关键 / 直接回应用户问题的信息，次要、辅助、修饰性
// 的内容可以少说甚至不说 —— 口播稿只有两三句的容量，字数必须花在最重要的信息上。
test("口播摘要：提示词要求优先关键 / 直接回应问题的信息，次要辅助修饰内容可省", () => {
	const prompt = buildSummaryPrompt("改完了。");
	assert.match(prompt, /直接回应/, "要优先直接回应用户问题的信息");
	assert.match(prompt, /关键/, "要优先关键信息");
	assert.match(prompt, /重要/, "要优先重要信息");
	assert.match(prompt, /次要/, "次要内容允许少说 / 不说");
	assert.match(prompt, /辅助/, "辅助内容允许少说 / 不说");
	assert.match(prompt, /修饰/, "修饰性内容允许少说 / 不说");
});

// 不念编号（用户 2026-10-04 定，实测反馈：提交 / 推送的播报里还是会把 commit 编号念出来）。
// 口播是秘书旁白，只说清做了什么、结果如何 —— 这正是「挑关键的说」在编号上的落点。
test("口播摘要：提示词要求说事不念编号（commit / hash / 推送范围 / 行数 / 文件数）", () => {
	const prompt = buildSummaryPrompt("改完了。");
	assert.match(prompt, /commit ?编号|commit/, "要点名 commit 编号这类技术细节");
	assert.match(prompt, /hash|哈希|编号/, "要覆盖 hash 这类标识");
	assert.match(prompt, /不要念|不念/, "要用否定的说法说清楚");
	assert.match(prompt, /行数|增删/, "增删行数也在禁念之列");
});

// 凭据没有例外口子：编号在「问的就是它」时可以念，密码 / key 任何情况下都不行。
test("口播摘要：提示词禁止念密码 / Key / token，且这条没有例外", () => {
	const prompt = buildSummaryPrompt("改完了。");
	assert.match(prompt, /密码/, "要点名密码");
	assert.match(prompt, /Key|密钥/, "要点名 Key");
	assert.match(prompt, /token/i, "要点名 token");
	// 例外那条要排除凭据（编号可答、凭据不可答）。
	assert.match(prompt, /密码 \/ Key 之类还是不要说|凭据.*不要说/, "例外口子必须把凭据排除在外");
});

test("truncateWithin: 一定不超过上限（truncateAtSentence 补的句号也算在内）", () => {
	// 没有句读的长串：truncateAtSentence 会补一个「。」，长度会到 limit + 1。
	const noStop = "甲".repeat(200);
	assert.equal(truncateAtSentence(noStop, 50).length, 51, "前提：truncateAtSentence 确实会多出 1 个字");
	assert.equal(truncateWithin(noStop, 50).length, 50, "truncateWithin 必须夹到 50");

	// 有句读时与 truncateAtSentence 一致（不无谓改动）。
	const withStop = `${"甲".repeat(20)}。${"乙".repeat(80)}`;
	assert.equal(truncateWithin(withStop, 50), truncateAtSentence(withStop, 50));
	// 短文本原样返回。
	assert.equal(truncateWithin("改完了。", 100), "改完了。");
});

// 固定摘要模型（用户 2026-10-03 定）：不用会话模型，避免重模型拖慢口播。
test("DEFAULT_SUMMARY_MODEL 是 deepseek-flash-qd", () => {
	assert.equal(DEFAULT_SUMMARY_MODEL, "deepseek-flash-qd");
});

test("buildSummaryPrompt: 超长原文截头保留，不整篇塞进去", () => {
	const long = "甲".repeat(SUMMARY_INPUT_CLIP_CHARS + 500);
	const prompt = buildSummaryPrompt(long);
	// 提示词长度与原文长度**无关**：只装得下截断后的正文 + 固定模板（模板本身几百字，
	// 所以不能拿「比原文短」当断言 —— 原文刚好超一点时它就不成立了）。
	assert.ok(prompt.length < SUMMARY_INPUT_CLIP_CHARS + 1000, "提示词必须只带截断后的正文");
	assert.ok(
		buildSummaryPrompt("甲".repeat(20_000)).length < SUMMARY_INPUT_CLIP_CHARS + 1000,
		"原文再长也不整篇塞进去",
	);
	assert.ok(prompt.includes("…"), "截断处要有省略号");
	assert.ok(!prompt.includes("甲".repeat(SUMMARY_INPUT_CLIP_CHARS + 1)), "不该含超过上限的连续原文");
});

test("buildSummaryPrompt: 未超上限的原文原样保留（不无谓截断）", () => {
	const text = "甲".repeat(SUMMARY_INPUT_CLIP_CHARS);
	assert.ok(buildSummaryPrompt(text).includes(text));
});

test("cleanSummaryText: 只留一个连续段（换行收成空格），剥掉列表 / 标题 / 加粗标记", () => {
	const raw = ["## 标题", "- **第一件事**做完了。", "- `第二件事`还在等。"].join("\n");
	assert.equal(cleanSummaryText(raw), "标题第一件事做完了。第二件事还在等。");
});

test("cleanSummaryText: 去掉整体引号 / 加粗包裹与「摘要：」前缀", () => {
	assert.equal(cleanSummaryText('"改完了。"'), "改完了。");
	assert.equal(cleanSummaryText("**改完了。**"), "改完了。");
	assert.equal(cleanSummaryText("摘要：改完了。"), "改完了。");
	assert.equal(cleanSummaryText("Summary: 改完了。"), "改完了。");
	assert.equal(cleanSummaryText("「改完了。」"), "改完了。");
});

test("cleanSummaryText: 整段被 fence 包住时剥掉围栏", () => {
	assert.equal(cleanSummaryText("```\n改完了。\n```"), "改完了。");
});

test("cleanSummaryText: emoji 去掉，空 / 全装饰返回空串", () => {
	assert.equal(cleanSummaryText("改完了 ✅"), "改完了");
	assert.equal(cleanSummaryText(""), "");
	assert.equal(cleanSummaryText("\n\n"), "");
    assert.equal(cleanSummaryText("🎉🎉"), "");
});

test("cleanSummaryText: 超长在句边界截断并补句号", () => {
	const raw = `${`甲`.repeat(DEFAULT_SUMMARY_MAX_CHARS - 1)}。第二句在限外。`;
	const cleaned = cleanSummaryText(raw);
	assert.ok(cleaned.length <= DEFAULT_SUMMARY_MAX_CHARS, `实际 ${cleaned.length} 字，应在上限内`);
	assert.ok(cleaned.endsWith("。"), "截断处应该收成一句完整的话");
});

// =============================================================================
// 编号 / 凭据的机械过滤（提示词的兜底）
// =============================================================================

/** 一条真实的「提交 + 推送」结论（2026-10-04 会话语料）。 */
const COMMIT_PUSH_SUMMARY =
	"已提交并推送。 - commit: `e752224` — `feat(voice): 阿里云口播换 qwen-audio-3.1-tts-flash 并支持方言指令`，9 个文件（+232/−57） - push: `fa90a4d..e752224 main -> main`，两个 remote（GitHub `jayli/litellm-any` 与内网 GitLab）";

test("stripSpokenNoise: 真实语料里的 commit / push 结论不再漏编号", () => {
	const speakable = toSpeakable(COMMIT_PUSH_SUMMARY);
	assert.ok(!/e752224|fa90a4d/.test(speakable), `不该念 commit 编号与推送范围：${speakable}`);
	assert.ok(!/\+232|−57/.test(speakable), `不该念增删行数：${speakable}`);
	assert.ok(speakable.includes("已提交并推送。"), "动作本身要保留");
});

test("stripSpokenNoise: commit 编号与推送范围成对剥掉（语料里的几种写法）", () => {
	for (const input of [
		"**commit** `eaacc61`：`fix(voice): 结论输出后立即播报`",
		"push: `fa90a4d..e752224`",
		"各自 `a056410..1c2a7b4`",
		"本地从 `5161261` 前进到 `e253042`",
		"编号 73505695 是这次提交",
	] ) {
		assert.ok(!/[0-9a-f]{7}/.test(stripSpokenNoise(input)), `还有编号没剥干净：${stripSpokenNoise(input)}`);
	}
});

test("stripSpokenNoise: 凭据剥掉（Bearer / sk- / 赋值式）", () => {
	// 反引号 / 括号的清理是 `stripInlineMarkup` 的职责（管线里在本函数之前跑），
	// 这里只断言「密钥字符本身没留下来」。
	assert.ok(!/sk-abc123/.test(stripSpokenNoise("还是 `Bearer sk-abc123` 认证")), "Bearer 后跟的 key 要剥");
	assert.ok(
		!/e08b024605b34be5b6ad5826e0cd9c1b/.test(stripSpokenNoise("Key（sk-e08b024605b34be5b6ad5826e0cd9c1b）已写入")),
		"sk- 前缀的密钥要剥",
	);
	assert.equal(stripSpokenNoise("密码：abcd1234 已改"), "已改");
	assert.equal(stripSpokenNoise("apiKey=DEEPSEEK_API_KEY 已经换了"), "已经换了", "赋值式要把整个 key 一起收掉");
});

test("stripSpokenNoise: 型号类的 kebab 标识不念，但文件 / 模块名与短型号要留下", () => {
	assert.equal(stripSpokenNoise("换了 qwen-audio-3.1-tts-flash 模型"), "换了模型");
	assert.equal(stripSpokenNoise("qwen3.8-max 太慢"), "太慢");
	assert.equal(stripSpokenNoise("claude-opus-4-6 换了"), "换了");
	assert.equal(stripSpokenNoise("改 user_id 这个字段"), "改 user_id 这个字段");
	// 短型号 / 含数字的普通标识：两段形态太短，机械层分不出「型号」还是「行号区段」，
	// 一律不摘（宁可少摘）。它们本来也念得出来。
	assert.equal(stripSpokenNoise("用 GPT-4 跑的"), "用 GPT-4 跑的");
	assert.equal(stripSpokenNoise("从 L72-73 行"), "从 L72-73 行");
	// `api2-v2`：三段以下、首段带数字 → 落进型号档，会被摘（它在上下文里就是个端点 / 型号名）。
});

// 日期前缀的名字 / 枚举短语不能被当型号摘掉（真实语料里 `2026-09-30-minecart` 出现过 85 次、
// `2-as-written` 7 次；`task-8-report.md` 这类任务产物则是该摘的）。
test("stripSpokenNoise: 日期前缀的名字与量段不摘，型号还是摘", () => {
	for (const keep of ["2026-09-30-minecart", "2-as-written", "md5-identical", "fw2-backup", "19000-char", "1.5-2KB", "104-test"]) {
		assert.equal(stripSpokenNoise(keep), keep, `不该动：${keep}`);
	}
	for (const strip of ["qwen3.8-df-qd-codex", "claude-opus-4-6", "task-8-report.md"]) {
		assert.equal(stripSpokenNoise(strip).trim(), "", `该摘：${strip}`);
	}
});

// 误伤高危区：这些都不能被剥（真实语料里的正常内容，剥了就是漏念事实）。
test("stripSpokenNoise: 文件 / 模块名、比率、ref、斜杠命令、数量单位都不动", () => {
	for (const keep of [
		"apikey.json 的 proxy 段",
		"config.yaml 里加了 drop_params",
		"测试全过，32/32",
		"已推到 origin/main",
		"跑 /reload 就能生效",
		"用了 9 个文件",
		"当前默认 500 字",
		"输出 16384 token",
		"剩下 3 个失败",
		"温度 -5 度",
		"上限是 4，不是 5",
		"本轮 00:11–00:12 跑的测试",
	]) {
		assert.equal(stripSpokenNoise(keep), keep, `不该动：${keep}`);
	}
});

test("stripSpokenNoise: 纯字母的 hex 形词不当编号（abcdef 是正常词）", () => {
	assert.equal(stripSpokenNoise("abcdef 这个词"), "abcdef 这个词");
	assert.equal(stripSpokenNoise("deadbeef 不算编号"), "deadbeef 不算编号");
});

test("stripSpokenNoise: 一行里剥掉多处后不留空括号、多余空格", () => {
	assert.equal(stripSpokenNoise("Key（sk-abcdef123456）已写入"), "Key已写入");
	// 整段被剥空的反引号一起丢掉，不留 `  ` 空壳。
	assert.equal(stripSpokenNoise("先 `e752224`，然后 `fa90a4d`。"), "先，然后。");
});

// 两档强度（拿本机 429 个会话文件实测定的）：模型写编号的习惯是包进反引号，而**裸字**
// 同形的短串在散文里大多是量（`120000`、`300000` 是毫秒数）—— 剥掉就是把关键事实静默吃掉。
test("stripSpokenNoise: 反引号里放宽到 6 位，裸字要 8 位以上", () => {
	// 反引号里：6~7 位的 hex / 纯数字当编号（真实语料里的 `78908fd` / `ada354f` / uid `140024`）
	assert.equal(stripSpokenNoise("提交 `78908fd`"), "提交", "反引号里的 7 位 hex");
	assert.equal(stripSpokenNoise("提交 `140024`"), "提交", "反引号里的 6 位数字（uid 形态）");
	// 裸字：同形的短串要留（它们通常是量，不是编号）
	assert.equal(stripSpokenNoise("超时 300000ms 没有数据"), "超时 300000ms 没有数据", "带单位的量本来就是关键数字");
	assert.equal(stripSpokenNoise("默认 120000 毫秒"), "默认 120000 毫秒", "裸的 6 位数字不是编号");
	assert.equal(stripSpokenNoise("重启一下 e253042 就好了"), "重启一下 e253042 就好了", "裸的 7 位短 hash 也留（宁可少摘）");
	// 8 位以上的裸编号照样剥
	assert.ok(!/5161261/.test(stripSpokenNoise("从 `5161261` 前进")), "反引号里的 7 位编号要剥");
	assert.ok(!/73505695/.test(stripSpokenNoise("编号 73505695 是这次提交")), "裸的 8 位数字要剥");
});

test("toSpeakable: 真实「提交 + 推送」结论口播后不剩编号", () => {
	const speakable = toSpeakable("已提交。\n- commit `78908fd`\n- push `78908fd..d4edfd5` 到两个远端");
	assert.ok(!/[0-9a-f]{7}/.test(speakable), `不该剩编号：${speakable}`);
	assert.ok(speakable.includes("已提交") && speakable.includes("两个远端"), speakable);
});

test("decideSpeak: 整段都是编号的结论不该只剩噪音", () => {
	// 极端形态：原文只有编号 —— 剥完为空则判定为 empty（宁可不播，也不念一串编号）。
	const decision = decideSpeak({ text: "`e752224` `fa90a4d..e752224`", stopReason: "stop" });
	assert.equal(decision.speak, false);
});

test("cleanSummaryText: 模型不守约、摘下编号时机械层兼底", () => {
	const raw = "已经提交并推送了（commit `e752224`，+232/−57 到两个远端）。";
	const cleaned = cleanSummaryText(raw);
	assert.ok(!/e752224|232|57/.test(cleaned), `摘要里的编号也要剥：${cleaned}`);
	assert.ok(cleaned.includes("已经提交并推送了"), cleaned);
});

// =============================================================================
// 音色列表解析
// =============================================================================

test("parseVoiceLine: 单名字 + locale", () => {
	assert.deepEqual(parseVoiceLine("Tingting            zh_CN    # 你好！我叫婷婷。"), {
		name: "Tingting",
		locale: "zh_CN",
	});
});

test("parseVoiceLine: 名字里带空格与括号（新版 macOS 音色）", () => {
	assert.deepEqual(parseVoiceLine("Eddy (中文（中国大陆）)     zh_CN    # 你好！我叫Eddy。"), {
		name: "Eddy (中文（中国大陆）)",
		locale: "zh_CN",
	});
});

test("parseVoiceLine: 没有 locale 的行（表头 / 空行）返回 undefined", () => {
	assert.equal(parseVoiceLine(""), undefined);
	assert.equal(parseVoiceLine("Voice           Locale   Sample"), undefined);
});

test("parseVoiceList: 整段输出解析出全部音色", () => {
	const output = [
		"Tingting            zh_CN    # 你好！我叫婷婷。",
		"Alex                en_US    # Hello, my name is Alex.",
		"Eddy (中文（台湾）)   zh_TW    # 你好，我叫Eddy。",
	].join("\n");
	assert.deepEqual(parseVoiceList(output), [
		{ name: "Tingting", locale: "zh_CN" },
		{ name: "Alex", locale: "en_US" },
		{ name: "Eddy (中文（台湾）)", locale: "zh_TW" },
	]);
});
