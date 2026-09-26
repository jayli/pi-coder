/**
 * Bash Command Collapse Extension
 *
 * 把 bash 工具调用的显示改成用户 2026-09-21 定的形状：命令最多两行（`Run ` 前缀、
 * 行尾溢出换一个 `…`），结果挂在同一棵树下面（`│ ` 续段、`└ ` 只出现一次）。
 * 纯显示层：发给模型的 tool call 参数、session 记录里的原文完全不变。
 *
 * ## 目标形状（用户给的样例）
 *
 * `Run ` 替代 pi 内置的 `$ `；命令最多 **2 个视觉行**，第 2 行**不管溢出多少字符都只把
 * 末尾换成 `…`**（不推进第 3 行）；命令本身更长时在第 2 行下面补一行 `… +N lines`。
 * 这两行的起始列都对齐 `Run ` 里 `n` 那一列（第 3 列）。
 *
 * ```
 * Run cd /Users/bachi/Library/pnpm/store/v11/links/@earendil-works/pi-cod
 *   ing-agent/0.86.0/5813aee6dbf81477902199f3db54e13ab115c8902b3ab00a
 *   … +1 lines
 * ```
 *
 * 这是**执行中**的形态：续行与 `… +N lines` 用等宽空格缩进。命令一执行完，这些行的
 * 前缀就换成 `│ `（树接上了），并在 `Run ` 下面开始挂结果：
 *
 * ```
 * Run cd /Users/bachi/Library/pnpm/store/v11/links/@earendil-works/pi-cod
 * │ ing-agent/0.86.0/5813aee6dbf81477902199f3db54e13ab115c8902b3ab00a
 * │ … +1 lines
 * │ … (20 earlier lines, ctrl+o to expand)
 * └ 第一行实质输出
 *   第二行输出
 *   Took 2.4s
 * ```
 *
 * `└ ` **只出现一次**，就在除截断提示（`… (N earlier lines, ctrl+o to expand)`）以外的
 * **第一行实质输出**上；它下面的内容行（后续输出、warnings、`Took Xs` 页脚、没有输出时
 * 的 `(no output)`）一律用等宽缩进（`  `）对齐正文列、不再画竖线 —— 树在 `└` 那里
 * 就“落地”了。`└ ` 与它后面的正文之间有 `└ ` 自带的那一个空格。
 *
 * **`│` / `└` 是结构符，不是正文**：整棵树的竖线与拐角统一 `muted`，各自**自成一段**
 * SGR（`styleCommandLine` 把前缀的颜色单独闭合在正文之前，`prefixTreeLines` 也只给前缀
 * 上色）—— 前缀绝不继承后面那个 token 的颜色（命令续行后面可能是 string / path / comment
 * 等任意 token，曾经路径那行的 `│` 就跟着 path 色飘了）。
 *
 * **只有 `Run` 这个词加粗**（`toolTitle` 正常色 + bold），行尾那格间距与整条命令正文一律
 * 不加粗 —— 加粗是 `\x1b[1m…\x1b[22m`，必须紧贴这个词，包住整个前缀会让间距看着变宽
 *（见 `styleCommandPrefix`）。
 *
 * `Run `（4 列）比原来的 `$ `（2 列）宽 2 列，所以首行的折行预算要按 4 列扣 ——
 * `renderCommandLines` 的 `firstRowBudget` 与续行缩进都从 `COMMAND_PROMPT` /
 * `COMMAND_CHAIN` 现算，别写死数字。
 *
 * ## 折叠视图：break-all 硬折行 + 行尾 `…` + `… +N lines`
 *
 * 折行规则是 CSS `word-break: break-all` 那一套：按列预算逐个 grapheme 填充，**装满到
 * 恰好放不下为止再断**，断点就在行末，不管它落在单词/路径中间。实现见 `hardWrapRows`。
 *
 * 为什么不用 pi-tui 的 `wrapTextWithAnsi`：它是**贪心词折行 + 长词按列断开**，装不进当前行
 * 剩余空间的词会被**整块挑到下一行**再去断 —— 实测 79 列终端上 `Run cp <78 列路径>` 渲染成
 * `Run cp` 单独一行 + 路径从中间断成两截：行尾白白空着几十列（就是“提前折行”那个难看的
 * 样子），命令和它的参数还被拆开。硬折行则把每行填满。
 *
 * 中间试过第三条路（commit 9024c26）：不折行、装不下就把行尾截成 `…`。它不提前折行，
 * 但一条长命令只剩一行可见内容、后面全丢；现在这条“2 行 + 行尾 `…` + `… +N lines`”
 * 是用户指定的折中：**溢出多少都只吃最后 1 行**，行数恒定可预期。
 *
 * 行数预算（`limit`，`DEFAULT_LINES = 2`）按**视觉行**算而不是源行：一条超长单行命令占满
 * 整个预算而不是刷十几行，而短行的多行命令（heredoc 等）仍然显示前 2 条源行 —— 两种情况
 * 都不会失控。`… +N lines` 里的 N 只数**整条源行**（第 2 行之后每条还没轮到的源行算 1，
 * 已经折出来但没放下的碎片也各算 1），不做 token 估算 —— 精确、一眼能对上行数。
 * 展开态（ctrl+o）用同一套硬折行规则，只是不限行数 —— 折行规则必须一致，否则展开态又会
 * 出现“提前折行”。
 *
 * 语法高亮（`styleCommandLine`）跟着折行走：token 偏移是**源行坐标**，折行碎片也带自己在
 * 源行里的起点偏移（`WrappedRow.start`，前缀不参与折行、所以不用换算），两边同坐标直接
 * 比对就对上号 —— 少了这个偏移，续行的颜色会整体错位。
 *
 * ## 输出预览行数（pi 写死 5 行，这里改成 3 行）
 *
 * pi 把 bash 输出的预览行数写死在 `core/tools/renderers/bash.js` 的
 * `const BASH_PREVIEW_LINES = 5`：模块私有常量，既没从包里导出，也不在
 * `BashToolOptions` 里，`docs/settings.md` 里也没有对应设置项 —— **没有全局配置可改**，
 * 只能在扩展里后处理（`withPreviewLimit` / `trimPreviewLines`）。
 *
 * 做法是拿 pi 渲好的组件做后处理而不是重写整个 resultRenderer，这样 pi 的语义
 *（截断页脚剔除、warnings、`Took Xs`、展开态、图片）全部保留，我们只动预览那一段。
 * 两个关键点：① **逐 child 渲染**而不是拿平铺行数组（平铺数组里分不清哪几行是预览）；
 * ② 裁掉的行数必须补进提示行的计数，否则「隐藏了多少行」就谎了 —— pi 给了提示行就
 * 在它那行**原地改数字**（保住 pi 的配色与真实键名），pi 没给（输出刚好 ≤ 5 行）
 * 就自建一行，否则那 1~2 行会静默消失。
 *
 * 展开态（ctrl+o）自动不受影响：那时 pi 用的是 `new Text(...)` 而不是预览组件，
 * 鸭子判定直接跳过，完整输出一行不裁。
 *
 * ## 输出树形 gutter（`│` 续段 / `└` 只出现一次）
 *
 * 命令执行完，续行从纯缩进换成 `│ `，结果挂在同一棵树下 —— 命令在上、输出在下，层次一眼
 * 可辨。`└ ` 在**整块结果里只出现一次**，就在第一行实质输出上（用户 2026-09-21 定的形状：
 * `└` 不再落在最后一行）。细节与三个不能想当然的点见 `prefixTreeLines`。
 *
 * 实现挂在 `withPreviewLimit` 里（它本来就要逐 child 找出「哪个子组件是输出」，gutter 用
 * 的是同一条判定）。三个刻意的设计决定：
 *   ① **展开态（ctrl+o）不加 gutter、也不裁行** —— 展开态要的就是原样完整输出。
 *   ② **`└ ` 必须在所有 child 的行都走完后统一上**（`prefixTreeLines(out)` 最后调一次），
 *     不能逐 child 各画一棵树：那样 warnings / `Took` 段会再长出一个 `└ `，屏幕上就有两行
 *     带拐角符的内容（实测踩过）。空行仍保持为空行 —— 失败状态那句 `\n\n` 除外，见下节。
 *   ③ 输出段按 `width - 2` 渲染（`GUTTER_WIDTH`），否则挂上前缀必超宽；结果里的其他段落
 *     （warnings / `Took`）pi 是按整宽渲染的，在更宽的终端里会把 2 列顶出边缘 —— 已知
 *     小瑕疵，只在「超长 warnings + 宽终端」下可见（`Took Xs` 这类短行不受影响）。
 *
 * ## 失败状态（`Command exited with code N` / ... timed out ... / ... aborted）
 *
 * 用户 2026-09-21 提的两件事：提示要染成 error 色，且提示上面那两行空行不能把树断开。
 * 这两件事的根源是同一个：**pi 把失败状态当成普通输出拼在结果正文末尾**，不是独立字段、
 * `details` 里也没有标记（`core/tools/bash.ts` 三处 `throw new Error(appendStatus(text, status))`，
 * `appendStatus` 就是 `` `${text}\n\n${status}` `` —— 注意它平时那个 `text ? … : ""` 三元在这里
 * 永远是“有 text”那一支，因为 `formatOutput` 已先把空输出换成了 `(no output)`）。
 * 结果正文逐行 `theme.fg("toolOutput", …)` 后 join，于是：
 *   - 状态行与输出同色（默认 gray）—— 要红只能**按文本形态认出来再换色**（
 *     `isFailureStatusLine` + `colorizeFailureStatus`，在 `prefixTreeLines` 里做，
 *     因为那里已经是“最终行数组”）；
 *   - 状态前面那句 `\n\n` 在非展开态下会渲染成**两行空行**（`\n\n` → 两个空行），夹在
 *     预览与提示之间就是用户说的“断层两层”（展开态因为 Text 折行而看不到）。
 *     `trimPreviewLines` 把状态与其前的空行一起摘下来单独处理：空行不画、状态当作预览
 *     里**必得占一格**的一行（否则它会被预览裁掉 —— 实测过：状态被裁掉后整块只剩
 *     一条 `│ … (N earlier lines)` 加两行空行），最后把状态放回尾部。摘空行是**连着摘**的：
 *     输出自己那些尾部空行（`printf "a\n\n\n"`）一并吃掉，否则它们会同样撑开断层 ——
 *     尾部的空行没有信息量，腾出来的预算换成真正的输出行更值。
 *
 * 形状上结果是「详情跟在正文后、两格缩进对齐」，与 `Took` / warnings 同一套：
 *
 * ```
 * Run for f in a b; do echo "-- $f"; done; exit 2
 * └ -- a
 *   -- b
 *   Command exited with code 2      ← 红色（error 槽）
 * ```
 *
 * **两道判定缺一不可**：`context.isError`（真是错的那次）+ 整行等于上面三个形态之一。
 * 只看形态会把 `echo "Command exited with code 2"` 的正常输出也染红、还会在它排在末尾时
 * 被当成状态摘走（回归测试盯的就是这条）；只看 `isError` 则会把整个输出正文染红。
 *
 * ## 耗时页脚门槛（短命令不画 `Took`）
 *
 * pi 内置的结果渲染器**无条件**在末尾画一行 `Took X.Xs`（`state.startedAt` 有值就画），
 * 而它是个**独占一行**的页脚：对绝大多数几十毫秒的命令来说只是白占一行高度，还额外带进
 * 一行分隔空行（页脚是 `new Text("\n" + …)`，那个前导 `\n` 就是正文与页脚之间的空白行）：
 *
 * ```
 * $ echo hello
 * └ hello
 *
 *  Took 0.1s
 * ```
 *
 * 所以**短命令整条页脚都不画**（连那行分隔空行一起）—— 区块变成「命令行 + 输出 +
 * 下边界空行」，一行都不浪费。门槛默认 2000ms（常量 `DEFAULT_MIN_TIME_FOOTER_MS`），
 * `PI_BASH_MIN_TIME_MS` 启动时可改，`0` = 永远显示（等于关掉这个优化）。
 *
 * 判定用**真实耗时** `endedAt - startedAt`（与 pi 画那个数字用的是同一个量），不去解析
 * 页脚上的文本 —— 文本是 `(ms / 1000).toFixed(1)` 四舍五入过的，拿它判会出现「显示 2.0s
 * 其实只跑了 1.96s」这类边界偏差。门槛 >= 耗时即隐藏，所以能看见的数字必然 >= 2.0s，
 * 不会出现自相矛盾的 `Took 1.9s`。
 *
 * 流式模式（`PI_BASH_STREAM=on`）下执行期中那个 `Elapsed X.Xs` 走同一条判定（同一个页脚，
 * 只是文案跟着 `isPartial` 变）：短命令执行期间不会闪出那一行，跑过 2s 才出现 ——
 * 正好是「值得看一眼」的时刻。非流式（默认）下只在执行结束时判一次，正是用户要的语义。
 *
 * 实现挂在 `withPreviewLimit` 里（它本来就要逐 child 渲染、也本来就把 warnings / `Took`
 * 当「非输出 child」透传），判定见 `isTimeFooterChild`：末位 + 文本形态两条缺一不可。
 *
 * ## bash 命令语法高亮（轻量版）
 *
 * 命令行按 shell 词法上色：命令名 `syntaxFunction`、选项 `-x/--xxx` `syntaxKeyword`、
 * 引号串与路径 `syntaxString`、`$VAR`/`NAME=` 赋值 `syntaxVariable`、`|`/`&&`/重定向
 * `syntaxOperator`、`#` 注释 `syntaxComment`，`Run ` 前缀用 `toolTitle`（正常色，不用
 * dim）。配色走主题的 `syntax*` 槽（和 markdown 代码块同一套），所以换主题自动跟着变。
 * 默认开，`PI_BASH_HIGHLIGHT=off` 回到「整行 toolTitle 粗体」—— 刻意**没有**
 * `/bash-highlight` 指令：纯观感开关，env 一个入口就够，没必要再占一条斜杠指令。
 *
 * 参照 `@sting8k/pi-droid-styling` 的 `tool-tags/bash.ts`：它同样是**手写 shell 分词器**
 *（`tokenizeShellLinePreservingText` + `colorShellWord`），只在分词失败（引号没闭合）时
 * 才退回 pi 导出的 `highlightCode(line, "bash")`。这里不采它的退回路径 —— `highlightCode`
 * 返回的是**带 ANSI 的整行**，而本扩展的折行是 break-all 硬折行、必须「先折纯文本、
 * 后上色」（反过来会把 SGR 序列从中间切断，见 renderCall 里的注释），带 ANSI 的行没法
 * 再喂给 `hardWrapRows`。所以分词失败就退回单色粗体，而不是换一个高亮器。
 *
 * 对齐办法：token 偏移是**源行**坐标，折行碎片是**折行后**坐标且带自己的起点偏移 ——
 * `styleCommandLine` 把 token 与正文都换算到源行坐标比较，偏移换算的三步（碎片自带
 * `start`、第 2 片起减 head 宽度、行尾 `…` 只在纯文本上放）见 `renderCommandLines`。
 * 三条要点：
 *   ① 一个 token 被折行切成两半时，两半是同一种颜色 —— 视觉上无碍。
 *   ② 引号状态**跨源行**保留（`openQuote`），所以多行字符串（`git commit -m "…\n…"`）
 *     的第二行不会被当成命令重新分词。heredoc 正文没有这个待遇（`<<EOF` 不是引号），
 *     会按命令行上色 —— 无害，只是不准。
 *   ③ 被折叠掉的行不参与上色（也根本不进渲染路径）。

## 输出正文的独立颜色（扩展 token `bashOutput`）

pi 的内置 bash 结果渲染器把输出正文写死成 `theme.fg("toolOutput", line)` —— 那是**所有
工具输出共用的槽**（read / grep / ls 的正文、`…` 占位符都吃它），想只调 bash 输出的颜色
就得绕开它。做法是在**委托给内置渲染器的那个同步窗口**里把主题的 `toolOutput` 临时指向
`bashOutput`（`withBashOutputColor()`），于是只有输出正文换色 —— 命令行（`toolTitle` +
自绘语法高亮）、折叠提示（`muted` / `dim`）、树形 gutter（`muted`）、`Took Xs` 页脚
（`muted`）一律不受影响，其他工具的输出也完全不受影响（它们的渲染器不在这个窗口里跑）。

注意**传给 `renderResult` 的那个 theme 参数是没用的**：pi 的 bash 渲染器签名把第二个
theme 参数写成 `_theme` 后根本不用它，输出行是用**模块级 theme 单例**上的色。
那个单例（`Proxy` → `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]`）
与扩展拿到的渲染器参数是同一个对象，所以改它的 `fgColors` 表就是改渲染器看到的色值。

`bashOutput` 是本仓库自造的 token（pi 官方 schema 里没有，与 `toolDiffAddedBg` 那两个
同一条路：TypeBox 校验对未知 key 放行、`createTheme()` 把它们收进前景表）。**主题没定义它
就什么都不做**（探测方式是真调一次 `getFgAnsi()`，pi 对未知 token 抛
`Unknown theme color: …`），所以内置主题与 pi-coder-summer-night / pi-coder-catppuccin 照旧走 `toolOutput`，
目前只有 `pi-coder-ayu.json` 定义了这个 token。展开态（ctrl+o）同样是输出正文，一并生效。

## 整块没有底色、没有 boundary 空行
 *
 * bash 块**完全不带底色**（用户 2026-09-21 定的）：pending 的 `toolPendingBg`、成功的
 * `toolSuccessBg`、失败的 `toolErrorBg` 三种底都不画，块里就是普通正文，与周围的 transcript
 * 连成一片。状态改由首行那颗圆点的颜色表达（见下节）—— 底色没了不等于状态信息丢了。
 *
 * 实现上是**主动不去画**，不是画上再擦掉：`renderShell: "self"` 之下 pi 本来就不再给整块套
 * bgFn（`selfRenderContainer` 是个纯 `Container`，只有默认 shell 那条路才套），所以只要我们
 * 自己不套，块就是干净的。于是 `Box` 的 `bgFn` 传 `undefined`（`new Box(0, 0)`），
 * `stateBgFn` 整个函数删掉 —— 它当初存在的唯一理由就是「把 pi 在默认 shell 下会套的那层
 * 底色补回来」，现在不需要了。
 *
 * ★ **只去 bash 的**：其他工具（read / grep / edit / write / task_* …）走的是 pi 自己的渲染
 * 路径，`contentBox` 与 bgFn 完全不受本扩展影响 —— 本扩展只注册 `bash` 这一个工具的渲染器，
 * 改的也只是自己返回的那两个组件。
 *
 * 上下 boundary 空行同理一并去掉：底色的上下内边距本来是本扩展自己画回来的（命令行上面一行、
 * 整块最后一行下面一行，两行都是染了底色的空行 —— `Box.applyBg` 会把每行补满到 width 再上色），
 * 但 bash 调用连着来时那样会把屏幕撑得很稀。现在整块只剩「命令行 + 结果」本身：命令就是块的
 * 第 1 行、结果就是最后一行，一行空白都不加。
 *
 * **中间本来就是紧贴的**（命令与输出之间不留空行）—— 那是更早一轮刻意去掉的（命令与结果
 * 是两个独立 Box，各自的 `paddingY` 会叠成三行空白）。
 *
 * 命令行那格左内边距不再是空格，换成了状态圆点（见下节）。
 *
 * ## 命令行首行的状态圆点（`•`）
 *
 * 命令行**首行**的前面一颗圆点 `•`（U+2022，1 列宽），颜色按这次 bash 调用的状态走
 *（用户 2026-09-21 定；最初是 `▎`，随后按观感换成 `•`，**着色逻辑一字未动**）：
 *
 * ```
 * • Run ls …path…
 *    python abc.py…
 * ```
 *
 *   - **执行中（pending）** → `dim`（暗灰）
 *   - **执行成功** → `toolDiffAdded`（diff 新增行的绿）
 *   - **执行失败** → `toolDiffRemoved`（diff 删除行的红）
 *
 * **只有 `Run ` 这一行前面有**：续行（`│ ` / 两格缩进）、`… +N lines` 标记、以及整棵结果树
 *（`└ ` / 两格缩进）前面都不画 —— 圆点是「这一次 bash 调用」的状态灯，不是整块的边框。
 *
 * 挂法：调用侧的 `Box` 用 `paddingX: 0`，左边距那两格**由扩展自己画**（`withHeadBar`）：
 * 首行是 `•` + 一个空格，其余行是两个空格。于是圆点落在**列 0**、`Run` 在列 2、所有正文在
 * 列 4，而续行 / 结果树的 `│` `└` 也在列 2 —— 与命令行同列，正文也彼此对齐。
 *
 * ★ **这两格整体是「正文右移一列」换来的**（用户 2026-09-21 第二轮定的观感：原来 `▎Run …`
 * 里 `Run` 顶着状态符太挤，现在 `• Run …`）。同一次改动把**结果侧也一起右移了一列**
 *（`withPreviewLimit` 里的 `contentWidth = width - GUTTER_WIDTH - 1`），否则命令行在列 2、
 * 结果树在列 0，两截会错开。改左边距时**两边必须一起改**，`INDENT_WIDTH` 就是这两个 1。
 *
 * `Box` 的 `paddingX` 是 0，所以孩子拿到的是整宽，两边各自把用掉的列扣回去
 *（`renderCall` 的 `width - 3`、`withPreviewLimit` 的 `width - 3`）。圆点只挂**首行**
 *（`renderCall` 里按索引 0 处理），`invalid arg` / 空命令那条 `wrapTextWithAnsi` 分支同样。
 *
 * 三个槽位 pi 一直都有（`toolDiffAdded` / `toolDiffRemoved` / `dim` 都是 schema 里的必需
 * token），所以不像 `bashOutput` 那样需要存在性探测；取的是**前景** ANSI（`getFgAnsi`），
 * 后面补一个 `\x1b[39m`，颜色不会洇到后面的 `Run` 上。
 *
 * 用法：
 *   /bash-preview             查看输出预览行数
 *   /bash-preview 5           输出预览改成 5 行（1-50）
 *   /bash-preview off         恢复 pi 内置的 5 行预览
 *   /bash-timeout             查看 bash 执行期限（默认 / 上限 / env 覆盖）
 *
 * 折叠固定开启、保留 2 个视觉行 + 行尾 `…` / `… +N lines`（原先的 `/bash-collapse`
 * 指令已删除）；树形缩进固定开启（`PI_BASH_TREE` 已废弃），流式只剩 `PI_BASH_STREAM=on`。
 *
 * 附带第五个职责：**短命令不画耗时页脚** —— 默认执行时长 < 2s 就把 `Took 0.1s` 那一行
 *（连它的前导分隔空行）整个去掉，详见上面「耗时页脚门槛」一节。`PI_BASH_MIN_TIME_MS`
 * 可改门槛，`0` = 永远显示。
 *
 * 附带第四个职责：把 bash **输出预览**从 pi 内置的 5 行改成 3 行
 *（`BASH_PREVIEW_LINES` 是 pi 的模块私有常量，没导出也没设置项，只能后处理，
 * 详见下面「输出预览行数」一节）。`/bash-preview` 可改。
 *
 * 附带第三个职责：给每条 bash 命令**强制一个执行期限**（默认 120s、上限 600s，
 * 照抄 Claude Code 的 BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS 策略，详见下面
 * CLAUDE_CODE_DEFAULT_TIMEOUT_MS 那块的注释）。pi 内置 bash 的 timeout 无默认值，
 * 不注入就会无限期等下去。
 *
 * 附带第二个职责：把 bash 工具调用的屏幕显示改成**非流式**（默认，对齐 opencode / codex）。
 * pi **没有**任何设置项能做到这件事（settings.md 里 Shell 一节只有 shellPath /
 * shellCommandPrefix / npmCommand）。而且这里有**两条独立的流式机制**，必须分别处理：
 *
 * （1）**输出流式**：内置 bash 的 execute 每收到 stdout/stderr 数据就 onUpdate() 一份快照，
 *     节流 100ms（renderers/bash.js 的 BASH_UPDATE_THROTTLE_MS），经 tool_execution_update
 *     事件到 TUI（interactive-mode.js）当 partial 结果重画一遍。
 *     关掉的办法：把 onUpdate 传成 undefined —— execute 里每个更新点都有
 *     `if (!onUpdate) return` 守卫，于是全程零更新。渲染器不受影响：组件在
 *     `tool_execution_start` 就已创建（与更新无关），最终显示走 `tool_execution_end` →
 *     `updateResult(result, isPartial=false)`，所以压掉 partial 只是少了中间帧，
 *     结束那一次照常出（5 行预览 + 展开提示 + 截断提示 + "Took Xs"）。
 *
 * （2）**命令文本流式**：模型生成工具调用时参数是流式的（json 事件里能看到 toolcall_delta
 *     一片一片到：`{"command": "echo a` / `; sleep 0` / `.3; echo` …），pi 每收一片就
 *     updateArgs() → updateDisplay() → 重画一次 renderCall，于是命令一个字一个字冒出来。
 *     这条与（1）**完全无关**，光压 onUpdate 管不到它。
 *
 *     关掉的办法是把两个时间点**分开**处理（对齐 codex / opencode）：
 *       时间点一：命令字符全收完（`context.argsComplete`）→ renderCall 一次性出完整命令；
 *       时间点二：命令执行完 → renderResult 把结果补刷到命令下面。
 *     具体做法：renderCall 在「args 可能还在流」（`!argsComplete && isPartial === true`）时
 *     返回**零行组件**（连占位行都不画）。
 *     注意不能**只**用 isPartial 当阈值：isPartial 要等 final 结果才置 false，单用它会把
 *     命令也压到结果之后，退化成「全等到结果才一次性出」。
 *     （setArgsComplete() 在 assistant message_end 时调，比 tool_execution_start 早 ~60ms，
 *     正好是“命令收完”这个语义点。）
 *     也不能**只**用 argsComplete：它只在实时流里置位，`/resume` 等历史重建路径从不调
 *     setArgsComplete（见 renderCall 里的详细说明），单用它会让恢复出来的 bash 块
 *     只剩输出、命令行整行消失（这就是曾经的 resume bug）。
 *     另外零行组件不会画出空盒子：Box.render 开头有 `childLines.length === 0 → []` 守卫
 *     （paddingY 是在这之后才加的）。
 *
 * 实测证据：
 *   - `pi -p --mode json` 跑真实 pi 数事件，同一条
 *     `echo a; sleep 0.35; echo b; sleep 0.35; echo c`：扩展加载时 `tool_execution_update` = **0**，
 *     `--no-extensions` 跑内置 bash 时 = **4**；两种情况的 tool result 都是 `"a\nb\nc\n"`。
 *   - 直接调包根导出的 createBashToolDefinition 数 onUpdate 次数：传 onUpdate = 4 次
 *     （1 次初始空更新 + 3 份输出快照），传 undefined = 0 次，final result 逐字节相同。
 *   - **执行耗时不受影响**：同一条 `echo a; sleep 0.5; echo b`，流式平均 545ms / 非流式
 *     平均 566ms（各跑 3 次，差 21ms 在噪声内）。所谓“变慢”是非流式的固有代价：
 *     以前第一块输出 ~100ms 就冒出来了，现在整个命令跑完才显示，感知延迟 = 命令全时长。
 *   - `echo hello` 的真实时间线：toolcall_start → toolcall_end 197ms（args 流式，模型侧）、
 *     toolcall_end → tool_execution_start 63ms、tool_execution_start → end 只 31ms。
 *     即“等了一下”的主体是模型在生成 tool call，不是命令执行。
 *
 * 为什么必须放在本扩展里而不是新开一个 bash-stream.ts：跨扩展的同名工具注册是
 * **first registration per name wins**（runner.js getAllRegisteredTools 的注释原文，
 * 按扩展加载顺序即文件名顺序遍历）。本文件排在前面，新开的那个会被**静默忽略**。
 *
 * 非流式的代价（刻意的，别顺手"优化"）：
 *   - 命令收完到执行完之间**没有进度反馈**（只有那行命令，没有输出、没有计时）。
 *     `renderResult` 里的每秒计时器只在 `options.isPartial` 时才起
 *     （`if (state.startedAt !== undefined && options.isPartial && !state.interval)`），
 *     没有 partial 就永远不起，也没有 "Elapsed" 跳动，直到结束才补上
 *     「输出 + Took 12.3s」。命令通常很短所以可接受；真要盯长任务就 `PI_BASH_STREAM=on`。
 *   - 发给模型的内容**完全不变**：onUpdate 只喂显示层（tool_execution_update →
 *     tool-execution.js 的 isPartial），既不进 session 落盘也不进 tool result，
 *     execute 的返回值一字不差；renderCall 也只改显示，tool call 参数与 session 原文不动。
 */

import type { BashToolOptions, ExtensionAPI, ThemeColor, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Box, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	ESCALATION_TITLE,
	boundaryFromEnv,
	buildSeatbeltProfile,
	classifyOutsidePaths,
	extractDeniedPaths,
	isSandboxEnabled,
	looksLikeSandboxDenial,
	maskedDenialPaths,
	memoryScopesFor,
	sessionScopeFor,
	wrapWithSandbox,
	writableRoots,
	type PathEnv,
	type WriteBoundary,
} from "./bash-command-collapse/sandbox.ts";
import { getAllowlistStore, getSessionScopes, type AllowlistStore } from "./bash-command-collapse/allowlist.ts";
import { getSandboxMode } from "./bash-command-collapse/sandbox-mode.ts";

/**
 * 命令行**折叠态**保留的**视觉行**数（硬折行后一条超长单行命令也最多占这么多行）。
 *
 * 2 是用户定的观感：第 1 行装到满，第 2 行溢出多少都截成 `…`；命令本身更长时
 * 第 2 行下面再补一行 `… +N lines` 标记。详见文件头「命令行：2 行 + `Run ` 前缀」一节。
 */
const DEFAULT_LINES = 2;

/**
 * 命令行前缀。老观感是 pi 内置的 `$ `，现在是 `Run `（见文件头「命令行：2 行 + `Run `
 * 前缀」）。首行用它、续行用 `COMMAND_CHAIN`（两者对**正文列**的影响不同，折行与预算
 * 都按各自那套算）。
 */
const COMMAND_PROMPT = "Run ";
/**
 * 结构符（`Run ` 命令行的续行 `│ `、结果的 `└ ` / `│ `）的主题槽 —— **`muted`**。
 *
 * 为什么不是 `toolTitle`（`Run ` 那一版用的）：命令行的续行与结果树里的拐角符是**同一棵
 * 树**的两段，颜色必须一致；`Run ` 是标题、用 `toolTitle` 正常色，树用 `muted` —— 与结果
 * 侧的 `└ `（`prefixTreeLines`）取同一个槽，于是 `Run ` / `│` / `└ ` 三层各就各位：
 * 前缀亮、结构灰。
 */
const COMMAND_CHAIN_COLOR = "muted";
/**
 * 树形 gutter 的竖线行：命令还没结束时的续行、执行完的续行、输出/命令的截断提示都用它
 *（见文件头「输出树形 gutter」）。2 列。
 */
const COMMAND_CHAIN = "│ ";
/** 纯缩进（2 列）：命令执行中还没接上树时的续行、结果树里 `└ ` 之后的正文续行。 */
const COMMAND_INDENT = "  ";
/** 行尾溢出标记（命令行最后一行末尾、截断提示行行首共用）。 */
const ELLIPSIS = "…";

/**
 * 输出预览保留的行数（pi 内置是 5，这里改成 3）。
 *
 * pi 把行数写死在 `core/tools/renderers/bash.js` 的 `const BASH_PREVIEW_LINES = 5`：
 * 模块私有常量，既没从包里导出（`index.d.ts` 里没有），也不在 `BashToolOptions`
 * 里，`docs/settings.md` 里也没有任何对应的设置项 —— 所以没有全局配置可改，
 * 只能在扩展里后处理。详见文件头「输出预览行数」一节。
 */
const DEFAULT_OUTPUT_PREVIEW_LINES = 3;

/**
 * 耗时页脚的展示门槛（毫秒）：执行时长**短于**它就不画 `Took 0.1s` 那一行。
 *
 * pi 内置 `renderResult` 无条件在结果末尾画一行 `Took X.Xs`（`state.startedAt` 有值就画），
 * 而它是个独占一行的页脚（外加自己那行前导空行）—— 对几十毫秒的命令来说纯属白占两行。
 * 详见文件头「耗时页脚门槛」一节。
 *
 * `PI_BASH_MIN_TIME_MS` 启动时可改；`0` 是合法值 = 永远显示（等于关掉这个优化）。
 */
const DEFAULT_MIN_TIME_FOOTER_MS = 2000;

/**
 * 第三个职责：给每条 bash 命令**强制一个执行期限**（照抄 Claude Code 的策略）。
 *
 * 为什么必须有：pi 的内置 bash `timeout` 是可选参数且**无默认值**（schema 描述原文
 * "Timeout in seconds (optional, no default timeout)"，settings.md 里也没有任何全局
 * 工具超时项），所以模型不传 timeout 时，一条不退出的命令会让 pi **无限期等下去**。
 * 而本扩展默认非流式（onUpdate 被摘掉），内置渲染器的 `Elapsed` 计时器只在
 * `isPartial` 时才起（renderers/bash.js），于是屏幕上「进程卡死」与「纯粹耗时」
 * 长得一模一样 —— 既不会自己脱困，也看不出该不该等。
 *
 * Claude Code 的做法（从 v2.1.268 二进制里扒出的原文，JS 是内嵌的）：
 *   var xRo=120000, ARo=600000;                       // 默认 2min / 上限 10min
 *   wCe(env)  → BASH_DEFAULT_TIMEOUT_MS 否则 xRo       // 默认
 *   i7e(env)  → Math.max(BASH_MAX_TIMEOUT_MS 否则 ARo, wCe(env))   // 上限=max(配置,默认)
 *   Math.min(z || Xe(), Be())                          // 模型传的 timeout **静默 clamp**
 * 工具描述里还把数字告诉模型："You may specify an optional timeout in milliseconds
 * (up to ${max}ms…). By default, your command will timeout after ${default}ms…"。
 * 注意它的单位是 ms，pi 的 bash 参数是**秒**，所以下面统一除 1000。
 *
 * env 变量名沿用 Claude Code 的（BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS），
 * 这样两边行为一致、迁移过来的配置直接可用；跟 Claude Code 一样在**调用时**读
 * process.env（不是模块加载时），所以运行时改 env 也生效。
 *
 * 超时后 pi 自己会 `killProcessTree(pid)`（整棵进程树，孙进程一起清）并把
 * "Command timed out after N seconds" 连同已有输出一起返回给模型 —— 这一步不用我们管。
 * 代价（与 Claude Code 同）：合法的长命令（大 build、长跑测试）会被默认期限杀掉，
 * 模型必须自己传更大的 timeout（上限 10min），或者用 env 抬高默认值。
 *
 * **对标审计（对 v2.1.268 二进制逐项核过，别凭文档印象怀疑下面的数值）**：
 * Claude Code 的 env 白名单里只有三个 `BASH_*` 是它自己的 —— `BASH_DEFAULT_TIMEOUT_MS` /
 * `BASH_MAX_TIMEOUT_MS` / `BASH_MAX_OUTPUT_LENGTH`（其余 `BASH_ARGC` / `BASH_SOURCE` 等
 * 都是 bash 自身的内部变量）。前两个就是上面那两个，已对齐；第三个**不采**：它只
 * 控制输出回读窗口（官方原文 "on its own only sizes the read-back window"），而 pi 的
 * 截断是“保留最后 2000 行 / 50KB + 全文写临时文件”，两者机制不同且 pi 的
 * `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES` 是模块常量、扩展改不了。
 * 已知差异（刻意的，不要“顺手对齐”）：
 *   ① **单位**：Claude Code 的 timeout 参数是 ms，pi 是秒 —— 所以 env 读 ms、内部除 1000，
 *     工具描述也用秒（不改 pi 的参数单位，否则会跟它自己的 schema 矛盾）。
 *   ② **非法值**：Claude Code 的 `z || Xe()` 会把**负数**原样透传（负数是 truthy），
 *     我们则把 `<=0` / 非有限值一律归到默认 —— 因为 pi 的 `resolveTimeoutMs` 对 `<=0`
 *     会直接 throw，不归就会把工具调用变成硬报错。NaN 两边行为一致（都落默认）。
 *   ③ **超时语义**：pi 是 throw（tool result 带 isError=true）+ 已积累输出，
 *     Claude Code 是普通结果 + 超时注释 —— 改不了（throw 发生在 `base.execute` 内部）。
 *   ④ Claude Code 的第 2/3 层（`run_in_background` + `BashOutput`/`KillShell`（新名
 *     `TaskOutput`/`TaskStop`）+ `/bashes` + Ctrl+B，以及 `CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS`
 *     到点不杀、自动转后台）**未实现**：pi 没有对应物，要做得新增三个工具 + 进程登记表。
 *   ⑤ pi 自己的硬上限 `MAX_TIMEOUT_MS = 2_147_483_647`（≈24.8 天）远高于我们 clamp 的
 *     600s，所以不会撞上 pi 的报错。
 */
const CLAUDE_CODE_DEFAULT_TIMEOUT_MS = 120_000;
const CLAUDE_CODE_MAX_TIMEOUT_MS = 600_000;

/** 读 env 里的毫秒值；非正数/非数字一律当未配置（与 Claude Code 的 `!isNaN(r)&&r>0` 一致）。 */
function readTimeoutEnvMs(name: string): number | undefined {
	const raw = process.env[name]?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 默认期限（秒）。 */
function defaultTimeoutSeconds(): number {
	return (readTimeoutEnvMs("BASH_DEFAULT_TIMEOUT_MS") ?? CLAUDE_CODE_DEFAULT_TIMEOUT_MS) / 1000;
}

/** 期限上限（秒）：Claude Code 是 `Math.max(配置上限, 默认)`，抬高默认时上限跟着抬。 */
function maxTimeoutSeconds(): number {
	return Math.max(readTimeoutEnvMs("BASH_MAX_TIMEOUT_MS") ?? CLAUDE_CODE_MAX_TIMEOUT_MS, readTimeoutEnvMs("BASH_DEFAULT_TIMEOUT_MS") ?? CLAUDE_CODE_DEFAULT_TIMEOUT_MS) / 1000;
}

/**
 * 算出这次执行的**有效期限（秒）**，即 Claude Code 那句 `Math.min(z || default, max)`：
 *   - 模型没传 / 传了非法值（0、负数、NaN、字符串）→ 落到默认期限；
 *   - 传了超过上限的值 → **静默 clamp 到上限**（不报错；Claude Code 同款行为，
 *     它这个静默 clamp 是已知 issue #83824，这里照抄以保持两边一致）。
 * 顺带避开 pi 的硬报错：内置 resolveTimeoutMs 对 <=0 / 非有限值会直接 throw。
 */
function effectiveTimeoutSeconds(requested: unknown): number {
	const max = maxTimeoutSeconds();
	const requestedSeconds = typeof requested === "number" ? requested : Number(requested);
	if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) return Math.min(defaultTimeoutSeconds(), max);
	return Math.min(requestedSeconds, max);
}

/** grapheme 分段器（pi-tui 没导出它自己的实例，所以本地建一个；Node 内置 Intl.Segmenter）。 */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 一条折行碎片：正文本身（**不含前缀**）、它在**源行**里的字符偏移、以及自己那行的前缀。 */
interface WrappedRow {
	text: string;
	start: number;
	prefix: string;
}

/**
 * **break-all 硬折行**：按列预算逐个 grapheme 填充，装满就断 —— 类似 CSS 的
 * `word-break: break-all`，不管断点是不是单词/路径中间。**不丢内容**：碎片拼起来就是
 * 原文（下一步怎么摆、怎么截由调用方决定）。
 *
 * 为什么不用 pi-tui 的 `wrapTextWithAnsi`：它是**贪心词折行 + 长词按列断开**，一个装不进
 * 当前行剩余空间的词会被**整块挑到下一行**再去断 —— 实测 79 列终端上 `Run cp <78 列路径>`
 * 渲染成 `Run cp` 单独一行 + 路径从中间断成两截：行尾白白空着几十列（就是“提前折行”那个
 * 难看的样子），命令和它的参数还被拆开。硬折行则把每行填满，`Run ` 后面直接跟命令正文。
 *
 * **前缀按行算**：第 1 行是 `firstPrefix`（`Run `），其余行是 `linePrefix`（`│ ` 或两格
 * 缩进）—— 预算是**扣掉该行前缀宽度之后**的正文预算，所以挂上前缀永远正好占满一行，不会
 * 顶出 gutter 一格（`Run ` 4 列、`│ ` 2 列，两种前缀下正文错一列是刻意的：首行跟着
 * `Run ` 走，续行对齐到 `Run ` 的 `n` 列）。
 *
 * **带偏移**（`WrappedRow.start`）：命令高亮靠它把「先折行、后上色」接起来 —— token 偏移
 * 是**源行**坐标、碎片是**折行后**坐标，没有这个区间就对不上号（详见 `styleCommandLine`）。
 *
 * 按 grapheme 而不是按列硬切：emoji / 组合字符的 segment 长度 ≠ 1 个字符，按字符下标切会把
 * 它们切成两半。宽字符（CJK 等，2 列）装不进剩下的 1 列时在它**前面**断行（行尾留 1 列
 * 空白）—— 一个 grapheme 不可分。
 *
 * @param firstPrefix 第 1 行的前缀（`Run `）
 * @param linePrefix  其余行的前缀（`│ ` / 两格缩进）
 * @param firstRowBudget 第 1 行的**整行**预算（含前缀；timeout 后缀已经从里面扣过了）
 * @param restRowBudget  其余行的**整行**预算
 */
function hardWrapRows(text: string, firstPrefix: string, linePrefix: string, firstRowBudget: number, restRowBudget: number): WrappedRow[] {
	const rows: WrappedRow[] = [];
	let row = "";
	let rowWidth = 0;
	let rowStart = 0;
	let prefix = firstPrefix;
	let budget = Math.max(1, firstRowBudget - visibleWidth(firstPrefix));
	for (const { segment, index } of graphemeSegmenter.segment(text)) {
		const w = visibleWidth(segment);
		// rowWidth > 0 守卫：单个 grapheme 比整行预算还宽时（极窄终端）也得放下，
		// 否则会产生空行死循环
		if (rowWidth > 0 && rowWidth + w > budget) {
			rows.push({ text: row, start: rowStart, prefix });
			prefix = linePrefix;
			budget = Math.max(1, restRowBudget - visibleWidth(linePrefix));
			row = segment;
			rowWidth = w;
			rowStart = index;
		} else {
			// row 为空说明这是本行第一个 grapheme，记下它在源行里的偏移
			if (row === "") rowStart = index;
			row += segment;
			rowWidth += w;
		}
	}
	rows.push({ text: row, start: rowStart, prefix });
	return rows;
}

/** 一条**待上色**的命令行：`text` 是纯文本（含前缀与行尾 `…`），上色信息齐备。 */
interface PendingRow {
	text: string;
	prefix: string;
	/** 正文起点在**源行**里的字符偏移（首片为 0，续片为碎片自身偏移）。 */
	sourceStart: number;
	tokens: ShellToken[] | null;
	/** 这一行挂上前缀后的整行预算（截断 `…` 用）。 */
	budget: number;
}

/**
 * 一条命令的渲染结果。`hiddenLines` 是**整个视觉行**没显示的条数（`0` 就没有标记行），
 * 被行尾 `…` 吃掉的那一行也计在内。
 */
interface CommandRender {
	lines: string[];
	hiddenLines: number;
}

function tokenizeShellLine(line: string, openQuote: string | null): { tokens: ShellToken[]; openQuote: string | null } {
	const tokens: ShellToken[] = [];
	let quote = openQuote;
	let commandExpected = true;
	let i = 0;

	while (i < line.length) {
		const char = line[i]!;

		// 跨行未闭合的引号：吃到本行的闭合引号为止，没有闭合就吃掉整行尾巴
		if (quote) {
			let j = i;
			while (j < line.length) {
				const c = line[j]!;
				if (c === "\\" && quote === '"' && j + 1 < line.length) {
					j += 2;
					continue;
				}
				if (c === quote) break;
				j++;
			}
			if (j >= line.length) {
				tokens.push({ kind: "string", start: i, end: line.length });
				i = line.length;
				continue;
			}
			tokens.push({ kind: "string", start: i, end: j + 1 });
			i = j + 1;
			quote = null;
			continue;
		}

		if (/\s/.test(char)) {
			let j = i;
			while (j < line.length && /\s/.test(line[j]!)) j++;
			tokens.push({ kind: "space", start: i, end: j });
			i = j;
			continue;
		}

		// `#` 只在**词首**才是注释（`foo#bar` 里的 `#` 是普通字符）
		if (char === "#") {
			tokens.push({ kind: "comment", start: i, end: line.length });
			i = line.length;
			continue;
		}

		const operator = matchShellOperatorAt(line, i);
		if (operator !== null) {
			tokens.push({ kind: "operator", start: i, end: i + operator.length });
			commandExpected = SHELL_COMMAND_NEXT_OPS.has(operator);
			i += operator.length;
			continue;
		}

		// 词：吃到空白 / 操作符 / 行尾为止，中途遇到引号就连引号一起吞
		let j = i;
		let wordQuote: string | null = null;
		while (j < line.length) {
			const c = line[j]!;
			if (wordQuote) {
				if (c === "\\" && wordQuote === '"' && j + 1 < line.length) {
					j += 2;
					continue;
				}
				if (c === wordQuote) wordQuote = null;
				j++;
				continue;
			}
			if (/\s/.test(c)) break;
			if (c === "'" || c === '"') {
				wordQuote = c;
				j++;
				continue;
			}
			if (SHELL_OPERATOR_CHARS.has(c)) break;
			if (c >= "0" && c <= "9" && isFdRedirectAt(line, j)) break;
			j++;
		}
		const word = line.slice(i, j);
		tokens.push({ kind: classifyShellWord(word, commandExpected), start: i, end: j });
		// 赋值前缀（`FOO=bar cmd`）后面仍然跟的是命令，其余词都把「该出命令了」清掉
		if (!SHELL_ASSIGN_PATTERN.test(stripOuterQuotes(word))) commandExpected = false;
		i = j;
		if (wordQuote) quote = wordQuote; // 引号没闭合 → 传给下一条源行
	}

	return { tokens, openQuote: quote };
}

/**
 * 命令行前缀的上色。三类前缀三种待遇：
 *   - `Run ` —— **只把 `Run` 这个词加粗**（`toolTitle` 正常色 + bold），后面那个空格与
 *     命令正文一律不加粗（用户 2026-09-21 定的：只有 `Run` 这一个单词是标题）；
 *   - `│ ` —— **结构符**，与结果侧的 `└ ` 同一个 `muted`（`COMMAND_CHAIN_COLOR`），
 *     不加粗；
 *   - 两格缩进（命令还在跑、树还没接上）—— 原样空格、不染色；空串原样返回（同一条
 *     源行折出来的后续碎片没有前缀）。
 *
 * 加粗必须**紧贴这个词**（`bold("Run")` 而不是 `bold(prefix)`）：粗体是 SGR `\x1b[1m…\x1b[22m`，
 * 包住前缀会把行尾那个空格也变粗 —— 与正文的间距看着会变宽。
 */
function styleCommandPrefix(prefix: string, theme: any): string {
	if (prefix === "" || prefix === COMMAND_INDENT) return prefix;
	if (prefix === COMMAND_CHAIN) return theme.fg(COMMAND_CHAIN_COLOR, prefix);
	// `Run ` → `Run`（bold）+ ` `（普通）
	return theme.fg("toolTitle", theme.bold(prefix.slice(0, -1)) + prefix.slice(-1));
}

/**
 * 给**一行命令**上色：`prefix` 整段按**结构符**上色（`Run ` = `toolTitle`、`│ ` / 两格缩进 =
 * `muted`，见 `styleCommandPrefix`），`body` 是**不含前缀**的正文，按 token 上色。高亮关掉时
 * 正文整段 `toolTitle` + 粗体（改动前的观感，只是前缀换成了 `Run `）。
 *
 * 前缀的颜色**必须在这一段就闭合**（`\x1b[39m`，由 `theme.fg` 自己收尾）：`│ ` 是**结构符**
 * 而不是正文；要是让后面的 token 色透到前缀上，路径那行的 `│` 就会跟 path 色一起飘
 *（实测踩过）。
 *
 * `sourceStart` 是 `body` 起点在**源行**里的字符偏移 —— token 的偏移也是源行坐标，折行
 * 碎片从源行任意位置开始，所以必须带着走，否则续行的语法高亮会整体错位。
 */
function styleCommandLine(prefix: string, body: string, tokens: ShellToken[] | null, sourceStart: number, theme: any): string {
	const head = styleCommandPrefix(prefix, theme);
	if (!tokens) return head + theme.fg("toolTitle", body);

	// 正文一律不加粗（只有 `Run` 那个词是粗体，见 styleCommandPrefix）
	const style = (kind: ShellTokenKind, chunk: string) => {
		const color = SHELL_TOKEN_COLORS[kind];
		return color === null ? chunk : theme.fg(color, chunk);
	};

	const sourceEnd = sourceStart + body.length;
	let out = head;
	let cursor = sourceStart;
	for (const token of tokens) {
		if (token.end <= cursor) continue;
		if (token.start >= sourceEnd) break;
		const from = Math.max(token.start, cursor);
		const to = Math.min(token.end, sourceEnd);
		if (from > cursor) out += body.slice(cursor - sourceStart, from - sourceStart);
		out += style(token.kind, body.slice(from - sourceStart, to - sourceStart));
		cursor = to;
	}
	// token 连续覆盖整行，所以正常走不到这里；真走到就按老样子兜底，不丢字符
	if (cursor < sourceEnd) out += theme.fg("toolTitle", body.slice(cursor - sourceStart));
	return out;
}

/**
 * 把行尾一个可见字符换成 `…`：`prefix + text` 的可见宽度保持不变（空正文原样返回）。
 *
 * 为什么不用 `truncateToWidth(row, budget, ELLIPSIS)`：目标串已经**装满**预算时它直接
 * 原样返回（`visibleWidth <= maxWidth` 就不动），而行满恰恰是最常见的溢出形态。
 * 宽字符占 2 列、装不下时会白空 1 列，可接受（与 `hardWrapRows` 的断行规则同源）。
 */
function ellipsizeTail(prefix: string, text: string, budget: number): string {
	if (text === "") return text;
	const limit = Math.max(1, budget - visibleWidth(prefix));
	let out = "";
	let used = 0;
	for (const { segment } of graphemeSegmenter.segment(text)) {
		const w = visibleWidth(segment);
		if (used + w > limit - 1) break;
		out += segment;
		used += w;
	}
	return out + ELLIPSIS;
}

/**
 * 渲染一条命令（可能多源行）：折行到 `limit` 个视觉行，装不下的归 `hiddenLines`。
 *
 * 前缀：第 1 条源行用 `firstPrefix`（`Run `）起头，它折出来的续行、以及后面每条源行都用
 * `linePrefix`（`│ ` 或两格缩进）—— 于是续行的正文对齐到 `Run ` 的 `n` 列（见文件头）。
 *
 * 规则（详见文件头「命令行：2 行 + `Run ` 前缀」）：
 *   ① **只要有溢出**，最后保留的那个视觉行末尾就换成 `…`（不管溢出的是一行的尾巴
 *      还是后面几行）；没溢出就一个 `…` 也不画；
 *   ② `hiddenLines` = 最后保留行**之后**还剩多少个视觉行：本条源行折到但没显示的碎片各
 *      算 1 行，后面每条没轮到的源行再各算 1 行。
 *
 * 折行、截断都在**纯文本**上做（`hardWrapRows` / `ellipsizeTail` 负责自带前缀的宽度），
 * 最后才逐行上色 —— 反过来会把 SGR 序列从中间切断。
 */
function renderCommandLines(
	lines: string[],
	firstPrefix: string,
	linePrefix: string,
	firstRowBudget: number,
	restRowBudget: number,
	openQuote: string | null,
	highlight: boolean,
	limit: number,
	theme: any,
): CommandRender {
	// 先全部按**纯文本**摆好（前缀 + 折行 + 行尾 `…`），最后一步再上色 —— 行尾 `…`
	// 必须在纯文本上放，否则会把 SGR 序列从中间切断
	const pending: PendingRow[] = [];
	let hiddenLines = 0;
	let hiddenTail = 0;
	let quote = openQuote;

	for (let index = 0; index < lines.length; index++) {
		if (pending.length >= limit) {
			// 后面每条源行都算一行没显示（它自己折几行不改变这个事实）
			hiddenLines += lines.length - index;
			break;
		}
		const line = lines[index]!;
		// 第 1 条源行用 `Run ` 起头，其余源行用它自己的续行前缀
		const head = pending.length === 0 ? firstPrefix : linePrefix;
		const rows = hardWrapRows(line, head, linePrefix, Math.max(1, pending.length === 0 ? firstRowBudget : restRowBudget), restRowBudget);
		// 引号状态同上一条源行一样跨行保留（分词只影响上色，与摆行顺序无关）
		const tokenized = highlight ? tokenizeShellLine(line, quote) : { tokens: null, openQuote: quote };
		quote = tokenized.openQuote;

		const room = limit - pending.length;
		const take = Math.min(rows.length, room);
		for (let i = 0; i < take; i++) {
			const row = rows[i]!;
			pending.push({
				text: row.text,
				prefix: row.prefix,
				sourceStart: row.start,
				tokens: tokenized.tokens,
				budget: row.prefix === firstPrefix ? firstRowBudget : restRowBudget,
			});
		}
		if (rows.length > take) {
			// 本条源行还有碎片没放下：它们就是“没显示的视觉行”
			hiddenTail = rows.length - take;
			break;
		}
	}

	hiddenLines += hiddenTail;
	if (hiddenLines > 0 && pending.length > 0) {
		// 还剩内容没显示：最后保留的那行末尾换成 `…`（宽度不变）
		const last = pending[pending.length - 1]!;
		last.text = ellipsizeTail(last.prefix, last.text, last.budget);
	}

	return {
		lines: pending.map((row) => styleCommandLine(row.prefix, row.text, row.tokens, row.sourceStart, theme)),
		hiddenLines,
	};
}

type ShellTokenKind = "space" | "comment" | "operator" | "command" | "flag" | "string" | "path" | "variable" | "word";

/** 一个词法单元；`start`/`end` 是**源行内**的字符偏移（不含 `$ ` 前缀）。 */
interface ShellToken {
	kind: ShellTokenKind;
	start: number;
	end: number;
}

/** token → 主题色槽。`null` = 不上色（空白原样输出）。 */
const SHELL_TOKEN_COLORS: Record<ShellTokenKind, ThemeColor | null> = {
	space: null,
	comment: "syntaxComment",
	operator: "syntaxOperator",
	command: "syntaxFunction",
	flag: "syntaxKeyword",
	string: "syntaxString",
	path: "syntaxString",
	variable: "syntaxVariable",
	word: "syntaxString",
};

/** `$VAR` / `${VAR}`。 */
const SHELL_VAR_PATTERN = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;
/** 赋值：`NAME=`。 */
const SHELL_ASSIGN_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * 操作符，**先长后短**按顺序取第一个匹配。重定向那条带可选的数字 fd，所以
 * `2>&1` 会被切成 `2>&`（操作符）+ `1`（词）而不是把 `2` 当成参数。
 */
const SHELL_OPERATOR_PATTERNS = [/^&&/, /^\|\|/, /^\|&/, /^;;/, /^<<-?/, /^\d*(?:>>|>&|<&|<|>)/, /^[|&;()]/];
/** 能起头的操作符字符（粗筛用，避免对每个字符都跑一遍正则 —— 长命令行下是 O(n²)）。 */
const SHELL_OPERATOR_CHARS = new Set(["|", "&", ";", "(", ")", "<", ">"]);
/** 这些操作符后面接的是新命令（`cmd1 | cmd2`），其余（重定向等）后面接的是参数。 */
const SHELL_COMMAND_NEXT_OPS = new Set(["|", "||", "&&", ";", "&", "|&", "("]);

function stripOuterQuotes(word: string): string {
	const match = /^(['"])([\s\S]*)\1$/.exec(word);
	return match ? match[2]! : word;
}

/** 纯数字后面紧跟 `<`/`>` 才是 fd 重定向（`2>`）；否则 `foo2` 里的 `2` 属于词。 */
function isFdRedirectAt(line: string, pos: number): boolean {
	let j = pos;
	while (j < line.length && line[j]! >= "0" && line[j]! <= "9") j++;
	const next = line[j];
	return next === "<" || next === ">";
}

/** 在 `pos` 处匹配一个操作符；不是操作符返回 null。 */
function matchShellOperatorAt(line: string, pos: number): string | null {
	const char = line[pos]!;
	if (!SHELL_OPERATOR_CHARS.has(char) && !(char >= "0" && char <= "9")) return null;
	const rest = line.slice(pos);
	for (const pattern of SHELL_OPERATOR_PATTERNS) {
		const match = pattern.exec(rest);
		if (match) return match[0];
	}
	return null;
}

/**
 * 词的归类。顺序有意义：赋值 > 引号串 > 选项 > `$VAR` > 路径 > 命令/参数。
 * `"--foo"` 算引号串而不是选项；`$HOME/x` 算变量而不是路径（`$` 优先）。
 */
function classifyShellWord(word: string, commandExpected: boolean): ShellTokenKind {
	const normalized = stripOuterQuotes(word);
	if (SHELL_ASSIGN_PATTERN.test(normalized)) return "variable";
	if (word.startsWith("'") || word.startsWith('"')) return "string";
	if (word.startsWith("-") && word.length > 1) return "flag";
	if (SHELL_VAR_PATTERN.test(normalized)) return "variable";
	// 含 `/` 就是路径；额外的分支覆盖裸的 `.` / `..` / `~`
	if (normalized.includes("/") || /^\.{1,2}(?:\/|$)/.test(normalized) || normalized.startsWith("~/")) return "path";
	return commandExpected ? "command" : "word";
}

/**
 * 给一条源行分词。token **连续覆盖整行**（含空白 token），所以折行碎片可以直接按
 * 偏移切片上色，不用再去猜碎片和 token 的对应关系。
 *
 * `openQuote` 是上一条源行留下的未闭合引号：多行字符串的第二行整段算 string，
 * 不会被当成一条新命令重新分词。分词**不会失败**（不像参照插件那样返回 undefined
 * 退回 highlightCode）—— 引号没闭合就一路吃到行尾并把状态传给下一条源行。
 */

/**
 * 给**一行命令**上色：`prefix` 整段 `toolTitle` 正常色（`Run ` / `│ ` / 两格缩进），`body`
 * 是**不含前缀**的正文，按 token 上色。高亮关掉时正文整段 `toolTitle` + 粗体（改动前的
 * 观感，只是前缀换成了 `Run `）。
 *
 * `sourceStart` 是 `body` 起点在**源行**里的字符偏移 —— token 的偏移也是源行坐标，折行
 * 碎片从源行任意位置开始，所以必须带着走，否则续行的语法高亮会整体错位。

/** pi 的 agent 目录（`PI_CODING_AGENT_DIR` 可覆盖，否则 `~/.pi/agent`）。 */
function resolveAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	return envDir ? (envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir) : join(homedir(), ".pi", "agent");
}

/**
 * `app.tools.expand` 的键名文本，给自建的提示行用。
 *
 * 为什么不直接用 pi 导出的 `keyText` / `keyHint`：扩展里 `import` 到的
 * `@earendil-works/pi-coding-agent` / `pi-tui` 是 loader alias 指向的 **npm/dist 副本**，
 * 与 pi 运行时（bundle）用的是两个不同的模块实例。实测（在 `~/.pi/agent/npm` 下直接
 * `node` 跑）：`keyHint("app.tools.expand", "to expand")` **直接抛**
 * `Theme not initialized. Call initTheme() first.`（它读的是副本自己的 theme 单例，
 * 而 pi 只初始化了 bundle 那份），`keyText(...)` 则返回 `""`（副本的 keybindings
 * 表是空的）。而 renderResult 抛异常会被 pi 静默 catch 并退回 `createResultFallback()`，
 * 整个自定义渲染就没了 —— 所以这两个函数绝不能 import，只能读配置文件。
 *
 * 默认值 `ctrl+o` 就是 pi 的默认绑定（`docs/keybindings.md` 的 `app.tools.expand` 行）。
 */
function expandKeyText(): string {
	try {
		const parsed = JSON.parse(readFileSync(join(resolveAgentDir(), "keybindings.json"), "utf8"));
		const bound = parsed?.["app.tools.expand"];
		const keys = Array.isArray(bound) ? bound : [bound];
		const text = keys.filter((k: unknown): k is string => typeof k === "string" && k.trim() !== "").join("/");
		if (text) return text;
	} catch {
		// 没配置文件 / 解析失败 / 没绑这个键，都用默认值
	}
	return "ctrl+o";
}

/**
 * 归一耗时页脚门槛（毫秒）：未设置 / 空串 / 非法值（NaN、负数）一律落到默认 2000；
 * **`0` 是合法值**（永远显示，等于关掉这个优化）—— 所以不能用 `value || DEFAULT` 那种写法。
 * 与 `clampPreviewLines` 一样在扩展注册时读一次。
 */
function resolveMinTimeFooterMs(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return DEFAULT_MIN_TIME_FOOTER_MS;
	const value = Number(raw.trim());
	return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MIN_TIME_FOOTER_MS;
}

/**
 * 把输出预览行数归一到 1-50 的整数；非法值（NaN / <=0 / 小数）一律落到默认 3。
 * 刻意用 Number 而不是 parseInt：parseInt("2.5") 会静默变成 2，而这里是归一到默认。
 */
function clampPreviewLines(value: number): number {
	if (!Number.isFinite(value) || value < 1 || value > 50 || !Number.isInteger(value)) return DEFAULT_OUTPUT_PREVIEW_LINES;
	return value;
}

/**
 * 读 shellPath / shellCommandPrefix 设置，让覆盖后的 bash 工具和内置工具行为一致
 * （内置工具由 AgentSession 用 settings 里的这两个值构造）。
 */
function readShellOptions(): BashToolOptions {
	const paths = [join(resolveAgentDir(), "settings.json"), join(process.cwd(), ".pi", "settings.json")];

	const merged: Record<string, unknown> = {};
	for (const path of paths) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (parsed && typeof parsed === "object") Object.assign(merged, parsed);
		} catch {
			// 缺文件 / 解析失败都按默认值处理
		}
	}

	const options: BashToolOptions = {};
	if (typeof merged.shellPath === "string" && merged.shellPath) {
		options.shellPath = merged.shellPath.startsWith("~") ? join(homedir(), merged.shellPath.slice(1)) : merged.shellPath;
	}
	if (typeof merged.shellCommandPrefix === "string") {
		options.commandPrefix = merged.shellCommandPrefix;
	}
	return options;
}

/**
 * 剥掉组件渲染结果的前导空行。
 *
 * 内置 bash 的 renderResult 会在输出前插一个前导空行（`new Text("\n" + styledOutput)`），
 * 在默认 shell 下那是“命令与输出之间的一行间距”；但本扩展走 self 模式，命令与输出是
 * 两个独立的块，这一行会叠上两个 Box 各自的 paddingY，变成三行空白（实测）。
 * 用户 2026-09-21 定的形状里命令与输出要**紧贴**，所以这一行照旧剥掉。
 * 先判 ANSI 再 trim：行里可能带前景色转义序列，直接 trim() 不会为空。
 * 只剥**前导**空行：输出与 "Took" 之间那个空行（也是 `\n` 前缀）刻意保留，
 * 用来分隔正文与耗时页脚。
 */
function stripLeadingBlanks(inner: any) {
	return {
		render(width: number): string[] {
			const lines: string[] = inner.render(width);
			let i = 0;
			while (i < lines.length && lines[i].replace(/\x1b\[[0-9;]*m/g, "").trim() === "") i++;
			return i > 0 ? lines.slice(i) : lines;
		},
		invalidate() {
			inner.invalidate?.();
		},
	};
}

/**
 * 给命令的每一行补上**块左边距**（`• ` + 一列，见文件头「命令行首行的状态圆点」）：首行是
 * 状态圆点 `•` + 一个空格，其余行是两个空格。
 *
 * 为什么这几格得由扩展自己画、而不是让 `Box` 的 `paddingX` 去补：`Box` 补出来的空白是**每行
 * 都一样**的，首行想要圆点就没地方画了。所以调用侧的 `Box` 用 `paddingX: 0`，左边距搬到这里
 * —— 于是首行是 `• Run …`、续行是 ` │ …` / `   …`，`Run` 的 `R`（列 2）与续行 / 结果树的
 * `│` `└`（也列 2）对齐，所有正文列（列 4）也对齐。
 *
 * 结果侧那条路径（`withPreviewLimit` / `prefixTreeLines`）挂的是同一份缩进，只是没有圆点 —— 用户 2026-09-21
 * 第二轮定要把两侧一起右移一列，所以两边的宽度预算必须一起改（见 `INDENT_WIDTH`）。
 *
 * 搬进来之后孩子的渲染宽度比 `Box` 时宽，所以调用方要自己把用掉的列扣回去
 *（`renderCall` / `withPreviewLimit` 里的 `width - GUTTER_WIDTH - INDENT_WIDTH`）。
 */
function withHeadBar(lines: string[], bar: string): string[] {
	return lines.map((line, index) => (index === 0 ? `${bar} ${line}` : `  ${line}`));
}

/**
 * 这条命令当前该用哪个槽的颜色画那颗状态圆点（用户 2026-09-21 定；字形从 `▎` 换成 `•`
 * 时**着色逻辑一字未动**）：
 *
 *   - 执行中（`isPartial`）→ `dim`（暗灰）
 *   - 执行完且成功 → `toolDiffAdded`（diff 新增行的绿）
 *   - 执行完且失败 → `toolDiffRemoved`（diff 删除行的红）
 *
 * 三个槽 pi 的 theme schema 都**必需**（内置 dark / light 与三个自建皮肤都有），所以
 * 不像 `bashOutput` 那样需要探测；取的是**前景** ANSI，后面补一个 `\x1b[39m` 收尾，
 * 颜色不会洇到后面的 `Run` 上。
 */
function stateBarAnsi(theme: any, isPartial: boolean, isError: boolean): string {
	const slot: ThemeColor = isPartial ? "dim" : isError ? "toolDiffRemoved" : "toolDiffAdded";
	return `${theme.getFgAnsi(slot)}\u2022\u001b[39m`;
}

/**
 * 树形 gutter 占的列数（`│ ` / `└ ` = 1 个 box-drawing 字符 + 1 个空格 = 2 列）。
 * 输出子组件必须按 `width - GUTTER_WIDTH - INDENT_WIDTH` 渲染，否则加上前缀就超宽。
 */
const GUTTER_WIDTH = 2;
/**
 * 整块**左边距**里、gutter 之外多让出来的那一列（用户 2026-09-21 第二轮定的：
 * 正文整体再右移一格，`• Run …` 而不是 `▎Run …`）。
 *
 * 命令侧与结果侧**用的是同一个值**：命令行首行是 `• `（圆点 + 空格）、结果树每行前面多这一格
 *（命令行的续行前缀 `│ ` 已经自带一个空格，所以它只在 `COMMAND_PROMPT` 的左侧再加这一列）。
 * 两边同宽才不会让命令与结果错开 —— 改一边必须改另一边。
 */
const INDENT_WIDTH = 1;
/** 树里“还有下文”的行：命令续行、命令折叠标记、输出的截断提示。 */
const GUTTER_PIPE = COMMAND_CHAIN;
/** 树里“正文内容”的续行缩进（与 `└ ` 等宽 + 块左边距，正文对齐）。 */
const GUTTER_BODY = COMMAND_INDENT + " ".repeat(INDENT_WIDTH);
/** 整块左边距里 gutter 之外的那一列（`INDENT_WIDTH` 个空格），挂在**每一行**结果前面。 */
const INDENT = " ".repeat(INDENT_WIDTH);

/**
 * 输出预览自己补的那条截断提示（`… (N earlier lines, <key> to expand)`）的形态。
 */
function isPreviewHintLine(line: string): boolean {
	const plain = stripAnsiCodes(line);
	// `... ` 是 pi 内置的写法（`truncateToWidth` 的省略号），`… ` 是我们在
	// `trimPreviewLines` 里改写的那个，两种形态都要认。
	return (plain.startsWith("... (") || plain.startsWith(`${ELLIPSIS} (`)) && plain.includes("earlier lines");
}

/**
 * 这个（剥掉 SGR 后的）纯文本是不是 pi 的**失败状态行**。
 *
 * pi 把命令的失败状态**焊死在输出正文里** —— `core/tools/bash.ts` 三处
 * `throw new Error(appendStatus(text, status))`，而 `appendStatus` 是
 * `` `${text ? `${text}\n\n` : ""}${status}` ``。三个 status：退出码非 0 / 超时被杀 / 被中断，
 * 都是失败。
 *
 * 结果里没有独立字段、`details` 里也没标记，**想单独给它上色只能按文本形态认**。所以调用方
 * 还得用 `context.isError` 把“真的是错的那次”加上 —— 本函数只管形态那半边（见文件头
 * 「失败状态」一节）。
 */
function isFailureStatusLine(line: string): boolean {
	const plain = stripAnsiCodes(line).trim();
	return /^Command (?:exited with code \d+|timed out after [\d.]+ seconds|aborted)$/.test(plain);
}

/**
 * 把失败状态行换成 `error` 前景色（`prefixTreeLines` 上树前调用，只动颜色、不动文本）。
 *
 * pi 写的是 `theme.fg("toolOutput", line)`（默认 gray）—— 那一行只有一个 SGR 前缀、末尾
 * 一个 `\u001b[39m`，所以直接拆掉重包一层 `error` 就行（不会丢内层样式：这一行本来就
 * 没有）。行尾补白原样接回去，于是可见宽度不变。
 */
function colorizeFailureStatus(line: string, theme: any): string {
	if (!isFailureStatusLine(line)) return line;
	const padding = /\s+$/.exec(line)?.[0] ?? "";
	return theme.fg("error", stripAnsiCodes(line).replace(/\s+$/, "")) + padding;
}

/**
 * 把**整块结果**的行数组画成树形：**第一个实质内容行**挂 `└ `，它前面的行（截断提示）
 * 挂 `│ `，它后面的行缩进两格（`  `），空行原样保留。
 *
 * 用户定的形状（2026-09-21）：`└ ` 在**整块结果里只出现一次**、就在第一个实质输出行上；
 * 那之下的内容行（第二行正文、warnings、`Took Xs` 页脚）不再画竖线，只用等宽缩进对齐
 * 正文 —— 树在 `└` 那里就“落地”了，不再向下延伸：
 *
 * ```
 * Run cat big.txt
 * │ … (12 earlier lines, ctrl+o to expand)
 * └ line 12
 *   line 13
 * ```
 *
 * 三个不能想当然的点：
 *   ① **必须在所有 child 的行走完后再统一上前缀**（不能逐 child 各画一棵树）：
 *     `└ ` 只能在整块里出现一次，逐 child 画会让第二段（warnings / 页脚）又长出一个
 *     `└ ` —— 实测过，输出里会出现两行带拐角符的正文。
 *   ② **前导空行不上前缀**：那是命令与输出之间的分隔行（pi 的 `new Text("\n" + …)`），
 *     外层 `stripLeadingBlanks` 还要靠「这一行是空的」把它剥掉 —— 一旦挂上前缀就变成
 *     非空行，剥不掉了（行里可能带前景色转义序列，所以判空必须先剔 ANSI 再 trim，
 *     与 `stripLeadingBlanks` 的判法一致）。footer / warnings 段自己那个前导空行
 *     同理留成空行，当作结果内部的段落间距。
 *   ③ 截断提示行（`… (N earlier lines, …)`）在正文前面，所以它挂 `│ `（“下文还没完”），
 *     `└ ` 留给正文第一行。
 *   ④ **前缀自成一段 SGR**（`theme.fg("muted", GUTTER_PIPE)` 把它单独包起来），绝不让后面
 *     正文的颜色透上来 —— 拐角符 / 竖线是结构符，`└ ` 与它后面的正文因此是同一种灰。
 *   ⑤ **栅栏以上的空行也带 `│ `**（用户 2026-09-21 第二次报的：`│ … (326 earlier lines…)`
 *     与 `└ Node.js v26.4.0` 之间那个空行，光秃秃地空着就成了“断层”）。这类空行来自 pi 的
 *     预览窗口开头（`truncateToVisualLines` 从尾部倒着切，空行是原样带进来的）或失败状态
 *     前面的分隔空行；`prefixTreeLines` 在 `first`（第一个非空行）与 `start`（第一个实质
 *     内容行，或它上面的截断提示行）之间补 `│ `。**`└ ` 以下的空行不补** —— 树在那里就
 *     指到首行实质输出了，下面那截是缩进对齐的续行（更多输出、`[Full output: …]` 之类的
 *     warnings、`Took`），各自成段；再画竖线反而像树还没完（用户 2026-09-21 第三次反馈：
 *     `[Full output:` 上面那行不该有 `│`）。
 *
 * 为什么不用 `setText(child,…)` 直接改子组件：它的 render 缓存在**首次渲染时以传入
 * width 为准**，把前缀送进去会让正文被它自己再折一次行（ansi 感知的贪心词折行），
 * 于是“先折行、后上色”的硬折行外套就白做了。逐 child 渲染 + 行数组挂前缀不改变各行
 * 宽度，缓存与实际显示始终一致（详见 `withPreviewLimit`）。
 */
function prefixTreeLines(lines: string[], theme: any, isError = false): string[] {
	const isBlank = (s: string) => stripAnsiCodes(s).trim() === "";
	// 最前面那串空行是命令与结果之间的分隔行（`stripLeadingBlanks` 还得靠它判空），
	// 所以 `first` 之前的空行保持空行 —— 树的起点在 `start`（第一个实质内容行，或它前面的截断提示行）。
	let first = 0;
	while (first < lines.length && isBlank(lines[first]!)) first++;
	let start = first;
	while (start < lines.length && (isBlank(lines[start]!) || isPreviewHintLine(lines[start]!))) start++;
	if (start >= lines.length) return lines;
	// 栅栏**以上**（`first` 之后、`start` 之前）的空行补 `│ ` —— 用户 2026-09-21 定的：
	// 空行也不能把栅栏断开。这里的空行来自 pi 的预览窗口开头（`truncateToVisualLines`
	// 从尾部倒着切，空行是原样带进来的）或失败状态前面的分隔空行 —— 光秃秃地空着就是“断层”。
	// `└ ` **以下**的空行不再补：树在 `└ ` 那一行就指到首行实质输出了，下面那截是缩进对齐的
	// 续行（更多输出、`[Full output: …]` 之类的 warnings、`Took`），各自成段；
	// 再画竖线反而像树还没完（用户 2026-09-21 第二次反馈：`[Full output:` 上面那行不该有 `│`）。
	const pipeBlank = (i: number) => i > first && i < start;
	return lines.map((line, i) => {
		if (isBlank(line)) return pipeBlank(i) ? INDENT + theme.fg("muted", GUTTER_PIPE) + line : line;
		if (i < start) return INDENT + theme.fg("muted", GUTTER_PIPE) + line;
		if (i === start) return INDENT + theme.fg("muted", "└ ") + (isError ? colorizeFailureStatus(line, theme) : line);
		return GUTTER_BODY + (isError ? colorizeFailureStatus(line, theme) : line);
	});
}

/**
 * 耗时页脚的**纯文本形态**：`Took 0.1s`（执行完）/ `Elapsed 1.2s`（流式执行中，每秒跳）。
 * 小数位数由 pi 的 `formatDuration` 决定（`(ms / 1000).toFixed(1)`，恒为一位）。
 */
const TIME_FOOTER_PATTERN = /^(?:Took|Elapsed) \d+\.\d+s$/;

/** 去掉 SGR 转义序列（页脚那行是 `theme.fg("muted", …)` 包着的，判形态 / 判空都得先剥）。 */
function stripAnsiCodes(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * 这个 child 是不是 pi 画的**耗时页脚**（`new Text("\n" + theme.fg("muted", "Took 0.1s"), 0, 0)`）。
 *
 * 两条缺一不可：
 *   ① `setText` 存在 = 是 pi-tui 的 `Text` —— 不能用 `instanceof`，理由与预览组件那条鸭子
 *      判定完全相同（扩展 import 到的 pi-tui 是 loader alias 指向的 npm/dist 副本，与 pi
 *      运行时 bundle 里的 `Text` 不是同一个类对象，`instanceof` 跨实例必然 false）；
 *   ② 剥 ANSI、trim 之后正好是 `Took 0.1s` / `Elapsed 1.2s` 这个形态。
 * 位置条件（**必须是末位 child**）由 `shouldHideTimeFooter` 带着判：pi 的
 * `rebuildBashResultRenderComponent` 按「输出 → warnings → 页脚」的顺序 addChild，
 * 所以页脚恒为末位。两条一起才敢下结论说末位那个就是页脚 —— 只看末位会把「输出正文恰好
 * 是一行 `Took 1.2s`」删掉（展开态下正文就是一个 `Text`），只看形态则会把碰巧长得像的
 * 末位子组件删掉。
 */
function isTimeFooterChild(child: any): boolean {
	if (typeof child?.setText !== "function" || typeof child.text !== "string") return false;
	return TIME_FOOTER_PATTERN.test(stripAnsiCodes(child.text).trim());
}

/**
 * 该不该把耗时页脚整个丢掉：**短于门槛的执行不画那一行**（默认 2000ms，见
 * `DEFAULT_MIN_TIME_FOOTER_MS`）。
 *
 * `elapsedMs === undefined` 表示压根不知道耗时（`state.startedAt` 为空 —— `/resume` 恢复的
 * 历史块不调 `markExecutionStarted`）—— 那种情况下 pi 本来就没有页脚可画，所以一律返回
 * false、不动手：即展开态里「输出正文恰好是一行 `Took 1.2s`」不会被误删。
 * 门槛与耗时比的是**同一个量**（`endedAt - startedAt`，见 renderResult 里的 `elapsedMs`），
 * 不是页脚上那个四舍五入后的数字。
 */
function shouldHideTimeFooter(lastChild: any, elapsedMs: number | undefined, minTimeFooterMs: number): boolean {
	if (elapsedMs === undefined || elapsedMs >= minTimeFooterMs) return false;
	return isTimeFooterChild(lastChild);
}

/**
 * 把 pi 内置 bash 渲染器的**输出预览**从 5 行裁到 `previewLines` 行，给整块结果挂上树形
 * gutter，并在短命令上丢掉耗时页脚、在无输出时补一行 `(no output)`。
 *
 * pi 的行数写死在它的 `BASH_PREVIEW_LINES = 5`（模块私有常量，改不了，也没有
 * 设置项），所以只能在拿到它的组件之后做后处理。详见文件头「输出预览行数」一节。
 *
 * 做法：**逐个 child 渲染**而不是拿整个 Container 的平铺行数组 —— 平铺数组里分不清
 * 哪几行属于预览（预览行、warnings 行、Took 行都是纯文本 + 不同前景色，按颜色猜很
 * 脆弱）。child 结构实测过：输出非空时 `children[0]` 就是预览组件，行形状固定是
 * `["", (提示行?), ...预览行]`；后面的 warnings / `Took Xs` 都是 `Text` 实例
 *（各自的 `\n` 前缀渲染成一行空行 + 正文）。
 *
 * 预览组件的判定用**鸭子类型**（`typeof child.setText !== "function"`）而不是
 * `instanceof Text`：扩展 import 到的 pi-tui 是 loader alias 指向的 npm/dist 副本，
 * 与 pi 运行时（bundle）用的 Text 不是同一个类对象，`instanceof` 跨模块实例必然 false。
 *
 * 所有 child 的行先**原样拼进一个数组**，最后统一交给 `prefixTreeLines` 画一次树 ——
 * `└ ` 于是自然落在**第一个实质内容行**上（输出段里的第一行正文；截断提示行在它上面，
 * 挂 `│ `），后面的输出行 / warnings / `Took` 页脚都只缩进两格。
 *
 * **展开态（ctrl+o）整块跳过**：pi 那时用的是 `new Text("\n" + styledOutput)`，输出全在
 * 一个 child 里、行数也不裁，所以连树都不挂 —— 展开态要的就是原样完整输出。
 *
 * 耗时页脚的过滤（`shouldHideTimeFooter`）也在这里：末位 child 是 `Took X.Xs` 页脚、
 * 且实际耗时短于门槛时，把它整个跳过（连它那行前导空行一起 —— 那是正文与页脚之间的
 * 分隔行，页脚不画时不该留）。详见文件头「耗时页脚门槛」一节。
 */
function withPreviewLimit(
	inner: any,
	previewLines: number,
	theme: any,
	/** 展开态（ctrl+o）：整块按原样透传（不裁行、不挂树）。 */
	expanded: boolean,
	/** pi 当前给的是 partial 结果（流式中）—— 决定“还没输出”要不要画成 `(no output)`。 */
	isPartial: () => boolean,
	/** 这块结果是错的（`context.isError`）—— 只有它为真才认失败状态，免得误染正常输出。 */
	isError: boolean,
	/** 真实耗时（毫秒；`undefined` = pi 根本没画页脚）。 */
	elapsedMs: () => number | undefined,
	minTimeFooterMs: number,
) {
	return {
		render(width: number): string[] {
			const out: string[] = [];
			let trimmed = false;
			// 前缀占 gutter + 左边距共 3 列，所以**输出预览按 width - 3 渲染**：pi 的预览行是按
			// 传进去的宽度折行 / 截断的（`truncateToVisualLines` 内部用 `Text.render(width)`），
			// 按整宽渲染再加前缀就会超出终端宽度（`Box.applyBg` 只会裁，内容就丢了）。
			const contentWidth = Math.max(1, width - GUTTER_WIDTH - INDENT_WIDTH);
			// 耗时页脚的判定放在 render 里而不是拿组件时就算死：流式模式下 pi 每秒
			// `invalidate()` 一次（内置 renderResult 里那个 setInterval），跨过门槛的
			// 那一刻页脚就能出现，不用等下一次 partial 结果。
			let children: any[] = inner.children ?? [];
			if (shouldHideTimeFooter(children[children.length - 1], elapsedMs(), minTimeFooterMs)) {
				children = children.slice(0, -1);
			}
			// 展开态（ctrl+o）要的就是原样完整输出：不裁行、不挂 gutter。pi 那时用的是
			// `new Text("\n" + styledOutput)`，一个 child 装全部输出，直接透传 ——
			// 只把失败状态那行染红（用户要的是提示见红，展开态也该红）。
			// 左边距照挂（只挂 `INDENT_WIDTH` 那 1 列，没有 gutter）：展开态的输出正文列
			// 与折叠态一样落在列 2 那一族里，切换 ctrl+o 时整块不会横跳。
			if (expanded) {
				const expandedWidth = Math.max(1, width - INDENT_WIDTH);
				for (const child of children) {
					const rendered = child.render(expandedWidth) as string[];
					out.push(...(isError ? rendered.map((line) => colorizeFailureStatus(line, theme)) : rendered).map((line) => INDENT + line));
				}
				return out;
			}
			for (const child of children) {
				const isOutput = !trimmed && typeof child.setText !== "function";
				if (!isOutput) {
					// pi 对空输出一个 child 都不加（内置渲染器的 `if (output)` 守卫），
					// 于是用户只看见光秃的一行 `Run xxx`，分不清是“真的没输出”还是
					// “渲染坏了”。在**输出本该出现的位置**补一行 `(no output)`（用户样例
					// 里 `└ ` 就挂它前面），这样它排在 warnings / `Took` 之前。
					// **执行中不补**：流式模式 pi 会先发一个空 partial 快照
					//（`onUpdate({ content: [] })`），那时“还没输出”不等于“没有输出”。
					out.push(...(trimmed || isPartial() ? child.render(contentWidth) : [theme.fg("toolOutput", "(no output)"), ...child.render(contentWidth)]));
					continue;
				}
				trimmed = true;
				// **输出段按 contentWidth 渲染**：整块结果的行都要挂 2 列前缀，不先
				// 扣掉的话按整宽折出来的正文会顶出终端宽度。
				out.push(...trimPreviewLines(child.render(contentWidth), previewLines, contentWidth, theme, isError));
			}
			// 最后统一上树：`└ ` 在整块里只出现一次（见 prefixTreeLines ①）
			return prefixTreeLines(out, theme, isError);
		},
		invalidate() {
			inner.invalidate?.();
		},
	};
}

/**
 * 裁掉预览行里超出预算的部分（保留**尾部** —— pi 的预览本来就是输出的最后几行），
 * 并把被裁掉的行数补进提示行的计数。
 *
 * 提示行的两种情况：
 *   ① pi 已经给了提示行（输出 > 5 行）—— 就在它那一行**原地改数字**，
 *     这样 pi 的配色与真实键名（`keyHint` 渲出来的 dim 键名 + muted 描述）一字不动，
 *     不用重建样式。正则匹配的是 SGR 包裹里的纯 ASCII 数字与文本，所以直接在
 *     带样式的字符串上替换是安全的。
 *   ② pi 没给提示行（输出刚好 ≤ 5 行，但我们裁到了 3 行）—— 必须自己造一行，
 *     否则那 1~2 行就**静默消失**了。用传进来的 `theme`（pi 运行时真正初始化过的那份）
 *     复刻 pi 的格式与配色，键名读 `keybindings.json`（见 `expandKeyText`）。
 */
function trimPreviewLines(lines: string[], previewLines: number, width: number, theme: any, isError: boolean): string[] {
	if (lines.length <= 1) return lines;
	const head = lines[0]; // 前导空行（去留由外层 stripLeadingBlanks 决定）
	const body = lines.slice(1);
	const hintLine = isPreviewHintLine(body[0] ?? "") ? body[0] : undefined;
	const rows = hintLine ? body.slice(1) : body;

	// ① 尾部是 pi 的失败状态（见文件头「失败状态」一节）时，把它和它前面那一串分隔空行
	// 单独摘出来：那些空行没有信息量，不该吃预览预算（把状态自己挤出可视区的正是它们）。
	// **只在 `isError` 时认** —— 正常输出里出现同样字样（例如把这句话 echo 出来）不碰。
	let status: string | undefined;
	let separators: string[] = [];
	let content = rows;
	if (isError && rows.length > 0 && isFailureStatusLine(rows[rows.length - 1]!)) {
		status = rows[rows.length - 1];
		let cut = rows.length - 1;
		while (cut > 0 && isBlankResultLine(rows[cut - 1]!)) cut -= 1;
		separators = rows.slice(cut, rows.length - 1);
		content = rows.slice(0, cut);
	}

	// ② 预算：状态自己占一格，其余留给内容。
	const budget = Math.max(1, previewLines - (status === undefined ? 0 : 1));

	// ③ 窗口 = 内容的尾部 `budget` 行（pi 的预览本来保留的就是尾部）。窗口整段都是空行时
	// 往上拉，让最近一行正文留在窗口里 —— 空行不该把预览独吞。
	let start = Math.max(0, content.length - budget);
	let end = content.length;
	if (content.length > 0 && content.slice(start).every((line) => isBlankResultLine(line))) {
		let last = content.length - 1;
		while (last >= 0 && isBlankResultLine(content[last]!)) last -= 1;
		if (last >= 0) {
			start = Math.max(0, last - budget + 1);
			end = last + 1;
		}
	}
	const window = content.slice(start, end);

	// ④ 一行正文都留不下时（内容全被裁掉），把状态前面那串分隔空行补回来 —— 用户 2026-09-21
	// 定的形状：空行要带 `│`，而不是光秃秃的空白（见文件头 ⑤）。有正文时不补：
	// `└ ` 已经落在正文上，它下面再补一行 `│` 反而像没完。
	const fillers = window.length === 0 && status !== undefined ? separators.slice(-budget) : [];

	// 什么都没动（没状态、窗口就是全部内容、没补空行）→ 原样返回 `lines`：保住 pi 自己画的
	// 行（提示行的配色与折行宽度都是它定的）。只把提示行的省略号统一成 `…`。
	if (status === undefined && fillers.length === 0 && window.length === content.length && end === content.length) {
		return hintLine === undefined ? lines : [head, withOurEllipsis(hintLine), ...rows];
	}

	// ⑤ 提示行的计数 = pi 原来那个数（它窗口之上的视觉行）+ 我们没显示的内容行。
	// 状态前那串分隔空行不计（它们本来就不载信息：算进去会让一条内容全显示完的失败命令
	// 凭空多出一行 `(2 earlier lines)`，实测踩过）。
	const hidden =
		(hintLine ? Number(/(\(\s*)(\d+)(\s*earlier lines)/.exec(hintLine)?.[2] ?? 0) : 0) + (content.length - window.length);
	const rendered: string[] = [];
	if (hidden > 0) {
		const hint = hintLine
			? withOurEllipsis(hintLine.replace(/(\(\s*)(\d+)(\s*earlier lines)/, (_m, open, _count, tail) => `${open}${hidden}${tail}`))
			: theme.fg("muted", `${ELLIPSIS} (${hidden} earlier lines,`) +
			  (expandKeyText() === "" ? "" : ` ${theme.fg("dim", expandKeyText())}`) +
			  theme.fg("muted", " to expand)");
		rendered.push(truncateToWidth(hint, width, ELLIPSIS));
	}
	return [head, ...rendered, ...fillers, ...window, ...(status === undefined ? [] : [status])];
}

/** pi 的提示行用三个点（`truncateToWidth` 的省略号），本扩展统一成单个 `…`。 */
function withOurEllipsis(line: string): string {
	return line.replace("...", ELLIPSIS);
}

/** 结果里的一行（带样式）去掉 SGR 后是不是空的。 */
function isBlankResultLine(line: string): boolean {
	return stripAnsiCodes(line).trim() === "";
}

/**
 * 在**同步窗口**内把主题的 `toolOutput` 临时换成 `bashOutput`，让 pi 内置 bash 结果渲染器
 * 画出来的输出正文用上自己的颜色槽（详见文件头「输出正文的独立颜色」一节）。
 *
 * 为什么必须是「换主题表」而不是「把主题对象换给渲染器」：pi 的 bash 渲染器**根本不看传进去
 * 的那个 theme 参数**（`renderResult(result, options, _theme, context)`），它用的是模块级的
 * `theme` 单例（`Proxy` → `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]`）。
 * 那个单例与传给扩展的渲染器参数**是同一个对象**（单例就是为跨 loader 共用而设计的），
 * 所以直接改它的 `fgColors` 表，渲染器下一次 `theme.fg("toolOutput", line)` 就会命中新色值。
 *
 * 四个要点：
 *   ① **只在同步窗口内换**：`base.renderResult()` 是同步的，输出行（含展开态那份）全部在
 *      这次调用里 `theme.fg("toolOutput", …)` 烘焙成字符串，所以 try/finally 里换进换出
 *      不会有第二个渲染插进来；换颜色也**不会**泄漏给其他工具（read / grep 的输出是它们
 *      自己的渲染器画的，不在这个窗口里）。
 *   ② **主题里没有 `bashOutput` 就什么都不做**（内置主题与 pi-coder-summer-night / pi-coder-catppuccin 都没
 *      这个 token）—— 探测方式是真调一次 `theme.getFgAnsi()`，pi 对未知 token 抛
 *      `Unknown theme color: …`。
 *   ③ `fgColors` 是 pi `Theme` 类的公开字段（`Map<string, string>`，存的是**已解析的
 *      SGR 前缀**）；哪天 pi 把它藏起来/改名，这里就自动退化成原样调用（返回前那个
 *      `typeof … .set` 判定），不会抛异常、只是颜色不生效。
 *   ④ 只动 `toolOutput`：命令标题 / `... (N earlier lines …)` 提示 / `Took Xs` 页脚走的是
 *      `toolTitle` / `muted`，命令行与折叠提示是扩展自绘的，一律不受影响。
 */
function withBashOutputColor<T>(theme: any, render: () => T): T {
	const fgColors = theme?.fgColors;
	if (typeof fgColors?.set !== "function" || typeof fgColors?.get !== "function") return render();
	let override: string;
	try {
		override = theme.getFgAnsi("bashOutput");
	} catch {
		return render();
	}
	const previous = fgColors.get("toolOutput");
	fgColors.set("toolOutput", override);
	try {
		return render();
	} finally {
		if (previous === undefined) fgColors.delete("toolOutput");
		else fgColors.set("toolOutput", previous);
	}
}

export default function (pi: ExtensionAPI) {
	// 折叠固定开启、保留 DEFAULT_LINES 个视觉行（原先的 `/bash-collapse` 指令已删除）。
	// 输出预览行数：pi 内置写死 5（`BASH_PREVIEW_LINES`，模块私有常量 + 无设置项），
	// 所以只能在扩展里后处理。/bash-preview 可改；PI_BASH_PREVIEW 启动时覆盖。
	let previewLines = clampPreviewLines(Number(process.env.PI_BASH_PREVIEW));
	// 耗时页脚门槛（毫秒）：短于它的执行不画 `Took X.Xs` 那一行（详见文件头「耗时页脚门槛」）。
	// PI_BASH_MIN_TIME_MS=0 永远显示。与 previewLines 一样在注册时读一次。
	// 流式输出开关：默认关（非流式，对齐 opencode / codex）。PI_BASH_STREAM=on 恢复 pi 原生流式。
	const streaming = process.env.PI_BASH_STREAM?.trim().toLowerCase() === "on";
	// 耗时页脚门槛（毫秒）：短于它的执行不画 `Took X.Xs` 那一行（详见文件头「耗时页脚门槛」）。
	// PI_BASH_MIN_TIME_MS=0 永远显示。与 previewLines 一样在注册时读一次。
	const minTimeFooterMs = resolveMinTimeFooterMs(process.env.PI_BASH_MIN_TIME_MS);
	// 命令语法高亮开关：默认开。PI_BASH_HIGHLIGHT=off 启动时关闭（回到整行 toolTitle 粗体）。
	// 刻意**不注册 /bash-highlight 指令** —— 这是个纯观感开关，env 一个入口就够，
	// 没必要再占一条斜杠指令（与 /bash-preview / /bash-timeout 那种要随时查看的不同）。
	// 展开态（ctrl+o）与折叠态走同一套分词，所以开关对两边同时生效。
	const highlightEnabled = process.env.PI_BASH_HIGHLIGHT?.trim().toLowerCase() !== "off";

	// ## 能力边界（seatbelt 沙箱）开关
	//
	// 两道独立的闸，取与：
	//   1. `sandboxOn`（注册期读一次）：PI_SANDBOX=off 整体关闭；非 darwin 平台自动关闭
	//      （没有 sandbox-exec，宁可没有这层保护也不要让命令因为找不到二进制而全部失败）。
	//      注册时读一次是刻意的：这是个启动期开关，运行中改 env 不该让同一条命令忽而
	//      沙箱忽而不沙箱。
	//   2. `getSandboxMode() === "dangerous"`（**执行期**读）：plan-mode 的三态模式。
	//      dangerous 是 pi 原生的任意权限形态，只能由用户 shift+tab 切到，所以它必须
	//      在执行期判定 —— 注册期读一次就永远切不动了。plan-mode 没装时单例恒为默认的
	//      bypass，这一道永远放行，行为与三态化之前完全一致。
	const sandboxOn = isSandboxEnabled();
	// 沙箱内用哪个 shell 跑原命令。跟 readShellOptions() 保持一致：用户配了 shellPath 就用它，
	// 否则 /bin/bash。注意这是**沙箱内**的 shell，与 pi 自己 spawn 的外层 shell 无关。
	const sandboxShellPath = readShellOptions().shellPath || "/bin/bash";
	// 持久白名单（`~/.pi/agent/sandbox-allowlist.json`，`PI_SANDBOX_ALLOWLIST` 可改位置）。
	// 与 sandbox-boundary 扩展共用同一个 globalThis 单例，所以一边记住另一边立刻生效。
	const allowlistPath = process.env.PI_SANDBOX_ALLOWLIST?.trim() || join(getAgentDir(), "sandbox-allowlist.json");
	// 路径分类需要的 IO（realpath / isDirectory）由这里注入，sandbox.ts 保持纯逻辑。
	const pathEnv: PathEnv = {
		home: homedir(),
		realpath: (p) => {
			try {
				return realpathSync(p);
			} catch {
				return undefined; // 目标不存在（已被删）：只做词法判定
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
	const sessionScopes = getSessionScopes();
	/** 取白名单 store。env 只在首次创建时用于加载过滤。 */
	const allowlist = (): AllowlistStore => getAllowlistStore(allowlistPath, pathEnv);

	/**
	 * 给**整体成功**的命令结果补一行 `[沙箱]` 说明：`rm <越界> ; <成功命令>` 形状里
	 * 删除被内核 EPERM 拒了但退出码 0，catch 分支（弹框）走不到，拒绝被静默吞掉。
	 * 这里不弹框不重跑（用户 2026-09-26 定：只加提示）—— 命令本身仍算成功，
	 * 只在结果末尾追加被拦路径与授权出口，让模型和用户都看得见。
	 * 判定与误报过滤全在 `maskedDenialPaths`（见其文件内注释）。
	 */
	function annotateMaskedDenial<T extends { content?: Array<{ type: string; text?: string }> }>(
		result: T,
		boundary: WriteBoundary,
	): T {
		const text = (result.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n");
		const masked = maskedDenialPaths(text, {
			boundary,
			allowedRoots: allowlist().roots(),
			sessionRoots: sessionScopes.roots(),
			env: pathEnv,
			exists: (p) => {
				try {
					statSync(p);
					return true;
				} catch {
					return false;
				}
			},
		});
		if (masked.length === 0) return result;
		const note =
			`\n\n[沙箱] 命令整体成功，但以下删除被沙箱拦下（文件仍在）：${masked.join("、")}。` +
			`如需删除，用 /sandbox-boundary allow <目录> 授权后重试。` +
			`可删边界：${writableRoots(boundary).join("、")}`;
		return { ...result, content: [...(result.content ?? []), { type: "text", text: note }] };
	}

	// cwd 只是兜底：内置 execute 用的是 ctx.cwd（每次调用的当前 session cwd）。
	const base: ToolDefinition<any, any, any> = createBashToolDefinition(process.cwd(), readShellOptions());

	pi.registerTool({
		name: base.name,
		label: base.label,
		// 照抄 Claude Code：把默认期限和上限**写进工具描述**告诉模型，否则模型不知道
		// 可以传 timeout，长命令就会被默认期限杀掉却不知道该调大。
		// （内置描述结尾本来只是 "Optionally provide a timeout in seconds."，没给数字。）
		description: `${base.description} By default, your command will time out after ${defaultTimeoutSeconds()} seconds. You may specify an optional timeout in seconds (up to ${maxTimeoutSeconds()} seconds); larger values are clamped to that maximum.`,
		parameters: base.parameters,
		// prompt 元数据不会从内置工具继承，必须显式带上
		promptSnippet: base.promptSnippet,
		promptGuidelines: base.promptGuidelines,
		constrainedSampling: base.constrainedSampling,
		executionMode: base.executionMode,
		prepareArguments: base.prepareArguments,
		// `renderShell: "self"` 是为了让“流式接命令字符时屏幕上一行都不出”成为可能。
		// 默认 shell 下 ToolExecutionComponent 构造里常驻一个 `Spacer(1)`，而 render() 走
		// `super.render(width)`（Container）会把所有子组件都画出来 —— 所以即使 renderCall
		// 返回零行组件，仍会渲染出那一行空行（实测 `[""]`）。而 `hideComponent` 那条路
		// 走不到：updateDisplay() 里只要 callRenderer 成功返回组件就把 `hasContent` 置 true，
		// 三个分支全都置 true，所以末尾 `if (… && !hasContent …) hideComponent = true` 永远不成立。
		// self 模式下 render() 绕过 super.render()，只画 selfRenderContainer，于是那个 Spacer
		// 根本不会被渲染；且开头有 `contentLines.length === 0 → return []` 守卫，
		// 真正做到“空就什么都不出”。顺带一个**刻意保留**的副作用：pi 不再给整块套 bgFn
		//（默认 shell 下 contentBox 会套 toolPendingBg / toolSuccessBg / toolErrorBg），
		// 而我们自己也不套 —— 于是 bash 块**没有任何底色**（用户 2026-09-21 定的，见文件头
		// 「整块没有底色」）。其他工具走的不是这条路，它们的底色不受影响。
		renderShell: "self",
		// renderResult 委托内置 bash 的实现（输出预览 / 截断提示 / "Took Xs" 都是它画的），
		// 只在外层包一个**不带底色**的 Box 挂左边距，页脚那行则在 withPreviewLimit 里按门槛滤掉。
		// 注意传给内置的 `lastComponent` 必须是
		// **内层**组件而不是我们的 Box —— 内置实现会 `context.lastComponent ?? new
		// BashResultRenderComponent()` 然后对它 clear() / addChild()，喂个 Box 进去会嵌套错乱。
		// 所以内层组件存在 context.state 里跨次复用（state 本来就用来存 startedAt/endedAt/interval）。
		renderResult(result, options, theme, context) {
			const state = context.state;
			// renderCall 靠这个标记决定要不要自己补下边界空行（结果还没到时才补）。
			// 放在委托内置实现**之前**置位：万一内置实现抛异常，pi 会退回自己的
			// fallback 结果组件，那时下边界已经由它那边负责了。
			state.resultSeen = true;
			// 输出正文换用主题的 `bashOutput` 槽（主题没定义就原样；详见 withBashOutputColor）
			const inner = withBashOutputColor(theme, () =>
				base.renderResult(result, options, theme, { ...context, lastComponent: state.innerComponent }),
			);
			state.innerComponent = inner;
			// isError 必须从 **context** 读，不能从 result 读：pi 调 resultRenderer 时传的是
			// `{ content: this.result.content, details: this.result.details }`，**没有 isError 字段**
			// （tool-execution.js 的 updateDisplay），isError 只在 getRenderContext() 里
			// （`isError: this.result?.isError ?? false`）。读 result.isError 会永远拿到 undefined，
			// 于是失败的命令也会染成 success 底色。
			//
			// paddingY 必须用 0，且要剥掉 inner 的前导空行 —— 否则命令与输出之间会有
			// **三个**空行（实测过）：① callBox 的下 padding、② resultBox 的上 padding、
			// ③ 内置 renderResult 自己的 `new Text("\n" + styledOutput)` 前导空行。
			// 第③行在默认 shell 下是“命令与输出之间的一行间距”（那时两者在同一个
			// contentBox 里，只有这一行），但 self 模式下两者是两个独立的 Box，
			// 各自的 paddingY 会叠加上去，所以这里把三者全部去掉，让输出紧贴命令。
			// 整块外面也**不再补下边界空行**（用户 2026-09-21 定的：上下都不留白，
			// 见文件头「整块没有底色、没有 boundary 空行」）。
			// 耗时页脚门槛判据（见文件头「耗时页脚门槛」）：与 pi 画那行字用的是**同一个量**
			// —— `state.endedAt ?? Date.now()` 减 `state.startedAt`（内置 renderResult 刚在上面
			// 那次调用里补上了 endedAt）。做成**函数**、在 render 时才求值：流式模式下每秒
			// invalidate 一次，跨过门槛的那一刻页脚自然出现，不用等下一次 partial 结果。
			// startedAt 为空 = pi 根本没画页脚（`/resume` 恢复的历史块不调 markExecutionStarted），
			// 这时返回 undefined，过滤逻辑一律不动手。
			const elapsedMs = () => (state.startedAt === undefined ? undefined : (state.endedAt ?? Date.now()) - state.startedAt);
			// `new Box(1, 0)`：**只有 bgFn 去了**（bash 块不带底色 —— pending / 成功 / 失败三种底
			// 都不画，见文件头「整块没有底色」），`paddingX: 1` 保持不变 —— 结果侧那格左内边距是
			// 与命令行 `• ` 对齐用的（`withPreviewLimit` 再挂 `INDENT_WIDTH` 那一列），去掉整块会
			// 比命令行少一列；`paddingY: 0` 则让上下不留空行。
			const box = new Box(1, 0);
			box.addChild(
				stripLeadingBlanks(
					withPreviewLimit(inner, Math.max(1, Math.round(previewLines)), theme, options.expanded === true, () => options.isPartial === true, context.isError === true, elapsedMs, minTimeFooterMs),
				),
			);
			return box;
		},

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// 关流式就是把 onUpdate 摘掉：内置 execute 的每个更新点都有 !onUpdate 守卫，
			// 于是渲染器只会收到最后那次 final 结果。返回值与 details 不受影响。
			//
			// 同时把**有效期限**注进 params：pi 内置 bash 无默认 timeout，不注入的话
			// 一条不退出的命令会无限期挂着。注入只影响这次执行 —— session 里落盘的
			// toolCall.arguments 是模型原样发来的那份，不会被改写。
			const nextParams = { ...params, timeout: effectiveTimeoutSeconds(params?.timeout) };
			const runOnUpdate = streaming ? onUpdate : undefined;

			// ## 能力边界（seatbelt 沙箱）
			//
			// 强制点不是"枚举危险命令"，而是**操作系统**：命令在 sandbox-exec 里跑，
			// 写入不限制，只有**删除**收窄到项目目录 + 临时目录 —— 边界外的 unlink
			// 被内核直接 EPERM 拒绝（rename 也走 unlink，见 sandbox.ts 文件头）。
			// 于是正常操作一次都不弹窗，越界删除先失败 —— 失败之后才问用户。
			// 这是 Codex 的模型，也是唯一 fail-closed 的模型。
			//
			// 两层授权（用户 2026-09-24 定）：
			// - **危险目录**（系统根 / bin / 应用安装目录 / 配置类）每次必问，只支持会话级豁免；
			// - **普通目录**问一次，同意后把目录范围写进持久白名单，以后（含 headless）不再问。
			// 记住一个目录 = 把它并进 profile 的 `(allow file-write-unlink …)`，删除在沙箱内
			// 直接成功，命令的其余部分仍被沙箱管着 —— 所以常见路径零弹框零重跑。
			//
			// 包裹只发生在这个局部 params 副本上：session 落盘的仍是模型原样发来的命令，
			// 渲染器显示的也是原命令（不是那串 sandbox-exec 前缀）。
			const command = typeof params?.command === "string" ? params.command : "";
			// dangerous 模式（plan-mode 三态之一，只能 shift+tab 切到）：不包 seatbelt、
			// 不弹框、不标注被拦路径 —— 命令按 pi 原生形态直接跑。
			if (!sandboxOn || getSandboxMode() === "dangerous" || command.trim() === "") {
				return base.execute(toolCallId, nextParams, signal, runOnUpdate, ctx);
			}

			const boundary = boundaryFromEnv(ctx?.cwd ?? process.cwd());
			// profile 带上持久白名单 + 会话豁免：已授权的目录在命令执行前就进了放行名单，
			// 删除在沙箱内直接成功，不弹框也不重跑。
			const extraRoots = [...allowlist().roots(), ...sessionScopes.roots()];
			const wrapped = wrapWithSandbox(command, buildSeatbeltProfile(boundary, extraRoots), sandboxShellPath);

			let denialMessage: string | undefined;
			try {
				const result = await base.execute(toolCallId, { ...nextParams, command: wrapped }, signal, runOnUpdate, ctx);
				return annotateMaskedDenial(result, boundary);
			} catch (err) {
				// 内置 bash 在非零退出时 throw，输出正文就在 message 里 —— 那正是判定
				// "是不是沙箱拦的" 的地方。只认 EPERM / Operation not permitted：
				// `Permission denied` 是 EACCES（文件权限位），不是沙箱，拿它当升级信号
				// 会把"这文件本来就没权限"误报成"沙箱拦的"。
				const message = err instanceof Error ? err.message : String(err);
				if (!looksLikeSandboxDenial(message)) throw err;
				denialMessage = message;
			}

			// ---- 被沙箱拦下了：从失败输出里抽被拦路径，按目录走两层授权 ----
			const deniedPaths = extractDeniedPaths(denialMessage ?? "");
			if (deniedPaths.length === 0) {
				// 抽不出路径 → 猜不出目标就不许进按目录的记忆逻辑（AGENTS.md
				// 「Never derive a delete target」的同一口径）。
				//
				// 这里**不弹框**，也不拿到沙箱外裸跑：旧行为是「按整条命令会话级问一次，
				// 同意后整条命令在边界之外重跑」，而那个兜底分支正是 heredoc 误报
				// （`/bin/bash: cannot create temp file for here document: EPERM`）被抽成
				// 「要删 /bin/bash」后弹危险目录框的入口。`extractDeniedPaths` 现在用排除法
				// 从源头认不出这类非删除形状，抽不出路径就只剩两种可能：真不是删除
				// （exec 失败、嵌套沙箱不可用），或是我们认不出的删除形状 —— 两种都该
				// 原样报错，而不是把整条命令拿到整层边界之外裸跑（那等于为了一个认不出的
				// 目标交出全部删除能力）。出口是 `/sandbox-boundary allow <目录>`，
				// 授权后重试 —— 那条路径走的是同一个安全闸，不会把危险目录落盘。
				//
				// 交互与非交互（headless）走同一条路：原样报错 + 一行 `[沙箱]` 提示。
				throw new Error(
					`${denialMessage}\n\n[沙箱] 认不出被拦的具体路径，未弹确认框；` +
						`如确认要删，可用 /sandbox-boundary allow <目录> 授权后重试。` +
						`\n可删边界：${writableRoots(boundary).join("、")}`,
				);
			}

			const classification = classifyOutsidePaths(deniedPaths, {
				boundary,
				allowedRoots: allowlist().roots(),
				sessionRoots: sessionScopes.roots(),
				env: pathEnv,
			});

			// 永不删除档：**不弹框、无任何放行选项**。内核 deny 行已经把它拦下了
			// （`buildSeatbeltProfile` 在 allow 行之后收回），这里只负责把原因说清楚。
			// 交互与 headless 同一条路 —— 本来就没有「批准」这个动作可给。
			if (classification.blocked.length > 0) {
				throw new Error(
					`${denialMessage}\n\n[沙箱] 以下路径是永不删除的身份/凭据/手写配置，任何授权方式都不放行：\n` +
						classification.blocked.map((d) => `  ${d.path}（${d.reason}）`).join("\n") +
						`\n如确需删除，请自己在终端执行（或 PI_SANDBOX=off 整体关掉这一层）。`,
				);
			}

			if (classification.dangerous.length === 0 && classification.ordinary.length === 0) {
				// 全部已授权却仍被拦：白名单可能刚被另一侧（sandbox-boundary / 手动 allow）
				// 更新过，而本次的 profile 是更新前构建的。带上最新名单重跑一次；
				// 仍被拦就报错 —— 不循环，也不升级到沙箱外。
				const retryRoots = [...allowlist().roots(), ...sessionScopes.roots()];
				const retry = wrapWithSandbox(command, buildSeatbeltProfile(boundary, retryRoots), sandboxShellPath);
				try {
					const result = await base.execute(toolCallId, { ...nextParams, command: retry }, signal, runOnUpdate, ctx);
					return annotateMaskedDenial(result, boundary);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					if (looksLikeSandboxDenial(message)) {
						throw new Error(
							`${message}\n\n[沙箱] 已按白名单加宽仍被拒绝，可能是路径识别有误。` +
								`可用 /sandbox-boundary allow <目录> 手动授权后重试。`,
						);
					}
					throw err;
				}
			}

			// 有未授权的路径：非交互环境 fail-closed（持久白名单在 headless 下生效，
			// 能走到这里说明没有命中；危险目录与未授权的普通目录一律拒绝）。
			if (!ctx?.hasUI) {
				const denied = [...classification.dangerous.map((d) => d.path), ...classification.ordinary];
				throw new Error(
					`${denialMessage}\n\n[沙箱] 这条命令要删除可删边界之外且未授权的路径，非交互环境不予升级。\n` +
						`目标：${denied.join("、")}\n` +
						`可删边界：${writableRoots(boundary).join("、")}\n` +
						`持久白名单：${allowlist().roots().length} 条（/sandbox-boundary 查看）`,
				);
			}

			const hasDangerous = classification.dangerous.length > 0;
			const foldPaths = (paths: readonly string[], limit = 3): string => {
				const shown = paths.slice(0, limit).map((p) => `  ${p}`);
				if (paths.length > limit) shown.push(`  …还有 ${paths.length - limit} 处`);
				return shown.join("\n");
			};
			// 弹框前先算好「将记住的范围」，在弹框里明示 —— 用户批准的是这个范围，
			// 不是无限授权。
			const ordinaryScopes = memoryScopesFor(classification.ordinary, pathEnv, boundary.cwd);
			const dangerousScopes = classification.dangerous.map((d) => sessionScopeFor(d.path, pathEnv, boundary.cwd));

			let choice: string | undefined;
			if (hasDangerous) {
				// 危险目录在场：用更严的那套选项。普通路径一并列出，但只能随本次批准
				// （要永久记住它们得在没有危险路径的命令里单独走普通弹框）。
				// pi 的 select 只有 (title, options)：正文必须拼进 title（destructive-guard 同一做法）。
				const lines = [
					`⚠️ ${ESCALATION_TITLE}（危险目录）`,
					"",
					`命令：${truncateToWidth(command, 160)}`,
					"",
					"危险路径（每次删除都会问，只能会话级豁免）：",
					foldPaths(classification.dangerous.map((d) => `${d.path}（${d.reason}）`)),
				];
				if (classification.ordinary.length > 0) {
					lines.push("", "同批还有普通边界外路径（本次批准，不记住）：", foldPaths(classification.ordinary));
				}
				lines.push("", "同意后命令会重新执行一次（已执行过的部分会重复）。", "选 Deny 不会删任何东西。");
				choice = await ctx.ui.select(lines.join("\n"), ["Deny", "Allow once", "Allow for this session"]);
			} else {
				const lines = [
					`⚠️ ${ESCALATION_TITLE}`,
					"",
					`命令：${truncateToWidth(command, 160)}`,
					"",
					"要删（可删边界之外）：",
					foldPaths(classification.ordinary),
					"",
					ordinaryScopes.length > 0
						? `将记住：${ordinaryScopes.join("、")}（以后这些目录下的删除不再询问）`
						: "这些路径算不出可安全记住的范围，只能逐次批准。",
					"",
					"同意后命令会重新执行一次（已执行过的部分会重复）。",
					"选 Deny 不会删任何东西。",
				];
				choice = await ctx.ui.select(lines.join("\n"), [
					"Deny",
					"Allow for this session（并记住该目录）",
					"Allow once",
				]);
			}

			if (choice === undefined || choice === "Deny") {
				throw new Error(
					`${denialMessage}\n\n[沙箱] 用户拒绝删除可删边界之外的路径：` +
						[...classification.dangerous.map((d) => d.path), ...classification.ordinary].join("、") +
						`（可删边界：${writableRoots(boundary).join("、")}）`,
				);
			}

			// 按选择落授权：
			// - `Allow for this session（并记住该目录）` → 普通路径的范围**落盘**（remember 内部
			//   还有安全闸，危险范围落不进去）。名字里的 session 由括注与下面的 notify 共同
			//   说清：它比 `Allow once` 多记住了目录，而且重启后仍生效。
			// - `Allow for this session`（危险分支）→ 危险路径的会话范围进会话集合，重启即失效
			// - `Allow once` → 只加宽这一次重跑的 profile，不进任何记忆
			const onceRoots: string[] = [];
			if (choice === "Allow for this session（并记住该目录）") {
				const remembered = allowlist().remember(ordinaryScopes, "confirm", pathEnv);
				if (remembered.length > 0)
					ctx.ui.notify(
						`已永久记住 ${remembered.length} 个目录（重启后仍生效），以后其下的删除不再询问`,
						"info",
					);
				// 被安全闸挡掉的范围（算不出可记范围的）仍要放行这一次
				onceRoots.push(...ordinaryScopes.filter((s) => !remembered.includes(s)));
			} else if (choice === "Allow for this session") {
				sessionScopes.add(dangerousScopes);
				onceRoots.push(...classification.ordinary.map((p) => sessionScopeFor(p, pathEnv, boundary.cwd)));
			} else {
				// Allow once
				onceRoots.push(...ordinaryScopes, ...dangerousScopes);
			}

			// 带上刚批准的目录在沙箱内重跑（命令的其余部分仍被沙箱管着）。
			// 仍被拦 → 报错，不循环、也不升级到沙箱外（手动 /sandbox-boundary allow 是出口）。
			const widenedRoots = [...allowlist().roots(), ...sessionScopes.roots(), ...onceRoots];
			const widened = wrapWithSandbox(command, buildSeatbeltProfile(boundary, widenedRoots), sandboxShellPath);
			try {
				const result = await base.execute(toolCallId, { ...nextParams, command: widened }, signal, runOnUpdate, ctx);
				return annotateMaskedDenial(result, boundary);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (looksLikeSandboxDenial(message)) {
					throw new Error(
						`${message}\n\n[沙箱] 已按批准的范围加宽仍被拒绝，可能还有别的路径被拦或路径识别有误。` +
							`可用 /sandbox-boundary allow <目录> 手动授权后重试。`,
					);
				}
				throw err;
			}
		},

		renderCall(args, theme, context) {
			// 内置 renderCall 靠这里记时（"Took 1.2s"），覆盖后需要自己维护
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}

			// 非流式模式下管住**命令文本的逐字刷新**，但要分两个时间点（对齐 codex / opencode）：
			//   时间点一：命令字符全收完（argsComplete）→ 一次性把完整命令打到屏幕上；
			//   时间点二：命令执行完 → 结果由 renderResult 补刷到命令下面。
			// 两个点必须分开：用 isPartial 做阈值会把命令也压到结果之后才出，变成
			// 「全等到结果才一次性出」，那不是想要的效果。
			//
			// 为什么命令会逐字刷：模型生成 tool call 时参数是流式的（toolcall_delta 一片
			// 一片到），pi 每收一片就 updateArgs() → updateDisplay() → 重画一次 renderCall。
			// 所以收完前返回**零行组件**（连占位行都不画），argsComplete 后才出完整命令。
			// 实测这段时间占大头：`echo hello` 从 toolcall_start 到 tool_execution_end 约 290ms，
			// 其中 args 流式 197ms、toolcall_end→execution_start 63ms、命令执行只 31ms。
			//
			// argsComplete 在 assistant message_end 时置位（setArgsComplete），比
			// tool_execution_start 早 ~60ms，正好是“命令收完”这个语义点。
			// 返回零行组件是安全的：Box.render 开头有 `childLines.length === 0 → []` 守卫
			// （paddingY 是在这之后才加的），所以不会画出空的块。
			// （updateDisplay 每次都传全新的 context，getRenderContext 现拼对象，
			// 所以 argsComplete 读得到实时值。）
			//
			// **但 argsComplete 只在实时流里置位**，所以判定条件是「args 可能还在流」
			// 而不是「args 还没收完」：pi 的 interactive-mode.js 只在 `message_end` 分支调
			// `component.setArgsComplete()`，而 `/resume`（以及 renderInitialMessages /
			// compaction_end / rebuildChatFromMessages）走的 `renderSessionItems` 重建历史时
			// 只 `new ToolExecutionComponent(...)` + `component.updateResult(message)`，
			// **从不调 setArgsComplete / markExecutionStarted** —— 历史块的 argsComplete
			// 永远是 false。若只按 argsComplete 判定，恢复出来的 bash 块就只剩输出、
			// 命令行整行消失（实测过：RESTORE 渲染出 ["", " hello"]，LIVE 渲染出
			// ["", " $ echo hello", " hello", "", " Took 0.0s"]）。
			// isPartial 正好补上这个缺口：构造时默认 true，只有 updateResult(result, false)
			// 会置 false —— 实时流里那必然发生在 argsComplete 之后（tool_execution_end），
			// 历史重建里则发生在第一次渲染之后。两种路径都能出命令，而流式阶段
			// （isPartial 仍为 true）照旧一行都不画。
			// 副作用（可接受）：实时流里按 Esc 中断一个还没收完参数的 tool call 时，
			// message_end(aborted) 会 updateResult(isPartial=false) 而不置 argsComplete，
			// 于是命令行会显示出来（args 不全时是 `$ ...` 占位）—— 能看到被中断的是
			// 什么命令，比只显示一行报错更有用。
			if (!streaming && !context.argsComplete && context.isPartial === true) {
				return {
					render(): string[] {
						return [];
					},
					invalidate() {},
				};
			}

			const rawCommand = args?.command;
			const invalid = rawCommand !== undefined && rawCommand !== null && typeof rawCommand !== "string";
			const command = typeof rawCommand === "string" ? rawCommand : "";
			const timeout = args?.timeout;

			const commandDisplay = invalid ? theme.fg("error", "[invalid arg]") : command ? command : theme.fg("toolOutput", "...");
			const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
			// invalid / 空命令走 pi-tui 折行分支，这一行没有正文可分词，所以 `Run` 的粗体在这里拼
			const styledFull = theme.fg("toolTitle", theme.bold(COMMAND_PROMPT.trimEnd()) + " ") + commandDisplay + timeoutSuffix;

			// 缓存放在组件闭包里而不是 state：流式阶段 args 会不断变长，
			// 而 state 是整行共享的，按 width 缓存会返回旧命令的行。
			let cachedWidth: number | undefined;
			let cachedExpanded: boolean | undefined;
			let cachedResultSeen: boolean | undefined;
			let cachedLines: string[] | undefined;

			const component = {
				render(width: number): string[] {
					// `Box` 的 paddingX 是 0（左边距由 `withHeadBar` 画：首行 `• `、其余两格空格），
					// 所以它给孩子的就是整宽 —— 这里把用掉的三列扣回去：gutter 2 + 左边距 1 + 右边界。
					// 见文件头「命令行首行的状态圆点」。
					const wrapWidth = Math.max(20, (width || 80) - GUTTER_WIDTH - INDENT_WIDTH);
					const limit = DEFAULT_LINES;
					// 缓存键要带上 expanded / resultSeen，否则 ctrl+o 切换或结果到达后已渲染的行不会刷新
					const resultSeen = state.resultSeen === true;
					if (
						cachedLines &&
						cachedWidth === wrapWidth &&
						cachedExpanded === context.expanded &&
						cachedResultSeen === resultSeen
					)
						return cachedLines;

					let result: string[];
					// invalid（args.command 不是字符串）/ 空命令走 pi-tui 折行分支：这两种文本固定是
					// `Run [invalid arg]` / `Run ...`，短到根本不会折行，而那个分支能原样保留
					// 嵌套样式（error 色 / toolOutput 色），不用在硬折分支里重建
					if (!context.expanded && !invalid) {
						// 折叠态：**break-all 硬折行** + 视觉行数预算（`limit`，默认 2 行）。
						// 详见文件头「命令行：2 行 + `Run ` 前缀」一节。
						// 先把行尾 `…` 放在**纯文本**上，再整行上色 —— 反过来会把 SGR
						// 序列从中间切断。
						const commandLines = (command || "...").split("\n");
						const suffixWidth = visibleWidth(timeoutSuffix);
						// 首行（且仅首行）要给 timeout 后缀留位置，否则长命令会把后缀挤掉
						const firstRowBudget = suffixWidth > 0 ? Math.max(4, wrapWidth - suffixWidth) : wrapWidth;
						// 执行中续行只用等宽缩进，`│ ` 是“命令已结束”的信号（用户定的观感，
						// 见文件头「命令行：2 行 + `Run ` 前缀」）
						const linePrefix = resultSeen ? COMMAND_CHAIN : COMMAND_INDENT;
						const { lines, hiddenLines } = renderCommandLines(
							commandLines,
							COMMAND_PROMPT,
							linePrefix,
							firstRowBudget,
							wrapWidth,
							null,
							highlightEnabled,
							limit,
							theme,
						);
						result = lines.map((row, idx) => row + (idx === 0 ? timeoutSuffix : ""));
						// 命令本身没显示完 → `… +N lines`（执行中不挂 `│ `，与续行一致）
						if (hiddenLines > 0) {
							const hint = theme.fg("muted", `${linePrefix}${ELLIPSIS} +${hiddenLines} lines`);
							result = [...result, truncateToWidth(hint, wrapWidth, ELLIPSIS)];
						}
					} else if (invalid || !command) {
						// invalid（args.command 不是字符串）/ 空命令：文本固定是 `Run [invalid arg]`
						// / `Run ...`，短到根本不会折行，而折行分支能原样保留嵌套样式
						//（error 色 / toolOutput 色），不用在硬折分支里重建
						result = wrapTextWithAnsi(styledFull, wrapWidth);
					} else {
						// 展开态（ctrl+o）：要的就是完整命令，**同样用 break-all 硬折行** —— 贪心词折行
						// 在这里一样会把长路径整块挪到下一行再从中间断开（就是用户看到的 `Run ` 后面直接
						// 折行），展开态只是不限行数，折行规则必须一致。
						const commandLines = command.split("\n");
						const suffixWidth = visibleWidth(timeoutSuffix);
						const firstRowBudget = suffixWidth > 0 ? Math.max(4, wrapWidth - suffixWidth) : wrapWidth;
						// 执行中续行用等宽缩进，完成后才换成 `│ `（与折叠态同一条规则）
						const linePrefix = resultSeen ? COMMAND_CHAIN : COMMAND_INDENT;
						// 与折叠态共用同一套摆行逻辑，只把行数预算放开（`hiddenLines` 必为 0）
						const { lines } = renderCommandLines(
							commandLines,
							COMMAND_PROMPT,
							linePrefix,
							firstRowBudget,
							wrapWidth,
							null,
							highlightEnabled,
							Number.MAX_SAFE_INTEGER,
							theme,
						);
						result = lines.map((row, idx) => row + (idx === 0 ? timeoutSuffix : ""));
					}

					// 状态圆点 `•` + 左侧留白：只挂在首行（用户 2026-09-21 定，见文件头「命令行首行的
					// 状态圆点」）。结果侧在 `withPreviewLimit` / `prefixTreeLines` 里挂同一份缩进，两边对齐。
					result = withHeadBar(result, stateBarAnsi(theme, context.isPartial === true, context.isError === true));

					// 行尾补白交给外层（`Box.render` 会把每行补满到它拿到的宽度），这里不用管。
					cachedWidth = wrapWidth;
					cachedExpanded = context.expanded;
					cachedResultSeen = resultSeen;
					cachedLines = result;
					return result;
				},
				invalidate() {
					cachedWidth = undefined;
					cachedExpanded = undefined;
					cachedResultSeen = undefined;
					cachedLines = undefined;
				},
			};

			// `new Box(0, 0)`：**没有 bgFn**（bash 块不带底色 —— pending / 成功 / 失败三种底都不画，
			// 状态由首行那颗圆点的颜色表达，见文件头「整块没有底色」）；两维 padding 也都是 0：
			// 整块上下不留空行，左边距由组件自己画 —— 首行是 `• `、其余行两格空格（`withHeadBar`），
			// 所以孩子拿到的是整宽、组件内部再扣回去（`width - 3`）。
			const box = new Box(0, 0);
			box.addChild(component);
			return box;
		},
	});

	pi.registerCommand("bash-preview", {
		description: "bash 输出预览行数：off（pi 内置 5 行）| <行数 1-50>",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "off") {
				previewLines = 5; // pi 的 BASH_PREVIEW_LINES，等于不裁
				ctx.ui.notify("bash 输出预览已恢复 pi 内置的 5 行", "info");
				return;
			}

			if (arg === "") {
				ctx.ui.notify(`当前输出预览：前 ${previewLines} 行（pi 内置是 5 行，超出部分带 earlier lines 提示）`, "info");
				return;
			}

			// 用 Number 而不是 parseInt：parseInt("2.5") 会静默变成 2（与
			// clampPreviewLines 的归一策略一致，小数应当被拒而不是静默截断）
			const parsed = Number(arg);
			const next = clampPreviewLines(parsed);
			if (next !== parsed) {
				ctx.ui.notify("用法：/bash-preview off | <行数 1-50 的整数>", "warning");
				return;
			}

			previewLines = next;
			ctx.ui.notify(`bash 输出预览已改为前 ${previewLines} 行`, "info");
		},
	});

	// 只读查看当前生效的期限：默认值、上限、以及 env 有没有覆盖。
	// 值在 execute 里每次调用时重算，所以这里显示的永远是下一次执行的真实期限。
	pi.registerCommand("bash-timeout", {
		description: "查看 bash 执行期限（默认 / 上限 / env 覆盖）",
		handler: async (_args, ctx) => {
			const override = (name: string) => {
				const value = readTimeoutEnvMs(name);
				return value === undefined ? "未设置" : `${name}=${value}ms`;
			};
			ctx.ui.notify(
				`默认 ${defaultTimeoutSeconds()}s，上限 ${maxTimeoutSeconds()}s；env：${override("BASH_DEFAULT_TIMEOUT_MS")} / ${override("BASH_MAX_TIMEOUT_MS")}（改完需重启 pi）`,
				"info",
			);
		},
	});
}
