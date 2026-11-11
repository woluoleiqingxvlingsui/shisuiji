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
      <Button x:Name="BtnStart" Grid.Column="0" Content="▶ 启动服务" Style="{StaticResource BtnBase}" Margin="0,10,0,0"/>
      <Button x:Name="BtnStop"  Grid.Column="2" Content="⏹ 停止服务" Style="{StaticResource BtnBase}" Margin="0,10,0,0"/>
    </Grid>

    <TextBlock Text="启动时自动加载 local.env.ps1 口令；若目录有 danji-cert.pem / danji-key.pem 则走 HTTPS。关闭窗口不停服务。"
               FontSize="11.5" Foreground="#667084" Margin="2,16,0,0" TextWrapping="Wrap"/>
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
$envText      = $win.FindName('EnvText')
$btnOpen      = $win.FindName('BtnOpen')
$btnPairQr    = $win.FindName('BtnPairQr')
$btnBackup    = $win.FindName('BtnBackup')
$btnStart     = $win.FindName('BtnStart')
$btnStop      = $win.FindName('BtnStop')

# ---- 后台脚本（在独立运行空间里跑，界面线程不参与） ----

# 探活：健康检查 + 端口归属 + 地址信息
$script:ProbeScript = {
  param($libPath)
  . $libPath
  $up = $false
  try { $up = Test-Up } catch { }
  $owner = @{ State = 'Unknown'; Pid = $null; Verdict = $null }
  try { $owner = Get-PortOwner } catch { }
  [pscustomobject]@{
    Up              = [bool]$up
    OwnerState      = [string]$owner.State
    OwnerPid        = $owner.Pid
    Verdict         = $owner.Verdict
    Url             = [string]$Url
    Scheme          = [string]$Scheme
    Port            = [int]$Port
    TokenConfigured = [bool](Get-EffectiveToken)
    TlsEnabled      = [bool](Get-UseTls)
  }
}

# 备份：调 backup.ps1（服务在跑时它会拒绝，这里只负责把结果弹出来）
$script:BackupScript = {
  param($scriptFile)
  $out  = & powershell -NoProfile -ExecutionPolicy Bypass -File $scriptFile 2>&1
  $code = $LASTEXITCODE
  [pscustomobject]@{ Code = [int]$code; Text = [string](($out | Out-String).Trim()) }
}

# 配对码：生成载荷与二维码 PNG（失败时退回终端 ASCII 码）
$script:QrScript = {
  param($libPath)
  . $libPath
  $json = Get-PairPayload
  $png = $null
  try { $png = New-PairQrPng } catch { $png = $null }
  $ascii = ''
  if (-not $png) {
    try {
      $qrScript = Join-Path $Base 'tools\print-pair-qr.mjs'
      if (Test-Path $qrScript) {
        $parsed = $json | ConvertFrom-Json
        $ascii = [string]((& node $qrScript --base $parsed.base --token $parsed.token) -join "`n")
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
    $tls = if ($script:Probe.TlsEnabled) { "HTTPS 已启用 · SW 可注册" } else { "HTTP · 局域网下无离线冷启动（见 README）" }
    $envText.Text = "$tok · $tls"
    return
  }
  $tok = if (Get-EffectiveToken) { "口令已配置（config.json 或 local.env.ps1）" } else { "未配置口令（建议 config.json 设置 sync.token）" }
  $tls = if (Get-UseTls) { "HTTPS 已启用 · SW 可注册" } else { "HTTP · 局域网下无离线冷启动（见 README）" }
  $envText.Text = "$tok · $tls"
}

Refresh-AddressLabels

try {
  $iconPath = Join-Path $Base 'assets\icon.ico'
  if (Test-Path $iconPath) { $win.Icon = [Windows.Media.Imaging.BitmapFrame]::Create([Uri] $iconPath) }
} catch { }

function Start-ServerFire {
  # $Owner / $Up 来自后台探活结果；没有结果时才同步查一次（仅命令行兜底路径）
  param($Owner, $Up)
  $script:EnvInfo = Import-LocalEnv
  Refresh-AddressLabels
  if (-not $Owner) { $Owner = Get-PortOwner }
  # 端口被别的程序占着：只提示，不结束它
  if ($Owner.State -notin @('Free', 'Project')) {
    $msg = Get-PortConflictMessage -OwnerPid $Owner.Pid -Verdict $Owner.Verdict
    $script:LastNotice = @{ Text = $msg; At = (Get-Date) }
    $dot.Fill        = ColorBrush '#F5A623'
    $statusText.Text = "端口被其他程序占用"
    $statusDetail.Text = $msg
    $btnOpen.IsEnabled  = $true
    $btnStart.IsEnabled = $true
    $btnStop.IsEnabled  = $false
    return
  }
  # 端口有残留但探活失败：只有即时核实确认是拾穗集自己的进程才停（HTTP→HTTPS 切换）。
  # 探活结果是缓存，PID 可能已经被别的进程顶替，所以这里重新查一次命令行，不认识就不动它。
  if (-not $Up -and $Owner.State -eq 'Project' -and $Owner.Pid) {
    $verdict = Test-ProjectServerProcess -ProcessId ([int]$Owner.Pid)
    if ($verdict.Confirmed) {
      try { Stop-Process -Id ([int]$Owner.Pid) -Force -ErrorAction Stop } catch { }
      Start-Sleep -Milliseconds 400
    } else {
      $script:LastNotice = @{ Text = [string]$verdict.Message; At = (Get-Date) }
    }
  }
  if (-not (Start-ServerProcess)) {
    $msg = ("启动失败：找不到 {0}。" -f (Get-ProjectServerPath))
    $script:LastNotice = @{ Text = $msg; At = (Get-Date) }
    $statusDetail.Text = $msg
    $btnStart.IsEnabled = $true
    $btnStop.IsEnabled  = $false
    return
  }
  $script:LaunchPending = $true
  $script:StartAt = Get-Date
}

function Get-NoticeText {
  if (-not $script:LastNotice) { return $null }
  $age = ((Get-Date) - $script:LastNotice.At).TotalSeconds
  if ($age -gt 25) { return $null }
  return $script:LastNotice.Text
}

function Update-Status {
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
  $notice = Get-NoticeText
  if ($notice) { $statusDetail.Text = $notice }
  $btnOpen.IsEnabled  = $true
  $btnStart.IsEnabled = $true
  $btnStop.IsEnabled  = $false
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
    elseif ($kind -eq 'stop') { Complete-Stop -Result $taskResult -TaskError $taskError }
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
    return
  }
  $text = [string]$Result.Text
  if ([int]$Result.Code -eq 0) {
    $done = "备份完成，输出在项目根目录的 backups\"
    [System.Windows.MessageBox]::Show($text, "拾穗集 备份",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Information) | Out-Null
  } else {
    $done = "备份没做成，看弹窗里的说明"
    [System.Windows.MessageBox]::Show($text, "拾穗集 备份",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Warning) | Out-Null
  }
  Update-Status
  if ($done) { $statusDetail.Text = $done }
}

$btnBackup.Add_Click({
  if ($script:TaskKind) { return }
  $scriptFile = Join-Path $Base 'backup.ps1'
  if (-not (Test-Path $scriptFile)) {
    $statusDetail.Text = "没找到 backup.ps1（应在项目根目录）。"
    return
  }
  $btnBackup.IsEnabled = $false
  $statusDetail.Text   = "正在备份 data/…"
  $script:TaskKind = 'backup'
  if (-not (Start-BackgroundTask -Worker $script:TaskWorker -Script $script:BackupScript -Arguments @($scriptFile))) {
    $script:TaskKind = $null
    $btnBackup.IsEnabled = $true
    $statusDetail.Text = "上一个任务还没结束，请稍后再试。"
  }
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
