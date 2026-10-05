# Changelog

本项目的重要变更都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Added
- **同步回报闭环（M13）**：成功回报下沉到 `engine.syncNow()` 里的 `reportSyncSuccess()`——以前回报只挂在 `push.js` 的 `drain()` 上，而 `syncNow()` 有 13 处调用（启动 / 本地写入 / 手动 / 切前台 / 定时器 / 闹钟唤醒…）全都绕开它，于是「手机同步成功了」永远到不了电脑端（`data/messages.json` 里 `bg-sync` 一直是 0 条）
- 回报新增两个字段：`sync_pushed`（这轮推了几条本机改动）与 `sync_caught_up`（发现服务端版本变了，说明睡着期间电脑端改过、这轮补齐了）。服务端据此生成更准确的文案：`手机推来了 N 条改动 ✅` / `手机补齐了后台的更新 ✅` / `手机已同步 ✅`（老客户端不带新字段时退化成最后一种）
- `GET /api/sync/pull` 返回 `data_version`（服务端每次写入 +1）。手机把上次的版本记在 `localStorage`，下次同步一比就知道自己落后了——**即使广播被错过，醒来同步时也能发现自己欠了一次回报**
- `report.js` 导出 `shouldReportSuccess()` 纯函数（该不该报 / 60 秒合并窗口）与 `SUCCESS_COOLDOWN_MS`：连着记三条随记电脑端只响一次，空跑一轮（打开 App 看了眼、定时器空转）完全不响
- `tools/test-kb-report-title.mjs`：临时隔离实例验证服务端回报文案与 `data_version`（不碰真实服务与真实 `data/`）
- **电脑端同步回报通知（M11）**：回报通道加 45 秒一次的兜底补拉（`GET /api/messages`），SSE 被浏览器掐掉也能收到；通道状态摊开成 `state.reportInbox`（未启动 / 连接中 / 已连接 / 已断开）
- 消息中心新增「🔔 测试通知」按钮：点一下就明确知道这台机器到底能不能弹系统通知（顶栏铃铛与空态各一个）
- 通知能力新增 `notifBlockReason()` / `refreshNotifPermission()`：把「为什么发不出去」变成可查询的值，UI 不再自己拼布尔
- `tools/test-desktop-report-inbox.mjs`：钉死回报通道的启动、幂等、播报登记与兜底补拉四条真值表（已并入 `npm test`）

### Removed
- 上一轮为排查「手机同步了但电脑端没收到」临时插在 `server.js` 里的 7 处 `dbg(...)` 埋点与顶部 `DBG_FILE` 常量（排查已结束，正式代码不留诊断输出）

### Fixed
- 推送（SSE）连着时手机仍每 60 秒全量拉一次 `/api/sync/pull`：服务端本来就会广播，这份轮询纯属浪费电和流量。`pickIntervalMs()` 改成三态——有待推送数据仍走 8 秒快轮询（往上传本地改动，优先级最高，与推送无关）、推送连着则**完全不轮询**（返回 0）、推送断了才退回 3 分钟慢速兜底
- 回报文案只有「手机已同步 ✅」一种，成功时说不清这轮到底干了什么（推了东西？只是补齐？）
- 电脑端回报通道「先置 `listenerStarted` 再判 `isDesktop()`」导致整条通道永久关闭且永不重试：冷启动时角色尚未探回，整条通道一挂就死
- 回报 SSE 不带 `X-Danji-Token`、不走 `resolveApiUrl()`，与 `api.js` 的约定不一致（此前只因回环免口令才侥幸可用）
- 通知权限只在模块加载时读一次 `Notification.permission`：用户在浏览器设置里改过后，顶栏状态与实际能力长期不一致
- 切回前台只补查蛋到期、不补拉消息中心：回报帧收到了但用户不点开「💬 消息」就完全看不见
- **三态胶囊把「我自己关的」误判成「系统坏了」**：模板里判的是「有没有卡点」，而 `switch_off` 本身也是非空字符串，于是「用户主动关闭」和「权限被拦截」都渲染成橙色 ⚠️ + `blocked`，🔕 那一档事实上永远显示不出来——恰好把本次改版「区分我关的和发不出去的」的目的抵消了。映射逻辑收进 `notify.js` 的纯函数 `notifPillState()`，并由 `test-global-notify.mjs` 四条断言钉死
- **兜底轮询把服务不可用变成每 45 秒弹一次「消息加载失败」**：45 秒一次的可用性兜底反而在通道死掉（最需要安静）时不停骚扰。`loadMessages({ silent: true })` 支持静默失败，兜底路径改用它；同时删掉 `sweepReports()` 里那个永远进不去的 `try/catch`（`loadMessages` 自己吞异常）
- 通道状态（`reportInboxState` / `reportInboxText`）算出来了却从没渲染，「为什么没收到通知」只能靠猜：现显示在消息中心筛选栏（已连接=绿点 / 已断开=橙点）

### Changed
- 成功回报**只留一个出口**：`push.js` 的 `onSyncSuccess()` 不再单独 `reportOutcomes({ok:true})`（两处都留着就是每轮报两次），失败回报 `onSyncFail()` 原样不动
- `push.js` 把连接状态写进 `state.sync.pushLive`，并在连上 / 断开 / 启停监听时调 `rearmInterval()` 让轮询立即重新评估；依赖仍是单向的 `push.js → engine.js`，两者只通过 `state.sync` 通信，不构成循环
- `drain()` 把 `fromEvent` / `recovered` 透传给 `syncNow()`：回报要靠它们判断该不该报
- 顶栏通知开关改三态胶囊，**去掉「灰度 + 斜杠」**的旧样式；蛋到期铃铛同步换成同一套胶囊。三态的判定收敛在 `notifPillState()`：🔔 已开启（主题色）/ 🔕 **用户主动关闭**（中性）/ ⚠️ 未授权、被拦截或环境不支持（橙色）——只有「用户主动关的」是中性 off，其余一切发不出去的原因都是 blocked
- 消息中心新增回报通道状态徽标；`state.notifWhy` 死字段删除；`report.js` 不再重复导出 `notifBlockReason`；手机端不再起 45 秒兜底轮询（`ensureReportSweep()` 供角色判定延迟时补启动）
- **知识库去掉「类别」**：分类与检索只走标签，搜索框支持直接输入 `#标签`；服务端不再校验/写入 `category`，老客户端（老 APK）仍带该字段时直接忽略，存量数据里的 `category` 原样保留不迁移
- `public/sw.js` 缓存版本 `p9-v6` → `p12-v1`

### 已知限制
- **手机退到后台时原生 15 分钟闹钟是否触发仍未解决**（缺陷 A，涉及原生代码 + 厂商后台策略，另立任务）。本任务只保证「一旦手机醒来同步，就会发现落后并回报」，**不保证「醒来」这件事本身发生**
- 成功回报有 60 秒合并窗口：1 分钟内连着多次同步只报一条；刚推完东西后服务端又广播一轮时，那轮 `pushed=0` / 版本没变，会被冷却吞掉——这是故意的，那是自己踢自己的脚
- 电脑端**关掉浏览器页面后收不到通知**（网页没有后台常驻能力），要真正做到需 Web Push（另立需求）
- 兜底补拉周期 45 秒：漏推送时最迟 45 秒送达，不是瞬时
- 老 APK 里打包的前端仍会显示知识库类别徽章、保存时多发一个 `category`（服务端已忽略），下次重打 APK 后自然消失

## [1.2.0] - 2026-09-28

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
