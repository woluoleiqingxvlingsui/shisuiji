# 拾穗集 图形控制台 —— 双击桌面快捷方式 / start.bat / launch.vbs 打开的就是这个窗口
# 深色卡片风：状态灯每 2 秒自动刷新；纯按钮操作；关闭窗口不影响后台服务。
# 启动会自动加载 local.env.ps1（口令）与目录下 HTTPS 证书（若有）。
#
# 界面线程原则：探活（curl）、端口归属（Get-NetTCPConnection + CIM，约 1.5 秒）、
# 备份、生成二维码这些耗时动作一律放到后台运行空间里跑，界面线程只负责取结果画界面。
# 否则窗口会每隔 2 秒卡住 1~2 秒（点不动、像"未响应"），启动时更要等好几秒才出窗口。
. (Join-Path $PSScriptRoot 'first-run.ps1')
if (-not (Show-FirstRunSetup -ProjectRoot $PSScriptRoot)) { exit }
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$ErrorActionPreference = 'Stop'

$script:LaunchPending   = $false
$script:StartAt         = $null
$script:AutoOpenPending = $false
$script:AutoStartTried  = $false
$script:EnvInfo         = Import-LocalEnv
# 最近一条要告诉用户的提示（停止失败 / 端口被占等），短时间内在状态栏里保留
$script:LastNotice      = $null
# 最近一次后台探活结果（界面线程只读它，不再自己去查端口）
$script:Probe           = $null
$script:LastProbeAt     = $null
# 后台长任务：backup / qr
$script:TaskKind        = $null
$script:LibPath         = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')
$script:MaintPath       = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'maintenance.ps1')
$script:RestorePath     = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'restore.ps1')
$script:PendingRestore  = ''
$script:ProbeWorker     = New-BackgroundWorker
$script:TaskWorker      = New-BackgroundWorker

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="拾穗集 控制台" Width="460" SizeToContent="Height"
        WindowStartupLocation="CenterScreen" ResizeMode="CanMinimize"
        Background="#17191F" FontFamily="Microsoft YaHei UI" FontSize="13">
  <Window.Resources>
    <Style x:Key="Card" TargetType="Border">
      <Setter Property="Background" Value="#22252E"/>
      <Setter Property="CornerRadius" Value="14"/>
      <Setter Property="Padding" Value="18"/>
    </Style>
    <Style x:Key="BtnBase" TargetType="Button">
      <Setter Property="FontSize" Value="14"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Foreground" Value="White"/>
      <Setter Property="Background" Value="#2C303B"/>
      <Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Margin" Value="0"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border Background="{TemplateBinding Background}" CornerRadius="10" Padding="0,11">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter Property="Opacity" Value="0.85"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter Property="Opacity" Value="0.35"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <StackPanel Margin="22,18,22,20">
    <TextBlock Text="🧺 拾穗集" FontSize="20" FontWeight="Bold" Foreground="#F2F4F8"/>
    <TextBlock Text="赛博鸡蛋 &amp; 文献 · 本地服务控制" FontSize="12" Foreground="#8B93A5" Margin="1,4,0,14"/>

    <Border Style="{StaticResource Card}">
      <StackPanel>
        <StackPanel Orientation="Horizontal">
          <Ellipse x:Name="Dot" Width="11" Height="11" Fill="#FF5C5C" VerticalAlignment="Center" Margin="0,0,9,1"/>
          <TextBlock x:Name="StatusText" Text="正在检查服务状态…" FontSize="15" FontWeight="SemiBold"
                     Foreground="#F2F4F8" VerticalAlignment="Center"/>
        </StackPanel>
        <TextBlock x:Name="StatusDetail" Text="" FontSize="12" Foreground="#8B93A5" Margin="20,7,0,0" TextWrapping="Wrap"/>
        <TextBlock x:Name="ProtocolText" Text="" FontSize="12" Foreground="#9AA3B5" Margin="20,6,0,0" TextWrapping="Wrap"/>
        <TextBlock x:Name="EnvText" Text="" FontSize="11.5" Foreground="#667084" Margin="20,6,0,0" TextWrapping="Wrap"/>
      </StackPanel>
    </Border>

    <Button x:Name="BtnOpen" Content="🚀 打开网页（电脑）" Style="{StaticResource BtnBase}" Background="#4D6BFE" Margin="0,14,0,0"/>
    <Grid Margin="0,14,0,0">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="10"/>
        <ColumnDefinition Width="*"/>
      </Grid.ColumnDefinitions>
      <Button x:Name="BtnPairQr" Grid.Column="0" Content="🔗 配对码（App 扫码）" Style="{StaticResource BtnBase}"/>
      <Button x:Name="BtnBackup" Grid.Column="2" Content="💾 备份数据" Style="{StaticResource BtnBase}"/>
    </Grid>
    <Grid>
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="10"/>
        <ColumnDefinition Width="*"/>
      </Grid.ColumnDefinitions>
      <Button x:Name="BtnRestore" Grid.Column="0" Content="📂 恢复备份" Style="{StaticResource BtnBase}" Margin="0,10,0,0"/>
      <Button x:Name="BtnStop"  Grid.Column="2" Content="⏹ 停止服务" Style="{StaticResource BtnBase}" Margin="0,10,0,0"/>
    </Grid>
    <Grid>
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="10"/>
        <ColumnDefinition Width="*"/>
      </Grid.ColumnDefinitions>
      <Button x:Name="BtnStart" Grid.Column="0" Content="▶ 启动服务" Style="{StaticResource BtnBase}" Margin="0,10,0,0"/>
      <Button x:Name="BtnHttp"  Grid.Column="2" Content="🌐 以 HTTP 启动（App 配对）" Style="{StaticResource BtnBase}" Margin="0,10,0,0"/>
    </Grid>
    <Button x:Name="BtnAuto" Content="🔁 协议改回自动（有证书就用 HTTPS）" Style="{StaticResource BtnBase}" Margin="0,10,0,0"/>

    <TextBlock Text="启动时自动加载 local.env.ps1 口令；若目录有 danji-cert.pem / danji-key.pem 则走 HTTPS。关闭窗口不停服务。"
               FontSize="11.5" Foreground="#667084" Margin="2,16,0,0" TextWrapping="Wrap"/>
    <TextBlock Text="手机 App 不接受自签 HTTPS 证书：扫码配对请用「以 HTTP 启动」。备份会先暂停服务，备份完自动恢复运行。"
               FontSize="11.5" Foreground="#667084" Margin="2,6,0,0" TextWrapping="Wrap"/>
  </StackPanel>
</Window>
'@

function ColorBrush([string]$hex) {
  New-Object Windows.Media.SolidColorBrush ([Windows.Media.ColorConverter]::ConvertFromString($hex))
}

$win          = [Windows.Markup.XamlReader]::Parse($xaml)
$dot          = $win.FindName('Dot')
$statusText   = $win.FindName('StatusText')
$statusDetail = $win.FindName('StatusDetail')
$protocolText = $win.FindName('ProtocolText')
$envText      = $win.FindName('EnvText')
$btnOpen      = $win.FindName('BtnOpen')
$btnPairQr    = $win.FindName('BtnPairQr')
$btnBackup    = $win.FindName('BtnBackup')
$btnRestore   = $win.FindName('BtnRestore')
$btnStart     = $win.FindName('BtnStart')
$btnStop      = $win.FindName('BtnStop')
$btnHttp      = $win.FindName('BtnHttp')
$btnAuto      = $win.FindName('BtnAuto')

# ---- 后台脚本（在独立运行空间里跑，界面线程不参与） ----

# 探活：健康检查 + 端口归属 + 地址信息
$script:ProbeScript = {
  param($libPath)
  . $libPath
  $up = $false
  try { $up = Test-Up } catch { }
  $live = ''
  try { if ($script:LiveScheme) { $live = [string]$script:LiveScheme } } catch { }
  $owner = @{ State = 'Unknown'; Pid = $null; Verdict = $null }
  try { $owner = Get-PortOwner } catch { }
  $pref = 'auto'
  try { $pref = [string](Get-DanjiSchemePreference -ProjectRoot $Base) } catch { }
  $want = ''
  try { $want = [string](Get-DanjiEffectiveScheme) } catch { }
  $runtimeLabel = '没找到 Node 运行时'
  try {
    $rt = Get-DanjiRuntime -ProjectRoot $Base
    if ($rt) { if ($rt.Bundled) { $runtimeLabel = '随包自带 Node' } else { $runtimeLabel = '系统 Node' } }
  } catch { }
  [pscustomobject]@{
    Up              = [bool]$up
    LiveScheme      = $live
    OwnerState      = [string]$owner.State
    OwnerPid        = $owner.Pid
    Verdict         = $owner.Verdict
    Url             = [string]$Url
    Scheme          = [string]$Scheme
    Want            = $want
    Pref            = $pref
    Runtime         = $runtimeLabel
    Port            = [int]$Port
    TokenConfigured = [bool](Get-EffectiveToken)
    TlsEnabled      = [bool](Get-UseTls)
  }
}

# 备份：交给 maintenance.ps1 —— 先暂停确认属于本项目的服务，备份完再恢复运行
$script:BackupScript = {
  param($libPath, $maintPath, $projectRoot)
  . $libPath
  . $maintPath
  $r = Invoke-MaintenanceBackup -ProjectRoot $projectRoot
  [pscustomobject]@{
    Ok         = [bool]$r.Ok
    Message    = [string]$r.Message
    Path       = [string]$r.BackupPath
    Files      = [int]$r.Files
    WasRunning = [bool]$r.ServiceWasRunning
    Restarted  = [bool]$r.ServiceRestarted
  }
}

# 恢复前：先检查这份备份能不能用（结构 / 图片 / 链接 / 越界路径）
$script:RestoreCheckScript = {
  param($libPath, $restorePath, $projectRoot, $backupDir)
  . $libPath
  . $restorePath
  $c = Get-RestoreCandidate -Path $backupDir -ProjectRoot $projectRoot
  [pscustomobject]@{
    Ok        = [bool]$c.Ok
    DataDir   = [string]$c.DataDir
    Files     = [int]$c.Files
    Bytes     = [double]$c.Bytes
    Boards    = @($c.Boards)
    ImageRefs = [int]$c.ImageRefs
    Missing   = @($c.MissingImages)
    Errors    = @($c.Errors)
    Warnings  = @($c.Warnings)
    Oldest    = [string]$c.Oldest
    Newest    = [string]$c.Newest
  }
}

# 恢复：停服务 → 安全备份 → 暂存校验 → 换名替换 → 出错回滚 → 恢复服务原状态
$script:RestoreApplyScript = {
  param($libPath, $maintPath, $projectRoot, $backupDir)
  . $libPath
  . $maintPath
  $r = Invoke-MaintenanceRestore -ProjectRoot $projectRoot -BackupPath $backupDir
  [pscustomobject]@{
    Ok         = [bool]$r.Ok
    Message    = [string]$r.Message
    Safety     = [string]$r.SafetyBackupPath
    WasRunning = [bool]$r.ServiceWasRunning
    Restarted  = [bool]$r.ServiceRestarted
  }
}

# 切换协议（http / auto）：先停掉确认属于本项目的服务，再改设置并重新启动
$script:SchemeScript = {
  param($libPath, $projectRoot, $target)
  . $libPath
  $out = [ordered]@{ Ok = $false; Message = ''; Started = $false }
  $owner = @{ State = 'Unknown'; Pid = $null; Verdict = $null }
  try { $owner = Get-PortOwner } catch { }
  if ($owner.State -notin @('Free', 'Project')) {
    $out.Message = Get-PortConflictMessage -OwnerPid $owner.Pid -Verdict $owner.Verdict
    return [pscustomobject]$out
  }
  if ($owner.State -eq 'Project') {
    $stopped = $false
    try { $stopped = Stop-Server } catch { $stopped = $false }
    if (-not $stopped) {
      $out.Message = [string](Get-LastStopMessage)
      return [pscustomobject]$out
    }
  }
  try {
    $null = Set-DanjiSchemePreference -Scheme $target -ProjectRoot $projectRoot
  } catch {
    $out.Message = ('没能保存协议设置：' + $_.Exception.Message)
    return [pscustomobject]$out
  }
  $started = $false
  try { $started = Start-Server } catch { $started = $false }
  if ($started) {
    $out.Ok = $true
    $out.Started = $true
    $out.Message = '已经按新协议启动服务。'
  } else {
    $out.Message = [string](Get-LastStartMessage)
  }
  return [pscustomobject]$out
}

# 配对码：生成载荷与二维码 PNG（失败时退回终端 ASCII 码）
$script:QrScript = {
  param($libPath)
  . $libPath
  # 先探一次活：服务在跑就用它真实的协议，二维码才不会和服务对不上
  try { $null = Test-Up } catch { }
  $json = Get-PairPayload
  $png = $null
  try { $png = New-PairQrPng } catch { $png = $null }
  $ascii = ''
  if (-not $png) {
    try {
      $qrScript = Join-Path $Base 'tools\print-pair-qr.mjs'
      $nodeExe = Get-DanjiNodePath -ProjectRoot $Base
      if ((Test-Path $qrScript) -and $nodeExe) {
        $parsed = $json | ConvertFrom-Json
        $ascii = [string]((& $nodeExe $qrScript --base $parsed.base --token $parsed.token) -join "`n")
      }
    } catch { $ascii = '' }
  }
  [pscustomobject]@{ Json = [string]$json; Png = [string]$png; Ascii = [string]$ascii }
}

# 停止服务：整个动作（含端口归属的实时身份核实）放到后台线程，避免界面卡住
$script:StopScript = {
  param($libPath)
  . $libPath
  $ok = $false
  try { $ok = Stop-Server } catch { }
  [pscustomobject]@{ Ok = [bool]$ok; Message = [string](Get-LastStopMessage) }
}

function Refresh-AddressLabels {
  # 只读已经探好的结果，不再在界面线程上做端口/网卡查询
  if ($script:Probe) {
    $tok = if ($script:Probe.TokenConfigured) { "口令已配置（config.json 或 local.env.ps1）" } else { "未配置口令（建议 config.json 设置 sync.token）" }
    $rt  = [string]$script:Probe.Runtime
    $envText.Text = "$tok · $rt"
    return
  }
  $tok = if (Get-EffectiveToken) { "口令已配置（config.json 或 local.env.ps1）" } else { "未配置口令（建议 config.json 设置 sync.token）" }
  $rt = '没找到 Node 运行时'
  try {
    $r = Get-DanjiRuntime -ProjectRoot $Base
    if ($r) { if ($r.Bundled) { $rt = '随包自带 Node' } else { $rt = '系统 Node' } }
  } catch { }
  $envText.Text = "$tok · $rt"
}

# 协议那一行：显示正在跑的实例实际用什么协议，并提醒和设置不一致
function Get-ProtocolLine([string]$Live, [string]$Want) {
  if (-not $Live) { return '' }
  if ($Live -eq 'https') {
    $t = '当前协议：HTTPS · 自签证书，手机 App 不接受（扫码配对请用 HTTP）'
  } else {
    $t = '当前协议：HTTP · 手机 App 可直接扫码配对'
  }
  if ($Want -and $Want -ne $Live) {
    $t = $t + "`n设置里的协议是 " + $Want + "，和正在跑的实例不一致；想换过来请先停止服务再启动。"
  }
  return $t
}

function Test-MaintenanceTaskBusy {
  return ($script:TaskKind -eq 'start' -or $script:TaskKind -eq 'backup' -or $script:TaskKind -eq 'restore-check' -or
          $script:TaskKind -eq 'restore-apply' -or $script:TaskKind -eq 'scheme-http' -or
          $script:TaskKind -eq 'scheme-auto')
}

function Format-SizeText([double]$Bytes) {
  if ($Bytes -lt 1KB) { return ('{0:N0} 字节' -f $Bytes) }
  if ($Bytes -lt 1MB) { return ('{0:N0} KB' -f ($Bytes / 1KB)) }
  return ('{0:N1} MB' -f ($Bytes / 1MB))
}

Refresh-AddressLabels

try {
  $iconPath = Join-Path $Base 'assets\icon.ico'
  if (Test-Path $iconPath) { $win.Icon = [Windows.Media.Imaging.BitmapFrame]::Create([Uri] $iconPath) }
} catch { }

$script:StartScript = {
  param($libPath)
  . $libPath
  $ok = Start-Server
  [pscustomobject]@{ Ok = [bool]$ok; Message = [string](Get-LastStartMessage) }
}
function Start-ServerFire {
  param($Owner, $Up)
  if ($script:TaskKind) { return }
  $script:TaskKind = 'start'
  $script:LaunchPending = $true
  $script:StartAt = Get-Date
  if (-not (Start-BackgroundTask -Worker $script:TaskWorker -Script $script:StartScript -Arguments @($script:LibPath))) {
    $script:TaskKind = $null
    $script:LaunchPending = $false
    $script:LastNotice = @{Text='上一个任务还没结束，请稍后再试。';At=(Get-Date)}
  }
}
function Complete-Start {
  param($Result, $TaskError)
  if (-not $Result -or -not $Result.Ok) {
    $script:LaunchPending = $false
    $script:AutoOpenPending = $false
    $message = if ($TaskError) { $TaskError } elseif ($Result) { [string]$Result.Message } else { '服务启动失败' }
    $script:LastNotice = @{Text=$message;At=(Get-Date)}
    $statusDetail.Text = $message
  }
  $script:LastProbeAt = $null
}

function Get-NoticeText {
  if (-not $script:LastNotice) { return $null }
  $age = ((Get-Date) - $script:LastNotice.At).TotalSeconds
  if ($age -gt 25) { return $null }
  return $script:LastNotice.Text
}

function Update-StatusCore {
  # 只根据后台探活结果刷新界面：这里不做任何网络/进程查询
  $p = $script:Probe
  if (-not $p) { return }
  $ownerState = [string]$p.OwnerState
  $mine = ($ownerState -eq 'Project')

  if ($ownerState -notin @('Free', 'Project')) {
    # 端口被别的程序占着：明确说出来，拾穗集不会去结束它
    $msg = Get-PortConflictMessage -OwnerPid $p.OwnerPid -Verdict $p.Verdict
    $script:LastNotice = @{ Text = $msg; At = (Get-Date) }
    $dot.Fill        = ColorBrush '#F5A623'
    $statusText.Text = "端口被其他程序占用"
    $statusDetail.Text = $msg
    $btnOpen.IsEnabled  = $true
    $btnStart.IsEnabled = $true
    $btnStop.IsEnabled  = $false
    $script:LaunchPending = $false
    return
  }

  if ($p.Up -and $mine) {
    $srvPid = $p.OwnerPid
    $dot.Fill        = ColorBrush '#3DD68C'
    $statusText.Text = "服务运行中" + $(if ($srvPid) { " · PID $srvPid" } else { '' })
    $statusDetail.Text = "后台独立运行 · 启动时已加载 local.env / TLS（若有）"
    $protocolText.Text = Get-ProtocolLine ([string]$p.LiveScheme) ([string]$p.Want)
    $btnOpen.IsEnabled  = $true
    $btnStart.IsEnabled = $false
    $btnStop.IsEnabled  = ($script:TaskKind -ne 'stop')
    $script:LaunchPending = $false
    $script:AutoStartTried = $true
    if ($script:AutoOpenPending) {
      $script:AutoOpenPending = $false
      Start-Process $script:Url
    }
    return
  }

  if ($script:LaunchPending) {
    $elapsed = if ($script:StartAt) { ((Get-Date) - $script:StartAt).TotalSeconds } else { 0 }
    if ($elapsed -gt 48) {
      $script:LaunchPending = $false
      $dot.Fill          = ColorBrush '#FF5C5C'
      $statusText.Text   = "启动失败"
      $statusDetail.Text = "端口 $($script:Port) 可能被占用，或 node 报错。可在项目目录运行 node server.js 看日志"
      $notice = Get-NoticeText
      if ($notice) { $statusDetail.Text = $notice }
      $btnOpen.IsEnabled  = $true
      $btnStart.IsEnabled = $true
      $btnStop.IsEnabled  = $false
      return
    }
    $dot.Fill          = ColorBrush '#F5A623'
    $statusText.Text   = "正在启动服务…"
    $statusDetail.Text = "正在拉起 node server.js（含口令/HTTPS 环境）"
    $protocolText.Text = '正在启动…'
    $btnOpen.IsEnabled  = $true
    $btnStart.IsEnabled = $false
    $btnStop.IsEnabled  = $false
    return
  }

  # 服务没在跑：第一次拿到探活结果时自动拉起（界面上先显示"正在启动"）
  if (-not $script:AutoStartTried) {
    $script:AutoStartTried = $true
    Start-ServerFire -Owner @{ State = $ownerState; Pid = $p.OwnerPid; Verdict = $p.Verdict } -Up ([bool]$p.Up)
    if ($script:LaunchPending) {
      $script:AutoOpenPending = $true
      $dot.Fill          = ColorBrush '#F5A623'
      $statusText.Text   = "正在启动服务…"
      $statusDetail.Text = "正在拉起 node server.js（含口令/HTTPS 环境）"
      $btnOpen.IsEnabled  = $true
      $btnStart.IsEnabled = $false
      $btnStop.IsEnabled  = $false
      return
    }
  }

  $dot.Fill          = ColorBrush '#FF5C5C'
  $statusText.Text   = "服务已停止"
  $statusDetail.Text = "点「启动服务」或「打开网页」都可以把它拉起来（会自动加载口令）"
  $protocolText.Text = '服务没在跑 · 下次启动会用 ' + [string]$p.Want
  $notice = Get-NoticeText
  if ($notice) { $statusDetail.Text = $notice }
  $btnOpen.IsEnabled  = $true
  $btnStart.IsEnabled = $true
  $btnStop.IsEnabled  = $false
}

# 备份/恢复进行中：启停按钮先锁住，避免和换 data/ 撞车
function Update-Status {
  Update-StatusCore
  if (Test-MaintenanceTaskBusy) {
    $btnStart.IsEnabled = $false
    $btnStop.IsEnabled  = $false
  }
}

# 收后台结果 + 发起下一次后台探活。全部在界面线程上只做状态搬运。
function Update-Background {
  if (Test-BackgroundTaskDone -Worker $script:ProbeWorker) {
    $result = Get-BackgroundTaskResult -Worker $script:ProbeWorker
    if ($result) {
      $script:Probe = $result
      $script:Url    = [string]$result.Url
      $script:Scheme = [string]$result.Scheme
      $script:Port   = [int]$result.Port
      Refresh-AddressLabels
      Update-Status
    } else {
      $err = Get-BackgroundTaskError -Worker $script:ProbeWorker
      if ($err) {
        $script:LastNotice = @{ Text = "状态检查失败：$err"; At = (Get-Date) }
        $statusDetail.Text = "状态检查失败：$err"
      }
    }
  }
  $now = Get-Date
  if ($script:ProbeWorker.Done -and
      ($null -eq $script:LastProbeAt -or ($now - $script:LastProbeAt).TotalMilliseconds -ge 1500)) {
    $script:LastProbeAt = $now
    Start-BackgroundTask -Worker $script:ProbeWorker -Script $script:ProbeScript -Arguments @($script:LibPath)
  }
  if ($script:TaskKind -and (Test-BackgroundTaskDone -Worker $script:TaskWorker)) {
    $kind = $script:TaskKind
    $script:TaskKind = $null
    $taskResult = Get-BackgroundTaskResult -Worker $script:TaskWorker
    $taskError = Get-BackgroundTaskError -Worker $script:TaskWorker
    if ($kind -eq 'backup') { Complete-Backup -Result $taskResult -TaskError $taskError }
    elseif ($kind -eq 'qr') { Complete-Qr -Result $taskResult -TaskError $taskError }
    elseif ($kind -eq 'start') { Complete-Start -Result $taskResult -TaskError $taskError }
    elseif ($kind -eq 'stop') { Complete-Stop -Result $taskResult -TaskError $taskError }
    elseif ($kind -eq 'restore-check') { Complete-RestoreCheck -Result $taskResult -TaskError $taskError }
    elseif ($kind -eq 'restore-apply') { Complete-RestoreApply -Result $taskResult -TaskError $taskError }
    elseif ($kind -eq 'scheme-http' -or $kind -eq 'scheme-auto') { Complete-Scheme -Result $taskResult -TaskError $taskError }
  }
}

$btnOpen.Add_Click({
  if ($script:Probe -and $script:Probe.Up -and ([string]$script:Probe.OwnerState -eq 'Project')) {
    Start-Process $script:Url
    return
  }
  if (-not $script:LaunchPending) {
    # 服务没起来：交给后台探活结果驱动启动（避免界面线程里同步查端口）
    $script:AutoStartTried  = $false
    $script:AutoOpenPending = $true
  }
})

$btnPairQr.Add_Click({
  if ($script:TaskKind) { return }
  $btnPairQr.IsEnabled = $false
  $statusDetail.Text = "正在生成配对二维码…"
  $script:TaskKind = 'qr'
  if (-not (Start-BackgroundTask -Worker $script:TaskWorker -Script $script:QrScript -Arguments @($script:LibPath))) {
    $script:TaskKind = $null
    $btnPairQr.IsEnabled = $true
    $statusDetail.Text = "上一个任务还没结束，请稍后再试。"
  }
})

function Complete-Qr {
  param($Result, $TaskError)
  $btnPairQr.IsEnabled = $true
  if (-not $Result) {
    $statusDetail.Text = "配对码生成失败：$TaskError"
    return
  }
  $json = [string]$Result.Json
  try { Set-Clipboard -Value $json } catch { }
  $png = [string]$Result.Png
  if (-not $png -or -not (Test-Path $png)) {
    # PNG 生成失败：把终端 ASCII 二维码打出来（无窗口时用户看不到，靠提示说明）
    $ascii = [string]$Result.Ascii
    if ($ascii) { Write-Host $ascii }
    $statusDetail.Text = "二维码图片生成失败，已在终端出码；配对 JSON 已复制。"
    [System.Windows.MessageBox]::Show(
      "未能生成二维码图片；终端窗口已打印 ASCII 二维码。`n`n配对 JSON 已复制到剪贴板（含口令，请勿外传）：`n`n$json`n`nApp → 连接 → 扫码（对准终端里的二维码）。",
      "拾穗集 配对码",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Warning
    ) | Out-Null
    return
  }
  $statusDetail.Text = "配对二维码已显示；App 扫码即可。"
  Show-QrWindow -Png $png
}

function Show-QrWindow {
  param([string]$Png)
  $qrXaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="拾穗集 配对码" Width="420" SizeToContent="Height"
        WindowStartupLocation="CenterOwner" ResizeMode="NoResize"
        Background="#17191F" FontFamily="Microsoft YaHei UI">
  <StackPanel Margin="24,20,24,22" HorizontalAlignment="Center">
    <TextBlock Text="🔗 扫码配对" FontSize="18" FontWeight="Bold" Foreground="#F2F4F8" HorizontalAlignment="Center"/>
    <TextBlock Text="手机 App → 连接 → 扫码，对准下方二维码" FontSize="12" Foreground="#8B93A5"
               Margin="0,5,0,14" HorizontalAlignment="Center" TextWrapping="Wrap" TextAlignment="Center"/>
    <Border Background="White" CornerRadius="12" Padding="14" HorizontalAlignment="Center">
      <Image x:Name="QrImage" Width="300" Height="300" RenderOptions.BitmapScalingMode="NearestNeighbor"/>
    </Border>
    <TextBlock Text="App → 连接 → 开始扫码，对准此码即可（配对 JSON 已在剪贴板，含口令，请勿外传）。"
               FontSize="11" Foreground="#667084" Margin="0,8,0,0" TextWrapping="Wrap" TextAlignment="Center"/>
    <Button x:Name="QrClose" Content="关闭" FontSize="14" FontWeight="SemiBold" Foreground="White"
            Background="#2C303B" BorderThickness="0" Cursor="Hand" Margin="0,16,0,0" Padding="0,10" Width="160"
            HorizontalAlignment="Center">
      <Button.Template>
        <ControlTemplate TargetType="Button">
          <Border Background="{TemplateBinding Background}" CornerRadius="10" Padding="0,10">
            <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Border>
        </ControlTemplate>
      </Button.Template>
    </Button>
  </StackPanel>
</Window>
'@
  $qrWin = [Windows.Markup.XamlReader]::Parse($qrXaml)
  $qrWin.Owner = $win
  $img = $qrWin.FindName('QrImage')
  $bmp = New-Object Windows.Media.Imaging.BitmapImage
  $bmp.BeginInit()
  $bmp.CacheOption = [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
  $bmp.UriSource = [Uri]$Png
  $bmp.EndInit()
  $bmp.Freeze()
  $img.Source = $bmp
  $qrWin.FindName('QrClose').Add_Click({ $qrWin.Close() })
  $qrWin.Add_Closed({
    try { if (Test-Path $Png) { Remove-Item $Png -Force -ErrorAction SilentlyContinue } } catch { }
  })
  $qrWin.ShowDialog() | Out-Null
}

function Complete-Backup {
  param($Result, $TaskError)
  $btnBackup.IsEnabled = $true
  if (-not $Result) {
    $msg = "备份没做成：$TaskError"
    $script:LastNotice = @{ Text = $msg; At = (Get-Date) }
    $statusDetail.Text = $msg
    Update-Status
    return
  }
  if ([bool]$Result.Ok) {
    $text = "备份完成。`n`n位置：$($Result.Path)`n文件：$($Result.Files) 个"
    if ($Result.WasRunning) {
      if ($Result.Restarted) { $text += "`n`n服务备份前是运行着的，已经重新启动。" }
      else { $text += "`n`n服务备份前是运行着的，但没能自动重新启动，请手动点「启动服务」。" }
    } else {
      $text += "`n`n服务备份前是停着的，现在仍然是停着的。"
    }
    [System.Windows.MessageBox]::Show($text, "拾穗集 备份",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Information) | Out-Null
    $statusDetail.Text = '备份完成。'
  } else {
    [System.Windows.MessageBox]::Show([string]$Result.Message, "拾穗集 备份",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Warning) | Out-Null
    $script:LastNotice = @{ Text = [string]$Result.Message; At = (Get-Date) }
    $statusDetail.Text = [string]$Result.Message
  }
  Update-Status
}

$btnBackup.Add_Click({
  if ($script:TaskKind) { return }
  if (-not (Test-Path -LiteralPath $script:MaintPath)) {
    $statusDetail.Text = '没找到 maintenance.ps1（应在项目根目录）。'
    return
  }
  $btnBackup.IsEnabled = $false
  $statusDetail.Text   = '正在备份 data/…（服务会先暂停一下，备份完自动恢复）'
  $script:TaskKind = 'backup'
  if (-not (Start-BackgroundTask -Worker $script:TaskWorker -Script $script:BackupScript `
      -Arguments @($script:LibPath, $script:MaintPath, $Base))) {
    $script:TaskKind = $null
    $btnBackup.IsEnabled = $true
    $statusDetail.Text = '上一个任务还没结束，请稍后再试。'
  }
})

# ———— 恢复备份 ————
$btnRestore.Add_Click({
  if ($script:TaskKind) { return }
  if (-not (Test-Path -LiteralPath $script:RestorePath)) {
    $statusDetail.Text = '没找到 restore.ps1（应在项目根目录）。'
    return
  }
  # 选备份文件夹（备份目录，或它里面的 data 文件夹）
  $picked = ''
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = '选择备份文件夹（备份目录，或它里面的 data 文件夹）'
    $dlg.ShowNewFolderButton = $false
    $defaultDir = Join-Path $Base 'backups'
    if (Test-Path -LiteralPath $defaultDir) { $dlg.SelectedPath = $defaultDir }
    try {
      if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $picked = [string]$dlg.SelectedPath }
    } finally { $dlg.Dispose() }
  } catch {
    $statusDetail.Text = ('选不了文件夹：' + $_.Exception.Message)
    return
  }
  if (-not $picked) { return }
  $script:PendingRestore = $picked
  $btnRestore.IsEnabled = $false
  $statusDetail.Text = '正在检查这份备份…'
  $script:TaskKind = 'restore-check'
  if (-not (Start-BackgroundTask -Worker $script:TaskWorker -Script $script:RestoreCheckScript `
      -Arguments @($script:LibPath, $script:RestorePath, $Base, $picked))) {
    $script:TaskKind = $null
    $btnRestore.IsEnabled = $true
    $statusDetail.Text = '上一个任务还没结束，请稍后再试。'
  }
})

function Complete-RestoreCheck {
  param($Result, $TaskError)
  $btnRestore.IsEnabled = $true
  if (-not $Result) {
    $statusDetail.Text = "备份检查失败：$TaskError"
    return
  }
  if (-not [bool]$Result.Ok) {
    $lines = @()
    foreach ($e in @($Result.Errors)) { $lines += ('· ' + [string]$e) }
    $text = "这份备份不能用来恢复：`n`n" + ($lines -join "`n") + "`n`n当前数据没有任何改动。"
    [System.Windows.MessageBox]::Show($text, "拾穗集 恢复备份",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Warning) | Out-Null
    $statusDetail.Text = '这份备份没通过校验，当前数据没有任何改动。'
    return
  }
  $boards = ((@($Result.Boards) | Sort-Object) -join '、')
  $summary = "要用这份备份恢复吗？`n`n位置：$($Result.DataDir)`n文件：$($Result.Files) 个 · $(Format-SizeText ([double]$Result.Bytes))`n板块：$boards`n贴图：$($Result.ImageRefs) 张"
  if ($Result.Oldest -and $Result.Newest) { $summary += "`n数据时间：$($Result.Oldest) ~ $($Result.Newest)" }
  if (@($Result.Warnings).Count -gt 0) { $summary += "`n`n提醒：" + ((@($Result.Warnings)) -join '；') }
  $summary += "`n`n恢复会用这份备份覆盖当前的 data\。config.json、文献库、证书都不受影响。`n恢复前会自动把当前数据备份一份到 backups\。"
  $ans = [System.Windows.MessageBox]::Show($summary, "拾穗集 恢复备份",
    [System.Windows.MessageBoxButton]::YesNo,
    [System.Windows.MessageBoxImage]::Question)
  if ($ans -ne [System.Windows.MessageBoxResult]::Yes) {
    $statusDetail.Text = '已取消，当前数据没有任何改动。'
    return
  }
  $btnRestore.IsEnabled = $false
  $statusDetail.Text = '正在恢复…（请不要关窗口）'
  $script:TaskKind = 'restore-apply'
  if (-not (Start-BackgroundTask -Worker $script:TaskWorker -Script $script:RestoreApplyScript `
      -Arguments @($script:LibPath, $script:MaintPath, $Base, $script:PendingRestore))) {
    $script:TaskKind = $null
    $btnRestore.IsEnabled = $true
    $statusDetail.Text = '上一个任务还没结束，请稍后再试。'
  }
}

function Complete-RestoreApply {
  param($Result, $TaskError)
  $btnRestore.IsEnabled = $true
  if (-not $Result) {
    $statusDetail.Text = "恢复没做成：$TaskError"
    return
  }
  if ([bool]$Result.Ok) {
    $text = "恢复完成。`n`n"
    if ($Result.Safety) { $text += "恢复前的数据留了一份：`n$($Result.Safety)`n`n" }
    if ($Result.WasRunning) {
      if ($Result.Restarted) { $text += '服务已经重新启动。' }
      else { $text += '服务没能自动重新启动，请手动点「启动服务」。' }
    } else {
      $text += '服务现在是停着的（和恢复前一样）。'
    }
    [System.Windows.MessageBox]::Show($text, "拾穗集 恢复备份",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Information) | Out-Null
    $statusDetail.Text = '恢复完成。'
  } else {
    [System.Windows.MessageBox]::Show([string]$Result.Message, "拾穗集 恢复备份",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Warning) | Out-Null
    $script:LastNotice = @{ Text = [string]$Result.Message; At = (Get-Date) }
    $statusDetail.Text = [string]$Result.Message
  }
  Update-Status
}

# ———— 协议切换 ————
function Start-SchemeTask([string]$Target, [string]$ConfirmText) {
  if ($script:TaskKind) { return }
  $p = $script:Probe
  $up = ($p -and [bool]$p.Up -and [string]$p.OwnerState -eq 'Project')
  $live = ''
  if ($up) { $live = [string]$p.LiveScheme }
  if ($up -and $live -eq 'http' -and $Target -eq 'http') {
    [System.Windows.MessageBox]::Show('服务已经在用 HTTP，手机 App 可以直接扫码配对。', "拾穗集 协议",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Information) | Out-Null
    return
  }
  if ($up) {
    $ans = [System.Windows.MessageBox]::Show($ConfirmText, "拾穗集 协议",
      [System.Windows.MessageBoxButton]::YesNo,
      [System.Windows.MessageBoxImage]::Question)
    if ($ans -ne [System.Windows.MessageBoxResult]::Yes) { return }
  }
  $btnHttp.IsEnabled = $false
  $btnAuto.IsEnabled = $false
  $statusDetail.Text = '正在按新协议启动服务…'
  $script:TaskKind = if ($Target -eq 'http') { 'scheme-http' } else { 'scheme-auto' }
  if (-not (Start-BackgroundTask -Worker $script:TaskWorker -Script $script:SchemeScript `
      -Arguments @($script:LibPath, $Base, $Target))) {
    $script:TaskKind = $null
    $btnHttp.IsEnabled = $true
    $btnAuto.IsEnabled = $true
    $statusDetail.Text = '上一个任务还没结束，请稍后再试。'
  }
}

function Complete-Scheme {
  param($Result, $TaskError)
  $btnHttp.IsEnabled = $true
  $btnAuto.IsEnabled = $true
  if (-not $Result) {
    $statusDetail.Text = "切换协议失败：$TaskError"
    return
  }
  if ([bool]$Result.Ok) {
    $statusDetail.Text = '已按新协议启动服务。'
    $script:LastNotice = @{ Text = '已按新协议启动服务。'; At = (Get-Date) }
  } else {
    $msg = [string]$Result.Message
    [System.Windows.MessageBox]::Show($msg, "拾穗集 协议",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Warning) | Out-Null
    $script:LastNotice = @{ Text = $msg; At = (Get-Date) }
    $statusDetail.Text = $msg
  }
  Update-Status
}

$btnHttp.Add_Click({
  $text = "当前运行中的实例用的是 HTTPS。`n`n手机 App 不接受自签 HTTPS 证书。要先停止拾穗集，再以 HTTP 重新启动吗？"
  Start-SchemeTask -Target 'http' -ConfirmText $text
})

$btnAuto.Add_Click({
  $text = "当前运行中的实例用的是 HTTP。`n`n改回自动后：有证书就用 HTTPS，没有就用 HTTP。手机 App 不接受自签 HTTPS 证书。`n`n要现在停止并重新启动吗？"
  Start-SchemeTask -Target 'auto' -ConfirmText $text
})

$btnStart.Add_Click({
  if ($script:Probe) {
    Start-ServerFire -Owner @{ State = [string]$script:Probe.OwnerState; Pid = $script:Probe.OwnerPid; Verdict = $script:Probe.Verdict } -Up ([bool]$script:Probe.Up)
    Update-Status
    return
  }
  # 还没有探活结果：等下一次探活回来再启动
  $script:AutoStartTried = $false
})

function Complete-Stop {
  param($Result, $TaskError)
  $btnStop.IsEnabled = $true
  $script:LaunchPending = $false
  if ($Result) {
    $why = [string]$Result.Message
    if ($why) { $script:LastNotice = @{ Text = $why; At = (Get-Date) } }
  } elseif ($TaskError) {
    $script:LastNotice = @{ Text = "停止服务失败：$TaskError"; At = (Get-Date) }
  }
  Update-Status
}

$btnStop.Add_Click({
  if ($script:TaskKind) { return }
  # 停止要实时核实端口归属（可能有一秒级查询），放到后台线程做，界面不卡
  $btnStop.IsEnabled = $false
  $statusDetail.Text = "正在停止服务…"
  $script:TaskKind = 'stop'
  if (-not (Start-BackgroundTask -Worker $script:TaskWorker -Script $script:StopScript -Arguments @($script:LibPath))) {
    $script:TaskKind = $null
    $btnStop.IsEnabled = $true
    $statusDetail.Text = "上一个任务还没结束，请稍后再试。"
  }
})

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({ Update-Background })
$timer.Start()

# 窗口一画出来就开始后台探活：界面线程不阻塞，状态到了自己更新
$win.Add_ContentRendered({
  Start-BackgroundTask -Worker $script:ProbeWorker -Script $script:ProbeScript -Arguments @($script:LibPath)
  $script:LastProbeAt = Get-Date
})

# 关闭 / 异常退出时释放后台运行空间，别让线程一直挂着
$win.Add_Closed({
  try { $timer.Stop() } catch { }
  Close-BackgroundWorker $script:ProbeWorker
  Close-BackgroundWorker $script:TaskWorker
})

$win.ShowDialog() | Out-Null
