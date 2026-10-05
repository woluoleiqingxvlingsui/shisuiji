/**
 * 拾穗集 —— 服务端同步回报的文案 + pull 的 data_version（临时实例，不碰真实服务）
 * 用法：node tools/test-kb-report-title.mjs
 *
 * 为什么要有这个：文案是**服务端生成**的（不采信手机传来的 title/body），
 * 「手机推来了 3 条改动」「手机补齐了后台的更新」都取决于手机传上来的新字段，
 * 字段名拼错或类型不对，手机端就改了代码也永远只看到旧文案。
 * data_version 同理：手机靠它发现「我睡着的这段时间电脑端改过东西」，
 * 服务端漏了这个字段，手机的补齐回报就永远不会触发。
 *
 * 红线遵守（AGENTS.md §1 §2）：
 *   - server.js + public/ + lib/ 复制到临时目录再跑，data/ 各自独立
 *   - DANJI_PAPERS_DIR 显式指向临时目录，绝不回落项目内 papers\
 *   - 端口用高位端口，绝不碰真实服务的 8642
 *   - 临时目录用完就删；data/messages.json（真实数据）全程不碰
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TOKEN = 'kb-title-probe-token';
const PORT = 8794;

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'danji-kbtitle-'));
const papers = path.join(tmp, 'papers');
fs.mkdirSync(papers, { recursive: true });
for (const item of ['server.js', 'public', 'lib']) {
  fs.cpSync(path.join(REPO, item), path.join(tmp, item), { recursive: true });
}
console.log(`临时实例：${tmp}`);

const child = spawn(process.execPath, ['server.js'], {
  cwd: tmp,
  env: { ...process.env, PORT: String(PORT), DANJI_PAPERS_DIR: papers, DANJI_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });
child.stdout.on('data', () => {});

const base = `http://127.0.0.1:${PORT}`;   // 本机回环 = desktop 身份，免口令
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

/** 以手机的身份回报一次同步结论，返回服务端生成的 title */
async function report(body) {
  const res = await fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ kind: 'bg-sync', sync_ok: '1', ...body }),
  });
  assert.equal(res.status, 201, `回报应被接受，实际 ${res.status}`);
  return res.json();
}

try {
  console.log('隔离实例启动');
  if (!await waitUp()) {
    console.error(stderr.trim() || '(stderr 为空)');
    throw new Error('隔离实例未能启动');
  }
  ok('临时实例起来了（不碰真实 8642 服务）', true);

  console.log('回报文案（由服务端生成）');

  const pushed = await report({ sync_pushed: '3' });
  ok('推了 3 条 → 「手机推来了 3 条改动 ✅」', pushed.title === '手机推来了 3 条改动 ✅', pushed.title);
  ok('推了几条被记进消息（sync_pushed 落库）', pushed.sync_pushed === '3', String(pushed.sync_pushed));

  const caught = await report({ sync_caught_up: '1' });
  ok('补齐了后台更新 → 「手机补齐了后台的更新 ✅」', caught.title === '手机补齐了后台的更新 ✅', caught.title);
  ok('补齐标记被记进消息（sync_caught_up 落库）', caught.sync_caught_up === '1', String(caught.sync_caught_up));

  const plain = await report({});
  ok('老客户端（不带新字段）→ 仍是「手机已同步 ✅」', plain.title === '手机已同步 ✅', plain.title);
  ok('缺省字段归一成 0 而不是 undefined', plain.sync_pushed === '0' && plain.sync_caught_up === '0',
    `${plain.sync_pushed}/${plain.sync_caught_up}`);

  console.log('pull 的 data_version（手机发现「我落后了」的依据）');
  const pull = await (await fetch(`${base}/api/sync/pull`, { headers: auth })).json();
  ok('pull 返回 data_version', 'data_version' in pull, Object.keys(pull).join(','));
  ok('data_version 是数字', typeof pull.data_version === 'number' && Number.isFinite(pull.data_version),
    String(pull.data_version));
  ok('data_version >= 1（起始版本号）', pull.data_version >= 1, String(pull.data_version));
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  child.kill();
  await sleep(300);
  if (child.exitCode === null) child.kill('SIGKILL');
  // 临时实例的 data/ 与 papers/ 都在临时目录里，一并清掉；真实仓库一概不碰
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (process.exitCode) {
  console.error(`\n✗ test-kb-report-title：有失败（通过 ${passed}）`);
} else {
  console.log(`\n✓ test-kb-report-title：${passed} 项通过`);
}
