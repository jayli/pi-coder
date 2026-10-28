/**
 * working-indicator.ts — 语义化 working spinner 文案 + 运行时长读秒 + bash 执行中行尾 ●
 *
 * pi 内置的 working loader 在流式期间只显示一句固定的 "Working"，看不出当前
 * 在做什么、已经跑了多久。这个扩展用 `ctx.ui.setWorkingMessage()` 把它换成
 * 随状态变化的文案，并在尾部挂一个每秒读秒的运行时长。
 *
 * 文案规则：
 *   bash 工具          → Tools Calling (↓ N tokens · D)
 *   edit 工具          → Editing         (↓ N tokens · D)
 *   write 工具         → Writing         (↓ N tokens · D)
 *   read 工具          → Reading         (↓ N tokens · D)
 *   模型推理中         → Thinking        (↓ N tokens · D)
 *   其他（含未知工具） → Working         (D)
 *
 * 配色：**标签用正文色（正常白），后面的统计段保持 pi 默认的 muted 灰**。
 * 详见 `formatWorkingMessage` 的注释 —— 颜色必须拼进文案字符串里，因为 pi 只按
 * 「整条文案」上色，没有分段着色的入口。
 *
 * 时长格式：<60s 用 `42s`；≥60s 用 `1m 23s`；≥1h 用 `1h 23m 32s`。
 *
 * token 口径说明：`↓ N tokens` 是**当前这一小段的产出量**，不是回合累加值。每次推理段
 * （`thinking_start`）、每次工具参数段（`toolcall_start`）都从 0 重新开始数 —— 否则一个
 * 回合里跑几次工具，数字会一路涨上去，看不出「这次 bash 命令有多大」。实现上按段类型
 * 分成独立的计数器（推理段 / 工具参数段各一份），显示的数跟着当前文案走：`Thinking` 配
 * 推理段的数、`Tools Calling` / `Editing` / `Writing` / `Reading` 配工具参数段的数。
 * 正文段（`text_delta`）刻意不计：它从不显示，累加只会污染后面几段的数。
 *
 * 四个实测得来的实现前提（都验证过）：
 *   1. **`usage.output` 在流式期间恒为 0**（probe 实测：thinking_start /
 *      toolcall_start / 多个 text_delta 时点全是 0），所以 token 数只能从
 *      流式字符估算，不能读 usage。
 *   2. **`toolcall_start` 的 `partial.content[contentIndex].name` 已经带
 *      工具名**（probe 实测 `block.type=toolCall block.name=bash`），所以
 *      参数还在流式生成时就能显示工具态，不必等到 `tool_execution_start`。
 *   3. 现有扩展没人用过 `setWorkingMessage` / `setWorkingIndicator`（grep
 *      0 命中；`setStatus` 只被 simple-task / cwd-statusline 用在 footer），
 *      所以不存在同名覆盖冲突。
 *   4. **`toolcall_checkpoint` 不在扩展能看到的事件联合里** —— pi-ai 的
 *      `AssistantMessageEvent` 只有 start / text_* / thinking_* /
 *      toolcall_{start,delta,end} / done / error；checkpoint 是 TUI / session
 *      编码器内部用的 `MessageFrame`，在事件流下游。所以每个参数 delta 都会
 *      以 `toolcall_delta` 到达扩展，段级计数本身就是完整的，不需要为恢复会话的
 *      catch-up 补一段（补了反而会和 delta 重复计数）。
 *
 * 时长口径说明：秒数是**回合级**时钟（从 `agent_start` 起算），不是每个活动
 * 各自计时。这样 `Working (42s)` 和 `Tools Calling (… · 42s)` 是同一个数，
 * 不会因为状态切换而跳回 0 —— 切换活动时时钟若重置，读秒就失去了"这个回合
 * 已经花了多久"的意义。**token 数正好相反，是段级的**：时长答"这个回合跑了多久"，
 * token 答"当前这一段产出了多少"，两个口径刻意不同。
 *
 * 行尾还有一段**右对齐的提示词摘要**（`working-summary.ts` 算布局）：当前回合
 * 用户输入**压平成一行**后的前排字符，放不下就截断补 `…`，形如
 *
 *     ⠧ Working (23s)                        ✦ /init 我要优化…
 *
 * 用来在长任务跑起来之后提醒「这一轮到底在干什么」。压平规则见 `flattenPrompt`：
 * 多行折成一句（行间按两侧字符决定补不补空格，CJK 折行处不插空格）、缩进 / 制表符 /
 * 连续空格折叠、ANSI 转义与零宽字符剥掉、Markdown 排版噪声（列表符号 / 引用 / 标题 /
 * 代码围栏标记行）剥掉 —— 截断针对整段而不只是第一行。几个要点：
 *   - 提示词从 `input` 事件捕获（"Fired when user input is received, before
 *     agent processing"）：普通消息就是用户敲的原文，skill / 模板命令是展开前的
 *     原始命令行。**扩展命令（如 /init）例外** —— pi 在 `input` 事件之前就把
 *     原始命令行消费掉了（`agent-session.prompt()` 先走
 *     `_tryExecuteExtensionCommand`，命中即 return），扩展能看到的只有命令
 *     handler 经 `sendUserMessage` 发出的那段提示词，所以 /init 显示的是它
 *     构造的提示词压平后的前排字符而不是 "/init …"。
 *   - 压平在 `input` 事件里**算一次并缓存**（`promptText`），不在每次 refresh 里重算 ——
 *     refresh 每个流式 delta 都会跑，几十 KB 的粘贴不能每次都重新扫一遍。
 *   - 流式中 steer / followUp 也会触发 `input`，摘要跟着更新成最新一条指令。
 *   - **长提示词会异步请模型压成一句话**（`summary-request.ts` 决策 / 提示词 / 清洗，
 *     这里只负责发请求与回包护栏）：原文超过可用宽度 `PI_WORKING_SUMMARY_TRIGGER` 倍
 *     （默认 1，即只要放不下就压）时，拿**同一个可用宽度**算出一个目标列数，让
 *     模型按「一句话说清这段提示词要干什么」返回；请求与主回合并行，不 `await`、不阻
 *     塞任何渲染路径；回来了就顶掉原文，没回来 / 超时 / 报错 / 返回空串就一直显示截断
 *     后的原文，并隔 `PI_WORKING_SUMMARY_RETRY_MS`（默认 3s）**再试一次** —— 每个提示词
 *     最多请求两次，第二次仍失败就放弃（新提示词 / 回合结束会作废待重试的那次）。摘要
 *     回来超长也不追问：按可见宽度正常截断就行（再要一次只会让这一格来回跳）。压平后的
 *     原文也参与判断（不像旧实现那样只看第一行）：只要整段超出阈值就请求，所以多行
 *     粘贴的长提示词同样能拿到摘要。
 *     代价：本机网关给这些模型路由在 `extra_body` 里**写死了 thinking**
 *     （`thinking: {type: enabled}` + `reasoning_effort: max`，客户端关不掉），所以这次
 *     请求一定带着思考：实测 3-20s、600-1400 个 thinking token。默认用当前会话模型，
 *     想省钱 / 提速可以 `PI_WORKING_SUMMARY_MODEL=provider/modelId` 换成便宜快的模型，
 *     或者 `PI_WORKING_SUMMARY_LLM=off` 整个关掉。
 *   - 右对齐靠「把整行可见宽度恰好凑满预算」实现：pi 的 working message 走
 *     Text 的 word-wrap，只有不超宽才单行原样输出（详见 working-summary.ts
 *     头注释）。预算 = 终端列数 − 4（spinner "⠧ " 2 列 + Text paddingX 左右
 *     各 1 列），终端宽度每次刷新现读 `process.stdout.columns`，resize 后
 *     下一个 1s tick 自愈。
 *   - 摘要段另有**整段宽度上限 = 终端宽度的一半**（`floor(cols / 2)`，含
 *     `✦ ` 前缀）：宽终端上剩余空间再多，摘要也不会超过半屏，免得长提示词
 *     把左边的状态文案挤得只剩几列；上限收窄出的富余并进 gap，右对齐不变。
 *     请求目标长度用的是同一个 `availableSummaryTextWidth`，所以「要求模型写多长」
 *     与实际能显示多少列是同一份数学。
 *   - 只对**独立 spinner 行**（statusContainer）精确成立。若 working 指示器被
 *     嵌进编辑器上边框（内置编辑器的 embedWorkingStatus 模式；本机装的
 *     prompt-editor.ts 没开嵌入，所以走独立行），边框渲染会把超宽部分截掉、
 *     摘要自动退化为不显示（折行发生在 gap 的空格处，第一行仍是原文案），
 *     不会渲染出半截摘要。
 *   - 配色：`✦` 用 syntaxKeyword（语法高亮的关键字色，在各行主题里都够显眼又不刺眼），
 *     摘要正文用 muted（与统计段一致，不跟标签抢注意力）。
 *   - 开关：`PI_WORKING_SUMMARY=off` 整段关闭；`PI_WORKING_SUMMARY_LLM=off` 只关掉
 *     模型压缩（退回「压平 + 截断」）；`PI_WORKING_SUMMARY_TRIGGER=<n>` 调触发倍数
 *     （默认 1 = 只要放不下就请求；调大则先容忍截断，见 `SUMMARY_TRIGGER_RATIO`）；
 *     `PI_WORKING_SUMMARY_MODEL=provider/modelId` 指定摘要模型（缺省用
 *     当前会话模型，也可以用便宜快的模型，摘要只是个附带请求）；
 *     `PI_WORKING_SUMMARY_GAP=<n>` 调整左段与摘要之间的最小空隙（默认 1 列；
 *     右对齐时实际空隙通常远大于它，这个值只是窄终端下的下限）。
 *
 * ## spinner 幻彩帧（`spinner-frames.ts`）
 *
 * pi 的 working spinner 是十帧盲文 + 单色 accent。本扩展把它换成**同族盲文按调色板轮换颜色**
 * 的幻彩帧：accent → success → warning → syntaxKeyword → toolDiffAdded → toolDiffRemoved →
 * toolTitle，每色 ≈1.5s（19 帧 × 80ms = 1520ms；1500ms 不是 80ms 的整数倍，取最近的 19 帧，
 * 差 1.3%；初版 400ms → 800ms → 1520ms，一路按需求放慢），旋转速度与 pi 默认完全一致
 * （同一套十帧盲文、同一个 80ms 帧间隔），所以看着只是「那只熟悉的 spinner 在变色」。
 *
 * 帧表只能**预烘颜色**：`ctx.ui.setWorkingIndicator({ frames })` 的自定义帧是 verbatim 渲染的
 * （pi 的 Loader 里 `renderIndicatorVerbatim` 为真时不套 `spinnerColorFn`），颜色得自己带在帧
 * 字符串里。于是换主题后必须重装帧表 —— `refresh()` 每秒读主题时顺手比一下色板指纹（同主题
 * 稳定、换肤必变），变了才重装（重装会把动画相位复位，所以不能进每秒 tick 里无脑调）。
 * 帧表怎么排、色槽撞车怎么去重、单色主题怎么降级，全在 `spinner-frames.ts` 头注释里（纯模块，
 * 12 条 `node --test` 用例）。
 *
 * 三个装帧表的时机：
 *   - `agent_start`：回合开始、spinner 还没渲染，相位复位看不见；同时把「上一回合被
 *     `ask_user_question` 顶掉」与「换会话时 pi 的 `resetExtensionUI()` 把 indicator 还原成
 *     默认帧」这两种情况一并补回来。
 *   - `refresh()` 里的指纹比对：`/theme` 换肤后一秒内自愈。
 *   - `ask_user_question` 的 `tool_execution_end`：那个扩展在问卷期间冻结 spinner（单帧 ⠿），
 *     退出时无参 `setWorkingIndicator()` 恢复的是 **pi 的默认帧**（它不知道本扩展的彩帧），
 *     所以问卷一结束就补装，免得这一回合剩下的时间掉回单色。
 *
 * 七个色槽在当前主题里可能撞色（实测 pi-coder-summer-night 的 success == toolDiffAdded、warning ==
 * toolTitle），撞车的只留一个；如果最后只剩一种颜色（单色主题 / `NO_COLOR` / 恒等 `fg`），
 * 干脆不下发帧表、保持 pi 默认 spinner —— 装一张每帧长得都一样的「动画」表没有意义。
 * 开关：`PI_SPINNER_RAINBOW=off` 回到单色 accent；`PI_SPINNER_COLOR_HOLD=<帧数>` 调每种
 * 颜色持续多久（默认 19 帧 ≈ 1.5s；1 = 每帧一换，在 80ms 帧率下是频闪，不是幻彩）。
 *
 * ## 标签扫光（`label-shadow.ts`）
 *
 * 用户 2026-10-28 要的效果：一道有渐变的黑影**从左到右快速划过整个状态词**，像有个东西飞过去
 * 遮住了光，单词中间被压暗一下又立刻亮回来；**两秒一次**。范围是**所有状态词**（`Working` /
 * `Thinking` / `Editing` / `Writing` / `Reading` / `Tools Calling`，用户定），压暗方式是**字色
 * 混向黑**（用户定：不用 `\x1b[2m` 那种由终端自己决定深度的 faint，也不用主题的 muted 槽）。
 *
 * 时间轴是**恒定速度**而不是「每周期固定时长」（用户定：不管单词多长，划过的速度一样）：
 * 默认 20 列/秒，两秒一趟 ⇒ 一趟能走 40 列。`Working`（7 列）约 0.65s 飞过、剩下 1.35s 词上
 * 无影子；`Subagent watchdog reviewing`（27 列）则扫 1.65s。
 *
 * **跨状态连续**（用户 2026-10-28 定）：影子位置只由**回合时钟**决定（`shadowColumnAt`），与标签
 * 宽度无关。所以扫到单词一半时状态切换了，影子在**原位置**继续往右扫（换个更长的词就是同一道
 * 影子接着走）；如果新标签比影子位置还短（影子已经飞到它后面），这一帧就不画，**等两秒间隔
 * 到点再从左边重来** —— 不会出现「影子瞬移回句首」。
 *
 * 实现上三件事值得记住：
 *   - **定时器是自排程的一次性 setTimeout，不是 50ms interval**：`shadowSchedule` 返回
 *     「下一帧要等多久」，静止段里那个值就是「下一趟开始还有多久」，所以 2/3 的时间一次重绘
 *     都不发。流式期间 `message_update` 每秒会调几十次 `refresh()`，所以重复排帧要按
 *     「到点时刻差 < 5ms 就当同一帧」去重，否则定时器一直在被推倒重建。
 *   - **静止段与带子完全在标签外的那两帧必须走 `paint.plain(label)` 一条路径**：`refresh()` 靠
 *     `message === lastMessage` 去重，如果静止时把标签拆成 7 个同色段，字符串就每周转都不一样，
 *     会变成每秒几十次无用重绘。`shadowSegments` 在这两种情况下返回 `null`。
 *   - **颜色只从主题的活值现取**（`theme.colors[LABEL_COLOR]` + `theme.getColorMode()`）：换肤后
 *     下一个 1s tick 自然就用新色，不需要额外的失效逻辑；拿不到具体色值（主题 `text` 是空串 /
 *     终端没报颜色 / pi-tui 缺那几个函数）就退回静态标签 —— 不猜颜色。
 *
 * 开关：`PI_LABEL_SHADOW=off` 整个关掉；`PI_LABEL_SHADOW_PERIOD_MS` / `_SPEED`（列/秒）/
 * `_BAND`（带宽列数）/ `_STRENGTH`（深处压暗比例，默认 0.72）四个旋钮，默认值见
 * `DEFAULT_SHADOW_TIMING`。
 *
 * ## bash 执行中 `●`（working 行尾）
 *
 * 需求原文：把 `●` 挂在 `⠼ Tools Calling (13m 59s)` 后面，bash 执行时长超过 1 秒后出现、
 * 执行结束后消失；多个 bash 同时在执行时，任意一个超过 1s 就闪，**所有** bash 都结束后才
 * 消失。这是退役的 bash 首行 `$ ` → `● ` spinner 的落点迁移（命令块里不再出现 `●`）：
 * 门槛 1s、亮 / 灭各 500ms、`PI_BASH_SPINNER=off` 关闭，都与旧版同契约。
 *
 * 实现分两半：纯逻辑在伴生模块 `bash-spinner.ts`（形态 / 门槛 / 并发登记簿，不 import pi，
 * `node --test` 用例在 `bash-spinner.test.ts`），定时器在 `index.ts`：
 *   - `tool_execution_start`（toolName=bash）落账、`tool_execution_end` 销账，`toolCallId`
 *     为键，天然支持并行多 bash；
 *   - 每次 `refresh()` 都跑 `driveBashSpinner(now)`：已跨过门槛 → 起 500ms 节拍（翻相位 +
 *     重绘）；还没跨过 → 按**最早**那个执行的截止点排一次性定时器，让 `●` 准时出现（非流式
 *     命令执行期间没有上游事件，不自驱就永不重绘）；
 *   - 标记段拼在左段（标签 + 统计段）末尾、摘要布局之前，恒 2 列（亮 `" ●"` / 灭两格空格），
 *     所以右对齐的提示词摘要不随亮灭左右蹦；
 *   - 停表三处：`agent_settled` / `session_shutdown`（回合结束、会话替换）、旧 ctx 的
 *     try/catch（`stopActivity`）、以及 `refresh()` 早退分支（不在回合内）。
 *   - 标签口径顺带修了一处：`executingTool` 从单字符串改成 `toolCallId → 工具名` 的 Map ——
 *     并行批次里先结束的工具不再把还在跑的工具名清掉（否则长 bash 的 `●` 会挂在 `Working`
 *     而不是 `Tools Calling` 后面）。标签仍取最后启动的那个，优先级语义不变。
 *
 * ## 回合结束符 `✻ Churned for 3m 37s · done 11:52 PM`（turn-marker.ts）
 *
 * 用户 2026-10-07 定：一轮对话跑完 spinner 直接消失、不留痕迹，要求把它原地换成一条静态
 * 结束符。文本 / 词表 / 时钟 / 条目契约都在 `turn-marker.ts`（十个词随机取一个、12 小时制
 * `11:52 PM`、整行 dim 色 —— 与 recap 行里 `Recap:` 标签同档；纯模块，单测在
 * `turn-marker.test.ts`）；这里只管时机与落点：
 *   - 落点是**会话条目**（`pi.appendEntry(TURN_MARKER_ENTRY_TYPE, { text })` +
 *     `pi.registerEntryRenderer`），不是编辑器上方的 widget（用户 2026-10-26 定，替换
 *     10-07 的 widget 方案）。widget 那条路的病根：它占的是编辑器上方那一格，`agent_start`
 *     时必须显式清掉（否则盖在活 spinner 上）⇒ **用户一敲下一句，上一回合的结束符就消失了**。
 *     会话条目活在 chat 流里，往上滚仍在、`/resume` 与重开也仍在。`type: "custom"` 的条目
 *     不进模型上下文（pi 的 `convertToLlm` 直接丢弃），所以零 token 成本；也不再需要 widget
 *     那套「行尾补空行」间隔补偿 —— `CustomEntryComponent` 自带一条前导空行。
 *   - 时机：`agent_settled`（回合真正结束 —— `agent_end` 之后还可能自动重试 / 压缩 / 排队消息）。
 *     时长 = `agent_start` → `agent_settled` 的墙钟，复用 spinner 读秒的同一个 `formatDuration`，
 *     结束时长不会与 spinner 最后一帧对不上。
 *   - 只认正常完成：结局在 `agent_before_settle` 记下（`agent_settled` 不带载荷），`aborted` /
 *     `error` 不写 —— ESC 打断保持现状，spinner 直接消失。
 *   - **还有子代理在跑就不写**（用户 2026-10-08 要求，见下）。
 *   - 不做任何清理：条目一旦写进会话就是历史，`agent_start` 不再碰它（这正是这次改动的目的）。
 *   - 开关 `PI_TURN_MARKER=off`。
 *
 * ## 为什么有子代理在跑时不画结束符（`subagentsBusy`）
 *
 * 病根：异步子代理是**脱离回合**的 —— `subagent({ async: true })` 发出去主回合就结束，
 * 子代理还在后台跑几分钟，结果由被唤醒的**后续回合**带回。而 `agent_settled` 只看
 * `outcome === "completed"`，于是主回合结束时照样画一行「✻ … · done 8:04 AM」，
 * 它恰好紧贴在 pi-subagents 的 `async subagent · background` 块下面 —— 用户原文：
 * 「我希望当有 subagent 进行的时候不要输出这个结束标记，因为还有 subagent 进行中」。
 * 结束符断言的语义是「这一轮真做完了」，而那一刻并没有。
 *
 * 判据走**仓库里现成的探测**：`recap/subagents.ts` 的 `hasActiveSubagentWork(pi.events)`
 * —— pi-subagents 的进程内事件总线 RPC（`subagents:rpc:v1:request` 的 `status` 方法 →
 * `fleet.totalActive`，前台 / 异步 / 排队都算），`verify-loop` 已经这么用了。不新增文件、
 * 不 import pi-subagents 的任何文件（它是独立安装的 npm 包，也可能压根没装）。
 *
 * 两条规则（用户 2026-10-08 选）：
 *   - 探到有活 → 不写。子代理唤醒的那一轮结束时（若真跑完了）会写自己的结束符，语义
 *     正好落回「这轮真做完了」。
 *   - 探不到答案（没装 pi-subagents / 协议不认识 / 超时 / 抛异常）→ 当作没有，照常写
 *     （fail-open，recap 的既定口径）。
 *
 * 代价：每个正常完成的回合多一次进程内 RPC。装了 pi-subagents 是毫秒级；没装的机器要
 * 等一次超时 —— pi 的 `EventBus` 只暴露 `emit`/`on`/`clear`（`dist/core/event-bus.js`），
 * **没有 listenerCount**，无法在「没对端」时零成本短路，所以超时值是这里唯一的成本旋钮
 * （`PI_TURN_MARKER_PROBE_TIMEOUT_MS`，默认 300ms）。探测放在 completed 判断**之后**，
 * 被打断 / 报错的回合一次都不问。
 * 范围只算子代理：`run_in_background` 的后台 shell 仍照常出结束符（用户 2026-10-08 定）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as piTui from "@earendil-works/pi-tui";
import {
	BASH_SPINNER_BLINK_MS,
	BASH_SPINNER_COLOR,
	BashRunTracker,
	bashSpinnerSuffix,
} from "./bash-spinner.ts";
import {
	DEFAULT_MIN_GAP,
	SUMMARY_MARKER,
	availableSummaryTextWidth,
	flattenPrompt,
	layoutPromptSummary,
} from "./working-summary.ts";
import {
	DEFAULT_FRAMES_PER_COLOR,
	SPINNER_INTERVAL_MS,
	buildSpinnerPalette,
	type SpinnerPalette,
} from "./spinner-frames.ts";
import {
	DEFAULT_TRIGGER_RATIO,
	TARGET_WIDTH_RATIO,
	buildSummaryRequestPrompt,
	cleanSummaryText,
	planSummaryRequest,
} from "./summary-request.ts";
import { buildContinuationSummaryPrompt, isContinuationPhrase } from "./summary-continuation.ts";
import {
	DEFAULT_SHADOW_TIMING,
	labelWidth,
	paintLabel,
	shadowSchedule,
	shadowSegments,
	type ShadowPaint,
	type ShadowTiming,
} from "./label-shadow.ts";
import { hasActiveSubagentWork } from "../recap/subagents.ts";
import {
	TURN_MARKER_ENTRY_TYPE,
	formatEndClock,
	formatTurnMarker,
	pickTurnVerb,
	turnMarkerTextFromEntry,
} from "./turn-marker.ts";

/** 工具名 → 文案。没列进来的工具一律回落到 Working（按需求「其他情况都显示 Working」）。 */
const TOOL_LABELS: Record<string, string> = {
	bash: "Tools Calling",
	edit: "Editing",
	write: "Writing",
	read: "Reading",
};

const THINKING_LABEL = "Thinking";
const DEFAULT_LABEL = "Working";
/**
 * **不参与标签扫光**的状态（用户 2026-10-28 定）：`Thinking` 与三个工具态
 * （`Tools Calling` / `Editing` / `Writing`）。保留扫光的只有 `Working` 与 `Reading`。
 *
 * 从 `TOOL_LABELS` 派生而不是重写字符串：工具名 → 文案的映射只该有一处，否则改文案时
 * 这个集合会暗暗失效（表现是「刚排除掉的状态又开始扫了」，很难想到是这里）。
 */
const SHADOW_EXCLUDED_LABELS: ReadonlySet<string> = new Set([
	THINKING_LABEL,
	TOOL_LABELS.bash,
	TOOL_LABELS.edit,
	TOOL_LABELS.write,
] as string[]);
/**
 * 问卷工具名（`ask-user-question/` 扩展注册的）。它在问卷期间把 working indicator 冻结成单帧、
 * 退出时无参恢复成 pi 的**默认**帧（见文件头「spinner 幻彩帧」），所以本扩展要在它结束时补装彩帧。
 */
const ASK_USER_QUESTION_TOOL = "ask_user_question";

/**
 * 弹窗期间 spinner 冻结在这一帧（与 `ask-user-question` 扩展同字同族：盲文全集字符，
 * 看起来是「spinner 停住了」而不是换了个东西）。pi-tui Loader 对单帧 indicator 不起
 * 动画定时器，所以冻结帧 = 停掉 80ms 重绘。
 */
const FROZEN_SPINNER_FRAME = "⠿";

/**
 * 文案两个色段。标签用 `text`（正文正常色，深色主题下就是那条浅白），统计段用
 * `muted` —— 和 pi 给整条 working message 上的默认色**同一个槽位**，所以那截灰
 * 渲染出来和改动前一致（只是转义符的位置从整条包一层变成统计段自己带前缀）。
 */
const LABEL_COLOR = "text";
const STATS_COLOR = "muted";
/** 摘要标记 `✦` 的颜色：语法高亮的关键字色，作行尾的视觉锚点。 */
const SUMMARY_MARKER_COLOR = "syntaxKeyword";

/**
 * spinner（"⠧ " 2 列）+ Text 组件 paddingX（左右各 1 列）占掉的列数：
 * working message 的可见宽度预算 = 终端列数 − 4（见文件头注释）。
 */
const SPINNER_AND_PADDING_COLUMNS = 4;

const SUMMARY_ENABLED = (process.env.PI_WORKING_SUMMARY ?? "").toLowerCase() !== "off";
/**
 * 提示词太长时请模型压成一句话的开关（`PI_WORKING_SUMMARY_LLM=off` 关掉，退回「只截断」）。
 * `PI_WORKING_SUMMARY=off` 时整段摘要都不显示，自然也不用请求。
 */
const SUMMARY_LLM_ENABLED = SUMMARY_ENABLED && (process.env.PI_WORKING_SUMMARY_LLM ?? "").toLowerCase() !== "off";
/**
 * 延续短语的摘要延续开关（`PI_WORKING_SUMMARY_CONTINUATION=off` 关掉，退回「短语原样显示」）。
 * 依赖 LLM 摘要：关掉 `PI_WORKING_SUMMARY_LLM` 时这条路径自然也不存在。
 */
const SUMMARY_CONTINUATION_ENABLED =
	SUMMARY_LLM_ENABLED && (process.env.PI_WORKING_SUMMARY_CONTINUATION ?? "").toLowerCase() !== "off";
/**
 * 超过可用宽度的多少倍才请求摘要（`PI_WORKING_SUMMARY_TRIGGER`，默认 1）。
 * 1 = 只要放不下（哪怕只多一列）就请求；调大则先容忍截断：1.2 ≈ 截断丢掉近两成原文才压，
 * 2 = 丢掉一半以上才压。小于 1 的值无意义（退回默认）。
 */
const SUMMARY_TRIGGER_RATIO = (() => {
	const parsed = Number.parseFloat(process.env.PI_WORKING_SUMMARY_TRIGGER ?? "");
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_TRIGGER_RATIO;
})();
/**
 * 摘要请求用哪个模型（`PI_WORKING_SUMMARY_MODEL=provider/modelId`，如 `litellm-any/deepseek-flash`）。
 * 缺省 / 解析不到时用当前会话模型 —— 摘要只是个附带请求，不该因为配置写错就消失。
 */
const SUMMARY_MODEL_SPEC = (process.env.PI_WORKING_SUMMARY_MODEL ?? "").trim();
/** 摘要请求的硬超时，到点 abort。本机这些路由都带着强制 thinking，实测一次「压一句话」
 * 要 3-20s（qwen3.8-flash 在 max 档上偏慢），所以比 recap 的 30s 再宽一点；回合结束时
 * 还会提前 abort（那时摘要已经没人看）。超时只是白花一次请求，不影响主任务。 */
const SUMMARY_TIMEOUT_MS = 45_000;
/** 摘要请求失败后的默认重试延时（`PI_WORKING_SUMMARY_RETRY_MS` 覆盖）。 */
const DEFAULT_SUMMARY_RETRY_DELAY_MS = 3_000;
/**
 * 首次请求失败后延时多久再试一次（`PI_WORKING_SUMMARY_RETRY_MS`，默认 3s；0 = 立即重试）。
 * 失败多半是一次抖动（上游 5xx / 连接被掐 / 只出了 thinking 没出正文），隔几秒再要一次
 * 常常就有了；**只重试这一次**（见 `SUMMARY_MAX_ATTEMPTS`）。
 */
const SUMMARY_RETRY_DELAY_MS = (() => {
	const raw = (process.env.PI_WORKING_SUMMARY_RETRY_MS ?? "").trim();
	if (raw === "") return DEFAULT_SUMMARY_RETRY_DELAY_MS;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SUMMARY_RETRY_DELAY_MS;
})();
/** 摘要请求最多尝试几次：首次 + 一次重试；第二次仍失败就彻底放弃。 */
const SUMMARY_MAX_ATTEMPTS = 2;
/**
 * 摘要请求的 maxTokens。**必须给 thinking 留足份额**：本机网关给这些路由强制
 * `thinking: {type: enabled}` + `reasoning_effort: max`（`gateway/config.yaml` 的
 * `extra_body`），客户端关不掉；实测「压一句话」光思考就要 600-1400 token，预算给小了
 * 思考会把额度吃光、正文一个字都不剩（实测 80 / 512 / 2048 全被 thinking 吃满）。
 * 1024 在 deepseek-flash / qwen3.8-flash / deepseek-flash-qd 上都稳定留下正文。
 *
 * 另：**不要传 `temperature: 0`** —— 这几个 max 档路由在 0 温度下会退化成停不下来的
 * 长思考（2048 额度也被吃光且零正文），默认温度下 3s 就正常返回。
 */
const SUMMARY_MAX_TOKENS = 1024;
/**
 * 估算「左段（标签 + 统计段 + `●`）占多宽」的余量，只用于请求模型时算目标长度。
 * 请求发生在 `input` 事件里，那时这一回合还没开始、真实左段不存在，只能按工具执行态
 * （最长的 `Tools Calling (↓ N tokens · D)` 加行尾 `●`）估一个偏保守的值：宽终端上真正
 * 起作用的是半屏上限，这个估计只在窄终端里生效，估小了反而会让摘要被截。
 */
const SUMMARY_LEFT_WIDTH_ESTIMATE = 34;
/**
 * bash 执行中 `●` 的开关。env 名沿用退役的 bash 首行 spinner（`PI_BASH_SPINNER`）：
 * 功能只是把落点从命令块挪到了 working 行尾。
 */
const BASH_SPINNER_ENABLED = (process.env.PI_BASH_SPINNER ?? "").toLowerCase() !== "off";
/**
 * 幻彩 spinner 开关（`PI_SPINNER_RAINBOW=off` 回到 pi 默认的单色 accent 十帧）。
 */
const SPINNER_RAINBOW_ENABLED = (process.env.PI_SPINNER_RAINBOW ?? "").toLowerCase() !== "off";
/**
 * 标签扫光开关（`PI_LABEL_SHADOW=off` 关闭，标签回到静态单色）。
 * 动画的时间轴与形状在 `label-shadow.ts`（纯模块，13 条用例）。
 */
const LABEL_SHADOW_ENABLED = (process.env.PI_LABEL_SHADOW ?? "").toLowerCase() !== "off";
/**
 * 扫光的可调参数（都能用 env 覆盖，`PI_LABEL_SHADOW_*`）：周期 / 速度（列每秒）/ 带宽 /
 * 最深处的压暗强度。默认值见 `DEFAULT_SHADOW_TIMING`：两秒一趟、20 列/秒、6 列宽的软边带、
 * 最深处压到原色的 28%。
 */
const SHADOW_TIMING: ShadowTiming = {
	periodMs: envNumber("PI_LABEL_SHADOW_PERIOD_MS", DEFAULT_SHADOW_TIMING.periodMs),
	columnsPerSecond: envNumber("PI_LABEL_SHADOW_SPEED", DEFAULT_SHADOW_TIMING.columnsPerSecond),
	bandColumns: envNumber("PI_LABEL_SHADOW_BAND", DEFAULT_SHADOW_TIMING.bandColumns),
	maxStrength: envNumber("PI_LABEL_SHADOW_STRENGTH", DEFAULT_SHADOW_TIMING.maxStrength),
};
/** 解析 env 里的正数；缺省 / 解析不出就用默认值（`normalizeTiming` 还会再夹一次范围）。 */
function envNumber(name: string, fallback: number): number {
	const raw = (process.env[name] ?? "").trim();
	if (raw === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}
/**
 * 影子往哪个方向压暗：把标签本色按 `strength` 混向**黑**（用户 2026-10-28 选的「字色压暗」）。
 *
 * 为什么不是 `\x1b[2m`（SGR 2 faint）：那是终端自己决定压多暗，各终端差异极大，而且 faint 与
 * 正文色不是同一条色相 —— 看着像「字变淡了」而不是「一道影子遮住了光」。混向黑能在深浅两种
 * 皮肤上都真的变暗，且两个色值都是主题自己的。
 *
 * 拿不到主题的具体色值（`text` 被设成空串 / 终端没报颜色 / pi-tui 缺函数）时返回 null，调用方
 * 退回静态标签 —— 动画是装饰，任何一步拿不到真色值就不猜。
 */
function createShadowPaint(theme: ExtensionContext["ui"]["theme"]): ShadowPaint | null {
	const ops = SHADOW_COLOR_OPS;
	if (ops === null) return null;
	let base: unknown;
	let mode: string;
	try {
		base = theme.colors[LABEL_COLOR];
		mode = theme.getColorMode();
	} catch {
		return null;
	}
	if (base === undefined) return null;
	const black = ops.rgbColor(0, 0, 0);
	// 每个量化档的转义只算一次：一帧最多 8 段，但每秒可能有 20 帧。
	const ansiCache = new Map<number, string>();
	const ansiFor = (strength: number): string => {
		const cached = ansiCache.get(strength);
		if (cached !== undefined) return cached;
		const ansi = ops.foregroundAnsi(ops.mixColors(base, black, strength), mode);
		ansiCache.set(strength, ansi);
		return ansi;
	};
	return {
		plain: (text) => theme.fg(LABEL_COLOR, text),
		shaded: (text, strength) => `${ansiFor(strength)}${text}\x1b[39m`,
	};
}
/**
 * 回合结束符开关（`PI_TURN_MARKER=off` 关闭，回到「回合结束 spinner 直接消失」）。
 * 关掉后不写会话条目，也不注册渲染器。形状 / 条目契约 / 12 小时制时钟都在 `turn-marker.ts`。
 */
const TURN_MARKER_ENABLED = (process.env.PI_TURN_MARKER ?? "").toLowerCase() !== "off";
/**
 * 结束符的色槽：`dim`，与 recap 行里 `Recap:` 标签同档（用户 2026-10-07 定）。整行
 * （含行首 `✻`）一个色段，所以只有一个槽位。
 */
const TURN_MARKER_COLOR = "dim";
/**
 * 结束符条目的行首缩进（**列数**）。
 *
 * 会话条目的渲染器直接返回行，没有 `Text` 的 `paddingX=1` 那一格；而同一屏里的用户消息、
 * recap 行、工具块都带一格缩进，留一格让结束符与它们对齐（与旧 widget 方案看的行首位置一致）。
 */
const TURN_MARKER_INDENT = " ";
/**
 * 结束符前那次「还有子代理在跑吗」探测的超时（`PI_TURN_MARKER_PROBE_TIMEOUT_MS`）。
 *
 * 装了 pi-subagents 时对端回的是内存快照、毫秒级就到，这个值只在**没装**的时候起作用：
 * pi 的事件总线没有 listenerCount（见文件头），探不到对端时只能等满一次超时。300ms 够
 * 拿到快照、又不至于让「多数回合」在这一格上有可感觉的停顿。测试用它把用例压快。
 */
export const DEFAULT_TURN_MARKER_PROBE_TIMEOUT_MS = 300;
export const TURN_MARKER_PROBE_TIMEOUT_MS = (() => {
	const raw = (process.env.PI_TURN_MARKER_PROBE_TIMEOUT_MS ?? "").trim();
	if (raw === "") return DEFAULT_TURN_MARKER_PROBE_TIMEOUT_MS;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_TURN_MARKER_PROBE_TIMEOUT_MS;
})();
/**
 * watchdog 提示开关（`PI_WORKING_INDICATOR_WATCHDOG=off` 关闭）。关掉后 spinner 在
 * watchdog 审查期间仍显示普通 Working，不做特殊提示。
 */
const WATCHDOG_HINT_ENABLED = (process.env.PI_WORKING_INDICATOR_WATCHDOG ?? "").toLowerCase() !== "off";
/**
 * watchdog 审查期间显示的文案（用户指定，英文，不带时长/省略号）。
 */
export const WATCHDOG_LABEL = "Subagent watchdog reviewing";
/**
 * `agent_end` 之后多久还没 settle 就认定「有东西在阻塞」并切到 watchdog 文案。
 *
 * 依据：pi-subagents 的 watchdog 在**每个改过仓库的回合**的 `agent_end` 里跑一次独立
 * 模型审查（实测 7~17s），而 pi 要等所有 `agent_end` handler 跑完才清 spinner —— 所以
 * 那段时间 spinner 一直转却没有解释。正常回合 `agent_end` → `agent_settled` 是毫秒级，
 * 2s 阈值不会误报；唯一同样会阻塞这段窗口的自动压缩，由 `session_before_compact`
 * 取消定时器兜底（见下）。`PI_WORKING_INDICATOR_WATCHDOG_DELAY_MS` 覆盖（测试用）。
 */
export const DEFAULT_WATCHDOG_DELAY_MS = 2_000;
export const WATCHDOG_DELAY_MS = (() => {
	const raw = (process.env.PI_WORKING_INDICATOR_WATCHDOG_DELAY_MS ?? "").trim();
	if (raw === "") return DEFAULT_WATCHDOG_DELAY_MS;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_WATCHDOG_DELAY_MS;
})();
/**
 * 幻彩里每种颜色持续的**帧数**（`PI_SPINNER_COLOR_HOLD`，默认 19 帧 × 80ms = 1520ms ≈ 1.5s
 * 一换色；1500ms 不是 80ms 的整数倍，取最近帧数）。解析不到 / 小于 1 时退回默认；
 * `spinner-frames.ts` 里还会再兜一次非有限值。
 */
const SPINNER_COLOR_HOLD = (() => {
	const parsed = Number.parseInt(process.env.PI_SPINNER_COLOR_HOLD ?? "", 10);
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_FRAMES_PER_COLOR;
})();
const SUMMARY_MIN_GAP = (() => {
	const parsed = Number.parseInt(process.env.PI_WORKING_SUMMARY_GAP ?? "", 10);
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MIN_GAP;
})();

/** 终端列数；拿不到（非 TTY）或异常窄时退回 80。每次刷新现读，resize 自愈。 */
function terminalWidth(): number {
	const cols = process.stdout.columns;
	return Number.isFinite(cols) && cols >= 20 ? Math.floor(cols) : 80;
}

/** 只用到 `fg` 的主题接口 —— 探针 / 单测里可以喂一个只有 `fg` 的假对象。 */
export interface WorkingMessageTheme {
	fg(color: string, text: string): string;
}

/**
 * `label-shadow.ts` 需要的颜色运算（真实现来自 pi-tui）。单独列出来是因为这些导出是**较新**的
 * pi-tui 才有的：扩展拷到别的 pi 上时，缺函数只会让影子退化成静态标签，而不是让整个扩展加载失败
 * （ESM 的静态命名导入在链接期检查，缺一个导出就整个文件加载不了 —— `theme-extra/colors.ts` 记过同一个坑）。
 */
interface ShadowColorOps {
	parseColor(value: string | number): unknown;
	mixColors(first: unknown, second: unknown, amount: number): unknown;
	foregroundAnsi(color: unknown, mode: string): string;
	rgbColor(r: number, g: number, b: number): unknown;
}

/** 从 pi-tui 的命名空间对象里组一份 ops；缺任何一个函数就返回 null（= 关掉影子动画）。 */
function shadowColorOpsFrom(tui: unknown): ShadowColorOps | null {
	const candidate = tui as Partial<ShadowColorOps> | null | undefined;
	const { parseColor, mixColors, foregroundAnsi, rgbColor } = candidate ?? {};
	if (
		typeof parseColor !== "function" ||
		typeof mixColors !== "function" ||
		typeof foregroundAnsi !== "function" ||
		typeof rgbColor !== "function"
	)
		return null;
	return { parseColor, mixColors, foregroundAnsi, rgbColor };
}

const SHADOW_COLOR_OPS = shadowColorOpsFrom(piTui);

/**
 * 组装 spinner 文案：标签（`Tools Calling` / `Editing` / …）走正文色，后面的统计段
 * （`(↓ 70 tokens · 10s)`）走 muted 灰。
 *
 * 为什么要自己上色：pi 的 `WorkingStatusIndicator` 把整条 working message 交给
 * `theme.fg("muted", message)`（非嵌入态；嵌入编辑器边框时是边框色），没有分段着色的
 * 入口，`setWorkingMessage()` 收的就是一个字符串。好在 `Theme.fg` 只重置前景色
 * （结尾是 `\x1b[39m` 而不是 `\x1b[0m`），于是「标签染 text + 统计段再染 muted」的
 * 拼接结果是稳定的：标签的重置符止于标签末尾，统计段自己带上 muted 前缀，最外层的
 * 那次 muted 只是多包了一层、渲染上无副作用。
 *
 * 统计段的 muted **必须显式写出来**，不能指望外层那次 `fg("muted")` —— 标签里的
 * `\x1b[39m` 已经把外层的前景色重置成终端默认色了，不重新上色的话那截灰会变白。
 *
 * 拿不到主题时（理论上只有非 TUI 上下文）退回纯文本：外层仍按 pi 的默认色渲染，
 * 只是标签不再是白的。
 */
export function formatWorkingMessage(
	theme: WorkingMessageTheme | undefined,
	label: string,
	stats: string | null,
): string {
	if (theme === undefined) return labelWithStats(label, stats);
	return formatStyledWorkingMessage(theme, theme.fg(LABEL_COLOR, label), stats);
}

/** 纯字符串拼接（`theme === undefined` 的降级形态）：不染色，外层按 pi 默认色渲染。 */
function labelWithStats(label: string, stats: string | null): string {
	return stats === null ? label : `${label} ${stats}`;
}

/**
 * 与 `formatWorkingMessage` 相同，但标签**已经上过色**（影子动画逐段染色后的结果）。
 *
 * 拆成两个函数是因为标签的颜色不再是「一个色」，而是一段段不同深浅的色 —— 统计段的 muted
 * 处理、分隔空格归属这些细节必须两边完全一致，所以只有「标签怎么染色」这一步不一样。
 */
function formatStyledWorkingMessage(
	theme: WorkingMessageTheme | undefined,
	styledLabel: string,
	stats: string | null,
): string {
	if (theme === undefined) return labelWithStats(styledLabel, stats);
	return stats === null ? styledLabel : `${styledLabel}${theme.fg(STATS_COLOR, ` ${stats}`)}`;
}

/**
 * 在左段（标签+统计）之后补空隙、接上右对齐的提示词摘要。放不下（终端太窄 /
 * 左段太宽 / 提示词为空）时原样返回左段 —— 摘要永远是增强，不挤掉原有信息。
 *
 * 传入的 `summaryText` 是 `input` 事件里已经压平缓存好的整段提示词（见文件头注释），
 * 这里只做布局。宽度计算用 pi-tui 的 `visibleWidth`（与渲染器折行同一套实现），布局数学在
 * `working-summary.ts`（纯函数，有单测）。gap 空格夹在两段各自的颜色重置之后、
 * 之前，不归属任何色段（空格本来就没有前景色）。
 */
function appendPromptSummary(
	theme: WorkingMessageTheme | undefined,
	left: string,
	summaryText: string | null,
): string {
	if (summaryText === null || summaryText === "") return left;
	const termWidth = terminalWidth();
	const layout = layoutPromptSummary({
		promptText: summaryText,
		leftWidth: visibleWidth(left),
		totalWidth: termWidth - SPINNER_AND_PADDING_COLUMNS,
		// 摘要段（含 `✦ `）不超过半屏，免得长提示词把左侧状态文案挤没。
		maxWidth: Math.floor(termWidth / 2),
		widthOf: visibleWidth,
		minGap: SUMMARY_MIN_GAP,
	});
	if (layout === null) return left;
	const styledSummary =
		theme === undefined
			? `${SUMMARY_MARKER} ${layout.summaryText}`
			: `${theme.fg(SUMMARY_MARKER_COLOR, SUMMARY_MARKER)}${theme.fg(STATS_COLOR, ` ${layout.summaryText}`)}`;
	return `${left}${" ".repeat(layout.gap)}${styledSummary}`;
}

/** 摘要用哪个模型：`PI_WORKING_SUMMARY_MODEL` 解析得到就用它，否则用当前会话模型。 */
function resolveSummaryModel(ctx: ExtensionContext): NonNullable<ExtensionContext["model"]> | undefined {
	if (SUMMARY_MODEL_SPEC !== "") {
		const slash = SUMMARY_MODEL_SPEC.indexOf("/");
		if (slash > 0) {
			const found = ctx.modelRegistry.find(SUMMARY_MODEL_SPEC.slice(0, slash), SUMMARY_MODEL_SPEC.slice(slash + 1));
			if (found !== undefined) return found;
		}
	}
	return ctx.model;
}

/**
 * 请求模型摘要时假定的可用宽度（列）。与渲染共用 `availableSummaryTextWidth`，只是左段
 * 宽度是估计值 —— 请求发生在 `input` 事件里，这一回合还没开始，真实左段还不存在
 * （见 `SUMMARY_LEFT_WIDTH_ESTIMATE`）。
 */
function summaryRequestBudgetWidth(): number {
	const termWidth = terminalWidth();
	return availableSummaryTextWidth({
		leftWidth: SUMMARY_LEFT_WIDTH_ESTIMATE,
		totalWidth: termWidth - SPINNER_AND_PADDING_COLUMNS,
		maxWidth: Math.floor(termWidth / 2),
		widthOf: visibleWidth,
		minGap: SUMMARY_MIN_GAP,
	});
}

/** 从消息 content 里抽纯文本（string 或 text 块数组；其它块类型丢掉）。 */
function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => (block as { type?: unknown; text?: unknown })?.type === "text")
		.map((block) => (block as { text?: unknown }).text)
		.filter((text): text is string => typeof text === "string")
		.join("\n");
}

/** 从 assistant 响应里抽文本（只走了 thinking 的空回复会得到空串 → 放弃这次摘要）。 */
function textFromAssistant(message: unknown): string {
	return textFromContent((message as { content?: unknown } | undefined)?.content);
}

/**
 * 从 session 分支里倒序取**上一条** user 文本消息（延续短语的上下文兜底，见 `input` 处理）。
 * 时序上安全：`input` 事件在消息落盘之前触发（pi 的 `prompt()` 先跑 input handlers 再追加
 * 消息），所以分支里最后一条 user 消息就是上一轮的，不会取到当前这条。工具结果是
 * `toolResult` role，按 `role === "user"` 过滤天然排除。拿不到 / stale ctx 一律返回 null ——
 * 上下文只是增强，缺了它退回现状（短语原样显示）。
 */
function previousUserPromptText(ctx: ExtensionContext): string | null {
	try {
		const branch = ctx.sessionManager?.getBranch?.() ?? [];
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index] as
				| { type?: string; message?: { role?: string; content?: unknown } }
				| undefined;
			if (entry?.type !== "message" || entry.message?.role !== "user") continue;
			const text = textFromContent(entry.message.content).trim();
			if (text !== "") return text;
		}
	} catch {
		// stale ctx / session manager 不可用：当没有上下文。
	}
	return null;
}

/** 读秒间隔。1s 足够 —— 显示精度就是秒，更密的 tick 只是白做渲染。 */
const TICK_MS = 1000;

/**
 * 时长格式化：<60s → `42s`；≥60s → `1m 23s`；≥1h → `1h 23m 32s`。
 * 分钟段在超过 1 小时后仍然保留（不折算成纯分钟），符合 `1h 23m 32s` 的形状。
 *
 * 导出是为了可测：小时档要真跑一小时才能触发，所以三个分支用单测覆盖，
 * 分钟档另外用一次真实的长任务抓帧验证（见 README）。
 */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	return `${minutes}m ${seconds}s`;
}

export default function (pi: ExtensionAPI) {
	/** 回合起始时刻；null 表示当前不在回合内（不渲染、不起定时器）。 */
	let turnStartedAt: number | null = null;
	/**
	 * 本次 run 的结局（`agent_before_settle` 记录、`agent_settled` 消费一次就清）：
	 * 结束符只在 `completed` 时画 —— ESC 打断 / 报错收尾保持现状（spinner 直接消失）。
	 */
	let turnOutcome: "completed" | "aborted" | "error" | null = null;

	/**
	 * 当前回合的用户输入**压平后**的原文（`input` 事件捕获后立刻 `flattenPrompt`
	 * 一次并缓存，见文件头注释）；null = 还没捕获到（恢复的会话自动继续等），
	 * 此时不显示摘要。刻意不存原文再每次 refresh 重算 —— refresh 每个流式 delta 都跑。
	 */
	let promptText: string | null = null;
	/**
	 * 模型压出来的一句话（异步到达；null = 还没到 / 没请求 / 请求失败）。显示时优先于
	 * `promptText`：到了就换上摘要，一直到回合结束都不会再变（每个提示词最多请求两次，
	 * 首次失败会隔几秒重试一次；回来的摘要再长也只截断、不再追问）。
	 */
	let promptSummaryText: string | null = null;
	/**
	 * 每次 `input` 递增的序号。模型回包可能比提示词换得慢（用户已经开始下一轮 / 流中
	 * steer），回包拿它对一下：不是自己那一次就丢掉，绝不把旧提示词的摘要贴到新的上面。
	 */
	let promptSeq = 0;
	/** 上一次 `input` 的原文，用来吃掉同一条消息的重复 `input` 事件（见 `input` 处理里）。 */
	let lastInputText: string | null = null;
	/** 在飞的摘要请求；`abort()` 停掉它（新提示词 / 回合结束 / 会话关掉）。 */
	let summaryAbort: AbortController | null = null;
	/**
	 * 待执行的摘要重试定时器（首次失败后延时重试一次）。`cancelSummaryRequest()` 会把它
	 * 一并清掉 —— 新提示词 / 回合结束 / 会话替换之后，那次重试已经没人要了。
	 */
	let summaryRetryTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * 上一回合的模型摘要（`agent_settled` 时从 `promptSummaryText` 留存）。延续短语
	 * （`继续` / `ok`）的摘要请求拿它当「上一任务」上下文 —— 它已经是浓缩的一句话，
	 * 正是该携带的东西。`session_shutdown` 清掉：换会话后没有延续性可言。
	 */
	let lastTurnSummary: string | null = null;

	/**
	 * 按段类型分开的 token 估算计数器：宽字符（CJK，终端占 2 列）按 1 token 计，
	 * 窄字符按 1/4 token 计（下方 `wide` 从 pi-tui 的 `visibleWidth` 反推，不是自己维护码点表）。
	 *
	 * 以前这个口径与 `tool-diff.ts` 的 `estimateTokens` 共用 —— 那边标题行后来改成显示
	 * `(+N -M)` 行数而不是 token 数，函数已经删掉，所以估算只留这里一份。
	 *
	 * 每段各自一份、段开始时清零，所以显示出来的数永远是「当前这一小段」的量。
	 * 分开存而不是共用一个累加值，还有一个原因：工具执行期间上游可能还在推 reasoning 帧，
	 * 共用一个累加值会把推理字符算进 bash 命令的数里。
	 *
	 * 这里做**增量累加**而不是每秒重算整串：宽/窄字符数是可加的，所以
	 * 逐 delta 累加与对完整文本一次性计算等价，但代价从 O(全文) 降到 O(delta)。
	 *
	 * 正文段（text）不在表里：它的 token 数从不显示，累加只会污染其它段。
	 */
	type CounterKind = "thinking" | "toolcall";
	const counters: Record<CounterKind, { wide: number; narrow: number }> = {
		thinking: { wide: 0, narrow: 0 },
		toolcall: { wide: 0, narrow: 0 },
	};

	/** 新一小段开始：该段的计数器清零，从头重新数。 */
	function resetCounter(kind: CounterKind): void {
		counters[kind].wide = 0;
		counters[kind].narrow = 0;
	}

	/** 逐 delta 累加宽/窄字符数到对应段。 */
	function accumulate(kind: CounterKind, text: string): void {
		if (text === "") return;
		const points = [...text].length; // 按码点计，代理对不会算成 2 个字符
		const wide = Math.max(0, visibleWidth(text) - points);
		counters[kind].wide += wide;
		counters[kind].narrow += Math.max(0, points - wide);
	}

	function tokenEstimate(kind: CounterKind): number {
		const counter = counters[kind];
		return Math.ceil(counter.wide + counter.narrow / 4);
	}

	/**
	 * 正在执行的工具：`toolCallId → 工具名`（`tool_execution_start` 落账、`_end` 销账）。
	 * 一个批次里可能**并行**执行多个工具（pi 的 parallel tool mode），只留一个字符串会在
	 * 先结束的那个上把名字清掉 —— 长 bash 还在跑、文案却掉回 `Working`，行尾的 `●` 就挂在
	 * 了错的标签后面。标签取**最后启动**的那个（沿用原语义：执行态压过推理态，看启动序）。
	 */
	const executingTools = new Map<string, string>();

	/** 最后启动且仍在执行的工具名；没有则 null。 */
	function executingToolName(): string | null {
		let name: string | null = null;
		for (const toolName of executingTools.values()) name = toolName;
		return name;
	}

	/**
	 * 并发 bash 执行的登记簿（见 `bash-spinner.ts`）：门槛 / 粘性 / 消失条件都在它里面，
	 * 这里只管「什么时候闪」的定时器。
	 */
	const bashRuns = new BashRunTracker();
	/** 标记的亮 / 灭相位（`bashSpinnerSuffix` 用它出两态）。 */
	let bashSpinOn = false;
	let bashBlinkTimer: ReturnType<typeof setInterval> | null = null;
	let bashArmTimer: ReturnType<typeof setTimeout> | null = null;
	/** 参数正在流式生成的工具（`toolcall_start` → `toolcall_end`）。 */
	let streamingTool: string | null = null;
	/** 是否处于推理段（`thinking_start` → `thinking_end`）。 */
	let thinking = false;

	let timer: ReturnType<typeof setInterval> | null = null;
	let ctxRef: ExtensionContext | null = null;
	let lastMessage: string | null = null;
	/**
	 * 标签扫光的「下一帧」定时器（见 `label-shadow.ts`）：一次性、按算出来的列宽自排程，
	 * 静止段里就排一个「下一趟开始」的长定时器 —— 不做固定频率的 interval（静止的 2/3 时间里
	 * 一次重绘都不该发）。
	 */
	let shadowTimer: ReturnType<typeof setTimeout> | null = null;
	/** 已经排上的那一帧到点的绝对时刻（`shadowTimer === null` 时为 null）。 */
	let shadowDueAt = 0;
	/**
	 * 弹窗（`ui_prompt_start` → `ui_prompt_end`）期间为 true：所有定时器暂停、spinner 冻结成
	 * 单帧，`refresh()` 早退。目的：pi 的主屏渲染每次重绘都把视口钉在底部，弹窗期间任何
	 * 周期性重绘（Loader 的 80ms 动画、本扩展的 1s 读秒）都会把用户手动上翻的滚动位置立刻
	 * 拉回去 —— 长内容弹窗（plan-mode 批准框）因此看不全。冻结后终端自己的回滚不再被抢。
	 */
	let uiPromptActive = false;
	/**
	 * watchdog 审查提示是否正在显示。`agent_end` 后 `WATCHDOG_DELAY_MS` 还没 settle 就置
	 * true（refresh 把文案切成 WATCHDOG_LABEL）；`agent_settled` / `agent_before_settle` /
	 * `session_before_compact` / `agent_start` / `session_shutdown` 任一到就复位。
	 */
	let watchdogActive = false;
	let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * 上一次装上去的色板指纹（`spinner-frames.ts` 的 `signature`）：`refresh()` 每秒拿当前主题
	 * 现算一次，指纹变了才重装帧表 —— `/theme` 换肤后一秒内自愈，且相位只在真的换色时复位。
	 */
	let spinnerSignature: string | null = null;

	/**
	 * 当前该显示哪个文案，以及该配哪一段的 token 计数；返回 null 表示回落到
	 * Working（无 token 段）。
	 *
	 * 优先级：正在执行 > 参数流式中 > 推理中。执行态压过推理态是有意的 ——
	 * 工具执行期间上游可能还在推 reasoning 帧，但用户关心的是"命令在跑"。
	 * 未列进 TOOL_LABELS 的工具直接回落 Working，不再往下走推理态（沿用原语义）。
	 */
	function currentActivity(): { label: string; counter: CounterKind } | null {
		const executing = executingToolName();
		if (executing !== null) {
			const label = TOOL_LABELS[executing];
			return label === undefined ? null : { label, counter: "toolcall" };
		}
		if (streamingTool !== null) {
			const label = TOOL_LABELS[streamingTool];
			return label === undefined ? null : { label, counter: "toolcall" };
		}
		if (thinking) return { label: THINKING_LABEL, counter: "thinking" };
		return null;
	}

	/** 当前文案拆成「标签」与「统计段」两截 —— 两截颜色不同，得分开上色。 */
	function buildParts(now: number): { label: string; stats: string | null } {
		const duration = formatDuration(now - (turnStartedAt ?? now));
		const activity = currentActivity();
		if (activity === null) return { label: DEFAULT_LABEL, stats: `(${duration})` };
		return {
			label: activity.label,
			stats: `(↓ ${tokenEstimate(activity.counter)} tokens · ${duration})`,
		};
	}

	/** 当前主题下的幻彩色板（现算；`theme.fg` 是 live proxy，换肤后同一调用就能拿到新色）。 */
	function spinnerPalette(ctx: ExtensionContext): SpinnerPalette {
		return buildSpinnerPalette((token, text) => ctx.ui.theme.fg(token, text), {
			framesPerColor: SPINNER_COLOR_HOLD,
		});
	}

	/**
	 * 把色板装到 pi 上（不判重、不兜异常）。`frames === null`（当前主题挑不出两种可区分的颜色）
	 * 时退回 pi 默认帧。
	 */
	function applySpinnerPalette(ctx: ExtensionContext, palette: SpinnerPalette): void {
		spinnerSignature = palette.signature;
		if (palette.frames === null) {
			ctx.ui.setWorkingIndicator();
			return;
		}
		ctx.ui.setWorkingIndicator({ frames: palette.frames, intervalMs: SPINNER_INTERVAL_MS });
	}

	/**
	 * 无条件装幻彩帧表。失败静默：调用点都是「旧 ctx 也不该掀翻宿主」的位置（`agent_start` /
	 * `tool_execution_end`）—— 旧 ctx 会抛 `This extension ctx is stale…`，那种情况下什么都没必要做。
	 */
	function installRainbowSpinner(ctx: ExtensionContext): void {
		if (!SPINNER_RAINBOW_ENABLED) return;
		try {
			applySpinnerPalette(ctx, spinnerPalette(ctx));
		} catch {
			// 旧 ctx：不去碰 UI。
		}
	}

	/**
	 * 只在主题指纹变了时重装（`refresh()` 每秒调一次）。重装会把动画相位复位，所以不能无脑调 ——
	 * 换肤那一瞬间本来就要全屏重绘，那一下复位看不见。
	 */
	function syncRainbowSpinner(ctx: ExtensionContext): void {
		if (!SPINNER_RAINBOW_ENABLED) return;
		const palette = spinnerPalette(ctx);
		if (palette.signature === spinnerSignature) return;
		applySpinnerPalette(ctx, palette);
	}

	/**
	 * 把当前标签上好色：开了扫光、这个状态不在排除名单里、且主题色解析得出来时逐段压暗，
	 * 否则就是原来那一整段纯色。`label` 未染色（纯文本），返回的字符串带完整 ANSI。
	 *
	 * 被排除的状态返回 `nextChangeMs: null` ⇒ 不排扫光定时器，这段时间一帧都不多画。
	 * 回到有扫光的状态时，位置由回合时钟现算（见 `label-shadow.ts` 的 `shadowColumnAt`），
	 * 所以退出 `Thinking` 之后影子接着当前相位走，不会为了「补上漏掉的那几趟」而连扫。
	 */
	function paintWorkingLabel(
		ctx: ExtensionContext,
		label: string,
		now: number,
	): { styled: string; nextChangeMs: number | null } {
		const plainLabel = (): { styled: string; nextChangeMs: null } => ({
			styled: ctx.ui.theme.fg(LABEL_COLOR, label),
			nextChangeMs: null,
		});
		if (!LABEL_SHADOW_ENABLED || SHADOW_EXCLUDED_LABELS.has(label)) return plainLabel();
		const paint = createShadowPaint(ctx.ui.theme);
		if (paint === null) return plainLabel();
		// 宽度用 pi-tui 的 `visibleWidth`（与折行/摘要同一套实现），所以宽字符也按整格算。
		const schedule = shadowSchedule(now - (turnStartedAt ?? now), labelWidth(label, visibleWidth), SHADOW_TIMING);
		const segments = shadowSegments(label, schedule, SHADOW_TIMING, visibleWidth);
		return { styled: paintLabel(label, segments, paint), nextChangeMs: schedule.nextChangeMs };
	}

	/**
	 * 刷新文案。只在字符串真的变了时才调 `setWorkingMessage`，避免每秒无谓重渲染。
	 *
	 * `ctx.ui` 的读取（取主题、写文案）包在 try/catch 里：会话被替换或 `/reload` 之后，
	 * 旧 ctx 会抛 `This extension ctx is stale after session replacement or reload`，
	 * 而这个异常发生在**读 `ctx.ui` 这一步**（比组件 render 更早），漏网的定时器回调
	 * 足以掀翻宿主进程 —— recap / simple-task 都踩过同一个坑。
	 *
	 * 主题每次现读（`/theme` 换主题后一秒内自愈），刻意不订阅主题变更事件。
	 */
	function refresh(): void {
		// 弹窗期间不碰 UI：定时器已停，但 tool_execution_start 等事件路径仍可能调到这里。
		if (uiPromptActive) return;
		const ctx = ctxRef;
		if (ctx === null || turnStartedAt === null) {
			stopBashSpinner();
			return;
		}
		let message: string;
		let shadowNextChange: number | null = null;
		// 不带扫光的标签（watchdog）不参与影子动画，也不排下一帧。
		let animated = false;
		try {
			const now = Date.now();
			// watchdog 审查中：只显示固定文案，不拼 token/时长，也不跑 bash spinner。
			// 用户指定文案就是全部，加时长反而暗示「还要很久」。
			if (watchdogActive) {
				message = formatWorkingMessage(ctx.ui.theme, WATCHDOG_LABEL, null);
				if (message !== lastMessage) {
					lastMessage = message;
					try {
						ctx.ui.setWorkingMessage(message);
					} catch {
						stopActivity();
					}
				}
				return;
			}
			driveBashSpinner(now);
			const parts = buildParts(now);
			const painted = paintWorkingLabel(ctx, parts.label, now);
			shadowNextChange = painted.nextChangeMs;
			animated = true;
			let left = formatStyledWorkingMessage(ctx.ui.theme, painted.styled, parts.stats);
			left += bashSpinnerText(ctx.ui.theme);
			// 模型摘要到达后顶掉原文；没到 / 失败就是截断后的原文。
			const summarySource = promptSummaryText ?? promptText;
			message = SUMMARY_ENABLED ? appendPromptSummary(ctx.ui.theme, left, summarySource) : left;
			// 主题指纹变了就重装幻彩帧表（换肤后一秒内自愈）；指纹没变这里什么都不做。
			syncRainbowSpinner(ctx);
		} catch {
			// 旧 ctx：停掉定时器，别再拿它去碰 UI。
			stopActivity();
			return;
		}
		if (message === lastMessage) {
			// 文字没变（比如扫光落在强度全 0 的尾部、或 1s 读秒还没跳），但影子下一位可能已经要变：
			// 照样把下一帧排上，不然动画会靠每秒的 tick 才动一下。
			if (animated) armShadowFrame(shadowNextChange);
			return;
		}
		lastMessage = message;
		try {
			ctx.ui.setWorkingMessage(message);
		} catch {
			stopActivity();
			return;
		}
		if (animated) armShadowFrame(shadowNextChange);
	}

	/**
	 * 排扫光的下一帧（一次性定时器，自排程）。`null`（未开动画 / 解不出色值）或弹窗中不排；
	 * 已经在排的那个先清掉 —— 每次 `refresh()` 算出的都是「从现在算起」的最新延时，
	 * 多留着旧的那个只会多打一次无用重绘。
	 */
	function armShadowFrame(nextChangeMs: number | null): void {
		if (nextChangeMs === null || uiPromptActive || ctxRef === null || turnStartedAt === null) {
			stopShadowTimer();
			return;
		}
		const dueAt = Date.now() + Math.max(1, nextChangeMs);
		// 流式期间 `message_update` 每秒几十次调 `refresh()`：每次都重排会让定时器不停被推倒重建。
		// 算出来的到点时刻与已排的那个相差不到 5ms 就当同一帧，不动它。
		if (shadowTimer !== null && Math.abs(dueAt - shadowDueAt) < 5) return;
		stopShadowTimer();
		shadowDueAt = dueAt;
		shadowTimer = setTimeout(() => {
			shadowTimer = null;
			refresh();
		}, Math.max(1, nextChangeMs));
		// unref：动画不许把进程吊住。
		shadowTimer.unref?.();
	}

	function startTimer(ctx: ExtensionContext): void {
		stopTimer();
		ctxRef = ctx;
		timer = setInterval(refresh, TICK_MS);
		// unref：读秒定时器不该把进程吊住（退出时不必等它）。
		timer.unref?.();
	}

	function stopTimer(): void {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
		stopShadowTimer();
		ctxRef = null;
	}

	/** 停掉扫光的下一帧（幂等）。弹窗 / 回合结束 / 旧 ctx 三处都调它。 */
	function stopShadowTimer(): void {
		if (shadowTimer !== null) {
			clearTimeout(shadowTimer);
			shadowTimer = null;
		}
		shadowDueAt = 0;
	}

	/**
	 * 弹窗开始：停掉本扩展的三个定时器，并把 spinner 冻结成单帧。
	 *
	 * 冻结单帧是这里**最关键**的一步：pi 的 working indicator 是 pi-tui 的 `Loader`，它自带
	 * 一个 80ms 的帧动画定时器，每帧都 `requestRender()` —— 比本扩展 1s 的读秒快 12.5 倍，
	 * 是把视口钉回底部的主因。`Loader.restartAnimation()` 遇 `frames.length <= 1` 直接返回，
	 * 所以装一个单帧就能停掉那个 interval（`ask-user-question` 扩展用的是同一手法）。
	 *
	 * 不用 `stopTimer()`：它会把 `ctxRef` 置 null，弹窗结束就没法恢复了。
	 */
	function pauseForUiPrompt(ctx: ExtensionContext): void {
		if (uiPromptActive) return;
		uiPromptActive = true;
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
		stopShadowTimer();
		stopBashSpinner();
		try {
			ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", FROZEN_SPINNER_FRAME)] });
		} catch {
			// 旧 ctx / 宿主不支持：冻结失败不影响正确性，只是弹窗期间仍会重绘
		}
	}

	/**
	 * 弹窗结束：重装幻彩帧表（`installRainbowSpinner` 无条件装，正好覆盖掉冻结帧）、
	 * 重启读秒定时器、立即刷一次文案（把弹窗期间走过的秒数补上）。
	 *
	 * 只在真的处于回合中（`ctxRef` 与 `turnStartedAt` 都在）时重启定时器 —— 弹窗可能
	 * 发生在回合外（比如 `/plan` 命令弹的确认框），那时不该凭空起一个读秒。
	 */
	function resumeAfterUiPrompt(): void {
		if (!uiPromptActive) return;
		uiPromptActive = false;
		const ctx = ctxRef;
		if (ctx === null) return;
		// 恢复帧表：幻彩开着就重装彩帧（无条件装，正好覆盖掉冻结帧）；关着就回到 pi 默认帧，
		// 否则单帧冻结会卡住。
		if (SPINNER_RAINBOW_ENABLED) installRainbowSpinner(ctx);
		else {
			try {
				ctx.ui.setWorkingIndicator();
			} catch {
				// 旧 ctx：不碰 UI
			}
		}
		if (turnStartedAt !== null && timer === null) {
			timer = setInterval(refresh, TICK_MS);
			timer.unref?.();
		}
		refresh();
	}

	/** 停掉 `●` 的节拍 / 排程定时器并回到灭态（幂等）。 */
	function stopBashSpinner(): void {
		if (bashBlinkTimer !== null) {
			clearInterval(bashBlinkTimer);
			bashBlinkTimer = null;
		}
		if (bashArmTimer !== null) {
			clearTimeout(bashArmTimer);
			bashArmTimer = null;
		}
		bashSpinOn = false;
	}

	/**
	 * 亮灭节拍：`●` 亮起后每 500ms 翻相位 + 重绘（与 tool-diff 的 `edit` / `write` 同节拍）。
	 * 幂等：已在闪就不动（相位不重置，多 bash 并发时节拍连续）。
	 */
	function startBashBlink(): void {
		if (bashBlinkTimer !== null) return;
		bashSpinOn = true; // 首次亮相：到门槛那一刻就是亮的，不留 500ms 空窗
		bashBlinkTimer = setInterval(() => {
			bashSpinOn = !bashSpinOn;
			refresh();
		}, BASH_SPINNER_BLINK_MS);
		bashBlinkTimer.unref?.();
	}

	/**
	 * 门槛未到：起一次性定时器，到点重绘一次让 `●` **准时**出现（否则要等下一次别的重绘 ——
	 * 非流式命令执行期间可能一个上游事件都没有）。幂等（已有排程 / 已在闪都直接返回）。
	 */
	function armBashSpinner(delayMs: number): void {
		if (bashArmTimer !== null || bashBlinkTimer !== null) return;
		bashArmTimer = setTimeout(() => {
			bashArmTimer = null;
			refresh();
		}, Math.max(0, delayMs));
		bashArmTimer.unref?.();
	}

	/**
	 * 「这一批 bash 有没有谁跨过门槛」+ 定时器驱动，每次 refresh 都跑一遍。
	 * 已跨过 → 停排程、起节拍；还没跨过 → 按最早截止点排一次性定时器；没有执行 / 开关关了
	 * → 全部停掉。
	 */
	function driveBashSpinner(now: number): void {
		if (!BASH_SPINNER_ENABLED || bashRuns.size === 0) {
			stopBashSpinner();
			return;
		}
		if (bashRuns.markCrossed(now)) {
			if (bashArmTimer !== null) {
				clearTimeout(bashArmTimer);
				bashArmTimer = null;
			}
			startBashBlink();
			return;
		}
		const delay = bashRuns.armDelay(now);
		if (delay !== null) armBashSpinner(delay);
	}

	/**
	 * 行尾标记段（含前导空格，**恒 2 列**；不显示时是空串）。上色在这里做：`Theme.fg`
	 * 只重置前景色，拼在左段末尾不影响前面已有的色段。
	 */
	function bashSpinnerText(theme: WorkingMessageTheme | undefined): string {
		if (!BASH_SPINNER_ENABLED || !bashRuns.shown) return "";
		const text = bashSpinnerSuffix(bashSpinOn);
		return theme === undefined ? text : theme.fg(BASH_SPINNER_COLOR, text);
	}

	/**
	 * 回合结束符：写一条会话条目（形状 / 词表 / 条目契约见 `turn-marker.ts`）。
	 *
	 * 为什么是会话条目而不是 working message / widget（用户 2026-10-26 定）：
	 *   - working message 走不通 —— pi 在应用层 `agent_end` 就 `clearStatusIndicator("working")`，
	 *     `setWorkingMessage` / `setWorkingVisible` 只在流式期间有效，扩展没有让 statusContainer
	 *     在回合外继续渲染的接口。
	 *   - 旧的 widget 方案能留在编辑器上方，但它占的是**那一格**：下一回合的 `agent_start`
	 *     必须把它清掉（不清就盖在活 spinner 上）⇒ 用户一敲下一句，上一回合的结束符就消失。
	 *     用户要的正好相反：这行属于对话流，应该留在历史里。
	 *   - `type: "custom"` 的会话条目不进模型上下文（pi 的 `convertToLlm` 直接丢弃），所以
	 *     零 token 成本；它是真历史，往上滚 / `/resume` / 重开都还在。
	 *
	 * 只写文本，不写颜色：渲染器拿 `theme` 的 live proxy 上色，`/theme` 换肤后重绘就自愈
	 * （把转义序列烘进条目的话，历史颜色会永远钉在旧皮肤上）。
	 *
	 * 无 UI（`pi -p` / json / rpc）不写：结束符是屏幕装饰，那些模式里没人画它，写进去只会
	 * 让会话日志多出无意义的条目（旧 widget 方案同样靠 `ctx.hasUI` 挡住）。
	 *
	 * 包 try/catch：`pi.appendEntry` 在 stale 运行时（会话被替换 / `/reload`）会抛，而结束符
	 * 只是装饰 —— 抛了就当没写，不能把回合收尾弄挂。
	 */
	function writeTurnMarker(ctx: ExtensionContext, text: string): void {
		try {
			if (!ctx.hasUI) return;
			pi.appendEntry<{ text: string }>(TURN_MARKER_ENTRY_TYPE, { text });
		} catch {
			// stale runtime / 宿主不支持：静默跳过。
		}
	}

	/**
	 * 结束符条目的渲染器。
	 *
	 * pi 会在**加载时**注册它、在会话回放 / 实时追加时按 `customType` 调它，所以它必须是无状态
	 * 纯函数：只读 `entry.data.text`，不碰本扩展的闭包状态（回放历史条目时那些状态早就没了）。
	 *
	 * 形状不对 / 不是本扩展的条目 → 返回 `undefined`（不画，也不报错）。
	 *
	 * 宽度拿 `truncateToWidth` 裁一行：结束符恒单行，窄终端下宁可截断也不折行（折行会让下面
	 * 那条前导空行看上去像两条）。
	 */
	if (TURN_MARKER_ENABLED) {
		pi.registerEntryRenderer<{ text?: unknown }>(TURN_MARKER_ENTRY_TYPE, (entry, _options, theme) => {
			const text = turnMarkerTextFromEntry(entry);
			if (text === null) return undefined;
			return {
				render: (width: number) => [
					truncateToWidth(`${TURN_MARKER_INDENT}${theme.fg(TURN_MARKER_COLOR, text)}`, width, ""),
				],
				invalidate() {},
			};
		});
	}

	/**
	 * 现在还有子代理在跑吗（探针细节见文件头）。
	 *
	 * 两层 fail-open：`hasActiveSubagentWork` 自己不抛（探不到就 false），这里再包一层
	 * try/catch 兜住「事件总线本身坏了」—— 探测是结束符的修饰，不该因为它把回合收尾弄挂。
	 */
	async function subagentsBusy(): Promise<boolean> {
		try {
			return await hasActiveSubagentWork(pi.events, { timeoutMs: TURN_MARKER_PROBE_TIMEOUT_MS });
		} catch {
			return false;
		}
	}

	/** 旧 ctx（会话被替换 / `/reload`）：停掉所有定时器、清掉账本，别再拿它去碰 UI。 */
	function stopActivity(): void {
		stopTimer();
		stopBashSpinner();
		bashRuns.clear();
		cancelSummaryRequest();
		clearWatchdogHint();
	}

	/** 取消待触发的 watchdog 定时器并复位标志（幂等）。 */
	function clearWatchdogHint(): void {
		if (watchdogTimer !== null) {
			clearTimeout(watchdogTimer);
			watchdogTimer = null;
		}
		watchdogActive = false;
	}

	/**
	 * `agent_end` 后起一个一次性定时器：到点还没 settle 就认定 watchdog（或其他阻塞）
	 * 正在跑，把文案切成 WATCHDOG_LABEL。定时器 unref，不吊住进程退出。
	 */
	function armWatchdogHint(): void {
		if (!WATCHDOG_HINT_ENABLED) return;
		clearWatchdogHint();
		watchdogTimer = setTimeout(() => {
			watchdogTimer = null;
			// 到点时回合必须还在（turnStartedAt 非空）才显示；settled 会先清掉它。
			if (turnStartedAt === null) return;
			watchdogActive = true;
			refresh();
		}, WATCHDOG_DELAY_MS);
		watchdogTimer.unref?.();
	}

	/** 从 `toolcall_start` 的 partial 里取工具名。 */
	function toolNameFromPartial(event: { contentIndex?: number; partial?: unknown }): string | null {
		const partial = event.partial as { content?: unknown[] } | undefined;
		const index = event.contentIndex;
		if (!Array.isArray(partial?.content) || typeof index !== "number") return null;
		const block = partial.content[index] as { name?: unknown } | undefined;
		return typeof block?.name === "string" ? block.name : null;
	}

	/** 停掉在飞的摘要请求与待重试的那次（幂等）。它们只是附带请求，停了也不会影响主任务。 */
	function cancelSummaryRequest(): void {
		if (summaryRetryTimer !== null) {
			clearTimeout(summaryRetryTimer);
			summaryRetryTimer = null;
		}
		if (summaryAbort !== null) {
			summaryAbort.abort();
			summaryAbort = null;
		}
	}

	/**
	 * 提示词太长时**异步**让模型压一句话（决策 / 提示词 / 清洗都在 `summary-request.ts`）。
	 * 发出去就返回，不 `await`：主回合跟这个请求完全并行，请求慢 / 失败只意味着这一格继续
	 * 显示截断后的原文。回包三重护栏：abort 过的、序号换了的、提示词已经清掉的（回合结束）
	 * 一律丢弃。
	 *
	 * 首次失败（报错 / 45s 超时 / 只出了 thinking 没出正文）会隔 `SUMMARY_RETRY_DELAY_MS`
	 * 自动重试**一次**（`attempt`），第二次仍失败就彻底放弃。重试前要再确认这次请求
	 * 仍然有效：新提示词 / 回合结束 / 会话替换都会经过 `cancelSummaryRequest()`（清掉待
	 * 重试的定时器、把 `summaryAbort` 置空），`retryLater` 靠 `summaryAbort === controller`
	 * 认出「已被取消」并放弃 —— 45s 超时虽然也 abort，但不碰 `summaryAbort`，所以那算
	 * 失败、照常重试。
	 */
	function requestPromptSummary(
		ctx: ExtensionContext,
		prompt: string,
		seq: number,
		attempt = 0,
		continuationContext?: string,
	): void {
		if (ctx.mode !== "tui") return; // print / json / rpc 没有 working 行，白花请求。
		const model = resolveSummaryModel(ctx);
		if (model === undefined) return;

		// 延续短语（`continuationContext` 非 undefined）宽度上放得下、但语义上值得压：
		// 绕过宽度触发线，直接拿上一任务 + 短语去要一句融合后的标签。普通提示词仍走
		// 「放不下才请求」的原判定。
		let requestPromptText: string;
		if (continuationContext !== undefined) {
			const targetWidth = Math.max(1, Math.floor(summaryRequestBudgetWidth() * TARGET_WIDTH_RATIO));
			requestPromptText = buildContinuationSummaryPrompt(prompt, continuationContext, targetWidth);
		} else {
			const plan = planSummaryRequest({
				promptWidth: visibleWidth(prompt),
				budgetWidth: summaryRequestBudgetWidth(),
				triggerRatio: SUMMARY_TRIGGER_RATIO,
			});
			if (!plan.needed) return;
			requestPromptText = buildSummaryRequestPrompt(prompt, plan.targetWidth);
		}

		const controller = new AbortController();
		summaryAbort = controller;
		const timeout = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
		timeout.unref?.();

		/** 这次算失败：还有额度就排一次重试（已被取消 / 提示词换了 / 回合结束了就不排）。 */
		const retryLater = (): void => {
			if (attempt + 1 >= SUMMARY_MAX_ATTEMPTS) return;
			if (summaryAbort !== controller) return;
			if (seq !== promptSeq || promptText === null) return;
			summaryRetryTimer = setTimeout(() => {
				summaryRetryTimer = null;
				requestPromptSummary(ctx, prompt, seq, attempt + 1, continuationContext);
			}, SUMMARY_RETRY_DELAY_MS);
			summaryRetryTimer.unref?.();
		};

		void (async () => {
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				// 取不到 key：3 秒后也不会变好，不重试；已取消（极端情况下是超时）同样直接退出。
				if (!auth.ok || controller.signal.aborted) return;
				const response = await ctx.modelRegistry.complete(
					model,
					{
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: requestPromptText }],
								timestamp: Date.now(),
							},
						],
					},
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						signal: controller.signal,
						maxTokens: SUMMARY_MAX_TOKENS,
						// 刻意**不**传 temperature：0 会让这些 max 档路由退化成停不下来的长思考（见
						// `SUMMARY_MAX_TOKENS` 注释），默认温度反而稳。
						cacheRetention: "none",
					},
				);
				if (controller.signal.aborted || seq !== promptSeq || promptText === null) return;
				const text = cleanSummaryText(textFromAssistant(response));
				if (text === "") {
					// 只出了 thinking / 只回了装饰（清洗后空）：当成失败，值得再要一次。
					retryLater();
					return;
				}
				promptSummaryText = text;
				refresh();
			} catch {
				// 超时 / 中断 / 网络错误 / 模型不可用：延时重试一次；第二次仍失败就一直显示
				// 截断后的原文（摘要只是增强，不打扰主回合）。
				retryLater();
			} finally {
				clearTimeout(timeout);
				if (summaryAbort === controller) summaryAbort = null;
			}
		})().catch(() => {});
	}

	pi.on("input", async (event, ctx) => {
		// 在 agent 处理前触发：普通消息是用户原文，skill/模板命令是展开前的原始
		// 命令行，扩展命令的 sendUserMessage 也会再触发一次（source=extension）。
		// 流式中的 steer / followUp 同样走这里，摘要随之更新成最新指令。
		// 压平在这里算一次并缓存（refresh 每个 delta 都跑，不能每次重扫整段）。
		//
		// 同一条文本重复触发时直接复用：扩展命令的 sendUserMessage 会让同一条消息
		// 走两次 `input`，第二次不该把在飞的摘要请求作废重来。
		if (event.text === lastInputText) return;
		lastInputText = event.text;
		promptSeq += 1;
		cancelSummaryRequest();
		promptSummaryText = null;
		promptText = SUMMARY_ENABLED ? flattenPrompt(event.text) : null;
		if (SUMMARY_LLM_ENABLED && promptText !== null && promptText !== "") {
			// 延续短语（`继续` / `ok` / `go ahead` …）单独看没有任务语义：带上上一任务的
			// 上下文（上一回合的摘要优先，没有则退回分支里上一条 user 消息）让模型融合成
			// 一句。上下文两者都拿不到时退回现状（短语原样显示，不发请求）。
			const continuationContext =
				SUMMARY_CONTINUATION_ENABLED && isContinuationPhrase(event.text)
					? lastTurnSummary ?? previousUserPromptText(ctx)
					: undefined;
			if (continuationContext !== null) {
				requestPromptSummary(ctx, promptText, promptSeq, 0, continuationContext);
			}
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		turnStartedAt = Date.now();
		turnOutcome = null;
		resetCounter("thinking");
		resetCounter("toolcall");
		executingTools.clear();
		bashRuns.clear();
		stopBashSpinner();
		streamingTool = null;
		thinking = false;
		lastMessage = null;
		clearWatchdogHint();
		// print / json 模式没有 working loader 行，起定时器只是白跑。
		if (ctx.hasUI) {
			// 回合开始时装帧表：此刻 spinner 还没渲染（流式开始才出现），相位复位看不见；
			// 换会话后 pi 的 resetExtensionUI() 会把 indicator 还原成默认帧，这里一并补回来。
			installRainbowSpinner(ctx);
			startTimer(ctx);
			refresh();
		}
	});

	pi.on("message_update", async (event) => {
		const streamEvent = event.assistantMessageEvent as
			| { type?: string; delta?: string; contentIndex?: number; partial?: unknown }
			| undefined;
		switch (streamEvent?.type) {
			// 三个 *_start 都是一小段的起点：该段计数器清零，从头重新数。
			case "thinking_start":
				thinking = true;
				resetCounter("thinking");
				break;
			case "thinking_end":
				thinking = false;
				break;
			// 文本段开始 = 推理段结束（正常顺序里 thinking_end 会先到，这里是兜底）。
			// text_delta 本身不计数，所以 text_start 不需要重置任何计数器。
			case "text_start":
				thinking = false;
				break;
			case "toolcall_start": {
				const name = toolNameFromPartial(streamEvent as { contentIndex?: number; partial?: unknown });
				if (name !== null) streamingTool = name;
				resetCounter("toolcall");
				break;
			}
			case "toolcall_end":
				streamingTool = null;
				// 刻意不清零 toolcall 计数器：`tool_execution_start` 紧接着就到，执行期间
				// 显示的仍然是这条命令的量；清零会让整个执行期显示 `↓ 0 tokens`。
				break;
			// delta 按自己的类型归到对应段，于是推理帧不会算进工具命令的数里。
			case "thinking_delta":
				accumulate("thinking", typeof streamEvent.delta === "string" ? streamEvent.delta : "");
				break;
			case "toolcall_delta":
				accumulate("toolcall", typeof streamEvent.delta === "string" ? streamEvent.delta : "");
				break;
			// text_delta 刻意不计：正文段的 token 数从不显示，累加只会污染后面几段的数。
		}
		refresh();
	});

	pi.on("tool_execution_start", async (event) => {
		executingTools.set(event.toolCallId, event.toolName);
		if (event.toolName === "bash") bashRuns.start(event.toolCallId, Date.now());
		// 参数流式阶段可能没拿到名字（partial 缺块），执行态是权威来源，这里补上。
		streamingTool = null;
		refresh();
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		executingTools.delete(event.toolCallId);
		bashRuns.end(event.toolCallId);
		// 问卷退出时会把 indicator 恢复成 pi 的默认帧（它不知道本扩展的彩帧），这里补装回去。
		if (event.toolName === ASK_USER_QUESTION_TOOL) installRainbowSpinner(ctx);
		refresh();
	});

	/**
	 * `agent_end`：所有扩展的 agent_end handler 会被 pi 依次 await，跑完才发应用层
	 * agent_end（TUI 在那里清 spinner）。pi-subagents 的 watchdog 就在这个 handler 里
	 * 阻塞 7~17s 跑审查模型 —— 于是 spinner 一直转却没解释。这里起一个一次性定时器：
	 * 到点还没 settle 就把文案切成 watchdog 提示（见 armWatchdogHint）。
	 */
	pi.on("agent_end", async () => {
		armWatchdogHint();
	});

	/**
	 * 压缩与 `/goal` 评估都发生在应用层 agent_end（spinner 已被 pi 清掉）**之后**、
	 * agent_settled 之前。watchdog 阶段在那之前就已经结束，所以这两个事件一到就复位
	 * 提示，避免把压缩 / verify-loop 的 `/goal` 评估误标成 watchdog。
	 */
	pi.on("session_before_compact", async () => {
		clearWatchdogHint();
	});
	pi.on("agent_before_settle", async (event) => {
		// 结局只有这里能拿到（`agent_settled` 不带载荷），结束符按它决定写不写。
		turnOutcome = event.outcome;
		clearWatchdogHint();
	});

	/**
	 * `agent_settled` 才是回合真正结束（`agent_end` 之后还可能自动重试、自动压缩
	 * 或继续排队的后续消息 —— 那些阶段 spinner 仍在转，所以不能提前停表）。
	 */
	pi.on("agent_settled", async (_event, ctx) => {
		// 结束符要用回合时长与结局，两者都得在清状态之前取出来。
		const settledAt = Date.now();
		const startedAt = turnStartedAt;
		const completed = turnOutcome === "completed";
		// 留存本回合的摘要给下一回合的延续短语用（`继续` 这类输入要带上「上一任务」才
		// 有语义）。摘要没算成（短提示词 / 请求失败）就不动旧值 —— 宁可延续到更早的任务，
		// 也不清空。回合被打断同样留存：下一句 `继续` 续的就是被打断的那件事。
		if (promptSummaryText !== null) lastTurnSummary = promptSummaryText;
		stopActivity();
		turnStartedAt = null;
		turnOutcome = null;
		lastMessage = null;
		promptText = null;
		promptSummaryText = null;
		lastInputText = null;
		try {
			ctx.ui.setWorkingMessage(); // 无参 = 恢复 pi 默认文案
		} catch {
			// 旧 ctx，忽略
		}
		// 结束符：写一条会话条目，历史里留一行「跑了多久 · 几点结束」。
		// 只认正常完成；`startedAt === null`（没见到 agent_start，比如中途重载）不写。
		if (!TURN_MARKER_ENABLED || !completed || startedAt === null) return;
		// 还有子代理在后台跑就不写（见文件头）：那行「done」此刻是假的，它正贴在
		// pi-subagents 的 `async subagent` 块下面。探测放在上面两道判断之后，被
		// 打断 / 报错的回合一次都不问。
		if (await subagentsBusy()) return;
		// 探测是异步的（最多一个超时），这段窗口里可能已经起了**新回合**（子代理完成会
		// `triggerTurn` 唤醒一轮、用户也可能直接发了下一句）。旧 widget 方案在这里要让位；
		// 现在写的是会话条目 —— 它就属于刚结束的那一轮，新回合开不开都不该被吞掉。
		writeTurnMarker(
			ctx,
			formatTurnMarker(pickTurnVerb(), formatDuration(settledAt - startedAt), formatEndClock(new Date(settledAt))),
		);
	});

	/**
	 * 弹窗期间冻结一切周期性重绘，让用户能上翻看长内容（plan-mode 批准框）。
	 * 事件由 pi 的 `withUIPrompt` 发出，覆盖 select / confirm / input / editor / custom
	 * 五种对话框；嵌套弹窗靠 `uiPromptDepth` 计数，只在最外层进出时发事件，所以这里
	 * 不用自己防嵌套。
	 */
	pi.on("ui_prompt_start", async (_event, ctx) => {
		pauseForUiPrompt(ctx);
	});
	pi.on("ui_prompt_end", async () => {
		resumeAfterUiPrompt();
	});

	pi.on("session_shutdown", async () => {
		stopActivity();
		turnStartedAt = null;
		turnOutcome = null;
		promptText = null;
		promptSummaryText = null;
		lastTurnSummary = null;
		// 去重键也要清：新会话里用户可能又敲一条与上一会话最后一条完全相同的提示词，
		// 留着旧值会把它当成「重复的 input」直接跳过。
		lastInputText = null;
	});
}
