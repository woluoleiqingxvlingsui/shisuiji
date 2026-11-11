# 拾穗集 图形控制台的真实启动验收（隔离临时目录，不碰真实配置/数据/文献库）
# 验证三件事：
#   1) 窗口出现得够快，且刚出现时就能响应消息（不再被同步探活/网卡查询冻住）
#   2) 后台耗时工作（备份）进行期间，窗口仍然能及时处理消息（不会"未响应"）
#   3) 关掉窗口后进程能自己退出（后台运行空间被释放，没有挂着的线程）
# 临时目录里没有 server.js，所以不会真的启动任何服务，也不会碰真实 data/。
# 可选：-SourceDir 指向另一份控制台源码目录（例如 git HEAD 的旧版）做前后对比。
param([string]$SourceDir = '')

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if ($SourceDir) { $repo = (Resolve-Path -LiteralPath $SourceDir).Path }

if (-not ('DanjiWin' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DanjiWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint ms, out IntPtr res);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  public static IntPtr Find(uint pid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len <= 0) return true;
      StringBuilder sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString() == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  // 往窗口发一条 WM_NULL 并等它被处理：返回 true = 窗口的线程还在正常泵消息
  public static bool Ping(IntPtr h, uint ms) {
    IntPtr res;
    return SendMessageTimeout(h, 0, IntPtr.Zero, IntPtr.Zero, 2, ms, out res) != IntPtr.Zero;
  }
  public static string[] Titles(uint pid) {
    System.Collections.Generic.List<string> list = new System.Collections.Generic.List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid) {
        int len = GetWindowTextLength(h);
        StringBuilder sb = new StringBuilder(len + 1);
        GetWindowText(h, sb, sb.Capacity);
        list.Add(sb.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
  public static bool Click(int x, int y) {
    if (!SetCursorPos(x, y)) return false;
    System.Threading.Thread.Sleep(80);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(50);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
    return true;
  }
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  public static void Foreground(IntPtr h) { SetForegroundWindow(h); }
}
'@
}

function Get-Window([int]$ProcessId, [string]$Title) {
  return [DanjiWin]::Find([uint32]$ProcessId, $Title)
}

function Wait-Window {
  param([int]$ProcessId, [string]$Title, [int]$TimeoutSeconds = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $h = Get-Window -ProcessId $ProcessId -Title $Title
    if ($h -ne [IntPtr]::Zero) { return $h }
    Start-Sleep -Milliseconds 50
  }
  return [IntPtr]::Zero
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ('danji-control-ui-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
$proc = $null
try {
  # 合成一个"项目目录"：只有控制台需要的文件，故意不放 server.js
  foreach ($name in @('lib.ps1', 'control-ui.ps1', 'first-run.ps1')) {
    Copy-Item -LiteralPath (Join-Path $repo $name) -Destination (Join-Path $temp $name)
  }
  $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = $listener.LocalEndpoint.Port
  $listener.Stop()
  [IO.File]::WriteAllText((Join-Path $temp 'config.json'),
    ('{"host":"127.0.0.1","port":' + $port + ',"sync":{"token":""}}'))
  # 合成 backup.ps1：睡 4 秒当作耗时工作，全程不碰真实 data/
  [IO.File]::WriteAllText((Join-Path $temp 'backup.ps1'),
    "Start-Sleep -Seconds 4`nWrite-Host 'isolated backup done'`nexit 0`n")

  $outLog = Join-Path $temp 'stdout.log'
  $errLog = Join-Path $temp 'stderr.log'
  $argLine = '-NoProfile -ExecutionPolicy Bypass -STA -File "' + (Join-Path $temp 'control-ui.ps1') + '"'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $proc = Start-Process -FilePath (Get-Command powershell).Source -ArgumentList $argLine `
    -WorkingDirectory $temp -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru

  # 1) 窗口要尽快出现
  $hwnd = Wait-Window -ProcessId $proc.Id -Title '拾穗集 控制台' -TimeoutSeconds 30
  if ($hwnd -eq [IntPtr]::Zero) {
    $err = if (Test-Path $errLog) { Get-Content $errLog -Raw } else { '' }
    throw "控制台窗口没有出现。stderr: $err"
  }
  $showMs = $sw.ElapsedMilliseconds
  Write-Host ("窗口出现耗时: {0} ms" -f $showMs)
  if ($showMs -gt 12000) { throw "窗口出现太慢（$showMs ms），启动仍在被同步操作阻塞" }

  # 刚出现时就要能处理消息（探活还在后台跑，界面不该是冻的）
  $ping0 = [Diagnostics.Stopwatch]::StartNew()
  $alive = [DanjiWin]::Ping($hwnd, 1500)
  $ping0.Stop()
  if (-not $alive) { throw '窗口刚出现就无响应（启动阶段仍有同步阻塞）' }
  Write-Host ("窗口出现后首次消息往返: {0} ms" -f $ping0.ElapsedMilliseconds)

  # 2) 后台耗时工作期间窗口仍可响应：点「备份数据」（合成脚本睡 4 秒）
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $backupButton = $null
  foreach ($el in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($el.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $el.Current.Name -like '*备份*') {
      $backupButton = $el
      break
    }
  }
  if (-not $backupButton) { throw '找不到「备份数据」按钮' }
  # 点击放到后台线程做：UIA 的 Invoke() 会等按钮处理完才返回，
  # 放前台线程做就等于“等活干完再测”，测不出干活期间卡不卡。
  $clickShell = [powershell]::Create()
  $null = $clickShell.AddScript({
    param([int]$h)
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$h)
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button)
    foreach ($b in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
      if ($b.Current.Name -like '*备份*') {
        $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        return 'clicked'
      }
    }
    return 'not-found'
  })
  $null = $clickShell.AddArgument([int]$hwnd.ToInt64())
  $null = $clickShell.BeginInvoke()

  $busy = [Diagnostics.Stopwatch]::StartNew()
  $pings = 0
  $worst = 0
  while ($busy.Elapsed.TotalSeconds -lt 5) {
    $one = [Diagnostics.Stopwatch]::StartNew()
    $ok = [DanjiWin]::Ping($hwnd, 1000)
    $one.Stop()
    if ($ok) {
      $pings++
      if ($one.ElapsedMilliseconds -gt $worst) { $worst = $one.ElapsedMilliseconds }
    } else {
      $worst = 9999
    }
    Start-Sleep -Milliseconds 40
  }
  Write-Host ("耗时任务期间: 成功消息往返 {0} 次，最慢 {1} ms" -f $pings, $worst)
  if ($pings -lt 3) { throw "耗时工作期间窗口基本没有响应（成功往返仅 $pings 次），说明工作跑在了界面线程上" }
  if ($worst -ge 900) { throw "耗时工作期间窗口卡住（最慢往返 $worst ms）" }
  try { $clickShell.Dispose() } catch { }

  # 备份结束的弹窗要能正常出现并被关掉
  $dialog = [IntPtr]::Zero
  $dialogWait = [Diagnostics.Stopwatch]::StartNew()
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    $dialog = Get-Window -ProcessId $proc.Id -Title '拾穗集 备份'
    if ($dialog -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 100
  }
  Write-Host ("备份弹窗出现耗时: {0} ms" -f $dialogWait.ElapsedMilliseconds)
  if ($dialog -eq [IntPtr]::Zero) {
    $texts = @()
    foreach ($el in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
      if ($el.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and $el.Current.Name) { $texts += $el.Current.Name }
    }
    $out = if (Test-Path $outLog) { Get-Content $outLog -Raw } else { '' }
    $err = if (Test-Path $errLog) { Get-Content $errLog -Raw } else { '' }
    throw "备份完成的弹窗没有出现（点击可能没生效）。进程窗口: $([DanjiWin]::Titles([uint32]$proc.Id) -join ' / ')。界面文字: $($texts -join ' | ')。stdout: $out / stderr: $err"
  }
  [DanjiWin]::PostMessage($dialog, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  Start-Sleep -Milliseconds 400
  if (-not [DanjiWin]::Ping($hwnd, 1500)) { throw '关闭弹窗后控制台窗口失去响应' }

  # 3) 关窗后进程要能自己退出（后台运行空间/线程都被释放）
  $exitSw = [Diagnostics.Stopwatch]::StartNew()
  [DanjiWin]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  if (-not $proc.WaitForExit(20000)) {
    throw '关闭控制台窗口后进程没有退出（后台资源没有释放）'
  }
  $exitSw.Stop()
  Write-Host ("关闭后进程退出耗时: {0} ms" -f $exitSw.ElapsedMilliseconds)

  # 隔离目录里没有 server.js，不应该有任何服务进程被拉起来
  $started = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$temp*" }
  if ($started) { throw '测试意外启动了服务进程' }

  $err = if (Test-Path $errLog) { Get-Content $errLog -Raw } else { '' }
  if ($err -and $err -match 'Exception') { throw "控制台窗口有未处理异常: $err" }
  Write-Host 'PASS 控制台启动快、耗时工作期间可响应、关窗后干净退出'
} finally {
  if ($proc -and -not $proc.HasExited) {
    try { $proc.Kill() } catch { }
    try { $proc.WaitForExit(5000) | Out-Null } catch { }
  }
  # 只删自己刚建的临时目录
  $resolved = [IO.Path]::GetFullPath($temp)
  $expectedParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if ($resolved.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase) -and
      [IO.Path]::GetFileName($resolved).StartsWith('danji-control-ui-')) {
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
  }
}
