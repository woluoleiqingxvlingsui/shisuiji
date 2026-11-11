# Real WPF controls, synthetic directories only. No service is started.
$ErrorActionPreference = 'Stop'
# Synthetic setup fixtures must not inherit the user's launch overrides. No service starts here.
foreach ($name in @('PORT','DANJI_HOST','DANJI_TOKEN','DANJI_PAPERS_DIR','DANJI_TLS_CERT','DANJI_TLS_KEY')) { Remove-Item ('Env:' + $name) -ErrorAction SilentlyContinue }
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'first-run.ps1')
$temp = Join-Path ([IO.Path]::GetTempPath()) ('danji-setup-ui-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
$passed = 0
try {
  foreach ($case in @('desktop', 'android', 'invalid-port', 'cancel')) {
    $root = Join-Path $temp $case
    New-Item -ItemType Directory -Path (Join-Path $root 'tools') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repo 'tools\first-run.mjs') -Destination (Join-Path $root 'tools')
    Copy-Item -LiteralPath (Join-Path $repo 'tools\qrcode-loader.mjs') -Destination (Join-Path $root 'tools')
    if ($case -eq 'android') {
      $stub = Join-Path $root 'node_modules\qrcode'
      New-Item -ItemType Directory -Path $stub -Force | Out-Null
      [IO.File]::WriteAllText((Join-Path $stub 'index.js'), 'module.exports = {};')
    }
    $portListener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $portListener.Start()
    $port = $portListener.LocalEndpoint.Port
    $portListener.Stop()
    $window = New-FirstRunWindow -ProjectRoot $root
    $watchdog = New-Object Windows.Threading.DispatcherTimer
    $watchdog.Interval = [TimeSpan]::FromSeconds(20)
    $state = @{ Error = ''; Window = $window; Watchdog = $watchdog; Case = $case; Port = $port; Repo = $repo }
    $watchdog.Add_Tick({
      $state.Error = 'Wizard did not finish: ' + $state.Case + ' / ' + $state.Window.FindName('SetupStatus').Text
      $state.Watchdog.Stop()
      $state.Window.Dispatcher.InvokeShutdown()
    }.GetNewClosure())
    $window.Add_Loaded({
      param($sender, $eventArgs)
      try {
        # Capture the real view before changing any sample fields.
        if ($state.Case -eq 'desktop') {
          $sender.UpdateLayout()
          $view = $sender.Content
          $bitmap = New-Object Windows.Media.Imaging.RenderTargetBitmap([int]$view.ActualWidth, [int]$view.ActualHeight, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
          $bitmap.Render($view)
          $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
          $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
          $output = Join-Path $state.Repo 'output\first-run-preview.png'
          $stream = [IO.File]::Create($output)
          try { $encoder.Save($stream) } finally { $stream.Dispose() }
        }
        if ($state.Case -eq 'cancel') {
          $sender.FindName('SetupCancel').RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))
          return
        }
        $sender.FindName('PortInput').Text = if ($state.Case -eq 'invalid-port') { 'bad' } else { [string]$state.Port }
        if ($state.Case -eq 'android') { $sender.FindName('AndroidMode').IsChecked = $true }
        $sender.FindName('SetupCreate').RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))
        if ($state.Case -eq 'invalid-port') {
          if ($sender.FindName('SetupStatus').Text -notmatch '65535') { throw 'Invalid port error missing' }
          $sender.Close()
        }
      } catch { $state.Error = $_.Exception.Message; $sender.Close() }
    }.GetNewClosure())
    $watchdog.Start()
    $null = $window.ShowDialog()
    $watchdog.Stop()
    if ($state.Error) { throw $state.Error }
    $configFile = Join-Path $root 'config.json'
    if ($case -in @('desktop', 'android')) {
      if (-not $window.Tag) { throw "Wizard failed: $case" }
      $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
      $expected = if ($case -eq 'android') { '0.0.0.0' } else { '127.0.0.1' }
      if ($config.host -ne $expected -or $config.port -ne $port) { throw 'Wrong generated settings' }
    } elseif (Test-Path -LiteralPath $configFile) { throw 'Cancel or invalid input created a configuration' }
    $passed++
    Write-Host "PASS WPF $case"
  }
} finally {
  # Verify the deletion target stays in the explicitly created test directory.
  $resolved = [IO.Path]::GetFullPath($temp)
  $expectedParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase) -or
      -not ([IO.Path]::GetFileName($resolved)).StartsWith('danji-setup-ui-')) { throw 'Unsafe temporary target' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Host "PASS $passed first-run WPF scenarios"
