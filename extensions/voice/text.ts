/**
 * voice/text — 播报文本的纯逻辑：把 assistant 的最终 markdown 回复精简成「能听懂的
 * 那几句话」，外加「这一轮值不值得念」的判定。不 import pi，`node --test` 直接测。
 *
 * 为什么必须精简：coding agent 的结论里代码块、文件路径、markdown 表格、URL 占了大头，
 * 逐字念出来又长又没法听。这里的规则全部是**局部**的（逐行 / 逐 fenced 段判定），
 * 不做任何"根据上下文猜测"的处理 —— 猜错的代价是漏念一句真正要说的话。
 *
 * 精简顺序与小节对应：
 *   1. 剥 fenced 代码块（``` / ~~~），块内整体丢弃
 *   2. 逐行处理：markdown 表格行丢弃、标题/引用/列表标记剥离、URL 丢弃、路径丢弃、
 *      markdown 强调标记剥离、**编号 / 凭据机械过滤**（`stripSpokenNoise`）
 *   3. 折叠空白 → 按「句末标点 + 换行」分段 → 按字数上限在句边界截断
 *
 * **长结论另有一档**：本条管线之上还有一次可选的口播摘要（`buildSummaryPrompt` /
 * `cleanSummaryText`，由 controller 编排、index 发请求）。两者是**串联**的 ——
 * 摘要在前，本函数在后，所以提示词里要求干净的输出仍会被这里再滤一遍，
 * 模型不听话时不会把路径 / 代码漏进耳朵。
 *
 * 管线里四处顺序是**负载性的**（换一处就静默坏掉其它，都有回归用例钉着）：
 *   - 行内代码必须在 URL 之前（否则 `` `https://x.y` `` 的闭合反引号被 URL 正则吃掉，
 *     剩下的孤立反引号会跟后文配对，把中间正文误当行内代码）
 *   - 图片必须在链接之前（否则 `![](url)` 被链接规则吃成一个 `!`）
 *   - 方位词的双字形式必须排在单字之前（否则「里面」被「里」吃掉一半、剩下一个「面」）
 *   - **编号 / 凭据过滤必须在反引号剥离之前**（反引号是「这是代码不是事实」的信号：
 *     反引号里的 `78908fd` 是 commit，裸的 `120000` 是毫秒数 —— 先剥反引号两档就塌成一档，
 *     短编号会漏、短量会被误伤，两种都实测复现过）
 *
 * 规则全部从**真实会话语料**反推（精简规则基于本仓 12 个会话、301 条播报样本；编号过滤
 * 基于全会话目录 1134 条结论里出现的 864 个被摘 token 逐个看过），不是拍脑袋 ——
 * 具体的判据、误伤高危区与刻意不收的残骸，见下面各常量的注释。
 */

/** 播报的默认上限（字符）。中文按字算，500 字约 1.5 分钟，是「听得完」的量级。 */
export const DEFAULT_MAX_CHARS = 500;

/** 低于这个长度不值得念（"好的" / "Done" / 空回复）。 */
export const MIN_SPEAKABLE_CHARS = 6;

/** 内容全是这些字符时视为空（剥完标记后剩下的装饰）。 */
const DECORATION_ONLY = /^[\s\-—–_*#>|·•.。，,、!！?？:：;；'"“”‘’()（）[\]{}<>/\\`~+=]*$/;

/**
 * 剥掉 fenced 代码块的内容。
 *
 * 支持 ``` 与 ~~~ 两种围栏（CommonMark 都算 fenced code），info string 可有可无；
 * 未闭合的围栏按「一直到文末都是代码」处理 —— 这是 streaming 中断的常见残留，
 * 宁可多丢也不要把代码念出来。
 */
export function stripFencedCodeBlocks(text: string): string {
	const lines = text.split("\n");
	const kept: string[] = [];
	let fence: string | undefined;

	for (const line of lines) {
		if (fence === undefined) {
			const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
			if (open) {
				fence = open[1][0].repeat(3);
				continue;
			}
			kept.push(line);
			continue;
		}
		// 闭合围栏：同一种字符、长度不少于开启者、且后面没有别的非空白内容。
		const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
		if (close && close[1][0] === fence[0] && close[1].length >= 3) {
			fence = undefined;
		}
	}
	return kept.join("\n");
}

/** markdown 表格行：以 | 开头且至少两个 | ，或表格分隔行（|---|:--:|）。 */
function isTableRow(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|")) return false;
	return (trimmed.match(/\|/g) ?? []).length >= 2;
}

/**
 * 路径形状的 token（含斜杠的一段），以及它周围**一起构成定位短语**的部件：
 * 前置介词、行号、后置「的」与方位词。
 *
 * 为什么必须整段收：只抽中间会把句子拆散 —— 「文件在 /tmp/a/b.ts 里。」只剩「文件在里。」
 * （实测确认）。行号同理：`index.js`:644-668 只抽路径会剩下一个悬空的「:644-668」。
 *
 * 关于「 的」与方位词：它们只能作为**路径的一部分**被收，不能写成全局的 `\s+的\s*` 规则 ——
 * 中英混排里「apikey.json 的 proxy」这类空格是正常的（真实语料里就有），全局规则会把正常
 * 句子改成「apikey.jsonproxy」。
 *
 * 方位词的书写顺序也有讲究：**双字形式必须排在单字之前**（正则择一按书写顺序取第一个匹配），
 * 写成 `里|中|…|里面` 时「里面」会被单字「里」先吃掉一半，留下一个「面」。
 *
 * 行号只在紧跟在路径后面时才收（`index.js`:644-668）—— 裸的「上限：4」「00:11」是正常内容，
 * 绝不能当行号去掉（真实语料里「：N」共 15×9 次，全部是后者）。
 *
 * 用**命名分组**而不是按下标切片取尾巴：普通分组会让 `match` 里混入分隔用的捕获组，
 * 按位置切很易错（已踩过）。
 */
const PATH_RUN =
	/(?<prep>[在到从往向于]\s*)?(?<path>[~.]?[A-Za-z0-9_.@+-]*(?:\/[A-Za-z0-9_.@+-]+)+\/?)(?::(?<line>\d+(?:[-–—~]\d+)?))?(?<de>\s+的)?(?<loc>\s*(?:下面|上面|里面|当中|底下|中间|里|中|下|上|内|外))?/g;

/**
 * 这个「含斜杠的 token」是不是文件路径？
 *
 * 规则是用**真实会话语料**（本仓 12 个会话里 238 个含斜杠 token）反推的，不是拍脑袋：
 * 要剥掉的是 `clients/pi/README.md`、`~/.pi/agent/extensions/`、`/Users/bachi/Library/…`，
 * 要留下的是比率 `32/32`、`107/113`、单词对 `A/B`、`UI/behavior`、`before/after`、
 * git ref `origin/main` 与斜杠命令 `/reload`、`/voice`。判别点三个：
 *   - 必须含字母（纯数字/斜杠 = 比率）：`32/32` 留下
 *   - 两级以上（`a/b/c`）或带扩展名（`a/b.js`）或结尾是 `/`（目录）才算路径
 *   - 单级且无扩展名的不算：`/reload`、`origin/main`、`A/B` 留下
 */
export function isPathToken(token: string): boolean {
	if (!token.includes("/")) return false;
	if (!/[A-Za-z_]/.test(token)) return false;
	if (token.endsWith("/")) return true;
	if ((token.match(/\//g) ?? []).length >= 2) return true;
	return /\.[A-Za-z0-9]+$/.test(token);
}

/**
 * 收紧中日韩文本里的空格。
 *
 * 摘掉 URL / 标记 / 路径后会留下缝隙（`toSpeakable`），模型生成的口播稿拼行时也会留下
 * 缝隙（`cleanSummaryText`）—— 两边共用这一份规则。
 *
 * **不能**碰「中文 空格 拉丁」：那个空格是分隔词所必需，真实语料里就有
 * 「apikey.json 的 proxy」（见 `stripInlineMarkup` 里的同款注释）。
 */
export function tightenCjkSpacing(text: string): string {
	return text
		.replace(/([，。；：！？、【】《》「」『』（）])\s+/gu, "$1")
		.replace(/([\u4e00-\u9fff\u3040-\u30ff\u3000-\u303f\uff01-\uff65])\s+(?=[\u4e00-\u9fff\u3040-\u30ff\u3000-\u303f\uff01-\uff65])/gu, "$1");
}

// =============================================================================
// 口播时不该念的「编号 / 凭据」——机械过滤（提示词的兜底，用户 2026-10-04 定）
// =============================================================================

/**
 * 分工：提示词（`buildSummaryPrompt`）让模型**不要写**这类细节，本函数保证**写了也念不出来**。
 * 两条都要有：模型对长尾不守约（用户实测「有时候还是会」），而摘要在失败 / 超时时走的是
 * 本地兜底文本（原文精简）——那条路根本不过模型，只有机械过滤覆盖得到。
 *
 * 剥的**只有确定性形态**（猜语义的代价是漏念一句真话，所以不猜）：
 *   - 凭据：`Bearer …`、`sk-…` / `AKIA…` / `ghp_…`、`密码：…` / `apiKey=…` 这类赋值
 *   - 编号：**8 位以上**的十六进制（commit / hash，7 位短态不收 —— 与「纯数字 8 位以上」
 *     同一条线，少摘一点）与 `a1b2c3d..e4f5a6b` 推送范围
 *   - 纯数字串（8 位以上）：`5161261` 这类不带分隔符的编号（`300000ms` 不受影响 ——
 *     它是长度单位，正是「关键数字」该留的形态）
 *   - 统计：`+232` / `−57` 这种 diff 增删量（含 U+2212 减号与全角加号）
 *   - 连字符型号（`qwen3-tts-flash`、`gpt-4`）：**首段必须含数字**，且**不能全是数字段**
 *     —— 「典型型号」与「日期」的分界线就是这条（`qwen3-tts-flash` 是，`2026-09-24`
 *     与 `9-23` 不是，它们是日期 / 范围，念出来有意义）
 *
 * **刻意不剥**（都有回归用例或真实语料钉着）：文件 / 模块名（`apikey.json`、`config.yaml` ——
 * 它们常是句子的主语）、裸版本号（`4.1`，可能就是这轮的关键事实）、比率（`32/32`）、
 * 数量与单位（`9 个文件`、`4 秒`、`300000ms` —— 「哪个数字重要」由提示词按语义取舍，
 * 机械层不替模型判断）、git ref / 斜杠命令（`origin/main`、`/reload`）、
 * 带数字的普通词与标识（`python3`、`sha256`、`base64`、`o1`、`GPT-5`）、
 * 日期（`2026-09-24`）、普通英文字词（`config`、`e-mail`）。
 *
 * 反引号**不**当作信号：模型既爱把编号写进反引号，也爱把正常词写进去，所以只看形态，
 * 不看它是不是被包起来（何况 `toSpeakable` 走到这里时反引号早已被 `stripInlineMarkup` 剥掉了）。
 */

/** `Bearer <token>`：认证头的明文形态。 */
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._\-]{2,}/g;

/**
 * 「密码 / apiKey / token：值」这类赋值 —— 标签连同值一起去掉。两道分开：
 *
 *   - **强标签**（密码 / 口令 / passphrase / password / apiKey / secret / access_token）
 *     不管值长什么样都收 —— 这些词在结论里只可能是凭据。
 *   - **弱标签 `token`** 只在值**不像普数字**时才收：「输入 token 5000」「max_tokens: 1024」
 *     是这轮的关键数字，不能当凭据吃掉（两者形态完全一样，只能区分值的形状）。
 *
 * 边界用 lookbehind 卡住：`max_tokens:` 里的 `tokens` 不是标签（前面是 `_`）。
 */
const CREDENTIAL_VALUE = "(?:[A-Za-z0-9_./+@\\-=]{4,}|\\*{2,}|…|<[^>\\s]{2,}>)";
const CREDENTIAL_ASSIGNMENT = new RegExp(
	`(?<![_\\w])(?:密码|口令|passphrase|password|passwd|api[_ -]?key|apikey|secret|access[_ -]?token)\\s*[:：=]\\s*${CREDENTIAL_VALUE}`,
	"gi",
);
const TOKEN_ASSIGNMENT = new RegExp(
	`(?<![_\\w])token\\s*[:：=]\\s*(?!\\d{1,10}(?![0-9]))${CREDENTIAL_VALUE}`,
	"gi",
);

/** 密钥前缀（sk-…、AKID…、ghp_…）：只在 token 是整体形态时才判噪音。 */
const CREDENTIAL_PREFIX = /^(?:sk-|AKIA|ASIA|ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_-]*$/;

/** 十六进制编号（commit / hash）：至少含一个数字（纯字母的 `abcdef` 是正常词），
 * **8 位起收**（7 位短态留给纯数字规则之外，与下面那条同一条线：宁可少摘）。 */
const HEX_CODE = /^(?=[0-9a-f]*\d)[0-9a-f]{8,40}$/;

/** 推送范围 `a1b2c3d..e4f5a6b`（tokenizer 把 `..` 留在同一个 token 里）。 */
const HEX_RANGE = /^(?=[0-9a-f]*\d)[0-9a-f]{4,40}\.\.[0-9a-f]{4,40}$/;

/**
 * 纯数字串（8 位以上）：`5161261` 这类不带分隔符的编号。
 *
 * **7 位以下不收**：那是量级正常的数字（`300000`、`999999`、端口、行号），机械层分不出
 * 「编号」还是「关键数字」；`300000ms` 这种带单位的更是该留的形态（它是个「多少毫秒」的事实），
 * 所以下面这条只兑纯数字，不碰带字母的 token。
 */
const LONG_DIGITS = /^\d{8,}$/;

/** 连字符型号（`qwen3-tts-flash`、`gpt-4`）：**首段必须含数字**，且不能全是数字段
 * （日期 `2026-09-24` / 范围 `9-23` 因此被保住）。 */
const HYPHEN_IDENTIFIER = /^[A-Za-z0-9_.]*-[A-Za-z0-9_.-]*$/;

/** diff 增删量：`+232` / `-57` / `−57` / `＋9`。 */
const DIFF_STAT = /^[+＋\-−]\d+$/;
const DIFF_STAT_ALL = /[+＋\-−]\d+/g;
/** diff 摘要的固定搭配：有它才认为行内的带符号数字是「增删量」而不是普通负数。 */
const DIFF_STAT_CONTEXT = /个文件|files?\s+changed/;

/**
 * 连字符型号的判定（`qwen3.8-max`、`qwen3-tts-flash`、`claude-opus-4-6`）。
 *
 * 分界线是拿本机 429 个会话文件里出现过的 864 个被摘 token 逐个看过定的。型号的**形态**是
 * 「名字段 + 版本 / 修饰段」：
 *   - 至少有一个带数字的段（全字母的 `e-mail`、`roll-up` 不是）
 *   - 不能每段都是数字（那是日期或区段：`2026-09-24`、`9-23`）
 *   - **段数 ≥ 3**（`qwen3.8-df-qd-codex`、`claude-opus-4-6`），或两段但每段 ≥ 3 个字母
 *     （`qwen3-max`、`deepseek-v4`）—— 两段且段里字母稀少的（`2-as-written`、`md5-identical`、
 *     `fw2-backup`）与带日期的（`2026-09-30-minecart`）自然落在外边：它们的尾巴是普通词，
 *     不是型号后缀
 *   - `treat1` / `drain1` 这种 `-` 拼接的固定枚举排除
 *
 * **刻意不摘的**（都拿真实语料确认过，摘了就是漏念事实）：短型号 `GPT-4` / `o1`（两段、
 * 名字段太短，机械层分不出「型号」还是「行号区段」）、行号区段 `L72-73`、量段 `19000-char` /
 * `1.5-2KB` / `1000ms`、日期前缀的文件名。
 */
function isHyphenIdentifier(token: string): boolean {
	if (!HYPHEN_IDENTIFIER.test(token)) return false;
	const parts = token.split("-");
	if (parts.some((part) => part === "")) return false;
	if (!parts.some((part) => /\d/.test(part))) return false;
	if (parts.every((part) => /^\d+$/.test(part))) return false;
	if (parts.every((part) => /^(?:treat|drain|test|item|step|phase|task|part)\d*$/i.test(part))) return false;
	// 首段是纯数字的都不是型号：年份开头的名字（`2026-09-30-minecart`、`2026-10-02.md`）是
	// 「日期 + 名字」，`2-as-written` 是枚举短语 —— 日期本身是有效信息（「九月三十号那轮」），
	// 剥了就是漏念事实。型号的首段总是名字 + 版本（`qwen3.8`、`glm-5.3`、`claude`）。
	if (/^\d+$/.test(parts[0] ?? "")) return false;
	if (parts.length === 2) {
		// 两段：两段都得像「名字」（至少 3 个字母），否则是量或范围（`19000-char` / `md5-a`）。
		return parts.every((part) => (part.match(/[A-Za-z]/g) ?? []).length >= 3);
	}
	return true;
}

/** token 的字符集（比 `\w` 宽：标识符里常见的 `-` `.` `@` `+`）。 */
const NOISE_TOKEN_RUN = /[A-Za-z0-9_.@+\-−＋]+/g;

/**
 * 「代码形态」的放宽档：**只在反引号里**生效。
 *
 * 为什么需要这一档（拿本机 429 个会话文件实测）：模型写编号的固定习惯是**包进反引号**
 * （`78908fd`、`ada354f`、`e752224`、uid `140024`），而**裸字同形的短串**大多是量：
 * `120000`、`300000`、`164902` 这种六位数字在散文里就是「多少毫秒 / 多少字」——
 * 剥 6~7 位裸串会让「超时超到 30 万毫秒」这类关键事实被静默吃掉。所以用反引号把两档分开：
 * 裸字要 8 位以上（`5161261`），反引号里 6 位就够 —— 靠**排版**分开，而不是猜语义。
 */
const HEX_SHORT = /^(?=[0-9a-f]*\d)[0-9a-f]{6,40}$/;
const DIGITS_SHORT = /^\d{6,}$/;

/** 单反引号包着的整段（不跨行；多反引号的代码串在结论里近乎不存在）。 */
const BACKTICK_SPAN = /`[^`\n]*`/g;

function isNoiseToken(token: string, stripDiffStats: boolean, qualified: boolean): boolean {
	return (
		CREDENTIAL_PREFIX.test(token) ||
		HEX_CODE.test(token) ||
		HEX_RANGE.test(token) ||
		LONG_DIGITS.test(token) ||
		// 反引号里放宽到 6 位（`78908fd` / `ada354f` / `140024`），裸字仍要 8 位以上。
		(qualified && (HEX_SHORT.test(token) || DIGITS_SHORT.test(token))) ||
		(stripDiffStats && DIFF_STAT.test(token)) ||
		isHyphenIdentifier(token)
	);
}

/** 按当前档位把一段文字里的噪音 token 换成空格。 */
function stripNoiseTokens(segment: string, stripDiffStats: boolean, qualified: boolean): string {
	return segment.replace(NOISE_TOKEN_RUN, (token) =>
		isNoiseToken(token, stripDiffStats, qualified) ? " " : token,
	);
}

/**
 * 去掉口播不该念的编号 / 凭据（形态判定见上面的常量注释）。
 *
 * 两档强度：**裸字**只收确定性极强的（凭据、8 位以上编号、推送范围、diff 统计、连字符型号）；
 * **反引号里**放宽一档（6 位起）—— 模型把编号包进反引号的习惯恰好就是「这是代码、不是要听的事实」
 * 的标记，而裸字同形的短串在散文里大多是量。
 *
 * 带符号数字（`-57`）只在**确定是增删量**时才收：同一行里出现一对（`+232/−57`），
 * 或该行带有 diff 摘要的固定搭配（`9 个文件 +1908 行）。否则 `-5` 这种普通负数
 * （「温度 -5 度」）会被误伤 —— 形态相同，只能看上下文。
 *
 * 纯函数：输入相同输出相同；空行原样返回。
 */
export function stripSpokenNoise(line: string): string {
	if (!line) return "";
	const signedStats = line.match(DIFF_STAT_ALL)?.length ?? 0;
	const stripDiffStats = signedStats >= 2 || DIFF_STAT_CONTEXT.test(line);
	const withoutSecrets = line
		.replace(BEARER_SECRET, " ")
		.replace(CREDENTIAL_ASSIGNMENT, " ")
		.replace(TOKEN_ASSIGNMENT, " ");

	// 逐段处理：反引号内用放宽档，反引号外用严格档；整段被剥空时连反引号一起去掉，
	// 免得留下 `  ` 这种空壳（后续 `stripInlineMarkup` 会把剩下的反引号剥掉）。
	const parts: string[] = [];
	let cursor = 0;
	for (const match of withoutSecrets.matchAll(BACKTICK_SPAN)) {
		const start = match.index ?? 0;
		parts.push(stripNoiseTokens(withoutSecrets.slice(cursor, start), stripDiffStats, false));
		const inner = stripNoiseTokens(match[0].slice(1, -1), stripDiffStats, true);
		parts.push(inner.trim().length > 0 ? `\`${inner}\`` : "");
		cursor = start + match[0].length;
	}
	parts.push(stripNoiseTokens(withoutSecrets.slice(cursor), stripDiffStats, false));

	return tightenCjkSpacing(
		parts
			.join("")
			// 值被摘掉后可能留下空括号（`Key（sk-xxx）已写入` → `Key（）已写入`）与悬空空白。
			.replace(/[（(【「『]\s*[）)】」』]/gu, "")
			.replace(/[ \t]{2,}/g, " ")
			.trim(),
	);
}

/**
 * 去掉文件路径。念路径是纯噪音（"clients slash pi slash README 点 md"），
 * 而人耳从一句话里丢掉路径后语义仍然完整。管线里直接内联调用。
 */

/** markdown 强调 / 行内代码 / 链接 / 图片 / 删除线的标记剥离（保留文字）。 */
function stripInlineMarkup(line: string): string {
	return tightenCjkSpacing(
		line
			// 行内代码 `x` / ``x`` → 留 x。**必须排在 URL 规则之前**：反引号里的 URL
			// （`https://x.y`）如果先走 URL 剥离，URL 正则会把闭合反引号一起吃掉，
			// 剩下的孤立反引号再跟后文的反引号配对，把中间正文误当行内代码
			// （2026-10-03 真实数据回归：`https://github.com` … `apikey.json`）。
			.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1/g, "$2")
			// 落单的反引号（奇数个 / 跨行配对失败）直接去掉 —— 留着会被当成标记念出来
			.replace(/`/g, "")
			// 图片 ![alt](url) → 丢掉整个（alt 通常是文件名，念出来没意义）。
			// 必须排在链接规则**之前**：否则 `![](url)` 会先被链接规则吃成 `!`。
			.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
			// 链接 [text](url) → 只留 text（url 念出来是纯噪音）
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			// 自动链接 <https://x> → 丢（连后面紧跟的「 的」一起，避免「见 的说明」）
			.replace(/<https?:\/\/[^>]*>(\s+的)?/g, "")
			// 裸 URL → 丢。**不能**用 \S+：中文标点也是非空白，`https://x，跑` 会被整段吞掉；
			// 但 ASCII 括号 / 方括号要算进终止符，否则会把 markdown 链接的 `)` 一起吃掉
			.replace(/https?:\/\/[^\s，。；：！？、（）「」『』【】"'<>)\]}]+(\s+的)?/gu, "")
			// 文件路径 → 丢（判定规则见 isPathToken，靠真实语料反推）。
			// 定位短语（「在 X 里」/「X 下面」）整段收掉：实测语料里这两种形态都是 0~1 次，
			// 而只抽路径会拼出「文件在里。」这种断句（已复现），整段收则最多丢掉一个
			// 「下面」这种泛指（不会产生病句，读起来仍完整）。两害相权取轻的。
			.replace(PATH_RUN, (match, ...groups) => {
				// 命名分组在 args 末位（replace 回调：整串、各捕获组、offset、string、groups）
				const named = groups.at(-1) as { path?: string } | undefined;
				if (!named?.path) return match;
				return isPathToken(named.path) ? " " : match;
			})
			// 强调标记：**x** __x__ *x* _x_ ~~x~~
			.replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, "$1$2")
			.replace(/__([^_]+)__/g, "$1")
			.replace(/~~([^~]+)~~/g, "$1")
			// 残留的单字符标记（配对失败时别让它留在正文里）
			.replace(/\*/g, "")
			.replace(/~~/g, "")
			// 引用 / 列表 / 标题前缀
			.replace(/^\s{0,3}#{1,6}\s+/, "")
			.replace(/^\s{0,3}>\s?/, "")
			.replace(/^\s{0,3}[-+*]\s+/, "")
			.replace(/^\s{0,3}\d+[.)]\s+/, "")
			// 去掉 URL / 链接 / 路径后可能留下「空格 + 标点」，归一成紧贴的标点
			.replace(/\s+([，。；：！？、,.!?;:])/gu, "$1")
			// 路径被摘掉后的两种残骸（都来自真实语料，只收这两种，不扩大范围）：
			//   ① 空括号：「（clients/pi/extensions/）」→「（ ）」→ 整体去掉
			//   ② 开括号后接逗号：「（docs/x.md，上次…）」→「（，上次…）」→ 去掉那个逗号
			.replace(/[（(【「『]\s*[）)】」』]/gu, "")
			.replace(/([（(【「『])\s*[，、,]/gu, "$1")
	);
}

/** emoji / 变体选择符 / 零宽字符：念不出来，去掉。 */
export function stripEmoji(line: string): string {
	return line
		.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200B}-\u{200D}\u{FEFF}]/gu, "")
		.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "");
}

/**
 * 把 markdown 回复精简成播报文本。纯函数，输入相同输出相同。
 *
 * @param text assistant 的最终回复原文
 * @param maxChars 字数上限；超出时在句边界截断（截不到句边界就硬截）
 */
export function toSpeakable(text: string, maxChars: number = DEFAULT_MAX_CHARS): string {
	if (!text) return "";

	const lines = stripFencedCodeBlocks(text)
		.split("\n")
		.filter((line) => !isTableRow(line))
		// **顺序是负载性的**：噪音过滤必须在 `stripInlineMarkup` **之前**跑 —— 反引号是它的
		// 「代码形态」信号（`78908fd` 是编号，裸的 `120000` 是量），反引号一旦被剥掉，两档就
		// 塌成一档，短编号会漏、短量会被误伤（实测：先剥反引号时 `78908fd` 原样漏到耳朵里）。
		.map((line) => stripEmoji(stripInlineMarkup(stripSpokenNoise(line))).replace(/[ \t]+/g, " ").trim())
		.filter((line) => line.length > 0);

	// 拼行留下的缝隙（模型用换行分段，但口播是一段话）收成逗号分隔的一句。
	return truncateAtSentence(lines.join("\n"), maxChars);
}

/**
 * 在 `maxChars` 内取最长的一段，优先断在句末标点后。
 *
 * 断了就补一个「。」而不是「…」：`say` 对「…」的口播行为各音色不一，而句号听起来
 * 就是一句完整的话结束了 —— 截断这件事本身不需要在语音里表达。
 */
export function truncateAtSentence(text: string, maxChars: number): string {
	const collapsed = text.replace(/\s*\n\s*/g, "\n").trim();
	if (collapsed.length <= maxChars) return collapsed;

	const head = collapsed.slice(0, maxChars);
	// 句末标点（中英文）后断开；找不到就退到最近的换行/逗号边界。
	const lastStop = Math.max(
		head.lastIndexOf("。"),
		head.lastIndexOf("！"),
		head.lastIndexOf("？"),
		head.lastIndexOf("."),
		head.lastIndexOf("!"),
		head.lastIndexOf("?"),
		head.lastIndexOf(";"),
		head.lastIndexOf("；"),
	);
	if (lastStop >= MIN_SPEAKABLE_CHARS) return head.slice(0, lastStop + 1);

	const softStop = Math.max(head.lastIndexOf("\n"), head.lastIndexOf("，"), head.lastIndexOf(","), head.lastIndexOf("、"));
	if (softStop >= MIN_SPEAKABLE_CHARS) return `${head.slice(0, softStop)}。`;

	return `${head}。`;
}

/**
 * 硬上限截断：`truncateAtSentence` 在找不到句读时会补一个「。」，可能比上限多出 1 个字 ——
 * 口播摘要有一条硬要求（用户 2026-10-04：**绝不能比原文长**），所以这里再兜一刀，
 * 保证返回值 **一定** ≤ `maxChars`（代价是极端情况下句尾没有标点，而不标点是“最多 1 字溢出”
 * 更可接受的失败形态）。
 */
export function truncateWithin(text: string, maxChars: number): string {
	const truncated = truncateAtSentence(text, maxChars);
	return truncated.length <= maxChars ? truncated : truncated.slice(0, maxChars);
}

/** 剥掉「只剩装饰」的结果。 */
function isDecorationOnly(text: string): boolean {
	return DECORATION_ONLY.test(text);
}

export interface SpeakDecisionInput {
	/** 最终 assistant 文本（未精简）。 */
	text: string;
	/** 该消息的 stopReason（pi 的 AssistantMessage.stopReason）。 */
	stopReason?: string;
	/** 是否允许播报以问句结尾的回复（配置项，默认 true）。 */
	speakQuestions?: boolean;
	/** 字数上限（精简后低于 MIN_SPEAKABLE_CHARS 就不播）。 */
	maxChars?: number;
}

export type SpeakDecision = { speak: true; text: string } | { speak: false; reason: SpeakSkipReason };

export type SpeakSkipReason =
	| "empty"
	| "too-short"
	| "aborted"
	| "error"
	| "question"
	| "decoration"
	// `controller.ts` 自己的两个：摘要请求在发出声音之前被取消（用户在等摘要时发了下一句 /
	// 换了会话），以及末级空文本（兜底也空了，理论上不该发生）。前者的语义是「这一轮的结论
	// 已经过期了」，所以既不念也不重试 —— 指纹已经记下，重复的 settled 同样不会再念。
	| "interrupted";

/**
 * 判定这一轮要不要念、念什么。所有过滤都在这里，`index.ts` 只负责接线。
 *
 * 顺序有意为之：中止/报错的轮次先出局（那是失败的输出，念出来只会误导），
 * 再判空与过短，最后才是问句与装饰性内容。
 *
 * **问句默认播**（2026-10-04 改，用户实测后定的）：此前默认不播问句，但模型回一句
 * 反问是最常见的收尾形态，导致「对话结束了一声不响」看起来完全像坏了 —— 用户实测
 * 报告「自动播报不生效」时，真实原因就是那句 `…What would you like to work on?` 被这条
 * 规则静默跳过。要回到旧行为把 `voice.json` 的 `speakQuestions` 设为 `false`。
 */
export function decideSpeak(input: SpeakDecisionInput): SpeakDecision {
	const { text, stopReason, speakQuestions = true, maxChars = DEFAULT_MAX_CHARS } = input;

	if (stopReason === "aborted") return { speak: false, reason: "aborted" };
	if (stopReason === "error") return { speak: false, reason: "error" };
	if (!text || text.trim().length === 0) return { speak: false, reason: "empty" };
	if (isDecorationOnly(text.trim())) return { speak: false, reason: "decoration" };

	const speakable = toSpeakable(text, maxChars);
	// 精简后一个字都不剩（整段都是代码 / 表格 / 图片）与「本来就很短」是两回事，分开报。
	if (speakable.length === 0) return { speak: false, reason: "empty" };
	if (speakable.length < MIN_SPEAKABLE_CHARS) return { speak: false, reason: "too-short" };
	if (isDecorationOnly(speakable)) return { speak: false, reason: "decoration" };
	if (!speakQuestions && /[?？]\s*$/.test(speakable)) return { speak: false, reason: "question" };

	return { speak: true, text: speakable };
}

// =============================================================================
// 口播摘要：长结论 → 一两句能听的话（提示词 + 清洗，纯逻辑）
// =============================================================================

/**
 * 口播摘要的默认字数上限（`voice.json` 的 `summaryMaxChars` 可改）。
 *
 * 用户 2026-10-04 从 150 收紧到 **100**，并加了一条硬要求：**摘要绝不能比原文长**
 * （只能更短）。所以实际生效的上限是 `min(summaryMaxChars, 原文长度)` —— 求上限的那
 * 一步在 `index.ts` 的 `createSummarizer`（告诉模型多少字）与 `controller.ts` 的
 * `resolveSpeech`（对结果再夹一刀，兜住不守约的模型）两处，用的是同一个算式。
 *
 * 为什么不是更短（如 50）：一句结论 + 一句建议，100 字是刚能说清又不显啰嗦的量。
 */
export const DEFAULT_SUMMARY_MAX_CHARS = 100;

/**
 * 口播摘要固定用哪个模型（用户 2026-10-03 定）。
 *
 * 不再用会话模型：摘要只在结论说完后开口，快慢直接决定「沉默多久」；会话模型可能是
 * qwen3.8-max 这类重模型（实测同一段 130 字结论 14.2~16.4s，而 deepseek-flash-qd
 * 1.3~5.4s）。`index.ts` 先按这个名字去模型目录里找，找不到才退回会话模型。
 */
export const DEFAULT_SUMMARY_MODEL = "deepseek-flash-qd";

/** 送给摘要模型的原文上限（字符）。只取开头 —— 结论通常在开头，整篇塞进去既慢又贵。 */
export const SUMMARY_INPUT_CLIP_CHARS = 6000;

/**
 * 摘要模型的系统提示词（与 recap / verify-loop 同款：systemPrompt + 单条 user 消息）。
 *
 * 人设：**机器人秘书助手** —— 中文口语、简洁专业、如实汇报，**不称呼用户**。
 * 用户 2026-10-03 一度要求用「伙计」称呼他，2026-10-04 听过后觉得怪，改成正常汇报；
 * 「不用称呼」这条同时写在 `buildSummaryPrompt` 里，两处互为强化，避免模型自作主张
 * 加称呼（提示词里刻意不举反例：点名那个词反而容易被模型照着念）。
 */
export const SUMMARY_SYSTEM_PROMPT =
	"你是一名机器人秘书助手，用中文口语向用户汇报编码助手这一轮做完的事；表达简洁、精练、适合朗读。";

/**
 * 构建口播摘要提示词。
 *
 * 送进去的是**未精简**的 markdown 原文（带代码块 / 表格 / 路径都无所谓）—— 模型需要
 * 完整上下文才能判断「这轮到底做了什么」，本地精简是**播报前**才做的另一件事。
 * 送上来的是原文而不是本地精简结果，还因为 `decideSpeak` 里的精简已经按 `maxChars`
 * 截断过，拿它当输入等于让摘要只看到结论的前半截。
 *
 * 「不要显示」这条要求是用户 2026-10-03 的硬要求：这段文字只进 `say` 的 argv，
 * 写进提示词是为了防止模型把 markdown / 括号注解当成「读者能看见的排版」。
 *
 * 「挑关键的说」是用户 2026-10-04 的要求：口播稿只有两三句的容量，先讲直接回应问题
 * 的结论 / 重要结果 / 关键数字，次要内容、辅助说明、修饰性的话允许少说甚至完全不说。
 *
 * 「说事不念编号」也是用户 2026-10-04 的要求（实测反馈：提交 / 推送的播报里还是会把
 * commit 编号念出来）：口播是秘书旁白，只说清做了什么、结果如何，除非那编号本身就是
 * 他问的事。凭据那条**没有例外口子** —— 编号在「问的就是它」时可以念，密码 / key
 * 不能。而机械层（`stripSpokenNoise`）对两类都会剥，所以提示词这条是防「不该说」，
 * 机械层是防「万一说了」。
 */
export function buildSummaryPrompt(text: string, maxChars: number = DEFAULT_SUMMARY_MAX_CHARS): string {
	const clipped = text.length > SUMMARY_INPUT_CLIP_CHARS ? `${text.slice(0, SUMMARY_INPUT_CLIP_CHARS)}…` : text;
	return [
		"下面是编码助手这一轮任务的最终输出。把它改写成一段口播稿 —— 这段话只会被朗读出来，不会显示在屏幕上。",
		"",
		"要求：",
		"- 用中文口语，像一个机器人秘书助手那样简洁、专业地汇报；不要用任何称呼（姓名 / 头衔 / 昵称），直接说事",
		"- 用两三句话说清：这轮做了什么、结果如何、还剩什么问题",
		`- **绝不能比原文长，只能更短**：总长不超过 ${maxChars} 个字，越短越好`,
		"- **挑关键的说**：直接回应我问题的结论、最重要的结果和数字优先说；次要内容、辅助说明、修饰性的话可以少说、甚至完全不说",
		"- **说事不念编号**：提交 / 推送这类操作只说「改了什么、推到哪个仓库、成没成功」，commit 编号、hash、推送范围、增删行数、文件名清单、行号、文件数这类技术细节不要念；数字留着最要紧的",
		"- **密码、API Key、token 之类的凭据，任何情况下都不要念，一个字都不要提**",
		"- 必须准确：原文没说的结论、数字、失败都要如实说，不要美化，也不要编造",
		"- 在不影响准确性的前提下，可以有一点点感性的、亲切的表达（偶尔一句就够，不要寒暄套话、不要称呼用户）",
		"- 如果有明确值得做的下一步，可以用一句话给出建议",
		"- 不要 markdown、代码、文件路径、URL、emoji、括号里的注解",
		"- 不要推理过程 / 思考步骤 / 解释，也不要任何前缀（如「摘要：」）或引号包裹，直接输出口播稿正文",
		"",
		"唯一例外：如果我这一轮问的就是上面提到的这些编号，那就照实回答，不受限制（密码 / Key 之类还是不要说）。",
		"",
		"最终输出：",
		"<final_output>",
		clipped,
		"</final_output>",
	].join("\n");
}

/**
 * 清洗摘要模型的输出。
 *
 * 与 `toSpeakable` 分开是刻意的：那边处理的是「人写的 markdown 结论」，这边处理的是
 * 「模型按提示词生成的口播稿」—— 只需兜住模型偶尔的越界（引号包裹、`**加粗**`、
 * 「摘要：」前缀、整段 fence、列表化、超长），不去重复整套路径 / 表格规则。
 */
export function cleanSummaryText(raw: string, maxChars: number = DEFAULT_SUMMARY_MAX_CHARS): string {
	if (!raw) return "";
	let text = stripEmoji(raw).trim();
	if (!text) return "";

	// 整段被 fence 包住（模型偶尔会把口播稿当代码块输出）。
	text = text.replace(/^\s*(?:```|~~~)[^\n]*\n/, "").replace(/\n\s*(?:```|~~~)\s*$/, "");
	// 整体包裹的加粗 / 引号。
	text = text.replace(/^\s*(\*\*|__)([\s\S]+)\1\s*$/, "$2");
	text = text.replace(/^\s*["'“”‘’「『]([\s\S]*)["'“”‘’」』]\s*$/, "$1");
	// 「摘要：」这类前缀（提示词已禁止，模型仍可能加）。
	text = text.replace(/^\s*(?:摘要|口播摘要|总结|summary|summarize)\s*[:：]\s*/i, "");

	text = text
		.split("\n")
		.map((line) =>
			// 顺序同 `toSpeakable`：**噪音过滤先于反引号剥离** —— 反引号是「代码形态」的信号，
			// 先被 `.replace(/[`*_~]/g, "")` 去掉的话，短编号就漏了（实测过）。
			stripSpokenNoise(
				line
					.replace(/^\s{0,3}#{1,6}\s+/, "")
					.replace(/^\s{0,3}[-+*]\s+/, "")
					.replace(/^\s{0,3}\d+[.)]\s+/, ""),
			)
				.replace(/[`*_~]/g, "")
				.trim(),
		)
		.filter((line) => line.length > 0)
		.join("\n");

	if (!text) return "";
	// 摘要是**一段话**而不是分行结论：换行收成空格（`tightenCjkSpacing` 再收掉中文之间的
	// 缝隙，`{2,}` 再收掉编号被摘掉后的空格）——否则 `say` 会把中文里的换行读成停顿或怪调。
	return truncateAtSentence(
		tightenCjkSpacing(text.replace(/\s*\n\s*/g, " ")).replace(/ {2,}/g, " "),
		maxChars,
	);
}

// =============================================================================
// 音色目录：`say -v '?'` 的解析（locales 判定与列表都要它，所以放纯逻辑里）
// =============================================================================

export interface VoiceInfo {
	name: string;
	locale: string;
}

const LOCALE_RE = /\b([a-z]{2,3}_[A-Za-z]{2,4})\b/;

/**
 * 解析 `say -v '?'` 的一行。格式：
 *
 *   ```text
 *   Tingting            zh_CN    # 你好！我叫婷婷。
 *   Eddy (中文（中国大陆）)   zh_CN    # 你好！我叫Eddy。
 *   ```
 *
 * 名字里可以带空格与括号（Eddy (中文（中国大陆）)），所以不能按空白切 —— 定位
 * locale 标记（`xx_YY`），它之前的部分是名字、之后（`#` 之后）是示例句。
 */
export function parseVoiceLine(line: string): VoiceInfo | undefined {
	const match = LOCALE_RE.exec(line);
	if (!match) return undefined;
	const name = line.slice(0, match.index).trim();
	if (!name) return undefined;
	return { name, locale: match[1] };
}

/** 解析整个 `say -v '?'` 输出。 */
export function parseVoiceList(output: string): VoiceInfo[] {
	return output
		.split("\n")
		.map((line) => parseVoiceLine(line))
		.filter((v): v is VoiceInfo => v !== undefined);
}

/** 中文音色优先的候选顺序（本机存在的会被 /voice 列出来）。 */
export const PREFERRED_VOICES = ["Tingting", "Meijia", "Sinji", "Sandy (中文（中国大陆）)", "Eddy (中文（中国大陆）)"];
