/*
 * 拾穗集 —— M22 花销服务端行为回归
 * 用法：node tools/test-m22-expense.mjs
 *
 * 钉死的规则（M22 两项落在服务端 / 接口契约上的改动）：
 *   1. 花销日期只记到月份：POST / PUT 一律收敛成 YYYY-MM；
 *      老写法（2026-11-05）截断到月；空 / 非法月份回落本月；
 *      已存数据不在启动时改写，只在下次保存时截断。
 *   2. 自动归类兜底从「套餐」改成「杂项」：标题不含任何类别关键词 → misc；
 *      misc 进入类别枚举（显式 category=misc 被接受），其余类别优先级不变。
 *
 * 红线遵守（AGENTS.md §1 §2）：server.js + public/ + lib/ 复制到临时目录再跑；
 * DANJI_PAPERS_DIR 显式指向临时目录；端口用随机空闲端口，绝不碰真实 8642；
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
const TOKEN = 'm22-probe-token';

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

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'danji-m22-expense-'));
const papers = path.join(tmp, 'papers');
fs.mkdirSync(papers, { recursive: true });
for (const item of ['server.js', 'public', 'lib']) {
  fs.cpSync(path.join(REPO, item), path.join(tmp, item), { recursive: true });
}

// 启动前先塞一条「精确到日」的老记录：启动只回填 category，不该动 date
const SEED_ID = 'seed-old-day-precision';
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
fs.writeFileSync(
  path.join(tmp, 'data', 'expenses.json'),
  JSON.stringify({
    schema_version: 1,
    expenses: [{
      id: SEED_ID,
      title: '老记录补记',
      amount: 12.5,
      date: '2026-05-09',
      notes: '',
      category: 'plan',
      created_at: '2026-05-09T10:00:00.000Z',
      updated_at: '2026-05-09T10:00:00.000Z',
    }],
  }, null, 2),
  'utf8',
);

let child = null;
let base = '';
let auth = { ...json };

function startServer(port) {
  child = spawn(process.execPath, ['server.js'], {
    cwd: tmp,
    env: { ...process.env, PORT: String(port), DANJI_HOST: '127.0.0.1', DANJI_PAPERS_DIR: papers, DANJI_TOKEN: TOKEN },
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
      const res = await fetch(`${base}/api/health`, { headers: auth, signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

async function get(pathname) {
  return (await fetch(base + pathname, { headers: auth })).json();
}
async function post(pathname, body) {
  const res = await fetch(base + pathname, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function put(pathname, body) {
  const res = await fetch(base + pathname, { method: 'PUT', headers: auth, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

try {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  auth = { 'X-Danji-Token': TOKEN, ...json };
  startServer(port);
  if (!await waitUp()) {
    console.error('✗ 隔离服务未在超时内就绪');
    process.exitCode = 1;
    throw new Error('server not up');
  }
  console.log(`临时实例：${tmp} 端口 ${port}`);

  /* ---------- 1. 日期只记到月份 ---------- */
  const seeded = (await get('/api/expenses')).find((e) => e.id === SEED_ID);
  ok('启动不改写已存的老日期（仍 2026-05-09）', seeded && seeded.date === '2026-05-09', seeded && seeded.date);

  const putSeed = await put(`/api/expenses/${SEED_ID}`, { title: '老记录补记', amount: 13, date: '2026-05-09' });
  ok('保存老记录时把日期截断到月（2026-05）', putSeed.status === 200 && putSeed.body.date === '2026-05', JSON.stringify(putSeed.body.date));

  const monthCases = [
    ['2026-11', '2026-11'],
    ['2026/11', '2026-11'],
    ['2026.11', '2026-11'],
    ['2026-11-05', '2026-11'],
    ['2026/11/5', '2026-11'],
    ['2026-1', '2026-01'],
  ];
  for (const [input, want] of monthCases) {
    const r = await post('/api/expenses', { title: `日期写法 ${input}`, amount: 1, date: input });
    ok(`日期 ${input} → ${want}`, r.status === 201 && r.body.date === want, r.body.date);
  }

  const fallbacks = [
    ['', '空日期'],
    ['2026-13', '月份非法'],
    ['2026-00', '月份为 0'],
    ['随便写一句', '不是日期'],
  ];
  for (const [input, label] of fallbacks) {
    const r = await post('/api/expenses', { title: `回落 ${label}`, amount: 1, date: input });
    ok(`${label}回落本月（${thisMonth()}）`, r.status === 201 && r.body.date === thisMonth(), r.body.date);
  }

  const all = await get('/api/expenses');
  ok('列表里所有日期都是 YYYY-MM 形状', all.every((e) => /^\d{4}-\d{2}$/.test(String(e.date))), JSON.stringify(all.map((e) => e.date)));

  /* ---------- 2. 自动归类兜底改成「杂项」 ---------- */
  const guess = async (title) => {
    const r = await post('/api/expenses', { title, amount: 1, date: '2026-03' });
    return { status: r.status, category: r.body.category, title };
  };
  const misc = await guess('买了本不相干的书');
  ok('标题不含任何关键词 → 杂项（不再是套餐）', misc.category === 'misc', JSON.stringify(misc));
  const misc2 = await guess('U 盘');
  ok('另一个无关键词标题 → 杂项', misc2.category === 'misc', JSON.stringify(misc2));

  const stillPlan = await guess('会员套餐');
  const stillApi = await guess('API 调用');
  const stillCompute = await guess('算力租用');
  const stillLadder = await guess('机场订阅');
  ok('「会员套餐」仍归套餐（兜底改动没波及）', stillPlan.category === 'plan', JSON.stringify(stillPlan));
  ok('「API 调用」仍归 API', stillApi.category === 'api', JSON.stringify(stillApi));
  ok('「算力租用」仍归算力租用', stillCompute.category === 'compute', JSON.stringify(stillCompute));
  ok('「机场订阅」仍归梯子', stillLadder.category === 'ladder', JSON.stringify(stillLadder));

  const explicit = await post('/api/expenses', { title: '显式杂项', amount: 2, date: '2026-03', category: 'misc' });
  ok('显式 category=misc 被接受（已进入类别枚举）', explicit.status === 201 && explicit.body.category === 'misc', JSON.stringify(explicit.body));

  assert.ok(passed > 0, '至少跑过一项');
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
  console.error('\n✗ M22 花销服务端回归失败');
} else {
  console.log(`\n✓ M22 花销服务端回归全部通过（${passed} 项）`);
}
