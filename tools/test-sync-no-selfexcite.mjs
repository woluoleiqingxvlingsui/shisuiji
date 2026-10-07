/**
 * 拾穗集 —— 同步回报不得自激励(临时实例,不碰真实服务)
 * 用法:node tools/test-sync-no-selfexcite.mjs
 *
 * 背景(2026-10-06 深夜实锤):saveMessages 走 queueWrite 会 markDataChanged,
 * 于是「手机发一条回报」=「dataVersion +1」=「手机下一轮 pull 误判又落后」=
 * 「再发一条回报」……电脑端被「手机已补齐」无限刷屏。本文件钉死四条铁律:
 *   1. 消息类写入(回报/已读/清空)永远不推 dataVersion;
 *   2. 同一条回报(同 sync_rid)重发只落一条消息;
 *   3. 真实数据写入仍然推 dataVersion(回归保护);
 *   4. 源码层面:saveMessages 里不许再出现 markDataChanged。
 *
 * 红线遵守(AGENTS.md §1 §2):server.js + public/ + lib/ 复制到临时目录再跑;
 * DANJI_PAPERS_DIR 显式指向临时目录;端口 8795 绝不碰真实 8642;临时目录用完即删。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TOKEN = 'selfexcite-probe-token';
const PORT = 8795;

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'danji-selfexcite-'));
const papers = path.join(tmp, 'papers');
fs.mkdirSync(papers, { recursive: true });
for (const item of ['server.js', 'public', 'lib']) {
  fs.cpSync(path.join(REPO, item), path.join(tmp, item), { recursive: true });
}
console.log(`临时实例:${tmp}`);

const child = spawn(process.execPath, ['server.js'], {
  cwd: tmp,
  env: { ...process.env, PORT: String(PORT), DANJI_PAPERS_DIR: papers, DANJI_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });
child.stdout.on('data', () => {});

const base = `http://127.0.0.1:${PORT}`;   // 本机回环 = desktop 身份
const auth = { 'X-Danji-Token': TOKEN, 'Content-Type': 'application/json' };

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

async function version() {
  const res = await fetch(`${base}/api/sync/pull`, { headers: auth });
  assert.equal(res.status, 200, `pull 应 200,实际 ${res.status}`);
  return (await res.json()).data_version;
}

async function report(body) {
  return fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ kind: 'bg-sync', sync_ok: '1', ...body }),
  });
}

try {
  console.log('隔离实例启动');
  if (!await waitUp()) {
    console.error(stderr.trim() || '(stderr 为空)');
    throw new Error('隔离实例未能启动');
  }
  ok('临时实例起来了(不碰真实 8642 服务)', true);

  const v0 = await version();
  ok('pull 返回基线 data_version', Number.isFinite(v0) && v0 >= 1, String(v0));

  const r1 = await report({ sync_caught_up: '1', sync_background: '1' });
  assert.equal(r1.status, 201, `回报应被接受,实际 ${r1.status}`);
  const v1 = await version();
  ok('回报落盘不推 dataVersion(自激励循环的铁门)', v1 === v0, `before=${v0} after=${v1}`);

  // 同一条回报带同一个 sync_rid 重发:只能有一条消息
  const rid = '11111111-1111-4111-8111-111111111111';
  const r2a = await report({ sync_caught_up: '1', sync_background: '1', sync_rid: rid });
  const r2b = await report({ sync_caught_up: '1', sync_background: '1', sync_rid: rid });
  assert.equal(r2a.status, 201, `首报应 201,实际 ${r2a.status}`);
  assert.equal(r2b.status, 200, `重发同 rid 应还旧账(200),实际 ${r2b.status}`);
  const list = await (await fetch(`${base}/api/messages`, { headers: auth })).json();
  const bg = list.filter((m) => m.kind === 'bg-sync');
  const ridHits = bg.filter((m) => m.sync_rid === rid).length;
  ok('同 sync_rid 重发只落一条消息', ridHits === 1, `rid 命中 ${ridHits} 条`);

  // 已读标记也不许推版本
  assert.ok(bg.length >= 1 && bg[0].id, '消息中心里应有 bg-sync 消息');
  const markRes = await fetch(`${base}/api/messages/${bg[0].id}`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ ...bg[0], read: true }),
  });
  assert.equal(markRes.status, 200, `已读标记应 200,实际 ${markRes.status}`);
  const v2 = await version();
  ok('已读/消息维护类写入不推 dataVersion', v2 === v1, `before=${v1} after=${v2}`);

  // 真数据写入必须推版本(回归保护)
  const act = await fetch(`${base}/api/activities`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ platform: '测试', title: '自激励测试' }),
  });
  assert.equal(act.status, 201, `活动写入应 201,实际 ${act.status}`);
  const v3 = await version();
  ok('真实数据写入仍然推 dataVersion(markDataChanged 没被误伤)', v3 === v2 + 1, `before=${v2} after=${v3}`);

  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const saveBlock = src.slice(src.indexOf('function saveMessages()'), src.indexOf('function normalizeMessage'));
  ok('源码钉死:saveMessages 里没有 markDataChanged', !saveBlock.includes('markDataChanged'), saveBlock.slice(0, 300));
  ok('源码钉死:markDataChanged 仍然自增 dataVersion',
    /function markDataChanged\(\)[\s\S]{0,80}dataVersion\s*\+=\s*1/.test(src));
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  child.kill();
  await sleep(300);
  if (child.exitCode === null) child.kill('SIGKILL');
  // 临时实例的 data/ 与 papers/ 都在临时目录里,一并清掉;真实仓库一概不碰
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (process.exitCode) {
  console.error(`\n✗ test-sync-no-selfexcite:有失败(通过 ${passed})`);
} else {
  console.log(`\n✓ test-sync-no-selfexcite:${passed} 项通过`);
}
