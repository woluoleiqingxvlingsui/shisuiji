# 拾穗集 公共函数库 —— control.ps1（命令行）与 control-ui.ps1（图形窗口）共用
# 服务在本目录以隐藏窗口方式独立运行：关掉控制台/图形窗口都不会停服务。
# 启动时自动加载 local.env.ps1（口令等）以及目录下若存在的 HTTPS 证书。

$Base   = Split-Path -Parent $MyInvocation.MyCommand.Path

# 与 server.js 共用根目录 config.json；优先级：环境变量 > config.json > 内置默认 8642
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

# 加载本地私密配置（gitignore）：DANJI_TOKEN / DANJI_HOST / TLS 证书路径
function Import-LocalEnv {
  $envFile = Join-Path $Base 'local.env.ps1'
  if (Test-Path $envFile) {
    try { . $envFile } catch { Write-Host "local.env.ps1 加载失败: $($_.Exception.Message)" }
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

$AppCfg = Get-AppConfig
$Port   = $AppCfg.port
$Scheme = 'http'
$Url    = "http://localhost:$Port"

function Update-UrlFromEnv {
  if (Get-UseTls) { $script:Scheme = 'https' } else { $script:Scheme = 'http' }
  $script:Url = "{0}://localhost:{1}" -f $script:Scheme, $Port
  $lip = Get-LanIPv4
  if ($lip) {
    $script:PhoneUrl = "{0}://{1}:{2}" -f $script:Scheme, $lip, $Port
  } else {
    $script:PhoneUrl = $null
  }
  $script:Health = "{0}://127.0.0.1:{1}/api/health" -f $script:Scheme, $Port
}

# 启动前先读一遍 env，便于控制台立刻显示地址
$null = Import-LocalEnv
Update-UrlFromEnv
$Health = $script:Health
$PhoneUrl = $script:PhoneUrl

function Test-Up {
  try {
    $uri = "{0}://127.0.0.1:{1}/api/health" -f $script:Scheme, $Port
    if ($script:Scheme -eq 'https') {
      # 自签证书：仅本机健康检查时跳过校验
      [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
      try {
        return ((Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 1).StatusCode -eq 200)
      } finally {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $null
      }
    }
    return ((Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 1).StatusCode -eq 200)
  } catch { return $false }
}

function Get-ServerPid {
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.OwningProcess }
  return $null
}

function Start-Server {
  if (Test-Up) { return $true }
  $null = Import-LocalEnv
  Update-UrlFromEnv
  Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $Base -WindowStyle Hidden
  for ($i = 0; $i -lt 20; $i++) {
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
