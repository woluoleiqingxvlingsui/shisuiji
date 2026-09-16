# 拾穗集 公共函数库 —— control.ps1（命令行）与 control-ui.ps1（图形窗口）共用
# 服务在本目录以隐藏窗口方式独立运行：关掉控制台/图形窗口都不会停服务。

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

$AppCfg = Get-AppConfig
$Port   = $AppCfg.port
$Url    = "http://localhost:$Port"
$Health = "http://127.0.0.1:$Port/api/health"

function Test-Up {
  try {
    return ((Invoke-WebRequest -UseBasicParsing -Uri $Health -TimeoutSec 1).StatusCode -eq 200)
  } catch { return $false }
}

function Get-ServerPid {
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.OwningProcess }
  return $null
}

function Start-Server {
  if (Test-Up) { return $true }
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
