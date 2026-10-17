/**
 * 拾穗集 —— App 离线加图主链的浏览器验收（M21-C）
 *
 * 覆盖：
 *  1) IndexedDB v1 → v2 升级：补建 images store，旧 mirror/outbox 数据不丢；
 *  2) 本地图片仓：saveLocalImage / getLocalImage / localImageObjectUrl 取回同样字节；
 *  3) 离线加图：编辑器不再禁用选图，图片存本机（local:<uuid>），随记照常进 outbox，
 *     卡片/编辑器用本机 blob 显示缩略图；
 *  4) 联网同步：push 前自动上传成服务端 UUID、替换 outbox payload、清理本地 blob，
 *     电脑端 /api/ideas 拿到合法 UUID 且 /api/images/<id> 字节与原图一致；
 *  5) 在线直传（原有路径）：编辑器选图直接上传，不产生任何 local 记录。
 *
 * 全程使用独立临时服务（复制 server.js + public + lib 到系统临时目录）、端口 8814、
 * DANJI_PAPERS_DIR 指向临时目录，不读写真实 data/、config.json、papers/，结束即删。
 *
 * 用法：node tools/test-local-images-ui.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DANJI_TEST_PORT) || 8814;

// 1x1 透明 PNG：服务端按魔数校验，也能被浏览器真正解码（naturalWidth=1）
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const browserCandidates = [process.env.EDGE_PATH, process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
  .filter(Boolean)
  .map((location, index) => (process.env.EDGE_PATH && index === 0
    ? location
    : path.join(location, 'Microsoft', 'Edge', 'Application', 'msedge.exe')));
let browserPath;
for (const candidate of browserCandidates) {
  try { await fs.access(candidate); browserPath = candidate; break; } catch { /* 下一个安装目录 */ }
}
assert.ok(browserPath, '需要本机 Edge，或用 EDGE_PATH 指定浏览器路径');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'danji-local-images-'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(test, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await test(); if (value) return value; } catch { /* 尚未完成 */ }
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}

async function portFree(port) {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => socket.close(resolve));
}

let server, browser, ws;
try {
  await portFree(PORT).catch(() => {
    throw new Error(`端口 ${PORT} 已被占用，本测试需要独立端口，请先释放`);
  });

  // ---- 隔离实例：server.js + public + lib 全拷到临时目录 ----
  await fs.copyFile(path.join(root, 'server.js'), path.join(tmp, 'server.js'));
  await fs.cp(path.join(root, 'lib'), path.join(tmp, 'lib'), { recursive: true });
  await fs.cp(path.join(root, 'public'), path.join(tmp, 'public'), { recursive: true });
  // 同源空页：在 App 启动前用它造 v1 数据库，验证 v2 升级不丢旧数据
  await fs.writeFile(
    path.join(tmp, 'public', '__test-idb-v1.html'),
    '<!doctype html><meta charset="utf-8"><title>idb v1 seed</title><p>seed</p>',
    'utf8',
  );
  const fixturePath = path.join(tmp, 'upload-fixture.png');
  await fs.writeFile(fixturePath, PNG_BYTES);

  const base = `http://127.0.0.1:${PORT}`;
  server = spawn(process.execPath, [path.join(tmp, 'server.js')], {
    cwd: tmp,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(PORT),
      DANJI_HOST: '127.0.0.1',
      DANJI_TOKEN: '',
      DANJI_PAPERS_DIR: path.join(tmp, 'test-papers'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stderr.on('data', (chunk) => { serverLog += chunk; });
  await eventually(async () => {
    if (server.exitCode !== null) throw new Error(serverLog);
    return (await fetch(base + '/api/health')).ok;
  }, 'isolated server');

  // ---- 打开 headless Edge ----
  const debugPort = await (async () => {
    const socket = net.createServer();
    await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    return port;
  })();
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
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (e) => {
    const message = JSON.parse(e.data);
    if (message.id) {
      const callback = pending.get(message.id);
      if (callback) {
        pending.delete(message.id);
        message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result);
      }
    }
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map((a) => a.value || a.description).join(' '));
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

  async function navigate(url, label) {
    await cdp('Page.navigate', { url });
    await eventually(() => evaluate(
      `!!document.querySelector('#app:not([v-cloak]) .container')`
      + ` && document.querySelector('.workspace') && document.querySelector('.workspace').dataset.board === 'ideas'`
      + ` && !document.querySelector('.empty')?.textContent.includes('加载中')`,
    ), label || 'render ideas');
    await pause(200);
  }

  // ---- 1. v1 → v2 升级：补 images store，旧 mirror/outbox 数据不丢 ----
  await cdp('Page.navigate', { url: base + '/__test-idb-v1.html' });
  await eventually(() => evaluate('document.readyState === "complete"'), 'v1 seed page');
  const upgrade = await evaluate(`(async () => {
    // 先造一个 v1 库（只有 mirror/outbox），并塞入"旧版本数据"
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('danji-sync', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('mirror')) db.createObjectStore('mirror', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['mirror', 'outbox'], 'readwrite');
        tx.objectStore('mirror').put({
          key: 'ideas',
          items: [{ id: 'seed-idea', title: 'v1 旧镜像数据', content: '', updated_at: '2026-01-01T00:00:00.000Z' }],
          pulled_at: '2026-01-01T00:00:00.000Z',
        });
        tx.objectStore('outbox').put({
          id: 'seed-outbox', op: 'delete', payload: null, confirmed: true,
          base_updated_at: '', updated_at: '2026-01-01T00:00:00.000Z',
        });
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => reject(tx.error);
      };
    });
    // 再用产品代码的 openDb() 打开：走真实的 v1→v2 升级逻辑
    const idb = await import('/js/sync/idb.js');
    const db = await idb.openDb();
    const stores = [...db.objectStoreNames].sort();
    const mirror = await idb.idbGet('mirror', 'ideas');
    const outbox = await idb.idbGet('outbox', 'seed-outbox');
    const result = {
      version: db.version,
      dbVersion: idb.DB_VERSION,
      stores,
      mirrorSeed: mirror && mirror.items && mirror.items[0] && mirror.items[0].id,
      outboxSeed: !!(outbox && outbox.op === 'delete'),
    };
    // 清掉种子数据，别让它们混进后面的主链
    await idb.idbClear('outbox');
    await idb.idbPut('mirror', { key: 'ideas', items: [], pulled_at: '' });
    idb.closeDb();
    return result;
  })()`);
  assert.equal(upgrade.dbVersion, 2, 'DB_VERSION 应升到 2');
  assert.equal(upgrade.version, 2, '数据库实际版本应为 2');
  assert.deepEqual(upgrade.stores, ['images', 'mirror', 'outbox'], 'v2 应包含新增的 images store');
  assert.equal(upgrade.mirrorSeed, 'seed-idea', '升级不能丢 mirror 旧数据');
  assert.equal(upgrade.outboxSeed, true, '升级不能丢 outbox 旧数据');
  console.log('✓ IndexedDB v1→v2 升级保留 mirror/outbox 并新增 images store');

  // ---- 2. 打开 App（手机模式），本地图片仓基本能力 ----
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await navigate(base + '/?board=ideas&danji-mobile=1', 'app render');
  await eventually(() => evaluate(`(async () => {
    const { state } = await import('/js/state.js');
    return !!state.sync.enabled;
  })()`), 'mobile sync layer enabled');
  await pause(300);

  const localBasic = await evaluate(`(async () => {
    const local = await import('/js/local-images.js');
    const bytes = ${JSON.stringify([...PNG_BYTES])};
    const file = new File([new Uint8Array(bytes)], 'tiny.png', { type: 'image/png' });
    const rec = await local.saveLocalImage(file, 'tiny.png');
    const got = await local.getLocalImage(rec.id);
    const url = await local.localImageObjectUrl(rec.id);
    const gotBytes = [...new Uint8Array(await (await fetch(url)).arrayBuffer())];
    const idb = await import('/js/sync/idb.js');
    const rows = await idb.idbGetAll('images');
    await local.deleteLocalImage(rec.id);
    return {
      id: rec.id,
      name: rec.name,
      isLocal: local.isLocalImageId(rec.id),
      size: got && got.blob && got.blob.size,
      type: got && got.blob && got.blob.type,
      isBlobUrl: String(url).startsWith('blob:'),
      bytes: gotBytes,
      storeCount: rows.length,
      storeIds: rows.map((r) => r.id),
    };
  })()`);
  assert.match(localBasic.id, /^local:/, '本地图 id 必须是 local: 前缀');
  assert.equal(localBasic.isLocal, true);
  assert.equal(localBasic.name, 'tiny.png');
  assert.equal(localBasic.size, PNG_BYTES.length, '本地仓里 blob 字节数应一致');
  assert.equal(localBasic.type, 'image/png');
  assert.equal(localBasic.isBlobUrl, true, 'local id 应能生成 blob: URL');
  assert.deepEqual(localBasic.bytes, [...PNG_BYTES], '本地取回的图片字节必须与原图一致');
  assert.equal(localBasic.storeCount, 1, 'IDB images store 里应能看到这张图');
  assert.ok(localBasic.storeIds[0].startsWith('local:'), 'images store 的 key 应是 local id');
  console.log('✓ 本地图片仓：save/get/objectURL 字节一致，id 形如 local:<uuid>');

  // ---- 3. 离线加图：编辑器不再禁用选图，图存本机、随记进 outbox 且能看到缩略图 ----
  await cdp('Network.enable');
  await cdp('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  await eventually(() => evaluate('navigator.onLine === false'), 'browser offline');
  await evaluate(`(async () => {
    const { state } = await import('/js/state.js');
    state.sync.offline = true;
    state.sync.status = 'offline';
    document.querySelector('.create-button').click();
    return true;
  })()`);
  await eventually(() => evaluate(`!!document.querySelector('.drawer input')`), 'offline idea editor');
  // 离线时选图入口必须可用、按钮文案恢复「🖼 加图片」、并有离线提示
  const pickerUi = await evaluate(`(() => {
    const input = document.querySelector('.drawer .idea-img-add input[type="file"]');
    const label = document.querySelector('.drawer .idea-img-add span');
    const hint = [...document.querySelectorAll('.drawer p')].find((p) => p.textContent.includes('离线也会先存本机'));
    return { disabled: !!input && input.disabled, label: label && label.textContent.trim(), hint: !!(hint && hint.textContent.trim()) };
  })()`);
  assert.equal(pickerUi.disabled, false, '离线时文件选择不能禁用');
  assert.ok(pickerUi.label.includes('加图片'), '按钮文案应恢复「🖼 加图片」，实际：' + pickerUi.label);
  assert.equal(pickerUi.hint, true, '离线时应有「先存本机」轻提示');
  // 填标题 + 注入一张真实 PNG（和用户点选文件等价的 change 事件）
  await evaluate(`(() => {
    const input = document.querySelector('.drawer-form input');
    input.value = '离线带图随记';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const textarea = document.querySelector('.drawer-form textarea');
    textarea.value = '这条在断网时保存，联网后应自动把图片传上去。';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const docNode = await cdp('DOM.getDocument', { depth: -1, pierce: true });
  const fileNode = await cdp('DOM.querySelector', {
    nodeId: docNode.root.nodeId,
    selector: '.drawer .idea-img-add input[type="file"]',
  });
  assert.ok(fileNode.nodeId, '应能找到编辑器里的 file input');
  await cdp('DOM.setFileInputFiles', { files: [fixturePath], nodeId: fileNode.nodeId });
  // 等缩略图渲染出来（走本机 blob）并确认本地仓里多了一条 local 记录
  await eventually(() => evaluate(`(() => {
    const img = document.querySelector('.drawer .idea-imgs img');
    const input = document.querySelector('.drawer .idea-img-add input[type="file"]');
    return !!img && img.src.startsWith('blob:') && img.naturalWidth === 1 && !input.disabled;
  })()`), 'offline local thumbnail');
  const localAfterPick = await evaluate(`(async () => {
    const idb = await import('/js/sync/idb.js');
    const rows = await idb.idbGetAll('images');
    return rows.map((r) => ({ id: r.id, name: r.name, size: r.size }));
  })()`);
  assert.equal(localAfterPick.length, 1, '离线选图后本地仓应有 1 张图');
  assert.ok(localAfterPick[0].id.startsWith('local:'), '离线选图的 id 应是 local:<uuid>');
  assert.equal(localAfterPick[0].name, 'upload-fixture.png');
  const offlineLocalId = localAfterPick[0].id;
  // 保存随记 → 进 outbox，卡片上出现本地缩略图；服务端此刻不应有新记录
  await evaluate(`document.querySelector('.drawer button[type="submit"]').click()`);
  await eventually(() => evaluate(`(() => {
    const cards = [...document.querySelectorAll('.idea-card')];
    const card = cards.find((c) => c.textContent.includes('离线带图随记'));
    const img = card && card.querySelector('.idea-imgs img');
    return !!img && img.src.startsWith('blob:') && img.naturalWidth === 1;
  })()`), 'offline card local thumbnail');
  const offlineState = await evaluate(`(async () => {
    const { listOutbox } = await import('/js/sync/outbox.js');
    const ops = await listOutbox();
    return ops.map((o) => ({ id: o.id, op: o.op, imageIds: (o.payload && o.payload.images || []).map((im) => im.id) }));
  })()`);
  assert.equal(offlineState.length, 1, '离线保存后 outbox 应有 1 条待同步');
  assert.equal(offlineState[0].op, 'create');
  assert.equal(offlineState[0].imageIds.length, 1);
  assert.equal(offlineState[0].imageIds[0], offlineLocalId, 'outbox payload 里应是本地图 id');
  const offlineIdeaId = offlineState[0].id;
  let serverIdeas = await (await fetch(base + '/api/ideas')).json();
  assert.equal(serverIdeas.length, 0, '离线时随记不能已经写到服务端');
  console.log('✓ 离线加图：选图不禁用、缩略图走本机 blob、随记带 local:<uuid> 进 outbox');

  // ---- 4. 联网同步：push 前自动上传 → 服务端 UUID 图片、字节一致、本地清理 ----
  await cdp('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await eventually(() => evaluate('navigator.onLine === true'), 'browser online');
  await evaluate(`(async () => {
    const { state } = await import('/js/state.js');
    state.sync.offline = false;
    return true;
  })()`);
  await eventually(() => evaluate(`(async () => {
    const { listOutbox } = await import('/js/sync/outbox.js');
    return (await listOutbox()).length === 0;
  })()`), 'outbox drained after online sync', 30000);
  // 服务端：随记仍在，图片 id 是合法 UUID，图片字节与原图一致
  serverIdeas = await (await fetch(base + '/api/ideas')).json();
  assert.equal(serverIdeas.length, 1, '联网同步后服务端应有 1 条随记');
  const syncedIdea = serverIdeas.find((i) => i.id === offlineIdeaId);
  assert.ok(syncedIdea, '同步后的随记 id 应保持 ' + offlineIdeaId);
  assert.ok(Array.isArray(syncedIdea.images) && syncedIdea.images.length === 1, '随记应带 1 张图，实际：' + JSON.stringify(syncedIdea.images));
  const serverImageId = syncedIdea.images[0].id;
  assert.match(serverImageId, UUID_RE, '服务端图片 id 必须是标准 UUID（local: 前缀会被 sanitize 丢掉），实际：' + serverImageId);
  assert.equal(syncedIdea.images[0].name, 'upload-fixture.png');
  assert.ok(!JSON.stringify(serverIdeas).includes('local:'), 'local: 前缀 id 绝不能到达服务端');
  const imageRes = await fetch(base + '/api/images/' + serverImageId);
  assert.equal(imageRes.status, 200, '服务端应能取到同步后的图片');
  assert.ok(String(imageRes.headers.get('content-type') || '').includes('image/png'));
  const imageBytes = Buffer.from(await imageRes.arrayBuffer());
  assert.deepEqual([...imageBytes], [...PNG_BYTES], '电脑端拿到的原图字节必须与手机本地原图一致');
  // 本地：local 记录已清理，卡片缩略图换成服务端图片
  const localAfterSync = await evaluate(`(async () => {
    const local = await import('/js/local-images.js');
    const idb = await import('/js/sync/idb.js');
    const gone = await local.getLocalImage(${JSON.stringify(offlineLocalId)});
    const rows = await idb.idbGetAll('images');
    const card = [...document.querySelectorAll('.idea-card')].find((c) => c.textContent.includes('离线带图随记'));
    const img = card && card.querySelector('.idea-imgs img');
    return { gone: gone === null, storeCount: rows.length, cardImg: !!img && img.src.startsWith('blob:') };
  })()`);
  assert.equal(localAfterSync.gone, true, '上传成功后应删除本地图片记录');
  assert.equal(localAfterSync.storeCount, 0, '本地图片仓应已清空');
  assert.equal(localAfterSync.cardImg, true, '卡片缩略图应仍能显示（此时已换成服务端图）');
  console.log('✓ 联网自动上传：local:<uuid> → 服务端 UUID、原图字节一致、本地 blob 清理（'
    + serverImageId + '）');

  // ---- 5. 在线直传（原有行为）：编辑器选图直接上传，不产生 local 记录 ----
  await evaluate(`document.querySelector('.create-button').click()`);
  await eventually(() => evaluate(`!!document.querySelector('.drawer .idea-img-add input[type="file"]')`), 'online idea editor');
  await evaluate(`(() => {
    const input = document.querySelector('.drawer-form input');
    input.value = '在线直传随记';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const onlineDoc = await cdp('DOM.getDocument', { depth: -1, pierce: true });
  const onlineFileNode = await cdp('DOM.querySelector', {
    nodeId: onlineDoc.root.nodeId,
    selector: '.drawer .idea-img-add input[type="file"]',
  });
  await cdp('DOM.setFileInputFiles', { files: [fixturePath], nodeId: onlineFileNode.nodeId });
  await eventually(() => evaluate(`(() => {
    const img = document.querySelector('.drawer .idea-imgs img');
    const input = document.querySelector('.drawer .idea-img-add input[type="file"]');
    return !!img && img.src.startsWith('blob:') && img.naturalWidth === 1 && !input.disabled;
  })()`), 'online direct-upload thumbnail');
  const directState = await evaluate(`(async () => {
    const idb = await import('/js/sync/idb.js');
    const rows = await idb.idbGetAll('images');
    return { storeCount: rows.length };
  })()`);
  assert.equal(directState.storeCount, 0, '在线直传不应在本机图片仓留记录');
  await evaluate(`document.querySelector('.drawer button[type="submit"]').click()`);
  await eventually(() => evaluate(`!document.querySelector('.drawer')`), 'online save closed');
  serverIdeas = await (await fetch(base + '/api/ideas')).json();
  const onlineIdea = serverIdeas.find((i) => i.title === '在线直传随记');
  assert.ok(onlineIdea, '在线保存的随记应写到服务端');
  assert.ok(onlineIdea.images.length === 1 && UUID_RE.test(onlineIdea.images[0].id),
    '在线直传的图片 id 应是服务端 UUID，实际：' + JSON.stringify(onlineIdea.images));
  const onlineImageBytes = Buffer.from(await (await fetch(base + '/api/images/' + onlineIdea.images[0].id)).arrayBuffer());
  assert.deepEqual([...onlineImageBytes], [...PNG_BYTES], '在线直传的图片字节也应一致');
  console.log('✓ 在线直传路径不变：直接上传服务端 UUID，不产生 local 记录');

  // ---- 6. 本地 blob 清理：编辑移除本地图 / 本地新建后又删随记 ----
  await cdp('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  await eventually(() => evaluate('navigator.onLine === false'), 'offline for cleanup test');
  await evaluate(`(async () => {
    const { state } = await import('/js/state.js');
    state.sync.offline = true;
    return true;
  })()`);
  const cleanupCheck = await evaluate(`(async () => {
    const local = await import('/js/local-images.js');
    const engine = await import('/js/sync/engine.js');
    const { getOutbox, dequeueOutbox } = await import('/js/sync/outbox.js');
    const bytes = ${JSON.stringify([...PNG_BYTES])};
    const file = new File([new Uint8Array(bytes)], 'cleanup.png', { type: 'image/png' });
    // a) 本地图已进队列，随后编辑把图移除 → 本地 blob 应被清掉
    const recA = await local.saveLocalImage(file, 'cleanup-a.png');
    const idA = await engine.enqueueIdeaLocal({
      op: 'create',
      payload: { title: '清理测试A', content: '', images: [{ id: recA.id, name: recA.name }] },
    });
    const beforeA = !!(await local.getLocalImage(recA.id));
    await engine.enqueueIdeaLocal({
      op: 'update', id: idA,
      payload: { title: '清理测试A', content: '改成没有图了', images: [] },
      baseUpdatedAt: '',
    });
    const afterA = !!(await local.getLocalImage(recA.id));
    // b) 本地新建带图随记，还没同步就删掉 → create→delete 折叠掉整条，本地 blob 也应清掉
    const recB = await local.saveLocalImage(file, 'cleanup-b.png');
    const idB = await engine.enqueueIdeaLocal({
      op: 'create',
      payload: { title: '清理测试B', content: '', images: [{ id: recB.id, name: recB.name }] },
    });
    const beforeB = !!(await local.getLocalImage(recB.id));
    await engine.enqueueIdeaLocal({ op: 'delete', id: idB, payload: null, baseUpdatedAt: '' });
    const afterB = !!(await local.getLocalImage(recB.id));
    const collapsed = (await getOutbox(idB)) === null;
    // 清掉测试用队列项，别真推到服务端（仍是离线，不会触发同步）
    await dequeueOutbox(idA).catch(() => {});
    await dequeueOutbox(idB).catch(() => {});
    return { beforeA, afterA, beforeB, afterB, collapsed };
  })()`);
  assert.equal(cleanupCheck.beforeA, true, '入队后本地图应存在');
  assert.equal(cleanupCheck.afterA, false, '编辑移除图片后应删除本地 blob');
  assert.equal(cleanupCheck.beforeB, true, '本地新建后本地图应存在');
  assert.equal(cleanupCheck.afterB, false, '本地新建又删除随记后应删除本地 blob');
  assert.equal(cleanupCheck.collapsed, true, '未同步的 create 后 delete 应整条折叠掉');
  console.log('✓ 本地 blob 清理：编辑移除图片、未同步就删随记都会删掉本机原图');

  // ---- 7. 在线但上传临时失败：回落本地仓；取消编辑清理本机图 ----
  await cdp('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await eventually(() => evaluate('navigator.onLine === true'), 'online before fallback test');
  await evaluate(`(async () => {
    const { state } = await import('/js/state.js');
    state.sync.offline = false;
    document.querySelector('.create-button').click();
    return true;
  })()`);
  await eventually(() => evaluate(`!!document.querySelector('.drawer .idea-img-add input[type="file"]')`), 'fallback editor');
  // 打开抽屉后再断网：编辑器此时仍认为"在线"，选图会先走上传、失败后回落本地仓
  await cdp('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  await eventually(() => evaluate('navigator.onLine === false'), 'offline after editor open');
  const fallbackDoc = await cdp('DOM.getDocument', { depth: -1, pierce: true });
  const fallbackNode = await cdp('DOM.querySelector', {
    nodeId: fallbackDoc.root.nodeId,
    selector: '.drawer .idea-img-add input[type="file"]',
  });
  await cdp('DOM.setFileInputFiles', { files: [fixturePath], nodeId: fallbackNode.nodeId });
  const fallbackSaved = await eventually(async () => {
    const rows = await evaluate(`(async () => {
      const idb = await import('/js/sync/idb.js');
      return (await idb.idbGetAll('images')).map((r) => ({ id: r.id, name: r.name }));
    })()`);
    return rows.length === 1 ? rows[0] : null;
  }, 'online-upload failure falls back to local store');
  assert.ok(fallbackSaved.id.startsWith('local:'), '上传失败回落后应是本地图 id');
  // 编辑器里点 ✕ 移除这张刚存本机、还没进队列的图 → 应立即删本地 blob
  await evaluate(`document.querySelector('.drawer .idea-img-x').click()`);
  await eventually(async () => {
    const count = await evaluate(`(async () => {
      const idb = await import('/js/sync/idb.js');
      return (await idb.idbGetAll('images')).length;
    })()`);
    return count === 0;
  }, 'removing a session-local image deletes its blob');
  // 再选一次，然后取消编辑 → 没保存的本机图应被清理（抽屉卸载时兜底删除）
  await cdp('DOM.setFileInputFiles', { files: [fixturePath], nodeId: fallbackNode.nodeId });
  await eventually(async () => {
    const count = await evaluate(`(async () => {
      const idb = await import('/js/sync/idb.js');
      return (await idb.idbGetAll('images')).length;
    })()`);
    return count === 1;
  }, 're-picked local image stored');
  await evaluate(`(() => {
    const cancel = [...document.querySelectorAll('.drawer button')].find((b) => b.textContent.trim() === '取消');
    cancel && cancel.click();
    return true;
  })()`);
  await eventually(() => evaluate(`!document.querySelector('.drawer')`), 'fallback editor closed');
  await eventually(async () => {
    const rows = await evaluate(`(async () => {
      const idb = await import('/js/sync/idb.js');
      return (await idb.idbGetAll('images')).length;
    })()`);
    return rows === 0;
  }, 'canceled local image cleaned up');
  await cdp('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await eventually(() => evaluate('navigator.onLine === true'), 'online after fallback test');
  console.log('✓ 在线上传失败回落本地仓；移除/取消编辑都会清理没保存的本机图');

  // 上传失败时的网络请求失败属于预期噪音（浏览器可能记一条 Failed to load resource）
  const unexpectedErrors = errors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED/i.test(String(e)));
  assert.deepEqual(unexpectedErrors, [], '页面不应有运行时报错');
  console.log('\n✓ App 离线加图主链验收通过（全部写入均在隔离实例）');
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
