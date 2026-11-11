# 拾穗集 免安装包 / 打包 自检 —— 只在临时目录里跑，不联网、不碰真实数据
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\test-portable.ps1
#
# 验证：运行时查找（随包自带优先、回落系统 Node）、进程 PATH 只在前面加前缀、
#       打包时私密文件进不去、必需文件都在、SHA256SUMS 对得上、
#       源码清单里混进私密文件时打包直接失败且不产出压缩包。

$ErrorActionPreference = 'Stop'

$script:Pass = 0
$script:Fail = 0

function Assert-True {
  param($Condition, [string]$Message)
  if ($Condition) {
    $script:Pass++
    Write-Host ('  [通过] ' + $Message) -ForegroundColor Green
  } else {
    $script:Fail++
    Write-Host ('  [失败] ' + $Message) -ForegroundColor Red
  }
}

function Assert-Equal {
  param($Expected, $Actual, [string]$Message)
  if (([string]$Expected -eq [string]$Actual)) {
    $script:Pass++
    Write-Host ('  [通过] ' + $Message) -ForegroundColor Green
  } else {
    $script:Fail++
    Write-Host ('  [失败] ' + $Message + '（期望 ' + $Expected + '，实际 ' + $Actual + '）') -ForegroundColor Red
  }
}

function Write-Case([string]$Title) {
  Write-Host ''
  Write-Host ('== ' + $Title) -ForegroundColor Cyan
}

function Get-ZipEntries([string]$Path) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try {
    return @($zip.Entries | ForEach-Object { $_.FullName })
  } finally {
    $zip.Dispose()
  }
}

function Get-Sha256([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$work = Join-Path ([IO.Path]::GetTempPath()) ('shisuiji-portable-test-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
  . (Join-Path $repoRoot 'runtime.ps1')

  Write-Case '运行时查找：随包自带优先'
  $rtProj = Join-Path $work 'rt-proj'
  New-Item -ItemType Directory -Path (Join-Path $rtProj 'runtime') -Force | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $rtProj 'runtime\node.exe'), 'fake-node', (New-Object System.Text.UTF8Encoding($false)))
  $rt = Get-DanjiRuntime -ProjectRoot $rtProj
  Assert-True ($null -ne $rt) '找到了运行时'
  Assert-True ([bool]$rt.Bundled) '用的是随包自带的 Node'
  Assert-Equal (Join-Path $rtProj 'runtime\node.exe') $rt.Node 'node 路径正确'

  Write-Case '运行时查找：没有自带运行时就回落系统 Node'
  $sysProj = Join-Path $work 'sys-proj'
  New-Item -ItemType Directory -Path $sysProj -Force | Out-Null
  $rt2 = Get-DanjiRuntime -ProjectRoot $sysProj
  if (Get-Command node -ErrorAction SilentlyContinue) {
    Assert-True ($null -ne $rt2) '找到了系统 Node'
    Assert-True (-not [bool]$rt2.Bundled) '不是随包自带的'
  } else {
    Write-Host '    （这台机器没有系统 Node，跳过回落检查）' -ForegroundColor DarkGray
  }

  Write-Case '进程 PATH：只在前面加运行时目录，不改系统设置'
  $oldPath = $env:PATH
  try {
    $null = Use-DanjiRuntime -ProjectRoot $rtProj
    $expectPrefix = (Join-Path $rtProj 'runtime')
    Assert-True ($env:PATH.StartsWith($expectPrefix, [StringComparison]::OrdinalIgnoreCase)) '运行时目录排在最前面'
    Assert-True ($env:PATH.EndsWith($oldPath, [StringComparison]::Ordinal)) '原来的 PATH 原样保留在后面'
  } finally {
    $env:PATH = $oldPath
  }

  Write-Case '运行时已在 PATH 后面时仍提升到第一位'
  $oldPath = $env:PATH
  try {
    $env:PATH = $oldPath + ';' + (Join-Path $rtProj 'runtime')
    $null = Use-DanjiRuntime -ProjectRoot $rtProj
    Assert-True ($env:PATH.StartsWith((Join-Path $rtProj 'runtime') + ';',[StringComparison]::OrdinalIgnoreCase)) '系统 Node 不会抢在随包 Node 前面'
  } finally { $env:PATH = $oldPath }

  Write-Case '打包：私密文件进不去，必需文件都在'
  $fixture = Join-Path $work 'fixture'
  New-Item -ItemType Directory -Path $fixture -Force | Out-Null
  $manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'release-files.json') -Raw -Encoding UTF8 | ConvertFrom-Json

  function New-FixtureFile([string]$Rel) {
    $p = Join-Path $fixture ($Rel.Replace('/', '\'))
    $dir = Split-Path -Parent $p
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($p, ('fixture ' + $Rel), (New-Object System.Text.UTF8Encoding($false)))
  }

  # 清单里点名的文件都造出来
  foreach ($f in @($manifest.portable.files)) { New-FixtureFile ([string]$f) }
  foreach ($t in @($manifest.portable.tools)) { New-FixtureFile ([string]$t) }
  foreach ($d in @($manifest.portable.directories)) { New-FixtureFile (([string]$d) + '/index.html') }
  foreach ($entry in @($manifest.portable.requiredEntries)) { if ($entry -notmatch '^(runtime|node_modules)/') { New-FixtureFile ([string]$entry) } }
  foreach ($e in @($manifest.extraSourceFiles)) { New-FixtureFile ([string]$e) }
  New-FixtureFile 'README.md'
  New-FixtureFile 'LICENSE'
  # 打包清单要用真的那份（假项目里也得按同一份清单检查）
  Copy-Item -LiteralPath (Join-Path $repoRoot 'release-files.json') -Destination (Join-Path $fixture 'release-files.json') -Force
  # 版本号写死成 9.9.9，方便找输出文件
  $pkgJson = [ordered]@{
    name         = 'shisuiji-fixture'
    version      = '9.9.9'
    private      = $true
    dependencies = [ordered]@{ qrcode = '^1.5.4' }
  }
  [System.IO.File]::WriteAllText((Join-Path $fixture 'package.json'), ($pkgJson | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))

  # 本机私密文件：必须一个都进不了包
  New-FixtureFile 'config.json'
  New-FixtureFile 'local.env.ps1'
  New-FixtureFile 'runtime-options.json'
  New-FixtureFile 'data/eggs.json'
  New-FixtureFile 'papers/某论文.pdf'
  New-FixtureFile 'backups/旧备份/data/eggs.json'
  New-FixtureFile 'danji-cert.pem'
  New-FixtureFile 'danji-key.pem'
  New-FixtureFile '签名.jks'
  New-FixtureFile 'app/build.gradle'
  New-FixtureFile 'tools/test-secret.mjs'

  # 假的运行时与依赖
  $fakeRuntime = Join-Path $work 'fake-runtime'
  New-Item -ItemType Directory -Path $fakeRuntime -Force | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $fakeRuntime 'node.exe'), 'fake-node', (New-Object System.Text.UTF8Encoding($false)))
  [System.IO.File]::WriteAllText((Join-Path $fakeRuntime 'LICENSE'), 'fake node license', (New-Object System.Text.UTF8Encoding($false)))
  $fakeModules = Join-Path $work 'fake-node-modules'
  New-Item -ItemType Directory -Path (Join-Path $fakeModules 'qrcode') -Force | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $fakeModules 'qrcode\package.json'), '{"name":"qrcode"}', (New-Object System.Text.UTF8Encoding($false)))

  # 源码清单：正常的文件（私密文件不在清单里）
  $listPath = Join-Path $work 'source-list.txt'
  $listLines = @()
  foreach ($f in @($manifest.portable.files)) { $listLines += ([string]$f) }
  foreach ($t in @($manifest.portable.tools)) { $listLines += ([string]$t) }
  $listLines += 'public/index.html'
  # 这两个应该在源码包里，但不该出现在免安装包里
  $listLines += 'app/build.gradle'
  $listLines += 'tools/test-secret.mjs'
  [System.IO.File]::WriteAllLines($listPath, $listLines, (New-Object System.Text.UTF8Encoding($false)))

  $outDir = Join-Path $work 'out'
  $buildScript = Join-Path $repoRoot 'tools\build-release.ps1'
  $buildArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $buildScript,
    '-ProjectRoot', $fixture, '-OutputDir', $outDir,
    '-RuntimeDir', $fakeRuntime, '-PreparedNodeModules', $fakeModules,
    '-SourceFileList', $listPath, '-SkipNpmInstall', '-Fixture')
  $buildOut = $null
  $buildCode = -1
  $oldEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $buildOut = & powershell @buildArgs 2>&1
    $buildCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldEap
  }
  if ($buildCode -ne 0) {
    foreach ($line in @($buildOut)) { Write-Host ('    ' + [string]$line) -ForegroundColor DarkGray }
  }
  if ($buildCode -ne 0) {
    foreach ($line in @($buildOut)) { Write-Host ('    ' + [string]$line) -ForegroundColor DarkGray }
  }
  Assert-Equal 0 $buildCode '打包成功'

  $portableZip = Join-Path $outDir 'shisuiji-9.9.9-windows-x64.zip'
  $sourceZip = Join-Path $outDir 'shisuiji-9.9.9-source.zip'
  Assert-True (Test-Path -LiteralPath $portableZip) '免安装包在输出目录里'
  Assert-True (Test-Path -LiteralPath $sourceZip) '源码包在输出目录里'

  if (Test-Path -LiteralPath $portableZip) {
    $entries = Get-ZipEntries $portableZip
    $bad = @()
    foreach ($e in $entries) {
      if ($e -match '(^|/)(config\.json|local\.env\.ps1|runtime-options\.json)$') { $bad += $e }
      if ($e -match '(^|/)(data|papers|backups)/') { $bad += $e }
      if ($e -match '\.(pem|keystore|jks)$') { $bad += $e }
      if ($e -match '(^|/)app/') { $bad += $e }
      if ($e -match '(^|/)tools/test-') { $bad += $e }
    }
    Assert-Equal 0 $bad.Count ('免安装包里没有私密文件' + $(if ($bad.Count) { '：' + ($bad -join ', ') } else { '' }))
    $missing = @()
    foreach ($req in @($manifest.portable.requiredEntries)) {
      $want = 'shisuiji-9.9.9/' + ([string]$req).Replace('\', '/')
      if ($entries -notcontains $want) { $missing += $req }
    }
    Assert-Equal 0 $missing.Count ('免安装包必需文件齐全' + $(if ($missing.Count) { '：缺 ' + ($missing -join ', ') } else { '' }))
    Assert-True ($entries -contains 'shisuiji-9.9.9/runtime/node.exe') '免安装包带上了 Node 运行时'
    Assert-True ($entries -contains 'shisuiji-9.9.9/runtime/LICENSE') '保留了 Node 的 LICENSE'
  }

  if (Test-Path -LiteralPath $sourceZip) {
    $entries = Get-ZipEntries $sourceZip
    $bad = @()
    foreach ($e in $entries) {
      if ($e -match '(^|/)(config\.json|local\.env\.ps1|runtime-options\.json)$') { $bad += $e }
      if ($e -match '(^|/)(data|papers|backups)/') { $bad += $e }
      if ($e -match '\.(pem|keystore|jks)$') { $bad += $e }
    }
    Assert-Equal 0 $bad.Count ('源码包里没有私密文件' + $(if ($bad.Count) { '：' + ($bad -join ', ') } else { '' }))
    $missing = @()
    foreach ($req in @($manifest.source.requiredEntries)) {
      $want = 'shisuiji-9.9.9-source/' + ([string]$req).Replace('\', '/')
      if ($entries -notcontains $want) { $missing += $req }
    }
    Assert-Equal 0 $missing.Count ('源码包必需文件齐全' + $(if ($missing.Count) { '：缺 ' + ($missing -join ', ') } else { '' }))
  }

  Write-Case 'SHA256SUMS'
  $sumPath = Join-Path $outDir 'SHA256SUMS'
  Assert-True (Test-Path -LiteralPath $sumPath) '校验和文件在输出目录里'
  if (Test-Path -LiteralPath $sumPath) {
    $sumLines = @(Get-Content -LiteralPath $sumPath -Encoding UTF8 | Where-Object { $_ -and $_.Trim() })
    Assert-Equal 2 $sumLines.Count '两行（两个包）'
    foreach ($line in $sumLines) {
      $parts = ([string]$line) -split '\s+'
      $name = $parts[$parts.Count - 1]
      $file = Join-Path $outDir $name
      if (Test-Path -LiteralPath $file) {
        Assert-Equal $parts[0] (Get-Sha256 $file) ('校验和一致：' + $name)
      } else {
        Assert-True $false ('校验和里提到的文件不存在：' + $name)
      }
    }
  }

  Write-Case '源码清单里混进私密文件时，打包必须失败且不产出压缩包'
  $badList = Join-Path $work 'bad-list.txt'
  [System.IO.File]::WriteAllLines($badList, @('server.js', 'config.json'), (New-Object System.Text.UTF8Encoding($false)))
  $outDir2 = Join-Path $work 'out2'
  $buildArgs2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $buildScript,
    '-ProjectRoot', $fixture, '-OutputDir', $outDir2,
    '-RuntimeDir', $fakeRuntime, '-PreparedNodeModules', $fakeModules,
    '-SourceFileList', $badList, '-SkipNpmInstall', '-Fixture')
  $oldEap2 = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $null = & powershell @buildArgs2 2>&1
    $code2 = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldEap2
  }
  Assert-True ($code2 -ne 0) '打包失败了（这是应该的）'
  $zips = @()
  if (Test-Path -LiteralPath $outDir2) { $zips = @(Get-ChildItem -LiteralPath $outDir2 -Filter '*.zip' -File -Force) }
  Assert-Equal 0 $zips.Count '没有产出半成品压缩包'

  Write-Host ''
  if ($script:Fail -eq 0) {
    Write-Host ('全部通过：' + $script:Pass + ' 条') -ForegroundColor Green
    exit 0
  }
  Write-Host ('失败 ' + $script:Fail + ' 条，通过 ' + $script:Pass + ' 条') -ForegroundColor Red
  exit 1
} finally {
  try { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}
