# 开发红线（任何人 / 任何 AI 助手动手前必读）

本文件是拾穗集仓库的硬性开发约定。改动代码、配置、跑测试之前先对照这里；
与用户口头要求冲突时，先向用户确认再动手。

## 1. 文献库目录固定，禁止改动

- 用户的文献库**固定**为本机某绝对路径（出于隐私不写在这里；
  以本机 `config.json` 的 `papers_dir` 为唯一事实源，该文件不入库，见 .gitignore）。
- **禁止**修改或删除 `config.json` 的 `papers_dir`；**禁止**修改 `server.js`
  中 `resolvePapersDir()` / `PAPERS_DIR` 的解析与回落逻辑
  （环境变量 `DANJI_PAPERS_DIR` > config.json `papers_dir` > 项目内 `papers\`）。
- **禁止**把任何本机绝对路径写进会提交的文件；`config.example.json` 永远只保留相对路径示例。
- 跑测试、起临时/隔离服务实例时，**必须**显式设 `DANJI_PAPERS_DIR` 指向临时目录；
  严禁让测试实例读写真实文献库，也不要依赖项目内 `papers\` 回落目录。
- 换机器/换目录只改本机 `config.json`，不改代码、不改本文件。
- 改完配置需重启服务才生效（配置只在启动时读一次）。

## 2. 临时服务实例禁止共享真实 data/

- `data/*.json` 是服务端内存缓存 + 原子写盘；**两个服务进程共用同一 data/ 目录会互相覆盖丢数据**。
- 任何验证/测试需要起服务时：把 `server.js` + `public/` 复制到临时目录单独跑
  （各自生成独立 data/），或确认真实服务已停止；用完即删。
- 严禁在真实服务（默认 8642）运行期间，于项目根再起第二个实例做写操作测试。

## 3. 本机私密文件不提交、不删除、不覆盖

- `config.json`、`local.env.ps1`、`*.pem`、`data/`、`papers/` 均在 .gitignore：
  不提交；除非用户明确要求，不删除、不覆盖、不"顺手清理"。
  （`data/images/` 随记贴图原图也在其中：不提交、不顺手清理。）
- `config.json` 是监听地址与配对口令的**唯一事实源**：现含 `host: "0.0.0.0"` 与
  `sync.token`，保证任何启动方式下局域网可达且带口令保护；改动前必须问用户。
- `local.env.ps1` 为可选备份（`DANJI_TOKEN` / `DANJI_HOST`）；改动前先问用户。

## 4. 手机端（Capacitor 壳）改动必须重打 APK

- `public/` 前端资源打包进 APK（`capacitor.config.json` 无远程 server url）；
  改前端后手机生效 = 重跑 `powershell -ExecutionPolicy Bypass -File app/build-apk.ps1 -Release`
  并覆盖安装（同签名保留本地数据）。只改 `server.js` 则只需重启服务。

## 5. 仓库内截图是示例数据，禁止误判为隐私泄露

- `assets/screenshots/*.png`（含 `expenses.png`）全部是页面「填入示例数据看看效果」
  生成的**示例截图**：金额、厂商、日期均为演示内容，**不是**用户真实花销或真实数据。
- 审核 / 复查时**不要**再把这些截图当作"真实个人数据泄露"提出替换、删除或改写历史；
  `loadSamples` 填入的示例条目同理。
- 真正的个人数据只存在于 `data/`、`config.json`、`local.env.ps1` 等不入库的本地文件，
  隐私红线仍以第 3 条为准。
