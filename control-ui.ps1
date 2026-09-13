# 拾穗集 图形控制台 —— 双击桌面快捷方式 / start.bat / launch.vbs 打开的就是这个窗口
# 深色卡片风：状态灯每 2 秒自动刷新；纯按钮操作；关闭窗口不影响后台服务。
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$ErrorActionPreference = 'Stop'

# 状态机：checking → starting / up / down / failed（由定时器每 2 秒重新判定）
$script:LaunchPending   = $false   # 这次打开窗口后是否拉起过 node，还没确认它活了
$script:StartTicks      = 0        # starting 状态持续的 tick 数（24 次 = 48 秒仍未起来视为失败）
$script:AutoOpenPending = $false   # 拉起服务后要不要自动打开网页（保持"双击就能用"）

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="拾穗集 控制台" Width="440" SizeToContent="Height"
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
      </StackPanel>
    </Border>

    <Button x:Name="BtnOpen" Content="🚀 打开网页" Style="{StaticResource BtnBase}" Background="#4D6BFE" Margin="0,14,0,0"/>
    <Grid>
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="10"/>
        <ColumnDefinition Width="*"/>
      </Grid.ColumnDefinitions>
      <Button x:Name="BtnStart" Grid.Column="0" Content="▶ 启动服务" Style="{StaticResource BtnBase}" Margin="0,10,0,0"/>
      <Button x:Name="BtnStop"  Grid.Column="2" Content="⏹ 停止服务" Style="{StaticResource BtnBase}" Margin="0,10,0,0"/>
    </Grid>

    <TextBlock Text="关闭窗口不会停止后台服务；要真正停止请点「停止服务」。"
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
$btnOpen      = $win.FindName('BtnOpen')
$btnStart     = $win.FindName('BtnStart')
$btnStop      = $win.FindName('BtnStop')

$urlText.Text = $Url

try {
  $iconPath = Join-Path $Base 'assets\icon.ico'
  if (Test-Path $iconPath) { $win.Icon = [Windows.Media.Imaging.BitmapFrame]::Create([Uri] $iconPath) }
} catch { }

# 用后台拉起 node 的方式启动，不阻塞界面；死活由定时器确认
function Start-ServerFire {
  Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $Base -WindowStyle Hidden
  $script:LaunchPending = $true
  $script:StartTicks = 0
}

function Update-Status {
  $up = Test-Up
  if ($up) {
    $srvPid = Get-ServerPid
    $dot.Fill        = ColorBrush '#3DD68C'
    $statusText.Text = "服务运行中" + $(if ($srvPid) { " · PID $srvPid" } else { '' })
    $statusDetail.Text = "后台独立运行，关闭本窗口不受影响"
    $btnOpen.IsEnabled  = $true
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
      $statusDetail.Text = "请在项目文件夹运行 node server.js 查看具体报错"
      $btnOpen.IsEnabled  = $true
      $btnStart.IsEnabled = $true
      $btnStop.IsEnabled  = $false
      return
    }
    $dot.Fill          = ColorBrush '#F5A623'
    $statusText.Text   = "正在启动服务…"
    $statusDetail.Text = "正在拉起 node server.js，几秒内就好"
    $btnOpen.IsEnabled  = $true   # 服务没起时点它会先启动再打开
    $btnStart.IsEnabled = $false
    $btnStop.IsEnabled  = $false
    return
  }

  $dot.Fill          = ColorBrush '#FF5C5C'
  $statusText.Text   = "服务已停止"
  $statusDetail.Text = "点「启动服务」或「打开网页」都可以把它拉起来"
  $btnOpen.IsEnabled  = $true
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

# 窗口画出来的第一件事：服务没在跑就自动拉起（保持"双击就能用"），确认后自动开网页
$win.Add_ContentRendered({
  if (-not (Test-Up) -and -not $script:LaunchPending) {
    Start-ServerFire
    $script:AutoOpenPending = $true
  }
  Update-Status
})

Update-Status
$win.ShowDialog() | Out-Null
