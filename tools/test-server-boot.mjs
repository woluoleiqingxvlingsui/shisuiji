/**
 * 拾穗集 —— 后台同步端到端探针（临时实例，不碰真实服务）
 *
 * 覆盖真实进程里才暴露的问题（node --check 只能查语法，查不出 require 路径错）：
 *   1. 隔离副本能否起来、health 是否正常
 *   2. /api/events 未带口令应被拒（不能被匿名连上）
 *   3. 带口令应收到 SSE 首帧 hello，且带 pendingSince 字段
 *   4. 任意板块写盘后，新连上的客户端应看到 pendingSince 非 0
 *      ——证明 markDataChanged 真的挂在 queueWrite（全部写盘的汇合点）上
 *   5. 安静窗口满后应收到 event: sync
 *
 * 红线遵守（AGENTS.md §1 §2）：
 *   - server.js + public/ + lib/ 复制到临时目录再跑，data/ 各自独立
 *   - DANJI_PAPERS_DIR 显式指向临时目录，绝不回落项目内 papers\
 *   - 端口用 0/高位端口，绝不碰真实服务的 8642
 *
 * 用法：node tools/test-server-boot.mjs [--window-ms=60000]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TOKEN = 'e2e-probe-token';
const PORT = 8791;

/** 非回环 IPv4：口令门禁只对「非本机来源」生效（server.js clientRole 认的是 socket 回环地址） */
function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

// --window-ms 用来缩短第 5 项要等的安静窗口；默认跑真实 5 分钟
const argMs = Number((process.argv.find((a) => a.startsWith('--window-ms=')) || '').split('=')[1]);
const WINDOW_MS = Number.isFinite(argMs) && argMs > 0 ? argMs : 0;

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

/** 只读前 N 字节就掐断，避免 SSE 长连接把探测挂住 */
async function readHead(url, headers, ms = 3000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes('\n\n')) break;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    clearTimeout(timer);
    return { status: res.status, buf };
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') return { status: 0, buf: '', aborted: true };
    throw e;
  }
}

function parseHello(buf) {
  const m = buf.match(/event: hello\s*\ndata: (\{[^\n]*\})/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'danji-boot-'));
const papers = path.join(tmp, 'papers');
fs.mkdirSync(papers, { recursive: true });
for (const item of ['server.js', 'public', 'lib']) {
  fs.cpSync(path.join(REPO, item), path.join(tmp, item), { recursive: true });
}
console.log(`临时实例：${tmp}`);

const child = spawn(process.execPath, ['server.js'], {
  cwd: tmp,
  env: {
    ...process.env,
    PORT: String(PORT),
    // 绑 0.0.0.0 才能从局域网地址回连自己，从而以「手机端」身份触发口令门禁
    DANJI_HOST: '0.0.0.0',
    DANJI_PAPERS_DIR: papers,
    DANJI_TOKEN: TOKEN,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });
child.stdout.on('data', () => {});

const LAN = lanIPv4();
const base = `http://127.0.0.1:${PORT}`;        // 本机：desktop 身份，免口令
const lanBase = LAN ? `http://${LAN}:${PORT}` : null; // 局域网地址：mobile 身份，必须带口令
const auth = { 'X-Danji-Token': TOKEN };

async function waitUp(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${base}/api/health`, { headers: auth, signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  return false;
}

try {
  console.log('启动与健康检查');
  const up = await waitUp();
  if (!up) {
    console.error(stderr.trim() || '(stderr 为空)');
    throw new Error('隔离实例未能启动');
  }
  ok('隔离实例能起来（require 路径、语法、端口都正常）', true);

  const health = await (await fetch(`${base}/api/health`, { headers: auth })).json();
  ok('health 正常', health && health.ok === true, JSON.stringify(health));

  console.log('SSE 鉴权');
  if (!lanBase) {
    console.log('  ⓘ 取不到非回环 IPv4，跳过口令门禁两项（本机回环本就免口令）');
  } else {
    const anon = await readHead(`${lanBase}/api/events`, {}, 4000);
    ok('手机端未带口令连 /api/events 被拒（不能匿名订阅改动）', anon.status === 401 || anon.status === 403, `status=${anon.status}`);
    const wrong = await readHead(`${lanBase}/api/events`, { 'X-Danji-Token': 'wrong-token' }, 4000);
    ok('手机端口令错误被拒', wrong.status === 401 || wrong.status === 403, `status=${wrong.status}`);
  }
  // 本机回环按设计免口令（clientRole 认 socket 回环地址），这里只验证本机确实能连
  const loopAnon = await readHead(`${base}/api/events`, {}, 3000);
  ok('本机回环连 /api/events（design：desktop 免口令）', loopAnon.status === 200, `status=${loopAnon.status}`);

  const first = await readHead(`${base}/api/events`, { ...auth, Accept: 'text/event-stream' });
  ok('带口令连上并收到首帧', first.status === 200 && first.buf.includes('event: hello'), `status=${first.status}`);
  const hello0 = parseHello(first.buf);
  ok('hello 帧带 pendingSince 字段', !!hello0 && 'pendingSince' in hello0, JSON.stringify(hello0));
  ok('pendingSince 是数字（启动时的数据归一化本身也算一次改动，客户端连上会补同步）',
    !!hello0 && typeof hello0.pendingSince === 'number', JSON.stringify(hello0));

  console.log('写盘 → 聚合窗口');
  // 走一个任意板块的写接口：挂点在 queueWrite，全部落盘都汇合
  const wr = await fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: '探针', title: '聚合窗口探针', body: '只用来验证防抖' }),
  });
  ok('写接口成功', wr.ok, `status=${wr.status}`);

  const after = await readHead(`${base}/api/events`, { ...auth, Accept: 'text/event-stream' });
  const hello1 = parseHello(after.buf);
  ok(
    '写盘后新连接看到 pendingSince 非 0（markDataChanged 挂在写盘汇合点上）',
    !!hello1 && !!hello1.pendingSince && hello1.pendingSince > 0,
    JSON.stringify(hello1)
  );

  if (!WINDOW_MS) {
    console.log(`  ⓘ 未指定 --window-ms，跳过第 5 项（要真等 5 分钟）`);
  } else {
    console.log(`安静窗口（${WINDOW_MS}ms）→ sync 事件`);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), WINDOW_MS + 8000);
    const res = await fetch(`${base}/api/events`, { headers: { ...auth, Accept: 'text/event-stream' }, signal: ac.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let gotSync = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (/event: sync\s*\n/.test(buf)) { gotSync = true; break; }
      }
    } catch (e) {
      if (!ac.signal.aborted) throw e;
    }
    clearTimeout(timer);
    try { await reader.cancel(); } catch { /* ignore */ }
    ok(`安静满 ${WINDOW_MS}ms 后收到 event: sync`, gotSync, buf.slice(0, 200));
  }

  console.log('手机端同步回报 → 电脑端收件箱');
  if (!lanBase) {
    console.log('  ⓘ 取不到非回环 IPv4，跳过（需要 mobile 身份）');
  } else {
    // 先订阅，模拟电脑端开着消息中心
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12000);
    const res = await fetch(`${base}/api/events`, { headers: { ...auth, Accept: 'text/event-stream' }, signal: ac.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const readTask = (async () => {
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const m = buf.match(/event: report\s*\ndata: (\{[^\n]*\})/);
        if (m) return JSON.parse(m[1]);
      }
      return null;
    })();
    await sleep(300); // 等 hello 首帧走完再发回报

    // 以手机身份（局域网地址）回报「同步成功」
    const wr = await fetch(`${lanBase}/api/messages`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'bg-sync', sync_ok: '1', sync_attempts: '0', sync_reason: '' }),
    });
    ok('手机端回报同步成功（HTTP 201）', wr.status === 201, `status=${wr.status}`);
    const report = await readTask;
    clearTimeout(timer);
    try { await reader.cancel(); } catch { /* ignore */ }
    ok('电脑端立即收到 event: report（不等 5 分钟防抖）', !!report, JSON.stringify(report));
    ok('回报内容带上成败与文案', !!report && report.ok === true && !!report.title, JSON.stringify(report));

    // 回报应当已经进了消息中心，电脑端刷新就能看到
    const list = await (await fetch(`${base}/api/messages`, { headers: auth })).json();
    const mine = list.find((m) => m.kind === 'bg-sync');
    ok('回报落进消息中心（电脑端刷新可见）', !!mine, JSON.stringify(list.slice(0, 2)));
    ok('文案由服务端生成，不采信手机传来的 title', !!mine && mine.title === '手机已同步 ✅', mine && mine.title);
  }

  console.log('手机端写权限收口');
  if (lanBase) {
    const bad = await fetch(`${lanBase}/api/messages`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: '系统', title: '注入', body: '同网段任何人都不该能往消息中心塞东西' }),
    });
    ok('手机端写普通消息被拒（只放行 bg-sync 回报）', bad.status === 403, `status=${bad.status}`);
  }
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  child.kill();
  await sleep(300);
  if (child.exitCode === null) child.kill('SIGKILL');
  // 临时实例的 data/ 与 papers/ 都在临时目录里，一并清掉；真实仓库一概不碰
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (process.exitCode) {
  console.error(`\n✗ test-server-boot：有失败（通过 ${passed}）`);
} else {
  console.log(`\n✓ test-server-boot：${passed} 项通过`);
}
