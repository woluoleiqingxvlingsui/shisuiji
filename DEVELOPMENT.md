# 开发、验证与发布

动手前阅读 [AGENTS.md](AGENTS.md)。本机配置、文献库、真实 data/ 和签名材料不能用于测试或进入发布包。

## 环境

| 用途 | 要求 |
|---|---|
| 电脑服务 | Node.js 18+；Windows 控制台使用系统 PowerShell 5.1 |
| Android 构建 | Node.js 20+、JDK 21、Android SDK；见 app/README.md |
| 真实浏览器验收 | Node.js 22+ 与 Edge，可用 EDGE_PATH 指定 |
| Windows 免安装包 | 固定版本的官方 Node.js Windows x64 ZIP，校验 SHA-256 |

服务使用 Node 标准库和 JSON 数据，前端为本地 Vue 3 + 原生 ES modules，无前端编译步骤。二维码依赖使用根 package-lock.json。Vue 许可见 public/vendor/vue.LICENSE.txt；发布包同时保留 Node 及 npm 依赖的许可证。

## 修改入口

- 界面、业务组件：public/js/，样式：public/style.css。
- 板块常量、引导字段：public/config.js，相关服务端枚举保持一致。
- REST 与同步接口：server.js；持久化事务与文件规则：lib/。
- Windows 启停、维护、首次引导：根目录 PowerShell 脚本。
- Android 壳和原生同步：app/。改 public/ 后需要重打 APK 才会在手机生效。

## 验证

```powershell
npm ci
npm test
npm run test:ui
npm run test:kb-files:ui
npm run test:sync:flow
npm run test:sync:race
npm run test:local-images
npm run test:control:ui
npm run test:setup:ui
npm run test:sync:native
npm run preflight
```

服务测试必须复制 server.js、lib/、public/ 到临时目录，使用独立 data/、空闲端口，并显式设置临时 DANJI_PAPERS_DIR。不可在运行真实服务时在项目根再启动测试实例。手机后台、扫码和覆盖安装仍需真机验证，浏览器桥接桩不能代替真机。

CI 核心测试保留 Node 18/20/22 矩阵；真实浏览器与控制台任务使用 Node 24（本机浏览器验收使用相同主版本）；免安装包运行时仍为 Node 22。浏览器验收使用开发依赖 `ws` 与 Edge 的 CDP 通信，避免依赖不同 Node 版本内置 WebSocket 的差异；执行前先 `npm ci`。该依赖不进入生产免安装包。

## 版本与构建

根 package.json 为发布版本来源；根/app 的包声明和锁文件对齐。Android build.gradle 从根版本生成 versionName，并按 major*10000+minor*100+patch 生成 versionCode（minor/patch < 100）。CLIENT_VERSION / MIN_CLIENT 仅控制协议兼容，独立于显示版本。

```powershell
powershell -ExecutionPolicy Bypass -File app/build-apk.ps1 -Release
```

首次签名生成的 app/android/danji-release.keystore 与 keystore.properties 必须安全备份，以后复用同一签名。构建后用 aapt 核对 APK 版本、apksigner 验证签名，再核对 public/ 资源已完整同步进 APK。

Windows 与源码压缩包使用 tools/build-release.ps1。给出明确 -NodeVersion，或提供 -NodeArchive 与可信 -NodeSha256；下载源为 nodejs.org，核对官方 SHASUMS256.txt 后再打包。源码从 Git 跟踪文件及 release-files.json 明确列出的新增文件收集，禁止直接压缩整个工作目录。产物在 output/release/，校验清单为 SHA256SUMS。

发布前检查 Git diff、npm test、真实 UI 与控制台测试、预检和压缩包清单。再在 PATH 中没有系统 Node 的隔离解压目录验证首次引导、服务、二维码、备份恢复。验证使用虚构数据，不能拿真实用户目录试恢复。

## 发布与隐私

preflight 是规则检查，覆盖敏感路径、常见密钥和个人路径、提交邮箱、历史敏感文件、版本、Android 版本派生与 CHANGELOG。它不是对所有隐私内容和依赖漏洞的穷尽证明；发布包还要检查实际条目。

保留历史 v1.5.0，本轮改动使用 1.5.1。发布正式签名 APK、Windows x64 免安装包、源码包与 SHA256SUMS；GitHub Actions debug APK 只用于体验和测试。源码推送、tag 与正式发布以实际验收完成的提交为准。
