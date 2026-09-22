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
  $cfg = @{ port = 8642; host = '127.0.0.1' }
  $cfgPath = Join-Path $Base 'config.json'
  if (Test-Path $cfgPath) {
    try {
      $parsed = Get-Content -Path $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $p = 0
      if ([int]::TryParse([string]$parsed.port, [ref]$p) -and $p -gt 0 -and $p -le 65535) { $cfg.port = $p }
      if ($parsed.host) { $cfg.host = ([string]$parsed.host).Trim() }
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
    TokenConfigured = -not [string]::IsNullOrWhiteSpace($env:DANJI_TOKEN)
    TlsEnabled      = -not [string]::IsNullOrWhiteSpace($env:DANJI_TLS_CERT) -and (Test-Path $env:DANJI_TLS_CERT)
  }
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

function Get-ServerPid {
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.OwningProcess }
  return $null
}

function Start-Server {
  if (Test-Up) {
    # 协议不对（有证书却在跑 HTTP）时提示由 UI 处理；这里只判断「在不在」
    return $true
  }
  $null = Import-LocalEnv
  Update-UrlFromEnv
  # 端口被占但健康检查不过：先停掉残留进程，再启动（常见于 HTTP→HTTPS 切换）
  if (Get-ServerPid) {
    Stop-Server | Out-Null
    Start-Sleep -Milliseconds 400
  }
  Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $Base -WindowStyle Hidden
  for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Up) { return $true }
  }
  return $false
}

function Stop-Server {
  $srvPid = Get-ServerPid
  if ($null -eq $srvPid) { return $false }
  try { Stop-Process -Id $srvPid -Force -ErrorAction Stop } catch { }
  return $true
}

# 初始化配置与地址
$AppCfg = Get-AppConfig
$Port   = $AppCfg.port
$null = Import-LocalEnv
Update-UrlFromEnv
