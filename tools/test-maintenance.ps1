# 拾穗集 备份 / 恢复 自检 —— 只在临时目录里跑
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\test-maintenance.ps1
#
# 做法：把脚本复制到一个临时项目里，塞进假的 data/，用注入的服务状态（fixture）代替真实进程，
#       所以不会碰到真实服务、真实数据、真实文献库。
# 验证：备份时的暂停与恢复、备份时服务本来就停着、端口被别的程序占用时拒绝、
#       恢复前校验不过就不动 data/、换名失败回滚原 data/、备份源在 data/ 内拒绝、链接目录拒绝。

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
  $ok = ([string]$Expected -eq [string]$Actual)
  if ($ok) {
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

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$work = Join-Path ([IO.Path]::GetTempPath()) ('shisuiji-maint-test-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$proj = Join-Path $work 'proj'
$fakePapers = Join-Path $work 'papers'
New-Item -ItemType Directory -Path $proj -Force | Out-Null
New-Item -ItemType Directory -Path $fakePapers -Force | Out-Null

# 隔离环境：文献库指向临时目录；端口指向一个空闲端口，绝不碰真实服务
$env:DANJI_PAPERS_DIR = $fakePapers
$fixtureSocket = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
$fixtureSocket.Start()
$env:PORT = [string]$fixtureSocket.LocalEndpoint.Port
$fixtureSocket.Stop()

function Write-JsonFile([string]$Path, [string]$Content) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

try {
  foreach ($f in @('lib.ps1', 'runtime.ps1', 'restore.ps1', 'maintenance.ps1', 'backup.ps1')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot $f) -Destination (Join-Path $proj $f) -Force
  }

  # 假的项目数据
  $dataDir = Join-Path $proj 'data'
  Write-JsonFile (Join-Path $dataDir 'eggs.json') '{"schema_version":1,"activities":[{"id":"a1","title":"现在的蛋"}]}'
  Write-JsonFile (Join-Path $dataDir 'ideas.json') '{"schema_version":1,"ideas":[{"id":"i1","title":"现在的随记","images":[{"id":"img-keep","name":"a.png"}]}],"op_receipts":{},"idea_history":{}}'
  Write-JsonFile (Join-Path $dataDir 'sites.json') '{"schema_version":1,"sites":[]}'
  Write-JsonFile (Join-Path $dataDir 'trash.json') '{"schema_version":1,"items":[]}'
  New-Item -ItemType Directory -Path (Join-Path $dataDir 'images') -Force | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $dataDir 'images\img-keep.png'), 'fake-png', (New-Object System.Text.UTF8Encoding($false)))

  # 一份可以拿来恢复的备份
  $backupRoot = Join-Path $work 'backup-ok'
  Write-JsonFile (Join-Path $backupRoot 'data\eggs.json') '{"schema_version":1,"activities":[{"id":"a2","title":"备份里的蛋"}]}'
  Write-JsonFile (Join-Path $backupRoot 'data\ideas.json') '{"schema_version":1,"ideas":[{"id":"i2","title":"备份里的随记","images":[{"id":"img-old","name":"b.png"}]}],"op_receipts":{},"idea_history":{}}'
  Write-JsonFile (Join-Path $backupRoot 'data\sites.json') '{"schema_version":1,"sites":[]}'
  Write-JsonFile (Join-Path $backupRoot 'data\trash.json') '{"schema_version":1,"items":[]}'

  # 一份坏掉的备份（JSON 解析不过）
  $backupBroken = Join-Path $work 'backup-broken'
  Write-JsonFile (Join-Path $backupBroken 'data\eggs.json') '{"schema_version":1,"activities":[{"id":"a3",'

  . (Join-Path $proj 'maintenance.ps1')

  Assert-True ($Base -eq $proj) '脚本在临时项目里跑（不会碰真实项目）'
  Assert-True ($env:DANJI_PAPERS_DIR -eq $fakePapers) '文献库指向临时目录'

  # ———— 服务状态 fixture ————
  $script:SvcState = 'Free'
  $script:SvcStops = 0
  $script:SvcStarts = 0
  $svcProbe = { return @{ State = $script:SvcState; Pid = 0; Verdict = $null } }
  $svcStop = {
    $script:SvcStops++
    $script:SvcState = 'Free'
    return @{ Ok = $true; Message = '已停止（fixture）' }
  }
  $svcStart = {
    $script:SvcStarts++
    $script:SvcState = 'Project'
    return @{ Ok = $true; Message = '已启动（fixture）' }
  }

  Write-Case '备份：服务在跑时要暂停，备份完恢复运行'
  $script:SvcState = 'Project'
  $script:SvcStops = 0
  $script:SvcStarts = 0
  $r = Invoke-MaintenanceBackup -ProjectRoot $proj -ServiceProbe $svcProbe -ServiceStop $svcStop -ServiceStart $svcStart
  Assert-True ([bool]$r.Ok) ('备份成功：' + $r.Message)
  Assert-Equal 1 $script:SvcStops '备份前暂停了一次服务'
  Assert-Equal 1 $script:SvcStarts '备份后把服务拉了起来'
  Assert-Equal 'Project' $script:SvcState '服务最后是运行着的'
  Assert-True (Test-Path -LiteralPath $r.BackupPath) ('备份文件在：' + $r.BackupPath)
  Assert-True (Test-Path -LiteralPath (Join-Path $r.BackupPath 'eggs.json')) '备份里有板块数据'

  Write-Case '备份：服务本来就是停着的，备份完仍然停着'
  $script:SvcState = 'Free'
  $script:SvcStops = 0
  $script:SvcStarts = 0
  $r2 = Invoke-MaintenanceBackup -ProjectRoot $proj -ServiceProbe $svcProbe -ServiceStop $svcStop -ServiceStart $svcStart
  Assert-True ([bool]$r2.Ok) '备份成功'
  Assert-Equal 0 $script:SvcStops '没有去停本来就没在跑的服务'
  Assert-Equal 0 $script:SvcStarts '没有去启动本来就没在跑的服务'
  Assert-Equal 'Free' $script:SvcState '服务仍然是停着的'

  Write-Case '备份：端口被别的程序占用时拒绝，不动无关进程'
  $script:SvcState = 'Foreign'
  $script:SvcStops = 0
  $script:SvcStarts = 0
  $r3 = Invoke-MaintenanceBackup -ProjectRoot $proj -ServiceProbe $svcProbe -ServiceStop $svcStop -ServiceStart $svcStart
  Assert-True (-not [bool]$r3.Ok) '备份被拒绝'
  Assert-Equal 0 $script:SvcStops '没有去停任何进程'
  Assert-Equal 'Foreign' $script:SvcState '服务状态没变'

  Write-Case '恢复前预检：误选备份集合目录不能当作单份备份'
  $collection = Join-Path $work 'backup-collection'
  New-Item -ItemType Directory -Path $collection -Force | Out-Null
  Copy-Item -LiteralPath $backupRoot -Destination (Join-Path $collection 'one-backup') -Recurse -Force
  $collectionCandidate = Get-RestoreCandidate -Path $collection -ProjectRoot $proj
  Assert-True (-not [bool]$collectionCandidate.Ok) '仅嵌套目录含板块时拒绝，避免恢复出空数据'

  Write-Case '恢复前预检：JSON 坏掉的备份不能用'
  $candBad = Get-RestoreCandidate -Path $backupBroken -ProjectRoot $proj
  Assert-True (-not [bool]$candBad.Ok) '预检不通过'
  Assert-True (@($candBad.Errors).Count -gt 0) '给出了原因'
  $before = [System.IO.File]::ReadAllText((Join-Path $dataDir 'eggs.json'))
  $script:SvcState = 'Free'
  $rBad = Invoke-MaintenanceRestore -ProjectRoot $proj -BackupPath $backupBroken -ServiceProbe $svcProbe -ServiceStop $svcStop -ServiceStart $svcStart
  Assert-True (-not [bool]$rBad.Ok) '恢复被拒绝'
  Assert-Equal $before ([System.IO.File]::ReadAllText((Join-Path $dataDir 'eggs.json'))) 'data/ 一个字节都没变'

  Write-Case '恢复前预检：备份源在当前 data/ 里要拒绝'
  $candInside = Get-RestoreCandidate -Path $dataDir -ProjectRoot $proj
  Assert-True (-not [bool]$candInside.Ok) '拒绝拿 data/ 自己恢复'

  Write-Case '恢复前预检：备份里有链接目录要拒绝'
  $backupLink = Join-Path $work 'backup-link'
  Write-JsonFile (Join-Path $backupLink 'data\eggs.json') '{"schema_version":1,"activities":[]}'
  $linkMade = $false
  try {
    $linkTarget = Join-Path $work 'link-target'
    New-Item -ItemType Directory -Path $linkTarget -Force | Out-Null
    Write-JsonFile (Join-Path $linkTarget 'x.json') '{"schema_version":1,"activities":[]}'
    New-Item -ItemType Junction -Path (Join-Path $backupLink 'data\images') -Target $linkTarget -ErrorAction Stop | Out-Null
    $linkMade = $true
  } catch {
    Write-Host '    （这个文件系统不支持目录链接，跳过这一条）' -ForegroundColor DarkGray
  }
  if ($linkMade) {
    $candLink = Get-RestoreCandidate -Path $backupLink -ProjectRoot $proj
    Assert-True (-not [bool]$candLink.Ok) '链接目录被拒绝'
  }

  Write-Case '恢复：正常恢复，数据换新，服务状态还原'
  $script:SvcState = 'Project'
  $script:SvcStops = 0
  $script:SvcStarts = 0
  $r5 = Invoke-MaintenanceRestore -ProjectRoot $proj -BackupPath $backupRoot -ServiceProbe $svcProbe -ServiceStop $svcStop -ServiceStart $svcStart
  Assert-True ([bool]$r5.Ok) ('恢复成功：' + $r5.Message)
  $eggs = [System.IO.File]::ReadAllText((Join-Path $dataDir 'eggs.json'))
  Assert-True ($eggs -like '*备份里的蛋*') 'data/ 换成了备份里的内容'
  Assert-Equal 1 $script:SvcStops '恢复前停了一次服务'
  Assert-Equal 1 $script:SvcStarts '恢复后把服务拉了起来'
  Assert-True (Test-Path -LiteralPath $r5.SafetyBackupPath) ('恢复前的数据留了一份：' + $r5.SafetyBackupPath)
  $leftOver = @()
  if (Test-Path -LiteralPath (Join-Path $proj 'tmp')) {
    $leftOver = @(Get-ChildItem -LiteralPath (Join-Path $proj 'tmp') -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'restore-*' })
  }
  Assert-Equal 0 $leftOver.Count '暂存目录清理干净了'

  Write-Case '恢复：换名失败要回滚，原来的 data/ 还在'
  $beforeRollback = [System.IO.File]::ReadAllText((Join-Path $dataDir 'eggs.json'))
  $script:SvcState = 'Free'
  $script:SvcStops = 0
  $script:SvcStarts = 0
  $cand2 = Get-RestoreCandidate -Path $backupRoot -ProjectRoot $proj
  $r6 = Invoke-DataRestore -Candidate $cand2 -ProjectRoot $proj -ServiceProbe $svcProbe -ServiceStop $svcStop -ServiceStart $svcStart -TestFailSwap
  Assert-True (-not [bool]$r6.Ok) '恢复报告失败'
  Assert-Equal $beforeRollback ([System.IO.File]::ReadAllText((Join-Path $dataDir 'eggs.json'))) '原来的 data/ 被放回去了'
  Assert-True (Test-Path -LiteralPath (Join-Path $dataDir 'eggs.json')) 'data/ 还在'

  Write-Case '恢复：预检不过时不动 data/'
  $script:SvcState = 'Free'
  $beforeBad = [System.IO.File]::ReadAllText((Join-Path $dataDir 'eggs.json'))
  $r7 = Invoke-MaintenanceRestore -ProjectRoot $proj -BackupPath $backupBroken -ServiceProbe $svcProbe -ServiceStop $svcStop -ServiceStart $svcStart
  Assert-True (-not [bool]$r7.Ok) '恢复被拒绝'
  Assert-Equal $beforeBad ([System.IO.File]::ReadAllText((Join-Path $dataDir 'eggs.json'))) 'data/ 一个字节都没变'

  Write-Case '拒绝未确认服务状态与无效备份结构'
  $script:SvcState = 'Unknown'
  $unknownResult = Invoke-MaintenanceBackup -ProjectRoot $proj -ServiceProbe $svcProbe -ServiceStop $svcStop -ServiceStart $svcStart
  Assert-True (-not $unknownResult.Ok) '未知服务状态拒绝维护'
  Assert-True (-not (Wait-RestoreServiceStopped -Probe { @{State='Unknown'} })) '未知状态不等于停稳'
  $otherBackup = Join-Path $work 'unrelated'
  Write-JsonFile (Join-Path $otherBackup 'settings.json') '{"theme":"light"}'
  Assert-True (-not (Get-RestoreCandidate -Path $otherBackup -ProjectRoot $proj).Ok) '无关 JSON 不能作为数据备份'
  $badStructure = Join-Path $work 'missing-array'
  Write-JsonFile (Join-Path $badStructure 'ideas.json') '{"schema_version":1}'
  Assert-True (-not (Get-RestoreCandidate -Path $badStructure -ProjectRoot $proj).Ok) '缺少板块数组不能覆盖当前数据'
  $script:SvcState = 'Free'
  Write-Case '直接恢复命令使用完整维护入口'
  $cliText = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $proj 'restore.ps1') -BackupPath $backupRoot -Yes 2>&1
  Assert-Equal 0 $LASTEXITCODE ('直接恢复命令成功：' + ($cliText -join ' '))

  Write-Case '收尾：真实服务没被碰过'
  $conns = @()
  try { $conns = @(Get-NetTCPConnection -LocalPort ([int]$env:PORT) -State Listen -ErrorAction Stop) } catch { $conns = @() }
  Assert-Equal 0 $conns.Count '测试用的端口上没有任何监听'

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
