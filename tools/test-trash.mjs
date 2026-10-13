/**
 * 拾穗集 —— 回收站（M20 任务 D）
 * 用法：node tools/test-trash.mjs
 *
 * 钉死的规则：
 *   1. 七个板块的 DELETE 不再物理删除，而是搬进回收站（trash.json）；
 *   2. 恢复回原板块，且 created_at / updated_at 原样保留（恢复不是「新建」）；
 *   3. 彻底删除 / 清空真的抹掉；
 *   4. 到期懒清理：启动 load 与每次写 trash 都过滤过期项；
 *   5. 随记贴图进站不删、彻底删/到期才删（磁盘延迟删除）；
 *   6. 手机 push 的随记删除同样进回收站，返回语义不变；
 *   7. **回收站内部操作不 bump dataVersion**（彻底删/清空/懒清理），
 *      而删除进站与恢复照常 bump —— 防 M19 类「凭空多一次同步噪音」。
 *
 * 红线遵守（AGENTS.md §1 §2）：server.js + public/ + lib/ 复制到临时目录再跑；
 * DANJI_PAPERS_DIR 显式指向临时目录；端口 8798 绝不碰真实 8642；临时目录用完即删。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TOKEN = 'trash-probe-token';
const PORT = 8798;

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'danji-trash-'));
const papers = path.join(tmp, 'papers');
fs.mkdirSync(papers, { recursive: true });
for (const item of ['server.js', 'public', 'lib']) {
  fs.cpSync(path.join(REPO, item), path.join(tmp, item), { recursive: true });
}
const trashFile = path.join(tmp, 'data', 'trash.json');
const imageDir = path.join(tmp, 'data', 'images');
console.log(`临时实例：${tmp}`);

/** 起一个隔离实例（restart=true 时复用同一 tmp：用来验证「重启后的懒清理」） */
function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: tmp,
    env: { ...process.env, PORT: String(PORT), DANJI_HOST: '127.0.0.1', DANJI_PAPERS_DIR: papers, DANJI_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderrText = '';
  child.stderr.on('data', (d) => { child.stderrText += d.toString(); });
  child.stdout.on('data', () => {});
  return child;
}
let child = startServer();
const base = `http://127.0.0.1:${PORT}`;
const auth = { 'X-Danji-Token': TOKEN, ...json };

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

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((r) => child.once('close', r));
  child.kill();
  await done;
}

async function version() {
  const res = await fetch(`${base}/api/sync/pull`, { headers: auth });
  assert.equal(res.status, 200, `pull 应 200，实际 ${res.status}`);
  return (await res.json()).data_version;
}
async function get(pathname) { return (await fetch(base + pathname, { headers: auth })).json(); }
async function post(pathname, body) {
  const res = await fetch(base + pathname, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function del(pathname) {
  const res = await fetch(base + pathname, { method: 'DELETE', headers: auth });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const readTrashFile = () => JSON.parse(fs.readFileSync(trashFile, 'utf8'));
const listTrash = async () => (await get('/api/trash')).items;

// 七个板块：DELETE 路径 + 列表路径 + 造一条记录的 POST 路径
const BOARDS = [
  { source: 'activities', list: '/api/activities', make: () => ({ platform: '测试', title: '回收站-蛋' }) },
  { source: 'ideas', list: '/api/ideas', make: () => ({ title: '回收站-随记' }) },
  { source: 'expenses', list: '/api/expenses', make: () => ({ title: '回收站-花销', amount: 12.5, date: '2026-10-01', category: 'other' }) },
  { source: 'achievements', list: '/api/achievements', make: () => ({ title: '回收站-成果', category: 'other' }) },
  { source: 'kb', list: '/api/kb', make: () => ({ content: '回收站-知识' }) },
  { source: 'sites', list: '/api/sites', make: () => ({ url: 'https://trash.example.com/a', title: '回收站-网页' }) },
  { source: 'papers', list: '/api/papers', make: () => ({ title: '回收站-文献' }) },
];

// 各板块的 GET 列表端点一律返回裸数组（不是 {key:[...]}）
const listOf = async (pathname) => {
  const body = await get(pathname);
  assert.ok(Array.isArray(body), `${pathname} 应返回数组，实际 ${JSON.stringify(body).slice(0, 80)}`);
  return body;
};

try {
  console.log('隔离实例启动');
  if (!await waitUp()) {
    console.error(child.stderrText.trim() || '(stderr 为空)');
    throw new Error('隔离实例未能启动');
  }
  ok('临时实例起来了（不碰真实 8642 服务）', true);

  // ---------- 1. 各板块删除进站 ----------
  const created = {};
  for (const b of BOARDS) {
    const r = await post(b.list, b.make());
    assert.ok(r.status === 200 || r.status === 201, `${b.source} 创建应成功，实际 ${r.status}`);
    created[b.source] = r.body;
  }
  ok('七个板块都能造出记录', Object.keys(created).length === 7);

  const vBefore = await version();
  for (const b of BOARDS) {
    const id = created[b.source].id;
    const r = await del(`${b.list}/${id}`);
    assert.equal(r.body.deleted, id, `${b.source} DELETE 应返回 deleted=id`);
    const left = await listOf(b.list);
    ok(`${b.source}：删除后原列表已无此条`, !left.some((x) => x.id === id));
  }
  const vAfterDeletes = await version();
  ok('删除进站照常 bump dataVersion（真实数据变更）', vAfterDeletes > vBefore, `before=${vBefore} after=${vAfterDeletes}`);

  const trashNow = await listTrash();
  ok('回收站里躺着七条', trashNow.length === 7, `实际 ${trashNow.length}`);
  ok('回收站按 deleted_at 倒序', trashNow.every((it, i) => i === 0 || Date.parse(trashNow[i - 1].deleted_at) >= Date.parse(it.deleted_at)));
  ok('每条都带 30 天 expire_at', trashNow.every((it) => {
    const days = (Date.parse(it.expire_at) - Date.parse(it.deleted_at)) / 86400000;
    return Math.abs(days - 30) < 0.001;
  }));
  ok('七个来源板块都覆盖到了', new Set(trashNow.map((t) => t.source)).size === 7);

  // 回收站不进 pull
  const pull = await (await fetch(`${base}/api/sync/pull`, { headers: auth })).json();
  ok('/api/sync/pull 响应里没有 trash 键（协议零改动）', !('trash' in pull), Object.keys(pull).join(','));

  // ---------- 2. 恢复：回原板块且时间戳不变 ----------
  const ideasEntry = trashNow.find((t) => t.source === 'ideas');
  const beforePayload = ideasEntry.payload;
  const vBeforeRestore = await version();
  const rr = await post(`/api/trash/${ideasEntry.id}/restore`);
  assert.equal(rr.status, 200, `恢复应 200，实际 ${rr.status}`);
  ok('恢复后回到原 id', rr.body.restored === beforePayload.id, JSON.stringify(rr.body));

  const ideasBack = await listOf('/api/ideas');
  const restored = ideasBack.find((x) => x.id === beforePayload.id);
  ok('恢复的记录真的回到 ideas 板块', !!restored);
  ok('恢复不改 created_at', restored && restored.created_at === beforePayload.created_at, `${beforePayload.created_at} → ${restored && restored.created_at}`);
  ok('恢复不改 updated_at', restored && restored.updated_at === beforePayload.updated_at, `${beforePayload.updated_at} → ${restored && restored.updated_at}`);
  const vAfterRestore = await version();
  ok('恢复照常 bump dataVersion', vAfterRestore > vBeforeRestore, `before=${vBeforeRestore} after=${vAfterRestore}`);

  // 其余六条也各恢复一条，确认来源映射齐全
  for (const b of BOARDS) {
    const entry = (await listTrash()).find((t) => t.source === b.source);
    if (!entry) continue;
    await post(`/api/trash/${entry.id}/restore`);
    const back = await listOf(b.list);
    ok(`${b.source}：恢复回原板块`, back.some((x) => x.id === entry.payload.id));
  }
  ok('恢复完回收站已空', (await listTrash()).length === 0, `剩 ${(await listTrash()).length}`);

  // ---------- 3. 回收站内部操作不 bump dataVersion ----------
  // 重新造一条蛋并删进站
  const again = await post('/api/activities', { platform: '测试', title: '回收站-版本探测' });
  await del(`/api/activities/${again.body.id}`);
  const entry = (await listTrash()).find((t) => t.source === 'activities');

  const v0 = await version();
  const pd = await del(`/api/trash/${entry.id}`);
  assert.equal(pd.status, 200, `彻底删除应 200，实际 ${pd.status}`);
  const v1 = await version();
  ok('彻底删除不 bump dataVersion（手机视角无变化）', v1 === v0, `before=${v0} after=${v1}`);
  ok('彻底删除后回收站为空', (await listTrash()).length === 0);
  ok('彻底删除后原板块确实没有它', !(await listOf('/api/activities')).some((x) => x.id === again.body.id));

  // ---------- 4. 随记贴图：进站不删、彻底删才删 ----------
  fs.mkdirSync(imageDir, { recursive: true });
  const imgId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  fs.writeFileSync(path.join(imageDir, `${imgId}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const withImg = await post('/api/ideas', { title: '带图的随记', images: [{ id: imgId, name: 'a.png' }] });
  assert.ok(withImg.body.id, '带图随记应创建成功');
  await del(`/api/ideas/${withImg.body.id}`);
  ok('删除带图随记：图片文件仍在（进站不删）', fs.existsSync(path.join(imageDir, `${imgId}.png`)));
  const imgEntry = (await listTrash()).find((t) => t.source === 'ideas');
  ok('回收站 payload 保留 images 引用', Array.isArray(imgEntry.payload.images) && imgEntry.payload.images[0].id === imgId);
  await del(`/api/trash/${imgEntry.id}`);
  await sleep(300);
  ok('彻底删除后图片文件才被删（磁盘延迟删除）', !fs.existsSync(path.join(imageDir, `${imgId}.png`)));

  // ---------- 5. 到期懒清理（改 trash.json 的 expire_at 后重启实例） ----------
  const aged = await post('/api/expenses', { title: '回收站-到期', amount: 9.9, date: '2026-10-02', category: 'other' });
  await del(`/api/expenses/${aged.body.id}`);
  const agedEntry = (await listTrash()).find((t) => t.source === 'expenses');
  const onDisk = readTrashFile();
  onDisk.items[0].expire_at = new Date(Date.now() - 86400000).toISOString();
  fs.writeFileSync(trashFile, JSON.stringify(onDisk, null, 2), 'utf8');

  await stopServer();
  child = startServer();
  if (!await waitUp()) throw new Error('重启失败');
  const afterLazy = await listTrash();
  ok('重启启动时清掉过期项（懒清理）', !afterLazy.some((t) => t.id === agedEntry.id), JSON.stringify(afterLazy.map((t) => t.source)));
  // 注意：dataVersion 只在同一次进程内可比，重启后必然重置，这里不比版本号

  // 写 trash 时也过滤一次过期项
  const fresh = await post('/api/expenses', { title: '回收站-再删', amount: 8.8, date: '2026-10-03', category: 'other' });
  await del(`/api/expenses/${fresh.body.id}`);
  const dump = readTrashFile();
  dump.items.push({ ...dump.items[0], id: 'expired-on-write', source: 'expenses', payload: { id: 'zzz' }, deleted_at: new Date().toISOString(), expire_at: new Date(Date.now() - 1000).toISOString() });
  fs.writeFileSync(trashFile, JSON.stringify(dump, null, 2), 'utf8');
  await del(`/api/trash/dummy-never`);   // 404 不该清
  await sleep(200);
  const freshEntry = (await listTrash()).find((t) => t.source === 'expenses' && t.payload.id === fresh.body.id);
  assert.ok(freshEntry, '新删的应在回收站里');
  await post(`/api/trash/${freshEntry.id}/restore`);  // restore 会写 trash，顺带触发过滤
  const cleaned = await listTrash();
  ok('写 trash 时也过滤过期项', !cleaned.some((t) => t.id === 'expired-on-write'), JSON.stringify(cleaned.map((t) => t.id)));

  // ---------- 6. 清空 ----------
  const batch = [];
  for (const b of BOARDS.slice(0, 4)) {
    const r = await post(b.list, b.make());
    batch.push(r.body.id);
    await del(`${b.list}/${r.body.id}`);
  }
  ok('批量删除后回收站有 4 条', (await listTrash()).length === 4, `实际 ${(await listTrash()).length}`);
  const vBeforeEmpty = await version();
  const clear = await del('/api/trash');
  assert.equal(clear.status, 200, `清空应 200，实际 ${clear.status}`);
  ok('清空返回条数', clear.body.purged === 4, JSON.stringify(clear.body));
  ok('清空后回收站为空', (await listTrash()).length === 0);
  const vAfterEmpty = await version();
  ok('清空不 bump dataVersion', vAfterEmpty === vBeforeEmpty, `before=${vBeforeEmpty} after=${vAfterEmpty}`);
  for (const b of BOARDS.slice(0, 4)) {
    const left = await listOf(b.list);
    ok(`${b.source}：清空后仍不在列表里（清空不把记录放回去）`, !left.some((x) => batch.includes(x.id)), JSON.stringify(left.map((x) => x.id)));
  }

  // ---------- 7. 手机 push 删除也进回收站 ----------
  const mob = await post('/api/ideas', { title: '手机删的随记' });
  const v0m = await version();
  const push = await fetch(`${base}/api/sync/push`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ ideas: [{ id: mob.body.id, op: 'delete', updated_at: new Date().toISOString() }] }),
  });
  const pushBody = await push.json();
  assert.equal(push.status, 200, `push 应 200，实际 ${push.status}`);
  ok('push 删除返回语义不变（deleted:true）',
    pushBody.results && pushBody.results[0] && pushBody.results[0].status === 'ok' && pushBody.results[0].deleted === true,
    JSON.stringify(pushBody));
  await sleep(300);
  const mobEntry = (await listTrash()).find((t) => t.payload && t.payload.id === mob.body.id);
  ok('手机 push 删除同样进回收站（手机删的也能反悔）', !!mobEntry, JSON.stringify((await listTrash()).map((t) => t.source)));
  const v1m = await version();
  ok('push 删除进站 bump dataVersion', v1m > v0m, `before=${v0m} after=${v1m}`);
  // 清掉，避免影响后续断言
  if (mobEntry) await del(`/api/trash/${mobEntry.id}`);

  // ---------- 8. 恢复时的 id 冲突兜底 ----------
  const a1 = await post('/api/ideas', { title: '冲突源' });
  await del(`/api/ideas/${a1.body.id}`);
  const clashEntry = (await listTrash()).find((t) => t.source === 'ideas');
  // 同一个 id 再造一条（模拟极小概率的 id 复用）
  const a2 = await post('/api/ideas', { id: a1.body.id, title: '占位的同 id' });
  const restoredClash = await post(`/api/trash/${clashEntry.id}/restore`);
  const ideasList = await listOf('/api/ideas');
  const byId = ideasList.filter((x) => x.id === a1.body.id);
  ok('id 冲突时换新 id 放回，绝不覆盖新数据', byId.length === 1 && byId[0].title === '占位的同 id', JSON.stringify(byId.map((x) => [x.id, x.title])));
  ok('冲突恢复返回 duplicate_id 标记', restoredClash.body.duplicate_id === true, JSON.stringify(restoredClash.body));
  void a2;

  // ---------- 9. 源码钉死 ----------
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  ok('源码钉死：已无 SITE_KINDS 白名单', !/const SITE_KINDS\b/.test(src));
  ok('源码钉死：保留天数 30 天', /TRASH_RETENTION_DAYS\s*=\s*30/.test(src));
  ok('源码钉死：saveTrash 挂的是空 onWritten（不 bump 版本）', /function saveTrash\(\)\s*\{\s*return queueWrite\(saveTrashNow,\s*\(\)\s*=>\s*\{\s*\}\)/.test(src));
  ok('源码钉死：DELETE /api/ideas/:id 里不再直接 prune 图片', !/route\('DELETE', '\/api\/ideas\/:id'[\s\S]{0,700}pruneImageFiles/.test(src));
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await stopServer();
  if (child && child.exitCode === null) child.kill('SIGKILL');
  // 临时实例的 data/ 与 papers/ 都在临时目录里，一并清掉；真实仓库一概不碰
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
}

if (process.exitCode) {
  console.error(`\n✗ test-trash：有失败（通过 ${passed}）`);
} else {
  console.log(`\n✓ test-trash：${passed} 项通过`);
}