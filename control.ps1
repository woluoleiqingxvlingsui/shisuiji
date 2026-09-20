# 拾穗集 控制台（命令行 + 后备按键菜单）
# 双击 start.bat / 桌面快捷方式现在默认打开图形窗口（control-ui.ps1），不会进到这里。
# 命令行用法保留：powershell -File control.ps1 start|stop|status
# 启动时会自动加载 local.env.ps1（口令）与 HTTPS 证书（若存在）。
param([string]$Action = "")

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')

function Show-Menu {
  while ($true) {
    Clear-Host
    Write-Host "============================================"
    Write-Host "  拾穗集 控制台  -  $Url"
    Write-Host "============================================"
    if ($PhoneUrl) { Write-Host "  手机地址：$PhoneUrl" }
    if ($env:DANJI_TOKEN) { Write-Host "  口令：已从 local.env.ps1 加载" -ForegroundColor DarkGray }
    $srvPid = Get-ServerPid
    if ($null -eq $srvPid) {
      Write-Host "  服务状态：未运行" -ForegroundColor Yellow
    } else {
      Write-Host "  服务状态：后台运行中 (PID $srvPid)" -ForegroundColor Green
    }
    Write-Host "  关掉本窗口 / 按 Q 退出，都不影响后台服务"
    Write-Host ""
    Write-Host "  [O] 打开网页"
    Write-Host "  [S] 停止服务"
    Write-Host "  [Q] 退出控制台（服务继续运行）"
    Write-Host ""
    try { $key = [Console]::ReadKey($true).Key } catch { return }
    switch ($key) {
      'O' { Start-Process $Url }
      'S' {
        if (Stop-Server) {
          Write-Host "`n  拾穗集已停止，后台服务已关闭。" -ForegroundColor Green
        } else {
          Write-Host "`n  拾穗集当前没有在运行。" -ForegroundColor Yellow
        }
        Start-Sleep -Seconds 2
        return
      }
      'Q' { return }
    }
  }
}

Set-Location $Base

switch ($Action.ToLower()) {
  "start" {
    if (Start-Server) {
      Write-Host "shisuiji is up at $Url"
      if ($PhoneUrl) { Write-Host "phone: $PhoneUrl" }
      if ($env:DANJI_TOKEN) { Write-Host "token: loaded from local.env.ps1" }
      if (Get-UseTls) { Write-Host "tls: https" }
    } else {
      Write-Host "shisuiji failed to start"
      exit 1
    }
  }
  "stop" {
    if (Stop-Server) { Write-Host "shisuiji stopped" } else { Write-Host "shisuiji is not running"; exit 1 }
  }
  "status" {
    if ($null -ne (Get-ServerPid)) { Write-Host "running" } else { Write-Host "stopped" }
  }
  default {
    $Host.UI.RawUI.WindowTitle = "拾穗集 控制台"
    if (-not (Test-Up)) {
      Write-Host "正在启动拾穗集后台服务…"
      if (-not (Start-Server)) {
        Write-Host ""
        Write-Host "启动失败了。请在本文件夹运行  node server.js  查看具体报错。" -ForegroundColor Red
        Read-Host "按回车关闭"
        exit 1
      }
      Start-Process $Url
    }
    Show-Menu
  }
}
