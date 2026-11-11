# 拾穗集 发布打包 —— 生成免安装包（windows-x64）与源码包
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\build-release.ps1 -NodeVersion 22.23.4
#   powershell -ExecutionPolicy Bypass -File tools\build-release.ps1 -NodeArchive D:\node-v22.23.4-win-x64.zip -NodeSha256 <官方SHA256>
#
# 产出（默认 output\release\）：
#   shisuiji-<version>-windows-x64.zip   免安装包：自带 Node 运行时与依赖
#   shisuiji-<version>-source.zip         源码包：Git 跟踪文件（当前工作树内容）+ 明确列出的新文件
#   SHA256SUMS                           两个包的校验和
#
# 隐私红线：config.json / local.env.ps1 / data / papers / backups / 证书 / 签名材料
#   一律不进包；打包前后都会检查，任何一条不通过就不产出发布包。
# 本脚本不上传、不打 tag、不改任何真实配置。

param(
  [string]$ProjectRoot = '',
  [string]$OutputDir = '',
  [string]$Version = '',
  [string]$NodeVersion = '',
  [string]$NodeArchive = '',
  [string]$NodeSha256 = '',
  [string]$RuntimeDir = '',
  [string]$PreparedNodeModules = '',
  [string]$SourceFileList = '',
  [switch]$SkipNpmInstall,
  [switch]$Fixture
)

$ErrorActionPreference = 'Stop'
if (-not $Fixture -and ($RuntimeDir -or $PreparedNodeModules -or $SourceFileList -or $SkipNpmInstall)) { throw 'Unverified runtime/dependency overrides are only available with -Fixture' }
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ProjectRoot) { $ProjectRoot = (Split-Path -Parent $scriptDir) }
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
if (-not $OutputDir) { $OutputDir = Join-Path $ProjectRoot 'output\release' }
$OutputDir = [IO.Path]::GetFullPath($OutputDir)

function Write-Step([string]$Text) {
  Write-Host ('==> ' + $Text) -ForegroundColor Cyan
}

function Write-Note([string]$Text) {
  Write-Host ('    ' + $Text) -ForegroundColor DarkGray
}

function Test-DenyPath {
  param([string]$RelPath = '', [string[]]$Rules = @())
  $p = (([string]$RelPath) -replace '\\', '/').Trim('/')
  if (-not $p) { return $null }
  foreach ($rule in @($Rules)) {
    $r = (([string]$rule) -replace '\\', '/')
    if (-not $r) { continue }
    if ($r.Contains('*')) {
      if ($r.Contains('/')) {
        if ($p -like $r) { return $rule }
      } else {
        $leaf = Split-Path -Leaf $p
        if ($leaf -like $r) { return $rule }
      }
    } else {
      if ($r -in @('config.json','local.env.ps1','runtime-options.json','keystore.properties','local.properties','.env') -and (Split-Path -Leaf $p) -ieq $r) { return $rule }
      if ($p -ieq $r) { return $rule }
      if ($p.StartsWith($r + '/', [StringComparison]::OrdinalIgnoreCase)) { return $rule }
    }
  }
  return $null
}

function Assert-NoReparseAncestor([string]$Path) {
  $candidate = [IO.Path]::GetFullPath($Path)
  while ($candidate) {
    if (Test-Path -LiteralPath $candidate) {
      if ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Linked release input: ' + $candidate) }
    }
    $parent = Split-Path -Parent $candidate
    if ($parent -eq $candidate) { break }
    $candidate = $parent
  }
}

function Copy-ReleaseFile {
  param([string]$Root = '', [string]$Rel = '', [string]$Stage = '', [string[]]$DenyRules = @(), [switch]$SkipMissing)
  $norm = (([string]$Rel) -replace '\\', '/').Trim()
  if (-not $norm) { throw '空的相对路径' }
  if ($norm.StartsWith('/') -or $norm -match '^[A-Za-z]:') { throw ('路径必须是相对路径：' + $Rel) }
  foreach ($seg in $norm.Split('/')) {
    if ($seg -eq '..') { throw ('路径里有上级目录：' + $Rel) }
  }
  $hit = Test-DenyPath -RelPath $norm -Rules $DenyRules
  if ($hit) { throw ('这个路径不能进包（命中 ' + $hit + '）：' + $norm) }
  $full = Join-Path $Root ($norm.Replace('/', '\'))
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
    if ($SkipMissing) { return $false }
    throw ('找不到文件：' + $norm)
  }
  Assert-NoReparseAncestor $full
  $item = Get-Item -LiteralPath $full -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw ('文件是链接/重解析点，不进包：' + $norm)
  }
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $itemFull = [IO.Path]::GetFullPath($item.FullName)
  if (-not $itemFull.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw ('路径越界：' + $norm)
  }
  $dest = Join-Path $Stage ($norm.Replace('/', '\'))
  $destDir = Split-Path -Parent $dest
  if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
  Copy-Item -LiteralPath $item.FullName -Destination $dest -Force
  return $true
}

function Copy-ReleaseTree {
  param([string]$Root = '', [string]$Rel = '', [string]$Stage = '', [string[]]$DenyRules = @())
  $norm = (([string]$Rel) -replace '\\', '/').Trim('/')
  $srcDir = Join-Path $Root ($norm.Replace('/', '\'))
  if (-not (Test-Path -LiteralPath $srcDir -PathType Container)) { throw ('找不到目录：' + $norm) }
  Assert-NoReparseAncestor $srcDir
  $dirs = @(Get-ChildItem -LiteralPath $srcDir -Recurse -Directory -Force)
  foreach ($d in $dirs) {
    if ($d.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('目录里有链接/重解析点，不进包：' + $d.FullName) }
  }
  $files = @(Get-ChildItem -LiteralPath $srcDir -Recurse -File -Force)
  foreach ($f in $files) {
    $rel = $f.FullName.Substring([IO.Path]::GetFullPath($Root).TrimEnd('\', '/').Length).TrimStart('\', '/')
    $null = Copy-ReleaseFile -Root $Root -Rel $rel -Stage $Stage -DenyRules $DenyRules
  }
}

function Get-GitTrackedFiles {
  param([string]$Root = '')
  $git = Get-Command git -ErrorAction SilentlyContinue
  if (-not $git) { throw '找不到 git：源码包要用 git ls-files 取跟踪文件' }
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $git.Source -C $Root ls-files 2>$null
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $old
  }
  if ($code -ne 0) { throw 'git ls-files 执行失败' }
  return @($out | Where-Object { $_ -and ([string]$_).Trim() } | ForEach-Object { ([string]$_).Trim() })
}

function Get-Sha256File {
  param([string]$Path = '')
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $hash = $sha.ComputeHash($stream)
    return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

function New-ZipFromDirectory {
  param([string]$SourceDir = '', [string]$ZipPath = '', [string]$Prefix = '')
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  Add-Type -AssemblyName System.IO.Compression
  if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
  $root = (Get-Item -LiteralPath $SourceDir).FullName.TrimEnd('\', '/')
  $files = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force | Sort-Object FullName)
  $zip = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($f in $files) {
      $rel = $f.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
      $entryName = $Prefix + '/' + $rel
      $null = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip, $f.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    }
  } finally {
    $zip.Dispose()
  }
  return $files.Count
}

function Get-ZipEntryNames {
  param([string]$ZipPath = '')
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  Add-Type -AssemblyName System.IO.Compression
  $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    return @($zip.Entries | ForEach-Object { $_.FullName })
  } finally {
    $zip.Dispose()
  }
}

function Test-PackageEntries {
  param([string]$ZipPath = '', [string]$Prefix = '', [string[]]$Required = @(), [string[]]$PrivatePaths = @(), [string[]]$Forbidden = @())
  $entries = Get-ZipEntryNames -ZipPath $ZipPath
  $problems = @()
  foreach ($e in $entries) {
    $rel = [string]$e
    if ($Prefix -and $rel.StartsWith($Prefix + '/')) { $rel = $rel.Substring($Prefix.Length + 1) }
    $hit = Test-DenyPath -RelPath $rel -Rules $PrivatePaths
    if ($hit) { $problems += ('包里出现了不能带的东西：' + $rel + '（命中 ' + $hit + '）') }
    $bad = Test-DenyPath -RelPath $rel -Rules $Forbidden
    if ($bad) { $problems += ('包里出现了不该带的东西：' + $rel + '（命中 ' + $bad + '）') }
  }
  foreach ($req in @($Required)) {
    $want = $Prefix + '/' + ([string]$req).Replace('\', '/')
    if ($entries -notcontains $want) { $problems += ('包里少了必需的文件：' + $req) }
  }
  return $problems
}

function Copy-DirectoryTree {
  param([string]$Source = '', [string]$Dest = '')
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw ('找不到目录：' + $Source) }
  New-Item -ItemType Directory -Path $Dest -Force | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $Dest -Recurse -Force
}

# ———— 准备 Node 运行时 ————
function Resolve-NodeArchive {
  param([string]$Version = '', [string]$Archive = '', [string]$Expected = '')
  if ($Archive) {
    if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { throw ('找不到 Node 压缩包：' + $Archive) }
    $actual = Get-Sha256File -Path $Archive
    if ($Expected) {
      if ($actual -ne ([string]$Expected).ToLowerInvariant().Trim()) {
        throw ('Node 压缩包校验不对：期望 ' + $Expected + '，实际 ' + $actual)
      }
      Write-Note ('Node 压缩包 SHA256 与给定值一致：' + $actual)
    } else {
      if (-not $Fixture) { throw '用 -NodeArchive 时请一并给 -NodeSha256，以便核对官方校验和' }
      Write-Note ('自检模式：没有给 -NodeSha256，实测 SHA256 = ' + $actual)
    }
    return @{ Archive = (Get-Item -LiteralPath $Archive).FullName; Sha256 = $actual; TempDir = '' }
  }
  if (-not $Version) { throw '请给 -NodeVersion（明确版本号）或 -NodeArchive（离线压缩包）' }
  if ($Version -eq 'latest') { throw '不要用 latest：请写明确的 Node 版本号' }
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'NodeVersion must be an exact numeric release' }
  $base = 'https://nodejs.org/dist/v' + $Version
  $fileName = 'node-v' + $Version + '-win-x64.zip'
  $zipUrl = $base + '/' + $fileName
  $sumUrl = $base + '/SHASUMS256.txt'
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('node-dl-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    $sumFile = Join-Path $tmp 'SHASUMS256.txt'
    Write-Note ('下载校验和清单：' + $sumUrl)
    Invoke-WebRequest -Uri $sumUrl -OutFile $sumFile -UseBasicParsing
    $expected = ''
    foreach ($line in @(Get-Content -LiteralPath $sumFile -Encoding UTF8)) {
      $parts = ([string]$line) -split '\s+'
      if ($parts.Count -ge 2 -and $parts[1].Trim() -eq $fileName) { $expected = $parts[0].Trim().ToLowerInvariant() }
    }
    if (-not $expected) { throw ('官方 SHASUMS256.txt 里没有 ' + $fileName + ' 的条目') }
    $zipFile = Join-Path $tmp $fileName
    Write-Note ('下载 Node：' + $zipUrl)
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile -UseBasicParsing
    $actual = Get-Sha256File -Path $zipFile
    if ($actual -ne $expected) { throw ('Node 压缩包 SHA256 与官方清单不一致：期望 ' + $expected + '，实际 ' + $actual) }
    Write-Note ('SHA256 与官方 SHASUMS256.txt 一致：' + $actual)
    return @{ Archive = $zipFile; Sha256 = $actual; TempDir = $tmp }
  } catch {
    if ($tmp -and (Split-Path -Leaf $tmp) -like 'node-dl-*') { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    throw
  }
}

# ———— 主流程 ————
Write-Step ('项目目录：' + $ProjectRoot)
$manifestPath = Join-Path $ProjectRoot 'release-files.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw ('找不到 ' + $manifestPath) }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$denyRules = @($manifest.deny)
$privatePaths = @($manifest.privatePaths)
Write-Note ('排除清单 ' + $denyRules.Count + ' 条；隐私检查 ' + $privatePaths.Count + ' 条')

if (-not $Version) {
  $pkgPath = Join-Path $ProjectRoot 'package.json'
  if (-not (Test-Path -LiteralPath $pkgPath -PathType Leaf)) { throw ('找不到 ' + $pkgPath) }
  $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $Version = [string]$pkg.version
}
if (-not $Version) { throw '读不到版本号' }
$declaredVersion = [string](Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($Version -cne $declaredVersion -or $Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must match root package.json' }
Write-Step ('版本：' + $Version)

$staging = Join-Path ([IO.Path]::GetTempPath()) ('shisuiji-release-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$portableStage = Join-Path $staging 'portable'
$sourceStage = Join-Path $staging 'source'
$tmpZipDir = Join-Path $staging 'zip'
New-Item -ItemType Directory -Path $portableStage -Force | Out-Null
New-Item -ItemType Directory -Path $sourceStage -Force | Out-Null
New-Item -ItemType Directory -Path $tmpZipDir -Force | Out-Null

try {
  # 1. 免安装包的文件
  Write-Step '收集免安装包需要的文件'
  foreach ($f in @($manifest.portable.files)) {
    $null = Copy-ReleaseFile -Root $ProjectRoot -Rel ([string]$f) -Stage $portableStage -DenyRules $denyRules
  }
  foreach ($d in @($manifest.portable.directories)) {
    Copy-ReleaseTree -Root $ProjectRoot -Rel ([string]$d) -Stage $portableStage -DenyRules $denyRules
  }
  foreach ($t in @($manifest.portable.tools)) {
    $null = Copy-ReleaseFile -Root $ProjectRoot -Rel ([string]$t) -Stage $portableStage -DenyRules $denyRules
  }
  Write-Note ('文件 ' + @($manifest.portable.files).Count + ' 个、目录 ' + @($manifest.portable.directories).Count + ' 个、工具 ' + @($manifest.portable.tools).Count + ' 个')

  # 2. Node 运行时
  Write-Step '准备 Node 运行时'
  $stageRuntime = Join-Path $portableStage 'runtime'
  if ($RuntimeDir) {
    if (-not (Test-Path -LiteralPath (Join-Path $RuntimeDir 'node.exe') -PathType Leaf)) {
      throw ('-RuntimeDir 里没有 node.exe：' + $RuntimeDir)
    }
    Copy-DirectoryTree -Source $RuntimeDir -Dest $stageRuntime
    Write-Note ('用现成的运行时目录：' + $RuntimeDir)
  } else {
    $nodeInfo = Resolve-NodeArchive -Version $NodeVersion -Archive $NodeArchive -Expected $NodeSha256
    Add-Type -AssemblyName System.IO.Compression.FileSystem
  Add-Type -AssemblyName System.IO.Compression
    $extractDir = Join-Path $staging 'node-extract'
    $archiveCheck = [IO.Compression.ZipFile]::OpenRead($nodeInfo.Archive)
    try {
      foreach ($entry in $archiveCheck.Entries) {
        $entryPath = $entry.FullName.Replace('\','/')
        if ($entryPath.StartsWith('/') -or $entryPath.Contains(':') -or $entryPath.Split('/') -contains '..' -or
            ((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960)) { throw 'Unsafe Node archive entry' }
      }
    } finally { $archiveCheck.Dispose() }
    [System.IO.Compression.ZipFile]::ExtractToDirectory($nodeInfo.Archive, $extractDir)
    if ($nodeInfo.TempDir) {
      try { Remove-Item -LiteralPath $nodeInfo.TempDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }
    $inner = @(Get-ChildItem -LiteralPath $extractDir -Directory -Force)
    if ($inner.Count -ne 1) { throw 'Node 压缩包里没找到唯一的顶层目录' }
    Copy-DirectoryTree -Source $inner[0].FullName -Dest $stageRuntime
    if (-not (Test-Path -LiteralPath (Join-Path $stageRuntime 'LICENSE') -PathType Leaf)) {
      $lic = @(Get-ChildItem -LiteralPath $stageRuntime -Filter 'LICENSE*' -File -Force)
      if ($lic.Count -gt 0) { Copy-Item -LiteralPath $lic[0].FullName -Destination (Join-Path $stageRuntime 'LICENSE') -Force }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $stageRuntime 'LICENSE') -PathType Leaf)) {
      throw 'Node 运行时里找不到 LICENSE'
    }
    Write-Note ('运行时来自 ' + $nodeInfo.Archive + '（SHA256 ' + $nodeInfo.Sha256 + '）')
  }
  if (-not (Test-Path -LiteralPath (Join-Path $stageRuntime 'node.exe') -PathType Leaf)) {
    throw '运行时里没有 node.exe'
  }

  # 3. 依赖：在暂存目录里装，不复制本机的 node_modules，也不改源锁文件
  Write-Step '安装运行依赖（只在暂存目录里）'
  if ($SkipNpmInstall) {
    if ($PreparedNodeModules) {
      Copy-DirectoryTree -Source $PreparedNodeModules -Dest (Join-Path $portableStage 'node_modules')
      Write-Note '自检模式：用准备好的依赖目录'
    } else {
      Write-Note '自检模式：跳过依赖安装'
    }
  } else {
    if ($PreparedNodeModules) { Write-Note '注意：给了 -PreparedNodeModules，仍以 npm ci 的结果为准' }
    $nodeExe = Join-Path $stageRuntime 'node.exe'
    $npmCli = Join-Path $stageRuntime 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) { throw ('运行时里找不到 npm：' + $npmCli) }
    Push-Location $portableStage
    try {
      $oldEap = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        & $nodeExe $npmCli ci --omit=dev --ignore-scripts --no-audit --no-fund
        $code = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $oldEap
      }
    } finally {
      Pop-Location
    }
    if ($code -ne 0) { throw ('npm ci 失败（退出码 ' + $code + '）') }
    Write-Note '依赖装好了（npm ci --omit=dev）'
  }

  # 4. 源码包：Git 跟踪文件 + 明确列出的新文件
  Write-Step '收集源码包文件'
  $sourceFiles = @()
  if ($SourceFileList) {
    if (-not (Test-Path -LiteralPath $SourceFileList -PathType Leaf)) { throw ('找不到文件清单：' + $SourceFileList) }
    $sourceFiles = @(Get-Content -LiteralPath $SourceFileList -Encoding UTF8 | Where-Object { $_ -and ([string]$_).Trim() } | ForEach-Object { ([string]$_).Trim() })
    Write-Note ('用给的文件清单：' + $sourceFiles.Count + ' 个')
  } else {
    $sourceFiles = Get-GitTrackedFiles -Root $ProjectRoot
    Write-Note ('git 跟踪文件：' + $sourceFiles.Count + ' 个')
  }
  $extraSet = @()
  foreach ($extra in @($manifest.extraSourceFiles)) {
    $rel = ([string]$extra).Trim()
    if (-not $rel) { continue }
    if ($sourceFiles -notcontains $rel) { $sourceFiles += $rel }
    $extraSet += $rel
  }
  foreach ($rel in $sourceFiles) {
    if ($extraSet -contains $rel) { continue }
    $null = Copy-ReleaseFile -Root $ProjectRoot -Rel $rel -Stage $sourceStage -DenyRules $denyRules -SkipMissing
  }
  # 明确列出的新文件：缺了就报错（发布包必须是完整的）
  foreach ($rel in $extraSet) {
    $null = Copy-ReleaseFile -Root $ProjectRoot -Rel $rel -Stage $sourceStage -DenyRules $denyRules
  }
  Write-Note ('源码包共 ' + $sourceFiles.Count + ' 个文件')

  # 5. 打 zip
  Write-Step '生成压缩包'
  $portablePrefix = 'shisuiji-' + $Version
  $sourcePrefix = 'shisuiji-' + $Version + '-source'
  $portableTmp = Join-Path $tmpZipDir ($portablePrefix + '.zip')
  $sourceTmp = Join-Path $tmpZipDir ($sourcePrefix + '.zip')
  $n1 = New-ZipFromDirectory -SourceDir $portableStage -ZipPath $portableTmp -Prefix $portablePrefix
  $n2 = New-ZipFromDirectory -SourceDir $sourceStage -ZipPath $sourceTmp -Prefix $sourcePrefix
  Write-Note ('免安装包 ' + $n1 + ' 个文件；源码包 ' + $n2 + ' 个文件')

  # 6. 逐条检查：必需文件 + 隐私红线
  Write-Step '检查包里的每一个条目'
  $problems = @()
  $portableForbidden = @()
  if ($manifest.PSObject.Properties['portableForbidden']) { $portableForbidden = @($manifest.portableForbidden) }
  $problems += Test-PackageEntries -ZipPath $portableTmp -Prefix $portablePrefix -Required @($manifest.portable.requiredEntries) -PrivatePaths $privatePaths -Forbidden $portableForbidden
  $problems += Test-PackageEntries -ZipPath $sourceTmp -Prefix $sourcePrefix -Required @($manifest.source.requiredEntries) -PrivatePaths $privatePaths
  if ($problems.Count -gt 0) {
    foreach ($p in $problems) { Write-Host ('  [不通过] ' + $p) -ForegroundColor Red }
    throw ('检查没通过，一共 ' + $problems.Count + ' 条；没有生成发布包')
  }
  Write-Note '所有条目检查通过'

  # 7. 放进 output\release 并写校验和
  if (-not (Test-Path -LiteralPath $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null }
  $portableName = 'shisuiji-' + $Version + '-windows-x64.zip'
  $sourceName = 'shisuiji-' + $Version + '-source.zip'
  $portableOut = Join-Path $OutputDir $portableName
  $sourceOut = Join-Path $OutputDir $sourceName
  Copy-Item -LiteralPath $portableTmp -Destination $portableOut -Force
  Copy-Item -LiteralPath $sourceTmp -Destination $sourceOut -Force
  $sumLines = @()
  $sumLines += ((Get-Sha256File -Path $portableOut) + '  ' + $portableName)
  $sumLines += ((Get-Sha256File -Path $sourceOut) + '  ' + $sourceName)
  $sumPath = Join-Path $OutputDir 'SHA256SUMS'
  [System.IO.File]::WriteAllLines($sumPath, $sumLines, (New-Object System.Text.UTF8Encoding($false)))

  Write-Host ''
  Write-Host ('打包完成 ✅  ' + $OutputDir) -ForegroundColor Green
  Write-Host ('  ' + $portableName + '  (' + [math]::Round((Get-Item -LiteralPath $portableOut).Length / 1MB, 1) + ' MB)')
  Write-Host ('  ' + $sourceName + '  (' + [math]::Round((Get-Item -LiteralPath $sourceOut).Length / 1MB, 1) + ' MB)')
  Write-Host ('  SHA256SUMS')
  Write-Host '（没有上传、没有打 tag；发布前请自己再核对一遍校验和）'
} finally {
  try {
    $stagingFull = [IO.Path]::GetFullPath($staging)
    $tmpBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($stagingFull.StartsWith($tmpBase,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $stagingFull) -like 'shisuiji-release-*') { Remove-Item -LiteralPath $stagingFull -Recurse -Force -ErrorAction SilentlyContinue }
  } catch { }
}
