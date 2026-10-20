/** 出队竞态回归：隔离服务器 + Edge + 真实 IndexedDB + 真实同步引擎。
 * 场景：push 在途期间用户又编辑了同一条随记（同 id 覆盖写队列）。
 * 断言：新编辑不被删除、基线被推进、下一轮推送成功、界面始终显示用户刚写的内容。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'danji-outbox-race-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await check()) return; await pause(50); }
  throw new Error('Timed out: ' + label);
}
async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
const fixture = `<!doctype html><meta charset="utf-8"><script src="/vendor/vue.global.prod.js"></script>
<script type="module">
  window.pushDelayMs = 0;
  window.pushInFlight = 0;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (url, init) => {
    const u = String(url);
    if (u.includes('/api/')) {
      init = { ...init, headers: { ...init?.headers, 'X-Test-Mobile': '1' } };
    }
    // 只把 push 的响应扣住一段时间：模拟「请求在途」的窗口
    if (u.includes('/api/sync/push') && window.pushDelayMs > 0) {
      window.pushInFlight++;
      return originalFetch(url, init).then((res) => new Promise((resolve) => {
        setTimeout(() => { window.pushInFlight--; resolve(res); }, window.pushDelayMs);
      }));
    }
    return originalFetch(url, init);
  };
  localStorage.setItem('danji.serverBase', location.origin);
  window.Capacitor = { isNativePlatform: () => true, Plugins: { BackgroundSync: {
    readSnapshot: async () => ({ data: localStorage.getItem('test.snapshot') || '' }),
    getSyncedVersion: async () => JSON.parse(localStorage.getItem('test.ledger') || '{"version":0,"bootId":""}'),
    noteSynced: async value => localStorage.setItem('test.ledger', JSON.stringify(value)),
  } } };
  window.engine = await import('/js/sync/engine.js');
  window.state = (await import('/js/state.js')).state;
  await engine.initSync();
  window.ready = true;
</script>`;
let server, browser, ws;
try {
  for (const item of ['server.js', 'lib', 'public']) {
    await fs.cp(path.join(root, item), path.join(temp, item), { recursive: true });
  }
  // 仅在临时服务模拟远程手机身份；生产服务的身份识别和权限代码保持原样。
  const serverFile = path.join(temp, 'server.js');
  const serverSource = await fs.readFile(serverFile, 'utf8');
  assert.ok(serverSource.includes('const role = clientRole(req);'));
  await fs.writeFile(serverFile, serverSource.replace('const role = clientRole(req);',
    "const role = req.headers['x-test-mobile'] === '1' ? 'mobile' : clientRole(req);"));
  const papers = path.join(temp, 'isolated-papers');
  await fs.mkdir(papers);
  await fs.writeFile(path.join(temp, 'public/sync-fixture.html'), fixture);
  const port = await freePort(), debugPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  async function startServer() {
    server = spawn(process.execPath, ['server.js'], { cwd: temp, windowsHide: true,
      env: { ...process.env, PORT: String(port), DANJI_HOST: '127.0.0.1', DANJI_TOKEN: '', DANJI_PAPERS_DIR: papers },
      stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    server.stderr.on('data', data => { errors += data; });
    await eventually(async () => {
      if (server.exitCode !== null) throw new Error(errors);
      try { return (await fetch(base + '/api/health')).ok; } catch { return false; }
    }, 'isolated server');
  }
  async function stop(child) {
    if (!child || child.exitCode !== null) return;
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill(); await closed;
  }
  await startServer();
  async function api(endpoint, method = 'GET', body) {
    const res = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(res.ok, endpoint + ': ' + res.status);
    return res.json();
  }
  // 手机端自己建的随记（origin=mobile，手机可写）
  const idea = await api('/api/ideas', 'POST', { title: '初始标题', content: 'v0', origin: 'mobile' });
  let edge = process.env.EDGE_PATH;
  if (!edge) {
    for (const dir of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)) {
      const candidate = path.join(dir, 'Microsoft/Edge/Application/msedge.exe');
      try { await fs.access(candidate); edge = candidate; break; } catch { }
    }
  }
  assert.ok(edge, 'Edge is required; set EDGE_PATH if installed elsewhere');
  browser = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--disable-background-networking', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(temp, 'browser-profile')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let target;
  await eventually(async () => {
    try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(t => t.type === 'page'); return !!target; }
    catch { return false; }
  }, 'Edge');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data), callback = pending.get(msg.id);
    if (callback) { pending.delete(msg.id); msg.error ? callback.reject(new Error(JSON.stringify(msg.error))) : callback.resolve(msg.result); }
  });
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error('CDP timeout ' + method)); }, 15000);
      pending.set(requestId, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      ws.send(JSON.stringify({ id: requestId, method, params }));
    });
  }
  async function evaluate(expression) {
    const res = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  }
  async function open() {
    await cdp('Page.navigate', { url: base + '/sync-fixture.html' });
    await eventually(() => evaluate('window.ready === true'), 'sync fixture');
    await pause(100);
  }
  await open();
  assert.equal(await evaluate('(async () => (await engine.syncNow()).ok)()'), true);
  const baseIdea = await api('/api/ideas');
  const synced = baseIdea.find((i) => i.id === idea.id);
  assert.ok(synced, '镜像里应有这条随记');
  const T0 = synced.updated_at;

  /* ---- 竞态：push 在途期间又编辑同一条 ---- */
  await evaluate('window.pushDelayMs = 800');
  // 第一次编辑：入队并触发同步（push 响应被扣住 800ms）
  await evaluate(`(async () => {
    await engine.enqueueIdeaLocal({ op: 'update', id: ${JSON.stringify(idea.id)},
      payload: { title: '第一版', content: 'v1' }, baseUpdatedAt: ${JSON.stringify(T0)} });
  })()`);
  // 在途窗口内取出队列项（push 发出的那一版）
  const entryV1 = await evaluate(`(async () => (await import('/js/sync/outbox.js')).getOutbox(${JSON.stringify(idea.id)}))()`);
  assert.equal(entryV1.payload.title, '第一版');
  // 200ms 后用户又编辑：同 id 覆盖写队列
  await pause(200);
  await evaluate(`(async () => {
    await engine.enqueueIdeaLocal({ op: 'update', id: ${JSON.stringify(idea.id)},
      payload: { title: '第二版', content: 'v2' }, baseUpdatedAt: ${JSON.stringify(T0)} });
  })()`);
  // 等这一轮同步跑完（push 响应 800ms 后回来 + pull）
  await eventually(() => evaluate('state.sync.status !== "syncing"'), 'raced sync cycle');

  // 1) 队列项必须还在，且是用户刚写的「第二版」——没被旧版本出队删掉
  const entryV2 = await evaluate(`(async () => (await import('/js/sync/outbox.js')).getOutbox(${JSON.stringify(idea.id)}))()`);
  assert.ok(entryV2, '竞态后队列项必须保留（新编辑不被静默删除）');
  assert.equal(entryV2.payload.title, '第二版', '队列里应是用户刚写的第二版');
  assert.notEqual(entryV2.updated_at, entryV1.updated_at, '队列项应已被新编辑覆盖');
  // 操作身份：新的用户编辑必须换新身份（否则服务端会把它当成旧请求的重放而丢掉）
  assert.ok(entryV1.operation_id, '队列项必须带操作身份 operation_id');
  assert.notEqual(entryV2.operation_id, entryV1.operation_id, '新的用户编辑必须换新的操作身份');
  // 2) 乐观锁基线推进到服务端刚确认的版本（第一版的时间），否则下一轮会撞假冲突
  assert.equal(entryV2.base_updated_at, entryV1.payload.updated_at,
    'base_updated_at 必须推进到服务端确认的版本，不能留在旧基线');
  // 3) 服务端此时只有第一版（它只收到了在途那一版）
  const afterRace = (await api('/api/ideas')).find((i) => i.id === idea.id);
  assert.equal(afterRace.title, '第一版', '服务端只应用了在途那一版');
  // 4) 没有产生任何冲突提示
  assert.equal(await evaluate('state.sync.conflicts.length'), 0, '竞态不应产生冲突');
  // 5) 界面显示用户刚写的第二版（本地 payload 叠加，不被旧版本覆盖）
  // 注意：state.ideas 是 Vue reactive 对象，CDP returnByValue 序列化 Proxy 会丢字段，
  // 先在页面里 JSON 化成纯对象再取回
  const shown = await evaluate(`JSON.parse(JSON.stringify(state.ideas.find(i => i.id === ${JSON.stringify(idea.id)}) || null))`);
  assert.ok(shown, '界面应能看到这条随记');
  assert.equal(shown.title, '第二版', '界面必须显示用户刚写的内容');

  /* ---- 下一轮推送：基线已对齐，应成功且不判冲突 ---- */
  const second = await evaluate('(async () => (await engine.syncNow()).push)()');
  assert.equal(second.pushed, 1, '下一轮推送应成功推出第二版');
  assert.ok(second.results.every((r) => r.status === 'ok'), '重发不得判 conflict: ' + JSON.stringify(second.results));
  // 队列清空、服务端与镜像都是第二版
  const drained = await evaluate(`(async () => (await import('/js/sync/outbox.js')).getOutbox(${JSON.stringify(idea.id)}))()`);
  assert.equal(drained, null, '推送成功后队列项应出队');
  const final = (await api('/api/ideas')).find((i) => i.id === idea.id);
  assert.equal(final.title, '第二版', '服务端最终是用户刚写的第二版');
  const mirror = await evaluate(`(async () => (await import('/js/sync/mirror.js')).readCollection('ideas'))()`);
  assert.equal(mirror.items.find((i) => i.id === idea.id).title, '第二版', '镜像最终是第二版');
  const shownFinal = await evaluate(`JSON.parse(JSON.stringify(state.ideas.find(i => i.id === ${JSON.stringify(idea.id)}) || null))`);
  assert.equal(shownFinal.title, '第二版', '界面最终是第二版');
  console.log('✓ 并发编辑不被删除、基线推进、下一轮推送成功、界面始终显示最新内容');

  /* ---- 竞态（create 路径）：新建的随记在 push 在途期间又被编辑 ----
   * 与上一条用例同一类竞态，但走的是「本地新建」这条路：
   * outbox 对同一 id 只留一条，未确认的 create + update 折叠后仍是 create，
   * 于是下一轮重发的还是 create。服务端若把「已存在」一律当纯重放丢掉，
   * 用户在途期间写的内容就会永久消失（服务端/队列/镜像三处都没有）。
   */
  const freshId = randomUUID();
  await evaluate('window.pushDelayMs = 800');
  // 第一次：手机本地新建，触发同步；push 响应被扣住 800ms
  await evaluate(`(async () => {
    await engine.enqueueIdeaLocal({ op: 'create', id: ${JSON.stringify(freshId)},
      payload: { title: '新建第一版', content: 'c1' } });
  })()`);
  // 等 push 请求真的发出去了再编辑——在途窗口必须是确定的，不能靠 sleep 猜
  await eventually(() => evaluate('window.pushInFlight > 0'), 'create push in flight');
  // 用户在途窗口内又编辑同一条：同 id 覆盖写队列
  await evaluate(`(async () => {
    await engine.enqueueIdeaLocal({ op: 'update', id: ${JSON.stringify(freshId)},
      payload: { title: '新建第二版', content: 'c2' } });
  })()`);
  await eventually(() => evaluate('state.sync.status !== "syncing"'), 'raced create sync cycle');

  // 1) 队列项必须还在，且折叠后仍是 create（未确认的新建 + 编辑）
  const createEntry = await evaluate(`(async () => (await import('/js/sync/outbox.js')).getOutbox(${JSON.stringify(freshId)}))()`);
  assert.ok(createEntry, 'create 竞态后队列项必须保留（在途编辑不能被静默删除）');
  assert.equal(createEntry.op, 'update', '旧 create 确认后，后续编辑转为有基线的 update');
  assert.equal(createEntry.payload.title, '新建第二版', '队列里应是用户改后的第二版');
  // 操作身份：新用户操作换新身份，服务端才认得出「这是新编辑」而不是旧请求的重放
  assert.ok(createEntry.operation_id, '队列项必须带操作身份 operation_id');
  assert.ok(createEntry.confirmed && createEntry.base_updated_at, '已确认创建的后续编辑必须带因果基线');
  // 2) 服务端此时只有第一版（它只收到了在途那一版）
  const createAfterRace = (await api('/api/ideas')).find((i) => i.id === freshId);
  assert.ok(createAfterRace, '服务端应已收到在途那一版');
  assert.equal(createAfterRace.title, '新建第一版', '服务端此时只有第一版');
  // 3) 没有产生冲突
  assert.equal(await evaluate('state.sync.conflicts.length'), 0, 'create 竞态不应产生冲突');

  /* ---- 下一轮推送：服务端必须把第二版写上去，而不是当纯重放丢掉 ---- */
  const createPush = await evaluate('(async () => (await engine.syncNow()).push)()');
  assert.equal(createPush.pushed, 1, '下一轮应推出 create 的第二版');
  assert.ok(createPush.results.every((r) => r.status === 'ok'), '重发 create 不得判 conflict: ' + JSON.stringify(createPush.results));
  const createDrained = await evaluate(`(async () => (await import('/js/sync/outbox.js')).getOutbox(${JSON.stringify(freshId)}))()`);
  assert.equal(createDrained, null, '推送成功后队列项应出队');
  const createFinal = (await api('/api/ideas')).find((i) => i.id === freshId);
  assert.equal(createFinal.title, '新建第二版', '服务端最终必须是用户改后的第二版（当重放丢掉时会是第一版）');
  const createMirror = await evaluate(`(async () => (await import('/js/sync/mirror.js')).readCollection('ideas'))()`);
  assert.equal(createMirror.items.find((i) => i.id === freshId).title, '新建第二版', '镜像最终是第二版');
  const createShown = await evaluate(`JSON.parse(JSON.stringify(state.ideas.find(i => i.id === ${JSON.stringify(freshId)}) || null))`);
  assert.ok(createShown, '界面应能看到这条新建的随记');
  assert.equal(createShown.title, '新建第二版', '界面最终是第二版');
  console.log('✓ create 路径竞态：新建随记在 push 在途期间的编辑不被丢弃');

  /* ---- S3：create 在途期间用户删除 ----
   * 旧实现：本地 create+delete 折叠成空（整条取消），旧的成功响应回来后
   * 又把记录写回镜像 —— 看起来「删了又活过来」。
   * 现在：已发出的 create 遇到删除，删除意图保留到安全收尾（折叠成 delete），
   * 由服务端真正删除并进回收站；镜像里不会复活。 */
  const delId = randomUUID();
  await evaluate('window.pushDelayMs = 800');
  // 手机本地新建，随记随同步发出（响应被扣住 800ms）
  await evaluate(`(async () => {
    await engine.enqueueIdeaLocal({ op: 'create', id: ${JSON.stringify(delId)},
      payload: { title: '在途删除的新建', content: 'to-delete' } });
  })()`);
  await eventually(() => evaluate('window.pushInFlight > 0'), 'create push in flight (delete case)');
  // 用户在 push 在途期间删除同一条
  await evaluate(`(async () => {
    await engine.enqueueIdeaLocal({ op: 'delete', id: ${JSON.stringify(delId)}, payload: null, baseUpdatedAt: '' });
  })()`);
  await eventually(() => evaluate('state.sync.status !== "syncing"'), 'raced delete cycle');

  // 1) 删除意图必须保留：队列项不能整条消失
  const delEntry = await evaluate(`(async () => (await import('/js/sync/outbox.js')).getOutbox(${JSON.stringify(delId)}))()`);
  assert.ok(delEntry, '删除意图必须保留到安全收尾（不能整条取消）');
  assert.equal(delEntry.op, 'delete', '队列项应折叠为 delete');
  // 2) 界面不得把它当活跃记录显示：本地删除意图要盖住镜像里服务端那条
  // （镜像里此时确实有它——服务端已经创建过；pull 会如实拉回来，这是对的。
  //  错的是「用户明明删了，界面又冒出来」）
  const delShown = await evaluate(`JSON.parse(JSON.stringify(state.ideas.find(i => i.id === ${JSON.stringify(delId)}) || null))`);
  assert.equal(delShown, null, '已删除的记录不能在界面上复活');
  // 3) 服务端此时确实已经创建了这条（create 的响应虽然被扣住，但服务端已落库）
  const delOnServer = (await api('/api/ideas')).find((i) => i.id === delId);
  assert.ok(delOnServer, '服务端此时已创建这条');

  // 4) 下一轮同步：服务端完成删除并进回收站
  await evaluate('window.pushDelayMs = 0');
  const delPush = await evaluate('(async () => (await engine.syncNow()).push)()');
  assert.equal(delPush.pushed, 1, '下一轮应推出这条 delete');
  assert.ok(delPush.results.every((r) => r.status === 'ok'), 'delete 不得判 conflict: ' + JSON.stringify(delPush.results));
  const delGone = (await api('/api/ideas')).find((i) => i.id === delId);
  assert.equal(delGone, undefined, '服务端应已删除这条');
  // 回收站是异步写入的（push 响应先返回，入回收站随后落盘），轮询等它落地。
  // 回收站条目有自己的新 id，原记录在 payload 里。
  let trashed = null;
  await eventually(async () => {
    const items = (await api('/api/trash')).items || [];
    if (!items.some((t) => t.payload && t.payload.id === delId)) return false;
    trashed = items;
    return true;
  }, 'deleted idea reaches trash');
  assert.ok(trashed.some((t) => t.payload && t.payload.id === delId),
    '删除后应进回收站（反悔的余地与电脑端一致）');
  const delDrained = await evaluate(`(async () => (await import('/js/sync/outbox.js')).getOutbox(${JSON.stringify(delId)}))()`);
  assert.equal(delDrained, null, '删除完成后队列项应出队');
  const delMirrorFinal = await evaluate(`(async () => (await import('/js/sync/mirror.js')).readCollection('ideas'))()`);
  assert.equal(delMirrorFinal.items.find((i) => i.id === delId), undefined, '镜像最终也不该有这条');
  console.log('✓ create 在途删除：删除意图保留、记录不复活、服务端删除并进回收站');

  /* ---- S3 反面：确实从未发出的离线 create+delete 仍应整条取消 ---- */
  // 前提是「从未发出」：这里直接写真实 IndexedDB 队列（真实 outbox 模块），
  // 不经过引擎的自动同步触发——否则它会立刻被发出去，就不是「从未发出」了。
  const neverSentId = randomUUID();
  await evaluate(`(async () => {
    const ob = await import('/js/sync/outbox.js');
    const now = new Date().toISOString();
    await ob.enqueueOutbox({ id: ${JSON.stringify(neverSentId)}, op: 'create',
      payload: { id: ${JSON.stringify(neverSentId)}, title: '离线新建又删', content: 'never-sent' },
      base_updated_at: '', confirmed: false, updated_at: now, origin: 'mobile', operation_id: 'op-never-sent' });
    await ob.enqueueOutbox({ id: ${JSON.stringify(neverSentId)}, op: 'delete', payload: null,
      base_updated_at: '', confirmed: true, updated_at: now, origin: 'mobile', operation_id: 'op-never-sent-del' });
  })()`);
  const neverSentEntry = await evaluate(`(async () => (await import('/js/sync/outbox.js')).getOutbox(${JSON.stringify(neverSentId)}))()`);
  assert.equal(neverSentEntry, null, '从未发出的离线 create+delete 应整条取消');
  console.log('✓ 从未发出的离线 create+delete 仍可整条取消');

  const atomic = await evaluate(`(async () => {
    const ob = await import('/js/sync/outbox.js');
    const entry = {id:'transaction-fixture',op:'create',operation_id:'first',updated_at:'same-time',payload:{title:'first'}};
    await ob.enqueueOutbox(entry);
    const stale = await ob.getOutbox(entry.id);
    await ob.enqueueOutbox({id:entry.id,op:'delete',operation_id:'delete',updated_at:'same-time'});
    const claim = await ob.mutateOutbox(entry.id, current => ob.sameOutboxOperation(current, stale) ? {...current,sent:true} : undefined);
    const absent = await ob.getOutbox(entry.id);
    await ob.putOutbox({...entry, counter:0});
    await Promise.all(Array.from({length:20},()=>ob.mutateOutbox(entry.id,current=>({...current,counter:current.counter+1}))));
    const counter = (await ob.getOutbox(entry.id)).counter;
    let rolledBack = false;
    try { await ob.mutateOutbox(entry.id, () => { throw new Error('fixture rollback'); }); }
    catch { rolledBack = (await ob.getOutbox(entry.id)).counter === 20; }
    await ob.dequeueOutbox(entry.id);
    return {staleClaimRejected:!claim.changed&&absent===null,counter,rolledBack};
  })()`);
  assert.deepEqual(atomic, {staleClaimRejected:true,counter:20,rolledBack:true}, '队列比较写回应在真实 IDB 事务内串行并可回滚');
  console.log('✓ 原子队列：过期认领不复活、并发写不丢失、失败事务回滚');

  {
  const pictureId = randomUUID();
  await evaluate('window.pushDelayMs = 1500');
  await evaluate(`(async () => {
    const images = await import('/js/local-images.js');
    const image = await images.saveLocalImage(new Blob([new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0])], {type:'image/png'}), 'fixture.png');
    await engine.enqueueIdeaLocal({op:'create', id:${JSON.stringify(pictureId)},payload:{title:'pictured note',content:'delete me',images:[image]}});
  })()`);
  await eventually(() => evaluate('window.pushInFlight > 0'), 'pictured create in flight');
  const before = await evaluate(`(async () => (await import('/js/sync/outbox.js')).getOutbox(${JSON.stringify(pictureId)}))()`);
  await evaluate(`engine.enqueueIdeaLocal({op:'delete',id:${JSON.stringify(pictureId)},payload:null,baseUpdatedAt:''})`);
  await eventually(() => evaluate('state.sync.status !== "syncing"'), 'pictured delete settle');
  const after = await evaluate(`(async () => ({queued:await (await import('/js/sync/outbox.js')).getOutbox(${JSON.stringify(pictureId)}),shown:state.ideas.some(i=>i.id===${JSON.stringify(pictureId)})}))()`);
  assert.ok(before.sent, '带图请求发出后 sent 标记不可被图片写回抹掉');
  assert.equal(after.shown, false, '带图新建在途删除后不能复活');
  assert.equal(after.queued?.op, 'delete', '带图删除必须保留补偿操作');
  console.log(JSON.stringify({case:'real_idb_local_image_create_deleted_in_flight',sentBeforeDelete:!!before.sent,queueAfterAck:after.queued?.op||null,deletedNoteShownAgain:after.shown}));

  await evaluate('window.pushDelayMs=0');
  await evaluate('engine.syncNow()');
  assert.ok(!(await api('/api/ideas')).some(i=>i.id===pictureId), '带图记录下一轮必须完成删除');
  await open();
  assert.equal(await evaluate(`state.ideas.some(i=>i.id===${JSON.stringify(pictureId)})`), false, '重开后仍不复活');
  const clashId = randomUUID();
  await evaluate('window.pushDelayMs = 1500');
  await evaluate(`engine.enqueueIdeaLocal({op:'create',id:${JSON.stringify(clashId)},payload:{title:'clash',content:'mobile first'}})`);
  await eventually(() => evaluate('window.pushInFlight > 0'), 'clash create in flight');
  await eventually(async()=> (await api('/api/ideas')).some(i=>i.id===clashId), 'server create applied');
  await api('/api/ideas/'+clashId,'PUT',{content:'desktop changed while response held'});
  await evaluate(`engine.enqueueIdeaLocal({op:'update',id:${JSON.stringify(clashId)},payload:{title:'clash',content:'mobile second'},baseUpdatedAt:''})`);
  await eventually(() => evaluate('state.sync.status !== "syncing"'), 'clash first settle');
  const queued = await evaluate(`(async () => (await import('/js/sync/outbox.js')).getOutbox(${JSON.stringify(clashId)}))()`);
  await evaluate('window.pushDelayMs=0');
  const pushed = await evaluate('engine.syncNow()');
  const final = (await api('/api/ideas')).find(i=>i.id===clashId);
  assert.equal(pushed.push.results.find(i=>i.id===clashId).status, 'conflict', '真实跨端编辑必须保留冲突');
  assert.equal(final.content, 'desktop changed while response held', '不得覆盖电脑端修改');
  console.log(JSON.stringify({case:'real_idb_create_edit_with_intervening_desktop_edit',nextOp:queued.op,nextBaseline:queued.base_updated_at||'',pushStatus:pushed.push?.results?.find(i=>i.id===clashId)?.status,desktopEditLost:final.content==='mobile second'}));

  const sameTimeId = randomUUID();
  await evaluate('window.pushDelayMs=1500; window.originalDate=Date; window.fixedNow=Date.now(); window.Date=class extends window.originalDate {constructor(...a){super(...(a.length?a:[window.fixedNow]));} static now(){return window.fixedNow;}}');
  await evaluate(`engine.enqueueIdeaLocal({op:'create',id:${JSON.stringify(sameTimeId)},payload:{title:'same tick first',content:'first'}})`);
  await eventually(() => evaluate('window.pushInFlight > 0'), 'same tick create in flight');
  const sameFirst = await evaluate(`(async () => (await import('/js/sync/outbox.js')).getOutbox(${JSON.stringify(sameTimeId)}))()`);
  await evaluate(`engine.enqueueIdeaLocal({op:'update',id:${JSON.stringify(sameTimeId)},payload:{title:'same tick second',content:'second'}})`);
  const sameSecond = await evaluate(`(async () => (await import('/js/sync/outbox.js')).getOutbox(${JSON.stringify(sameTimeId)}))()`);
  await evaluate('window.Date=window.originalDate');
  await eventually(() => evaluate('state.sync.status !== "syncing"'), 'same tick settle');
  const sameQueue = await evaluate(`(async () => (await import('/js/sync/outbox.js')).getOutbox(${JSON.stringify(sameTimeId)}))()`);
  const sameFinal = (await api('/api/ideas')).find(i=>i.id===sameTimeId);
  assert.ok(sameQueue && sameQueue.payload.content==='second', '同一毫秒的新编辑不能被旧 ack 出队');
  await evaluate('window.pushDelayMs=0');
  await evaluate('engine.syncNow()');
  assert.equal((await api('/api/ideas')).find(i=>i.id===sameTimeId).content, 'second', '新编辑下一轮必须保存');
  console.log(JSON.stringify({case:'real_idb_distinct_operations_same_clock_tick',timestampsEqual:sameFirst.updated_at===sameSecond.updated_at,operationIdsDiffer:sameFirst.operation_id!==sameSecond.operation_id,queueAfterAck:sameQueue?.op||null,newEditLost:sameQueue===null&&sameFinal.content==='first'}));
  }
  console.log('\n✓ 出队竞态回归通过（隔离数据、真实浏览器存储与引擎）');
} finally {
  ws?.close();
  for (const child of [browser, server]) {
    if (child && child.exitCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill(); await closed;
    }
  }
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}
