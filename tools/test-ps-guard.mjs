/**
 * 拾穗集 —— 端口占用时的「进程归属门禁」自测
 * 用法：node tools/test-ps-guard.mjs
 *
 * 覆盖四种情况（全部用临时目录 + 随机端口，绝不碰用户真实的 8642 服务）：
 *   1) 端口被无关程序占用          → 必须拒绝结束它，进程还活着，并给出中文提示
 *   2) 端口被「像但不是」的程序占用 → 同样拒绝（/api/health 有 200，但没有 app=shisuiji）
 *   3) 确认属于本项目的实例         → 允许停止（命令行带本项目 server.js 路径）
 *   4) 手动 `node server.js` 起的实例 → 允许停止（相对路径，拒绝自动停止）
 *
 * 断言失败 → 退出码非 0。
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const libSrc = path.join(repoRoot, 'lib.ps1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
let passed = 0;
const failures = [];

function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  ✗ ${name}`);
    console.error(`    ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function portOwners(port) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique) -join ','`],
    { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// PowerShell 单引号字符串里，单引号要写两遍
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function waitPort(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise((resolve) => {
      const s = net.connect({ port, host: '127.0.0.1' });
      const done = (v) => { try { s.destroy(); } catch { /* ignore */ } resolve(v); };
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
      setTimeout(() => done(false), 500);
    });
    if (up) return true;
    await sleep(150);
  }
  return false;
}

async function waitGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return !pidAlive(pid);
}

function startNode(args, opts) {
  const child = spawn('node', args, { stdio: 'ignore', ...opts });
  children.push(child);
  return child;
}

const FIXTURES = {
  // 占用端口的无关程序：什么健康检查都不提供
  'foreign.js': `
const http = require('http');
const port = Number(process.argv[2]);
http.createServer((req, res) => { res.writeHead(404); res.end('not danji'); })
  .listen(port, '127.0.0.1');
`,
  // 「像但不是」拾穗集的程序：/api/health 有 200，但没有 app=shisuiji 标识
  'lookalike.js': `
const http = require('http');
const port = Number(process.argv[2]);
http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, app: 'not-shisuiji' }));
    return;
  }
  res.writeHead(404); res.end('nope');
}).listen(port, '127.0.0.1');
`,
};

// 放在「项目目录」里的假 server.js：--no-marker 可关掉 app=shisuiji 标识
// 端口优先取命令行参数；没有就读同目录 config.json（跟真实 server.js 一样）
const FAKE_SERVER = `
const http = require('http');
const fs = require('fs');
const path = require('path');
let port = Number(process.argv[2] || 0);
if (!port) {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  port = Number(cfg.port);
}
const withMarker = !process.argv.includes('--no-marker');
http.createServer((req, res) => {
  if (withMarker && req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, app: 'shisuiji' }));
    return;
  }
  res.writeHead(404); res.end('nope');
}).listen(port, '127.0.0.1');
`;

// 探针脚本：dot-source 临时 lib.ps1，跑指定动作，把结果写成 JSON 文件
const PROBE = `
param([string]$Mode = 'status', [string]$ResultFile = '')
. (Join-Path $PSScriptRoot 'lib.ps1')
$res = @{}
switch ($Mode) {
  'stop' {
    $owner = Get-PortOwner
    $res['state'] = [string]$owner.State
    $res['pid'] = $owner.Pid
    $res['ok'] = [bool](Stop-Server)
    $res['message'] = [string](Get-LastStopMessage)
  }
  'start' {
    $res['ok'] = [bool](Start-Server)
    $res['message'] = [string](Get-LastStartMessage)
  }
  'status' {
    $owner = Get-PortOwner
    $res['state'] = [string]$owner.State
    $res['pid'] = $owner.Pid
    $res['serverPid'] = Get-ServerPid
    $res['identity'] = [bool](Test-ServerIdentity)
  }
}
$json = $res | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($ResultFile, $json, (New-Object System.Text.UTF8Encoding($false)))
`;

function runProbe(ctx, mode) {
  const resultFile = path.join(ctx.projDir, `result-${mode}.json`);
  if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(ctx.projDir, 'probe.ps1'), '-Mode', mode, '-ResultFile', resultFile],
    { encoding: 'utf8', env: { ...process.env, DANJI_PAPERS_DIR: ctx.papersDir } });
  if (!fs.existsSync(resultFile)) {
    throw new Error(`探针 ${mode} 没有产出结果（exit=${r.status}）\n${r.stdout || ''}\n${r.stderr || ''}`);
  }
  const raw = fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

async function main() {
  // 临时目录名里故意带空格：真实项目路径就带空格，命令行引用与解析都要覆盖
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'danji guard '));
  const projDir = path.join(tmpRoot, 'proj');
  const otherDir = path.join(tmpRoot, 'other');
  const papersDir = path.join(tmpRoot, 'papers');
  for (const d of [projDir, otherDir, papersDir]) fs.mkdirSync(d);

  // 临时「项目」：lib.ps1 副本 + 独立 config.json（随机端口）+ 假 server.js
  fs.copyFileSync(libSrc, path.join(projDir, 'lib.ps1'));
  fs.writeFileSync(path.join(projDir, 'server.js'), FAKE_SERVER);
  fs.writeFileSync(path.join(projDir, 'probe.ps1'), PROBE);
  for (const [name, src] of Object.entries(FIXTURES)) {
    fs.writeFileSync(path.join(otherDir, name), src);
  }

  const port = await freePort();
  fs.writeFileSync(path.join(projDir, 'config.json'),
    JSON.stringify({ port, host: '127.0.0.1', sync: { token: '' } }, null, 2));
  const ctx = { tmpRoot, projDir, otherDir, papersDir, port };

  const ownersBefore = portOwners(8642);
  console.log(`  · 测试端口 ${port}（临时目录 ${tmpRoot}）`);
  console.log(`  · 真实 8642 当前占用者：${ownersBefore || '(无)'}`);
  assert.notEqual(port, 8642, '测试端口不能是 8642');

  // ---- 场景 1：端口被无关程序占用 ----
  console.log('\n场景 1：端口被无关程序占用');
  const foreign = startNode([path.join(otherDir, 'foreign.js'), String(port)]);
  assert.ok(await waitPort(port), '无关程序没有监听到测试端口');
  const foreignPid = foreign.pid;

  let res = runProbe(ctx, 'status');
  ok('状态：端口归属判为 Foreign', () => {
    assert.equal(res.state, 'Foreign');
  });
  ok('状态：Get-ServerPid 不再把别人的进程当拾穗集', () => {
    assert.equal(res.serverPid ?? null, null);
  });
  ok('状态：身份校验不通过（状态灯不会误报为运行中）', () => {
    assert.equal(res.identity, false);
  });

  res = runProbe(ctx, 'stop');
  ok('停止：拒绝结束无关程序', () => {
    assert.equal(res.ok, false);
    assert.equal(res.state, 'Foreign');
  });
  ok('停止：无关进程仍然活着', () => {
    assert.equal(pidAlive(foreignPid), true);
  });
  ok('停止：给出明确中文提示（端口/占用/不会结束/怎么办）', () => {
    const m = res.message || '';
    assert.ok(m.includes('端口'), `提示里没有说明端口：${m}`);
    assert.ok(m.includes('占用'), `提示里没有说明被占用：${m}`);
    assert.ok(m.includes('不会'), `提示里没有说明不会去结束它：${m}`);
    assert.ok(m.includes(String(foreignPid)), `提示里没有给出 PID：${m}`);
  });

  res = runProbe(ctx, 'start');
  ok('启动：端口被占时不启动、也不结束无关程序', () => {
    assert.equal(res.ok, false);
    assert.ok((res.message || '').includes('端口'));
  });
  ok('启动：无关进程仍然活着', () => {
    assert.equal(pidAlive(foreignPid), true);
  });

  try { foreign.kill(); } catch { /* ignore */ }
  await waitGone(foreignPid);

  // ---- 场景 2：端口被「像但不是」拾穗集的程序占用 ----
  console.log('\n场景 2：端口被「像但不是」拾穗集的程序占用');
  const lookalike = startNode([path.join(otherDir, 'lookalike.js'), String(port)]);
  assert.ok(await waitPort(port), '仿冒程序没有监听到测试端口');
  const lookalikePid = lookalike.pid;

  res = runProbe(ctx, 'status');
  ok('状态：健康检查有 200 也不算拾穗集', () => {
    assert.equal(res.state, 'Foreign');
    assert.equal(res.identity, false);
    assert.equal(res.serverPid ?? null, null);
  });
  res = runProbe(ctx, 'stop');
  ok('停止：无法确认归属 → 拒绝结束', () => {
    assert.equal(res.ok, false);
    assert.equal(res.state, 'Foreign');
  });
  ok('停止：仿冒进程仍然活着', () => {
    assert.equal(pidAlive(lookalikePid), true);
  });
  try { lookalike.kill(); } catch { /* ignore */ }
  await waitGone(lookalikePid);

  // ---- 场景 3：命令行带本项目 server.js 路径的实例 ----
  console.log('\n场景 3：命令行带本项目 server.js 路径的实例');
  const projectProc = startNode([path.join(projDir, 'server.js'), String(port), '--no-marker']);
  assert.ok(await waitPort(port), '项目实例没有监听到测试端口');
  const projectPid = projectProc.pid;

  res = runProbe(ctx, 'status');
  ok('状态：识别为本项目实例', () => {
    assert.equal(res.state, 'Project');
    assert.equal(res.serverPid, projectPid);
    assert.equal(res.identity, true);
  });
  res = runProbe(ctx, 'stop');
  ok('停止：允许停止本项目实例', () => {
    assert.equal(res.ok, true);
    assert.ok((res.message || '').includes('已停止'));
  });
  const gone = await waitGone(projectPid);
  ok('停止：本项目进程确实被结束', () => {
    assert.equal(gone, true);
  });


  // 相对路径启动不能证明工作目录；产品健康标识不能作为停止凭证。
  console.log('\n场景 4：无法确认的手动实例与其他项目副本');
  const manual = startNode(['server.js', String(port)], { cwd: projDir });
  assert.ok(await waitPort(port));
  res = runProbe(ctx, 'status');
  ok('相对路径实例归属无法证明时拒绝认领', () => assert.equal(res.state, 'Foreign'));
  res = runProbe(ctx, 'stop');
  ok('不能仅凭产品健康标识停止实例', () => assert.equal(res.ok, false));
  ok('手动实例未被结束', () => assert.ok(pidAlive(manual.pid)));
  manual.kill(); await waitGone(manual.pid);

  fs.writeFileSync(path.join(otherDir, 'server.js'), FAKE_SERVER);
  const otherCopy = startNode([path.join(otherDir, 'server.js'), String(port)]);
  assert.ok(await waitPort(port));
  res = runProbe(ctx, 'status');
  ok('另一个目录的拾穗集不能被认作当前项目', () => assert.equal(res.state, 'Foreign'));
  res = runProbe(ctx, 'stop');
  ok('拒绝停止另一个同名副本', () => assert.equal(res.ok, false));
  ok('另一个同名副本保持运行', () => assert.ok(pidAlive(otherCopy.pid)));
  otherCopy.kill(); await waitGone(otherCopy.pid);

  const queryScript = path.join(projDir, 'query-failure.ps1');
  fs.writeFileSync(queryScript, ". (Join-Path $PSScriptRoot 'lib.ps1')\nfunction Get-NetTCPConnection { throw 'fixture denied' }\n(Get-PortOwner).State");
  const query = spawnSync('powershell', ['-NoProfile','-ExecutionPolicy','Bypass','-File',queryScript], {encoding:'utf8', windowsHide:true});
  ok('查询进程失败不能假称端口空闲', () => assert.equal(query.stdout.trim(), 'Unknown'));

  // ---- 场景 5：CLI（control.ps1）层面 ----
  console.log('\n场景 5：CLI control.ps1 层面');
  fs.copyFileSync(path.join(repoRoot, 'control.ps1'), path.join(projDir, 'control.ps1'));
  const cli = startNode([path.join(otherDir, 'foreign.js'), String(port)]);
  assert.ok(await waitPort(port), 'CLI 场景：无关程序没有监听到测试端口');
  const cliPid = cli.pid;

  const cliRun = (action) => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & ${psQuote(path.join(projDir, 'control.ps1'))} ${action}`],
    { encoding: 'utf8', env: { ...process.env, DANJI_PAPERS_DIR: papersDir } });

  const cliStop = cliRun('stop');
  const cliStopOut = `${cliStop.stdout || ''}${cliStop.stderr || ''}`;
  ok('CLI stop：退出码非 0', () => {
    assert.notEqual(cliStop.status, 0);
  });
  ok('CLI stop：输出中文提示（端口被别的程序占用 / 不会去结束它）', () => {
    assert.ok(cliStopOut.includes('端口'), cliStopOut);
    assert.ok(cliStopOut.includes('不会'), cliStopOut);
  });
  ok('CLI stop：无关进程仍然活着', () => {
    assert.equal(pidAlive(cliPid), true);
  });

  const cliStart = cliRun('start');
  const cliStartOut = `${cliStart.stdout || ''}${cliStart.stderr || ''}`;
  ok('CLI start：端口被占时不启动、退出码非 0', () => {
    assert.notEqual(cliStart.status, 0);
    assert.ok(cliStartOut.includes('端口'), cliStartOut);
  });
  ok('CLI start：无关进程仍然活着', () => {
    assert.equal(pidAlive(cliPid), true);
  });

  const cliStatus = cliRun('status');
  ok('CLI status：不再把别人的服务报成 running', () => {
    const lines = String(cliStatus.stdout || '').trim().split(/\r?\n/).filter(Boolean);
    assert.ok(lines.length > 0 && lines[lines.length - 1].includes('stopped'), cliStatus.stdout);
  });

  try { cli.kill(); } catch { /* ignore */ }
  await waitGone(cliPid);

  // ---- 场景 6：真实启动路径（lib.ps1 的 Start-Server 自己拉起进程）----
  console.log('\n场景 6：Start-Server 自己拉起的实例');
  res = runProbe(ctx, 'start');
  ok('启动：端口空闲时能拉起服务', () => {
    assert.equal(res.ok, true);
  });
  await waitPort(port);
  res = runProbe(ctx, 'status');
  ok('状态：自己拉起的进程被识别为本项目实例', () => {
    assert.equal(res.state, 'Project');
    assert.equal(res.identity, true);
    assert.ok(res.serverPid > 0);
  });
  const startedPid = res.serverPid;
  res = runProbe(ctx, 'stop');
  ok('停止：允许停止自己拉起的实例', () => {
    assert.equal(res.ok, true);
  });
  const startedGone = await waitGone(startedPid);
  ok('停止：自己拉起的进程确实被结束', () => {
    assert.equal(startedGone, true);
  });

  // ---- 收尾：清理 + 确认没碰过 8642 ----
  const ownersAfter = portOwners(8642);
  ok('真实 8642 的占用者全程未被本测试改动', () => {
    assert.equal(ownersAfter, ownersBefore);
  });

  return ctx;
}

let ctx = null;
try {
  ctx = await main();
} catch (err) {
  console.error('\n✗ test-ps-guard：测试异常中断');
  console.error(err);
  process.exitCode = 1;
} finally {
  for (const c of children) {
    try { c.kill(); } catch { /* ignore */ }
  }
  if (ctx) {
    await sleep(300);
    try { fs.rmSync(ctx.tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

if (process.exitCode) {
  console.error(`\n✗ test-ps-guard：有失败（通过 ${passed}）`);
} else {
  console.log(`\n✓ test-ps-guard：${passed} 项通过`);
}
