# 拾穗集 图形控制台 —— 双击桌面快捷方式 / start.bat / launch.vbs 打开的就是这个窗口
# 深色卡片风：状态灯每 2 秒自动刷新；纯按钮操作；关闭窗口不影响后台服务。
# 启动会自动加载 local.env.ps1（口令）与目录下 HTTPS 证书（若有）。
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$ErrorActionPreference = 'Stop'

$script:LaunchPending   = $false
$script:StartTicks      = 0
$script:AutoOpenPending = $false
$script:EnvInfo         = Import-LocalEnv

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="拾穗集 控制台" Width="460" SizeToContent="Height"
        WindowStartupLocation="CenterScreen" ResizeMode="NoResize"
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
        <TextBlock x:Name="UrlText" Text="" FontSize="13" Foreground="#6EA8FF" Margin="20,3,0,0"/>
        <TextBlock x:Name="PhoneText" Text="" FontSize="12.5" Foreground="#9B8CFF" Margin="20,3,0,0" TextWrapping="Wrap"/>
        <TextBlock x:Name="EnvText" Text="" FontSize="11.5" Foreground="#667084" Margin="20,6,0,0" TextWrapping="Wrap"/>
      </StackPanel>
    </Border>

    <Button x:Name="BtnOpen" Content="🚀 打开网页（电脑）" Style="{StaticResource BtnBase}" Background="#4D6BFE" Margin="0,14,0,0"/>
    <Button x:Name="BtnCopyPhone" Content="📋 复制手机访问地址" Style="{StaticResource BtnBase}" Margin="0,10,0,0"/>
    <Button x:Name="BtnPairQr" Content="🔗 配对码（扫码 / 粘贴）" Style="{StaticResource BtnBase}" Margin="0,10,0,0"/>
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
$urlText      = $win.FindName('UrlText')
$phoneText    = $win.FindName('PhoneText')
$envText      = $win.FindName('EnvText')
$btnOpen      = $win.FindName('BtnOpen')
$btnCopyPhone = $win.FindName('BtnCopyPhone')
$btnPairQr    = $win.FindName('BtnPairQr')
$btnStart     = $win.FindName('BtnStart')
$btnStop      = $win.FindName('BtnStop')

function Refresh-AddressLabels {
  Update-UrlFromEnv
  $urlText.Text = $Url
  if ($script:PhoneUrl) {
    $phoneText.Text = "手机（同一 Wi-Fi）：$($script:PhoneUrl)"
  } else {
    $phoneText.Text = "手机地址：未能识别局域网 IP（ipconfig 查 WLAN IPv4）"
  }
  $tok = if ($env:DANJI_TOKEN) { "口令已加载（local.env.ps1）" } else { "未配置口令（建议 local.env.ps1 设置 DANJI_TOKEN）" }
  $tls = if (Get-UseTls) { "HTTPS 已启用 · SW 可注册" } else { "HTTP · 局域网下无离线冷启动（见 README）" }
  $envText.Text = "$tok · $tls"
}

Refresh-AddressLabels

try {
  $iconPath = Join-Path $Base 'assets\icon.ico'
  if (Test-Path $iconPath) { $win.Icon = [Windows.Media.Imaging.BitmapFrame]::Create([Uri] $iconPath) }
} catch { }

function Start-ServerFire {
  $script:EnvInfo = Import-LocalEnv
  Refresh-AddressLabels
  # 带 local.env / TLS 环境启动；端口有残留但探活失败时先停再起（HTTP→HTTPS）
  if (-not (Test-Up) -and (Get-ServerPid)) {
    Stop-Server | Out-Null
    Start-Sleep -Milliseconds 400
  }
  Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $Base -WindowStyle Hidden
  $script:LaunchPending = $true
  $script:StartTicks = 0
}

function Update-Status {
  Refresh-AddressLabels
  $up = Test-Up
  if ($up) {
    $srvPid = Get-ServerPid
    $dot.Fill        = ColorBrush '#3DD68C'
    $statusText.Text = "服务运行中" + $(if ($srvPid) { " · PID $srvPid" } else { '' })
    $statusDetail.Text = "后台独立运行 · 启动时已加载 local.env / TLS（若有）"
    $btnOpen.IsEnabled  = $true
    $btnCopyPhone.IsEnabled = [bool]$script:PhoneUrl
    $btnStart.IsEnabled = $false
    $btnStop.IsEnabled  = $true
    $script:LaunchPending = $false
    if ($script:AutoOpenPending) {
      $script:AutoOpenPending = $false
      Start-Process $Url
    }
    return
  }

  if ($script:LaunchPending) {
    $script:StartTicks++
    if ($script:StartTicks -gt 24) {
      $script:LaunchPending = $false
      $dot.Fill          = ColorBrush '#FF5C5C'
      $statusText.Text   = "启动失败"
      $statusDetail.Text = "端口 $($Port) 可能被占用，或 node 报错。可在项目目录运行 node server.js 看日志"
      $btnOpen.IsEnabled  = $true
      $btnCopyPhone.IsEnabled = [bool]$script:PhoneUrl
      $btnStart.IsEnabled = $true
      $btnStop.IsEnabled  = $false
      return
    }
    $dot.Fill          = ColorBrush '#F5A623'
    $statusText.Text   = "正在启动服务…"
    $statusDetail.Text = "正在拉起 node server.js（含口令/HTTPS 环境）"
    $btnOpen.IsEnabled  = $true
    $btnCopyPhone.IsEnabled = [bool]$script:PhoneUrl
    $btnStart.IsEnabled = $false
    $btnStop.IsEnabled  = $false
    return
  }

  $dot.Fill          = ColorBrush '#FF5C5C'
  $statusText.Text   = "服务已停止"
  $statusDetail.Text = "点「启动服务」或「打开网页」都可以把它拉起来（会自动加载口令）"
  $btnOpen.IsEnabled  = $true
  $btnCopyPhone.IsEnabled = [bool]$script:PhoneUrl
  $btnStart.IsEnabled = $true
  $btnStop.IsEnabled  = $false
}

$btnOpen.Add_Click({
  if (Test-Up) {
    Start-Process $Url
  } elseif (-not $script:LaunchPending) {
    Start-ServerFire
    $script:AutoOpenPending = $true
  }
})

$btnCopyPhone.Add_Click({
  Refresh-AddressLabels
  if (-not $script:PhoneUrl) { return }
  try {
    Set-Clipboard -Value $script:PhoneUrl
    $statusDetail.Text = "已复制：$($script:PhoneUrl)"
  } catch {
    $statusDetail.Text = "复制失败，请手动选中：$($script:PhoneUrl)"
  }
})

$btnPairQr.Add_Click({
  Import-LocalEnv | Out-Null
  Refresh-AddressLabels
  $json = Get-PairPayload
  # 终端出码 + 纯文本；图形窗口里再给一份可复制 JSON（含口令，慎分享）
  try {
    Show-PairQr | Out-Null
  } catch {
    Write-Host "生成二维码失败: $($_.Exception.Message)"
    Write-Host $json
  }
  try { Set-Clipboard -Value $json } catch { }
  $statusDetail.Text = "配对 JSON 已复制；终端已打印二维码。App 扫码或粘贴。"
  [System.Windows.MessageBox]::Show(
    "配对 JSON 已复制到剪贴板（含口令，请勿外传）。`n`n$json`n`n终端窗口里有可扫二维码。`nApp → 连接 → 扫码 / 粘贴码。",
    "拾穗集 配对码",
    [System.Windows.MessageBoxButton]::OK,
    [System.Windows.MessageBoxImage]::Information
  ) | Out-Null
})

$btnStart.Add_Click({
  if (-not (Test-Up) -and -not $script:LaunchPending) { Start-ServerFire }
})

$btnStop.Add_Click({
  Stop-Server | Out-Null
  Update-Status
})

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(2)
$timer.Add_Tick({ Update-Status })
$timer.Start()

$win.Add_ContentRendered({
  if (-not (Test-Up) -and -not $script:LaunchPending) {
    Start-ServerFire
    $script:AutoOpenPending = $true
  }
  Update-Status
})

Update-Status
$win.ShowDialog() | Out-Null
