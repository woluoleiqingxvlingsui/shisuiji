/**
 * 拾穗集 —— 同步 push 重放幂等回归（Node，无需浏览器）
 * 用法：node tools/test-sync-replay.mjs
 *
 * 钉死的规则：
 *   1. update 被服务端应用过（updated_at 已被改写）后，同一操作重放
 *      （响应在返回途中丢失 / WebView 后台冻结 / 进程被杀）必须返回 ok，
 *      而不是判 conflict——否则队列卡死、状态灯常驻未同步；
 *   2. 重放幂等不吞真冲突：服务端现存内容与 op 不一致时仍须 conflict；
 *   3. create / delete 的既有幂等分支不被破坏（already / missing）。
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
import { randomUUID } from 'node:crypto';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'danji-sync-replay-'));
const papers = path.join(tmp, 'papers');
fs.mkdirSync(papers, { recursive: true });
for (const item of ['server.js', 'public', 'lib']) {
  fs.cpSync(path.join(REPO, item), path.join(tmp, item), { recursive: true });
}

let child = null;
let base = '';
const auth = { ...json };

function startServer(port) {
  child = spawn(process.execPath, ['server.js'], {
    cwd: tmp,
    env: { ...process.env, PORT: String(port), DANJI_HOST: '127.0.0.1', DANJI_PAPERS_DIR: papers, DANJI_TOKEN: '' },
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

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const closed = new Promise((r) => child.once('close', r));
  child.kill();
  await closed;
  child = null;
}

async function post(pathname, body) {
  const res = await fetch(base + pathname, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function put(pathname, body) {
  const res = await fetch(base + pathname, { method: 'PUT', headers: auth, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function get(pathname) {
  return (await fetch(base + pathname, { headers: auth })).json();
}

/** 与客户端 toPushPayload 同形状的 op；客户端编辑时间取「现在」（与手机真实行为一致） */
function op(ideaId, over) {
  return {
    id: ideaId,
    op: 'update',
    title: '标题',
    content: '正文',
    images: [],
    origin: 'mobile',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: new Date().toISOString(),
    base_updated_at: '',
    ...over,
  };
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

  /* ---------- 1. update 重放幂等：服务端已写入、客户端未收到响应 ---------- */
  const created = await post('/api/ideas', { title: '初始', content: 'v0', origin: 'mobile' });
  ok('前置：创建随记', created.status === 201);
  const ideaId = created.body.id;
  const T0 = created.body.updated_at;
  // 客户端编辑时间：重放时必须与首次完全一致（同一操作原样重发）
  const clientEditAt = new Date().toISOString();

  const first = await post('/api/sync/push', { ideas: [op(ideaId, {
    title: '第一版', content: 'v1', base_updated_at: T0, updated_at: clientEditAt,
  })] });
  ok('首次 push update → ok', first.body.results[0].status === 'ok' && first.body.results[0].applied === true,
    JSON.stringify(first.body.results[0]));
  const afterFirst = (await get('/api/ideas')).find((i) => i.id === ideaId);
  ok('服务端已应用第一版', afterFirst.title === '第一版');

  // 同一操作原样重放（模拟响应在返回途中丢失）
  const replay = await post('/api/sync/push', { ideas: [op(ideaId, {
    title: '第一版', content: 'v1', base_updated_at: T0, updated_at: clientEditAt,
  })] });
  const replayResult = replay.body.results[0];
  ok('重放同一 update → ok（不判 conflict）', replayResult.status === 'ok', JSON.stringify(replayResult));
  ok('重放标记 already=true 且把服务端版本还回来', replayResult.already === true && replayResult.idea && replayResult.idea.title === '第一版',
    JSON.stringify(replayResult));
  const ideasAfterReplay = await get('/api/ideas');
  ok('重放不产生重复记录', ideasAfterReplay.filter((i) => i.id === ideaId).length === 1);
  ok('重放不覆盖内容', ideasAfterReplay.find((i) => i.id === ideaId).title === '第一版');

  /* ---------- 2. 重放幂等不吞真冲突 ---------- */
  // 电脑端此时改过这条（updated_at 被改写、内容也不同）
  const desktopEdit = await put(`/api/ideas/${ideaId}`, { title: '电脑端改', content: 'v2-desktop' });
  ok('前置：电脑端编辑成功', desktopEdit.status === 200);
  const staleReplay = await post('/api/sync/push', { ideas: [op(ideaId, {
    title: '第一版', content: 'v1', base_updated_at: T0, updated_at: clientEditAt,
  })] });
  ok('服务端内容已变 → 重放仍判 conflict（不误判为已应用）',
    staleReplay.body.results[0].status === 'conflict', JSON.stringify(staleReplay.body.results[0]));

  // 同基线但内容不同的 op 也不是重放
  const tampered = await post('/api/sync/push', { ideas: [op(ideaId, {
    title: '第一版-篡改', content: 'v1', base_updated_at: T0, updated_at: clientEditAt,
  })] });
  ok('同基线不同内容 → conflict', tampered.body.results[0].status === 'conflict',
    JSON.stringify(tampered.body.results[0]));

  /* ---------- 3. 既有幂等分支不回归 ---------- */
  const dupCreateId = randomUUID();
  const c1 = await post('/api/sync/push', { ideas: [op(dupCreateId, {
    op: 'create', title: '新建', content: '', base_updated_at: '', updated_at: '2026-01-03T00:00:00.000Z',
  })] });
  const c2 = await post('/api/sync/push', { ideas: [op(dupCreateId, {
    op: 'create', title: '新建', content: '', base_updated_at: '', updated_at: '2026-01-03T00:00:00.000Z',
  })] });
  ok('create 重放 → ok + already', c1.body.results[0].status === 'ok' && c2.body.results[0].status === 'ok'
    && c2.body.results[0].already === true, JSON.stringify([c1.body.results[0], c2.body.results[0]]));

  // delete 重放：另一条随记，基线取它当前的 updated_at
  const delCreated = await post('/api/ideas', { title: '待删', content: '', origin: 'mobile' });
  const delId = delCreated.body.id;
  const d1 = await post('/api/sync/push', { ideas: [op(delId, {
    op: 'delete', title: '', content: '', base_updated_at: delCreated.body.updated_at,
  })] });
  const d2 = await post('/api/sync/push', { ideas: [op(delId, {
    op: 'delete', title: '', content: '', base_updated_at: delCreated.body.updated_at,
  })] });
  ok('delete 首次 → ok + deleted', d1.body.results[0].status === 'ok' && d1.body.results[0].deleted === true,
    JSON.stringify(d1.body.results[0]));
  ok('delete 重放 → missing（幂等收尾）', d2.body.results[0].status === 'missing', JSON.stringify(d2.body.results[0]));

  /* ---------- 4. S2：时钟异常时 update 重放不得误报冲突 ---------- */
  // updated_at 故意用一个远超 30 天的旧时间：服务端的 isoOrNow() 会把越界时间
  // 重写成「当前时间」，于是同一个请求重发两次，算出来的时间并不相同。
  // 判定操作身份不能靠时间——否则第一次成功后重发就会误报冲突、队列从此卡死。
  const s2Created = await post('/api/ideas', { title: 'S2', content: 'v0', origin: 'mobile' });
  const s2Id = s2Created.body.id;
  const s2Base = s2Created.body.updated_at;
  const s2Op = { op: 'update', title: 'S2改', content: 'v1', base_updated_at: s2Base, updated_at: '2000-01-01T00:00:00.000Z' };
  const s2First = await post('/api/sync/push', { ideas: [op(s2Id, s2Op)] });
  ok('S2 首次 update → ok', s2First.body.results[0].status === 'ok' && s2First.body.results[0].applied === true,
    JSON.stringify(s2First.body.results[0]));
  await sleep(30);
  const s2Replay = await post('/api/sync/push', { ideas: [op(s2Id, s2Op)] });
  ok('S2 同一请求重放 → ok（不因重新清洗时间误报冲突）', s2Replay.body.results[0].status === 'ok',
    JSON.stringify(s2Replay.body.results[0]));
  ok('S2 重放标记 already 且内容未被覆盖',
    s2Replay.body.results[0].already === true && s2Replay.body.results[0].idea
    && s2Replay.body.results[0].idea.content === 'v1', JSON.stringify(s2Replay.body.results[0]));
  const s2After = (await get('/api/ideas')).find((i) => i.id === s2Id);
  ok('S2 重放后服务端仍是手机那一版', s2After.content === 'v1' && s2After.title === 'S2改', JSON.stringify(s2After));

  /* ---------- 5. S1：旧 create 重放不得覆盖别的端后来的修改 ---------- */
  // 手机 create 已被服务端应用，但响应在回程丢了；电脑端随后改了这条；
  // 手机把原 create 重发一次（老客户端形态：没有 operation_id）。
  const s1Id = randomUUID();
  const s1Create = { op: 'create', title: '手机写的', content: 'v1', base_updated_at: '', updated_at: '2026-01-03T00:00:00.000Z' };
  const s1First = await post('/api/sync/push', { ideas: [op(s1Id, s1Create)] });
  ok('S1 首次 create → ok', s1First.body.results[0].status === 'ok' && s1First.body.results[0].applied === true,
    JSON.stringify(s1First.body.results[0]));
  const s1DesktopEdit = await put(`/api/ideas/${s1Id}`, { title: '电脑改的', content: 'v2-desktop' });
  ok('S1 前置：电脑端改过这条', s1DesktopEdit.status === 200);
  const s1Replay = await post('/api/sync/push', { ideas: [op(s1Id, s1Create)] });
  const s1Now = (await get('/api/ideas')).find((i) => i.id === s1Id);
  ok('S1 旧 create 重放没有覆盖电脑端的新内容', s1Now.title === '电脑改的' && s1Now.content === 'v2-desktop',
    JSON.stringify({ result: s1Replay.body.results[0], now: s1Now }));
  ok('S1 旧 create 重放不写第二条记录', (await get('/api/ideas')).filter((i) => i.id === s1Id).length === 1);

  /* ---------- 6. 老客户端没有操作标识时的保守路径 ---------- */
  // 没有 operation_id、又无法确认是重试的 create（内容与现存不同）：
  // 不能静默覆盖别的端的修改，保留冲突让用户选。
  const oldId = randomUUID();
  const oldFirst = await post('/api/sync/push', { ideas: [op(oldId, {
    op: 'create', title: '旧客户端', content: 'v1', base_updated_at: '', updated_at: '2026-01-03T00:00:00.000Z',
  })] });
  ok('旧客户端 create → ok', oldFirst.body.results[0].status === 'ok', JSON.stringify(oldFirst.body.results[0]));
  const oldDifferent = await post('/api/sync/push', { ideas: [op(oldId, {
    op: 'create', title: '旧客户端', content: 'v2-不同内容', base_updated_at: '', updated_at: '2026-01-04T00:00:00.000Z',
  })] });
  ok('旧客户端无标识且内容不同 → conflict（保守，不静默覆盖）',
    oldDifferent.body.results[0].status === 'conflict', JSON.stringify(oldDifferent.body.results[0]));
  const oldNow = (await get('/api/ideas')).find((i) => i.id === oldId);
  ok('旧客户端保守路径下内容未被覆盖', oldNow.content === 'v1', JSON.stringify(oldNow));

  /* ---------- 7. 带 operation_id 的新客户端：同一身份重放=已应用，不同身份=新编辑 ---------- */
  const newId = randomUUID();
  const newOpId = randomUUID();
  const newCreate = { op: 'create', title: '新客户端', content: 'v1', base_updated_at: '', updated_at: '2026-01-05T00:00:00.000Z', operation_id: newOpId };
  const n1 = await post('/api/sync/push', { ideas: [op(newId, newCreate)] });
  ok('新客户端 create → ok', n1.body.results[0].status === 'ok', JSON.stringify(n1.body.results[0]));
  const n2 = await post('/api/sync/push', { ideas: [op(newId, newCreate)] });
  ok('新客户端同一 operation_id 重放 → already',
    n2.body.results[0].status === 'ok' && n2.body.results[0].already === true, JSON.stringify(n2.body.results[0]));
  // 同一 operation_id 换内容 → 受控拒绝，不能当成重放成功
  const n3 = await post('/api/sync/push', { ideas: [op(newId, { ...newCreate, content: 'v2-同身份不同内容' })] });
  ok('同一 operation_id 携带不同内容 → 受控拒绝（conflict）',
    n3.body.results[0].status === 'conflict', JSON.stringify(n3.body.results[0]));
  // 换一个新 operation_id = 新的用户操作 → 内容写上去
  const n4 = await post('/api/sync/push', { ideas: [op(newId, { ...newCreate, content: 'v3-新操作', base_updated_at: n1.body.results[0].idea.updated_at, operation_id: randomUUID() })] });
  ok('新 operation_id = 新的用户操作 → 内容写上去',
    n4.body.results[0].status === 'ok' && n4.body.results[0].applied === true, JSON.stringify(n4.body.results[0]));
  const nNow = (await get('/api/ideas')).find((i) => i.id === newId);
  ok('新操作的内容已成为服务端版本', nNow.content === 'v3-新操作', JSON.stringify(nNow));

  /* ---------- 7b. 手机的新编辑遇上电脑端的修改 → 保留冲突，不静默覆盖 ---------- */
  // 走 create 分支也不能绕开乐观锁：客户端带了基线就说明它知道服务端当前版本，
  // 对不上说明别的端改过——这时该让用户选，而不是用手机内容盖掉电脑端的修改。
  const clashId = randomUUID();
  const clashOpId = randomUUID();
  const clashCreate = { op: 'create', title: '撞车', content: '手机版', base_updated_at: '', updated_at: '2026-01-06T00:00:00.000Z', operation_id: clashOpId };
  const cc1 = await post('/api/sync/push', { ideas: [op(clashId, clashCreate)] });
  ok('撞车前置：手机 create 已应用', cc1.body.results[0].status === 'ok', JSON.stringify(cc1.body.results[0]));
  const serverVersion = (await get('/api/ideas')).find((i) => i.id === clashId).updated_at;
  // 电脑端改了这条
  await put(`/api/ideas/${clashId}`, { title: '撞车', content: '电脑版' });
  // 手机在途期间又编辑（新操作身份，基线仍是它知道的旧版本）
  const cc2 = await post('/api/sync/push', { ideas: [op(clashId, {
    op: 'create', title: '撞车', content: '手机改的第二版', base_updated_at: serverVersion,
    updated_at: '2026-01-07T00:00:00.000Z', operation_id: randomUUID(),
  })] });
  ok('手机新编辑遇上电脑端修改 → conflict（不静默覆盖）',
    cc2.body.results[0].status === 'conflict', JSON.stringify(cc2.body.results[0]));
  const clashNow = (await get('/api/ideas')).find((i) => i.id === clashId);
  ok('冲突时电脑端的内容没有被手机版盖掉', clashNow.content === '电脑版', JSON.stringify(clashNow));


  // 新操作身份不能替代有效基线，未见过电脑修改时必须冲突。
  const emptyBase = await post('/api/sync/push', { ideas: [op(clashId, {
    op: 'create', title: '撞车', content: '没有基线的新操作', base_updated_at: '', operation_id: randomUUID(),
  })] });
  ok('新身份 + 空基线不能覆盖已存在随记', emptyBase.body.results[0].status === 'conflict');
  ok('无基线覆盖被拒后保留电脑内容', (await get('/api/ideas')).find(i => i.id === clashId).content === '电脑版');

  const historyId = randomUUID();
  const historyOp = op(historyId, { op: 'create', operation_id: randomUUID(), content: '初始创建', updated_at: new Date().toISOString() });
  await post('/api/sync/push', { ideas: [historyOp] });
  for (let j = 0; j < 10; j++) {
    const current = (await get('/api/ideas')).find(i => i.id === historyId);
    await post('/api/sync/push', { ideas: [{ ...historyOp, op: 'update', operation_id: randomUUID(),
      content: '修改' + j, base_updated_at: current.updated_at, updated_at: new Date().toISOString() }] });
  }
  const beforeDelete = (await get('/api/ideas')).find(i => i.id === historyId);
  await post('/api/sync/push', { ideas: [{ ...historyOp, op: 'delete', operation_id: randomUUID(), base_updated_at: beforeDelete.updated_at }] });
  const afterEviction = await post('/api/sync/push', { ideas: [historyOp] });
  ok('回执淘汰后重放旧创建不会复活已删记录', afterEviction.body.results[0].status === 'missing');
  ok('重放后服务端列表中没有已删记录', !(await get('/api/ideas')).some(i => i.id === historyId));

  /* ---------- 8. 回执必须落盘：服务重启后重试仍认得出 ---------- */
  await stopServer();
  startServer(port);
  ok('重启后服务恢复', await waitUp());
  const deletedReplay = await post('/api/sync/push', { ideas: [historyOp] });
  ok('重启后仍拒绝复活已删除记录', deletedReplay.body.results[0].status === 'missing');
  const afterRestart = await post('/api/sync/push', { ideas: [op(s2Id, s2Op)] });
  ok('重启后同一请求重放仍判已应用（回执不是只存在内存）',
    afterRestart.body.results[0].status === 'ok' && afterRestart.body.results[0].already === true,
    JSON.stringify(afterRestart.body.results[0]));
  const s2AfterRestart = (await get('/api/ideas')).find((i) => i.id === s2Id);
  ok('重启后内容未被旧请求覆盖', s2AfterRestart.content === 'v1', JSON.stringify(s2AfterRestart));
  const s1AfterRestart = await post('/api/sync/push', { ideas: [op(s1Id, s1Create)] });
  const s1Final = (await get('/api/ideas')).find((i) => i.id === s1Id);
  ok('重启后旧 create 重放仍不覆盖电脑端新内容',
    s1Final.title === '电脑改的' && s1Final.content === 'v2-desktop', JSON.stringify(s1Final));
  ok('重启后旧 create 重放不写第二条记录', (await get('/api/ideas')).filter((i) => i.id === s1Id).length === 1);
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
  console.error('\n✗ 同步重放幂等回归失败');
} else {
  console.log(`\n✓ 同步重放幂等回归全部通过（${passed} 项）`);
}
