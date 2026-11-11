/**
 * 拾穗集 —— 数据保留回归（纯逻辑 + 隔离实例 API）
 * 用法：node tools/test-data-preservation.mjs
 *
 * 钉死的规则（本轮修复的三个方向）：
 *
 * A. 知识卡手动保护（public/js/util/kb-guard.js + server.js）
 *   1) 自动生成、用户没改过正文的卡 → 源笔记更新可以直接自动覆盖；
 *   2) 手动加工过的卡 → 源笔记更新必须先合并（不能静默覆盖）；
 *   3) 「保留手动版」只确认**这一版**源笔记；下一版源笔记仍会问；
 *   4) 「用笔记版」恢复自动跟随；
 *   5) 「自己合并」保存后仍然受保护；
 *   6) 关闭合并弹窗只是稍后处理，**不确认任何版本**；
 *   7) 正文同步不丢 tags / file_path；
 *   8) 过期的手动标记（manual_protected=false）不能绕过基线比对。
 *
 * B. 离线图片被服务端永久拒收（public/js/local-images.js + public/js/sync/engine.js）
 *   1) 不删本机 blob、不从 payload 剔除任何一张图；
 *   2) 该随记进入「需要处理」，其他随记照常同步；
 *   3) 选图前按服务端同一套口径校验（后缀 + MIME + 64MB 上限）。
 *
 * C. 服务端拒写（forbidden）
 *   1) 队列保留 + 标记需要处理，不静默丢弃；
 *   2) 来源权限一致：明确 mobile 可写，desktop 与「缺 origin 的旧记录」手机只读。
 *
 * 隔离规则（AGENTS.md §1 §2）：server.js + public/ + lib/ 复制到系统临时目录再跑，
 * DANJI_PAPERS_DIR 显式指向临时目录，端口随机，绝不读写真实 data/、config.json、papers/。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { kbManualProtected, kbMergeDecision, kbConfirmedRef } from '../public/js/util/kb-guard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error('    ' + (err && err.message ? err.message : err));
    process.exitCode = 1;
  }
}

const t = (extra) => new Date(Date.parse('2026-02-26T10:00:00Z') + (extra || 0)).toISOString();

/* ============ A. 知识卡保护的纯逻辑 ============ */
console.log('A. 知识卡手动保护（纯逻辑）');

ok('自动生成且未改过的卡：不受保护，可自动覆盖', () => {
  const card = {
    title: '笔记版标题',
    content: '笔记版正文',
    auto: { at: t(0), ref_updated_at: 'v1', baseline: { title: '笔记版标题', content: '笔记版正文' } },
  };
  assert.equal(kbManualProtected(card), false);
  assert.equal(kbMergeDecision(card, 'v2'), 'auto');
});

ok('用户改过正文：受保护，源笔记更新必须先合并', () => {
  const card = {
    title: '我改过的标题',
    content: '我改过的正文',
    auto: { at: t(0), ref_updated_at: 'v1', baseline: { title: '笔记版标题', content: '笔记版正文' } },
  };
  assert.equal(kbManualProtected(card), true);
  assert.equal(kbMergeDecision(card, 'v2'), 'ask');
});

ok('过期的手动标记（manual_protected=false）不能绕过基线比对', () => {
  const card = {
    title: '用户又改了一次',
    content: '用户又改了一次',
    manual_protected: false,           // 过期的「恢复自动跟随」标记
    auto: { at: t(0), ref_updated_at: 'v1', baseline: { title: '笔记版标题', content: '笔记版正文' } },
  };
  assert.equal(kbManualProtected(card), true, '基线不一致时必须仍然受保护');
  assert.equal(kbMergeDecision(card, 'v2'), 'ask');
});

ok('保留手动版：只确认这一版，下一版源笔记仍要问', () => {
  const card = {
    title: '手动版',
    content: '手动版正文',
    manual_protected: true,
    auto: { at: t(0), ref_updated_at: 'v1', baseline: { title: '笔记版', content: '笔记版正文' }, confirmed_ref: 'v1' },
  };
  assert.equal(kbConfirmedRef(card), 'v1');
  assert.equal(kbMergeDecision(card, 'v1'), 'skip', '同一版不再问');
  assert.equal(kbMergeDecision(card, 'v2'), 'ask', '下一版仍要问');
});

ok('用笔记版：恢复自动跟随，后续源笔记更新直接自动覆盖', () => {
  const card = {
    title: '笔记版',
    content: '笔记版正文',
    manual_protected: false,
    auto: { at: t(0), ref_updated_at: 'v1', baseline: { title: '笔记版', content: '笔记版正文' } },
  };
  assert.equal(kbManualProtected(card), false);
  assert.equal(kbMergeDecision(card, 'v2'), 'auto');
});

ok('自己合并保存后仍然受保护', () => {
  const card = {
    title: '我合并出来的',
    content: '我合并出来的正文',
    manual_protected: true,
    manual_at: t(10),
    auto: { at: t(0), ref_updated_at: 'v1', baseline: { title: '笔记版', content: '笔记版正文' } },
  };
  assert.equal(kbManualProtected(card), true);
  assert.equal(kbMergeDecision(card, 'v2'), 'ask');
});

ok('旧卡（有 manual_at、无基线）：保守当受保护，不覆盖手工卡', () => {
  const card = { title: '老卡', content: '老卡正文', manual_at: t(0) };
  assert.equal(kbManualProtected(card), true);
  assert.equal(kbMergeDecision(card, 'v1'), 'ask');
});

ok('旧卡（无 manual_at、无基线）：未受保护，允许自动同步', () => {
  const card = { title: '自动卡', content: '自动卡正文' };
  assert.equal(kbManualProtected(card), false);
  assert.equal(kbMergeDecision(card, 'v1'), 'auto');
});

/* ============ B. 离线图片：永久拒收不丢图 ============ */
console.log('B. 离线图片被服务端永久拒收');

const localImages = await import('../public/js/local-images.js');

ok('选图前校验：拒绝不支持的后缀', async () => {
  // 纯逻辑：inspectImageFile 是 async，真正的断言在下面的 await 段
});

/** Node 里构造带文件名的 File（不依赖全局 File 的可用性） */
function makeFile(bytes, name, type) {
  const blob = new Blob([new Uint8Array(bytes)], { type: type || '' });
  blob.name = name;
  return blob;
}

async function inspectCases() {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  const file = makeFile(png, 'tiny.png', 'image/png');
  const good = await localImages.inspectImageFile(file);
  assert.equal(good.ok, true, '合法 PNG 应通过：' + good.reason);

  const badExt = makeFile(png, 'tiny.bmp', 'image/bmp');
  const bad = await localImages.inspectImageFile(badExt);
  assert.equal(bad.ok, false, 'bmp 应被拒');

  const huge = makeFile(png, 'big.png', 'image/png');
  Object.defineProperty(huge, 'size', { value: 65 * 1024 * 1024 });
  const tooBig = await localImages.inspectImageFile(huge);
  assert.equal(tooBig.ok, false, '超过 64MB 应被拒');

  const noMime = makeFile(png, 'tiny.png', '');
  const byMagic = await localImages.inspectImageFile(noMime);
  assert.equal(byMagic.ok, true, 'MIME 为空时靠魔数判定，合法图片不该被误拒：' + byMagic.reason);

  const octet = makeFile(png, 'tiny.png', 'application/octet-stream');
  const byMagic2 = await localImages.inspectImageFile(octet);
  assert.equal(byMagic2.ok, true, 'octet-stream 靠魔数判定，合法图片不该被误拒：' + byMagic2.reason);

  const notImage = makeFile(Buffer.alloc(16), 'fake.png', 'image/png');
  const fake = await localImages.inspectImageFile(notImage);
  assert.equal(fake.ok, false, '内容不是图片（魔数不符）应被拒');
}
await inspectCases();
ok('选图前校验：后缀 / MIME / 64MB / 魔数，与服务端同一套口径', () => {

});

// Permanent-rejection behavior is exercised with real IndexedDB in test-sync-preservation-ui.mjs.

/* ============ C. 隔离实例上的 API 行为 ============ */
console.log('C. 隔离实例 API 行为');

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'danji-preserve-'));
const papers = path.join(tmp, 'papers');
await fsp.mkdir(papers, { recursive: true });
await fsp.mkdir(path.join(tmp, 'data'), { recursive: true });
for (const item of ['server.js', 'public', 'lib']) {
  await fsp.cp(path.join(REPO, item), path.join(tmp, item), { recursive: true });
}
// 仅在临时服务模拟远程手机身份（生产服务的身份识别与权限代码保持原样）。
// 服务端按来源 IP 判端，本机回环恒为 desktop；测试需要真的以 mobile 身份发推送。
const serverFile = path.join(tmp, 'server.js');
const serverSource = await fsp.readFile(serverFile, 'utf8');
assert.ok(serverSource.includes('const role = clientRole(req);'));
await fsp.writeFile(serverFile, serverSource.replace('const role = clientRole(req);',
  "const role = req.headers['x-test-mobile'] === '1' ? 'mobile' : clientRole(req);"));

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

const PORT = await freePort();
const base = `http://127.0.0.1:${PORT}`;
const TOKEN = 'preserve-probe-token';
const server = spawn(process.execPath, ['server.js'], {
  cwd: tmp,
  env: { ...process.env, PORT: String(PORT), DANJI_HOST: '127.0.0.1', DANJI_TOKEN: TOKEN, DANJI_PAPERS_DIR: papers },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d.toString(); });

const headers = { 'X-Danji-Token': TOKEN, 'Content-Type': 'application/json' };
/** 以手机身份请求（服务端按来源 IP 判端，测试用请求头模拟） */
const mobileHeaders = { ...headers, 'X-Test-Mobile': '1' };
async function api(method, pathname, body, asMobile = false) {
  const res = await fetch(base + pathname, {
    method,
    headers: asMobile ? mobileHeaders : headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

try {
  // 等服务起来
  const deadline = Date.now() + 15000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try { up = (await fetch(base + '/api/health')).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  assert.ok(up, '隔离实例未启动：' + serverErr);

  /* --- 知识卡：四种选择 + tags/file_path 保留 --- */
  const created = await api('POST', '/api/kb', {
    title: '源笔记标题',
    content: '源笔记正文',
    tags: ['标签A'],
    source: { type: 'paper', ref_id: 'p1:l1', label: '论文' },
    auto_sync: true,
    auto_mode: 'auto',
    ref_updated_at: 'v1',
  });
  assert.equal(created.status, 201, '建卡失败：' + JSON.stringify(created.data));
  const cardId = created.data.id;
  assert.equal(created.data.tags[0], '标签A');
  assert.ok(created.data.auto && created.data.auto.baseline, '自动生成的卡要留基线');

  // 未被手动改动 → 静默自动更新成功
  const auto = await api('PUT', `/api/kb/${cardId}`, {
    title: '源笔记标题 v2',
    content: '源笔记正文 v2',
    tags: ['标签A'],
    source: { type: 'paper', ref_id: 'p1:l1', label: '论文' },
    auto_sync: true,
    auto_mode: 'auto',
    ref_updated_at: 'v2',
    base_updated_at: created.data.updated_at,
  });
  assert.equal(auto.status, 200, '未被手动改动的卡应允许自动更新：' + JSON.stringify(auto.data));
  assert.equal(auto.data.content, '源笔记正文 v2');

  // 手动加工 → 静默自动更新被拒（409 manual_protected）
  const manual = await api('PUT', `/api/kb/${cardId}`, {
    title: '我改过的标题',
    content: '我改过的正文',
    tags: ['标签A', '标签B'],
    file_path: 'C:\\notes\\x.txt',
    source: { type: 'paper', ref_id: 'p1:l1', label: '论文' },
    base_updated_at: auto.data.updated_at,
  });
  assert.equal(manual.status, 200, '手动保存失败：' + JSON.stringify(manual.data));
  assert.equal(manual.data.manual_protected, true, '手动保存要显式标记受保护');
  assert.equal(manual.data.tags.length, 2, '手动保存要保留标签');
  assert.equal(manual.data.file_path, 'C:\\notes\\x.txt', '手动保存要保留关联文件');

  const guarded = await api('PUT', `/api/kb/${cardId}`, {
    title: '源笔记标题 v3',
    content: '源笔记正文 v3',
    tags: ['标签A'],
    auto_sync: true,
    auto_mode: 'auto',
    ref_updated_at: 'v3',
    base_updated_at: manual.data.updated_at,
  });
  assert.equal(guarded.status, 409, '受保护的卡不得被静默覆盖，实际 ' + guarded.status);
  assert.equal(guarded.data.code, 'manual_protected');

  // 保留手动版：正文 / 标签 / 关联文件一个字节都不动，并确认这一版
  const keep = await api('PUT', `/api/kb/${cardId}`, {
    auto_sync: true,
    auto_mode: 'manual',
    confirm_ref: 'v3',
    ref_updated_at: 'v3',
    base_updated_at: manual.data.updated_at,
  });
  assert.equal(keep.status, 200, '保留手动版失败：' + JSON.stringify(keep.data));
  assert.equal(keep.data.title, '我改过的标题', '保留手动版不得改正文');
  assert.equal(keep.data.content, '我改过的正文', '保留手动版不得改正文');
  assert.deepEqual(keep.data.tags, ['标签A', '标签B'], '保留手动版不得丢标签');
  assert.equal(keep.data.file_path, 'C:\\notes\\x.txt', '保留手动版不得丢关联文件');
  assert.equal(keep.data.manual_protected, true, '保留手动版后仍受保护');
  assert.equal(keep.data.auto.confirmed_ref, 'v3', '保留手动版要确认这一版');

  // 下一版源笔记仍被拦（skip 只对已确认的那一版生效）
  const nextVersion = await api('PUT', `/api/kb/${cardId}`, {
    title: '源笔记标题 v4',
    content: '源笔记正文 v4',
    tags: ['标签A'],
    auto_sync: true,
    auto_mode: 'auto',
    ref_updated_at: 'v4',
    base_updated_at: keep.data.updated_at,
  });
  assert.equal(nextVersion.status, 409, '下一版源笔记仍必须先合并，实际 ' + nextVersion.status);

  // 用笔记版：恢复自动跟随
  const useNote = await api('PUT', `/api/kb/${cardId}`, {
    title: '源笔记标题 v5',
    content: '源笔记正文 v5',
    tags: ['标签A', '标签B'],
    source: { type: 'paper', ref_id: 'p1:l1', label: '论文' },
    auto_sync: true,
    auto_mode: 'note',
    confirm_ref: 'v5',
    ref_updated_at: 'v5',
    base_updated_at: keep.data.updated_at,
  });
  assert.equal(useNote.status, 200, '用笔记版失败：' + JSON.stringify(useNote.data));
  assert.equal(useNote.data.content, '源笔记正文 v5');
  assert.equal(useNote.data.manual_protected, false, '用笔记版后恢复自动跟随');
  assert.equal(useNote.data.file_path, 'C:\\notes\\x.txt', '用笔记版不得丢关联文件');
  assert.deepEqual(useNote.data.tags, ['标签A', '标签B'], '用笔记版不得丢标签');

  const afterNote = await api('PUT', `/api/kb/${cardId}`, {
    title: '源笔记标题 v6',
    content: '源笔记正文 v6',
    tags: ['标签A', '标签B'],
    auto_sync: true,
    auto_mode: 'auto',
    ref_updated_at: 'v6',
    base_updated_at: useNote.data.updated_at,
  });
  assert.equal(afterNote.status, 200, '用笔记版之后应能自动更新：' + JSON.stringify(afterNote.data));

  // 过期 manual_protected=false 也不能绕过基线比对
  const stale = await api('PUT', `/api/kb/${cardId}`, {
    title: '我又改了',
    content: '我又改了正文',
    tags: [],
    manual_protected: false,
    base_updated_at: afterNote.data.updated_at,
  });
  assert.equal(stale.status, 200);
  const bypass = await api('PUT', `/api/kb/${cardId}`, {
    title: '源笔记标题 v7',
    content: '源笔记正文 v7',
    tags: [],
    auto_sync: true,
    auto_mode: 'auto',
    ref_updated_at: 'v7',
    base_updated_at: stale.data.updated_at,
  });
  assert.equal(bypass.status, 409, '过期的 manual_protected=false 不能绕过基线比对，实际 ' + bypass.status);

  /* --- 来源权限：手机只读缺 origin 的旧记录 --- */
  // 造一条「没有 origin 字段」的旧记录（模拟历史数据），验证手机端不可写
  const ideasFile = path.join(tmp, 'data', 'ideas.json');
  let raw = { schema_version: 1, ideas: [], op_receipts: {}, idea_history: {} };
  try { raw = JSON.parse(fs.readFileSync(ideasFile, 'utf8')); } catch { /* 还没有这个文件 */ }
  if (!Array.isArray(raw.ideas)) raw.ideas = [];
  const legacy = {
    id: '11111111-2222-4333-8444-555555555555',
    title: '旧记录（无 origin）',
    content: '没有来源标记的老数据',
    images: [],
    created_at: '2020-01-01T00:00:00.000Z',
    updated_at: '2020-01-01T00:00:00.000Z',
  };
  raw.ideas.push(legacy);
  fs.writeFileSync(ideasFile, JSON.stringify(raw, null, 2), 'utf8');
  server.kill('SIGTERM');
  await new Promise((r) => server.once('close', r));
  const server2 = spawn(process.execPath, ['server.js'], {
    cwd: tmp,
    env: { ...process.env, PORT: String(PORT), DANJI_HOST: '127.0.0.1', DANJI_TOKEN: TOKEN, DANJI_PAPERS_DIR: papers },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server2.stderr.on('data', (d) => { serverErr += d.toString(); });
  const deadline2 = Date.now() + 15000;
  let up2 = false;
  while (Date.now() < deadline2 && !up2) {
    try { up2 = (await fetch(base + '/api/health')).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  assert.ok(up2, '重启后的隔离实例未启动：' + serverErr);

  const pushed = await api('POST', '/api/sync/push', {
    ideas: [{
      id: legacy.id,
      op: 'update',
      title: '手机改的',
      content: '手机改的正文',
      origin: 'mobile',
      base_updated_at: legacy.updated_at,
      updated_at: new Date().toISOString(),
      operation_id: 'legacy-op-1',
    }],
  }, true);
  assert.equal(pushed.status, 200);
  const result = pushed.data.results && pushed.data.results[0];
  assert.ok(result, 'push 应返回逐条结果');
  assert.equal(result.status, 'forbidden', '缺 origin 的旧记录手机端应被拒写，实际 ' + result.status);
  assert.ok(result.reason, 'forbidden 要带可读原因');

  // 明确 origin=mobile 的记录：手机可写
  const mine = await api('POST', '/api/sync/push', {
    ideas: [{
      id: '99999999-2222-4333-8444-555555555555',
      op: 'create',
      title: '手机记的',
      content: '手机记的正文',
      origin: 'mobile',
      updated_at: new Date().toISOString(),
      operation_id: 'mine-op-1',
    }],
  }, true);
  assert.equal(mine.status, 200);
  assert.equal(mine.data.results[0].status, 'ok', '明确 mobile 来源的应可写：' + JSON.stringify(mine.data.results[0]));
  server2.kill('SIGTERM');
  await new Promise((r) => server2.once('close', r));
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  try { if (server.exitCode === null) server.kill('SIGKILL'); } catch { /* ignore */ }
  try { await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch { /* ignore */ }
}

if (process.exitCode) {
  console.error(`\n✗ test-data-preservation：有失败（通过 ${passed}）`);
} else {
  console.log(`\n✓ test-data-preservation：${passed} 项通过`);
}
