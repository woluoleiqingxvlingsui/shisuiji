# 一键创建/更新桌面「拾穗集」快捷方式 —— 指向图形控制台，全程无黑窗口
# 用法：右键"使用 PowerShell 运行"，或 powershell -File make-shortcut.ps1

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop '拾穗集.lnk'

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnkPath)
$sc.TargetPath       = Join-Path $base 'launch.vbs'
$sc.WorkingDirectory = $base
$sc.IconLocation     = Join-Path $base 'assets\icon.ico'
$sc.Description      = '拾穗集 · 赛博鸡蛋与文献（图形控制台启动）'
$sc.Save()

Write-Host "已在桌面创建/更新快捷方式：$lnkPath"
