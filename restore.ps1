# 拾穗集 数据恢复 —— 从一份备份把 data/ 恢复回来
#
# 用法（PowerShell）：
#   powershell -ExecutionPolicy Bypass -File restore.ps1 -BackupPath D:\备份\danji-20260101-120000
#   powershell -ExecutionPolicy Bypass -File restore.ps1 -BackupPath D:\备份\danji-20260101-120000\data -Yes
#
# 恢复只动 data/：config.json、文献库、证书、签名材料一概不碰。
# 恢复流程：校验备份 → 把当前 data/ 安全备份到 backups\ → 复制到暂存目录再校验一次
#           → 停服务（只停确认属于本项目的）→ 用改名换名替换 data\
# 出错会把原来的 data\ 换回去；安全备份始终保留在 backups\ 里。
#
# 图形控制台点「📂 恢复备份」时走的是 maintenance.ps1（同一套逻辑 + 暂停/恢复服务）。

param([string]$BackupPath = '', [switch]$Yes, [switch]$Quiet)

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')

$ErrorActionPreference = 'Stop'

# 各板块 JSON 的结构约定：文件名 → 必须是数组的字段
$script:DataBoardSchema = @{
  'eggs.json'         = @('activities')
  'papers.json'       = @('papers')
  'messages.json'     = @('messages')
  'sites.json'        = @('sites')
  'expenses.json'     = @('expenses')
  'ideas.json'        = @('ideas')
  'achievements.json' = @('achievements')
  'kb.json'           = @('kb')
  'insights.json'     = @('verdicts')
  'trash.json'        = @('items')
}

function Test-PathInside {
  param([string]$Child = '', [string]$Parent = '')
  if ([string]::IsNullOrWhiteSpace($Child) -or [string]::IsNullOrWhiteSpace($Parent)) { return $false }
  $c = [IO.Path]::GetFullPath($Child).TrimEnd('\', '/')
  $p = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  if ($c.Equals($p, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  return $c.StartsWith($p + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

# 跑一个外部程序并把输出收下来。
# 注意：外部程序往 stderr 写东西时，2>&1 会把它变成错误流；$ErrorActionPreference='Stop'
# 会因此直接抛错，所以这里临时改成 Continue。
function Invoke-NativeCapture {
  param([string]$File = '', [string[]]$Arguments = @())
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $File @Arguments 2>&1
    $code = $LASTEXITCODE
    return @{ Code = $code; Output = @($out) }
  } finally {
    $ErrorActionPreference = $old
  }
}

function Get-RestoreSizeText([double]$Bytes) {
  if ($Bytes -lt 1KB) { return ('{0:N0} 字节' -f $Bytes) }
  if ($Bytes -lt 1MB) { return ('{0:N0} KB' -f ($Bytes / 1KB)) }
  return ('{0:N1} MB' -f ($Bytes / 1MB))
}

# 备份里被图片引用的 id（随记贴图、回收站里的贴图）
function Get-JsonImageIds($Obj, [string]$FileName) {
  $ids = @()
  try {
    if ($FileName -eq 'ideas.json' -and $Obj.ideas) {
      foreach ($item in @($Obj.ideas)) {
        if (-not $item) { continue }
        foreach ($im in @($item.images)) {
          if ($im -and $im.id) { $ids += ([string]$im.id) }
        }
      }
    }
    if ($FileName -eq 'trash.json' -and $Obj.items) {
      foreach ($item in @($Obj.items)) {
        if (-not $item) { continue }
        $payload = $item.payload
        if (-not $payload) { continue }
        foreach ($im in @($payload.images)) {
          if ($im -and $im.id) { $ids += ([string]$im.id) }
        }
      }
    }
  } catch { }
  return $ids
}

# 预检一份备份：结构、图片引用、链接/越界路径。结果里 Ok 为 $false 时绝对不能动 data/
function Get-RestoreCandidate {
  param([string]$Path = '', [string]$ProjectRoot = '')
  if (-not $ProjectRoot) { $ProjectRoot = $Base }
  $res = [ordered]@{
    Ok            = $false
    DataDir       = ''
    Files         = 0
    Bytes         = 0
    JsonFiles     = 0
    Boards        = @()
    ImageRefs     = 0
    MissingImages = @()
    Errors        = @()
    Warnings      = @()
    Oldest        = ''
    Newest        = ''
    Label         = ''
  }
  if ([string]::IsNullOrWhiteSpace($Path)) {
    $res.Errors += '没有选择备份目录。'
    return $res
  }
  $full = $null
  try { $full = [IO.Path]::GetFullPath($Path) } catch {
    $res.Errors += ('路径不合法：' + $Path)
    return $res
  }
  if (-not (Test-Path -LiteralPath $full)) {
    $res.Errors += ('找不到备份目录：' + $full)
    return $res
  }
  $item = Get-Item -LiteralPath $full -Force
  if (-not $item.PSIsContainer) {
    $res.Errors += '请选择备份文件夹（备份目录，或它里面的 data 文件夹）。'
    return $res
  }
  # 定位真正的数据目录：优先用里面的 data 子目录，否则就用它自己
  $dataDir = $null
  $inner = Join-Path $full 'data'
  if (Test-Path -LiteralPath $inner -PathType Container) { $dataDir = $inner }
  else { $dataDir = $full }
  $res.DataDir = $dataDir
  $res.Label = $dataDir

  # 不能拿当前 data/ 自己恢复，也不能拿包含当前 data/ 的目录恢复
  $liveData = Join-Path $ProjectRoot 'data'
  if (Test-PathInside -Child $dataDir -Parent $liveData) {
    $res.Errors += '备份源就在当前 data/ 里面，恢复会自己覆盖自己，已拒绝。'
    return $res
  }
  if (Test-PathInside -Child $liveData -Parent $dataDir) {
    $res.Errors += '备份源包含了当前的 data/ 目录，已拒绝（这会把整个项目当成备份）。'
    return $res
  }

  # 链接 / 重解析点 / 越界路径：一律拒绝
  try {
    $self = Get-Item -LiteralPath $dataDir -Force
    if ($self.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      $res.Errors += '备份目录本身是链接或重解析点，已拒绝。'
      return $res
    }
  } catch { }
  $ancestor = [IO.Path]::GetFullPath($dataDir)
  while ($ancestor) {
    if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      $res.Errors += '备份路径经过链接或重解析点，已拒绝。'; return $res
    }
    $parentPath = Split-Path -Parent $ancestor
    if ($parentPath -eq $ancestor) { break }
    $ancestor = $parentPath
  }
  $dirs = @()
  $files = @()
  try {
    $dirs  = @(Get-ChildItem -LiteralPath $dataDir -Recurse -Directory -Force -ErrorAction Stop)
    $files = @(Get-ChildItem -LiteralPath $dataDir -Recurse -File -Force -ErrorAction Stop)
  } catch {
    $res.Errors += ('读不了备份目录：' + $_.Exception.Message)
    return $res
  }
  foreach ($d in $dirs) {
    if ($d.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      $res.Errors += ('备份里有链接或重解析点，已拒绝：' + $d.FullName)
      return $res
    }
  }
  foreach ($f in $files) {
    if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      $res.Errors += ('备份里有链接或重解析点，已拒绝：' + $f.FullName)
      return $res
    }
    if (-not (Test-PathInside -Child $f.FullName -Parent $dataDir)) {
      $res.Errors += ('备份里有越界路径，已拒绝：' + $f.FullName)
      return $res
    }
  }

  $res.Files = $files.Count
  $total = 0
  foreach ($f in $files) { $total += $f.Length }
  $res.Bytes = [double]$total

  # JSON 结构 + 图片引用
  $imageDir = Join-Path $dataDir 'images'
  $ids = @()
  $knownBoards = 0
  $oldest = $null
  $newest = $null
  foreach ($f in $files) {
    if ($f.Extension -ne '.json') { continue }
    $res.JsonFiles++
    $res.Boards += $f.Name
    if ($null -eq $oldest -or $f.LastWriteTime -lt $oldest) { $oldest = $f.LastWriteTime }
    if ($null -eq $newest -or $f.LastWriteTime -gt $newest) { $newest = $f.LastWriteTime }
    $raw = $null
    try { $raw = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 } catch {
      $res.Errors += ('读不出文件：' + $f.Name)
      continue
    }
    $obj = $null
    try { $obj = $raw | ConvertFrom-Json } catch {
      $res.Errors += ('JSON 解析失败：' + $f.Name)
      continue
    }
    if ($null -eq $obj) {
      $res.Errors += ('JSON 是空的：' + $f.Name)
      continue
    }
    if ($obj -is [System.Array] -or $obj -isnot [pscustomobject]) {
      $res.Errors += ($f.Name + ' 必须是数据对象。'); continue
    }
    if ($script:DataBoardSchema.ContainsKey($f.Name) -and $f.DirectoryName -eq $dataDir.TrimEnd('\','/')) {
      $knownBoards++
      foreach ($key in $script:DataBoardSchema[$f.Name]) {
        $prop = $obj.PSObject.Properties[$key]
        if ($null -eq $prop) {
          $res.Errors += ($f.Name + ' 里缺少必需的 ' + $key + ' 数组。')
          continue
        }
        if ($null -eq $prop.Value) {
          $res.Errors += ($f.Name + ' 的 ' + $key + ' 不能是 null，必须是数组。')
          continue
        }
        if ($prop.Value -isnot [System.Array]) {
          $res.Errors += ($f.Name + ' 的 ' + $key + ' 不是数组，结构不对。')
        }
      }
    }
    foreach ($id in (Get-JsonImageIds -Obj $obj -FileName $f.Name)) { $ids += $id }
  }
  if ($knownBoards -eq 0) {
    $res.Errors += '这里没有找到板块数据文件（*.json），不像是一份拾穗集备份。'
    return $res
  }
  if ($oldest) { $res.Oldest = $oldest.ToString('yyyy-MM-dd HH:mm') }
  if ($newest) { $res.Newest = $newest.ToString('yyyy-MM-dd HH:mm') }
  $ids = @($ids | Select-Object -Unique)
  foreach ($id in $ids) {
    $res.ImageRefs++
    if ($id -notmatch '^[A-Za-z0-9_-]+$') { $res.Errors += '图片引用包含非法路径字符。'; continue }
    $found = $false
    if (Test-Path -LiteralPath $imageDir -PathType Container) {
      foreach ($ext in @('png', 'jpg', 'jpeg', 'gif', 'webp')) {
        if (Test-Path -LiteralPath (Join-Path $imageDir ($id + '.' + $ext)) -PathType Leaf) { $found = $true; break }
      }
    }
    if (-not $found) { $res.MissingImages += $id }
  }
  if ($res.MissingImages.Count -gt 0) {
    $res.Warnings += ('有 ' + $res.MissingImages.Count + ' 张贴图在备份里找不到对应文件（恢复后这几张图会显示不出来）。')
  }
  $res.Ok = ($res.Errors.Count -eq 0)
  return $res
}

# 等服务真正停下来（端口不再有人监听）
function Wait-RestoreServiceStopped {
  param([scriptblock]$Probe, [int]$TimeoutSeconds = 20)
  if (-not $Probe) { return $true }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $state = & $Probe
    if ([string]$state.State -eq 'Free') { return $true }
    if ([string]$state.State -ne 'Project') { return $false }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

function ConvertFrom-BackupOutput($Lines) {
  foreach ($line in @($Lines)) {
    $t = [string]$line
    $idx = $t.IndexOf('DANJI_BACKUP_JSON ')
    if ($idx -ge 0) {
      $json = $t.Substring($idx + 'DANJI_BACKUP_JSON '.Length)
      try { return ($json | ConvertFrom-Json) } catch { return $null }
    }
  }
  return $null
}

# 真正执行恢复（校验通过之后才调用）
function Invoke-DataRestore {
  param(
    $Candidate = $null,
    [string]$ProjectRoot = '',
    [scriptblock]$ServiceProbe = $null,
    [scriptblock]$ServiceStop = $null,
    [scriptblock]$ServiceStart = $null,
    [switch]$SkipServiceControl,
    [switch]$TestFailSwap
  )
  $res = [ordered]@{
    Ok                 = $false
    Message            = ''
    SafetyBackupPath   = ''
    Files              = 0
    Bytes              = 0
    ServiceWasRunning  = $false
    ServiceRestarted   = $false
  }
  if (-not $ProjectRoot) { $ProjectRoot = $Base }
  if (-not $ServiceProbe) { $ServiceProbe = ${function:Get-MaintenanceServiceProbe} }
  if (-not $ServiceStop) { $ServiceStop = ${function:Stop-MaintenanceService} }
  if (-not $ServiceStart) { $ServiceStart = ${function:Start-MaintenanceService} }
  if (-not $Candidate -or -not $Candidate.Ok) {
    $res.Message = '备份没通过校验，恢复已取消（当前数据没有任何改动）。'
    return $res
  }
  $liveData   = Join-Path $ProjectRoot 'data'
  $backupDir  = Join-Path $ProjectRoot 'backups'
  $stageRoot  = Join-Path (Join-Path $ProjectRoot 'tmp') ('restore-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  $stageData  = Join-Path $stageRoot 'data'
  $oldData    = Join-Path $stageRoot 'data-old'
  $movedOld   = $false
  $swapped    = $false
  $serviceStopped = $false
  $res.Files  = [int]$Candidate.Files
  $res.Bytes  = [double]$Candidate.Bytes

  $projectFull = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\') + '\'
  foreach ($target in @($liveData,$stageRoot,$stageData,$oldData,$backupDir)) {
    if (-not [IO.Path]::GetFullPath($target).StartsWith($projectFull,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe restore target' }
  }
  if ((Test-Path -LiteralPath $liveData) -and ((Get-Item -LiteralPath $liveData -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Current data is a link; restore refused' }
  try {
    # 1. 服务：只停确认属于本项目的
    if (-not $SkipServiceControl) {
      $state = & $ServiceProbe
      $stateName = [string]$state.State
      if ($stateName -notin @('Free','Project')) {
        $res.Message = '端口被别的程序占用（或查不到归属）。为了不误伤别的程序，恢复已取消；当前数据没有任何改动。'
        return $res
      }
      $res.ServiceWasRunning = ($stateName -eq 'Project')
      if ($res.ServiceWasRunning) {
        $stop = & $ServiceStop
        if (-not $stop.Ok) {
          $res.Message = ('停不下服务，恢复已取消：' + $stop.Message)
          return $res
        }
        $serviceStopped = $true
        if (-not (Wait-RestoreServiceStopped -Probe $ServiceProbe)) {
          $res.Message = '服务没有完全停下来，恢复已取消（不替换正在使用的数据）。'
          return $res
        }
      }
    }

    # 2. 安全备份：把当前 data/ 先备份到独立的 backups/
    if (Test-Path -LiteralPath $liveData) {
      $backupScript = Join-Path $ProjectRoot 'backup.ps1'
      if (-not (Test-Path -LiteralPath $backupScript -PathType Leaf)) {
        $res.Message = '没找到 backup.ps1，做不了安全备份，恢复已取消（当前数据没有任何改动）。'
        return $res
      }
      New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
      $run = Invoke-NativeCapture -File 'powershell' -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $backupScript, '-OutDir', $backupDir, '-Json')
      $code = $run.Code
      $parsed = ConvertFrom-BackupOutput $run.Output
      if ($code -ne 0 -or -not $parsed -or -not $parsed.ok) {
        $res.Message = '当前数据的安全备份没成功，恢复已取消（当前数据没有任何改动）。'
        return $res
      }
      $res.SafetyBackupPath = [string]$parsed.path
    }

    # 3. 复制到暂存目录并再校验一次
    New-Item -ItemType Directory -Path $stageData -Force | Out-Null
    Get-ChildItem -LiteralPath $Candidate.DataDir -Force | Copy-Item -Destination $stageData -Recurse -Force
    $staged = Get-RestoreCandidate -Path $stageData -ProjectRoot $ProjectRoot
    if (-not $staged.Ok) {
      $res.Message = ('暂存副本没通过校验，恢复已取消（当前数据没有任何改动）：' + (($staged.Errors) -join '；'))
      return $res
    }

    $sourceFiles = @(Get-ChildItem -LiteralPath $Candidate.DataDir -Recurse -File -Force)
    $stagedFiles = @(Get-ChildItem -LiteralPath $stageData -Recurse -File -Force)
    if ($sourceFiles.Count -ne $stagedFiles.Count) { throw '暂存文件数量不一致' }
    foreach ($sourceFile in $sourceFiles) {
      $relativeFile = $sourceFile.FullName.Substring($Candidate.DataDir.TrimEnd('\','/').Length).TrimStart('\','/')
      $targetFile = Join-Path $stageData $relativeFile
      if ((Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash) { throw '暂存内容校验失败' }
    }
    # 4. 停好服务后用改名替换 data\
    if (Test-Path -LiteralPath $liveData) {
      Move-Item -LiteralPath $liveData -Destination $oldData -ErrorAction Stop
      $movedOld = $true
    }
    if ($TestFailSwap) { throw '自检：模拟换名失败' }
    Move-Item -LiteralPath $stageData -Destination $liveData -ErrorAction Stop
    $swapped = $true
    $res.Ok = $true
    $res.Message = '恢复完成。'
  } catch {
    $res.Ok = $false
    $res.Message = ('恢复出错：' + $_.Exception.Message)
  } finally {
    # 出错就把原来的 data\ 换回去
    if ($movedOld -and (-not $swapped)) {
      try {
        Move-Item -LiteralPath $oldData -Destination $liveData -ErrorAction Stop
        $movedOld = $false
        $res.Message = $res.Message + '（原来的数据已经放回去了。）'
      } catch {
        $res.Message = $res.Message + '（原来的数据没能自动放回去，请从 backups\ 里找回。）'
      }
    }
    # 清理暂存目录
    try {
      if ((-not $movedOld -or $swapped) -and (Test-Path -LiteralPath $stageRoot)) { Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue }
    } catch { }
    # 恢复服务原来的运行状态
    if ($serviceStopped -and $res.ServiceWasRunning -and (-not $SkipServiceControl) -and (-not $movedOld -or $swapped)) {
      $start = & $ServiceStart
      if ($start.Ok) { $res.ServiceRestarted = $true }
      else { $res.Message = $res.Message + '（服务没能自动重新启动：' + $start.Message + '）' }
    }
  }
  return $res
}

function Write-RestoreSummary($Candidate) {
  Write-Host ''
  Write-Host '这份备份里有什么：' -ForegroundColor Cyan
  Write-Host ('  位置：' + $Candidate.DataDir)
  Write-Host ('  文件：' + $Candidate.Files + ' 个 · ' + (Get-RestoreSizeText $Candidate.Bytes))
  Write-Host ('  板块：' + ((@($Candidate.Boards) | Sort-Object) -join '、'))
  if ($Candidate.Oldest -and $Candidate.Newest) {
    Write-Host ('  数据时间：' + $Candidate.Oldest + ' ~ ' + $Candidate.Newest)
  }
  Write-Host ('  贴图引用：' + $Candidate.ImageRefs + ' 张')
  foreach ($w in @($Candidate.Warnings)) { Write-Host ('  提醒：' + $w) -ForegroundColor Yellow }
  Write-Host ''
}

function Invoke-RestoreCli {
  param([string]$Path = '', [switch]$AssumedYes)
  $cand = Get-RestoreCandidate -Path $Path -ProjectRoot $Base
  if (-not $cand.Ok) {
    Write-Host '这份备份不能用来恢复：' -ForegroundColor Red
    foreach ($e in @($cand.Errors)) { Write-Host ('  · ' + $e) -ForegroundColor Red }
    Write-Host '当前数据没有任何改动。' -ForegroundColor Yellow
    return 1
  }
  Write-RestoreSummary $cand
  Write-Host '恢复会用这份备份覆盖当前的 data\（config.json、文献库、证书不受影响）。' -ForegroundColor Yellow
  if (-not $AssumedYes) {
    $ans = Read-Host '确认恢复请输入 yes'
    if ($ans -ne 'yes') {
      Write-Host '已取消，当前数据没有任何改动。' -ForegroundColor Yellow
      return 1
    }
  }
  $r = Invoke-DataRestore -Candidate $cand -ProjectRoot $Base
  if ($r.Ok) {
    Write-Host ''
    Write-Host ('恢复完成 ✅  ' + $r.Message) -ForegroundColor Green
    if ($r.SafetyBackupPath) { Write-Host ('  恢复前的数据留了一份：' + $r.SafetyBackupPath) }
  } else {
    Write-Host ''
    Write-Host ('恢复没做成：' + $r.Message) -ForegroundColor Red
  }
  if ($r.Ok) { return 0 }
  return 3
}

if ($MyInvocation.InvocationName -ne '.') {
  $invokeArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'maintenance.ps1'),'restore','-BackupPath',$BackupPath)
  if ($Yes) { $invokeArgs += '-Yes' }
  & powershell @invokeArgs
  exit $LASTEXITCODE
}
