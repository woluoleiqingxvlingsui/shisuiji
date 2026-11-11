/**
 * 拾穗集 —— 知识库「关联本地文件」的真实浏览器验收（headless Edge + CDP）
 * 用法：node tools/test-kb-files-ui.mjs
 *
 * 验的是用户真正看到的东西：
 *   1. 电脑端：编辑器里有「选择文件」按钮 + 可编辑的完整路径输入框，并写明只保存路径；
 *   2. 卡片上显示文件名、打开文件 / 更新文件入口，文件不在时给出显眼的失效提示；
 *   3. 编辑时路径原样带回；清空路径保存 = 解除关联；
 *   4. 手机端：只读说明，不出现任何电脑端操作入口。
 *
 * 隔离：server.js + public/ + lib/ 复制到临时目录各自跑；DANJI_PAPERS_DIR 显式指向临时目录；
 * 端口随机；浏览器用独立 profile；child_process 换成记录桩（不真的弹窗口、不真的打开文件）。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserCandidates = [process.env.EDGE_PATH, process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
  .filter(Boolean).map((location, index) => (process.env.EDGE_PATH && index === 0 ? location : path.join(location, 'Microsoft', 'Edge', 'Application', 'msedge.exe')));
let browserPath;
for (const candidate of browserCandidates) {
  try { await fs.access(candidate); browserPath = candidate; break; } catch { /* 下一个安装目录 */ }
}
assert.ok(browserPath, '需要本机 Edge，或用 EDGE_PATH 指定浏览器路径');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'danji-kb-files-ui-'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name} ${extra}`); process.exitCode = 1; }
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
async function eventually(test, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await test(); if (value) return value; } catch { /* 还没渲染好 */ }
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}

// 夹具：一个真实存在的本地文件（只在临时目录里）
const fixtureDir = path.join(tmp, '资料 夹');
await fs.mkdir(fixtureDir, { recursive: true });
const fixturePath = path.join(fixtureDir, 'AT&T 白皮书 笔记.pdf');
await fs.writeFile(fixturePath, '%PDF-1.4 fixture');
const openLog = path.join(tmp, 'open.log');
const pickFile = path.join(tmp, 'pick.txt');

let server, browser, ws;
try {
  await fs.cp(path.join(root, 'server.js'), path.join(tmp, 'server.js'));
  await fs.cp(path.join(root, 'lib'), path.join(tmp, 'lib'), { recursive: true });
  await fs.cp(path.join(root, 'public'), path.join(tmp, 'public'), { recursive: true });

  // child_process 换成记录桩：选文件不弹真窗口，打开文件不真的拉起程序
  const serverFile = path.join(tmp, 'server.js');
  const source = await fs.readFile(serverFile, 'utf8');
  const requireLine = "const { spawn, execFile } = require('child_process');";
  assert.ok(source.includes(requireLine), 'server.js 的 child_process 引入行变了，测试桩要同步');
  const stub = [
    "const spawn = (cmd, args) => {",
    "  fs.appendFileSync(process.env.DANJI_OPEN_LOG, JSON.stringify({ kind: 'spawn', cmd, args }) + '\\n');",
    "  return { pid: 1, unref() {}, once(ev, fn) { if (ev === 'spawn') setTimeout(() => fn(), 0); return this; } };",
    "};",
    "const execFile = (file, args, options, callback) => {",
    "  let out = '';",
    "  try { out = fs.readFileSync(process.env.DANJI_PICK_FILE, 'utf8'); } catch { out = ''; }",
    "  setTimeout(() => callback(null, out, ''), 5);",
    "};",
    "execFile[require('util').promisify.custom] = (file, args, options) => new Promise((resolve) => {",
    "  let out = '';",
    "  try { out = fs.readFileSync(process.env.DANJI_PICK_FILE, 'utf8'); } catch { out = ''; }",
    "  setTimeout(() => resolve({ stdout: out, stderr: '' }), 5);",
    "});",
  ].join('\n');
  await fs.writeFile(serverFile, source.replace(requireLine, stub));

  const port = await freePort();
  const debugPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(tmp, 'server.js')], {
    cwd: tmp, windowsHide: true,
    env: {
      ...process.env, PORT: String(port), DANJI_HOST: '127.0.0.1', DANJI_TOKEN: '',
      DANJI_PAPERS_DIR: path.join(tmp, 'test-papers'), DANJI_OPEN_LOG: openLog, DANJI_PICK_FILE: pickFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stderr.on('data', (chunk) => { serverLog += chunk; });
  await eventually(async () => {
    if (server.exitCode !== null) throw new Error(serverLog);
    return (await fetch(base + '/api/health')).ok;
  }, 'isolated server');
  console.log(`临时实例：${tmp} 端口 ${port}`);

  // 夹具数据：一条带文件关联的知识、一条没文件的
  const created = await fetch(base + '/api/kb', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '白皮书要点', content: '一条可复用的知识。', tags: ['写作'], file_path: fixturePath }),
  });
  assert.ok(created.ok, 'create kb fixture');
  const entry = await created.json();
  const plain = await fetch(base + '/api/kb', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '没有文件的知识', content: '普通条目。', tags: [] }),
  });
  assert.ok(plain.ok, 'create plain kb fixture');

  browser = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(tmp, 'browser-profile')}`, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await eventually(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === 'page'), 'headless browser');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener('message', (e) => {
    const message = JSON.parse(e.data);
    if (message.id) {
      const callback = pending.get(message.id);
      if (callback) { pending.delete(message.id); message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result); }
    }
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') pageErrors.push(message.params.args.map((a) => a.value || a.description).join(' '));
  });
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout ' + method)); }, 15000);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (err) => { clearTimeout(timer); reject(err); } });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });

  /* ---------- 1. 电脑端：卡片上的文件行 ---------- */
  console.log('\n1. 电脑端卡片');
  await cdp('Page.navigate', { url: `${base}/?board=kb&theme=light` });
  await eventually(() => evaluate(`!!document.querySelector('#app:not([v-cloak]) .kb-card')`), 'kb board rendered');
  await pause(300);
  const cardInfo = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.kb-card')].find(c => c.textContent.includes('白皮书要点'));
    if (!card) return null;
    const row = card.querySelector('.kb-file');
    return {
      hasRow: !!row,
      name: row ? row.querySelector('.kb-file-name').textContent.trim() : '',
      buttons: row ? [...row.querySelectorAll('button')].map(b => b.textContent.trim()) : [],
      warn: row ? !!row.querySelector('.kb-file-warn') : false,
    };
  })()`);
  ok('卡片上出现文件行', !!cardInfo && cardInfo.hasRow, JSON.stringify(cardInfo));
  ok('显示的是文件名（不是整条路径）', !!cardInfo && cardInfo.name.includes('AT&T 白皮书 笔记.pdf') && !cardInfo.name.includes('\\'), JSON.stringify(cardInfo));
  ok('有「打开文件」「更新文件」入口', !!cardInfo && cardInfo.buttons.includes('打开文件') && cardInfo.buttons.includes('更新文件'), JSON.stringify(cardInfo));
  ok('文件在时没有报错提示', !!cardInfo && cardInfo.warn === false, JSON.stringify(cardInfo));
  if (process.env.DANJI_UI_SCREENSHOTS) {
    await fs.mkdir(path.join(root, 'output', 'ui-preview'), { recursive: true });
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(root, 'output', 'ui-preview', 'kb-file-linked.png'), Buffer.from(shot.data, 'base64'));
  }

  /* ---------- 1b. 文件名可以被检索 ---------- */
  await evaluate(`(() => { const i = document.querySelector('.workspace-search input'); i.value = '白皮书 笔记.pdf'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await pause(300);
  const searchHit = await evaluate(`[...document.querySelectorAll('.kb-card')].filter(c => c.textContent.includes('白皮书要点')).length`);
  ok('文件名可以被检索到', searchHit === 1, String(searchHit));
  await evaluate(`(() => { const i = document.querySelector('.workspace-search input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await pause(200);

  /* ---------- 2. 打开文件：走服务端记录桩 ---------- */
  console.log('\n2. 打开文件');
  await fs.writeFile(openLog, '');
  await evaluate(`[...document.querySelectorAll('.kb-card')].find(c => c.textContent.includes('白皮书要点')).querySelector('.kb-file button').click()`);
  await eventually(async () => (await fs.readFile(openLog, 'utf8').catch(() => '')).includes('explorer.exe'), 'open-file request');
  const calls = (await fs.readFile(openLog, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const spawnCall = calls.find((c) => c.kind === 'spawn');
  ok('打开走系统默认程序 explorer.exe', !!spawnCall && spawnCall.cmd === 'explorer.exe', JSON.stringify(spawnCall));
  ok('参数是完整路径（含 & 空格 中文）', !!spawnCall && spawnCall.args[0] === fixturePath, JSON.stringify(spawnCall));

  /* ---------- 3. 编辑器：路径输入框 + 选择按钮 + 只保存路径的说明 ---------- */
  console.log('\n3. 编辑器');
  await evaluate(`[...document.querySelectorAll('.kb-card')].find(c => c.textContent.includes('白皮书要点')).querySelectorAll('.kb-file button')[1].click()`);
  await eventually(() => evaluate(`!!document.querySelector('.kb-file-field')`), 'kb editor opened');
  const editorInfo = await evaluate(`(() => {
    const field = document.querySelector('.kb-file-field');
    return {
      value: field.querySelector('input').value,
      hint: field.querySelector('.kb-file-hint').textContent.replace(/\\s+/g, ' ').trim(),
      pickButton: [...field.querySelectorAll('button')].map(b => b.textContent.trim()),
    };
  })()`);
  ok('编辑器里带回了原路径', editorInfo.value === fixturePath, JSON.stringify(editorInfo));
  ok('有「选择文件」按钮', editorInfo.pickButton.some((t) => t.includes('选择文件')), JSON.stringify(editorInfo));
  ok('写明只保存路径、不复制不上传', /只保存这个路径/.test(editorInfo.hint) && /不会复制/.test(editorInfo.hint), JSON.stringify(editorInfo));

  /* ---------- 4. 选文件按钮：填进输入框 ---------- */
  await fs.writeFile(pickFile, fixturePath);
  await evaluate(`document.querySelector('.kb-file-field button').click()`);
  await eventually(() => evaluate(`document.querySelector('.kb-file-field input').value.length > 0`), 'picked file filled');
  const pickedValue = await evaluate(`document.querySelector('.kb-file-field input').value`);
  ok('选择后路径进了输入框', pickedValue === fixturePath, pickedValue);

  /* ---------- 5. 清空路径 = 解除关联 ---------- */
  await evaluate(`(() => { const i = document.querySelector('.kb-file-field input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const clearedValue = await evaluate(`document.querySelector('.kb-file-field input').value`);
  ok('清空输入框后确实为空', clearedValue === '', JSON.stringify(clearedValue));
  await evaluate(`document.querySelector('form.drawer-form button[type="submit"]').click()`);
  await pause(800);
  const afterSave = await evaluate(`JSON.stringify({ editorOpen: !!document.querySelector('.kb-file-field'), toast: (document.querySelector('.toast')?.textContent || '').trim() })`);
  console.log('  · 保存后状态：' + afterSave);
  await eventually(async () => {
    const res = await fetch(base + '/api/kb');
    const items = await res.json();
    const found = items.find((k) => k.id === entry.id);
    return found && found.file_path === '';
  }, 'file_path unlinked');
  ok('清空路径保存后关联被解除', true);

  /* ---------- 6. 失效文件：显眼的提示 ---------- */
  console.log('\n4. 失效提示');
  await fetch(base + `/api/kb/${entry.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '白皮书要点', content: '一条可复用的知识。', tags: ['写作'], file_path: fixturePath, base_updated_at: (await (await fetch(base + '/api/kb')).json()).find((k) => k.id === entry.id).updated_at }),
  });
  await fs.rm(fixturePath, { force: true });
  // 服务端状态缓存 5 秒：等它过期再刷新页面，才能看到「文件不在了」的提示
  await pause(6000);
  await cdp('Page.navigate', { url: `${base}/?board=kb&theme=light` });
  await eventually(() => evaluate(`!!document.querySelector('#app:not([v-cloak]) .kb-card')`), 'kb board rendered again');
  await eventually(() => evaluate(`!!document.querySelector('.kb-file-warn')`), 'missing file warning');
  const warnText = await evaluate(`document.querySelector('.kb-file-warn').textContent.replace(/\\s+/g,' ').trim()`);
  ok('文件不在时给出显眼提示', /移动|删除|不在/.test(warnText), warnText);
  if (process.env.DANJI_UI_SCREENSHOTS) {
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(root, 'output', 'ui-preview', 'kb-file-missing.png'), Buffer.from(shot.data, 'base64'));
  }

  /* ---------- 7. 手机端：只读说明，没有电脑端操作 ---------- */
  console.log('\n5. 手机端');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 2, mobile: true });
  await cdp('Page.navigate', { url: `${base}/?board=kb&theme=light` });
  await eventually(() => evaluate(`!!document.querySelector('#app:not([v-cloak]) .kb-card')`), 'narrow kb board');
  // 把自己当成手机端（role 由服务端按 IP 判定，这里直接改前端状态模拟手机视角）
  await evaluate(`(async () => { const { state } = await import('/js/state.js'); state.role = 'mobile'; state.sync.role = 'mobile'; })()`);
  await pause(400);
  const mobileInfo = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.kb-card')].find(c => c.textContent.includes('白皮书要点'));
    if (!card) return null;
    const row = card.querySelector('.kb-file');
    return {
      hasRow: !!row,
      buttons: row ? [...row.querySelectorAll('button')].map(b => b.textContent.trim()) : [],
      note: row ? (row.querySelector('.kb-file-note')?.textContent || '').trim() : '',
    };
  })()`);
  ok('手机端仍能看到文件信息', !!mobileInfo && mobileInfo.hasRow, JSON.stringify(mobileInfo));
  ok('手机端没有打开/更新文件的入口', !!mobileInfo && mobileInfo.buttons.length === 0, JSON.stringify(mobileInfo));
  ok('手机端给出只读说明', !!mobileInfo && /电脑端/.test(mobileInfo.note), JSON.stringify(mobileInfo));
  const mobileEditor = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.kb-card')].find(c => c.textContent.includes('白皮书要点'));
    return card.querySelectorAll('.card-actions button').length;
  })()`);
  ok('手机端没有编辑入口（知识库只读）', mobileEditor === 0, String(mobileEditor));

  ok('页面没有脚本报错', pageErrors.length === 0, JSON.stringify(pageErrors).slice(0, 300));
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  if (browser && browser.exitCode === null) browser.kill();
  if (server && server.exitCode === null) {
    const closed = new Promise((resolve) => server.once('close', resolve));
    server.kill();
    await closed.catch(() => {});
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => {});
}

if (process.exitCode) {
  console.error('\n✗ 知识库关联文件 UI 验收失败');
} else {
  console.log(`\n✓ 知识库关联文件 UI 验收全部通过（${passed} 项）`);
}
