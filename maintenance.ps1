# 拾穗集 备份 / 恢复 的统一入口（图形控制台与命令行都用它）
#
# 用法（PowerShell）：
#   powershell -ExecutionPolicy Bypass -File maintenance.ps1 backup
#   powershell -ExecutionPolicy Bypass -File maintenance.ps1 backup -OutDir D:\备份
#   powershell -ExecutionPolicy Bypass -File maintenance.ps1 check  -BackupPath D:\备份\danji-xxx
#   powershell -ExecutionPolicy Bypass -File maintenance.ps1 restore -BackupPath D:\备份\danji-xxx
#   powershell -ExecutionPolicy Bypass -File maintenance.ps1 restore -BackupPath ... -Yes
#
# 备份：只暂停「确认属于本项目」的运行中服务 → 调 backup.ps1 做带校验的备份 → 原来在跑就再拉起来；
#       原来就是停的，备份完仍然停着。端口被别的程序占用（或查不到归属）时直接拒绝，不动无关进程。
# 恢复：先校验备份（结构 / 图片引用 / 链接 / 越界路径）→ 把当前 data/ 安全备份到 backups\
#       → 复制到暂存目录再校验 → 停服务 → 改名替换 data\ → 出错回滚 → 恢复服务原状态。
# 备份和恢复期间会拿着独占锁，别的一次启停操作插不进来。

param(
  [string]$Action = '',
  [string]$BackupPath = '',
  [string]$OutDir = '',
  [switch]$Yes
)

# dot-source 下面的脚本会覆盖同名参数，先存一份
$maintAction     = $Action
$maintBackupPath = $BackupPath
$maintOutDir     = $OutDir
$maintYes        = $Yes

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'restore.ps1')

$ErrorActionPreference = 'Stop'

function New-MaintenanceResult {
  return [ordered]@{
    Ok                = $false
    Message           = ''
    BackupPath        = ''
    SafetyBackupPath  = ''
    Files             = 0
    Bytes             = 0
    ServiceWasRunning = $false
    ServiceRestarted  = $false
    Candidate         = $null
    Errors            = @()
    Warnings          = @()
  }
}

function Invoke-MaintenanceBackupCore {
  param(
    [string]$ProjectRoot = '',
    [string]$OutDir = '',
    [scriptblock]$ServiceProbe = $null,
    [scriptblock]$ServiceStop = $null,
    [scriptblock]$ServiceStart = $null
  )
  $res = New-MaintenanceResult
  $state = & $ServiceProbe
  $stateName = [string]$state.State
  if ($stateName -notin @('Free','Project')) {
    $res.Message = '端口被别的程序占用（或查不到归属）。为了不误伤别的程序，备份已取消。'
    return $res
  }
  $wasRunning = ($stateName -eq 'Project')
  $res.ServiceWasRunning = $wasRunning
  $stopped = $false
  try {
    if ($wasRunning) {
      $stop = & $ServiceStop
      if (-not $stop.Ok) {
        $res.Message = ('停不下服务，备份已取消：' + $stop.Message)
        return $res
      }
      $stopped = $true
      if (-not (Wait-RestoreServiceStopped -Probe $ServiceProbe)) {
        $res.Message = '服务没有完全停下来，备份已取消（不复制正在运行的数据）。'
        return $res
      }
      $stopped = $true
    }
    $backupScript = Join-Path $ProjectRoot 'backup.ps1'
    if (-not (Test-Path -LiteralPath $backupScript -PathType Leaf)) {
      $res.Message = '没找到 backup.ps1（在项目根目录），备份没法做。'
      return $res
    }
    $callArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $backupScript)
    if ($OutDir) { $callArgs += @('-OutDir', $OutDir) }
    $callArgs += '-Json'
    $run = Invoke-NativeCapture -File 'powershell' -Arguments $callArgs
    $code = $run.Code
    $parsed = ConvertFrom-BackupOutput $run.Output
    if ($code -ne 0 -or -not $parsed -or -not $parsed.ok) {
      $res.Message = '备份没做成（复制或校验没过）；当前数据没有被改动。'
      return $res
    }
    $res.Ok = $true
    $res.BackupPath = [string]$parsed.path
    $res.Files = [int]$parsed.files
    $res.Bytes = [double]$parsed.bytes
    $res.Message = '备份完成。'
    return $res
  } finally {
    # 原来在跑就再拉起来；原来停着就让它继续停着
    if ($stopped -and $wasRunning) {
      $start = & $ServiceStart
      if ($start.Ok) { $res.ServiceRestarted = $true }
      else { $res.Message = $res.Message + '（服务没能自动重新启动：' + $start.Message + '）' }
    }
  }
}

function Invoke-MaintenanceBackup {
  param(
    [string]$ProjectRoot = '',
    [string]$OutDir = '',
    [scriptblock]$ServiceProbe = $null,
    [scriptblock]$ServiceStop = $null,
    [scriptblock]$ServiceStart = $null
  )
  $res = New-MaintenanceResult
  if (-not $ProjectRoot) { $ProjectRoot = $Base }
  if (-not $ServiceProbe) { $ServiceProbe = ${function:Get-MaintenanceServiceProbe} }
  if (-not $ServiceStop) { $ServiceStop = ${function:Stop-MaintenanceService} }
  if (-not $ServiceStart) { $ServiceStart = ${function:Start-MaintenanceService} }
  $lock = Enter-MaintenanceLock
  if (-not $lock) {
    $res.Message = '已经有备份或恢复在进行，请等它结束再试。'
    return $res
  }
  $global:DanjiMaintenanceOwned = $true
  try {
    $res = Invoke-MaintenanceBackupCore -ProjectRoot $ProjectRoot -OutDir $OutDir `
      -ServiceProbe $ServiceProbe -ServiceStop $ServiceStop -ServiceStart $ServiceStart
  } catch {
    $res = New-MaintenanceResult
    $res.Message = ('备份出错：' + $_.Exception.Message)
  } finally {
    $global:DanjiMaintenanceOwned = $false
    Exit-MaintenanceLock $lock
  }
  return $res
}

function Invoke-MaintenanceRestore {
  param(
    [string]$ProjectRoot = '',
    [string]$BackupPath = '',
    [scriptblock]$ServiceProbe = $null,
    [scriptblock]$ServiceStop = $null,
    [scriptblock]$ServiceStart = $null
  )
  $res = New-MaintenanceResult
  if (-not $ProjectRoot) { $ProjectRoot = $Base }
  if (-not $ServiceProbe) { $ServiceProbe = ${function:Get-MaintenanceServiceProbe} }
  if (-not $ServiceStop) { $ServiceStop = ${function:Stop-MaintenanceService} }
  if (-not $ServiceStart) { $ServiceStart = ${function:Start-MaintenanceService} }
  $lock = Enter-MaintenanceLock
  if (-not $lock) {
    $res.Message = '已经有备份或恢复在进行，请等它结束再试。'
    return $res
  }
  $global:DanjiMaintenanceOwned = $true
  try {
    $cand = Get-RestoreCandidate -Path $BackupPath -ProjectRoot $ProjectRoot
    $res.Candidate = $cand
    $res.Files = [int]$cand.Files
    $res.Bytes = [double]$cand.Bytes
    $res.Errors = @($cand.Errors)
    $res.Warnings = @($cand.Warnings)
    if (-not $cand.Ok) {
      $res.Message = '这份备份没通过校验，恢复已取消（当前数据没有任何改动）。'
      return $res
    }
    $r = Invoke-DataRestore -Candidate $cand -ProjectRoot $ProjectRoot `
      -ServiceProbe $ServiceProbe -ServiceStop $ServiceStop -ServiceStart $ServiceStart
    $res.Ok = [bool]$r.Ok
    $res.Message = [string]$r.Message
    $res.SafetyBackupPath = [string]$r.SafetyBackupPath
    $res.ServiceWasRunning = [bool]$r.ServiceWasRunning
    $res.ServiceRestarted = [bool]$r.ServiceRestarted
    return $res
  } catch {
    $res = New-MaintenanceResult
    $res.Message = ('恢复出错：' + $_.Exception.Message)
    return $res
  } finally {
    $global:DanjiMaintenanceOwned = $false
    Exit-MaintenanceLock $lock
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  if ($maintAction -eq 'backup') {
    $r = Invoke-MaintenanceBackup -ProjectRoot $Base -OutDir $maintOutDir
    if ($r.Ok) {
      Write-Host ''
      Write-Host ('备份完成 ✅  ' + $r.BackupPath) -ForegroundColor Green
      Write-Host ('  ' + $r.Files + ' 个文件')
      if ($r.ServiceWasRunning) { Write-Host '  备份前服务是运行着的，已经重新启动。' }
    } else {
      Write-Host ''
      Write-Host ('备份没做成：' + $r.Message) -ForegroundColor Red
    }
    if ($r.Ok) { exit 0 }
    exit 3
  }
  if ($maintAction -eq 'check') {
    $cand = Get-RestoreCandidate -Path $maintBackupPath -ProjectRoot $Base
    Write-RestoreSummary $cand
    foreach ($e in @($cand.Errors)) { Write-Host ('  · ' + $e) -ForegroundColor Red }
    if ($cand.Ok) { exit 0 }
    exit 1
  }
  if ($maintAction -eq 'restore') {
    $cand = Get-RestoreCandidate -Path $maintBackupPath -ProjectRoot $Base
    if (-not $cand.Ok) {
      Write-Host '这份备份不能用来恢复：' -ForegroundColor Red
      foreach ($e in @($cand.Errors)) { Write-Host ('  · ' + $e) -ForegroundColor Red }
      Write-Host '当前数据没有任何改动。' -ForegroundColor Yellow
      exit 1
    }
    Write-RestoreSummary $cand
    Write-Host '恢复会用这份备份覆盖当前的 data\（config.json、文献库、证书不受影响）。' -ForegroundColor Yellow
    if (-not $maintYes) {
      $ans = Read-Host '确认恢复请输入 yes'
      if ($ans -ne 'yes') {
        Write-Host '已取消，当前数据没有任何改动。' -ForegroundColor Yellow
        exit 1
      }
    }
    $r = Invoke-MaintenanceRestore -ProjectRoot $Base -BackupPath $maintBackupPath
    if ($r.Ok) {
      Write-Host ''
      Write-Host ('恢复完成 ✅  ' + $r.Message) -ForegroundColor Green
      if ($r.SafetyBackupPath) { Write-Host ('  恢复前的数据留了一份：' + $r.SafetyBackupPath) }
      exit 0
    }
    Write-Host ''
    Write-Host ('恢复没做成：' + $r.Message) -ForegroundColor Red
    exit 3
  }
  Write-Host '用法：maintenance.ps1 backup | restore | check  （-BackupPath / -OutDir / -Yes）' -ForegroundColor Yellow
  exit 1
}
