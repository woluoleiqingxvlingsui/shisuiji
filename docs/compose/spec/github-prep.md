---
feature: github-prep
status: delivered
updated: 2026-09-12
branch: github-prep
commits: (uncommitted working tree on c73c984)
---

# GitHub 发布前收尾

## Report

**What was built** — 在 `github-prep` 分支完成四项发布前收尾：`package.json` 标记 `private: true`；新增 `safeFileName` 并接入 `normalizePaper` / `filePaper` / `findPaperFile`，清洗路径分隔符与 `..` 前缀；新增根目录 `config.json`，`server.js` 与 `lib.ps1` 按「环境变量 > config.json > 默认 8642/127.0.0.1」共用端口/主机，两端均校验整数端口范围并容忍坏值；新增 `CHANGELOG.md`（v1.0.0 + Unreleased）。README 端口说明已同步。

**Verification** — `npm test` PASS；`safeFileName` 用例（含 `../`、`..\`、中文名）PASS；`config.json` 改 18765 后服务监听 18765 PASS；`PORT=19876` 覆盖 PASS；`PORT=12.5`/`abc` 回落 config/默认 PASS；`lib.ps1` 默认/自定义/环境变量/坏 JSON 回退 PASS；带 BOM 的 config 仍可启动 PASS。

**Journey log** — 首版 `loadAppConfig` 曾在 `ROOT` 定义前调用（TDZ），已调整声明顺序；`config.json` 被 PowerShell 写入 BOM 导致 `JSON.parse` 失败，两端增加 BOM 容忍且提交无 BOM 默认文件；独立 review 子代理因沙箱无法读 worktree，改为在会话工作区投递 diff 包审阅；review 提出的 env `PORT` 未捕获转换与非整数端口已用 `validPort` + `TryParse` 修掉。

## [S1] Problem
准备把拾穗集推到 GitHub 前，还差几项代码侧收尾：
1. `package.json` 未标 `private`，存在误 `npm publish` 的风险。
2. `file_name` 未像 `category` 一样清洗，`path.join` 可被路径穿越利用。
3. 端口写死在 `lib.ps1`（8642），与 `server.js` 的 `PORT` 环境变量不同步；用户改端口后图形控制台会误判服务状态。
4. 已有 `v1.0.0` tag，但缺少 `CHANGELOG.md`，发布页不够完整。

Remote / Description / Topics / Social Preview 等 GitHub 网页设置不在本次范围（等仓库建好后用户自行处理）。

## [S2] Design

### 2.1 package.json
- 增加 `"private": true`。
- 其余字段（name、version、repository、scripts、engines、license）保持不变。

### 2.2 file_name 路径清洗
新增 `safeFileName(raw)`，与 `safeCategory` 同族：
- 去掉 Windows 非法字符与路径分隔符：`[\\/:*?"<>|]`
- 去掉开头连续点号，避免 `..` / `.` 穿越
- `trim`，空则返回 `''`
- 长度上限 200（文件名场景）

使用点：
1. `normalizePaper()`：写入前清洗 `paper.file_name`，保证落库数据干净。
2. `filePaper()` 入口：对传入 `fileName` 再清洗一次（纵深防御）；清洗后为空则按「无文件」处理。
3. `findPaperFile()`：同样经 `safeFileName` 后再 `path.join`，历史脏数据也不会逃出论文库。

### 2.3 端口/主机共用配置
根目录新增已提交的默认配置文件 `config.json`：

```json
{
  "port": 8642,
  "host": "127.0.0.1"
}
```

读取优先级（两侧一致）：
1. 环境变量：`PORT` / `DANJI_HOST`（Node）；PowerShell 读 `$env:PORT` / `$env:DANJI_HOST`
2. `config.json` 对应字段
3. 内置默认：`8642` / `127.0.0.1`

校验：端口须为 1–65535 的整数，否则回落下一级（避免 `12.5` / `abc` 导致 listen 崩溃或 PS 转换异常）。config 读取容忍 UTF-8 BOM。

改动文件：
- `server.js`：`validPort` + `loadAppConfig`；`PORT`/`HOST` 按上述优先级取值。
- `lib.ps1`：`Get-AppConfig` 同样优先级；`$Url`/`$Health` 跟随 `$Port`。
- `control.ps1` / `control-ui.ps1`：经 `lib.ps1` 取值，无需改动。
- README 换端口说明改为优先改 `config.json`。

`config.json` 进 git（默认值可提交）；用户本地改端口直接编辑该文件即可。

### 2.4 CHANGELOG.md
根目录新增 `CHANGELOG.md`，Keep a Changelog 风格，中文。
- `[1.0.0]`：四大板块、安全基线、零依赖与 Windows 启动链路
- `[Unreleased]`：本次 private / file_name 清洗 / 共用端口配置 / CHANGELOG 本身

## [S3] Out of Scope
- 创建/推送 GitHub 仓库、配置 remote
- Description / Topics / Social Preview（网页设置）
- 英文 README、CONTRIBUTING、Issue 模板
- 功能测试框架、鉴权、Docker
- 重构前端/后端

## Tasks
- [x] T1: package.json 增加 `"private": true` — acceptance: 文件含该字段且 JSON 合法 (covers: S2.1)
- [x] T2: 实现 safeFileName 并接入 normalizePaper / filePaper / findPaperFile — acceptance: 含 `../` 或 `\` 的 file_name 被清洗；正常文件名保留 (covers: S2.2)
- [x] T3: 新增 config.json，server.js 与 lib.ps1 按优先级读取端口/主机 — acceptance: 改 config.json 端口后两侧一致；坏值回退；无 config 回退 8642 (covers: S2.3)
- [x] T4: 编写 CHANGELOG.md（v1.0.0 + Unreleased） — acceptance: 文件存在且覆盖上述范围 (covers: S2.4)
- [x] T5: 验证 npm test / 语法检查 / 端口读取行为 — acceptance: 命令全部通过并记录结果 (covers: S2.1; S2.2; S2.3; S2.4)
