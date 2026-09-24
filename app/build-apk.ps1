# 拾穗集 —— Windows 一键装工具并打 Android debug 包
# 用法（仓库根目录或 app/ 下）：
#   powershell -ExecutionPolicy Bypass -File app\build-apk.ps1
# 幂等：已有 JDK/SDK 会复用；缺什么补什么。产物：app\android\app\build\outputs\apk\debug\app-debug.apk
# 国内网络默认走镜像（Gradle 腾讯 / Maven 阿里）。

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

Write-Step 'Capacitor sync + assembleDebug'
Push-Location $AppRoot
try {
  npx cap sync android
  if ($LASTEXITCODE -ne 0) { throw 'cap sync failed' }
} finally { Pop-Location }

Push-Location $AndroidDir
try {
  & $gradleBin assembleDebug --no-daemon
  if ($LASTEXITCODE -ne 0) { throw "assembleDebug failed ($LASTEXITCODE)" }
} finally { Pop-Location }

$apk = Join-Path $AndroidDir 'app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path $apk)) { throw "APK not found: $apk" }
Write-Step 'Done'
Write-Host "APK: $apk" -ForegroundColor Green
Write-Host "Size: $([math]::Round((Get-Item $apk).Length / 1MB, 2)) MB"
Write-Host 'Copy to phone (allow unknown sources) and run the acceptance checklist.'