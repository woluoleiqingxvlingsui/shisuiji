/** 完整同步接线回归：隔离服务器 + Edge + 真实 IndexedDB；原生桥用可持久化桩代替。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'danji-sync-flow-'));
const localId = randomUUID(), conflictId = randomUUID(), successId = randomUUID();
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
  window.remoteOffline = true;
  window.badPull = false;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (url, init) => {
    if (String(url).includes('/api/')) {
      if (window.remoteOffline) return Promise.reject(new Error('isolated computer unreachable'));
      if (window.badPull && String(url).includes('/api/sync/pull')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
    }
    if (String(url).includes('/api/sync/push')) {
      init = { ...init, headers: { ...init?.headers, 'X-Test-Mobile': '1' } };
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
  let idea = await api('/api/ideas', 'POST', { title: 'initial desktop note', content: 'fixture' });
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
  async function backgroundSnapshot(title) {
    idea = await api('/api/ideas/' + idea.id, 'PUT', { ...idea, title });
    const snapshot = await api('/api/sync/pull');
    await evaluate(`localStorage.setItem('test.snapshot', ${JSON.stringify(JSON.stringify(snapshot))});
      localStorage.setItem('test.ledger', ${JSON.stringify(JSON.stringify({ version: snapshot.data_version, bootId: snapshot.boot_id }))});
      window.remoteOffline = true;`);
    return snapshot;
  }
  async function resume() {
    await evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
    await eventually(() => evaluate('state.sync.status !== "syncing"'), 'resume cycle');
  }
  await open();
  assert.equal(await evaluate('(async () => { remoteOffline = false; return (await engine.syncNow()).ok; })()'), true);
  const baseline = await api('/api/sync/pull');
  assert.equal(await evaluate(`localStorage.getItem('danji.lastBootId')`), baseline.boot_id);
  assert.equal(await evaluate(`Number(localStorage.getItem('danji.lastDataVersion'))`), baseline.data_version);
  console.log('✓ online pull preserves boot_id through the real engine and IndexedDB');

  // 快照导入必须保留尚未推送的本机记录。
  await evaluate(`(async () => {
    const { enqueueOutbox } = await import('/js/sync/outbox.js');
    await enqueueOutbox({ id: ${JSON.stringify(localId)}, op: 'create', payload: { title: 'unsent local note', content: '', origin: 'mobile' } });
  })()`);
  await backgroundSnapshot('hot-start latest');
  await resume();
  await eventually(() => evaluate(`state.ideas.some(i => i.title === 'hot-start latest')`), 'offline hot snapshot');
  assert.equal(await evaluate(`state.ideas.some(i => i.id === ${JSON.stringify(localId)})`), true);
  console.log('✓ offline hot resume imports newer snapshot and preserves local outbox');

  const coldSnapshot = await backgroundSnapshot('cold-start latest');
  await open();
  assert.equal(await evaluate(`state.ideas.some(i => i.title === 'cold-start latest')`), true);
  assert.equal(await evaluate(`state.ideas.some(i => i.id === ${JSON.stringify(localId)})`), true);
  assert.equal(await evaluate(`Number(localStorage.getItem('danji.lastDataVersion'))`), coldSnapshot.data_version);
  console.log('✓ offline cold reload imports newer snapshot from persistent storage');

  await evaluate(`localStorage.setItem('test.snapshot', ${JSON.stringify(JSON.stringify(baseline))})`);
  await resume();
  await pause(100);
  assert.equal(await evaluate(`state.ideas.some(i => i.title === 'cold-start latest')`), true);
  console.log('✓ stale snapshot cannot overwrite a newer mirror');

  await evaluate(`localStorage.setItem('test.snapshot', JSON.stringify({
    data_version: 99999, boot_id: ${JSON.stringify(baseline.boot_id)} }));`);
  await open();
  assert.equal(await evaluate(`state.ideas.some(i => i.title === 'cold-start latest')`), true);
  assert.equal(await evaluate(`Number(localStorage.getItem('danji.lastDataVersion'))`), coldSnapshot.data_version);
  console.log('✓ malformed native snapshot cannot advance the ledger without mirror data');

  await evaluate(`localStorage.setItem('danji.lastBootId', ''); remoteOffline = false`);
  assert.equal(await evaluate('(async () => (await engine.syncNow()).ok)()'), true);
  assert.equal(await evaluate(`localStorage.getItem('danji.lastBootId')`), baseline.boot_id);
  await backgroundSnapshot('repaired old ledger');
  await open();
  assert.equal(await evaluate(`state.ideas.some(i => i.title === 'repaired old ledger')`), true);
  console.log('✓ legacy empty boot ledger recovers by online pull, then offline import works');

  const beforeMalformed = await evaluate(`localStorage.getItem('danji.lastDataVersion')`);
  assert.equal(await evaluate(`(async () => { remoteOffline = false; badPull = true; return (await engine.syncNow()).ok; })()`), false);
  assert.equal(await evaluate(`localStorage.getItem('danji.lastDataVersion')`), beforeMalformed);
  await evaluate('badPull = false');
  console.log('✓ malformed HTTP 200 cannot claim sync success or advance mirror ledger');

  await api('/api/sync/push', 'POST', { ideas: [{ id: conflictId, op: 'create', title: 'mobile on server', content: '', origin: 'mobile' }] });
  await evaluate(`(async () => {
    const { enqueueOutbox } = await import('/js/sync/outbox.js');
    await enqueueOutbox({ id: ${JSON.stringify(successId)}, op: 'create', payload: { title: 'successful mobile change', content: '' } });
    await enqueueOutbox({ id: ${JSON.stringify(conflictId)}, op: 'update', confirmed: true,
      base_updated_at: '2000-01-01T00:00:00.000Z', payload: { title: 'conflicting edit', content: '' } });
    await enqueueOutbox({ id: ${JSON.stringify(idea.id)}, op: 'update', confirmed: true,
      base_updated_at: ${JSON.stringify(idea.updated_at)}, payload: { title: 'forbidden desktop edit', content: '' } });
    await enqueueOutbox({ id: 'invalid-note', op: 'create', payload: { title: '', content: '' } });
    localStorage.setItem('danji.pendingReports', JSON.stringify([{ rid: 'old-failure', kind: 'bg-sync', sync_ok: '0' }]));
    const originalNow = Date.now.bind(Date); Date.now = () => originalNow() + 61000;
  })()`);
  const pushResult = await evaluate('(async () => (await engine.syncNow()).push)()');
  assert.equal(pushResult.pushed, 1, 'only valid create succeeds; conflict/forbidden/error do not count');
  assert.ok(pushResult.results.some(result => result.status === 'conflict'));
  assert.ok(pushResult.results.some(result => result.status === 'forbidden'));
  assert.ok(pushResult.results.some(result => result.status === 'error'));
  await evaluate(`(async () => await (await import('/js/sync/report.js')).flushReports())()`);
  const messages = await api('/api/messages');
  assert.equal(messages.some(m => m.sync_ok === '0'), false);
  assert.ok(messages.some(m => m.sync_pushed === '1' && m.sync_source === 'js' && m.sync_stage === 'push-applied'));
  console.log('✓ real push counts successful changes and recovery does not replay old failure');

  // 重发真实客户端生成的字段，而不是只单测服务器假设中的协议。
  const { body, id: messageId, created_at, ...report } = messages.find(m => m.sync_pushed === '1');
  const repeated = await api('/api/messages', 'POST', report);
  assert.equal(repeated.id, messageId);
  assert.equal((await api('/api/messages')).length, messages.length);
  const legacyReport = { kind: 'bg-sync', sync_ok: '1', rid: 'legacy-rid' };
  assert.equal((await api('/api/messages', 'POST', legacyReport)).id,
    (await api('/api/messages', 'POST', legacyReport)).id);
  console.log('✓ canonical and legacy report IDs deduplicate on the real server');
  const pullFailure = await api('/api/messages', 'POST', { kind: 'bg-sync', sync_ok: '0',
    sync_stage: 'pull', sync_source: 'js', sync_cycle: 'failure-fixture', sync_reason: 'temporary receive error' });
  assert.equal(pullFailure.title, '手机接收更新失败 ❌');
  assert.equal(pullFailure.sync_cycle, 'failure-fixture');
  console.log('✓ failure notification identifies receiving stage and retains correlation metadata');

  await evaluate(`(async () => {
    const { toast } = await import('/js/toast.js');
    toast('sync report remains visible', 'report'); toast('ordinary save', 'ok');
  })()`);
  assert.equal(await evaluate('state.toast.msg'), 'sync report remains visible');
  console.log('✓ ordinary toast cannot replace an active sync report');

  await stop(server);
  await startServer();
  const rebooted = await api('/api/sync/pull');
  assert.notEqual(rebooted.boot_id, baseline.boot_id);
  await evaluate(`localStorage.setItem('test.ledger', ${JSON.stringify(JSON.stringify({ version: 999, bootId: baseline.boot_id }))}); remoteOffline = false`);
  assert.equal(await evaluate('(async () => (await engine.syncNow()).ok)()'), true);
  assert.equal(await evaluate(`localStorage.getItem('danji.lastBootId')`), rebooted.boot_id);
  assert.equal(await evaluate(`Number(localStorage.getItem('danji.lastDataVersion'))`), rebooted.data_version);
  console.log('✓ server restart does not compare old native version numbers with the new process');
  console.log('\n✓ full sync flow passed (isolated data, real browser storage, simulated native bridge)');
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
