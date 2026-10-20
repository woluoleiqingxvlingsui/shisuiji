/**
 * 拾穗集 —— 畸形请求不能把服务打死（H1）
 *
 * 背景：handleRequest 过去直接 `new URL(req.url, 'http://' + req.headers.host)`。
 * Host 头畸形（例如 "["）时它直接抛异常，异常冒泡成未捕获的 Promise 拒绝，
 * Node 默认因此退出进程 —— 一个畸形请求就能把整台机器上的服务打掉，
 * 而且不需要口令。
 *
 * 本用例钉死：
 *   1. 畸形 Host / 畸形请求目标 → 收到受控的 400（不是无响应、不是进程退出）
 *   2. 进程继续存活
 *   3. 随后的 /api/health 与普通接口照常可用
 *
 * 红线遵守（AGENTS.md §1 §2）：
 *   - server.js + public/ + lib/ 复制到临时目录再跑，data/ 各自独立
 *   - DANJI_PAPERS_DIR 显式指向临时目录
 *   - 端口用随机空闲端口，绝不碰真实服务的 8642
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'danji-bad-host-'));
const papers = path.join(tmp, 'papers');
fs.mkdirSync(papers, { recursive: true });
for (const item of ['server.js', 'public', 'lib']) {
  fs.cpSync(path.join(REPO, item), path.join(tmp, item), { recursive: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

/** 用裸 socket 发一行原始 HTTP，绕开 fetch/http 客户端对 Host 头的限制 */
function rawRequest(port, rawLine, hostHeader) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buf = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ raw: buf, closed: true });
    }, 5000);
    socket.on('connect', () => {
      socket.write(rawLine + '\r\n' + (hostHeader === null ? '' : `Host: ${hostHeader}\r\n`) + 'Connection: close\r\n\r\n');
    });
    socket.on('data', (d) => { buf += d.toString('utf8'); });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
    socket.on('close', () => { clearTimeout(timer); resolve({ raw: buf, closed: false }); });
  });
}

let child = null;
try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: tmp,
    env: { ...process.env, PORT: String(port), DANJI_HOST: '127.0.0.1', DANJI_PAPERS_DIR: papers, DANJI_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', () => {});

  // 等服务起来
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      up = res.ok;
    } catch { /* 还没起来 */ }
    if (!up) await sleep(250);
  }
  assert.ok(up, `隔离服务未就绪：${stderr}`);

  /* ---------- 1. 畸形 Host ---------- */
  const badHost = await rawRequest(port, 'GET /api/health HTTP/1.1', '[');
  assert.ok(badHost.raw.length > 0, '畸形 Host 应得到一个受控响应，而不是连接被直接掐断');
  assert.match(badHost.raw, /^HTTP\/1\.[01] 400/, `畸形 Host 应回 400，实际：${badHost.raw.slice(0, 120)}`);
  assert.equal(child.exitCode, null, '畸形 Host 之后进程必须还活着');

  /* ---------- 2. 畸形请求目标 ---------- */
  const badTarget = await rawRequest(port, 'GET http://[ HTTP/1.1', '127.0.0.1');
  assert.ok(badTarget.raw.length > 0, '畸形请求目标应得到一个受控响应');
  assert.match(badTarget.raw, /^HTTP\/1\.[01] 400/, `畸形请求目标应回 400，实际：${badTarget.raw.slice(0, 120)}`);
  assert.equal(child.exitCode, null, '畸形请求目标之后进程必须还活着');

  /* ---------- 3. 之后服务照常可用 ---------- */
  const health = await fetch(`${base}/api/health`);
  assert.ok(health.ok, '畸形请求之后 /api/health 仍应可用');
  const ideas = await fetch(`${base}/api/ideas`);
  assert.ok(ideas.ok, '畸形请求之后普通接口仍应可用');
  const list = await ideas.json();
  assert.ok(Array.isArray(list), '/api/ideas 仍应返回数组');

  /* ---------- 4. 连续畸形请求也不能打死后端 ---------- */
  for (let i = 0; i < 5; i++) {
    await rawRequest(port, 'GET / HTTP/1.1', '[');
  }
  assert.equal(child.exitCode, null, '连续畸形请求后进程必须还活着');
  const health2 = await fetch(`${base}/api/health`);
  assert.ok(health2.ok, '连续畸形请求后 /api/health 仍应可用');

  console.log('✓ 畸形 Host/请求目标 → 受控 400，进程存活，后续接口照常可用');
  console.log('\n✓ 畸形请求存活回归通过（隔离实例，未碰真实服务）');
} finally {
  if (child && child.exitCode === null) {
    const closed = new Promise((r) => child.once('close', r));
    child.kill();
    await closed;
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}
