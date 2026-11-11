# 拾穗集 运行时与本机偏好
# 1) 找 Node：先找随包自带的 runtime\node.exe，找不到再回落系统 PATH 里的 node。
# 2) 只在当前进程里把运行时目录放到 PATH 最前面，保证 node/npm 子进程用同一个 Node；
#    绝不修改系统环境变量、注册表或用户 PATH。
# 3) 本机偏好（协议 auto / http / https）写在 runtime-options.json：
#    这是本机文件，不入库、不打包（.gitignore 与 release-files.json 都已排除）。
#
# 兼容 PowerShell 5.1：不用三元表达式、不用 ??、不用 [System.IO.Path]::GetRelativePath。

$script:DanjiRuntimeProjectRoot = $null

# 项目根目录（本文件所在目录）
function Get-DanjiProjectRoot {
  if ($script:DanjiRuntimeProjectRoot) { return $script:DanjiRuntimeProjectRoot }
  $root = $null
  if ($PSScriptRoot) { $root = $PSScriptRoot }
  elseif ($MyInvocation.MyCommand.Path) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
  else { $root = (Get-Location).Path }
  $script:DanjiRuntimeProjectRoot = $root
  return $root
}

# 找到可用的 Node：随包自带优先，其次系统安装
function Get-DanjiRuntime {
  param([string]$ProjectRoot = '')
  if (-not $ProjectRoot) { $ProjectRoot = (Get-DanjiProjectRoot) }
  $bundleDir = Join-Path $ProjectRoot 'runtime'
  $bundleNode = Join-Path $bundleDir 'node.exe'
  if (Test-Path -LiteralPath $bundleNode -PathType Leaf) {
    $npmCli = Join-Path $bundleDir 'node_modules\npm\bin\npm-cli.js'
    $npmCmd = Join-Path $bundleDir 'npm.cmd'
    return @{
      Node    = $bundleNode
      NodeDir = $bundleDir
      Bundled = $true
      Source  = 'bundled'
      NpmCli  = $(if (Test-Path -LiteralPath $npmCli -PathType Leaf) { $npmCli } else { $null })
      NpmCmd  = $(if (Test-Path -LiteralPath $npmCmd -PathType Leaf) { $npmCmd } else { $null })
    }
  }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) {
    $nodeDir = Split-Path -Parent $cmd.Source
    $npmCli = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
    $npmCmd = Join-Path $nodeDir 'npm.cmd'
    return @{
      Node    = $cmd.Source
      NodeDir = $nodeDir
      Bundled = $false
      Source  = 'system'
      NpmCli  = $(if (Test-Path -LiteralPath $npmCli -PathType Leaf) { $npmCli } else { $null })
      NpmCmd  = $(if (Test-Path -LiteralPath $npmCmd -PathType Leaf) { $npmCmd } else { $null })
    }
  }
  return $null
}

# 让当前进程（以及它启动的 node/npm 子进程）统一用这个运行时。
# 只改本进程的 $env:PATH，不动系统设置。
function Use-DanjiRuntime {
  param([string]$ProjectRoot = '')
  $rt = Get-DanjiRuntime -ProjectRoot $ProjectRoot
  if (-not $rt) { return $null }
  $dir = $rt.NodeDir
  $parts = @()
  if ($env:PATH) { $parts = @($env:PATH -split ';' | Where-Object { $_ -and $_.Trim() }) }
  $parts = @($parts | Where-Object { $_.Trim().TrimEnd('\') -ine $dir.TrimEnd('\') })
  $env:PATH = ($dir + ';' + ($parts -join ';'))
  return $rt
}

# node 可执行文件路径（找不到返回 $null）
function Get-DanjiNodePath {
  param([string]$ProjectRoot = '')
  $rt = Get-DanjiRuntime -ProjectRoot $ProjectRoot
  if ($rt) { return $rt.Node }
  return $null
}

# npm 怎么调：优先 npm-cli.js（和 node 同一个运行时），其次 npm.cmd
function Get-DanjiNpmInvocation {
  param([string]$ProjectRoot = '')
  $rt = Get-DanjiRuntime -ProjectRoot $ProjectRoot
  if (-not $rt) { return $null }
  if ($rt.NpmCli) {
    return @{ Kind = 'cli'; File = $rt.Node; Args = @($rt.NpmCli); Root = $rt.NodeDir }
  }
  if ($rt.NpmCmd) {
    return @{ Kind = 'cmd'; File = $rt.NpmCmd; Args = @(); Root = $rt.NodeDir }
  }
  return $null
}

# 本机偏好文件路径
function Get-DanjiOptionsPath {
  param([string]$ProjectRoot = '')
  if (-not $ProjectRoot) { $ProjectRoot = (Get-DanjiProjectRoot) }
  return (Join-Path $ProjectRoot 'runtime-options.json')
}

# 读协议偏好：auto（默认，有证书走 HTTPS）/ http / https
function Get-DanjiSchemePreference {
  param([string]$ProjectRoot = '')
  $path = Get-DanjiOptionsPath -ProjectRoot $ProjectRoot
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    try {
      $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
      $obj = $raw | ConvertFrom-Json
      $s = ([string]$obj.scheme).Trim().ToLowerInvariant()
      if ($s -eq 'auto' -or $s -eq 'http' -or $s -eq 'https') { return $s }
    } catch { }
  }
  return 'auto'
}

# 写协议偏好（只写本机文件，不碰 config.json / local.env.ps1）
function Set-DanjiSchemePreference {
  param([ValidateSet('auto', 'http', 'https')][string]$Scheme = 'auto', [string]$ProjectRoot = '')
  $path = Get-DanjiOptionsPath -ProjectRoot $ProjectRoot
  $obj = [ordered]@{ scheme = $Scheme; updated_at = (Get-Date).ToString('o') }
  $json = ($obj | ConvertTo-Json -Depth 4)
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $json, $enc)
  return $path
}

function Get-DanjiSchemeLabel([string]$Scheme) {
  if ($Scheme -eq 'http') { return 'HTTP' }
  if ($Scheme -eq 'https') { return 'HTTPS' }
  return '自动'
}
