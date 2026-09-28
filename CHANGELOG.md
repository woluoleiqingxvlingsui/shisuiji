# Changelog

本项目的重要变更都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Added
- **成果与知识库板块**：成果记录（时间线 + 类别聚合）；知识卡可从随记 / 文献阅读记录 / 网页笔记三处沉淀，同名知识可合并
- **随记增强**：支持贴图（原图存 `data/images/`，不入库）与 📌 置顶（置顶组内按最近动作排）
- **浏览器扩展**：原页阅读进度回传 + 按锚点恢复（卡片进度徽章「读到 NN% / ✔ 已读完」）
- **贴图通道**：原生壳走 CapacitorHttp blob、Web 端走普通 fetch，统一转 objectURL（`public/js/img-urls.js`）

### Fixed
- 启动时数据文件损坏只抛栈崩溃：现给出友好提示（备份 data/ 后定位修复）再退出
- 蛋 / 文献 / 网页 / 花销 / 评价 / 消息六个集合并发写共用同一 `.tmp` 可能写坏文件：统一接入串行写队列 `queueWrite`
- 手机同步：服务端返回 2xx 但 body 异常（如校园网强制门户登录页）时待同步队列被静默清空：现校验 results 异常即留队重试
- 新克隆仓库跑 `app\build-apk.ps1` 因缺依赖失败：cap sync 前自动 `npm install`
- 文献板块类别下拉恒空：模板用 `paperCategories` 而 setup 未返回
- `tools/render-boards.mjs` 曾共享真实 `data/` 与文献库：改为临时目录隔离实例（AGENTS.md 红线 1、2）

## [1.1.0] - 2026-09-26

### Added
- **赛博鸡蛋**：已领取的蛋可手动「💤 标为过期」（不限量畅用的蛋永远不会「用完」，收尾只能走已过期）；已过期的蛋可「↩️ 还能用」改回已领取
- **想法 + 手机同步（P6）**：IndexedDB 镜像 + outbox；显示 = 镜像 ∪ 队列；仅手机端自动同步；顶栏同步状态胶囊；`api.js` 统一带 `X-Danji-Token`
- **移动端适配（P7）**：`role`（权限）与 `isPhone`（布局）拆分；文献 Windows 操作手机端隐藏；settle/remind 仅 desktop；小屏触控/抽屉/16px 输入框
- **PWA + 可选 HTTPS（P8）**：`manifest.webmanifest` + `public/sw.js` + 图标；仅 https/localhost 注册 Service Worker；`DANJI_TLS_CERT`/`DANJI_TLS_KEY` 可启 HTTPS
- **手机离线优先（P9）**：health 不可达时手机仍可进「想法」离线记录（镜像∪outbox），服务恢复自动同步；底部提示显示离线壳状态
- **Android App（P10 / M0–M5）**：Capacitor 混合壳（`app/`，webDir 直连 `public/`）；CapacitorHttp + HTTP 明文；扫码配对（html5-qrcode + 原生 BarcodeDetector 加速，扫码单通道）+ 控制台图形窗口二维码；原生强制 `role=mobile`、跳过 SW；一键打包 `app\build-apk.ps1`（含 `-Release` 自动签名）+ GitHub Actions 出 debug 包
- **版本门禁（P10 / M5）**：`/api/health` 增加 `apiVersion` / `minClient`；壳内置 `CLIENT_VERSION`，过旧顶栏提示「App 需升级」
- **配置**：`config.json` 支持 `papers_dir`（相对路径相对项目根）

### Changed
- **赛博鸡蛋**：待领取的蛋过了领取截止，「已错过 😢」更名为「已截止 ⏳」（内部状态 id `missed` → `closed`）；已领取的「已过期」与「💤 标为过期」不变
- **赛博鸡蛋**：「⏳ 已截止」改为所有待领取的蛋都能用（对齐已领取蛋常驻的「💤 标为过期」），不再只出现在「没填截止 / 已过截止」的蛋上

### Security / PWA 限制
- Service Worker **仅**在 `https` 或 `localhost` 注册；局域网 `http://IP:端口` 下关掉浏览器后无法离线冷启动，需配置 HTTPS
- 手机端自动过期扫描关闭，避免用手机时钟误标状态；局域网访问建议配置 `sync.token`
- **App 明文收紧（P10 / M5）**：Android NSC 无法按 IP 段放行，`usesCleartextTraffic` 保留；改在应用层门禁——HTTP 明文配对只接受私网/回环/局域网主机名（`pair.js` 的 `isAllowedPairBase`），公网必须 https；无任何 SSL 错误放行
- App 不支持电脑端自签 HTTPS（不做证书放行）；配对请用 HTTP 模式出码

## [1.0.0] - 2026-09-12

对应 git tag `v1.0.0`（首个公开版本）。

### Added
- **赛博鸡蛋**：记录大模型平台优惠（免费额度 / 代金券 / 折扣 / 试用会员等），按截止紧急度排序；领取/使用截止跟踪；桌面通知；消息中心
- **文献**：论文待读/已读管理，按类别归档；文件名模糊匹配；用指定阅读软件打开；阅读日志（三行速记门槛 + 多条记录）
- **网页**：待读网页收藏；自动抓标题；按类型（技术/杂项）引导记笔记；打开时置顶
- **花销**：按条目记账，按月/按年饼图，类别下钻；体感评价（按主体凝练备注与结论）
- Windows 启动链路：`start.bat` / `launch.vbs` / 图形控制台 / 桌面快捷方式
- 零依赖：Node 标准库 + 本地 Vue 3，无需 `npm install`
- 示例数据一键填入；深色/浅色主题；数据 JSON 原子写入
- 根目录 `config.json`：端口/监听地址与启动脚本共用（环境变量仍可覆盖）
- `CHANGELOG.md`

### Changed
- `lib.ps1` / 控制台与 `server.js` 按同一优先级读取端口：环境变量 `PORT` > `config.json` > 默认 `8642`

### Fixed
- 编辑已领取等状态的赛博鸡蛋时，点顶部「待领取 / 待使用」不再静默改状态，只切换字段显隐（状态用编辑抽屉里的状态下拉改）
- 新建赛博鸡蛋时，若上次模式是「待使用」，初始状态与模式对齐为「已领取」，不再出现界面是待使用、保存却是待领取

### Security
- 默认只监听 `127.0.0.1`
- API Origin 白名单（防浏览器 CSRF；放行本机回环与同源局域网 IP）
- 静态文件路径防穿越；请求体 2MB 上限
- `package.json` 标记 `private: true`，避免误发 npm
- 清洗论文 `file_name`（去掉路径分隔符与 `..` 前缀），防止写出论文库目录
