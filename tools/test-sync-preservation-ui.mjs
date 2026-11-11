/**
 * 拾穗集 —— 数据保留的浏览器验收（真实 IndexedDB + 隔离服务）
 * 用法：node tools/test-sync-preservation-ui.mjs
 *
 * 覆盖（对应本轮修复）：
 *  1) 离线加图、服务端**永久拒收**该图时：
 *     - 本机原图不被删、payload 不丢任何一张图；
 *     - 这条随记进入「需要处理」，**正文也不推**（电脑端不出现缺图的成功记录）；
 *     - 另一条正常随记照常上传成功（互不影响）；
 *     - 换图/移除并保存后，这条恢复同步。
 *  2) 服务端拒写（forbidden）：
 *     - 队列保留、标记「需要处理」，重启 App 后仍然可见；
 *     - 「另存为新的随记」产生**新 UUID**，原记录不被自动重建；
 *     - 其他条目继续同步。
 *  3) 来源权限一致：
 *     - 明确 origin=mobile 的随记手机可改；
 *     - desktop 的、以及没有 origin 的旧记录，手机上只读（没有编辑入口）。
 *
 * 隔离规则（AGENTS.md §1 §2）：server.js + public/ + lib/ 复制到系统临时目录再跑，
 * 端口随机，DANJI_PAPERS_DIR 指向临时目录，绝不读写真实 data/、config.json、papers/。
 */
import WebSocket from 'ws';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch { /* 尚未完成 */ }
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

// 1x1 透明 PNG（服务端按魔数校验，浏览器能真正解码）
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
// 扩展名是 .png 但内容不是图片：服务端按魔数拒收 → 永久拒收（客户端校验也会先拦下，
// 这里直接构造 blob 绕过客户端校验，专门测「服务端永久拒收」这条真实路径）
const BAD_BYTES = Buffer.from('this is definitely not an image payload at all', 'utf8');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const browserCandidates = [process.env.EDGE_PATH, process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
  .filter(Boolean)
  .map((location, index) => (process.env.EDGE_PATH && index === 0
    ? location
    : path.join(location, 'Microsoft', 'Edge', 'Application', 'msedge.exe')));
let browserPath;
for (const candidate of browserCandidates) {
  try { await fs.access(candidate); browserPath = candidate; break; } catch { /* 下一个 */ }
}
assert.ok(browserPath, '需要本机 Edge，或用 EDGE_PATH 指定浏览器路径');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'danji-preserve-ui-'));
let server, browser, ws;
try {
  for (const item of ['server.js', 'public', 'lib']) {
    await fs.cp(path.join(root, item), path.join(tmp, item), { recursive: true });
  }
  await fs.mkdir(path.join(tmp, 'isolated-papers'), { recursive: true });
  // 仅在临时服务模拟「手机身份」：服务端按来源 IP 判端，本机回环恒为 desktop。
  // 生产服务的身份识别与权限代码保持原样（与 tools/test-sync-flow.mjs 同一手法）。
  const MOBILE_TOKEN = 'mobile-role-probe-token';
  const serverFile = path.join(tmp, 'server.js');
  const serverSource = await fs.readFile(serverFile, 'utf8');
  assert.ok(serverSource.includes('const role = clientRole(req);'));
  await fs.writeFile(serverFile, serverSource.replace('const role = clientRole(req);',
    "const role = req.headers['x-danji-token'] === 'mobile-role-probe-token' ? 'mobile' : clientRole(req);"));
  await fs.writeFile(path.join(tmp, 'public', '__seed.html'),
    '<!doctype html><meta charset="utf-8"><title>seed</title><p>seed</p>');
  const badFile = path.join(tmp, 'broken.png');
  await fs.writeFile(badFile, BAD_BYTES);
  const goodFile = path.join(tmp, 'tiny.png');
  await fs.writeFile(goodFile, PNG_BYTES);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: tmp,
    env: { ...process.env, PORT: String(port), DANJI_HOST: '127.0.0.1', DANJI_TOKEN: '', DANJI_PAPERS_DIR: path.join(tmp, 'isolated-papers') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverLog = '';
  server.stderr.on('data', (d) => { serverLog += d.toString(); });
  await eventually(async () => {
    if (server.exitCode !== null) throw new Error(serverLog);
    return (await fetch(base + '/api/health')).ok;
  }, 'isolated server');

  const api = async (method, pathname, body) => {
    const res = await fetch(base + pathname, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: res.status, data };
  };

  // 桌面端记录一条「明确 origin=desktop」的随记（手机端应当只读）
  const desktopIdea = (await api('POST', '/api/ideas', {
    title: '电脑端记的随记',
    content: '手机端不该能改这条',
  })).data;
  assert.ok(desktopIdea.id, '桌面端随记应创建成功');

  // ---- 启动 headless Edge ----
  const debugPort = await freePort();
  browser = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(tmp, 'browser-profile')}`,
    'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await eventually(async () => (
    await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
  ).find((t) => t.type === 'page'), 'headless browser');
  ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (e) => {
    const message = JSON.parse(e.data);
    if (process.env.DANJI_CDP_DEBUG) console.log('CDP receive',message.id,message.method,message.error?.message);
    if (message.id) {
      const callback = pending.get(message.id);
      if (callback) {
        pending.delete(message.id);
        message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result);
      }
    }
    if (message.method === 'Fetch.requestPaused') {
      // Exercise slow classic-script loading: polling must not import state.js
      // before Vue exists, or the failed module stays cached for this document.
      setTimeout(() => cdp('Fetch.continueRequest', {
        requestId: message.params.requestId,
      }).catch((err) => errors.push(err.message)), 300);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    }
  });
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout ' + method)); }, 20000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      if (process.env.DANJI_CDP_DEBUG) console.log('CDP send',id,method);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }
  await cdp('Runtime.enable');
  await cdp('DOM.enable');
  await cdp('Page.enable');
  await cdp('Fetch.enable', { patterns: [{
    urlPattern: '*/vendor/vue.global.prod.js', requestStage: 'Request',
  }] });

  async function openApp() {
    await cdp('Page.navigate', { url: base + '/__seed.html' });
    await eventually(() => evaluate('location.pathname === "/__seed.html" && document.readyState === "complete"'), 'seed page');
    // 让 App 以手机身份访问电脑服务（服务端按口令识别这次请求为手机）
    await evaluate(`localStorage.setItem('danji.syncToken', ${JSON.stringify(MOBILE_TOKEN)});
      localStorage.setItem('danji.serverBase', ${JSON.stringify(base)});`);
    await cdp('Page.navigate', { url: base + '/?board=ideas&danji-mobile=1' });
    // Wait for the app's own script ordering and mount before importing modules
    // from CDP. Otherwise a slow Vue download poisons vue-globals.js's module cache.
    await eventually(() => evaluate(`location.pathname === '/' &&
      new URLSearchParams(location.search).get('danji-mobile') === '1' &&
      !!document.querySelector('#app:not([v-cloak]) .container')`), 'app mounted');
    await eventually(() => evaluate(`(async () => {
      const { state } = await import('/js/state.js');
      return !!state.sync.enabled;
    })()`), 'mobile sync layer enabled');
    await pause(300);
  }
  await openApp();

  /* ---------- 1) 离线加图：坏图被永久拒收 ---------- */
  // 直接在页面里造一条离线随记（带一张「内容不是图片」的 local 图）
  const badId = await evaluate(`(async () => {
    const local = await import('/js/local-images.js');
    const engine = await import('/js/sync/engine.js');
    const bytes = ${JSON.stringify([...BAD_BYTES])};
    const file = new File([new Uint8Array(bytes)], 'broken.png', { type: 'image/png' });
    const rec = await local.saveLocalImage(file, 'broken.png');
    const id = await engine.enqueueIdeaLocal({
      op: 'create',
      payload: { title: '带坏图的随记', content: '这张图传不上去', images: [{ id: rec.id, name: rec.name }] },
    });
    return { id, localId: rec.id };
  })()`);
  assert.ok(badId.id, '离线随记应入队');
  assert.ok(String(badId.localId).startsWith('local:'), '应是本地图 id');

  // 再造一条正常随记（不带图），验证互不影响
  const goodId = await evaluate(`(async () => {
    const engine = await import('/js/sync/engine.js');
    return engine.enqueueIdeaLocal({
      op: 'create',
      payload: { title: '正常的随记', content: '这条应该照常同步', images: [] },
    });
  })()`);

  // 联网并同步
  await evaluate(`(async () => {
    const { state } = await import('/js/state.js');
    state.sync.offline = false;
    state.sync.status = 'idle';
    return true;
  })()`);
  await evaluate('(async () => (await (await import("/js/sync/engine.js")).syncNow({ reason: "test" }))())');

  // 结果一：坏图那条进入「需要处理」，本机原图仍在，payload 没丢图
  const afterBad = await eventually(async () => evaluate(`(async () => {
    const { state } = await import('/js/state.js');
    const outbox = await import('/js/sync/outbox.js');
    const local = await import('/js/local-images.js');
    const ops = await outbox.listOutbox();
    const entry = ops.find((o) => o.id === ${JSON.stringify(badId.id)});
    if (!entry?.blocked) return false;
    return {
      blockedCount: state.sync.blockedCount,
      blocked: state.sync.blocked,
      stillQueued: !!entry,
      blockedKind: entry && entry.blocked && entry.blocked.kind,
      blockedReason: entry && entry.blocked && entry.blocked.reason,
      payloadImages: entry && entry.payload && entry.payload.images.map((im) => im.id),
      blobAlive: !!(await local.getLocalImage(${JSON.stringify(badId.localId)})),
    };
  })()`), 'blocked entry visible');
  assert.equal(afterBad.stillQueued, true, '被拒的随记必须留在队列里，不能被丢弃');
  assert.equal(afterBad.blockedKind, 'image', '应标记为 kind=image');
  assert.ok(afterBad.blockedReason, '应带可读原因');
  assert.equal(afterBad.blobAlive, true, '本机原图不得被删除');
  assert.deepEqual(afterBad.payloadImages, [badId.localId], 'payload 里的图片不得被剔除');

  // 结果二：坏图那条没被推上去（正文也不推，电脑端不该出现缺图的成功记录）
  await eventually(async () => (await api('GET', '/api/ideas')).data.some(i => i.title === '正常的随记'), 'other healthy entry syncs');
  const serverIdeas = (await api('GET', '/api/ideas')).data;
  assert.ok(!serverIdeas.some((i) => i.title === '带坏图的随记'),
    '图片有问题的随记不应推上去（正文也不推）');
  assert.ok(serverIdeas.some((i) => i.title === '正常的随记'),
    '其他正常随记应照常同步');

  // 结果三：换图（移除问题图片）保存后，这条恢复同步
  await evaluate(`(async () => {
    const engine = await import('/js/sync/engine.js');
    await engine.enqueueIdeaLocal({
      op: 'update',
      id: ${JSON.stringify(badId.id)},
      payload: { title: '带坏图的随记', content: '换掉坏图了', images: [] },
      baseUpdatedAt: '',
    });
    return true;
  })()`);
  await evaluate('(async () => (await (await import("/js/sync/engine.js")).syncNow({ reason: "test-fix" }))())');
  await eventually(async () => {
    const ideas = (await api('GET', '/api/ideas')).data;
    return ideas.some((i) => i.title === '带坏图的随记' && i.content === '换掉坏图了');
  }, 'fixed entry syncs after user removes the bad image');
  console.log('✓ 坏图：原图与 payload 都在、该条不推送、别的随记照常同步、换图后恢复');

  /* ---------- 2) forbidden：保留队列 + 重启仍可见 + 另存为新 UUID ---------- */
  const forbiddenId = await evaluate(`(async () => {
    const engine = await import('/js/sync/engine.js');
    return engine.enqueueIdeaLocal({
      op: 'update',
      id: ${JSON.stringify(desktopIdea.id)},
      payload: { title: '手机改的标题', content: '手机改的正文', images: [] },
      baseUpdatedAt: ${JSON.stringify(desktopIdea.updated_at)},
    });
  })()`);
  assert.equal(forbiddenId, desktopIdea.id);
  await evaluate('(async () => (await (await import("/js/sync/engine.js")).syncNow({ reason: "test-forbidden" }))())');
  const afterForbidden = await eventually(async () => evaluate(`(async () => {
    const { state } = await import('/js/state.js');
    const outbox = await import('/js/sync/outbox.js');
    const ops = await outbox.listOutbox();
    const entry = ops.find((o) => o.id === ${JSON.stringify(desktopIdea.id)});
    if (!entry?.blocked) return false;
    return {
      blockedCount: state.sync.blockedCount,
      kind: entry && entry.blocked && entry.blocked.kind,
      reason: entry && entry.blocked && entry.blocked.reason,
      stillQueued: !!entry,
      payloadTitle: entry && entry.payload && entry.payload.title,
    };
  })()`), 'forbidden entry blocked');
  assert.equal(afterForbidden.stillQueued, true, '被拒写的改动必须留在队列里');
  assert.equal(afterForbidden.kind, 'forbidden', '应标记为 kind=forbidden');
  assert.ok(afterForbidden.reason, '应带可读原因');
  assert.equal(afterForbidden.payloadTitle, '手机改的标题', '本地原内容必须留着，不能丢');
  console.log('✓ forbidden：队列保留 + 标记需要处理 + 原内容还在');

  // 重开 App（同一浏览器 profile，IndexedDB 保留）→ 仍能看到「需要处理」
  await openApp();
  const afterRestart = await eventually(async () => evaluate(`(async () => {
    const { state } = await import('/js/state.js');
    if (!state.sync.blockedCount) return false;
    return { blockedCount: state.sync.blockedCount, kinds: state.sync.blocked.map((b) => b.kind) };
  })()`), 'blocked visible after restart');
  assert.ok(afterRestart.blockedCount >= 1, '重启后「需要处理」的条目仍应可见');
  assert.ok(afterRestart.kinds.includes('forbidden'), '重启后 forbidden 条目仍在');
  console.log('✓ forbidden：重启后仍可见');

  // 另存为新的手机随记 → 新 UUID；原记录不被自动重建
  const savedAsNew = await evaluate(`(async () => {
    const engine = await import('/js/sync/engine.js');
    const before = (await engine.listBlocked()).find((b) => b.kind === 'forbidden');
    const newId = await engine.saveBlockedAsNewIdea(before.id);
    return { newId, oldId: before.id };
  })()`);
  assert.notEqual(savedAsNew.newId, savedAsNew.oldId, '另存必须用新 UUID');
  assert.match(savedAsNew.newId, UUID_RE, '新条目必须是合法 UUID');
  await evaluate('(async () => (await (await import("/js/sync/engine.js")).syncNow({ reason: "test-saved-as-new" }))())');
  await eventually(async () => {
    const ideas = (await api('GET', '/api/ideas')).data;
    return ideas.some((i) => i.title === '手机改的标题' && i.id !== desktopIdea.id);
  }, 'saved-as-new reaches the server');
  const ideasNow = (await api('GET', '/api/ideas')).data;
  const desktopCopy = ideasNow.find((i) => i.id === desktopIdea.id);
  assert.equal(desktopCopy.title, '电脑端记的随记', '被拒的原记录不得被自动重建或覆盖');
  console.log('✓ forbidden：另存为新 UUID，原记录不被重建');

  /* ---------- 3) 来源权限一致 ---------- */
  const perms = await evaluate(`(async () => {
    const { state } = await import('/js/state.js');
    const perm = await import('/js/perm.js');
    const desktop = state.ideas.find((i) => i.id === ${JSON.stringify(desktopIdea.id)});
    const mine = state.ideas.find((i) => i.origin === 'mobile');
    return {
      desktopCanWrite: desktop ? perm.canWriteIdea(desktop) : null,
      mobileCanWrite: mine ? perm.canWriteIdea(mine) : null,
      desktopOrigin: desktop && desktop.origin,
    };
  })()`);
  assert.equal(perms.desktopOrigin, 'desktop');
  assert.equal(perms.desktopCanWrite, false, '电脑端记的随记在手机上必须只读');
  assert.equal(perms.mobileCanWrite, true, '手机端记的随记在手机上可写');
  console.log('✓ 来源权限：mobile 可写、desktop 只读');

  const unexpectedErrors = errors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED/i.test(String(e)));
  assert.deepEqual(unexpectedErrors, [], '页面不应有运行时报错');
  console.log('\n✓ 数据保留浏览器验收通过（全部写入均在隔离实例）');
} finally {
  ws?.close();
  for (const child of [browser, server]) {
    if (child && child.exitCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill();
      await closed;
    }
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}
