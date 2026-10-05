---
name: pi-theme-from-palette
description: 从一份现成配色（vim colorscheme / tmTheme plist / codex 主题导出 / 裸 hex 列表）生成一套 pi 主题 JSON，主色按新配色重定、次要色一律 follow pi-coder-1337。当用户丢来配色文件或一堆色值要「做一套 pi 皮肤 / 加一套主题 / 换配色」时使用。
---

# 从配色生成 pi 主题

## 这个 skill 干什么

用户给你一份**别人的配色**（vim colorscheme、tmTheme plist、codex 主题导出、调色板 hex 清单……），你把它拆成色值，**映射进 pi 主题 JSON 的 22 个主色槽位**，其余 37 个次要槽位**原样 follow `pi-coder-1337.json`**，最后落盘一个可被 pi 加载的主题文件。

不负责挑新配色；配色由用户提供。找不到合适来源时**报告找不到**，不要硬编一个"看着像"的颜色。

基准文件（次要槽位全部来自它，也是结构模板）：
`<包内>/themes/pi-coder-1337.json`（本仓即 `themes/pi-coder-1337.json`，npm 装到 `node_modules/@bachi/pi-coder/themes/`）
槽位语义与三套现成皮肤的取值对照：
`<包内>/assets/pi-coder-palettes.html`（`三色对照` 表列出全部 53 个槽位）

## 主色 / 次要的边界（硬规则）

**22 个主色槽位 —— 必须来自用户给的配色，逐个重定：**

| 槽位 | 语义 | 1337 现值 |
| --- | --- | --- |
| `accent` | 强调色（logo / 选中项 / 光标） | `#8cdaff` |
| `borderAccent` | 高亮边框（默认跟随 `accent`，可另取） | `#8cdaff` |
| `border` | 普通边框 | `#515151` |
| `selectedBg` | 选中行底 | `#515151` |
| `success` | 成功 | `#a6e22e` |
| `error` | 错误 | `#e27878` |
| `warning` | 警告 | `#fdb082` |
| `toolTitle` | 工具标题 | `#8cdaff` |
| `mdHeading` | Markdown 标题 | `#ff8942` |
| `mdLink` | Markdown 链接 | `#6699cc` |
| `mdCode` | Markdown 行内代码 | `#0d92c1` |
| `mdListBullet` | Markdown 列表符号 | `#fbdfb5` |
| `bashMode` | bash 模式编辑器边框 | `#fc9354` |
| `syntaxComment` | 注释 | `#6d6d6d` |
| `syntaxKeyword` | 关键字 | `#ff5e5e` |
| `syntaxFunction` | 函数名 | `#8cdaff` |
| `syntaxVariable` | 变量名 | `#e9fdac` |
| `syntaxString` | 字符串 | `#fbe3bf` |
| `syntaxNumber` | 数字 | `#fdb082` |
| `syntaxType` | 类型名 | `#8cdaff` |
| `syntaxOperator` | 运算符 | `#f8f8f2` |
| `syntaxPunctuation` | 标点 | `#ffffff` |

**其余 37 个槽位 —— 一律照搬 1337，逐字节相同，不得另配：**
`borderMuted` `muted` `dim` `text` `thinkingText`、`scrollbarTrack` `scrollbarThumb`、`searchMatchBg` `searchMatchText`、`userMessageBg` `userMessageText`、`customMessageBg` `customMessageText` `customMessageLabel`、`toolPendingBg` `toolSuccessBg` `toolErrorBg`、`toolOutput` `bashOutput`、`mdLinkUrl` `mdCodeBlock` `mdCodeBlockBorder` `mdQuote` `mdQuoteBorder` `mdHr`、`toolDiffAdded` `toolDiffRemoved` `toolDiffContext` `toolDiffAddedBg` `toolDiffRemovedBg`、`thinkingOff` `thinkingMinimal` `thinkingLow` `thinkingMedium` `thinkingHigh` `thinkingXhigh` `thinkingMax`、`export` 三项。

用户点名过的次要槽位，别再去动它们：**diff 的新增/删除前景与背景**（`toolDiffAdded` `#8bc391` / `toolDiffRemoved` `#e27878` / `toolDiffAddedBg` `#1c241b` / `toolDiffRemovedBg` `#2e1c21`）与**思考档 xhigh / max**（`thinkingXhigh` `thinkingMax` `#696969`）。`bashOutput` 只有 1337 和 ayu 定义，属于次要，照搬。

## 两条最容易违反的规则

**1. 判定"次要槽位有没有变"，比的是解析后的颜色值，不是 `colors` 里的变量名。**
`colors` 的值大多是 `vars` 引用，改一个共享变量会连带改掉一串槽位。共享变量至少包括：`selection`（border / selectedBg / thinkingMinimal）、`comment`（dim / thinkingText / scrollbarThumb / mdLinkUrl / mdHr / syntaxComment）、`funcBlue`（toolTitle / syntaxFunction / syntaxType / accent 的旧值）、`number`（warning / syntaxNumber）、`softFg`（toolOutput / toolDiffContext / mdQuote）。

因此规则是：**新的主色值必须挂自己的新变量名**（如 `snGold`），**不得修改 1337 已有变量的值**。落盘后逐 token 用下面「验证」一节的脚本比对解析值 —— 变量名相同≠值相同。

**2. 主色要在 `#191919` 底色上读得出来。**
1337 的底色是 `#191919`（`vars.bg`），它当初就为对比度放弃过来源色（`markup.heading` 的 `#75715e` 只有 3.58:1，改用 `#ff8942` 的 7.46:1）。新配色里的深色（暗灰、暗蓝）直接搬会糊掉；对比度不够时**在同一份配色的邻近色里换一个更亮的同义色**，并在交付说明里写明换过。

## 输入解析

各种输入都是"一堆色值 + 一点语义标签"，把语义标签当主线索：

- **vim colorscheme**：抓 `hi <Group> ... guifg=#xxx`（**gui 值优先**，`ctermfg=150` 是 256 色索引，不进 truecolor 主题）。`s:xxx` 变量和 `exe 'hi' 'Group' 'guifg='.s:xxx` 拼串要回溯到定义处取值；条件分支（高对比 / 低对比、`has('gui_running')`）**取一支并在报告里说明取了哪支**。
- **tmTheme / Sublime plist**：`<key>foreground</key><string>#xxx</string>` 与同 dict 的 `scope` 配对。
- **codex 主题**：`~/.codex/config.toml` 的 `[tui] theme = "…"` 只是名字，色值在二进制里；让用户给出导出表（本仓库 1337 皮肤就是这么来的：zlib 解压出的 scope→色值表）。
- **裸 hex 列表 / 设计稿**：色名当线索（`bg` `fg` `accent` `red` `green`…），没有语义的按色相归位。

### 槽位 ← 语义来源的对应

| 槽位 | vim group | tmTheme scope | 说明 |
| --- | --- | --- | --- |
| `syntaxComment` | `Comment` | `comment` | |
| `syntaxKeyword` | `Keyword` `Conditional` `Statement` | `keyword` | |
| `syntaxFunction` | `Function` | `entity.name.function` | |
| `syntaxVariable` | `Identifier` | `variable` | |
| `syntaxString` | `String` `Character` | `string` | |
| `syntaxNumber` | `Number` `Constant` `Boolean` `Float` | `constant.numeric` | |
| `syntaxType` | `Type` `Structure` `StorageClass` | `entity.name.type` `entity.name.class` | |
| `syntaxOperator` | `Operator` | `keyword.operator` | 来源没有就落到 `Normal` 前景 |
| `syntaxPunctuation` | `Delimiter` | `punctuation.definition.*` | |
| `accent` | `Title` `ModeMsg` `TabLineSel` `Visual` | `markup.heading` / 主色 | 来源的"强调/选中"色 |
| `border` / `selectedBg` | `StatusLineNC` `CursorLine` `Pmenu` / `Visual` `PmenuSel` | 面板与选区底 | 边框常是面板底色 |
| `success` / `error` / `warning` | `String` `DiffAdd` / `Error` `ErrorMsg` | `diff.inserted` / `invalid` | |
| `toolTitle` | 同 `syntaxFunction` 或 `accent` | | 1337 里与函数名同值但**独立取变量** |
| `mdHeading` | `Statement` `Title` | `markup.heading` | |
| `mdLink` | `Statement` `Label` | `markup.underline.link` | |
| `mdCode` | `Special` `PreProc` | `markup.raw` | |
| `mdListBullet` | `SpecialComment` `Type` | `markup.list` | |
| `bashMode` | `Special` `WarningMsg` | | 与 `warning` 同源但独立取变量 |

一个来源色服务多个槽位是正常的（1337 里 `funcBlue` 同时给 `toolTitle` 和 `syntax*`），**但必须各自独立取变量名**，否则日后调一个会连带改另一个。

## 落盘与结构规则

- **输出路径**：默认 `~/.pi/agent/themes/<name>.json`（pi 全局主题目录；项目用 `.pi/themes/`，包内是 `themes/`）。**目标文件已存在就先问，不覆盖**。
- `name` 字段**必须等于文件名**（`loadThemeJson()` 拼 `${name}.json` 找文件）；换名要同时改文件名与 `name`。
- `colors` 的**键集合与顺序照抄 1337**（59 项，含 `bashOutput` 这类非官方 token），只改值。
- 所有色值走 `vars`：`colors` 里不出现 `#` 字面量。空串 `""` 是合法值，意思是"终端默认色"，不是未定义。
- 不写整数：`bgAnsi()` 对整数发 `48;5;N`（256 色索引），在 truecolor 皮肤里会脏。
- `export` 段照抄 1337（`pageBg` / `cardBg` / `infoBg`）。
- 新变量名带来源前缀（`snGold`、`noBlue`）便于回溯；`vars` 只留仍被引用的条目。

## 验证（必做）

pi 的主题加载是**静默失败**的：`vars` 悬空引用抛 `Variable reference not found` 后整份回退内置 `dark`，不报错；`toolDiffAddedBg` 这类 token 拼错也静默无效。所以必须用 pi 自己的加载器验，别只看 JSON 语法。

```bash
# pi 全局安装根（本机是 pnpm 全局包；shim 末行带 cmd-shim-target）
PI_ROOT=$(grep -o 'cmd-shim-target=.*' "$(command -v pi)" | sed 's#cmd-shim-target=##; s#/dist/bundle/cli.js##')
mkdir -p /tmp/theme-check && cat > /tmp/theme-check/check.mjs <<'EOF'
const R = process.env.PI_ROOT;
const fs = await import("node:fs");
const { loadThemeFromPath } = await import(`${R}/dist/modes/interactive/theme/theme.js`);
const { validateThemeJson } = await import(`${R}/dist/modes/interactive/theme/theme-json.js`);
const [BASE, CAND] = process.argv.slice(2);
const BG = new Set(["selectedBg","searchMatchBg","userMessageBg","customMessageBg","toolPendingBg","toolSuccessBg","toolErrorBg"]);
const PRIMARY = new Set(["accent","borderAccent","border","selectedBg","success","error","warning","toolTitle",
  "mdHeading","mdLink","mdCode","mdListBullet","bashMode","syntaxComment","syntaxKeyword","syntaxFunction",
  "syntaxVariable","syntaxString","syntaxNumber","syntaxType","syntaxOperator","syntaxPunctuation"]);
const jb = JSON.parse(fs.readFileSync(BASE, "utf8"));
const jc = JSON.parse(fs.readFileSync(CAND, "utf8"));
try { validateThemeJson(CAND, jc); console.log("schema: OK"); }
catch (e) { console.log("schema: FAIL\n" + e.message); process.exitCode = 1; }
console.log("name==file:", jc.name === CAND.split("/").pop().replace(/\.json$/, ""));
for (const mode of ["truecolor", "256color"]) {
  const a = loadThemeFromPath(BASE, mode), b = loadThemeFromPath(CAND, mode);
  const errs = [], changed = [], leaked = [];
  const read = (t, k) => { try { return BG.has(k) ? t.getBgAnsi(k) : t.getFgAnsi(k); } catch (e) { errs.push(`${k}: ${e.message}`); return null; } };
  for (const k of Object.keys(jb.colors)) {
    const x = read(a, k), y = read(b, k);
    if (x === null || y === null || x === y) continue;
    (PRIMARY.has(k) ? changed : leaked).push(k);
  }
  console.log(`${mode} | changed(${changed.length}): ${changed.join(",") || "-"}`);
  console.log(`${mode} | LEAK(${leaked.length}): ${leaked.join(",") || "none"}`);
  console.log(`${mode} | errors: ${errs.join("; ") || "none"}`);
}
EOF
PI_ROOT=$PI_ROOT node /tmp/theme-check/check.mjs <1337 绝对路径> <新主题绝对路径>
```

判定标准：

1. `schema: OK`、`name==file: true`、`errors: none`（任何 `Unknown theme color` / `Variable reference not found` 都是失败）。
2. 两个色彩模式都要出现，且都在同一标准下判定（`256color` 下量化会让部分改动并值，`changed` 数量可能少于 `truecolor`，属正常）。
3. `changed` 就是这次重定的主色，**逐个核对确实是你改的那批**（`borderAccent` 与 `accent` 同值时不会出现，属正常）。
4. `LEAK` **必须是 `none`** —— 出现任何次要槽位就是失败，回去把那个槽位重新指向 1337 的变量。

拿 1337 自己对自己跑一遍应得 `changed(0)` / `LEAK(0)`；若不是，说明脚本被改坏了。

## 交付说明

给用户一张映射表：`槽位 → 新值 → 来源色名`（22 行），加四句交代：从哪个文件取的、取了哪个条件分支、有没有为对比度换色、验证命令的输出。找不到来源的槽位单独列出来，不要默默用 1337 值顶上。

## 常见坑

| 坑 | 实情 |
| --- | --- |
| 用变量名判断"次要槽位没变" | 变量名相同不等于值相同；改共享变量会让次要槽位跟着变。只认解析后的值 |
| 改了 1337 已有变量的值 | 会连带改掉引用它的全部槽位。新值一律新变量名 |
| 以为 schema 会拦住拼错的 token | TypeBox 编译路径放行未知键（`additionalProperties: false` 不在执行路径上），拼错静默无效 |
| 只跑 `truecolor` | `256color` 下的量化和变量解析是另一条路，两个都要跑 |
| `name` 与文件名不一致 | 选择器显示旧名，或 `settings.json` 的 `theme` 落空 |
| 深色直接搬进主色 | `#191919` 上会糊；按对比度换同义更亮色并写明 |
