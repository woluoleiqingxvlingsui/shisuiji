# 拾穗集 公共函数库 —— control.ps1（命令行）与 control-ui.ps1（图形窗口）共用
# 服务在本目录以隐藏窗口方式独立运行：关掉控制台/图形窗口都不会停服务。
# 启动时自动加载 local.env.ps1（口令等）以及目录下若存在的 HTTPS 证书。

$Base = $null
if ($PSScriptRoot) { $Base = $PSScriptRoot }
elseif ($MyInvocation.MyCommand.Path) { $Base = Split-Path -Parent $MyInvocation.MyCommand.Path }
else { $Base = (Get-Location).Path }

$AppCfg = $null
$Port = 8642
$Scheme = 'http'
$Url = "http://localhost:8642"
$PhoneUrl = $null
$Health = "http://127.0.0.1:8642/api/health"

function Get-AppConfig {
  $cfg = @{ port = 8642; host = '127.0.0.1'; token = '' }
  $cfgPath = Join-Path $Base 'config.json'
  if (Test-Path $cfgPath) {
    try {
      $parsed = Get-Content -Path $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $p = 0
      if ([int]::TryParse([string]$parsed.port, [ref]$p) -and $p -gt 0 -and $p -le 65535) { $cfg.port = $p }
      if ($parsed.host) { $cfg.host = ([string]$parsed.host).Trim() }
      if ($parsed.sync -and $parsed.sync.token) {
        $t = ([string]$parsed.sync.token).Trim()
        if ($t) { $cfg.token = $t }
      }
    } catch { }
  }
  try {
    $ep = 0
    if ($env:PORT -and [int]::TryParse([string]$env:PORT, [ref]$ep) -and $ep -gt 0 -and $ep -le 65535) {
      $cfg.port = $ep
    }
  } catch { }
  if ($env:DANJI_HOST) { $cfg.host = $env:DANJI_HOST }
  return $cfg
}

function Import-LocalEnv {
  $envFile = Join-Path $Base 'local.env.ps1'
  if (Test-Path $envFile) {
    try { . $envFile } catch { Write-Host ("local.env.ps1 加载失败: " + $_.Exception.Message) }
  }
  $cert = Join-Path $Base 'danji-cert.pem'
  $key  = Join-Path $Base 'danji-key.pem'
  if ((Test-Path $cert) -and (Test-Path $key)) {
    $env:DANJI_TLS_CERT = $cert
    $env:DANJI_TLS_KEY  = $key
  }
  return @{
    TokenConfigured = -not [string]::IsNullOrWhiteSpace((Get-EffectiveToken))
    TlsEnabled      = -not [string]::IsNullOrWhiteSpace($env:DANJI_TLS_CERT) -and (Test-Path $env:DANJI_TLS_CERT)
  }
}

# 与 server.js 读取优先级一致：config.json 的 sync.token 优先，环境变量 DANJI_TOKEN 回落
function Get-EffectiveToken {
  $t = (Get-AppConfig).token
  if (-not [string]::IsNullOrWhiteSpace($t)) { return $t }
  if ($env:DANJI_TOKEN) { return $env:DANJI_TOKEN }
  return ''
}

function Get-UseTls {
  $cert = $env:DANJI_TLS_CERT
  if (-not $cert) { $cert = Join-Path $Base 'danji-cert.pem' }
  $key = $env:DANJI_TLS_KEY
  if (-not $key) { $key = Join-Path $Base 'danji-key.pem' }
  return ((Test-Path $cert) -and (Test-Path $key))
}

function Get-LanIPv4 {
  try {
    $addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object {
        $_.IPAddress -notlike '127.*' -and
        $_.IPAddress -notlike '169.254.*' -and
        $_.IPAddress -notlike '192.168.56.*'
      }
    foreach ($a in $addrs) {
      $if = Get-NetIPInterface -InterfaceIndex $a.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($if -and $if.ConnectionState -eq 'Connected') { return $a.IPAddress }
    }
    if ($addrs) { return ($addrs | Select-Object -First 1).IPAddress }
  } catch { }
  return $null
}

# App 配对载荷（P10 / M4）：{"v":1,"base":"http://IP:port","token":"..."}
function Get-PairPayload {
  $scheme = if (Get-UseTls) { 'https' } else { 'http' }
  $ip = Get-LanIPv4
  if (-not $ip) {
    $ip = '127.0.0.1'
  }
  $cfg = Get-AppConfig
  $token = Get-EffectiveToken
  # 局部变量不能叫 $base：PowerShell 变量不分大小写且动态作用域，会遮蔽全局 $Base 目录
  $pairBase = "{0}://{1}:{2}" -f $scheme, $ip, $cfg.port
  $obj = [ordered]@{ v = 1; base = $pairBase; token = $token }
  return ($obj | ConvertTo-Json -Compress)
}

function Show-PairQr {
  $json = Get-PairPayload
  $qrScript = Join-Path $Base 'tools\print-pair-qr.mjs'
  if (Test-Path $qrScript) {
    $parsed = $json | ConvertFrom-Json
    & node $qrScript --base $parsed.base --token $parsed.token
  } else {
    Write-Host '----- 配对 JSON -----'
    Write-Host $json
    Write-Host '---------------------'
  }
  return $json
}

# 生成配对二维码 PNG，返回图片路径（失败返回 $null）。图形控制台用它在窗口里直接显示可扫码。
function New-PairQrPng {
  $json = Get-PairPayload
  $parsed = $json | ConvertFrom-Json
  $qrScript = Join-Path $Base 'tools\pair-qr-png.mjs'
  if (-not (Test-Path $qrScript)) { return $null }
  $out = Join-Path ([System.IO.Path]::GetTempPath()) ("danji-pair-{0}.png" -f ([Guid]::NewGuid().ToString('N')))
  try {
    $tokenArg = @()
    if ($parsed.token) { $tokenArg = @('--token', [string]$parsed.token) }
    & node $qrScript --base ([string]$parsed.base) @tokenArg --out $out 2>$null | Out-Null
    if ((Test-Path $out) -and ((Get-Item $out).Length -gt 0)) { return $out }
  } catch { }
  return $null
}

function Update-UrlFromEnv {
  if (Get-UseTls) { $Scheme = 'https' } else { $Scheme = 'http' }
  $Url = ("{0}://localhost:{1}" -f $Scheme, $Port)
  $lip = Get-LanIPv4
  if ($lip) { $PhoneUrl = ("{0}://{1}:{2}" -f $Scheme, $lip, $Port) }
  else { $PhoneUrl = $null }
  $Health = ("{0}://127.0.0.1:{1}/api/health" -f $Scheme, $Port)
  # 同步到脚本作用域，避免 UI 读到旧的 $Url
  $script:Scheme = $Scheme
  $script:Url = $Url
  $script:PhoneUrl = $PhoneUrl
  $script:Health = $Health
  $script:Port = $Port
}

# 探测 URI 是否 200。自签证书用 curl -k，避免 PowerShell 对 HTTPS 误判「服务未启动」
function Test-UriOk([string]$uri) {
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (Test-Path $curl) {
    & $curl -sk -m 2 -f -o NUL $uri 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  }
  try {
    $req = [System.Net.HttpWebRequest]::Create($uri)
    $req.Timeout = 1500
    $req.Method = 'GET'
    if ($uri.StartsWith('https')) {
      $req.ServerCertificateValidationCallback = { $true }
    }
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $resp.Close()
    return ($code -eq 200)
  } catch { return $false }
}

function Test-Up {
  Update-UrlFromEnv
  # HTTP / HTTPS 都探：只要有一个在服就算在跑
  $a = Test-UriOk ("http://127.0.0.1:{0}/api/health" -f $Port)
  if ($a) { $script:LiveScheme = 'http'; return $true }
  $b = Test-UriOk ("https://127.0.0.1:{0}/api/health" -f $Port)
  if ($b) { $script:LiveScheme = 'https'; return $true }
  $script:LiveScheme = $null
  return $false
}

# 仅凭 node.exe + 本项目 server.js 的准确绝对路径确认归属。
# 健康检查只能识别产品，不能证明属于当前目录；相对路径手动实例请在原窗口停止。

# 本项目 server.js 的绝对路径（作为识别标志）
function Get-ProjectServerPath {
  return (Join-Path $Base 'server.js')
}

# 路径归一化：统一分隔符与大小写，方便比较
function ConvertTo-PathKey([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return '' }
  return ($p.Trim().Trim('"').Replace('/', '\')).ToLowerInvariant()
}

# 取进程信息（命令行 / 可执行路径）。读不到返回 $null。
function Get-ProcessInfo([int]$ProcessId) {
  if ($ProcessId -le 0) { return $null }
  try {
    $p = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId={0}" -f $ProcessId) -ErrorAction Stop
  } catch { return $null }
  if (-not $p) { return $null }
  return $p
}

# 把命令行切成参数：引号内的内容算一个整体，路径里的空格不会被拆散
function Get-CmdArgs([string]$cmd) {
  $parts = @()
  if ([string]::IsNullOrWhiteSpace($cmd)) { return $parts }
  $cur = New-Object System.Text.StringBuilder
  $quote = [char]0
  foreach ($ch in $cmd.ToCharArray()) {
    if ($quote -ne [char]0) {
      if ($ch -eq $quote) { $quote = [char]0 } else { [void]$cur.Append($ch) }
    } elseif ($ch -eq '"' -or $ch -eq "'") {
      $quote = $ch
    } elseif ([char]::IsWhiteSpace($ch)) {
      if ($cur.Length -gt 0) { $parts += $cur.ToString(); $cur = New-Object System.Text.StringBuilder }
    } else {
      [void]$cur.Append($ch)
    }
  }
  if ($cur.Length -gt 0) { $parts += $cur.ToString() }
  return $parts
}

# 判断某个命令行参数是不是本项目的 server.js
function Test-CmdArgIsProjectServer([string]$arg, [string]$baseKey, [string]$serverKey) {
  if ([string]::IsNullOrWhiteSpace($arg)) { return $false }
  $t = (ConvertTo-PathKey $arg)
  return ($serverKey -and $t -eq $serverKey)
}

# 判定某个 PID 是否属于本项目的服务实例
# 返回：@{ Confirmed; Reason; Message; CommandLine; ProcessName }
function Test-ProjectServerProcess([int]$ProcessId) {
  $verdict = @{
    Confirmed   = $false
    Reason      = 'unknown'
    Message     = ''
    CommandLine = ''
    ProcessName = ''
  }
  $info = Get-ProcessInfo -ProcessId $ProcessId
  if (-not $info) {
    $verdict.Reason = 'unreadable'
    $verdict.Message = ("读不到 PID {0} 的命令行，无法确认它是否属于拾穗集。" -f $ProcessId)
    return $verdict
  }
  $verdict.CommandLine = [string]$info.CommandLine
  $verdict.ProcessName = [string]$info.Name

  $serverKey = (ConvertTo-PathKey (Get-ProjectServerPath))
  $cmdArgs = @(Get-CmdArgs $verdict.CommandLine)
  if ($verdict.ProcessName -match '^node(?:\.exe)?$' -and $cmdArgs.Count -ge 2 -and
      (Test-CmdArgIsProjectServer -arg $cmdArgs[1] -baseKey '' -serverKey $serverKey)) {
    $verdict.Confirmed = $true
    $verdict.Reason = 'cmd-server-path'
    return $verdict
  }

  $verdict.Reason = 'not-project'
  $verdict.Message = ("PID {0}（{1}）无法确认属于当前目录的拾穗集。相对路径启动的服务请在原终端停止。" -f $ProcessId, $verdict.ProcessName)
  return $verdict
}

# 端口占用情况：Free=没人监听 / Project=本项目服务 / Foreign=别的程序占用
function Get-PortOwner {
  $result = @{ State = 'Free'; Pid = $null; Verdict = $null }
  $conns = @()
  try {
    $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
  } catch {
    # 查询无匹配与查询被拒绝不同；无法查询时不能假称端口空闲。
    if ($_.FullyQualifiedErrorId -notmatch 'CmdletizationQuery_NotFound') {
      return @{ State = 'Unknown'; Pid = 0; Verdict = @{ Reason = 'query-failed'; ProcessName = '' } }
    }
  }
  if ($conns.Count -eq 0) { return $result }
  $seen = @{}
  foreach ($c in $conns) {
    $ownerPid = 0
    try { $ownerPid = [int]$c.OwningProcess } catch { $ownerPid = 0 }
    if ($ownerPid -le 0) { continue }
    if ($seen.ContainsKey($ownerPid)) { continue }
    $seen[$ownerPid] = $true
    $verdict = Test-ProjectServerProcess -ProcessId $ownerPid
    if ($verdict.Confirmed) {
      $result = @{ State = 'Project'; Pid = $ownerPid; Verdict = $verdict }
    } else {
      return @{ State = 'Foreign'; Pid = $ownerPid; Verdict = $verdict }
    }
  }
  return $result
}

# 端口被外来程序占用 / 无法确认归属时的中文说明
function Get-PortConflictMessage([int]$OwnerPid, $Verdict) {
  $reason = 'unknown'
  $name = ''
  if ($Verdict) {
    $reason = [string]$Verdict.Reason
    if ($Verdict.ProcessName) { $name = ("（{0}）" -f $Verdict.ProcessName) }
  }
  $head = ''
  if ($reason -eq 'unreadable') {
    $head = ("端口 {0} 被别的程序占用（PID {1}），但读不到它的命令行，没法确认是不是拾穗集。" -f $Port, $OwnerPid)
  } elseif ($reason -eq 'query-failed') {
    return ("无法查询端口 {0} 的进程归属，拾穗集不会启动或结束任何进程。请检查系统查询权限后重试。" -f $Port)
  } else {
    $head = ("端口 {0} 被程序占用（PID {1}{2}），无法证明属于当前项目。" -f $Port, $OwnerPid, $name)
  }
  $tail = "拾穗集不会去结束这个无关进程（免得误杀你正在用的软件）。"
  $tail += "可以这样处理：先关掉占用该端口的程序再重新启动拾穗集；"
  $tail += ("或者改 config.json 里的 port 换一个空闲端口；" )
  $tail += "手动以相对路径启动的实例请在原终端按 Ctrl+C 停止。"
  return ($head + $tail)
}

# 端口上跑的是不是拾穗集自己（探活 + 身份校验）
function Test-ServerIdentity {
  $owner = Get-PortOwner
  return ($owner.State -eq 'Project')
}

# 只返回「确认属于本项目」的服务 PID；端口被外来程序占用时返回 $null
function Get-ServerPid {
  $owner = Get-PortOwner
  if ($owner.State -eq 'Project') { return $owner.Pid }
  return $null
}

# 启动服务进程：用 server.js 的绝对路径当命令行标志，方便事后按命令行认出是自己人
function Start-ServerProcess {
  $serverPath = Get-ProjectServerPath
  if (-not (Test-Path $serverPath)) { return $false }
  $arg = '"' + $serverPath + '"'
  try {
    Start-Process -FilePath "node" -ArgumentList $arg -WorkingDirectory $Base -WindowStyle Hidden
  } catch { return $false }
  return $true
}

function Start-Server {
  $script:LastStartMessage = ''
  # 端口被别的程序占着：明确告知，绝不去结束它
  $owner = Get-PortOwner
  if ($owner.State -notin @('Free', 'Project')) {
    $script:LastStartMessage = Get-PortConflictMessage -OwnerPid $owner.Pid -Verdict $owner.Verdict
    return $false
  }
  if (Test-Up) {
    # 协议不对（有证书却在跑 HTTP）时提示由 UI 处理；这里只判断「在不在」
    return $true
  }
  $null = Import-LocalEnv
  Update-UrlFromEnv
  # 端口被占但健康检查不过：只有确认是拾穗集自己的进程才停（常见于 HTTP→HTTPS 切换）
  if ($owner.State -eq 'Project') {
    $null = Stop-Server
    Start-Sleep -Milliseconds 400
  }
  if (-not (Start-ServerProcess)) {
    $script:LastStartMessage = ("找不到 {0}，无法启动服务。" -f (Get-ProjectServerPath))
    return $false
  }
  for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Up) { return $true }
  }
  $script:LastStartMessage = ("服务启动超时：端口 {0} 上没有出现拾穗集的健康检查响应。" -f $Port)
  return $false
}

function Stop-Server {
  $script:LastStopMessage = ''
  $owner = Get-PortOwner
  if ($owner.State -eq 'Free') {
    $script:LastStopMessage = ("拾穗集当前没有在运行（端口 {0} 没有监听进程）。" -f $Port)
    return $false
  }
  if ($owner.State -ne 'Project') {
    # 不是拾穗集自己的进程（或无法确认）：拒绝结束，只给提示
    $script:LastStopMessage = Get-PortConflictMessage -OwnerPid $owner.Pid -Verdict $owner.Verdict
    return $false
  }
  try {
    Stop-Process -Id $owner.Pid -Force -ErrorAction Stop
  } catch {
    $script:LastStopMessage = ("停止拾穗集服务（PID {0}）失败：{1}" -f $owner.Pid, $_.Exception.Message)
    return $false
  }
  $script:LastStopMessage = ("拾穗集服务已停止（PID {0}）。" -f $owner.Pid)
  return $true
}

# 最近一次启动/停止的说明（供 CLI 与图形控制台展示）
$script:LastStopMessage  = ''
$script:LastStartMessage = ''
function Get-LastStopMessage  { return $script:LastStopMessage }
function Get-LastStartMessage { return $script:LastStartMessage }

# 初始化配置与地址
$AppCfg = Get-AppConfig
$Port   = $AppCfg.port
$null = Import-LocalEnv
Update-UrlFromEnv
