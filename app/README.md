# 拾穗集 · Android 混合壳（Capacitor）

普通用户优先安装 [Releases](https://github.com/woluoleiqingxvlingsui/shisuiji/releases) 中的正式签名 APK；若该版本尚未发布，可按本文自行构建。

把仓库根目录的 `public/` 前端打进 APK。`webDir` 指向 `../public`，**无前端打包步骤**。

## 一键打包（推荐）

自己构建 APK 需要 **Node.js 20 或以上版本**（Capacitor CLI 7 的要求）。仅运行电脑服务和首次配对引导最低为 Node.js 18，两者要求不同。

```powershell
# 在仓库根目录
powershell -ExecutionPolicy Bypass -File app\build-apk.ps1            # debug 包
powershell -ExecutionPolicy Bypass -File app\build-apk.ps1 -Release   # release 签名包
```

脚本会：缺 JDK21 / Android SDK / Gradle 时自动下载到 `%USERPROFILE%\tools`（Gradle 走国内镜像）→ `cap sync` → `assembleDebug` / `assembleRelease`，并打印 APK 路径。已装工具链会复用，每次通过 `npm ci` 对齐 app 锁文件依赖，再同步前端并构建。

正式版本从 Releases 下载。GitHub 仓库 **Actions → Android APK** 中的 `shisuiji-app-debug` 用于体验和测试。

进阶手动步骤见下。

## Release 签名（M5）

`-Release` 首次运行会用 keytool 生成 `android\danji-release.keystore`（随机口令）并写 `android\keystore.properties`；两者均已 gitignore，**只在本机，丢了就无法覆盖安装升级，请自行备份**。之后每次 `-Release` 自动复用。

- `build.gradle` 只在 `keystore.properties` 存在时启用 release 签名；不存在则产出未签名 release（debug 构建不受影响）。
- debug 包用于临时体验；长期使用请固定同一个 release 签名。CI 每次生成的 debug 签名可能不同，不保证能连续覆盖安装。

> Cap 7 Android 模板按 **Java 21** 编译（见 `android/app/capacitor.build.gradle`）。  
> 下列「需 Android 工具链」的步骤要在装了 JDK/SDK 的机器上跑；开发机没有工具链时，以 `npx cap sync` 成功 + 根仓库 `npm test` 作为骨架验收。

## 本机构建（需 Android 工具链）

1. **环境（一次性）**
   - **Node.js 20+**（含 npm）
   - **JDK 21**（`JAVA_HOME` 指向安装目录）——不是 17，模板已锁 21
   - Android Studio，或 cmdline-tools + Platform + Build-Tools（`ANDROID_HOME`）
2. **安装壳依赖**（仅 `app/`）

   ```powershell
   cd app
   npm install
   ```

3. **首次 / 克隆后同步**（会生成 `assets/public` 与 `capacitor-cordova-android-plugins`，这两处被模板 gitignore）

   ```powershell
   npx cap sync android
   ```

4. **只改了前端、未改原生插件时**

   ```powershell
   npx cap copy android
   ```

5. **出 debug 包**（需 Android 工具链）

   ```powershell
   cd android
   .\gradlew.bat assembleDebug
   ```

6. **产物**：`android\app\build\outputs\apk\debug\app-debug.apk`  
   发到手机安装（允许未知来源），或 `adb install`。

## 验收（真机，需 Android 工具链）

| 步骤 | 期望 |
|------|------|
| 飞行模式点开 App | 能进界面（数据可为空） |
| 应用名 | 「拾穗集」 |
| 图标 | 使用拾穗集图标 |
| 错误或旧二维码 | 明确提示错误，原有效配对不被覆盖 |
| 离线写随记并加图 | 先留本机，同网后上传，电脑能看到内容和原图 |
| 同签名更新 | 本地随记与配对保留 |
| 锁屏、省电限制 | 按实际设备验证前后台同步，不以浏览器测试代替 |

## 说明

- 原生探测：`window.Capacitor.isNativePlatform()`；SW 在原生环境会跳过（见 `public/js/pwa.js`）。
- 配对：扫码单通道。原生走 `@capacitor-mlkit/barcode-scanning` 的 **startScan 路径**（CameraX 预览画在 WebView 背后 + 内置 ML Kit 解码，**不依赖 Google 服务**；`scan()` 那条 GmsBarcodeScanner 路径在国内无 GMS 机器上会报 module not available，勿用）。扫码期间页面加 `body.danji-scan-active` 透出相机画面（见 `public/style.css`）。浏览器不提供扫码，直接访问电脑地址并填口令；原生插件不可用时会明确提示安装完整 App。**没有手动输入 / 粘贴配对 JSON 的入口**（`pair-drawer.js` 只有「开始扫码」按钮）。
- **服务与配对码的协议必须一致**：App 不接受自签 HTTPS。新机器在根目录首次引导选择 Android 同步即可走局域网 HTTP；已有证书的安装，请按 [根 README 的 Android 步骤](../USAGE.md#android-app推荐路线) 明确启动 HTTP 并按相同协议出码。控制台使用 HTTP 启动入口时会保持所选协议；不要移动证书来临时改变协议。引导不会移动、删除证书或覆盖已有配置。
- **电脑端出码需要 `qrcode` 包**：`tools/qrcode-loader.mjs` 先找仓库根 `node_modules/qrcode`，再回落 `app/node_modules/qrcode`——在仓库根或 `app/` 目录任一处 `npm install` 都行；两处都没有时控制台出不了码（App 只有扫码入口，打印的 JSON 用不上）。首次引导的 Android 模式会按需安装。
- **电脑首次配置**：全新目录双击 `start.bat`，选 Android 同步，自动配置局域网监听和随机口令，按需安装二维码依赖。已有配置跳过引导；手动复制的示例仍默认仅本机、空口令，需自行设置后重启。配对检查验证口令和版本，错误二维码不覆盖原配对。
- **明文收紧（M5）**：Android NSC 无法按 IP 段放行，故 `usesCleartextTraffic=true` 保留，收紧在应用层——`pair.js` 的 `isAllowedPairBase` 只允许 http 连私网/回环/局域网主机名，公网必须 https；配对写入前强制校验。
- **版本门禁（M5）**：壳内置 `CLIENT_VERSION`（`public/js/sync/net.js`），health 返回 `minClient`；过旧时顶栏胶囊显示「App 需升级」并弹一次提示；新配对遇到不兼容版本会拒绝保存配置。改到「旧壳会静默出错」的行为时，同时递增 `server.js` 的 `MIN_CLIENT` 和 `net.js` 的 `CLIENT_VERSION`，并重打 APK。
- 改应用名：改 `capacitor.config.json` 的 `appName`，再 **`npx cap sync android`**（`cap copy` 不会重写 `strings.xml`）。
- 根仓库 `package.json` 仍保持零 Capacitor 依赖；壳依赖只在 `app/`。

## 目录

| 路径 | 说明 |
|------|------|
| `capacitor.config.json` | appId / appName / webDir |
| `android/` | 生成的 Android 工程（可直接 gradle 构建） |
| `resources/icon-512.png` | 主图标源文件 |

## 版本与升级

Android 的 versionName 和 versionCode 从根 package.json 派生；本轮为 1.5.1 / 10501。协议兼容版本独立管理。覆盖安装必须使用同一签名；构建后先验证版本、签名和打包的前端资源，再进行真机离线、扫码与覆盖升级验收。
