---
feature: egg-edit-status-sticky
status: delivered
updated: 2026-09-12
branch: github-prep
commits: (uncommitted on github-prep; mirrored to danji)
---

# 已领取蛋编辑时状态不被模式切换打回待领取

## Report

**What was built** — `EggEditor.switchMode` 在编辑已有蛋时只切换字段显隐，不再把 `form.status` 硬写成 `pending`/`claimed`；新建仍按模式定初始状态。另修新建初始化：上次模式为「待使用」时，`status` 与 mode 对齐为 `claimed`，避免界面/落库不一致。自用版 `danji` 与发布版 `github-prep` 已同步。

**Verification** — `node --check` 两棵 `app.js` PASS；`npm test` PASS；模拟脚本：编辑 claimed 点 claim/use 均保持 claimed、新建 use→claimed / claim→pending PASS。独立 review：无 critical/major，claimed 清空 claim_deadline 无残留降级路径。

**Journey log** — 根因是 seg 切换器把「字段布局」和「状态」耦死；编辑态应以状态下拉为唯一状态入口。review 顺带指出新建 mode/status 挂载不对齐，已一并修掉。

## [S1] Problem
编辑「已领取」的赛博鸡蛋时，抽屉顶部的「🥚 待领取 / 🧺 待使用」切换器始终可见。点到「待领取」会执行 `switchMode` → `form.status = 'pending'`。此时若再改领取截止并清空后保存，蛋会变成「待领取」。用户只是想改字段，不该被静默降级状态。

两份代码相同：自用版 `danji/public/app.js` 与发布纯净版 `shisuiji`（`github-prep`）。

## [S2] Design
`EggEditor.switchMode`：
- **新建**（`!props.initial`）：保持现行为——claim→`pending`，use→`claimed`（模式即初始状态）。
- **编辑**（`props.initial` 非空）：只切换 `mode`（字段显隐），**不改** `form.status`。状态变更只走编辑态才显示的状态下拉 `onStatusChange`。

新建初始化：`status` 与 `mode` 对齐（use→`claimed`，claim→`pending`），避免 localStorage 记住「待使用」后直接保存落成 pending。

不改服务端；不改自动 missed/expired 流转。

## [S3] Out of Scope
- 重做记蛋模式/状态 UI
- 限制状态合法迁移
- 服务端校验

## Tasks
- [x] T1: github-prep 修 switchMode — acceptance: 编辑时点待领取/待使用不改 status；新建行为不变 (covers: S2)
- [x] T2: danji 同步同一修复 — acceptance: 与 github-prep 行为一致 (covers: S2)
- [x] T3: 验证 — acceptance: 逻辑复核 + 语法检查通过 (covers: S2)
