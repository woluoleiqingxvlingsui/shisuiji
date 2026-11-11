# 首次启动引导。只为全新目录创建配置；已存在的本机配置不覆盖。
function Get-FirstRunXaml {
  return @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="欢迎使用拾穗集" Width="540" SizeToContent="Height"
        WindowStartupLocation="CenterScreen" ResizeMode="CanMinimize"
        Background="#F4F6FA" FontFamily="Microsoft YaHei UI" FontSize="14">
  <Border Padding="28" Background="#F4F6FA">
    <StackPanel>
      <TextBlock Text="把零散收获，慢慢收好。" FontSize="25" FontWeight="Bold" Foreground="#202A44"/>
      <TextBlock Text="首次使用，选一个适合你的方式。" Margin="0,10,0,20" Foreground="#566079"/>
      <Border Background="White" CornerRadius="12" Padding="18">
        <StackPanel>
          <RadioButton x:Name="DesktopMode" GroupName="Mode" IsChecked="True" Content="仅电脑使用" FontWeight="Bold"/>
          <TextBlock Text="适合先体验。只允许本机访问，不需要安装额外依赖。" TextWrapping="Wrap" Margin="22,7,0,18" Foreground="#566079"/>
          <RadioButton x:Name="AndroidMode" GroupName="Mode" Content="电脑 + Android 同步" FontWeight="Bold"/>
          <TextBlock Text="允许同一 Wi-Fi 的手机连接，自动生成口令；随包已带二维码依赖时不用联网。手机端仍需安装 APK。" TextWrapping="Wrap" Margin="22,7,0,0" Foreground="#566079"/>
        </StackPanel>
      </Border>
      <StackPanel Orientation="Horizontal" Margin="0,18,0,0">
        <TextBlock Text="服务端口" VerticalAlignment="Center"/>
        <TextBox x:Name="PortInput" Text="8642" Width="90" Padding="7,4" Margin="16,0,12,0"/>
        <TextBlock Text="通常保持默认即可" VerticalAlignment="Center" Foreground="#69738A"/>
      </StackPanel>
      <TextBlock Text="文献默认放在项目内 papers/。已有文献库请先恢复原配置，再启动，避免误用新目录。" TextWrapping="Wrap" Margin="0,15,0,0" Foreground="#69738A" FontSize="12"/>
      <Border Background="#E9EEF8" CornerRadius="8" Padding="12" Margin="0,16,0,0">
        <TextBlock x:Name="SetupStatus" Text="会检查 Node.js、端口和依赖。配置仅保存在本机。" TextWrapping="Wrap" Foreground="#34496D" MinHeight="42"/>
      </Border>
      <ProgressBar x:Name="SetupProgress" Height="4" IsIndeterminate="True" Visibility="Collapsed" Margin="0,10,0,0"/>
      <Grid Margin="0,20,0,0">
        <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
        <Button x:Name="NodeWebsite" Content="安装 Node.js" Padding="10,9" HorizontalAlignment="Left"/>
        <Button x:Name="SetupCancel" Grid.Column="1" Content="暂不启动" Padding="14,9" Margin="0,0,10,0"/>
        <Button x:Name="SetupCreate" Grid.Column="2" Content="完成设置并启动" Padding="14,9" Background="#4263EB" Foreground="White"/>
      </Grid>
    </StackPanel>
  </Border>
</Window>
'@
}

function Resolve-FirstRunNode {
  param([string]$ProjectRoot = '')
  if (-not $ProjectRoot) { $ProjectRoot = $PSScriptRoot }
  # 免安装包自带运行时：先用它，不用装 Node.js
  $bundled = Join-Path $ProjectRoot 'runtime\node.exe'
  if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
  $found = Get-Command node -ErrorAction SilentlyContinue
  if ($found) { return $found.Source }
  # 安装 Node 后不用重启整台电脑，也能从默认安装目录重新检测。
  foreach ($candidate in @((Join-Path $env:ProgramFiles 'nodejs\node.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

function New-FirstRunWindow {
  param([string]$ProjectRoot = $PSScriptRoot)
  Add-Type -AssemblyName PresentationFramework
  Add-Type -AssemblyName PresentationCore
  Add-Type -AssemblyName WindowsBase
  $window = [Windows.Markup.XamlReader]::Parse((Get-FirstRunXaml))
  $ui = @{ Window = $window; Busy = $false; Process = $null; Root = $ProjectRoot }
  $ui.NodeResolver = ${function:Resolve-FirstRunNode}
  foreach ($name in @('DesktopMode', 'AndroidMode', 'PortInput', 'SetupStatus', 'SetupProgress', 'NodeWebsite', 'SetupCancel', 'SetupCreate')) {
    $ui[$name] = $window.FindName($name)
  }
  # 自带运行时的免安装包：不用装 Node.js
  $bundledNode = Join-Path $ProjectRoot 'runtime\node.exe'
  if (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
    $ui.NodeWebsite.Content = '打开 Node.js 官网'
    $ui.SetupStatus.Text = '已找到随包自带的运行环境，不用安装 Node.js。配置仅保存在本机。'
  }
  $window.Tag = $false
  $timer = New-Object Windows.Threading.DispatcherTimer
  $timer.Interval = [TimeSpan]::FromMilliseconds(200)
  $ui.Timer = $timer
  $timer.Add_Tick({
    if (-not $ui.Process -or -not $ui.Process.HasExited) { return }
    $ui.Timer.Stop()
    $process = $ui.Process
    try {
      $raw = $process.StandardOutput.ReadToEnd()
      $diagnostic = $process.StandardError.ReadToEnd()
      $result = $raw | ConvertFrom-Json
      if ($process.ExitCode -eq 0 -and $result.ok) {
        $ui.Window.Tag = $true
        $ui.Busy = $false
        $ui.Window.DialogResult = $true
        return
      }
      $ui.SetupStatus.Text = if ($result.error) { $result.error } else { '未能完成设置，请确认 Node.js 版本和项目文件完整，再重试。' }
    } catch {
      $ui.SetupStatus.Text = '未能完成设置。请安装 Node.js 18 或以上版本，并确认项目目录可写，再重试。'
    } finally {
      $process.Dispose()
      $ui.Process = $null
      $ui.Busy = $false
      $ui.SetupProgress.Visibility = 'Collapsed'
      foreach ($name in @('DesktopMode', 'AndroidMode', 'PortInput', 'SetupCreate', 'SetupCancel')) { $ui[$name].IsEnabled = $true }
    }
  }.GetNewClosure())
  $ui.SetupCreate.Add_Click({
    if ($ui.Busy) { return }
    $nodePath = & $ui.NodeResolver $ui.Root
    if (-not $nodePath) {
      $ui.SetupStatus.Text = '没找到可用的 Node.js。请点「打开 Node.js 官网」安装 LTS 版后重试，或使用自带运行时的免安装包。'
      return
    }
    $portValue = 0
    if (-not [int]::TryParse($ui.PortInput.Text.Trim(), [ref]$portValue) -or $portValue -lt 1 -or $portValue -gt 65535) {
      $ui.SetupStatus.Text = '端口需要是 1 到 65535 的整数。'
      return
    }
    $mode = if ($ui.AndroidMode.IsChecked) { 'android' } else { 'desktop' }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $nodePath
    $info.Arguments = '"{0}" create {1} {2}' -f (Join-Path $ui.Root 'tools\first-run.mjs'), $mode, $portValue
    $info.WorkingDirectory = $ui.Root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    try {
      $ui.Process = [Diagnostics.Process]::Start($info)
      $ui.Busy = $true
      $ui.SetupStatus.Text = if ($mode -eq 'android') { '正在检查端口和二维码依赖；首次下载可能需要几分钟，请保持联网。' } else { '正在检查环境并生成本机配置…' }
      $ui.SetupProgress.Visibility = 'Visible'
      foreach ($name in @('DesktopMode', 'AndroidMode', 'PortInput', 'SetupCreate', 'SetupCancel')) { $ui[$name].IsEnabled = $false }
      $ui.Timer.Start()
    } catch { $ui.SetupStatus.Text = '无法启动 Node.js，请安装后重试。' }
  }.GetNewClosure())
  $ui.NodeWebsite.Add_Click({ Start-Process 'https://nodejs.org/' }.GetNewClosure())
  $ui.SetupCancel.Add_Click({ $ui.Window.Close() }.GetNewClosure())
  $window.Add_Closing({ param($sender, $eventArgs)
    if ($ui.Busy) { $eventArgs.Cancel = $true; $ui.SetupStatus.Text = '设置仍在进行，请等待结束；依赖下载需要网络连接。' }
    else { $ui.Timer.Stop() }
  }.GetNewClosure())
  return $window
}

function Show-FirstRunSetup {
  param([string]$ProjectRoot = $PSScriptRoot)
  $configPath = Join-Path $ProjectRoot 'config.json'
  if (Test-Path -LiteralPath $configPath) {
    try {
      $existing = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
      if ($existing -isnot [pscustomobject]) { throw 'Invalid configuration' }
      if ($null -ne $existing.port) {
        $existingPort = 0
        if (-not [int]::TryParse([string]$existing.port, [ref]$existingPort) -or $existingPort -lt 1 -or $existingPort -gt 65535) { throw 'Invalid port' }
      }
      return $true
    } catch {
      Add-Type -AssemblyName PresentationFramework
      [Windows.MessageBox]::Show('已有 config.json 无法读取或端口无效。请先检查原配置；引导不会覆盖它，也不会启动服务。', '拾穗集：请检查本机配置') | Out-Null
      return $false
    }
  }
  $window = New-FirstRunWindow -ProjectRoot $ProjectRoot
  $null = $window.ShowDialog()
  return [bool]$window.Tag
}

if ($MyInvocation.InvocationName -ne '.') {
  if (Show-FirstRunSetup) { Write-Host '本机配置已就绪；双击 start.bat 可启动拾穗集。' }
}
