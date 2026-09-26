# Pi Coding Agent 全局配置模板

pi（`@earendil-works/pi-coding-agent`）的全局配置与扩展脚本快照，作为本机 pi 环境的模板标准。
本机装的是 pi **0.87.1** + `pi-web-access` **0.31.0** + `pi-subagents` **0.71.0**。

pi 是接入本网关的第四个客户端：它走 `/v1/messages`（Anthropic Messages API），因此和 Claude Code
一样绑定 **claude 路由**的模型。快照里只有一个自定义 provider `litellm-any`，指向本机 996 端口的
adapter（局域网别的机器用则换成网关主机 LAN IP）。

与 `clients/codex`、`clients/opencode` 那几个 profile skill 不同，这里**没有安装脚本**：
只有文件快照和这份说明，装回本机靠手动 `cp`。

## 目录映射与安装

| 本仓库 | 真实路径 |
| --- | --- |
| `AGENTS.md` | `~/.pi/agent/AGENTS.md`（机器全局行为规则） |
| `AGENTS.core.md` | `~/.pi/agent/AGENTS.core.md`（`AGENTS.md` 的蒸馏版核心铁律，约 6KB；`extensions/core-rules/` 读它并中途重注入。**缺失则扩展静默跳过**） |
| `config/settings.json` | `~/.pi/agent/settings.json` |
| `config/models.json` | `~/.pi/agent/models.json` |
| `config/mcp.json` | `~/.pi/agent/mcp.json`（MCP 服务器；不装就没有 MCP 工具，`/mcp` 会给出提示） |
| `config/web-search.json` | `~/.pi/agent/web-search.json`（`pi-web-access` 自己的配置） |
| `config/pi-statusline.json` | `~/.pi/agent/pi-statusline.json`（**已失效的遗留配置**：旧 npm statusline 包专用，留着只为随时换回那个包） |
| `extensions/*.ts` | `~/.pi/agent/extensions/` |
| `extensions/<name>/` | 同上（子目录形式：`<目录>/index.ts` 作入口，pi 支持 `extensions/*/index.ts`） |
| `extensions/sandbox-boundary/` | 同上（非 shell 工具的删除边界闸：只拦 apply_patch 的 Delete File，write/edit 不拦；与 bash 沙箱同一道白名单与同一套三档授权） |
| `extensions/destructive-guard/` | **已从 live 退役**（词法黑名单路线的参考实现，仓库副本与测试保留；见其 `README.md`） |
| `themes/*.json` | `~/.pi/agent/themes/`（pi 全局主题目录） |

在仓库根目录执行：

```bash
cp clients/pi/AGENTS.md                 ~/.pi/agent/AGENTS.md
cp clients/pi/AGENTS.core.md            ~/.pi/agent/AGENTS.core.md      # core-rules 扩展读的蒸馏版核心铁律（不装则该扩展静默不注入）
cp clients/pi/config/settings.json      ~/.pi/agent/settings.json
cp clients/pi/config/models.json        ~/.pi/agent/models.json
cp clients/pi/config/pi-statusline.json ~/.pi/agent/pi-statusline.json   # 可选：只有要回退到 npm statusline 包时才需要
cp clients/pi/config/mcp.json           ~/.pi/agent/mcp.json               # 可选：不装就没有 MCP 工具（见下文）
cp clients/pi/config/web-search.json    ~/.pi/agent/web-search.json
cp clients/pi/extensions/*.ts           ~/.pi/agent/extensions/
cp -R clients/pi/extensions/tool-diff          ~/.pi/agent/extensions/   # tool-diff.ts 的纯排版模块（无 index.ts，不会被当成扩展）
cp -R clients/pi/extensions/prompt-editor     ~/.pi/agent/extensions/   # prompt-editor.ts 的纯逻辑模块（无 index.ts，不会被当成扩展）
cp -R clients/pi/extensions/simple-task        ~/.pi/agent/extensions/   # 轻量任务清单（与 plan-mode 无耦合，可单独装）
cp -R clients/pi/extensions/recap              ~/.pi/agent/extensions/   # 依赖上一行的 gap.ts（跨目录相对 import）
cp -R clients/pi/extensions/rewind             ~/.pi/agent/extensions/
cp -R clients/pi/extensions/statusline         ~/.pi/agent/extensions/
cp -R clients/pi/extensions/auto-default-model ~/.pi/agent/extensions/
cp -R clients/pi/extensions/startup-logo       ~/.pi/agent/extensions/
cp -R clients/pi/extensions/ask-user-question  ~/.pi/agent/extensions/
cp -R clients/pi/extensions/subagent-log-guard ~/.pi/agent/extensions/
cp -R clients/pi/extensions/fenceless-code-block ~/.pi/agent/extensions/   # 子目录形式：纯逻辑在 render.ts（不 import pi，可单测）
cp -R clients/pi/extensions/user-message-bar   ~/.pi/agent/extensions/   # 同上：纯逻辑在 bar.ts
cp -R clients/pi/extensions/bash-command-collapse ~/.pi/agent/extensions/  # bash-command-collapse.ts 的伴生模块（sandbox.ts / allowlist.ts 是 live 代码，不是测试）与端到端渲染测试（无 index.ts，不会被当成扩展）
cp -R clients/pi/extensions/working-indicator  ~/.pi/agent/extensions/
cp -R clients/pi/extensions/mcp                ~/.pi/agent/extensions/   # MCP（纯逻辑模块 + fixtures 一起拷）
cp -R clients/pi/extensions/plan-mode          ~/.pi/agent/extensions/   # Claude Code 式 plan mode（改绑 shift+tab，见下文）
cp -R clients/pi/extensions/sandbox-boundary   ~/.pi/agent/extensions/   # 删除边界闸（apply_patch 不走 shell，补 bash 沙箱管不到的那部分；write/edit 不拦；与 bash 沙箱共用三档授权与持久白名单）
cp -R clients/pi/extensions/core-rules         ~/.pi/agent/extensions/   # 全局 AGENTS.md 蒸馏版的中途重注入（纯判定在 decision.ts）
cp -R clients/pi/extensions/verify-loop        ~/.pi/agent/extensions/   # 验证闭环 + /goal 评估器（CC Stop hook / goal 同构；import ../recap/subagents.ts，依赖上一行已装 recap/）
cp -R clients/pi/extensions/memory             ~/.pi/agent/extensions/   # 类 CC auto-memory（索引+正文，索引机械派生；见下文）
# superpowers 无扩展：技能发现是 pi 原生扫 ~/.agents/skills，触发规则已并入全局 AGENTS.md 的 ## Skills 一节（Codex 形态：原生发现 + 提示词强化，2026-09-26 删除 skill-router 后的形态）
# destructive-guard 已于 2026-09-24 从 live 退役（被 seatbelt 能力边界取代），不再安装
mkdir -p ~/.pi/agent/themes && cp clients/pi/themes/*.json ~/.pi/agent/themes/

pi install npm:pi-web-access                # 外部包；装完必须配 web-search.json（见下文）
pi install npm:pi-subagents                 # 同上；默认零配置可用（watchdog 是 opt-in，模板 settings.json 已带配置，见下文 watchdog 一节）
```

四个容易踩的点：

- 上面几条 `cp` 会**整体覆盖**目标文件，没有脚本帮你合并。目标机器上有要保留的自定义字段
  （别的 provider、别的模型、别的全局规则）就先手动比对再覆盖。
- `~/.pi/agent/themes/` 是按需目录，新机器上不存在，必须先 `mkdir -p`。
- **`extensions/tool-diff/` 里没有 `index.ts`**：pi 只加载 `extensions/<name>.ts` 与
  `extensions/<name>/index.ts`，找不到入口就跳过整目录 —— 所以它不会被误当成扩展。
  但只装 `extensions/*.ts` 而不装这个目录，`tool-diff.ts` 会 import 失败。
- **`recap/` 必须和 `simple-task/` 一起装**：`recap/index.ts` 里
  `import { widgetGaps } from "../simple-task/gap.ts"` —— 跨扩展相对 import 是刻意的取舍
  （两个扩展同仓库、同目录树、一起安装，省掉一份重复实现）。

生效方式：扩展改完在 pi 里执行 `/reload` 即热加载（`~/.pi/agent/extensions/` 是自动发现目录）；
`settings.json` / `models.json` / `AGENTS.md` 需要**重开 pi**（启动时读一次，`/reload` 也不管用）。
`AGENTS.core.md` 是例外：`core-rules/` 在每次 `before_agent_start` 里现读，改完**下一条 prompt 就生效**，
不用 `/reload` 也不用重开（内容 hash 变了会自动带替换声明重注入）。

## settings.json / models.json 的要紧处

字段的取值和注释直接看那两个文件，这里只记扫不出来、改错了会静默坏掉的东西。

**快照与本机真实配置的已知差异（三处，都是刻意的）**：`models.json` 的 `baseUrl`（快照写
`127.0.0.1` 假定网关在本机，本机那份指向 `192.168.124.1` —— 从局域网别的机器用就换成网关主机
LAN IP）；`settings.json` 的 `defaultModel`（会被 `auto-default-model/` 在换模型时随手改写，
所以真实值只是「上次用的模型」）；以及 `settings.json` 的 `extensions` 字段（见文末）。

**`litellm-any` 登记六个模型**：`qwen3.8-df-qd-claude`、`deepseek-flash`、`qwen3.8-max`、
`qwen3.8-flash`、`deepseek-flash-qd`、`Qwen3.8-Max-DogFooding`。这是**原样快照**：网关的 claude
路由还有三条没登记（`qwen3.8-df-id-claude`、`glm-5.3`、`glm-5.3-flash`），要加别的模型就按同样
形状追加。

- **模型名是路由键**：`model.id` 原样透传给 LiteLLM，必须和 `adapter/adapter.config.json` /
  `gateway/config.yaml` 里注册的名字一致，没有别名或改写。
- **`thinkingLevelMap` 里置 `null` 的档位不会出现在 `/thinking` 选择器里**，值就是发给后端的档位
  字符串。这些档位是**客户端侧声明**：qoder agent 协议忽略 `reasoning_effort`（模板只有
  `is_reasoning: true`），idealab 那条路由则被 `gateway/config.yaml` 的 `extra_body` 覆盖 ——
  所以别照 `~/.zshrc` 里那句 `CLAUDE_CODE_EFFORT_LEVEL=max` 抄成 `max`。目录里没有的档位
  （如 `qwen3.8-flash` 的 `high`）保留只为形状一致，后端忽略、不报错。
- **只有 `qwen3.8-max` / `qwen3.8-flash` / `deepseek-flash-qd` 声明 `input: ["text","image"]`**：
  qoder 目录里 `qmodel_38max` / `qfmodel` / `dfmodel` 三条是 `is_vl: true`，三条都实测过发纯色 PNG
  能被正确识别。注意 `dfmodel` 的识图**依赖网关侧 2026-09-22 的修复**：在那之前 `read` 这类工具返回的图
  会走 tool 消息、被内联成 base64 文本（不是 image part），读进 5 张大图后每次请求都被 qoder 网关
  400 顶回来；修好后 tool 结果的图会另起一条 user 消息按真图片发（详见根目录 `CLAUDE.md` 的
  「tool 结果里的图片」一条）。其余条目别顺手补 image —— idealab 后端吃不下，同一张图发过去是 HTTP 400。
- `settings.json` 的 `modelThinkingLevels` 把 `deepseek-flash` 与 `deepseek-flash-qd` 钉在 `max`
  （这两个的 map 里 `max` 有真值），其余跟随全局 `xhigh`。
- `doubleEscapeAction: "none"` 是**把内置的双击 Esc 动作关掉**，交给 `rewind/` 接管。
  该扩展会**吃掉第二次 Esc**，所以即使写回 `tree` 也不会弹 pi 的 tree；写成 `none` 只是把意图写明。
  要恢复内置行为：删掉 `rewind/` 再改回 `"tree"`。
- `tuiMode: "regular"`（也是 pi 默认值）、`steeringMode`、`markdown.mermaid` 三项写的都是 pi 的默认值，
  本机只是显式写了出来。

### `litellm-any` provider 的两个 compat flag

两个都**只对自定义 provider 能开**（真 Anthropic 会拒绝）：

```jsonc
"compat": {
  "allowEmptySignature": true,     // 上游会发空签名的 thinking 块并要求回放时原样带回；
                                   // 关掉的话 pi 会把这种块降级成纯文本
  "forceAdaptiveThinking": true    // 让 pi 发 thinking.type="adaptive" + output_config.effort，
                                   // 而不是旧的 budget 形状
}
```

### 没有网关别名的两条：`deepseek-flash` 与 `Qwen3.8-Max-DogFooding`

其余四条在 `gateway/config.yaml` 里都是别名（`qwen3.8-max` → `qoder/qmodel_38max`、
`qwen3.8-df-qd-claude` → `qoder/mode-24b28ef…` 这种），名字由网关自己定义。这两条不一样：
**上游认的就是这个名字本身** —— `deepseek-flash` 直连 DeepSeek 自家的 Anthropic API（plain
pass-through），`Qwen3.8-Max-DogFooding` 则对应 `gateway/config.yaml` 里那条刻意只用 litellm
内置设施的对照路由：**不带 `custom_llm_provider`**（即不过 `idealab-openai` 那套自定义 provider，
也就没有 tool_choice 抹除与 `\x01` marker 注入），`adapter/adapter.config.json` 里也**刻意不登记路由**，
于是 `adapterMode` 落回 `pass-through` —— 端到端只是转发，实测 thinking 与工具调用都完整保留
（`thinking` 块 + `tool_use` + `input_json_delta`）。

写这两条时要记住 **`model.id` 会被 pi 原样当成请求体的 `model` 字段发出**（`pi-ai` 的 `buildParams`），
所以 `id` 必须是上游认得的名字，不能起别名；pi 的 `name` 只用于 `--model` 匹配，而 `/model`、
`--list-models` 与 footer 显示的是 `id`。

### 主题文件

`settings.json` 的 `theme` 指向 `~/.pi/agent/themes/<name>.json`，**文件名必须等于 JSON 里的
`name` 字段**（`loadThemeJson()` 拼 `${name}.json` 找文件）—— 改主题名要**同时**改文件名、`name`
和 `settings.json` 的 `theme` 三处，只改一处的话要么选择器显示旧名、要么 `theme` 值落空。

- `pi-coder-catppuccin.json` —— 移植上游 [bacnh85/pi-extensions](https://github.com/bacnh85/pi-extensions)
  的 Catppuccin Mocha 皮肤。与另两套一样全走 `vars`（`bgAnsi()` 对整数会直接发
  `48;5;N`，所以上游遗留的唯一一个 256 色索引 `toolPendingBg: 233` 已先改成 hex 字面量、
  后来按要求整个清空成 `""`，现在三套皮肤都没有整数字面量）。本仓对它的存心 deviation 一处：
  `thinkingXhigh` / `thinkingMax` 不再走调色板的 `blue`，与另两套皮肤统一成中性灰 `#626262`
  （新增 `vars.thinkingGrey`）—— 理由同下面 ayu 的第 2 条。**pi-coder-1337 按你的要求锁到 `#696969`**，
  catppuccin 与 ayu 仍是这个 `#626262`，三套皮肤的最高两档分成了两档：`#626262`（catppuccin / ayu）
  与 `#696969`（1337）。
- `pi-coder-ayu.json` —— 移植 [iodic/pi-ayu-themes](https://github.com/iodic/pi-ayu-themes) 的
  `ayu-dark`（官方 Ayu 调色板），**格式照 `pi-coder-catppuccin.json` 抄**：同样的
  `$schema` / `vars` / `colors` / `export` 四段，`colors` 的 key 与键序照 pi-coder-catppuccin 抄（pi-coder-ayu 多一个
  自定义的 `bashOutput`，所以是 55 个 key），色值全部走 `vars`。上游皮肤已经定义的 51 个 token 里 **48 个逐字节同值** —— 这条可以用代码验：
  用 `loadThemeFromPath()` 同时解析两份文件，对同名 token 比 `getFgAnsi()` / `getBgAnsi()`；
  本仓只补了它没定义的四个：`toolDiffAddedBg` / `toolDiffRemovedBg`（`tool-diff.ts` 要读的行
  底色，上游没有）、`thinkingMax` 与 `bashOutput`（bash 输出正文的独立颜色槽，见下）。自定的
  色值一共五处：两个 diff 行底色、代码字符串的绿、最高两个思考档的边框灰、bash 输出灰（第六处
  原本是按你要求单独调过的 pending 态卡片底色 `toolPendingBg`，现已清空，见下面第 3 条）。两个 diff 行底色是 `#1d241c`（bg 朝 `green` 混 10%）与 `#321d23`（朝 `red` 混 18%）——
  比例是反推出来的：让两侧行底色相对工具盒底色的亮度比都落在 ≈1.15（pi-coder-catppuccin 是 1.15 / 1.14），
  同时 `tool-diff.ts` 那个 30% 行内混色之后正文还有 4.0:1 / 5.6:1。绿侧只能给到 10% 是因为
  Ayu 的绿 `#AAD94C` 很亮，行内混色天然吃掉更多对比度。

  对上游**三条存心 deviation**：

  1. 上游把 `toolDiffAdded`（diff 增加行的前景，行号与 `+` 号跟它同色）与 `syntaxString`
     （代码文本里的字符串）**指向同一个绿 `#AAD94C`**，两边亮得发同一种光；本仓把 `syntaxString`
     拆出去指向自己的 `stringGreen` `#67a567`（更沉的墨绿，差在色相与亮度：代码块底色上 6.2:1，
     原值 `#AAD94C` 是 11.1:1；先定的是 `#73a073`，后按你要求换成 `#67a567` 更纯一点的绿），
     diff 侧保留上游的 `#AAD94C`（行底色上 9.6:1）。副作用：新绿与 `muted`（注释灰 `#6B7385`）
     亮度接近（1.62:1），字符串与注释主要靠色相区分，嫌分不开就往 `#7FAE7F` / `#8CB884` 方向拾一点。
  2. 思考档边框：`thinkingXhigh` 上游是红 `#D95757`，本仓与 `thinkingMax` 一起改成中性灰
     `#626262`（`vars.thinkingGrey`）—— 编辑器边框按当前档位取色，本机 `defaultThinkingLevel`
     正是 xhigh，红边框读着像报错。代价：最高两档不再靠更热的颜色表达，只靠明暗差 —— 这个灰对
     底色 3.12:1，比 `thinkingMinimal` 的 `#6B7385`（4.00:1）暗一档、比 `thinkingOff` 的
     `#515868`（2.67:1）亮一档，与 minimal 相差 1.28:1（看得出但偏淡），要再拉开就继续调深/调浅。
  3. `toolPendingBg`：上游是 `#1b1c1d`（与它的 `userMessageBg` 同一个值），本仓先按你要求改成中性
     `#1f1f1f`、后又调成 `#171717`，**现在三套皮肤统一清空成 `""`**（终端默认底色）—— 只影响 pending 态
     的工具卡片底色，`userMessageBg` / `customMessageBg` 走它们自己那个仍为 `#1b1c1d` 的变量，不受影响；
     它的 `vars` 条目（`#171717` / `#1b1c1d`）与三套皮肤里其他无人引用的变量一起删掉了，文件里已不留痕。

  整体观感是「近黑蓝底 + 高对比亮色」，
  正文在面板上 8.4-9.2:1（pi-coder-catppuccin 12.7）；代价是 Ayu 自己的灰阶偏暗：`muted` `#6B7385`
  在面板上 3.3-3.8:1、`dim` `#515868` 2.2-2.6:1（pi-coder-catppuccin 分别 ≈4.9 / 4.7），注释、
  `Think:` 行、设置页提示因此明显更淡 —— 这是上游皮肤自己的取值（与 `ayu-dark` 逐字节一致），
  嫌淡只需调 `vars.muted` / `vars.dimmed` 两个变量。上游那个包（`iodic/pi-ayu-themes`，自带
  `ayu-dark` / `ayu-mirage` / `ayu-light` 三套变体）**已按你要求卸载**（`pi remove npm:pi-ayu-themes`，
  三份变体文件随之从 `~/.pi/agent/npm/` 消失，`/theme` 里不再有这三个名字），所以本机的 Ayu 皮肤
  只剩本仓这份 `pi-coder-ayu.json` —— 它是同一套 dark 调色板的「可按文件改」版本；要回到上游三套变体只需
  重新 `pi install npm:pi-ayu-themes`。
- `pi-coder-1337.json` —— **当前在用**（`settings.json` 的 `theme` 指向它）。移植 Codex CLI 的**内置语法主题 `1337`**（`~/.codex/config.toml` 的
  `[tui] theme = "1337"` 就是它）。1337 是 Mark Herpich 的 Sublime 配色，被 two-face 打包进
  Codex 二进制的 32 套主题之一。取色方式可复核：从本机那份 codex 可执行文件里解出嵌入的 theme blob
  （`zlib` 解压后是可读的 scope→色值表），再与上游 `1337.tmTheme` 逐条对账 —— 两边 48 个有名 scope
  全部命中，其中 37 个逐字节同值，其余 11 个是 Codex 侧把该 scope 合并成 `None`（不单独着色、
  继承父级）—— 两边都没有出现过「同一 scope 两个不同色值」的情况，所以下面那些值不是「照着观感配的」。
  1337 本身只有**代码语法**一层 —— `background` `#191919` / `foreground` `#f8f8f2` / `caret` `#f8f8f0` /
  `selection` `#515151` / `lineHighlight` `#3D3D3D55` / `invisibles` `#3B3A32`，加 **48 个有名 scope
  条目、28 个不同前景色**，**没有任何 UI 槽位**。所以 pi 那 59 个颜色分两类来源：语法槽位按下表直译，
  UI 槽位在这 28 个色值里挑（挑不到就用 `foreground`），只有 12 个不是 1337 的色（见本节末）。

  语法槽位（`colors` 键 ← 1337 scope，全部取上游字面值；pi 只有 8 个语法槽，所以要合并）：

  | pi 槽位 | 1337 scope | 色值 |
  | --- | --- | --- |
  | `syntaxComment` | `comment` | `#6d6d6d` |
  | `syntaxString` | `string` | `#fbe3bf` |
  | `syntaxNumber` | `constant.numeric` | `#fdb082` |
  | `syntaxVariable` | `variable` | `#e9fdac` |
  | `syntaxKeyword` | `keyword`（`storage` 与 `entity.name.tag` 同值） | `#ff5e5e` |
  | `syntaxFunction`、`syntaxType` | `entity.name.function` / `entity.name.class` / `entity.other.inherited-class`（三者同值） | `#8cdaff` |
  | `syntaxOperator` | **无对应 scope** → 落到 `foreground` | `#f8f8f2` |
  | `syntaxPunctuation` | `punctuation.definition.*` | `#ffffff` |

  两处合并的取舍要交代：① 1337 把「函数名 / 类名 / 继承类」（`#8cdaff`）与 `support.function`
  库函数（`#6699cc`）分成两支，pi 只有一个 `syntaxFunction` —— 取 `#8cdaff`，它是前三者的共同值，
  `syntaxType` 也跟它（在 1337 里类名与函数名本来就同色）；`#6699cc` 没浪费，转手给了 `mdLink`。
  （`support.class` / `support.type` 在 1337 里是另一个米色 `#fbe3bf`，与字符串同值，没有采用 ——
  让 `syntaxType` 跟类名走才合 1337 自己的分工。）② `mdHeading` **没有用** 1337 的 `markup.heading` `#75715e` ——
  那个值在 `#191919` 上只有 3.58:1，而且 pi 的 `mdHeading` 不只画 markdown 标题，还画启动页那批
  `[Skills]` / `[Extensions]` 分组标签（`interactive-mode.js` 的 `addLoadedSection` 默认色），太暗读不清；
  改用 `constant.language` 的橙 `#ff8942`（7.46:1）。

  整体对账（把 `colors` 的值展开 `vars` 后逐一对回 1337 的调色板）：**59 个槽位里 46 个取自 1337、
  12 个不是、1 个是空串** —— 12 个已在本节逐一点名（5 个指定 + 6 个锁死 + 1 个 `error` 统一），
  没有一处「随手拿个相近色」。

  非语法槽位全部从 1337 自己的色板上取（括号里是对 `#191919` 的对比度）：`border` / `selectedBg` ←
  `selection` `#515151`、`borderMuted` ← `invisibles` `#3b3a32`、`warning` ← `constant.numeric` `#fdb082`、
  `success` ← git-gutter 的 `#a6e22e`（1337 自己给「插入」的用色）、`toolTitle` 与
  `syntaxFunction` 共用 `#8cdaff`（11.38:1）、`toolOutput` ← `variable.parameter.function` `#d0d0d0`（11.40:1）、
  `mdListBullet` ← `storage.type` `#fbdfb5`、`bashMode` ← `variable.parameter` `#fc9354`、
  `customMessageLabel` ← PHP 命名空间 `#ffb2f9`。
  思考档走 1337 自己的冷→暖阶梯：`thinkingOff` = `invisibles`、`thinkingMinimal` = `selection`、
  `thinkingLow` ← `support.function` `#6699cc`、`thinkingMedium` ← `entity.other.attribute-name` `#97d8ea`、
  `thinkingHigh` ← `variable.language.*` `#d699ff`，最高两档锁死（见下）。

  **六个锁死槽位是照你指定的值写死的**（不是 1337 的色）：
  `toolDiffAdded` `#8bc391` / `toolDiffRemoved` `#e27878` / `toolDiffAddedBg` `#1c241b` /
  `toolDiffRemovedBg` `#2e1c21`（diff 行前景 + 整行底色四件套）、`thinkingXhigh` / `thinkingMax` `#696969`
  （最高两档思考边框）。锁死时比对过两份 JSON 的解析结果，6/6 全等；现在只剩这份值本身。
  **这里有一个锁死带来的必然后果要交代**：那两个 diff 行底色是**为 `#161616` 卡片挑的**
  （对卡片 1.14 / 1.12:1），换到本皮肤指定的 `#202020` 成功卡片上只剩 **1.02 / 1.01:1** —— 行底色几乎是平的，
  在深色 diff 块里基本看不出来（前景色不受影响，`addedGreen` 对新增行底色仍是 7.83:1）。
  这不是漏改：两侧的锁死要求互相拉扯，行底色要重新可见就得改 `toolSuccessBg` 或这两个底色中的一个。

  另按你要求**把报错色统一到 diff 删除行的前景色**：`error` 不再用 1337 的 `markup.deleted` `#f92672`，
  而是与 `toolDiffRemoved` 共用同一个 `vars.removedRed` `#e27878` —— 共用一个变量而不是两个同值变量，
  这样改一处两边同时变，才叫「统一」。`#f92672`（1337 的 `markup.deleted`）因此彻底退出这份皮肤，
  变量也从 `vars` 里删掉了 —— 连同后面 `mdCode` 换色撤下的 `#ecfdb9`（1337 的 `support.constant`），
  这份皮肤一共放弃了两个 1337 色值。`error` 对 `#191919` 的对比度随之从 4.65:1 变成
  **6.02:1**（在 `toolErrorBg` `#171010` 上是 6.43:1）。新增行侧不动：`toolDiffAdded` / `addedGreen`
  仍是指定值 `#8bc391`。

  四个指定底色：`userMessageBg` / `customMessageBg` `#242424`、`toolSuccessBg` `#202020`、`toolErrorBg` `#171010`、
  `export.cardBg` `#181825`（另配 `export.pageBg` `#111111`，同族推的、比 cardBg 暗一档）；
  `toolPendingBg` 与另三套一样清空成 `""`。
  `accent` / `borderAccent` 按你要求改成了 `#8cdaff` —— 这次**是** 1337 自己的色（函数名 / 类名那个青蓝，
  与 `vars.funcBlue` 同值），但**各立一个 `vars`**（`accent` 与 `funcBlue` 分开，改一个不连带改另一个，
  本仓习惯）—— 所以调 accent 不会顺手把 `syntaxFunction` / `syntaxType` / `toolTitle` 一起改掉。
  对 `#191919` 11.38:1（旧值 `#0d92c1` 是 4.94:1），选中的行 / 光标 / logo 因此明显更亮。

  `mdCode`（行内代码）同时按你要求换成 **`#0d92c1`**，就是 accent 撤下来的那个深青 —— 新开一个
  `vars.mdCodeCyan` 装它，与 accent 解耦。它原来指向的 1337 色 `support.constant` `#ecfdb9` 因此不再被引用，
  变量已从文件里删掉（板页变量表同步换一格，总数仍是 35）。行内代码对 `#191919` 4.94:1
  （代码块底色 `#202020` 上 4.58:1）—— 比注释 / `dim` 的 3.40:1 亮一档、比语法关键字的 5.87:1 弱一档，
  处在语法色阶的下半段，读是够读，嫌淡就往上抬。

  与另三套的一个结构性差别：**它也定义了 `bashOutput`**（`#999999`，bash 输出正文的独立灰 ——
  与它自己的 `muted` 同值但各立一个 `vars`，改一个不连带改另一个），机制同 ayu，catppuccin 没有。

三套皮肤共同的两条硬约束：

- **`colors` 正在引用的 `vars` 变量不能删**：`colors` 的值只要不是 `#` 开头（也不是空串）就会被当变量引用去 `vars` 里查，
  查不到直接抛 `Variable reference not found`，**整个主题加载失败**并回退内置 `dark`。反过来，把某个颜色值清空成
  `""` 之后（三套皮肤的 `toolPendingBg` 都是这个状态），它原来指向的变量变成无人引用，可以留着也可以删，两者都不影响加载。
  **本仓的做法是删**：三套皮肤里的 `vars` 只保留仍被 `colors` / `export` 直接或间接引用的条目（仅 `pi-coder-catppuccin` 的
  `pendingPanel` 按你要求整条保留，留作后续恢复 pending 底色的备选值——它独一无二，未被任何槽位引用）。
  另注意 **空串是合法值**，不是「未定义」：`bgAnsi("")` 发 `\x1b[49m`（终端默认底色）、`fgAnsi("")` 发 `\x1b[39m`，
  token 仍在表里，`theme.bg(token, ...)` 不会报错。
- **缺了主题文件会静默降级**：`initTheme()` 加载失败时是 `catch` 后静默回退内置 `dark`，不报错、
  不启 watcher —— 重装时最容易漏的就是这一行（它不在 `cp config/*.json` 那几行的覆盖范围内）。

三套皮肤里都有 pi 官方 schema 没有的自定义 token：`toolDiffAddedBg` / `toolDiffRemovedBg`
（diff **整行底色**；`toolDiffAdded` / `toolDiffRemoved` / `toolDiffContext` 三个前景色是标准 token），
`bashOutput` 是第三个（ayu / 1337 都有，catppuccin 没有，见下节）。
它们能生效靠三件事凑齐：主题校验实际用的是 TypeBox 的 `Compile().Check()`，**对未知 key 放行**
（`theme-schema.json` 里那句 `additionalProperties: false` 不是执行路径）；`createTheme()` 把不在那 7 个
ThemeBg 名单里的颜色一律收进 `fgColors` 表；而 `getFgAnsi()` 是按 key 查表、不校验 key 是否在联合类型里
—— 拿到前景色 SGR 后把 `38` 换成 `48` 就是合法底色。**pi 一旦改成严格校验，这两个 token 就读不到**，
扩展会静默退回 `toolSuccessBg` / `toolErrorBg`，底色变淡但不报错。

主题文件里的色值选择（pi-coder-catppuccin 的 diff 底色按 OKLab 感知亮度标定、`accent` 取 Macchiato lavender、
`muted` / `toolOutput` / `thinkingText` 指向同一个 `secondaryText`；pi-coder-ayu 的 diff 底色按上面那条
「行内混色 + 两侧行底色亮度比」反推等）都写在 JSON 自己的变量命名与 `tool-diff.ts` 的注释里，
改色时以文件为准。皮肤不会自证对错 —— `toolDiffAddedBg` 之类的自定义 token 写错名字只会静默走兜底，
所以新皮肤落盘后至少用 pi 自己的校验与解析跑一遍：`validateThemeJson()`（`pi-coding-agent/dist/modes/interactive/theme/theme-json.js`）
过 schema、`loadThemeFromPath(path, "truecolor" | "256color")` 后对每个 token 调 `getFgAnsi()` /
`getBgAnsi()`，任一 `vars` 引用不存在都会抛 `Variable reference not found`。移植类皮肤再加一条：
把上游那份皮肤文件一起解析，同名 token 逐个比 ANSI 值 —— 同值才叫「搬运」，不同值要么是漏改，
要么是有意 deviation，得在注释或文档里交代清楚。

### `bashOutput`：bash 输出正文的独立颜色（ayu / 1337 都定义了）

`pi-coder-ayu.json` 多一个 pi 官方 schema 没有的 token `bashOutput`（值 `#6B7385`，与那条
`… (N tokens hidden)` 折叠提示同为 `muted` 灰，但**自己一个 `vars.bashOutput`** —— 改 `muted`
不会连带动它）；`pi-coder-1337.json` 也有一份（`#999999`，等于它的 `muted`，独立 `vars`）。
它买的是「只改 bash 输出正文的颜色，不跟其他颜色混掉」：pi 内置的 bash 渲染器把
输出正文写死成 `toolOutput`，而那是**所有工具输出共用**的槽（read / grep / ls 的正文都吃它），
所以这个 token 只能由 `bash-command-collapse.ts` 生效 —— 机制（在委托给内置渲染器的同步窗口里
临时改主题单例的 `fgColors`）写在该扩展文件头「输出正文的独立颜色」一节。两条行为要知道：

- **别的皮肤不定义它 = 零影响**：扩展先真调一次 `getFgAnsi("bashOutput")` 探测，抛
  `Unknown theme color: …` 就什么都不做，照旧走 `toolOutput`（内置主题与 pi-coder-catppuccin
  现在都是这条路）。反过来，想给某套皮肤也拆出来，就是照 pi-coder-ayu 加一行 `vars` +
  一行 `colors`；删掉那两行等于回到 `toolOutput`，不报错。
- **它不在官方 schema 里，所以不会出现在 `theme-command.ts` 的色卡预览上**：那只预览画的是
  pi 的标准 token 列表。

## 联网检索（`pi-web-access`）

给 pi 加 `pi_web_search` / `fetch_content` / `source_check` / `get_search_content` 四个工具。
**零配置可用**（不填 key 时检索走 Exa MCP），本机就是这种状态。

配置里只有一项，但它是**必须的**：

```json
{ "toolNames": { "webSearch": "pi_web_search" } }
```

pi 默认把该工具注册成 `web_search`，而 litellm 的 Anthropic→OpenAI 转换会按名字把**任何叫
`web_search` 的工具**当成 Anthropic 官方内置的联网检索工具（`_is_web_search_tool`），于是把它从
`tools` 里剔除、换成一个空的 `web_search_options: {}` 参数；qoder 后端不认这个参数，工具就**静默消失**
—— 请求正常返回、没有任何报错，只是模型的 tool schema 里没有它（实测：pi 发 8 个工具，网关日志
`tools=7`；只发 `web_search` 时是 `tools=0`）。改名后同一个请求变成 `tools=8`，检索实测可用。

> 排查这类「工具凭空消失」时不要相信模型的自述（它会照着 system prompt 里残留的 `promptSnippet` 猜），
> 要看网关日志的 `tools=N` 计数：pi 发了几个、网关收到几个，对不上就是中间层吞了。

## 子代理委派（`pi-subagents`）

`scout` / `researcher` / `evidence-auditor` / `worker` / `reviewer` / `oracle` / `delegate` 等内置
agent，加 `workflowScript` 脚本化编排。工具名（`subagent` / `subagent_supervisor` /
`contact_supervisor` / `bg_wait` / `structured_output`）都不撞 litellm 的 `web_search` 特判，
所以**不像 `pi-web-access` 那样需要改名**。

### 委派闸门与 Codex 的对齐（2026-09-25 实测）

`AGENTS.md` 的「非显式不委派」闸门**不是过度抑制，而是与 Codex 默认同档**：从 Codex 0.154.0 二进制
（222MB Mach-O）`strings` 抽出 `spawn_agent` 工具的 prompt 原文——

> Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask
> for sub-agents, delegation, or parallel agent work. Requests for depth, thoroughness, research,
> investigation, or detailed codebase analysis do not count as permission to spawn.

三方同档：Codex 内置 prompt、pi-subagents 0.71.0 的 `SUBAGENT_SAFETY_GUIDANCE`
（`src/extension/tool-description.js:9`）、本仓库 `AGENTS.md`。issue #12 说的「可检视子线程」指的是
**检视面**（`/agent`、agents 面板、`SubAgentActivity`、`SubagentStart`/`SubagentStop` hooks），
不是主动委派策略。

与 Codex 的两处差异已在 2026-09-25 补齐：

1. **授权来源**：Codex 认「用户显式要求 **或** 适用的 AGENTS.md/skill 指令」，旧规则只认用户原话——
   `dispatching-parallel-agents` 这类技能、项目 AGENTS.md 里写明的委派指令永远无法授权委派。
   现已对齐：项目指令/技能也可授权。
2. **打法**：Codex 闸门后跟着一整套委派打法（先规划再委派、只委派不阻塞下一步的 sidecar 任务、
   写集不相交、子代理直接改文件并汇报路径、不重做已委派的活、`wait_agent` 极少用），旧规则只有
   闸门没有打法。现已补入 `AGENTS.md` 的 `## Delegation`。

Codex 另有 proactive 档（`MultiAgentMode` 枚举：`custom` / `explicit` / `RequestOnly` /
`proactive`，配置键 `features.multi_agent_v2.*`），本仓库**明确不采用**。官方文档
（learn.chatgpt.com/docs/agent-configuration/subagents）也说当前版本「spawn agents after a direct
request or applicable project or skill instruction」。检视面（FleetView / fleet inspector /
async run artifacts）pi-subagents 已自带（`docs/observability.md`），无需自建。

### 补回被压缩掉的「主动找并行」（2026-09-26）

2026-09-25 那次把 Codex 闸门后的 **19 条**打法压成 **5 条**，砍掉的主要是 Codex 鼓励主动寻找并行机会
的那一半。后果实测可见：`workflowScript` 在全部会话日志里**零调用**（按 `toolCall` 精确计数：`subagent`
共 6 次，其中 3 次是 `{agent, task}` 直调派活、3 次是 `list` / `guide` 管理动作，没有一次上升到编排层；
详见下一节）——闸门 + 纪律保留、并行主动性砍掉、proactive 档关闭，三层叠加后模型没有任何理由去碰编排层。

补回两条（`AGENTS.md` 的 `## Delegation`，**闸门一字未动**，只加在「授权之后」的打法段）：

| 补回的条款 | Codex 0.154.0 原文 |
| --- | --- |
| 授权后主动在同一轮里找并行机会：写集不相交就按切片各派一个子代理，独立问题一起发出而不是逐个问 | 「Split implementation into disjoint codebase slices and spawn multiple agents for them in parallel when the write scopes do not overlap.」+「The key is to find opportunities to spawn multiple independent subtasks in parallel within the same round…」 |
| 验证只在能与进行中的实现并行、且可能在最终集成前抓到具体风险时才委派 | 「Delegate verification only when it can run in parallel with ongoing implementation and is likely to catch a concrete risk before final integration.」 |

这是**做法 B（补打法）而不是做法 C（放宽闸门）**：授权来源仍只有「用户当前请求 / 适用的项目指令 / 技能」，
「任务大小、复杂度、工具调用数、想并行」依旧不构成授权，「要深入 / 要调研 / 要详细分析」依旧不算许可。
proactive 档仍不采用。差别只在**授权成立之后**：以前模型拿到授权也不知道该主动切并行，现在会。
`AGENTS.core.md` 的蒸馏版同步加了一句（core-rules 按 hash 检测，下个会话自动带替换声明重注）。

### 编排触发机制：workflowScript 零调用的病根（2026-09-26）

上一节补的是「授权之后要主动找并行」，但**没说用什么机制去并行**。实测后果（按 `toolCall` 精确计数，
63 个会话文件）：`subagent` 工具调用共 **6 次**，其中真派活 **3 次**（全在 2026-09-16，全是直调
`{agent, task}`），`workflowScript` / `workflowScriptPath` **零次**。

与上一节两处口径差异，以本次为准：上一节记的「9 次」含 `guide` / `status` / `list` 等管理动作与
非 `toolCall` 形态的提及，此处只数 `role:"assistant"` 的 `toolCall`（得 6）；上一节说「没有一次真派活」
也不准——那 3 次 `{agent, task}` 直调是真派活，只是全部停在直调层、从未上升到编排层。两节结论一致：
**编排层零调用**。

能力其实全在 pi-subagents 0.71.0 里：`runs.run` / `runs.all` / `runs.lanes` / `runs.steer` /
`outputSchema` / typed gate / worktree 隔离 / 三种预算，`subagent` 工具描述本身也写了 `workflowScript`
（`src/extension/tool-description.js:19`）。缺的是**触发**：`AGENTS.md` 对 workflowScript 零提及，模型拿到
授权也不知道有这层，只会发 N 个临时直调。

补法与上一节同构——**做法 B（补打法），闸门一字未动**。`AGENTS.md` 的 `## Delegation` 加一条
「Pick the orchestration mechanism once authorized」，判据直接取自官方 `docs/workflows.md`：

| 工作形状 | 机制 |
| --- | --- |
| 单个有界子任务 | 直调 `subagent({ agent, task })` |
| 需要稳定键控子代理 / 顺序 / 扇出 / 纠偏 / 重试 / 聚合 | **一次**顶层 `subagent` 调用带 `workflowScript`（或 `workflowScriptPath`），子代理全部在脚本内启动 |
| 形状匹配打包模板 | 优先 `/prompt-workflow <name>`（包内 6 个：`parallel-review` / `review-loop` / `parallel-research` / `parallel-cleanup` / `gather-context-and-clarify` / `council`） |

两条硬约束一并写进条款：**不做第二次顶层编排**（官方原文「make exactly one top-level `subagent`
workflow call … rather than constructing a second top-level orchestration」），复合 workflow 加
`timeoutMs` / `toolBudget` / `usageBudget`。条款末尾明写「这是 how，不是新的授权来源，不动闸门」——
授权来源仍只有用户当前请求 / 适用的项目指令 / 技能。

`AGENTS.core.md` 蒸馏版同步一条（core-rules 按 hash 检测，下个会话自动带替换声明重注），否则长会话里
条款照样衰减。`/council` 不是注册的 slash command（`registerCommand` 全表里没有它，由 `council-mode`
skill 驱动），所以条款里只写 `/prompt-workflow council` 这个真实入口。

### watchdog：开关与配置（2026-09-26 起默认开）

watchdog 是 pi-subagents 的 opt-in 第二模型审查员：每个回合结束且仓库有改动时，把本轮 diff +
用户 scope 喂给一个独立 reviewer 模型，找漏掉的约束 / 正确性风险 / 测试缺口 / 不安全改动 / 跑偏；
干净静默，high 发现推回模型上下文续跑，low/medium 只给用户看；连续 3 次相同警告判僵局停止
（`docs/watchdog.md`）。**配置在 `settings.json` 的 `subagents.watchdog`**（`src/watchdog/settings.js:331`
读的就是 `~/.pi/agent/settings.json`），模板已带：

```json
"watchdog": {
  "enabled": true,
  "main": { "model": "litellm-any/deepseek-flash-qd" }
}
```

- **开关**：改 `enabled` 即可（或会话内 `/subagents-watchdog on|off`、`/subagents-watchdog status` 查状态）。
  settings 是启动时读的，改完**下个会话生效**。
- **模型**：`main.model` 必须 `provider/model` 全限定且在 registry 能认证（`model-selection.js:50-71`）；
  省略则继承当前会话模型。本机选 `deepseek-flash-qd` 是取它快（实测经 996 网关 ~1.4s 返回）；
  注意本网关所有路由 thinking 钉死，审查调用也付 thinking，单次成本与 `/goal` 评估器同级。
- **刻意没开的子项**（都默认关）：`children`（子代理审查，当前不委派子代理）、`clarification`
  （每 prompt 多一次追问审查）、`cadence`（每 N 次工具调用审一次的高频档）。要开再加对应键。
- **超时**：`agentEndTimeoutMs` 默认 30000（`settings.js:9`），审查超时就放弃本次、不拦回合。
- **与 verify-loop 的关系**：watchdog 的 Test Gap 类别与 verify-loop 闸重叠（都抓「声称完成但没验证」），
  但闸是确定性零成本、watchdog 是模型判断付成本；两层并存是有意为之（闸防没跑，watchdog 防跑偏/漏改）。

### `tools:` 是严格白名单，但真正决定成败的是「子会话注册表里有没有这个名字」

白名单本身的过滤规则（`child-tool-plan.ts`）：**核心内建名**（`PI_BUILTIN_TOOL_NAMES` =
`read` / `bash` / `powershell` / `edit` / `write` / `grep` / `find` / `ls`）里宿主没有的会被剔除、
并记进 `unavailableHostBuiltins`（后台 run 的 `runner.stderr.log` 里那条
`host runtime tool availability omitted [...]` 警告就是它）；**非核心名原样放行**，交给子会话自己的
工具注册表去校验。

所以扩展工具被丢掉通常不是白名单的锅，而是**名字对不上**：内置 `researcher` 的 frontmatter 写的是
`web_search`，而本机 `web-search.json` 已经把该工具改名成 `pi_web_search`，于是子会话注册表里没有
`web_search`，它就在那里被丢掉 —— 这类「工具凭空消失」不要相信模型自述，看子会话实际拿到的工具表。

另一条独立规则：只有**后台**子代理才加载父进程的环境扩展（`ambientExtensions = host === "runner" && ...`），
`async: false` 的前台子会话跑在父进程内，只加载内置 + runtime 扩展 —— 所以前台子代理没有联网工具，
除非 agent 自己用 `extensions:` 声明（但那样环境扩展整体被关掉，`simple-task` 的 `task_*` 之类不再有）。

`settings.json` 给三个**可写型**内置代理设 `tools: "inherit"`：`researcher`、`delegate`、`worker`。
`inherit` 的实现就是 `delete target.tools`（`applyToolsOverride`）—— 白名单整个删掉，子代理拿回
子会话注册表里的全部工具，上面那类名字对不上的问题也就绕过去了。实测后台子代理拿到 13 个工具，
`researcher` 与 `delegate` 都真的联网成功。
**只读型内置代理（`scout` / `reviewer` / `oracle`）不能设** —— `inherit` 会把 `write` / `edit` / `bash`
一并给出去，破坏只读契约；`evidence-auditor` 的白名单是同一个坏形状，但给它 `inherit` 等于白送写权限，
所以留原样。交互类工具不用手动排除：`ask_user_question` 自己按 `ctx.hasUI` 判断，子会话里自动摘掉。

## MCP 服务器（`mcp/`）

让 pi 用上 Claude Code 那套 MCP 服务器：**每个 MCP 工具直接注册成一个 pi 工具**，名字
`mcp__<server>__<tool>`（Claude Code 同款，skill 与权限规则里的写法可以直接搬过来）。

配置按 Claude Code 的 `.mcp.json` 形状：全局 `~/.pi/agent/mcp.json`，再加上从 cwd 往上找到的
**第一个**项目根 `.mcp.json`（同名 server 项目覆盖全局）。所以 `~/jayli/homework/.mcp.json` 里已有的
`wechat-local` 在 pi 里开箱即用，全局那份则是「在哪个目录都能用」。字段：`command` / `args` / `env` /
`cwd` / `timeout`（毫秒，工具调用用；握手另有 20s 上限）走 stdio；`url` / `headers`（`type: "sse"` 走旧版
HTTP+SSE，否则 streamable HTTP）走远程；字符串值支持 `${VAR}` 与 `${VAR:-默认值}`；`enabled: false` 保留条目但不连。

**动态请求头（`headersCommand`）**是 OAuth 的“便宜档”：很多 SaaS MCP 既支持 OAuth、也支持静态 token（GitHub PAT、
`CONTEXT7_API_KEY`、Sentry/Figma 的 token），所以与其为一个 header 实现整套 OAuth 2.1，不如让命令自己去取：
```json
{ "mcpServers": { "remote": {
  "url": "https://mcp.example.com/mcp",
  "headersCommand": "security find-generic-password -s example-mcp -w"
} } }
```
命令输出三种形状都认：扁 JSON 对象、`{"headers":{...}}` 包装、或 `Name: Value` 行（值里的冒号不会被切开）。
别名 `headersHelper`（Claude Code）与 `http_headers_helper`（Codex）同样可用，从那边拷配置不用改字段名；
`headersCommandTimeout` 默认 10s。语义上有四条要记住：

- **每次连接只跑一次**，结果与静态 `headers` 合并（**动态的赢**，它是更新鲜的凭据）；HTTP 协议头（`content-type`/
  `accept`/`mcp-protocol-version`/`mcp-session-id`）优先级最高，配置改不动它们。
- **401/403 会重跑一次，但只有头真的变了才重试请求**（命令每次都返回同一个 token 就不会白重试一遍）。旧版 SSE
  只重建 POST，不重建 GET 长连接。
- **失败不致命**：命令超时/非零退出/输出不可解析时退回静态 headers 继续连，原因记进诊断；真被拒时错误信息里
  会带上这条原因（否则你只看到 401，以为是 token 过期）。
- **绝不记录头的值**：诊断只输出头的**名字**（`头命令取到 1 个头（Authorization）`），解析失败也不回显命令输出
  —— 输出可能整段都是密钥。`/mcp <server>` 里显示的是命令本身（你自己的配置），不是取回来的值。

没有浏览器弹窗、不写任何凭据存储：token 的生命周期完全归那条命令管（钥匙串、vault、`opencode auth` 都行）。
只支持 OAuth（不接受静态 token）的 server 目前用不了，要支持得上第二档（OAuth 2.1 + PRM + DCR + 回调服务器），
那基本就是 pi-mcp-adapter 的领域。

三个命令入口：`/mcp` 看状态（server / 工具数 / 版本 / 配置来源），`/mcp reload` 改完配置不用重启 pi，
`/mcp <server>` 看单个 server 的详情与最近诊断。不开 pi 想验证配置就 `npm run mcp:probe -- <server> [tool]`
（用的是扩展里同一份客户端，通了 pi 里就通；**本机 Node 22 专用** —— 它直接 import `.ts`，靠 Node 的类型擦除，
与 `npm run usage` 一样不在 Node 20 的路由器上跑）。

改之前的约束：

- **传输是自己实现的**（`protocol.ts` + `client.ts`），**不依赖 `@modelcontextprotocol/sdk`** —— 扩展目录
  里没有 node_modules，引 SDK 就得给 `~/.pi/agent/extensions/mcp/` 铺依赖。协议面只做
  initialize / notifications/initialized / tools/list / tools/call，其余（OAuth、sampling、elicitation、
  progress、`tools/list_changed` 热更新）**刻意不做**；服务端反向请求一律回 `-32601`，不留傻等的对端。
- **诊断输出只进内存环形缓冲**（每个 server 20 行，`/mcp <server>` 看），**不写 stdout/stderr** ——
  interactive pi 里往 stderr 写会直接糊在输入框上（`subagent-log-guard/` 就是为这个存在的）。
- **会话开始时连接、结束时断开**。工具表必须先 `tools/list` 才能注册，所以不能等首次调用才连；
  多个 server 并行握手，单个失败只影响它自己（启动时给一条 warning，不阻塞会话）。
- **工具输出必须截断**：沿用 pi 内建工具的 50KB / 2000 行上限（`tools.ts` 的头截断），图片块不计入、
  也不被截掉。MCP 的 `resource` / `resource_link` / `audio` 会降级成一行文本说明 —— pi 的 tool content
  只认 `text` 与 `image`，原样塞进去会被静默丢掉。
- **工具名有 64 字符硬上限**（Anthropic / OpenAI 的 tool 名限制）：超长时截断工具名并接 FNV-1a 哈希后缀，
  保证截断后仍可区分。改命名规则时 `tools.test.ts` 的哈希稳定性用例会拦住手滑。
- **头命令的设计约束（`headers-command.ts`）**：① 子进程**刻意不 unref** —— 它是我们正在等的结果，unref
  会让 `pi -p` / probe 这类短命进程先退出、promise 永远不 resolve（单测当场拦到过）；② 诊断只能用
  `describeHeaderNames` 输出**头名**，头的值与解析失败的原文一律不打印（命令输出可能整段是 token）；
  ③ 命令失败不当致命错误，退回静态 headers 并把原因带进最终错误信息，否则用户只看到 401 而不知道是命令挂了；
  ④ 401/403 重跑命令后**只在头真的变化时**重试（headless 与交互两种模式行为要一致）。

## 自写扩展：改之前要知道的

每个扩展的完整理由都写在**它自己的文件头注释**里，这里只列「不在文件里、但改错了会静默坏掉」的约束。
除了下文点名的那些，`extensions/` 下还有一批较小的显示层 / 输入层扩展：

| 扩展 | 作用 |
| --- | --- |
| `thinking-collapse.ts` | thinking 块渲染成**一条连续横向滚动的行**（固定 1 行，不注册命令）：所有换行（模型自己折的行、空行分段、列表项、代码围栏内）全部拼进同一条行 —— 上一段结束后下一段直接接续在上一段的结尾，**不另起一行**，Think 区域从头到尾只有一行不间断的 token 流；**段落接缝（空行处）中文 ↔ 中文补一个逗号**（上段末尾已有标点不重复补，英文/混排仍按空格规则，段内折行不补），行首 `Think: ` 标签（顶格，无竖线 gutter），整行超宽时从头部丢掉溢出字符、行首补 `…`，行尾永远是最新 token，不折行；**没有短段回填补满逻辑**（曾有，会打断流动观感，已移除），短 thinking 行尾留白不补 |
| `fenceless-code-block/` | Markdown 代码块去掉开合围栏（连 `lang` 标签一起），代码正文按 pi 的缩进铺开、语法着色保留，**不加底色**（观感来自 npm `@itc-steve/pi-theme`，但只取去围栏这一半）；`render.ts` 是纯逻辑（量度 / 折行 / Markdown 类都注入），入口只接线。`PI_FENCELESS_CODE=off` 关闭 |
| `user-message-bar/` | 用户消息框**每一行**（含上下两条空白内边距行）行首加一条竖线 `▎`（U+258E，左侧四分之一块），**竖线跟着消息底色**（不抠底 —— 它直接坐在 Box 的 `userMessageBg` 里，与底色块连成一片），竖线后空一格（正文共缩进两格），颜色取 **皮肤的强调色 `accent`**（`PI_USER_MESSAGE_BAR_COLOR` 可换槽位，显式指定 `toolDiffAdded` 则拿回原来的 diff 新增行行号色；兜底顺序 `accent` → `selectedBg` → `toolDiffAdded` → `text`）；`UserMessageComponent.prototype.render` 补丁 —— 竖线占原本那一格左内边距，多空的那一格（`BAR_INDENT`）则从**行尾补白**里等量吃回来，所以底色 / 行宽 / 折行位置全不变（pi-tui 对超宽行直接抛错，多一格都不行；`outputPad = 1` 时 Box 只给孩子 `width - 2` 列，所以正文总能留得下那一格，已在 `index.test.ts` 用长正文折行逐行验宽度）。**别再改成「竖线格无底色」**：那需要在竖线前插 `49m`、画完再还原 `48;…m`，而结果是底色块左边缘被抠出一个缺角，实测观感更差（曾这么做过，已回退）；`bar.ts` 是纯逻辑，入口只接线；取色源在 `session_shutdown` 时摘掉、读皮肤再兜一层 try/catch —— 会话替换（`/clear`、`/new`、`/resume`、`/fork`、`/reload`）时 pi 会作废旧 ctx，而旧消息这时还挂在聊天区里，渲染 tick 里抛出的 stale-ctx 异常没人接得住，会直达 pi 的 `uncaughtException` 把进程带走。`PI_USER_MESSAGE_BAR=off` 关闭，`PI_USER_MESSAGE_BAR_COLOR=<槽位名>` 换色（背景槽如 `selectedBg` 会 48→38 转前景） |
| `bash-command-collapse.ts` | bash 工具块的命令 + 树形输出（**用户 2026-09-21 定的形状**）：命令**首行**行首是一颗状态圆点 `•` **加一个空格**（执行中 `dim` / 成功 `toolDiffAdded` / 失败 `toolDiffRemoved`，**只有首行有**，续行、折叠标记与整棵结果树前面没有；这一列与结果侧的缩进共用同一个 `INDENT_WIDTH`，所以 `Run` / `│` / `└` 同在列 2、正文同在列 4），命令以 `Run ` 起头（pi 内置是 `$ `）、最多 **2 个视觉行**，第 2 行溢出多少都只把行尾换成 `…`，命令更长时再补一行 `… +N lines`；两类续行（折行续行、折叠标记）的正文都对齐 `Run ` 的 `n` 列 —— 执行中是两格缩进，命令一执行完就换成 `│ `。结果挂在同一棵树下：`└ ` **整块只出现一次**、在第一行实质输出上（截断提示行挂 `│ `，`└ ` 之下的输出 / warnings / `Took Xs` 只缩进两格不再画竖线），没有输出时补一行 `(no output)`（`└ ` 挂它前面）；`│ ` / `└ ` 取 `muted`（结构符，`Run ` 取 `toolTitle`；两者**各自是一段独立的前景 SGR**，前缀绝不继承后面 token 的颜色 —— 曾经路径那行的 `│` 跟着 path 色飘过）。只有 `Run` **这一个词**加粗（`bold("Run") + " "`，包住整个前缀会把行尾那格间距也变粗），命令正文一律不加粗（原先是命令名加粗）。**命令失败时** pi 把状态当普通输出拼在结果末尾（`appendStatus` 的 `\n\n` + `Command exited with code N` / `timed out after N seconds` / `aborted`，无输出时正文已被 pi 换成了 `(no output)`）—— 那句 `\n\n` 原本渲染成两行**没有前导符**的空行（用户说的“中间断层两层”），现在 `trimPreviewLines` 把状态与其前的空行一起摘下来、空行不画、状态当作预览必占的一行（否则它会被预览裁掉，只剩一条 `│ … (N earlier lines)`），`└ ` **之上**的空行补 `│ `（用户 2026-09-21 定的：栅栏不能断在空行上；来源是 pi 预览窗口开头的空行与失败状态前面的分隔空行），`└ ` **之下**的空行保持空行（树在那里就落地了，下面那截是缩进对齐的续行 —— 更多输出、`[Full output: …]` 之类的 warnings、`Took`，各自成段；挂竖线反而像还没完），最后按 `error` 槽染红（`isError` + `isFailureStatusLine` 两道判定：只看形态会把 `echo "Command exited with code 2"` 这种正常输出也染红）并放回尾部，展开态（ctrl+o）同样染色（不裁行、不挂树）。整块**既不带底色也不留边界空行**（`Box` 不带 bgFn、`paddingY: 0`：命令就是块的第 1 行、结果就是最后一行；左边距由组件自己画 —— 首行是 `• `、其余行两格空格，结果侧挂同宽的那一列。**只去 bash 的**底色，其他工具照旧）。同时保留：非流式（`onUpdate` 摘掉）、break-all 硬折行 + 行首 `Run ` 语法高亮（`syntax*` 槽）、`/bash-preview` 输出预览行数、`/bash-timeout`、短命令（<2s）不画 `Took` 页脚、`bashOutput` 独立输出色。详见文件头与 `bash-command-collapse/render.test.ts` |
| `read-path-collapse.ts` | read 工具块的标题 + 结果（**用户 2026-09-21 定，与 bash 块同一套观感**）：`renderShell: "self"` 让 pi 不再套默认壳，于是整块**没有底色**（pending / 成功 / 失败三色底都不画）、**没有上下边界空行**（默认壳 `Box(1, 1)` 的那两条），只有内容本身；标题行 `• Read <路径>` —— 状态圆点 `•` 在**列 0**、`Read` 的 `R` 在**列 2**（正文整体右移一格），圆点颜色三态：**读的时候（pending / partial）`dim` 灰、成功 `toolDiffAdded` 绿、失败 `toolDiffRemoved` 红**（与 `bash-command-collapse.ts` 的 `stateBarAnsi` 同源，字形也一样）；结果正文每行两格缩进（与 `Read` 同列），pi 那个前导 `\n` 空行被剥掉，所以正文紧贴标题。左边距由孩子自己画（`withHeadBar`），`Box(0, 0)` 的孩子按 `width - MARGIN_WIDTH - RIGHT_PAD` 渲染。**只影响 read**：其他工具仍走 pi 的默认壳（有底色、有边界空行），有专门的对照断言。原有能力一字未动：长路径压缩成一行（`…` 前缀，装得下的短路径走 pi 原生渲染只换 `accent`→`text` 一个色）、工具名首字母大写（`Read`）、`[skill]` / `read docs` / `read resource` 紧凑形态、OSC 8 超链接、`(ctrl+o to expand)` 提示、`app.tools.expand` 从 keybindings.json 读。12 个端到端断言见 `read-path-collapse/render.test.ts`（含一条回归：cwd 之外的资源文件压缩后标签必须是路径而不是 `.`） |
| `prompt-editor.ts` | 输入框 `❯ ` gutter（`!` bash 模式下换成 `!`、正文里输入的 `!` 不再显示）+ 补全列表与 statusline 之间补一行空行；纯逻辑在 `prompt-editor/bash-prompt.ts` |
| `cwd-statusline.ts` | 用 `setStatus` 在 statusline 第二行显示完整 pwd（不经任何路径压缩） |
| `folder-history.ts` | 按工作目录持久化命令历史，注入编辑器原生 ↑/↓（**不注册快捷键** —— 上游的 ctrl+↑/↓ 在 macOS 上被 Mission Control 抢走） |
| `clear-command.ts` | `/clear` 别名 → `ctx.newSession()`（先 `waitForIdle`，与内置 `/new` 同一条流程） |
| `exit-command.ts` | 整行 `exit` / `quit` 优雅退出（只在 TUI 模式；`--print` 里仍是普通 prompt） |
| `init-command.ts` | Claude Code 式 `/init`：`CLAUDE.md` → 否则 `AGENTS.md` → 否则新建 `AGENTS.md` |
| `ask-user-question/` | Claude Code `AskUserQuestion` 式的结构化提问工具（子会话里按 `ctx.hasUI` 自动摘掉） |
| `mcp/` | MCP 服务器 → pi 工具（`mcp__<server>__<tool>`）；自带 stdio / streamable HTTP / 旧版 SSE 三种传输与 `/mcp` 命令。配置、约束与验证方式见上一节 |
| `simple-task/` | 轻量任务清单（`task_set` / `task_update` / `task_get`）。计划批准后模型认为该建清单就自己 `task_set`，扩展不再代它建（2026-09-24 起与 plan-mode 无耦合）。三个工具都带 `renderShell: "self"`（用户 2026-09-26 定，与 bash / read 块同一套壳）：整块**没有底色**（pending / 成功 / 失败三色底都不画）、**没有上下边界空行**（默认壳 `Box(1, 1)` 的上下两条）；标题与结果都从**列 1** 起 —— 每行前置一个空格、不顶格（补回默认壳原本的那一列左边距，由 Text 的 `paddingX = 1` 画）；块上方只剩 pi self 模式固定的那一行留白。形状断言见 `render.test.ts`（3 个端到端用例，含「其他工具底色照旧」的对照） |
| `plan-mode/` | Claude Code 式 plan mode + **三态权限模式**（`dangerous` / `bypass` / `plan`）。`shift+tab` 走固定循环 `dangerous → bypass → plan → dangerous`；`/plan` 只切 plan（永远不落到 dangerous）、`--plan` 启动即进；模型可自行调 `enter_plan_mode` 进入、用 `exit_plan_mode` 提交**一份完整方案文本**等用户批准；批准后模型把方案落成计划文档（`.pi/plans/`），写完自动收尾并回到**进入前的模式**。dangerous 关掉沙箱删除拦截，bypass 开启。详见下文 |
| `core-rules/` | 对抗全局 AGENTS.md 的注意力衰退：把蒸馏版核心铁律（`~/.pi/agent/AGENTS.core.md`，约 6KB，仓库镜像 `clients/pi/AGENTS.core.md`）在会话开始 / 压缩后 / 内容变更三个时机持久化注入到上下文末尾（用户消息之后），照 Codex 的 world-state diff 语义（不变不发、变了带替换声明）。判定在 `decision.ts`；`PI_CORE_RULES=off` 关闭 |
| `verify-loop/` | **验证闭环 + 评估器**（补 issue #12 权重最高的一格空白），对齐 CC 的两个原生件，落在 pi 官方的 `agent_before_settle` 边界上（"the final actionable boundary: it can append entries and request one continuation"）。**(1) 闸**（CC 的 `type:"command"` Stop hook）：每次 settle（仅 `outcome==="completed"`，abort / error 不触发 —— CC 的 Stop / StopFailure 分流）检查本次 run（最后一条 user 消息之后）：有文件改动（`edit`/`write`/`apply_patch`/`multiedit`，非文档路径）但**改动之后没跑过任何 bash 命令** → 追加一条 `display:true` 的注入消息（用户可见 = CC 的 "Stop hook feedback"；同时以 user 角色进模型上下文）并 `continue:true` 强制续跑一轮。**拦截次数不用内存计数器，而是数投影里已注入的同类消息** —— `agent_start` 在每次边界续跑时都会再 fire（`runAgentLoopContinue` 里 emit），挂在它上面的复位会在续跑链里把计数清零、上限失效；从投影数则天然分支正确、resume 后仍正确、无可变状态，且注入消息是 `role:"custom"`（不是 user），不会切断 run 窗口 —— 整条续跑链共用一个窗口，正是 CC「同一 turn 内连续 block」的语义。上限默认 2（`PI_VERIFY_LOOP_CAP`；CC 的通用 8 是给任意用户 hook 的）。**verification 口径 = 任何 bash 调用**：2026-09-25 第一次活体冒烟量到误报 —— 模型改完 `probe.js` 跑的是 `node --input-type=module -e "import('./probe.js')…"`，真证据但不匹配任何测试形状，被闸第二次拦下；词法判不了「这条命令是不是*相关的*测试」（那是评估器的活），所以闸只问「改动之后有没有观察过实际状态」。`PI_VERIFY_PATTERN=strict` 恢复只认测试/构建/lint 形状，或给自定义正则。**(2) `/goal`**（CC 的会话级 prompt 评估器，手动设定、之后每轮自动评估）：`/goal <条件>`（≤4000 字符，CC 同限）存 `appendEntry` 并立即以条件为指令起一轮；此后每次 settle 先问子代理在不在跑（在 → 本轮跳过，CC 的 "background work defers evaluation"，复用 `recap/subagents.ts` 的 RPC），再发一次**不带工具**的独立模型调用（条件 + `serializeConversation(convertToLlm(投影))` 截尾，默认 120k 字符），解析三裁决 JSON（`met`/`not_met`/`impossible`，裸 / 包 code fence 都认）：未达成 → 理由注入续跑；达成 / 不可能 → 记录条目并清除。**fail-open**：评估失败 / 超时 / 解析不出 → 放行（CC 的 hook 失败同样不拦回合）。无进展检测（连续 2 轮续跑零工具调用 → 停循环、goal 保留，CC："stops the loop … with the goal still set"）与 8 次续跑上限（`PI_GOAL_CAP`，CC 的数字）同样从投影数。resume 恢复活跃 goal 但重置轮数计时（CC："carries the condition over but resets the turn count"）；已达成 / 已不可能的不恢复。评估模型 `PI_VERIFY_EVALUATOR_MODEL=provider/modelId`，缺省 `litellm-any/qwen3.8-flash`，再退回当前会话模型；已知成本 —— 这些路由的 thinking 是 `gateway/config.yaml` 钉死的，评估调用也付 thinking（实测 3-20s）。**与 CC 的唯一有意偏离**：CC 默认不装任何 hook（用户在 settings.json 配置）；这里没有 hooks 配置层，所以闸**默认 block 开启**、触发条件收得极窄，`PI_VERIFY_LOOP=off|notify|block` 一键切换。2026-09-25 活体验证（隔离 agent dir + SDK 驱动）：闸拦一次后模型补验证放行；`/goal VALUE=42` 驱动模型真改文件到 `met`（证据是命令输出）；只口头声称的一轮被判 `not_met` → 注入理由 → 真干活 → `met`；不可满足条件判 `impossible` 并清除。量到的一个 pi 限制（非本扩展 bug）：会触发回合的扩展命令（`/goal`，以及既有的 `/init`）在 `-p` print 模式下不生效 —— `session.prompt()` 在命令的 `sendUserMessage` 回合开始前就返回。91 个 `node --test` 用例：`gate.test.ts`（24）/ `goal.test.ts`（23）/ `evaluator.test.ts`（23）纯逻辑 + `index.test.ts`（21）走 pi 真加载器（假子代理总线 + 假 model registry） |
| `memory/` | **类 CC auto-memory**（补 issue #13 权重最高的一格空白：记忆 / 跨会话学习）。存储照 CC：`~/.pi/agent/memory/<git根slug>/` 下 `MEMORY.md` 索引 + 一记忆一文件（CC 兼容 frontmatter：`name`/`description`/`metadata.type` 四选一 user/feedback/project/reference /`modified`）。**方案 C：索引由扩展机械派生，模型不手写** —— `memory_write` 写完正文后扫全部正文 frontmatter 自动重建索引（内容一致不落盘，幂等），消除 CC/Qoder 都在搏斗的「忘更新索引 → 写进去却永远召回不到」故障源；手改正文文件后下次 `before_agent_start` 自动纳入索引。注入走 `before_agent_start` 改 `systemPromptOptions.sections.memory`（纪律文本 + 索引，空库不注入）—— section 进 system message、随 transcript 重放、压缩后存活；索引只在写入时变化，字节天然稳定，**不需要 pi-memory 那套 KV 缓存快照机制**。纪律文本 = CC 三道闸（applicable/durable/legible）+ 时态判据（只存过去时观察，不存现在时仓库状态断言 —— 过去时永不过期，现在时必然腐烂）+ 读取端核实义务（记忆是快照不是地面真相，点名文件/函数/flag 的记忆行动前先核实，AGENTS.md `## Verification` 同款）+ 不存密钥。四个工具：`memory_write`（写正文+重建索引，同名=更新）、`memory_read`（读正文/列全部）、`memory_forget`（删除+索引更新）、`memory_search`（零依赖关键词检索，frontmatter 命中权重 3 / 正文 1）；全部文件读写包 `withFileMutationQueue`（工具调用并行执行）。`/memory` 命令（对标 CC 三项）：状态行 + 打开目录 + 显示索引 + 开关（per-project `.disabled` 标记）。`PI_MEMORY=off` 整体关闭，`PI_MEMORY_DIR` 覆盖记忆根（测试隔离）。**v1 刻意不做**：后台 dream 固化（留挂载点）、USER/PROJECT 双 scope（仅 per-project）、qmd 语义搜索、写入机械闸（时态/密钥靠纪律文本）。26 个 `node --test` 用例：`store.test.ts`（10）/ `context.test.ts`（4）纯逻辑 + `index.test.ts`（12）走 pi 真加载器（含 issue #13 那个 promptSnippet 被剥 bug 的回归断言）。设计文档 `docs/superpowers/specs/2026-09-26-pi-memory-design.md` |
| `bash-command-collapse/sandbox.ts` + `allowlist.ts` | bash 命令的 seatbelt 删除能力边界（`bash-command-collapse.ts` 的 `execute` 里包裹）与**三档授权**（用户 2026-09-24 定）：**永不删除**（身份/凭据/手写配置：`~/.zshrc`、`~/.gitconfig`、`~/.env`、`~/.bash_history`、`~/.envrc`、`~/.tool-versions` 等 home 一级文件（49 项），以及 `~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.kube`、`~/.docker`、`~/.azure`、`~/.gcloud`、`~/.terraform.d`、`~/.helm`、`~/.minikube`、`~/.password-store` 等子树（21 项）；**名字里可以带斜杠** —— `~/.config/gh`（`hosts.yml` 存 GitHub token）与 `~/.config/gcloud`（凭据库）是两条嵌套条目，2026-09-25 补，专门把「`~/.config` 整棵移出本档」之后落在两级的真凭据捞回来；代价是 `isSafeAllowlistRoot` / `isSafeSessionRoot` 的**祖先闸改为只查危险档**（用户 2026-09-25 选），否则 `~/.config` 会因「是 `~/.config/gh` 的祖先」而永远记不住 —— 安全上无损失，内核 deny 行在 allow 行之后无条件收回，`classifyOutsidePaths` 也先判 blocked 再判白名单，记住 `~/.config` 交不出 `~/.config/gh`；`~/.config`、`~/.pi`、`~/.claude`、`~/.codex` 于 2026-09-25 移出本档 —— 它们是工具状态目录，含 lock/缓存/会话日志，整棵子树不给删连 pi 自己清理 stale lock 都会被内核拦死，现走普通档弹框可记住）——**不弹框、无任何放行选项**，白名单 / 会话豁免 / `PI_SANDBOX_EXTRA_WRITE` 都压不过（profile 在 allow 行之后另起一行 deny 收回，内核级强制）；**危险目录**（系统根 / bin / 应用安装目录 / `~/Library` / 含 `.git`）每次删除必问、只支持会话级豁免（选项 `Deny` / `Allow once` / `Allow for this session`）；**普通目录**问一次（`Deny` / `Allow for this session（并记住该目录）` / `Allow once`），选中间那项后把目录范围写进持久白名单 `~/.pi/agent/sandbox-allowlist.json`（`PI_SANDBOX_ALLOWLIST` 可改位置），以后含 headless 都不再问。记住一个目录 = 把它并进 seatbelt profile 的 `file-write-unlink` 放行名单，删除在沙箱内直接成功。可删边界 = 项目目录 + 临时目录（`/tmp`、`/private/tmp`、`/var/folders`、`/private/var/folders`、`/var/tmp`、`/private/var/tmp`）+ **可再生缓存**（`~/.cache`、`~/.npm`、`~/.gradle/caches`、`~/.m2/repository`、`~/.cargo/registry`、`~/.bun/install/cache`、`~/.node-gyp`、`~/.Trash`、`~/Library/Caches`、`~/Library/Developer/Xcode/DerivedData` —— 删了能干净重建，静默放行；`~/Library/pnpm/store`、`~/.deno`、`~/.nvm` 含不可重建内容，**不在**名单）+ `PI_SANDBOX_EXTRA_WRITE`；`/var/tmp` 是 macOS 自带 bash 3.2 的 heredoc 临时目录（编译期写死、`TMPDIR` 改不动），不放行则沙箱内任何 heredoc 都 100% 失败。从失败输出里抽被拦路径用的是**排除法**（保留「行内绝对路径 token」兜底扫描，只排除含 `here document` 的行与行首 prog 是 shell / `sandbox-exec` 的行）而不是程序名白名单 —— 白名单会静默丢掉 python3 `PermissionError`、`find:`、`ln:` 这三类真实删除形状。**抽不出路径就不弹框**，原样报错并追加一行 `[沙箱]` 提示（出口是 `/sandbox-boundary allow <目录>`）；旧的「按整条命令会话级问一次、同意后沙箱外裸跑」降级路径已删。`/sandbox-boundary` 查看边界与白名单，`forget <path>` / `clear` / `allow <path>` 管理条目（`allow` 对永不删除路径直接拒）。同目录的 `sandbox-mode.ts` 是 plan-mode 三态的运行期开关单例（dangerous 关掉整个拦截层，见下文 plan mode 一节）。完整口径与名单见仓库根 `CLAUDE.md` 的 `### Capability boundary` 一节 |
| `sandbox-boundary/` | 同一道删除边界的非 shell 侧：`apply_patch` 的 `*** Delete File:` 行在 `tool_call` 钩子上拦截（write/edit 不拦），与 bash 侧共用同一套 `classifyOutsidePaths` 判定与同一个白名单单例，所以一边记住另一边立刻生效；命中白名单时静默放行但补一行 notify。永不删除路径整份 patch 一起拒（不给「批准其余部分」的机会）。与 bash 侧的区别：它在执行前就能拦、且已知全部目标路径，没有「命令重跑一次」的代价 |

### plan mode（`plan-mode/`）

**三态权限模式（用户 2026-09-27 定）**，`shift+tab` 走固定循环：

```
dangerous ──shift+tab──▶ bypass ──shift+tab──▶ plan ──shift+tab──▶ dangerous
```

| 模式 | 图标 / 颜色 | 权限含义 |
| --- | --- | --- |
| `dangerous` | `☢` / `error`（红） | pi 原生的任意权限形态 —— **沙箱删除拦截整体关闭** |
| `bypass`（默认） | `⏵` / `success`（绿） | **沙箱删除拦截开启**（启动、`/resume`、认不出的历史值都收敛到这里） |
| `plan` | `⏸` / `warning`（橙） | 只读探索 —— 工具收拢 + bash 写拦截，比沙箱的「只拦删除」更严 |

**dangerous 只能由 `shift+tab` 切到**：没有 `/dangerous` 命令，`/plan` 也永远不把你带进
dangerous（它只切 plan，离开 plan 时回 bypass），模型路径（`enter_plan_mode`）同样只能进 plan。
所以「关掉保护」永远是用户自己按出来的决定，不会由任何自动路径到达。

**plan 有三条出口，落点不同**（这是三态化里唯一需要记住来路的地方）：

| 出口 | 落到哪 | 为什么 |
| --- | --- | --- |
| `shift+tab` | **dangerous**（固定循环的下一态） | 按循环走，不是原路返回 —— 否则从 bypass 进的 plan 按一次看起来像没切动 |
| `/plan` | **bypass**（安全默认） | 一条命令不该把用户悄悄送进沙箱关闭的态 |
| 计划文档写完、进入实施阶段 | **returnPhase**（从哪来回哪去，可能是 dangerous） | 用户批准了方案，实施就该在他原本选定的权限姿态下进行 |

`returnPhase` 由 `enterPlan` 记下（进 plan 之前的那一态），只有第三条出口用它。回到
dangerous 时 notify 会明说「沙箱删除拦截已关闭」，不能让用户以为还在保护下。

**沙箱开关怎么传过去。** plan-mode 与两层删除拦截（bash 的 seatbelt 包裹在
`bash-command-collapse.ts`、`apply_patch` 的 `tool_call` 检查在 `sandbox-boundary/index.ts`）
分属三个扩展文件，中间只有一个 `globalThis` 单例：`bash-command-collapse/sandbox-mode.ts`
的 `getSandboxMode()` / `setSandboxMode()`（与 `allowlist.ts` 的 store 缓存同一套做法 ——
pi 的加载器不保证给两个扩展同一个模块实例，挂 globalThis 则读到的必然是同一份状态）。
两个沙箱消费方都在**执行期**读它，与注册期读的 env 总闸（`PI_SANDBOX` + 平台）取与：
任何一道说关就关。plan-mode 没装、或被 `PI_PLAN_MODE=off` 关掉时单例永远是默认的
`bypass`，拦截照旧生效（fail-safe）。

**没有 execute 态** —— 与 Claude Code 对齐：批准后写权限恢复、状态直接回 returnPhase，
「按计划文档实施」是一次性交给模型的指令，进度也交还给模型（它认为该建任务清单就自己
`task_set`，扩展不再镜像步骤、不再记进度）。

2026-09-24 之前是三态（bypass → plan → execute，批准即把步骤镜像进 simple-task 清单、
按序号记 `[DONE:n]`、状态行报 `▶ n/N`）。那套「扩展持有进度」的机制整个删除：镜像契约
（`simple-task/plan-mirror.ts`）、`[DONE:n]` 标记、步骤 widget、execute 态的每轮注入全部
随之消失。起因是用户要求高度对齐 cc 的 plan mode：cc 的 `ExitPlanMode(plan)` 参数就是
一份完整方案文本，批准后产出物是计划文档，任务清单由模型自决。2026-09-27 重新变成三态，
但第三个态是**权限模式**（dangerous）而不是进度态（execute）—— 两者毫无关系。

计划状态存会话（`appendEntry("plan-mode")`，不进模型上下文）；计划文档写进工作区的
`.pi/plans/`（被 `.gitignore` 排除 —— 计划是过程产物，不该进仓库）。

四个入口：`shift+tab`（三态循环）、`/plan`（只切 plan）、`--plan`（启动即进）、模型调
`enter_plan_mode`。`/plan-status` 看当前模式。`PI_PLAN_MODE=off` 整体关闭，
`PI_PLAN_MODE_AUTO=off` 只关模型自动进入，`PI_PLAN_MODE_CONSENT=off` 只关下面这道同意弹框。

**模型自动进入要过一道同意弹框（CC 同构）。** 模型调 `enter_plan_mode` 时不再直接进，而是先弹
`select` 两选一：`进 plan mode（只读探索）`（默认选中，直接回车即接受模型的请求）/ `直接实施`。
选后者或按 esc 都不进 plan，工具结果是「用户选择直接实施……不要再调用 `enter_plan_mode`」，模型
当轮就照用户指令动手。三个刻意点：① esc 当作否决，与 CC 的 “must consent to entering plan mode”
一致，也让「嫌烦想跳过」这条最常见路径只需一个键；② 弹框**只在模型路径**——`shift+tab` / `/plan` /
`--plan` 走 `enterPlanMode(ctx, "user")` 不经过它，那已经是用户自己的决定；③ 无 UI（`pi -p`）不弹框、直接进，
保持既有 headless 行为（那边没有人会被打扰）。这正是 CC 敢把判据写松的原因：它的 `EnterPlanMode`
是 `shouldDefer: true`，误判的代价被弹框吸收成「用户按一次键」，而不是被迫走完「进 plan → 出方案 →
审批 → 写文档」一整圈。

**brainstorming 互斥闸（二选一，用户 2026-09-26 定）。** superpowers 的 `brainstorming` 技能自带
「澄清 → 2-3 方案 → 批准 → 设计文档 → writing-plans 实施计划」全流程，与 plan mode 完全重叠。
模型调 `enter_plan_mode` 时，execute 在同意弹框**之前**先扫会话分支（`getBranch()` 的原始条目里
`type:"message"` 那层）：**本次 run**（最后一条 `role:"user"` 消息之后）内若有 assistant 的
`toolCall` 块是 `read` 且路径含 `/brainstorming/`（片段匹配，兼容技能库搬家；判定在 `brainstorm.ts`，
13 个纯用例），就**不进 plan、也不弹框**，直接回一段「二选一」说明（按技能流程走、别再调本工具、
用户想进 plan 请自己 shift+tab / `/plan`）。只拦模型路径：用户手动进入不经过这道闸。判定异常一律
fail-open（照常弹框）——误判成「没加载」只是回到旧行为，误判成「加载了」会静默剥夺 plan mode，
代价不对称。已知边界（写进 `brainstorm.ts` 头注释）：用 bash `cat` 读 SKILL.md 不算加载（只认
`read` 工具，与 verify-loop 的词法口径同级）；豁免仅本次 run，下一条新 prompt 不继承。

**路由判据只在工具描述里（CC 同构）。** `enter_plan_mode` 的 `description` 承载全部判据：7 条正面条件
（新功能 / 多种可行方案 / 改既有行为 / 架构取舍 / **>2-3 个文件** / 需求不清 / 用户偏好决定走向，最后
一条明写「如果你正打算用 `ask_user_question` 问方案，就改用这个工具」）+ 5 条豁免（一两行小修 / 需求
明确的单个函数 / **用户已给具体详细指令** / **纯调研探索审阅** / **本次 run 已加载 brainstorming 技能**）
+ GOOD/BAD 示例。全局 `AGENTS.md` 的
`## Uncertainty` 只留一条指针（判据与豁免在该工具的描述里），不再重复一份——CC 的系统提示词里同样
一句 plan 规则都没有。判据放在工具描述里，模型在决定要不要调这个工具的那一刻正好读到它，也不会与
`AGENTS.md` 漂移。

**提交与审批（三选一）。** `exit_plan_mode` 的参数是 `plan`（给用户看的完整方案 markdown）
+ **必填 `slug`**（计划文档的文件名短名：小写英文 + 数字 + 连字符，3~5 个词，如
`m5-entity-runtime`；最终文档名 `<日期>-<slug>.md`）+ 可选 `summary`（一句话总结，仅用于
写文档指令与 `/plan-status` 展示）。文档名规则（`plan-doc.ts`）：slug 清洗成**纯英文
kebab-case** —— CJK 与标点一律折掉（纯中文退化成 `plan`），路径分隔符与 `..` 进不了
文件名；撞名追加 `-2` / `-3` 绝不覆盖。审批对话框是 `select` 三选一：

| 选项 | 之后发生什么 |
| --- | --- |
| 写计划文档并实施 | 进写文档子态 → 模型 write 文档 → 自动收尾回 **returnPhase**（从哪来回哪去），收尾指令是「按文档实施」 |
| 只写计划文档 | 同上，但收尾指令是「报告路径就停，不要动手」 |
| 打回（或按 esc） | 留在 plan 态（只读），等用户反馈后重新提交 |

非交互运行（`pi -p`）没有对话框：自动按推荐路线（写文档并实施）走，不死锁。

**写文档子态（`docWriting`）。** 两条批准路线都经过它：phase 仍是 `plan`（bash 写拦截、
工具收拢全部照常），唯一的区别是 `write` 被单独放回工具表（`planModeToolSet(active, true)`），
并由 `tool_call` 钩子限死只能写计划文档那一个路径（`.pi/plans/YYYY-MM-DD-<slug>.md`，
路径在用户选路线的那一刻算好并钉死 —— 撞名判定问的是文件系统，`/resume` 后重算可能得到
不同的 `-2` 后缀）。每轮注入的上下文从只读探索换成写文档指令（带钉死的路径与计划全文）。
模型用 write 把文档写成功的那一刻，`tool_result` 钩子自动收尾：状态回 returnPhase、工具表还原、
收尾指令（实施 / 只报告路径）**替换**掉 write 的普通成功文本 —— 模型在同一轮里就能看到
接下来该做什么，不需要再调任何工具。write 失败（isError）不收尾，模型自己会看到错误并重试。

**模式指示的显示位：statusline 第二行的行首**（那个区也叫「扩展 status 区」）。
三个态**都有文案**，所以「当前在哪个模式」永远有一个固定的显示位：

| 态 | 显示 |
| --- | --- |
| dangerous | `☢ dangerous`（**`error`**，红 —— 沙箱已关，最醒目） |
| bypass | `⏵ bypass`（**`success`**，绿 —— 2026-09-27 之前是红色 `toolDiffRemoved`，三态化后红色让给 dangerous） |
| plan 等待模型出方案 | `⏸ plan`（`warning`） |
| plan 已提交、等批准 | `⏸ plan · 待批准` |
| plan 写文档子态 | `⏸ plan · 写文档中`（尾巴走 `accent`） |

这一格原先归 `simple-task`（那里显示 `✔ 7/7 done`），但**与它自己在输入框上方的 widget 重复**
（widget 是完整版：`● N tasks (…)` + 逐条清单 + spinner），那个缩略版已删除，格子让给模式指示。
注意 `simple-task` 的 widget 行**不吃这一格**，所以两者不会再抢显示位。

**模式指示固定在第二行行首**（`statusline/line.ts` 的 `STATUS_PRIORITY`）。不要改回「按注册顺序」：
第二行是超长只截断不折行，而路径 / checkpoint 计数会越长越长 —— 放尾部时一条长路径就能把它挤到
看不见（这正是改到行首的原因）。注册顺序还取决于 pi 加载扩展的顺序（目录字母序），改个文件名就会变。
优先级表之外的 key 仍按注册顺序跟在后面。

**约束是两道独立的闸，别以为只有一道：**

1. **工具集**：进 plan 时把 `edit` / `write` / `powershell` 从活动工具里摘掉，退出时按**进入前的快照
   原样还原**。本机 pi 的工具表里有二十多个扩展动态注册的工具（`mcp__*`、`ask_user_question`、
   `task_set` …），官方示例那种硬编码白名单会把它们全吃掉 —— 所以必须是快照-还原。
   写文档子态单独放回 `write`（路径仍被第二道闸限死）。
2. **`tool_call` 钩子**：`bash` 还在工具表里，所以写类命令（重定向、`rm` / `mv` / `sed -i` /
   `git commit` / `npm install` / `sudo` …）靠这道钩子拦，拒绝原因作为工具错误结果回给模型。
   判定按**简单命令**粒度切开（`cat a.txt && rm -rf b` 会拦下 rm 那段），heredoc 正文先剥掉，
   fd 复制（`2>&1`）与 `/dev/null` 这类黑洞目标放行。写文档子态里 `write` 只许写钉死的那个
   路径（写别处会被拒，拒绝原因里给出正确路径）。实现与全部边界在 `plan.ts` 的上半部分与
   `plan.test.ts`。

**这是给配合的模型用的护栏，不是沙箱。** 两个刻意放行的形状：双引号内的 `$(...)` 命令替换、
以及 `npm run <script>` 这类由脚本内容决定副作用的命令 —— 宁可放行也不要把正常探索全部拦死。
要真防住恶意写入得靠操作系统级沙箱。实测证据（`pi --plan -p "别规划，立刻用 bash 执行：echo hacked > proof.txt"`）：
模型拒绝了命令，原话是「我没法照做 —— plan mode 在拦 …… 换个写法绕过去也不行」，然后把它作为计划
提交走审批，文件是**批准之后**才创建的。

**`shift+tab` 是从 pi 内置的 `app.thinking.cycle` 手里抢来的。** 内置键位扩展抢不到
（`registerShortcut` 与内置冲突时会被 runner skip），所以走 `ctx.ui.onTerminalInput` 在按键到达编辑器
**之前**拦下并 `consume`。代价是思考等级循环键被占，因此扩展首次启动时会把
`~/.pi/agent/keybindings.json` 里的 `app.thinking.cycle` 改绑到 **`ctrl+shift+t`**。改绑的边界（`keybinding.ts`）：
只有**该键完全没有任何绑定**时才写；用户自己配过就一个字不动、也不提示（`needsAttention` 区分
「已有绑定，正常」与「配置坏了，需要你手动处理」—— 前者每次启动都提醒会变成噪音，实测踩过）。

抢键的三个条件（`index.ts` 的 `attachInputListener`）：TUI 模式 + 空闲 + 没有扩展弹窗。
**匹配 shift+tab 必须用 pi-tui 的 `matchesKey`**，不能手写 `data === "\x1b[Z"`：
shift+tab 有三种编码 —— 裸 CSI（`\x1b[Z`）、Kitty 键盘协议的 CSI-u（`\x1b[9;2u`）与 xterm
modifyOtherKeys。而 pi **启动时会主动启用 Kitty 协议**（`pi-tui` 的 `terminal.js` 发
`\x1b[>{flags}u\x1b[?u\x1b[c` 并等终端回复），一旦启用，真实终端（Ghostty / kitty / WezTerm）发的
就不再是 `\x1b[Z`。实测踩到过：pty 假终端（不回协议查询）里 shift+tab 能切，真实 Ghostty 里
完全没反应 —— 本地复现必须**让 pty 回一个 `\x1b[?1u`** 才是真实终端行为。
**流式中按 `shift+tab` 仍是切思考等级**（不空闲就不抢）—— 这是刻意的：plan mode 只在你停下来的时候才切。
弹窗打开时不抢，否则 `/model`、`/sessions` 这些 picker 里的 `shift+tab` 会跳出选择器。

### 跨扩展 / 跨文件

- **plan-mode 的三态模式 → 两层删除拦截**（`bash-command-collapse/sandbox-mode.ts`，2026-09-27）：
  plan-mode 持有 dangerous / bypass / plan 三态，而删除拦截分属另两个文件（bash 的 seatbelt
  包裹在 `bash-command-collapse.ts`、`apply_patch` 的 `tool_call` 检查在 `sandbox-boundary/index.ts`），
  所以中间放一个 `globalThis` 单例传递信号（与 `allowlist.ts` 的 store 缓存、`getSessionScopes()`
  同一套做法 —— pi 的加载器不保证给两个扩展同一个模块实例，挂 globalThis 则读到的必然是
  同一份状态）。**两个消费方都在执行期读**，与注册期读的 env 总闸（`PI_SANDBOX` + 平台）取与；
  注册期读一次就永远切不动了。单例默认 `bypass`，认不出的写入值也收敛到 `bypass` ——
  plan-mode 没装 / 被 `PI_PLAN_MODE=off` 关掉 / 还没切过态时，拦截一律照旧生效（fail-safe）。
  改这个契约时记住三件事：① dangerous 是唯一会关掉拦截的态，只能由用户 shift+tab 到达；
  ② plan 态不靠沙箱（它自己的两道闸更严），记下来只是为了状态永远与 plan-mode 一致；
  ③ 单例的键名 `pi-sandbox-mode` 是跨文件的硬契约，改名要同时改测试里那个「换一个模块实例
  读到同一份状态」的断言。
- **plan-mode 与 simple-task 不再耦合**（2026-09-24 删掉了镜像契约）：两者都能单独装、
  单独 `/reload`，互不 import、互不通信。计划批准后进度归模型自己 —— 它要建清单就调
  `task_set`，那是 simple-task 的普通工具调用，没有任何特殊路径。`simple-task/gap.ts`
  仍被 `recap/` 跨目录 import（那是另一个契约：widget 之间的空行判定，与任务清单无关）。
  `recap/subagents.ts` 被 `verify-loop/` 跨目录 import（第三个契约：「现在有子代理在跑吗」
  的 pi-subagents 进程内 RPC 探测 —— `/goal` 评估在子代理未结束时跳过本轮，CC 的
  "background work defers evaluation"；探测 fail-open，recap 不装时 verify-loop 也不该装）。
- **statusline 第二行（扩展 status 区）的显示位分配**：顺序由 `statusline/line.ts` 的
  `STATUS_PRIORITY` 决定 —— `plan-mode`（模式指示）**强制行首**，其余按注册顺序跟在后面：
  `cwd-statusline`（完整路径）、`rewind`（`◆ N checkpoints`），限 5 条。
  把模式指示放行首是因为第二行超长只截断不折行，它跟在会变长的路径后面会被挤掉；
  而注册顺序取决于目录字母序，太脆。
  `simple-task` **不再占**这个区（它曾经在这里显示 `✔ n/N`，与自己在输入框上方的 widget 重复，
  已删除）—— 改回去之前先想想是不是又造了一份重复信息。状态行里 `▶ n/N` 的 N 与数字来自
  simple-task（见上文），所以这个区与那份清单是**两个不重复的口径**：一个说模式与进度比，
  一个逐条列步骤。`verify-loop` 的 `◎ /goal active`（key `verify-goal`，仅在 goal 活跃时挂）
  也走这个区，注册顺序在字母序里排很后，被截断时先丢 —— 可接受：goal 活跃时输入框上方
  的注入消息本身就在提醒。
- **`simple-task/gap.ts` 的「看邻居」是靠*渲染邻居*实现的**：它没有枚举别人 widget 的接口，
  只能从 TUI 根往下找到装着自己的 Container，再看紧邻兄弟面向自己那一侧的渲染结果。于是
  `recap` 反过来渲染 `simple-task` 时就是**互递归**（无保护时实测递归到 depth 61+ 才被栈拦住）——
  **重入标记必须留在 recap 这一侧**（`inspectingNeighbours`，粒度是组件实例）：放在 `gap.ts` 里的话，
  嵌套那次 walk 一律返回「无间隔」，两边各补一次空行、**变成两行**。
- **`below-editor-after-statusline.ts` 靠对象身份找容器，不猜下标**：先注册一个 render 返回空数组的
  探针 widget，遍历 `tui.children` 找到「子树里装着这个探针」的顶层 child，再把它移到末尾。
  探针本身必须**显式传 `placement: "belowEditor"`**：漏写（默认落到 `aboveEditor`）会把「上方」那个容器
  整块搬走，而且没有任何运行时报错（实测踩到过，代码里只有一行注释提醒）。找不到容器就什么都不做。
- **「内置 statusline 露出来」有两个窗口，用了两套办法**：① **启动窗口**（进程刚起来 → `session_start` 轮到我们。
  实测：内置 footer 在 ~470ms 出首帧，我们的 statusline 到 ~1.2s 才装上）没有上一帧可重放，由
  `statusline/footer-suppress.ts` 在**扩展工厂**里（此时 TUI 还没 new 出来）接管 `FooterComponent.prototype.render`，
  窗口内渲染 0 行 —— 底部留白，而不是先画一个马上要变的默认状态行；我们的 footer 挂上的一刻交还，
  30s 兜底（`mcp` 握手 20s 上限也在这个窗口里，因为 `Runner.emit()` 串行 await，字母序在前的 `mcp` 先跑）。
  ② **换会话窗口**由 `footer-guard.ts` 重放上一帧压住（有旧状态可留，比留白更好）。两个开关独立：
  `PI_STATUSLINE_BOOT_SUPPRESS=off` / `PI_STATUSLINE_FREEZE=off`。
  补丁打的是包根导出的 `FooterComponent` —— 实测（0.87.1 bundle 形态，A/B pty 捕获，两次只差这一处）
  它**就是** pi 自己 `new` 出来那个类：临时改成返回 `["PROBE-FOOTER-MARKER"]` 时屏幕上真的出现这一行，
  关掉开关后内置 footer 照旧。
- **`statusline/footer-guard.ts` 与 `startup-logo/header-guard.ts` 是同一套机制的两份**（接管容器的
  `render`、重放上一帧的行），互不依赖、符号键不同。原因是 pi 换会话时 `resetExtensionUI()` 会
  **无条件**把内置 footer / header 装回去并清空所有 `setStatus`，而扩展侧没有比 `session_start`
  更早的钩子 —— 所以保证只能挪到「出帧那一刻」。`PI_STATUSLINE_FREEZE=off` 关掉冻结。
  （启动窗口那个留白补丁**也可以**这样扩到 header 上，`startup-logo/` 目前没做：启动那一段顶部
  仍会先闪一下内置 header 再换成 logo。）

### pi 平台的坑

- **`shift+tab` 不能用字符串比对，要用 `matchesKey("shift+tab")`**：它有三种编码 —— 裸 CSI
  `\x1b[Z`、Kitty 键盘协议的 CSI-u `\x1b[9;2u`、xterm modifyOtherKeys `\x1b[27;2;9~`。
  pi 启动时会**主动启用 Kitty 协议**（`pi-tui/terminal.js` 发 `\x1b[>{flags}u\x1b[?u\x1b[c`），
  真实终端一旦同意，发的就不是 `\x1b[Z` 了。同一坑对任何手写的“按了哪个键”判断都成立。
  推论：**pty 假终端默认不回协议查询，所以只能复现那种编码** —— 用 pty 验证这类交互时
  得主动回一个 `\x1b[?1u`，否则测出来的“通过”在真实终端里不成立（plan-mode 实测踩到：
  pty 里 shift+tab 能切，Ghostty 里完全没反应）。
- **扩展必须真起一次 pi 验证，不能只跑 `node --test`**：pi 直接加载 `.ts`，而 `node --test` 的类型
  擦除**不做语法/类型校验**。实测一个非法标注（`readonly (readonly 0 | 1)[][]`）22 条单测全绿，
  pi 却在加载时 `ParseError`、**整个扩展根本不加载**。最低验证是 `cp` 到 `~/.pi/agent/extensions/`
  后用 tmux 真起一次 pi，在 `capture-pane` 里搜 `Failed to load extension` / `ParseError`。
- **捕获的 `ctx` 在会话结束后会 stale，读 `ctx.ui` 会抛**（`"This extension ctx is stale after
  session replacement or reload"`），而抛出发生在读的那一刻 —— 比 widget 的 `render()` 更早，
  所以 `render()` 里的 try/catch 拦不住。**一个活过会话的定时器会直接把宿主进程带崩**（实测 exit=1）。
  `simple-task/` 与 `working-indicator/` 因此都有三层防护：回调自己 try/catch 并停表、所有 `ctx.ui`
  访问包 try/catch、`session_shutdown` 里立刻停表。
- **`renderCall` 抛异常会被 pi 静默 catch 并回退到 `createCallFallback()`** —— 界面上只少点东西，
  日志里什么都没有。`read-path-collapse.ts` / `bash-command-collapse.ts` 都踩过这一条。
- **跨扩展同名工具注册是 first registration per name wins**，所以 `bash` 的开关必须住在
  `bash-command-collapse.ts` 里，不能另开一个同样注册 `bash` 的文件（后者会被静默忽略）。
- **重新注册内置工具必须用 `createXToolDefinition()`，不能用 `createXTool()`**：后者是
  `wrapToolDefinition(createXToolDefinition(…))`，而 `wrapToolDefinition` 只保留 8 个字段
  （name / label / description / parameters / constrainedSampling / prepareArguments /
  executionMode / execute），`promptSnippet` 与 `promptGuidelines` 被静默剥掉 —— 于是 system
  prompt 的 `<tools>` 段里该工具整行消失（`visibleTools` 按 `!!toolSnippets[name]` 过滤），
  `<rules>` 段里它的 guidance 也全部缺席。**全程无任何报错**：工具照样能调、`description`
  照样进 tool schema、渲染照样正常，唯一的症状是模型看不到那几行。`tool-diff.ts` 实测踩过
  （edit / write 两行 + 5 条 guidance 全丢，70 条 system prompt 命中 0 次），修复是每处一行
  换成 `createEditToolDefinition` / `createWriteToolDefinition`（与 read 侧 `read-path-collapse.ts`
  同形）；回归测试在 `tool-diff/prompt-metadata.test.ts`（走 pi 真加载器，含「包装器确实剥掉
  元数据」的反例断言）。pi 官方示例 `examples/extensions/built-in-tool-renderer.ts` 用的正是
  `createEditTool()`，**它自己就带这个 bug**，「照着官方示例抄」不构成保护。
- **扩展 import 的 `@earendil-works/pi-tui` 与 pi 自己渲染用的**是不是同一份，取决于启动形态，
  **不能靠推测**：`pi` 命令跑的是 `dist/bundle/cli.js`，pi-tui **内联**在 chunk 里，而加载器在
  这个形态下走的是 `virtualModules` 分支（bundle 里 `isBundledNode=!0`，见
  `core/extensions/loader.js:421`），把扩展的 `@earendil-works/pi-tui` 指向**加载器那份 bundle 自己的
  命名空间** —— 与内联副本是同一个类，所以在扩展里打 `Markdown.prototype` 这类**原型补丁是有效的**
  （`fenceless-code-block/` 就这么实现，`index.test.ts` 用 pi 自己的 `AssistantMessageComponent` 渲染
  一条 assistant 消息来断言）。反过来，patch `node_modules` 里那份**毫无效果且没有任何报错**（实测）。
  同一个原因的另一面：`@earendil-works/pi-coding-agent` 在 bundle 形态下被 alias 到 `dist/index.js`
  （未打包的那套模块图），所以包根的状态型 API（`keyHint` / `keyText`）拿到的是另一个副本 ——
  即上面那条“绝不能 import”的由来。**这一条对「类」不成立（实测）**：`statusline/footer-suppress.ts`
  从包根 import `FooterComponent` 打原型，A/B 捕获证明补丁落在 pi 自己 new 的那个实例上（见「跨扩展」一节），
  而 `dist/bundle/index.js` 确实是从 `./chunks/chunk-*.js` re-export 的。`keyHint` / `keyText` 的现象仍是事实，
  但按「别在模块顶层读 pi 的状态」理解即可：打类方法没事，**读状态**别放在模块顶层。
- **`keyHint` / `keyText` 绝不能 import**（`bash-command-collapse.ts` 与 `read-path-collapse.ts`
  都踩过：扩展拿到的是 npm/dist 副本，前者抛 `Theme not initialized`、后者返回空串）。要从
  `~/.pi/agent/keybindings.json` 读键名。`startup-logo` 的提示行是唯一从包根 import 的，它整行包了 try/catch。
- **照抄 pi 的函数时，参数序也要照抄**：pi 的 `resolvePath(input, baseDir)`（`utils/paths.js`）与 node 的
  `resolve(base, target)` **正好相反**。`read-path-collapse.ts` 把 node 的 `resolve` 别名成了 `resolvePath`
  再照抄源码，于是 `resolvePath(filePath, cwd)` 看着一模一样、实际是 node 语义：绝对路径进来时 node
  直接返回 `cwd`，文件被丢掉 → `relative(cwd, cwd)` = `""` → “在 cwd 内”判定通过 → 标签退化成 `"."`。
  症状：读 `~/.pi/agent/AGENTS.md` 在窄终端上显示 `Read resource .:67-80`（实测复现，宽度 ≤ 66 触发）。
  **cwd 之内的文件碰巧正确**，所以这类坑只能用 cwd 之外的路径才测得出来（回归断言已钉）。
  现在那两行走 `resolveLikePi(input, baseDir)` —— 复刻 pi 的函数就复刻它的**签名**，别复刻它的名字。
- **扩展里没有 `toolcall_checkpoint` 事件**（pi-ai 的事件联合里只有 start / text_* / thinking_* /
  toolcall_{start,delta,end} / done / error），它是 TUI / session 编码器内部用的 `MessageFrame`。
  所以每个参数 delta 都会以 `toolcall_delta` 到达扩展，段级计数本身就是完整的。
- `usage.output` 在**流式期间恒为 0**，token 数只能从流式字符估算；`toolcall_start` 的
  `partial.content[i].name` 已经带工具名，但缺块时拿不到，所以 `tool_execution_start` 仍是权威兜底。

### 几个「看起来可以简化、其实不行」

- **`bash-command-collapse.ts` 的命令行形状是「`• Run ` + 2 行 + 行尾 `…` + `… +N lines`」**（用户 2026-09-21 定）：
  续行 / 折叠标记的正文列对齐 `Run ` 的 `n` 列（2 列前缀：执行中是空格、出结果后是 `│ `），命令溢出多少都只
  吃最后 1 行。结果侧的 `└ ` **在整块里只出现一次**、挂在第一行实质输出上（截断提示行之上都挂 `│ `，之下只缩进），
  所以它必须在**所有 child 的行都走完后统一上**（`prefixTreeLines` 接在 `withPreviewLimit` 的末尾调一次）——
  逐 child 各画一棵树会在 warnings / `Took` 段再长出一个 `└ `。没有输出时补一行 `(no output)`（`└ ` 挂它前面），
  流式 partial 期间不补（那时“还没输出”不等于“没有输出”）。整块**没有任何底色**（`Box` 不带 bgFn：pending 的
  `toolPendingBg` / 成功的 `toolSuccessBg` / 失败的 `toolErrorBg` 三种底都不画，用户 2026-09-21 定）—— 状态改由
  命令**首行**行首那颗圆点 `•`（执行中 `dim` / 成功 `toolDiffAdded` / 失败 `toolDiffRemoved`，续行、折叠标记与
  整棵结果树前面都没有）表达，**着色逻辑与早先的 `▎` 一字未变**；圆点后面接一格空格，即「正文整体右移一格」，
  `Run` / `│` / `└` 同在列 2、所有正文同在列 4（用户 2026-09-21 第二轮定；命令行与结果侧必须同时移，否则两截会
  错开，`INDENT_WIDTH` 就是这一格）。左边距全由扩展自己画（`Box` 的 `paddingX` 在命令侧是 0：`withHeadBar`
  首行 `• `、其余两格空格；结果侧留 1 格再由 `withPreviewLimit` / `prefixTreeLines` 挂 `INDENT_WIDTH` 那一列），
  两边各自把用掉的列从 `wrapWidth` / `contentWidth` 里扣回来。**整块上下也没有空行**（`paddingY: 0`：命令就是块的
  第 1 行、结果就是最后一行）。底色只去 bash 这一个工具 —— 其他工具（read / grep / edit / write …）走 pi 自己的
  `contentBox` + bgFn 渲染路径，完全不受影响（有专门的回归断言盯着这条）。形状与 25 个端到端断言见
  `bash-command-collapse/render.test.ts`（过 pi 自己的加载器 + `ToolExecutionComponent`，断言的是渲染出来的行）。
  `PI_BASH_TREE` 已废弃（前缀固定用树形）。
- **read 块与 bash 块共用同一套壳的约定**（用户 2026-09-21 定）：两者都用 `renderShell: "self"` + 「自己不去画底色」（不是画上再擦）得到**无底色、无上下边界空行**的块，左边距都是**两列**（首行 `• ` + 一格，其余行两格空格），圆点颜色都是 pending `dim` / 成功 `toolDiffAdded` / 失败 `toolDiffRemoved`。`read-path-collapse.ts` 的 `MARGIN_WIDTH = 2` 与 `bash-command-collapse.ts` 的 `GUTTER_WIDTH + INDENT_WIDTH = 3` 是**两条独立的算式**（bash 那边还要算树形 gutter），但左边缘必须对齐 ——**改一个必须看另一个**，否则两个工具的块会错开一列。宽度预算也一样：`Box` 的 `paddingX` 是 0 时，孩子拿到整宽，壳自己得按「左边距 + 末尾留白」扣回来。
- **read 的折叠态在成功时没有结果正文**：pi 的 `formatReadResult` 开头是 `if (!options.expanded && !isError) return ""` —— 读成功且没展开就只有一个标题行。所以测结果正文的列位要用**失败**那一次（`read-path-collapse/render.test.ts` 里就是这么写的），别以为正文丢了。
- **`bash-command-collapse.ts` 判定「参数还在流」是 `!streaming && !argsComplete && isPartial === true`**
  （`streaming` = 用户开了 `PI_BASH_STREAM=on` 走 pi 原生流式，此时整条压命令的路径直接跳过）。
  后两个阈值**缺一不可**：只用 `isPartial` 会把命令压到结果之后（退化成「全等结果才一次性出」）；
  只用 `argsComplete` 则 `/resume` 重建历史时它永远是 `false`（`renderSessionItems` 从不调
  `setArgsComplete`），恢复出来的 bash 块**只剩输出、命令行整行消失**。
- **`renderResult` 里 `isError` 必须从 `context` 读，不能从 `result` 读**：pi 调 resultRenderer 时传的是
  `{ content, details }`，**没有 `isError` 字段** —— 读 `result.isError` 永远拿到 undefined，
  于是失败的命令也会染成 success 底色。
- **pi 的 bash 渲染器不看传给 `renderResult` 的 theme 参数**：`renderers/bash.js` 的签名是
  `renderResult(result, options, _theme, context)`，输出正文用的是**模块级 `theme` 单例**
  （`Proxy` → `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]`）。想让 bash 输出单独
  一色（扩展 token `bashOutput`）只能改那个单例的 `fgColors` 表 —— `bash-command-collapse.ts` 在
  委托内置渲染器的**同步窗口**里换进换出（`withBashOutputColor`）。代价与前提：那只 map 是全局的，
  所以窗口必须同步、只能换 `toolOutput` 一个 key，且 `fgColors` 哪天被 pi 藏起来就会静默退回原色。
- **simple-task 的三个工具也带 `renderShell: "self"`**（用户 2026-09-26 定）：与 bash / read 块同一套观感 ——
  整块没有底色、没有上下边界空行。它不需要 bash / read 那套自绘左边距（`withHeadBar`）：
  `renderCall` / `renderResult` 返回的是 `new Text(…, 1, 0)` —— **`paddingX = 1`** 补回默认壳
  `Box(1, 1)` 原本提供的那一列左边距（每行前置一个空格、不顶格，用户同日补定），
  **`paddingY = 0`** 保持上下不留空行，无 bgFn，所以不用再包 Box。`render.test.ts` 的 3 个用例
  过 pi 自己的加载器 + `ToolExecutionComponent` 钉住形状（含「其他工具底色照旧」的对照断言）。
- **两个覆盖内置 bash / edit / write 的扩展都用 `renderShell: "self"`**，动机不同：
  `tool-diff.ts` 是为了逐行拼 `\x1b[48;2;…m` 画整行 diff 底色（走 `selfRenderContainer` 就绕开了
  `tool-execution.js` 里按状态整块染色的 `bgFn`，否则逐行底色会被整块绿底盖掉；它**不用 Box**）；
  `bash-command-collapse.ts` 是为了让「流式接命令字符时屏幕上一行都不出」成为可能 —— 它把这个副作用
  **当成需求用**：pi 不再套 bgFn，而扩展自己也**故意不套**，于是 bash 块没有任何底色（别的工具照旧）。
  **`paddingY` 必须置 0**（否则两个 Box 的 padding 会叠出**三个空行**；上下外边界也一并不留）。
  命令侧 `paddingX: 0` —— 左边距（首行 `• `、其余两格空格）由 `withHeadBar` 自己画；结果侧留 1 格，
  再由 `withPreviewLimit` / `prefixTreeLines` 挂共用的 `INDENT_WIDTH`，命令行与结果树因此始终同列。
- **`prompt-editor.ts` 的 `!` bash 模式只改渲染层，正文一个字符都不动**：判定照抄 pi 的
  `interactive-mode.js`（`text.trimStart().startsWith("!")` —— 边框颜色 `updateEditorBorderColor`
  用的就是同一个标志），所以 gutter 和输入框颜色永远一致；正文里那个 `!` 只是「摘掉第一个可见字符
  + 行尾补一列空格」，Enter 提交（`text.startsWith("!")`）、↑ 历史、Esc 清空全都不用配合。
  代价是隐藏列会变成可落点，所以 `handleInput` / `handleMouse` 之后都要把光标从 (0,0) 挡回 (0,1)
  （调 Editor private 的 `setCursorCol`，没有公开 setter），点选坐标也要多算 1 列 —— 正文在视觉上
  整体左移了一列。放进那一列的话，反显光标会落在空列上（看起来光标消失），而且在那儿打字会把
  `x!ls` 写进正文、pi 当场判定退出 bash 模式。
- **`theme-command.ts` 的预览/落盘/取消三条路径全靠 `ctx.ui.setTheme()` 的两条路径语义区分**：
  传 **Theme 对象** → `setThemeInstance()`（只换色、不写 `settings.json`）；传**名字** →
  `setThemeName()`（应用**且立刻写盘**）。所以预览必须走对象路径，只有回车才走名字路径。
  选择器里主题列表与色卡区之间有一个 `Spacer(1)`：两者都是多行块，紧贴在一起分不清边界。
- **`rewind/` 的 esc esc 第二次按键必须吃掉**（`{ consume: true }`）：`/rewind` 派发后选择器是
  **同步**获得焦点的，而 pi 的输入管线是「先跑扩展 input listener、再交给聚焦组件」—— 不吃掉的话
  这次 esc 会直接落到刚打开的选择器上（`tui.select.cancel`），菜单刚弹出就被自己取消（实测就这么失败的）。
  吃掉它还顺带保证：即使 `doubleEscapeAction` 写回 `tree`，pi 内置逻辑也看不到第二次按压。
  第一次 esc **原样放行**，所以单个 esc 仍能中断流式回复。

### 存储与副作用边界

- `rewind/` 的快照存在**影子 git 仓库**里（`~/.pi/agent/rewind/<项目哈希>/git`，`GIT_DIR` 指过去、
  `GIT_WORK_TREE` 指向项目），**从不碰用户仓库的 HEAD / index / refs / status**，目录不是 git 仓库时也能用；
  根外与 `.gitignore` 挡掉的文件靠 `tool_call` 事件里的**惰性预镜像**兜底（blob 按内容寻址）。
  已知限制：只跟踪 `edit` / `write` 两个工具（`bash` 写到根外无法解析），大于 8MB 的文件不拷。
- `simple-task/` 的状态用 `pi.appendEntry` 骑在 session 日志里（**不往工作仓库写**），重建时必须读
  `ctx.sessionManager.getBranch()` 而不是 `getEntries()`，否则分支导航会把已丢弃分支上的状态复活。
- `verify-loop/` 分两种存储，别混：**goal 本身**（条件 / 状态 / 已评估轮数 / 最近裁决）用
  `pi.appendEntry("verify-loop-goal")` 骑 session 日志，`session_start` 从 `getBranch()` 重建 ——
  所以 resume 自然恢复、新会话自然清除；而**计数器**（闸拦了几次、/goal 续跑几次、连续几轮无进展）
  **不落盘也不进内存**，全部从模型可见投影（`event.context.contextMessages`）里数已注入的
  `verify-loop` 消息得出 —— 理由见上面扩展表里那一行（`agent_start` 在每次边界续跑都会重发，
  内存计数器会被清零）。注入消息本身是 `display:true` 的 `custom_message`，**会进模型上下文**
  （这正是闸的作用机制），与 recap 的「不落盘不进上下文」是两种刻意不同的选择。
- `recap/` **刻意不落盘、不进上下文**：不调 `appendEntry`，摘要只活在内存里，`/new` 或 `/resume`
  后不恢复（**刻意的，不是 bug**）。它探测子代理是否在跑走的是 pi-subagents 的进程内事件总线 RPC
  （`subagents:rpc:v1:request`），**不 import 它的任何文件** —— 独立安装的 npm 包，换台机器可能根本没装，
  探测失败一律当「没有子代理」。
  **`/recap` 是幂等的**：同一轮对话（最后一对 user+assistant 与模型都相同）已经生成过摘要、且它还挂在
  屏幕上时，再执行直接返回 —— 不重跑模型、不清 widget、也不发通知（一次失败的重复生成会用「没能生成
  recap」的提示把刚生成的摘要顶掉，这正是要避免的）。指纹只在一个地方算：`latestExchange()`，`generate()`
  的去重与命令的闸门共用它；有新对话（指纹变化，或 `input` 事件先清了状态）时闸门自动放开。
- `auto-default-model/` 会写 `~/.pi/agent/settings.json` 的 `defaultProvider` / `defaultModel`
  （pi 的 `/model` 只改当前会话，本机把那次 Ctrl+S 自动化掉了）。
- 删除边界的持久白名单 `~/.pi/agent/sandbox-allowlist.json` 是**机器本地状态**（见下表）：
  它记的是「哪个目录被用户确认过安全」的授权决定，不是配置，不进快照；`PI_SANDBOX_ALLOWLIST`
  可改位置（测试靠它隔离）。写入是原子的（临时文件 + rename），损坏 / 版本不认识降级为空不抛；
  危险范围（`/`、`$HOME`、含 `.git` 的路径）与**永不删除路径**（`~/.ssh`、`~/.gnupg`、`~/.zshrc` 等）
  在写入前与加载时**两道过滤**，手改的 JSON 也塞不进去。
  会话级豁免（危险目录的 `Allow for this session`）与单次豁免（`Allow once`）不落盘，只活在进程内存里（globalThis 单例，
  bash 侧与 apply_patch 侧共享）。

## 刻意不入库的机器本地文件

| 文件 | 为什么不入库 |
| --- | --- |
| `~/.pi/agent/auth.json` | 凭证 |
| `~/.pi/agent/trust.json` | 各机器自己的项目信任决定（按绝对路径记录） |
| `~/.pi/agent/models-store.json` | pi 内置模型目录的缓存 |
| `~/.pi/agent/settings.json.bak*` | 手工备份 |
| `~/.pi/agent/sessions/` | 会话记录 |
| `~/.pi/agent/missions/`、`run-history.jsonl` | `pi-subagents` 的 mission / 运行历史，换机器没有迁移价值 |
| `~/.pi/agent/rewind/` | `rewind/` 的影子快照仓库 |
| `~/.pi/agent/sandbox-allowlist.json` | 删除边界的持久白名单（哪个目录被用户确认过安全），是授权决定不是配置，换机器不该跟着走 |
| `~/.pi/agent/plans/` | 机器本地的计划与一次性脚本 |
| `~/.pi/agent/npm/`、`bin/` | pnpm 装的包（靠 `pi install` 重拉）与 pi 自带的 `fd` / `rg` |
| `~/.pi/agent/web-search-cache/`、`~/.pi/folder-history/*.jsonl` | 运行时缓存 / 历史数据 |

另外，`settings.json` 的 `extensions` 字段是本快照与本机真实配置**唯一刻意保留的差异**：真实文件里它指向
`~/.loongsuite-pilot/plugins/pi-coding-agent/index.mjs`（另一个工具装的遥测扩展，本机版本已被置空成 no-op；
机器专属绝对路径、不属于 pi 自身配置），模板里置为 `[]`，只保留 `extensions/` 目录的自动发现。

## 快照维护约定

没有安装脚本，所以同步是**双向手动**的：

- **改了本机全局配置 / 扩展** → 手动把 `~/.pi/agent/` 下的 `AGENTS.md` / `settings.json` / `models.json` /
  `mcp.json` / `pi-statusline.json` / `web-search.json` / `extensions/*` / `themes/*.json` 拷回本目录，
  保持模板与实际环境一致 —— 只有上文列的那三处是刻意差异，其余应当逐字节相同。
  （`mcp.json` 里是**本机 MCP 可执行文件的绝对路径**，与 `models.json` 的 `baseUrl` 同类：入库作模板，
  换机器照着改 `command`。）
- **换机器 / 重装** → 按前面的 `cp` 装回去，再 `pi install npm:pi-web-access` 与 `pi install npm:pi-subagents`。
- **改完扩展的最低验证**是真起一次 pi（见上文「pi 平台的坑」——`node --test` 不校验语法）。
- **面向本机 pi 的写法约定**：纯逻辑模块刻意**不 import pi / pi-tui**（鸭子类型 + 结构化最小接口），
  这样 `node --test` 能直接跑；`tool-diff/`、`statusline/`、`recap/`、`rewind/`、`simple-task/`、
  `working-indicator/`、`startup-logo/`、`thinking-collapse/`、`fenceless-code-block/`、`prompt-editor/`、`user-message-bar/`
  都按这个约定拆出了可单测的伴生模块
  （`thinking-collapse/window.ts` 只注入一个 `widthOf`，`node --test clients/pi/extensions/thinking-collapse/window.test.ts`）。
  `mcp/` 更进一步：`protocol.ts` / `config.ts` / `client.ts` / `tools.ts` / `headers-command.ts` **全部不 import pi**，
  只有 `index.ts` 接线 —— 所以整条 MCP 链路（含真实 spawn 子进程）都能 `node --test` 覆盖。
- **`AGENTS.md` 自设 19000 字符预算**（当前 **19952 字符** ≈ 4988 tokens，**已超预算 952 字符**）：
  pi 本身没有上限 —— 0.87.1 的 `system-prompt.js` 是原样拼接 context files、无截断，实测把标记放在
  9500 字符处仍被模型逐字读回；这条上限是自设的每请求固定开销预算，一路放宽：7400 → 8000（skill 优先级
  与 shell 卫生）→ 9600（issue #8 的 `## Uncertainty` 节）→ 18000（2026-09-23 删除安全 / 爆炸半径重写）
  → **19000（2026-09-23 审议式/门控式升级，issue #10）**。最后一档把执行风格从「直接式/精益式」改成
  「CC 式审议/门控」：`## Uncertainty` 的 plan 触发从「会分叉才进」改为**默认准入**（多文件、任何设计/
  结构/接口/数据形状取舍、文档重写或重构、方案未定都先进 plan，仅极简单单文件小改豁免），并新增
  「实质取舍先问」一条；新增 `## Delegation` 节（subagent 仅用户明确点名才调、调查默认内联、被授权的
  委派仍守全部纪律）；`## Verification` 加两条（写文档前逐条对权威来源核事实、报告须写明跑了哪些验证）。
  同一次改动里压缩了现有节腾空间（Git↔Shell 的交互式禁令去重、secrets/staging 三条合并、Destructive
  actions 措辞瘦身），所以抬上限是买新规则而非灌水。下次再加规则前仍须先压缩或再抬上限。
  **2026-09-24 把 plan 门控回摆了一档**（上面那档「默认准入」的修正，不改写历史记录）：实测本机
  23 个 session / 97 条用户指令里模型主动进了 **15 次** plan（15.5% 的指令、61% 的 session），且误报
  集中在两类——纯调研/写报告（CC 明列 “Pure research/exploration tasks” 不进 plan）和用户已给具体
  详细指令的小改（CC 的 BAD 清单正是这一条）。照 CC 的做法改了两处：① **判据搬进 `enter_plan_mode`
  的工具描述**（7 条正面 + 4 条豁免 + GOOD/BAD 示例），`AGENTS.md` 的 `## Uncertainty` 只留一条指针
  ——CC 的系统提示词里同样一句 plan 规则都没有，判据在模型决定要不要调工具那一刻才被读到；
  ② **模型主动进入前加用户同意弹框**（见上文 plan mode 一节）——CC 的 `EnterPlanMode` 是
  `shouldDefer: true` + “must consent”，正因为每次进入都要用户点头，它才敢把判据写松并保留
  “err on the side of planning”。本次「拿不准就调」也保留了，误判代价从「被迫绕一圈」降为「按一次键」。
  字符账：工具描述 +761、`AGENTS.md` 那条 −87，**每请求净增 ~674 字符**（tools 数组同样每轮发送，
  所以搬过去不省开销）——买的是去重（两处不再漂移）与判据的读取时机，不是体积。
  **2026-09-25 又做了一次同向去重（+63 字符）**：「何时必须停下来问」原先在 `## Uncertainty` /
  `## Authorization` / `## Destructive actions` 三处各写了一遍且条件互不相同（改一处忘两处就漂移），
  现在规范定义收敛到 `## Blast radius` 的 **Ask-triggers** 一条（(a) 表格的两个 confirm 类；(b) 不属于
  模型的判断：请求有实质歧义 / 要求互斥 / 超出请求范围 / 删除目标不清），其余三节只留指针；同一次改动
  把「授权跨轮持续」与「批准不外溢」的字面矛盾显式调和为**持续的是作用域、不是逐次批准**（两侧各加一句
  互指），并合并 `## Authorization` 里因此重复的两条。蒸馏版 `AGENTS.core.md` 同步（Ask-triggers 进 Blast
  radius 节、Authorization 节改成 scope-vs-approval 那句），字符数 2909 → 3327。
  它是每个会话、每一轮请求都带的固定开销，改完要重开会话才生效（context files 只在 pi 启动时读一次）。
  它装的是行为规则与安全闸（Authorization / Delegation / Destructive actions / Blast radius /
  Shell commands / Git 六节是硬闸，项目级 AGENTS.md/CLAUDE.md 只能赢过其余的工作流/风格规则，
  赢不过这六节 —— 文件开头就是这么声明的），并刻意剔除全部
  Codex 机制耦合内容（`apply_patch` / `update_plan` / `multi_tool_use` 等十个词一个都不能出现），
  工具名一律用 pi 的真实工具（`read` / `bash` / `edit` / `write`，任务清单写作 `task_set` / `task_update`）。
  本机另有一份 4 断言 gate 脚本 `~/.pi/agent/plans/verify-global-agents.mjs`（机器本地，不入库）。
