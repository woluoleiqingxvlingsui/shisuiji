# 拾穗集 一键备份 —— 把 data/ 整个复制成一份带时间戳的副本
# 用法（PowerShell）：
#   powershell -ExecutionPolicy Bypass -File backup.ps1
#   powershell -ExecutionPolicy Bypass -File backup.ps1 -OutDir D:\备份
#   powershell -ExecutionPolicy Bypass -File backup.ps1 -Force   # 服务还在跑也照样复制
#   powershell -ExecutionPolicy Bypass -File backup.ps1 -Json     # 额外输出一行机器可读结果
#
# 备份什么：data/ 下的各板块 JSON + 随记贴图原图（data/images/），整个目录复制。
# 不备份什么：config.json（本机 papers_dir 与 sync.token）和 papers_dir 指向的论文库
#   —— 论文库通常在项目外，脚本只打印它的位置，不替你搬动。
#
# 为什么默认要求先停服务：服务启动时把整个 JSON 读进内存，每次保存都是整份重写。
#   服务开着的时候复制，复制到的可能不是内存里最新的那份，恢复后对不上。
#   先点控制台的「⏹ 停止服务」（或 powershell -File control.ps1 stop）再备份。
#   图形控制台点「💾 备份数据」时，会由 maintenance.ps1 先暂停服务、备份完再恢复运行。

param([string]$OutDir = '', [switch]$Force, [switch]$Json)

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')

$ErrorActionPreference = 'Stop'

# 机器可读的结果行（给维护脚本解析用）；人看的说明照旧打印
function Write-BackupResult([bool]$Ok, [string]$Reason, [string]$Path = '', [int]$Files = 0, [double]$Bytes = 0) {
  if (-not $Json) { return }
  $obj = [ordered]@{ ok = $Ok; reason = $Reason; path = $Path; files = $Files; bytes = [int64]$Bytes }
  Write-Output ('DANJI_BACKUP_JSON ' + ($obj | ConvertTo-Json -Compress))
}

if (-not $OutDir) { $OutDir = Join-Path $Base 'backups' }
$src = Join-Path $Base 'data'

if (-not (Test-Path $src)) {
  Write-Host "没找到 $src —— 要么还没记过东西，要么当前目录不是项目根。" -ForegroundColor Yellow
  Write-BackupResult $false 'no-data'
  exit 1
}

$owner = Get-PortOwner
if ($owner.State -ne 'Free' -and (-not $Force -or $owner.State -ne 'Project')) {
  Write-Host "服务端口正在使用或无法确认状态，先确认服务停止再备份。" -ForegroundColor Yellow
  Write-Host "  控制台点「⏹ 停止服务」，或命令行：powershell -File control.ps1 stop" -ForegroundColor Yellow
  Write-Host "  用 node server.js 手动启动的，请回原终端按 Ctrl+C 停止。" -ForegroundColor Yellow
  Write-Host "  无法查询进程状态时请先检查查询权限；-Force 只允许跳过已确认本项目服务的运行检查。" -ForegroundColor Yellow
  Write-BackupResult $false 'service-running'
  exit 2
}
if ($owner.State -eq 'Project') {
  Write-Warning '正在强制复制运行中的数据：这不是一致性备份，恢复时可能缺少近期操作。'
}

# 禁止输出到 data/ 内，否则递归复制会把备份再次当作源数据。
$srcFull = [IO.Path]::GetFullPath($src).TrimEnd('\', '/')
$outFull = [IO.Path]::GetFullPath($OutDir).TrimEnd('\', '/')
if ($outFull.Equals($srcFull, [StringComparison]::OrdinalIgnoreCase) -or
    $outFull.StartsWith($srcFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  Write-Host '备份位置不能在 data/ 里面，请换一个输出目录。' -ForegroundColor Red
  Write-BackupResult $false 'output-inside-data'
  exit 1
}
$stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$dest = Join-Path $OutDir "danji-$stamp"
$destData = Join-Path $dest 'data'
New-Item -ItemType Directory -Path $destData -Force | Out-Null
Get-ChildItem -LiteralPath $src -Force | Copy-Item -Destination $destData -Recurse -Force

# 复制完核对清单、字节数和每个文件的哈希。
$srcFiles = @(Get-ChildItem -LiteralPath $src -Recurse -File -Force)
$dstFiles = @(Get-ChildItem -LiteralPath $destData -Recurse -File -Force)
$srcBytes = ($srcFiles | Measure-Object -Property Length -Sum).Sum
$dstBytes = ($dstFiles | Measure-Object -Property Length -Sum).Sum
if ($srcFiles.Count -ne $dstFiles.Count -or $srcBytes -ne $dstBytes) {
  Write-Host "备份校验没过：源文件 $($srcFiles.Count) 个 / $srcBytes 字节，备份 $($dstFiles.Count) 个 / $dstBytes 字节。" -ForegroundColor Red
  Write-BackupResult $false 'verify-mismatch'
  exit 3
}
function Get-BackupHash([string]$FilePath) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($FilePath)
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)) }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
foreach ($file in $srcFiles) {
  $relative = $file.FullName.Substring($srcFull.Length).TrimStart('\', '/')
  $copied = Join-Path $destData $relative
  if (-not (Test-Path -LiteralPath $copied -PathType Leaf) -or
      (Get-BackupHash $file.FullName) -ne (Get-BackupHash $copied)) {
    Write-Host "备份内容校验失败：$relative。请保留源数据，停止服务后重新备份。" -ForegroundColor Red
    Write-BackupResult $false 'verify-hash'
    exit 3
  }
}

function Show-Size([double]$bytes) {
  if ($bytes -lt 1MB) { return "{0:N0} KB" -f ($bytes / 1KB) }
  return "{0:N1} MB" -f ($bytes / 1MB)
}

Write-Host ""
Write-Host "备份完成 ✅  $dest" -ForegroundColor Green
Write-Host "  $($srcFiles.Count) 个文件 · $(Show-Size $srcBytes)"
Write-Host "  恢复：停服务后把 $destData 整个复制回项目根目录，改名为 data\"
Write-BackupResult $true 'ok' $destData $srcFiles.Count $srcBytes

# 提醒另外两样不在备份里的东西
$cfgPath = Join-Path $Base 'config.json'
$papersDir = ''
if (Test-Path $cfgPath) {
  try {
    $cfg = Get-Content -Path $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.papers_dir) { $papersDir = [string]$cfg.papers_dir }
  } catch { }
}
Write-Host ""
Write-Host "另外两样不在这份备份里，要单独留一份：" -ForegroundColor Yellow
Write-Host "  config.json（论文库路径 + 手机口令）：$cfgPath"
if ($papersDir) {
  Write-Host "  论文库（PDF 原件，可能在项目外）：$papersDir"
} else {
  Write-Host "  论文库（PDF 原件）：config.json 里没配 papers_dir，默认项目内的 papers\"
}
