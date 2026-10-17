/**
 * 拾穗集 —— M21 服务端行为回归
 * 用法：node tools/test-m21-api.mjs
 *
 * 钉死的规则（本轮六项需求里落在服务端/接口契约上的部分）：
 *   1. 花销金额最多四位小数：POST/PUT 四舍五入到 1e-4，旧的两位/整数数据不变；
 *   2. 花销新增类别「梯子」：机场/梯子/vpn 等关键词优先于套餐的「订阅」；
 *   3. 非法金额（负数 / 空 / 非数字）仍然 400，错误文案说明最多四位小数；
 *   4. 回收站 GET 返回的 payload 是完整原记录（不截断），供电脑端默认展开；
 *   5. 同步协议零改动：/api/sync/pull 仍是 9 个集合 + data_version + boot_id，
 *      不含 trash 键（回收站不参与手机同步）。
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
const TOKEN = 'm21-probe-token';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'danji-m21-api-'));
const papers = path.join(tmp, 'papers');
fs.mkdirSync(papers, { recursive: true });
for (const item of ['server.js', 'public', 'lib']) {
  fs.cpSync(path.join(REPO, item), path.join(tmp, item), { recursive: true });
}

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
async function del(pathname) {
  const res = await fetch(base + pathname, { method: 'DELETE', headers: auth });
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

  /* ---------- 1. 同步协议零改动 ---------- */
  const pull = await get('/api/sync/pull');
  const pullKeys = Object.keys(pull).sort();
  const collections = ['achievements', 'activities', 'ideas', 'insights', 'kb', 'messages', 'papers', 'sites', 'expenses'];
  ok('pull 含 9 个集合', collections.every((k) => Array.isArray(pull[k])), JSON.stringify(pullKeys));
  ok('pull 无 trash 键', !('trash' in pull));
  ok('pull 保留 data_version / boot_id', Number.isFinite(pull.data_version) && typeof pull.boot_id === 'string' && !!pull.boot_id);

  /* ---------- 2. 四位小数 ---------- */
  const dec = await post('/api/expenses', { title: '四位小数验收', amount: 0.1234, date: '2026-10-01' });
  ok('POST amount=0.1234 原样保存', dec.status === 201 && dec.body.amount === 0.1234, JSON.stringify(dec.body));
  const round = await post('/api/expenses', { title: '四舍五入验收', amount: 1.23456, date: '2026-10-02' });
  ok('POST 1.23456 → 1.2346（四舍五入到四位）', round.body.amount === 1.2346, String(round.body.amount));
  const putDec = await put(`/api/expenses/${dec.body.id}`, { amount: 0.0001 });
  ok('PUT amount=0.0001 原样保存', putDec.status === 200 && putDec.body.amount === 0.0001, JSON.stringify(putDec.body));
  const listed = await get('/api/expenses');
  const hit = listed.find((e) => e.id === putDec.body.id);
  ok('GET 返回的金额仍是四位', hit && hit.amount === 0.0001, hit && String(hit.amount));

  const badNeg = await post('/api/expenses', { title: '负数', amount: -1, date: '2026-10-03' });
  const badEmpty = await post('/api/expenses', { title: '空金额', amount: '', date: '2026-10-03' });
  const badText = await post('/api/expenses', { title: '乱写', amount: 'abc', date: '2026-10-03' });
  ok('负金额仍 400', badNeg.status === 400);
  ok('空金额仍 400', badEmpty.status === 400);
  ok('非数字金额仍 400', badText.status === 400);
  ok('金额错误文案说明四位小数', /四位/.test(String(badNeg.body.error || '')) && /四位/.test(String(badEmpty.body.error || '')), JSON.stringify([badNeg.body.error, badEmpty.body.error]));

  /* ---------- 3. 「梯子」类别与自动归类优先级 ---------- */
  const guess = async (title) => {
    const r = await post('/api/expenses', { title, amount: 1, date: '2026-10-04' });
    return { status: r.status, category: r.body.category, title };
  };
  const ladder1 = await guess('机场订阅');
  const ladder2 = await guess('梯子续费');
  const ladder3 = await guess('VPN 年费');
  const plan = await guess('会员套餐');
  const api = await guess('API 调用');
  const compute = await guess('算力租用');
  ok('「机场订阅」自动归到梯子（不因“订阅”误判套餐）', ladder1.category === 'ladder', JSON.stringify(ladder1));
  ok('「梯子续费」自动归到梯子', ladder2.category === 'ladder', JSON.stringify(ladder2));
  ok('「VPN 年费」自动归到梯子', ladder3.category === 'ladder', JSON.stringify(ladder3));
  ok('「会员套餐」仍是套餐', plan.category === 'plan', JSON.stringify(plan));
  ok('「API 调用」仍是 API', api.category === 'api', JSON.stringify(api));
  ok('「算力租用」仍是算力租用', compute.category === 'compute', JSON.stringify(compute));
  const explicit = await post('/api/expenses', { title: '显式类别', amount: 2, date: '2026-10-04', category: 'ladder' });
  ok('显式 category=ladder 被接受', explicit.status === 201 && explicit.body.category === 'ladder');

  /* ---------- 4. 回收站 payload 完整 ---------- */
  const longTail = '——这是用于确认回收站不截断正文的尾部标记-' + 'X'.repeat(40);
  const longContent = '前半段正文。'.repeat(30) + longTail;
  const idea = await post('/api/ideas', { title: '回收站完整内容验收', content: longContent });
  const removed = await del(`/api/ideas/${idea.body.id}`);
  ok('删除随记成功（进回收站）', removed.status === 200);
  const trash = await get('/api/trash');
  const entry = (trash.items || []).find((t) => t.payload && t.payload.id === idea.body.id);
  ok('回收站包含该随记', !!entry);
  ok('回收站 payload.content 未被截断（含尾部标记）', !!entry && entry.payload.content === longContent, entry && entry.payload.content.length);
  ok('回收站 payload 保留图片字段', !!entry && Array.isArray(entry.payload.images));

  /* ---------- 5. 网页类型：服务端仍保留自定义/中文 kind ---------- */
  const site = await post('/api/sites', { title: '类型显示验收', url: 'https://example.com/kind', kind: '技术' });
  ok('服务端不把中文 kind 静默改成 tech', site.status === 201 && site.body.kind === '技术', JSON.stringify(site.body));
  const siteCustom = await post('/api/sites', { title: '自定义类型验收', url: 'https://example.com/kind2', kind: '工具' });
  ok('自定义 kind 原样保留', siteCustom.body.kind === '工具', JSON.stringify(siteCustom.body));
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
  console.error('\n✗ M21 服务端回归失败');
} else {
  console.log(`\n✓ M21 服务端回归全部通过（${passed} 项）`);
}
