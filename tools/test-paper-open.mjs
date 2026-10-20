/**
 * 拾穗集 —— 文献「打开」回归（Node，无需浏览器）
 * 用法：node tools/test-paper-open.mjs
 *
 * 钉死的规则：
 *   1. 未配置阅读软件时，打开文件不得经过 cmd 解析——文件名里的 & 等元字符
 *      必须原样到达打开通道（spawn 数组参数不经 shell）；
 *   2. 已配置阅读软件的分支行为不变（spawn(reader, [filePath])）。
 *
 * 断言方式：把临时副本里 child_process.spawn 换成「记录调用」的桩
 * （不真的打开任何外部程序），打开后检查日志里的 cmd 与参数。
 *
 * 红线遵守（AGENTS.md §1 §2）：server.js + public/ + lib/ 复制到临时目录再跑；
 * DANJI_PAPERS_DIR 显式指向临时目录；端口随机空闲端口，绝不碰真实 8642；
 * 临时目录用完即删。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

let passed = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name} ${extra}`);
    process.exitCode = 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = { 'Content-Type': 'application/json' };

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'danji-paper-open-'));
const papers = path.join(tmp, 'papers');
fs.mkdirSync(papers, { recursive: true });
for (const item of ['server.js', 'public', 'lib']) {
  fs.cpSync(path.join(REPO, item), path.join(tmp, item), { recursive: true });
}

// 把 spawn 换成记录桩：只记调用，不真的拉起任何外部程序
const serverFile = path.join(tmp, 'server.js');
const serverSource = fs.readFileSync(serverFile, 'utf8');
assert.ok(serverSource.includes("const { spawn, execFile } = require('child_process');"));
const stub = `const { execFile } = require('child_process');
const spawn = (cmd, args) => {
  fs.appendFileSync(process.env.DANJI_OPEN_LOG, JSON.stringify({ cmd, args }) + '\\n');
  return { unref() {}, pid: 0 };
};`;
fs.writeFileSync(serverFile, serverSource.replace(
  "const { spawn, execFile } = require('child_process');", stub));

const openLog = path.join(tmp, 'open.log');
let child = null;
let base = '';
const auth = { ...json };

function startServer(port) {
  child = spawn(process.execPath, ['server.js'], {
    cwd: tmp,
    env: { ...process.env, PORT: String(port), DANJI_HOST: '127.0.0.1', DANJI_PAPERS_DIR: papers, DANJI_TOKEN: '', DANJI_OPEN_LOG: openLog },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));
}

async function waitUp(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

async function post(pathname, body) {
  const res = await fetch(base + pathname, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function openCalls() {
  if (!fs.existsSync(openLog)) return [];
  return fs.readFileSync(openLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

try {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  startServer(port);
  if (!await waitUp()) {
    console.error('✗ 隔离服务未在超时内就绪');
    process.exitCode = 1;
    throw new Error('server not up');
  }
  console.log(`临时实例：${tmp} 端口 ${port}`);

  /* ---------- 1. 未配阅读软件：含 & 的文件名必须完整到达打开通道 ---------- */
  const fileName = 'AT&T白皮书.pdf';
  fs.writeFileSync(path.join(papers, fileName), '%PDF-1.4 fixture');
  const paper = await post('/api/papers', { title: 'AT&T 白皮书', file_name: fileName, category: '测试类别', status: 'to_read' });
  ok('前置：记录创建并归档', paper.status === 201 && paper.body.file_name === fileName, JSON.stringify(paper.body));

  const opened = await post(`/api/papers/${paper.body.id}/open`, {});
  ok('打开请求成功', opened.status === 200 && opened.body.ok === true, JSON.stringify(opened.body));
  const calls = openCalls();
  ok('打开通道被调用恰好一次', calls.length === 1, JSON.stringify(calls));
  const call = calls[0] || {};
  ok('不经过 cmd（无命令注入面/截断）', call.cmd !== 'cmd', JSON.stringify(call));
  ok('走系统默认打开通道 explorer.exe', call.cmd === 'explorer.exe', JSON.stringify(call));
  const target = Array.isArray(call.args) ? call.args[0] : '';
  ok('参数是完整文件路径（含 & 不被截断）', typeof target === 'string' && target.endsWith(fileName),
    JSON.stringify(call.args));
  ok('参数里 & 之后的内容完整（不是被截断的前缀）', typeof target === 'string' && !/AT&[^T]/.test(target) && target.includes('AT&T'),
    JSON.stringify(call.args));
  ok('路径指向论文库内真实文件', typeof target === 'string' && fs.existsSync(target), String(target));

  /* ---------- 2. 已配置阅读软件：原分支行为不变 ---------- */
  const readerPath = path.join(tmp, 'fake-reader.exe');
  fs.writeFileSync(readerPath, 'stub');
  fs.writeFileSync(path.join(papers, 'R&D report.pdf'), '%PDF-1.4 fixture');
  const paper2 = await post('/api/papers', { title: 'R&D report', file_name: 'R&D report.pdf', category: '测试类别', status: 'to_read', reader: readerPath });
  ok('前置：第二条记录创建', paper2.status === 201, JSON.stringify(paper2.body));
  const opened2 = await post(`/api/papers/${paper2.body.id}/open`, {});
  ok('配了阅读软件时打开成功', opened2.status === 200, JSON.stringify(opened2.body));
  const calls2 = openCalls();
  const readerCall = calls2[calls2.length - 1] || {};
  ok('已配置阅读软件：仍走 spawn(reader, [filePath])', readerCall.cmd === readerPath
    && Array.isArray(readerCall.args) && readerCall.args[0].endsWith('R&D report.pdf'), JSON.stringify(readerCall));
} catch (err) {
  if (!process.exitCode) {
    console.error(err);
    process.exitCode = 1;
  }
} finally {
  if (child && child.exitCode === null) {
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.kill();
    await closed.catch(() => {});
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}

if (process.exitCode) {
  console.error('\n✗ 文献打开回归失败');
} else {
  console.log(`\n✓ 文献打开回归全部通过（${passed} 项）`);
}
