# 拾穗集 · Android 混合壳（Capacitor）

把仓库根目录的 `public/` 前端打进 APK。`webDir` 指向 `../public`，**无前端打包步骤**。

## 一键打包（推荐）

```powershell
# 在仓库根目录
powershell -ExecutionPolicy Bypass -File app\build-apk.ps1            # debug 包
powershell -ExecutionPolicy Bypass -File app\build-apk.ps1 -Release   # release 签名包
```

脚本会：缺 JDK21 / Android SDK / Gradle 时自动下载到 `%USERPROFILE%\tools`（Gradle 走国内镜像）→ `cap sync` → `assembleDebug` / `assembleRelease`，并打印 APK 路径。已装环境会复用，可重复执行。

也可在 GitHub 仓库 **Actions → Android APK** 下载 CI 打好的 `shisuiji-app-debug`。

进阶手动步骤见下。

## Release 签名（M5）

`-Release` 首次运行会用 keytool 生成 `android\danji-release.keystore`（随机口令）并写 `android\keystore.properties`；两者均已 gitignore，**只在本机，丢了就无法覆盖安装升级，请自行备份**。之后每次 `-Release` 自动复用。

- `build.gradle` 只在 `keystore.properties` 存在时启用 release 签名；不存在则产出未签名 release（debug 构建不受影响）。
- 日常自用装 debug 包即可；release 包用于长期安装（不依赖 USB 调试签名）。

> Cap 7 Android 模板按 **Java 21** 编译（见 `android/app/capacitor.build.gradle`）。  
> 下列「需 Android 工具链」的步骤要在装了 JDK/SDK 的机器上跑；开发机没有工具链时，以 `npx cap sync` 成功 + 根仓库 `npm test` 作为骨架验收。

## 本机构建（需 Android 工具链）

1. **环境（一次性）**
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
| 图标 | 使用项目 `public/icons/icon-512.png`（已替换模板默认；M5 再做多密度精修） |

## 说明

- 原生探测：`window.Capacitor.isNativePlatform()`；SW 在原生环境会跳过（见 `public/js/pwa.js`）。
- 配对：扫码 / 粘贴 JSON / 手输三通道，载荷 `{"v":1,"base":"http://IP:port","token":"..."}`（见 `public/js/pair.js`）。
- **明文收紧（M5）**：Android NSC 无法按 IP 段放行，故 `usesCleartextTraffic=true` 保留，收紧在应用层——`pair.js` 的 `isAllowedPairBase` 只允许 http 连私网/回环/局域网主机名，公网必须 https；配对写入前强制校验。
- **版本门禁（M5）**：壳内置 `CLIENT_VERSION`（`public/js/sync/net.js`），health 返回 `minClient`；过旧时顶栏胶囊显示「App 需升级」并弹一次提示，不阻断同步。改到「旧壳会静默出错」的行为时，同时递增 `server.js` 的 `MIN_CLIENT` 和 `net.js` 的 `CLIENT_VERSION`，并重打 APK。
- 改应用名：改 `capacitor.config.json` 的 `appName`，再 **`npx cap sync android`**（`cap copy` 不会重写 `strings.xml`）。
- 根仓库 `package.json` 仍保持零 Capacitor 依赖；壳依赖只在 `app/`。

## 目录

| 路径 | 说明 |
|------|------|
| `capacitor.config.json` | appId / appName / webDir |
| `android/` | 生成的 Android 工程（可直接 gradle 构建） |
| `resources/icon-512.png` | 主图标源文件 |
