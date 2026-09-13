---
feature: platform-combobox
status: delivered
updated: 2026-02-26
branch: in-place
commits: n/a
---

# 记蛋表单 · 平台自定义下拉

## Report

**What was built** — 记蛋抽屉的「平台」字段从原生 `<input list>` + `<datalist>` 换成自定义 combobox：点 ▼ 必开全量建议（`CONFIG.platforms` ∪ 已用平台，去重），输入时大小写不敏感过滤，支持键盘 ↑↓/Enter/Esc、点选写入、点外部收起。配置里补了 `MiniMax`。下拉开着时 Esc 只收列表；关着时 Esc 仍关抽屉。选中后主动 focus 不会把菜单再拉开。

**Verification** — `node --check public/app.js` PASS；Edge headless E2E PASS（箭头全量 22 项、`minimax`→`MiniMax`、点选关闭且不重开、菜单关时 Esc 关抽屉、菜单开时 Esc 只关菜单、外部点击关闭、`qoder` 过滤命中）。

**Journey log**
- 原生 datalist 嵌在 `<label>` 里 + 按当前文本过滤，输入不在配置中的 `minimax` 时点箭头列表为空，看起来像按钮坏了。
- Review 抓到两个 E2E 漏网：`fill` 会保持输入框已聚焦，掩盖「选中后 focus 再 open」；无条件 `.stop` 会吞掉关着时的抽屉 Esc。
- 箭头打开应显示全量（`showAll`），输入才过滤——否则已有值时几乎点不到别的平台。
- 本目录不是 git 仓库，无 worktree/commit；改动直接落在工作区。

## [S1] Problem

记蛋抽屉里的「平台」字段用的是原生 `<input list>` + `<datalist>`。点右侧下拉箭头没有可靠反应：

1. `<datalist>` 嵌在 `<label>` 内，部分浏览器会干扰箭头点击。
2. 当前输入为 `minimax` 时，原生 datalist 会按已填文本过滤；配置列表 `CONFIG.platforms` 中没有该词，点开后列表为空，看起来像按钮坏了。
3. 原生 datalist 对「点箭头必开完整列表」支持不稳定，无法作为可靠交互。

## [S2] Design

把「平台」改成自定义 combobox，行为契约：

- **输入**：始终可自由输入任意平台名（保持原产品约定，不限于建议列表）。
- **箭头**：点击右侧 ▼ 必打开建议列表全量（不受当前文本过滤）；再点收起。
- **建议来源**：`CONFIG.platforms` ∪ 父组件传入的已用平台（`known-platforms` prop，来自 `platformOptions`），去重、保留原顺序（配置在前，已用补充在后）。
- **过滤**：输入时按当前文本做大小写不敏感的 `includes` 过滤；输入为空则显示全部。
- **选择**：鼠标点选项或键盘 Enter 选中并写入 `form.platform`，随后收起；选中后的 focus 不应再次打开列表。
- **键盘**：↓/↑ 在列表中移动高亮并滚入可视区；Enter 选中高亮项（无高亮时不拦表单提交）；Esc 仅在列表打开时收起并阻止冒泡，列表关闭时放行给抽屉关闭。
- **关闭**：点击组件外部收起；选项用 `mousedown.prevent` 选中，避免 input 先 blur 导致列表消失。
- **配置**：`CONFIG.platforms` 增加 `MiniMax`（用户已在数据中使用 minimax）。
- **实现位置**：逻辑与模板放在 `EggEditor` 内（`public/app.js`），样式在 `public/style.css`；`index.html` 给 `<egg-editor>` 传 `:known-platforms="platformOptions"`。

## [S3] Out of Scope

- 文献编辑器的 category datalist、筛选栏原生 `<select>` 等其它下拉。
- 后端 API、数据迁移、历史 `minimax` 记录改名。
- 全站通用 Combobox 组件库化。

## Tasks

- [x] T1: `config.js` 增加 MiniMax — acceptance: `DANJI_CONFIG.platforms` 含 `MiniMax` (covers: S2)
- [x] T2: `EggEditor` 实现自定义 combobox 逻辑与模板 — acceptance: 点箭头打开过滤列表，可键盘选择，自由输入不丢 (covers: S2)
- [x] T3: 样式：combo 控件与菜单可读、不被抽屉裁切 — acceptance: 菜单绝对定位显示在输入框下方，深浅主题可读 (covers: S2)
- [x] T4: 父组件传入已用平台 — acceptance: `egg-editor` 收到 `known-platforms`，已用且不在配置中的平台也会出现在建议里 (covers: S2; depends: T2)
- [x] T5: 语法与手动路径验证 — acceptance: `node --check` 通过；页面能加载且 combobox 行为符合 S2 (covers: S2; depends: T2, T3, T4)
