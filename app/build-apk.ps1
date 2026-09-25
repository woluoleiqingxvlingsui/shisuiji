# 拾穗集 —— Windows 一键装工具并打 Android 包（默认 debug）
# 用法（仓库根目录或 app/ 下）：
#   powershell -ExecutionPolicy Bypass -File app\build-apk.ps1            # debug 包
#   powershell -ExecutionPolicy Bypass -File app\build-apk.ps1 -Release   # release 包（首次自动生成签名）
# 幂等：已有 JDK/SDK 会复用；缺什么补什么。
# 产物：app\android\app\build\outputs\apk\debug\app-debug.apk
#   或：app\android\app\build\outputs\apk\release\app-release.apk
# 国内网络默认走镜像（Gradle 腾讯 / Maven 阿里）。

param([switch]$Release)

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $AppRoot
$AndroidDir = Join-Path $AppRoot 'android'
$ToolsRoot = Join-Path $env:USERPROFILE 'tools'
$JdkDir = Join-Path $ToolsRoot 'jdk-21'
$SdkDir = Join-Path $ToolsRoot 'android-sdk'
$GradleDir = Join-Path $ToolsRoot 'gradle-8.11.1'
$InitGradle = Join-Path $env:USERPROFILE '.gradle\init.gradle'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Get-File($url, $dest) {
  Write-Host "  download $url"
  curl.exe -L --retry 3 --connect-timeout 30 -o $dest $url
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $dest)) { throw "download failed: $url" }
}

Write-Step 'Prepare JDK 21'
if (Test-Path (Join-Path $JdkDir 'bin\java.exe')) {
  Write-Host "  reuse $JdkDir"
} else {
  New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
  $zip = Join-Path $ToolsRoot 'temurin21.zip'
  Get-File 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse' $zip
  $tmp = Join-Path $ToolsRoot 'jdk-extract'
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $dir = Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like 'jdk*' } | Select-Object -First 1
  if (Test-Path $JdkDir) { Remove-Item $JdkDir -Recurse -Force }
  Move-Item $dir.FullName $JdkDir
  Remove-Item $tmp -Recurse -Force
  Remove-Item $zip -Force
}
$env:JAVA_HOME = $JdkDir

Write-Step 'Prepare Android SDK (cmdline-tools + platform 35 + build-tools)'
$sdkm = Join-Path $SdkDir 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $sdkm)) {
  New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
  $zip = Join-Path $ToolsRoot 'cmdline-tools.zip'
  Get-File 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' $zip
  $tmp = Join-Path $SdkDir 'cmdline-tools-temp'
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $SdkDir 'cmdline-tools') | Out-Null
  Move-Item (Join-Path $tmp 'cmdline-tools') (Join-Path $SdkDir 'cmdline-tools\latest')
  Remove-Item $tmp -Recurse -Force
  Remove-Item $zip -Force
}
$env:ANDROID_HOME = $SdkDir
1..30 | ForEach-Object { 'y' } | & $sdkm --sdk_root=$SdkDir --licenses | Out-Null
& $sdkm --sdk_root=$SdkDir 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'sdkmanager install failed' }

Write-Step 'Prepare Gradle 8.11.1'
$gradleBin = Join-Path $GradleDir 'bin\gradle.bat'
if (Test-Path $gradleBin) {
  Write-Host "  reuse $GradleDir"
} else {
  $zip = Join-Path $ToolsRoot 'gradle-8.11.1-all.zip'
  $mirrors = @(
    'https://mirrors.cloud.tencent.com/gradle/gradle-8.11.1-all.zip',
    'https://mirrors.huaweicloud.com/gradle/gradle-8.11.1-all.zip',
    'https://services.gradle.org/distributions/gradle-8.11.1-all.zip'
  )
  $got = $false
  foreach ($u in $mirrors) {
    try {
      Get-File $u $zip
      if ((Get-Item $zip).Length -gt 10MB) { $got = $true; break }
    } catch { Write-Host "  mirror fail: $u" }
  }
  if (-not $got) { throw 'all Gradle mirrors failed' }
  Expand-Archive -Path $zip -DestinationPath $ToolsRoot -Force
  Remove-Item $zip -Force
}

Write-Step 'Write Gradle mirrors init.gradle and local.properties'
New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE '.gradle') | Out-Null
$init = @"
// CN mirrors for Gradle deps
allprojects {
  buildscript {
    repositories {
      maven { url 'https://maven.aliyun.com/repository/google' }
      maven { url 'https://maven.aliyun.com/repository/public' }
      maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }
    }
  }
  repositories {
    maven { url 'https://maven.aliyun.com/repository/google' }
    maven { url 'https://maven.aliyun.com/repository/public' }
    maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }
  }
}
"@
[IO.File]::WriteAllText($InitGradle, $init, [Text.UTF8Encoding]::new($false))
$sdkProp = $SdkDir.Replace('\', '\\')
[IO.File]::WriteAllText((Join-Path $AndroidDir 'local.properties'), "sdk.dir=$sdkProp`n", [Text.UTF8Encoding]::new($false))

if ($Release) {
  Write-Step 'Prepare release keystore'
  $ksFile = Join-Path $AndroidDir 'danji-release.keystore'
  $ksProps = Join-Path $AndroidDir 'keystore.properties'
  if (-not (Test-Path $ksFile)) {
    # 首次：随机口令生成签名密钥；只留本机（已 gitignore），丢了就无法覆盖安装升级
    $keytool = Join-Path $JdkDir 'bin\keytool.exe'
    $ksPwd = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
    & $keytool -genkeypair -v -keystore $ksFile -alias danji -keyalg RSA -keysize 2048 -validity 10950 `
      -storepass $ksPwd -keypass $ksPwd -dname 'CN=Danji, OU=Home, O=Danji, L=Local, C=CN'
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $ksFile)) { throw 'keytool genkeypair failed' }
    $props = @(
      'storeFile=danji-release.keystore',
      "storePassword=$ksPwd",
      'keyAlias=danji',
      "keyPassword=$ksPwd"
    ) -join "`n"
    [IO.File]::WriteAllText($ksProps, "$props`n", [Text.UTF8Encoding]::new($false))
    Write-Host '  keystore 已生成；口令在 app\android\keystore.properties（不入库，请自行备份）'
  } elseif (-not (Test-Path $ksProps)) {
    throw "找到 $ksFile 但缺 keystore.properties（含口令），无法签名；请恢复该文件"
  } else {
    Write-Host "  reuse $ksFile"
  }
}

$gradleTask = if ($Release) { 'assembleRelease' } else { 'assembleDebug' }
Write-Step "Capacitor sync + $gradleTask"
Push-Location $AppRoot
try {
  npx cap sync android
  if ($LASTEXITCODE -ne 0) { throw 'cap sync failed' }
} finally { Pop-Location }

Push-Location $AndroidDir
try {
  & $gradleBin $gradleTask --no-daemon
  if ($LASTEXITCODE -ne 0) { throw "$gradleTask failed ($LASTEXITCODE)" }
} finally { Pop-Location }

$apk = if ($Release) {
  Join-Path $AndroidDir 'app\build\outputs\apk\release\app-release.apk'
} else {
  Join-Path $AndroidDir 'app\build\outputs\apk\debug\app-debug.apk'
}
if (-not (Test-Path $apk)) { throw "APK not found: $apk" }
Write-Step 'Done'
Write-Host "APK: $apk" -ForegroundColor Green
Write-Host "Size: $([math]::Round((Get-Item $apk).Length / 1MB, 2)) MB"
Write-Host 'Copy to phone (allow unknown sources) and run the acceptance checklist.'