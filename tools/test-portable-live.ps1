# Exercise an actual release ZIP with no system Node on PATH. Synthetic data only.
param([Parameter(Mandatory=$true)][string]$Archive)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path $repoRoot ('output\portable-live-' + [Guid]::NewGuid().ToString('N'))
$testRoot = [IO.Path]::GetFullPath($testRoot)
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'output')).TrimEnd('\') + '\'
if (-not $testRoot.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture path' }
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$passed = $false
$project = $null
try {
  Expand-Archive -LiteralPath $Archive -DestinationPath $testRoot
  $roots = @(Get-ChildItem -LiteralPath $testRoot -Directory)
  if ($roots.Count -ne 1) { throw 'Expected one release directory' }
  $project = $roots[0].FullName
  foreach ($private in @('config.json','data','papers','local.env.ps1','runtime-options.json')) {
    if (Test-Path -LiteralPath (Join-Path $project $private)) { throw ('Private path in release: ' + $private) }
  }
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0;$env:SystemRoot"
  if (Get-Command node -ErrorAction SilentlyContinue) { throw 'Fixture still sees a system Node' }
  foreach ($name in @('PORT','DANJI_HOST','DANJI_TOKEN','DANJI_PAPERS_DIR','DANJI_TLS_CERT','DANJI_TLS_KEY')) {
    Remove-Item ('Env:' + $name) -ErrorAction SilentlyContinue
  }
  . (Join-Path $project 'first-run.ps1')
  $nodePath = Resolve-FirstRunNode -ProjectRoot $project
  if ($nodePath -ne (Join-Path $project 'runtime\node.exe')) { throw 'First-run did not resolve bundled Node' }
  $socket = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
  $socket.Start(); $fixturePort = $socket.LocalEndpoint.Port; $socket.Stop()
  $setup = & $nodePath (Join-Path $project 'tools\first-run.mjs') create android $fixturePort
  if ($LASTEXITCODE -ne 0) { throw ('First-run failed: ' + ($setup -join ' ')) }
  $fixturePapers = Join-Path $testRoot 'isolated-papers'
  New-Item -ItemType Directory -Path $fixturePapers | Out-Null
  $env:DANJI_PAPERS_DIR = $fixturePapers
  . (Join-Path $project 'maintenance.ps1')
  if (-not (Start-Server)) { throw ('Portable server failed: ' + (Get-LastStartMessage)) }
  $fixtureBase = 'http://127.0.0.1:' + $fixturePort
  $health = Invoke-RestMethod ($fixtureBase + '/api/health')
  if (-not $health.ok) { throw 'No health response' }
  $qrPath = New-PairQrPng
  if (-not $qrPath -or -not (Test-Path -LiteralPath $qrPath)) { throw 'Bundled QR dependency did not work' }
  $body = @{title='Portable synthetic fixture';content='Restore must retain this exact text'} | ConvertTo-Json
  $idea = Invoke-RestMethod ($fixtureBase + '/api/ideas') -Method Post -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body))
  $backup = Invoke-MaintenanceBackup -ProjectRoot $project
  if (-not $backup.Ok -or -not $backup.ServiceRestarted) { throw ('Live backup failed: ' + $backup.Message) }
  Invoke-RestMethod ($fixtureBase + '/api/ideas/' + $idea.id) -Method Delete | Out-Null
  $restored = Invoke-MaintenanceRestore -ProjectRoot $project -BackupPath $backup.BackupPath
  if (-not $restored.Ok -or -not $restored.ServiceRestarted -or -not $restored.SafetyBackupPath) { throw ('Live restore failed: ' + $restored.Message) }
  $ideas = @(Invoke-RestMethod ($fixtureBase + '/api/ideas'))
  if (-not ($ideas | Where-Object { $_.id -eq $idea.id -and $_.content -eq 'Restore must retain this exact text' })) { throw 'Restored note differs from backup' }
  Write-Host 'PASS: no system Node; first-run, service, QR, live backup and restore work in the extracted ZIP.'
  $passed = $true
} finally {
  if ($project -and (Get-Command Get-PortOwner -ErrorAction SilentlyContinue)) {
    $owner = Get-PortOwner
    if ($owner.State -eq 'Project') { $null = Stop-Server }
  }
  if ($passed -and $testRoot.StartsWith($allowedRoot,[StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  } elseif (-not $passed) { Write-Host ('Fixture retained for diagnosis: ' + $testRoot) }
}
