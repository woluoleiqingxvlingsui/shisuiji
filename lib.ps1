# 拾穗集 公共函数库 —— control.ps1（命令行）与 control-ui.ps1（图形窗口）共用
# 服务在本目录以隐藏窗口方式独立运行：关掉控制台/图形窗口都不会停服务。

$Base   = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port   = 8642
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
