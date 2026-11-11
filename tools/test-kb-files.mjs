/**
 * 拾穗集 —— 知识库「关联本地文件」回归（Node，无需浏览器）
 * 用法：node tools/test-kb-files.mjs
 *
 * 钉死的规则：
 *   1. 只保存路径：记录里只有路径字符串，文件本身不被复制/上传/解析；
 *   2. 编辑省略 file_path = 保留原关联；显式空串 = 解除关联；
 *   3. 路径必须本机绝对路径：UNC / 设备路径 / 数据流 / 控制字符 / 相对路径 / 网址一律拒绝；
 *   4. 文件类型走白名单：exe/bat/cmd/ps1/js/lnk 等可执行文件拒绝；
 *   5. 状态单独查（GET /api/kb/files/status），不写进记录、不 bump 版本；
 *   6. 打开文件只按记录 id 查已保存路径，spawn 参数不经 shell（含 & 空格 中文）；
 *   7. 手机端不能选文件 / 查状态 / 打开文件；
 *   8. 删除进回收站再恢复，文件关联不丢。
 *
 * 红线遵守（AGENTS.md §1 §2）：server.js + public/ + lib/ 复制到临时目录再跑；
 * DANJI_PAPERS_DIR 显式指向临时目录；端口随机，绝不碰真实 8642；临时目录用完即删。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

let passed = 0;
let skipped = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name} ${extra}`);
    process.exitCode = 1;
  }
}
function skip(name, why) {
  skipped += 1;
  console.log(`  · 跳过：${name}（${why}）`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = { 'Content-Type': 'application/json' };
const TOKEN = 'kb-files-isolated-token';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'danji-kb-files-'));
const papers = path.join(tmp, 'papers');
fs.mkdirSync(papers, { recursive: true });
for (const item of ['server.js', 'public', 'lib']) {
  fs.cpSync(path.join(REPO, item), path.join(tmp, item), { recursive: true });
}

// 把 child_process 的 spawn / execFile 换成记录桩：
//   - spawn：只记调用，不真的拉起任何外部程序（打开文件的参数安全性靠它验证）
//   - execFile：模拟文件选择窗口（不弹真窗口），路径从 DANJI_PICK_RESULT 来
const serverFile = path.join(tmp, 'server.js');
const serverSource = fs.readFileSync(serverFile, 'utf8');
const requireLine = "const { spawn, execFile } = require('child_process');";
assert.ok(serverSource.includes(requireLine), 'server.js 里的 child_process 引入行变了，测试桩需要同步');
const stub = `const spawn = (cmd, args, opts) => {
  fs.appendFileSync(process.env.DANJI_OPEN_LOG, JSON.stringify({ kind: 'spawn', cmd, args }) + '\\n');
  return {
    pid: 4242,
    unref() {},
    once(ev, fn) { if (ev === 'spawn') setTimeout(() => fn(), 0); return this; },
  };
};
const execFile = (file, args, options, callback) => {
  fs.appendFileSync(process.env.DANJI_OPEN_LOG, JSON.stringify({ kind: 'exec', cmd: file, args }) + '\\n');
  let out = '';
  try { out = fs.readFileSync(process.env.DANJI_PICK_FILE, 'utf8'); } catch { out = ''; }
  const delay = fs.existsSync(process.env.DANJI_PICK_FILE + '.delay') ? 1500 : 5;
  setTimeout(() => callback(null, out, ''), delay);
};
// 真实的 execFile 带 util.promisify.custom（resolve { stdout, stderr }），桩也得一样
execFile[require('util').promisify.custom] = (file, args, options) => new Promise((resolve) => {
  fs.appendFileSync(process.env.DANJI_OPEN_LOG, JSON.stringify({ kind: 'exec', cmd: file, args }) + '\\n');
  let out = '';
  try { out = fs.readFileSync(process.env.DANJI_PICK_FILE, 'utf8'); } catch { out = ''; }
  const delay = fs.existsSync(process.env.DANJI_PICK_FILE + '.delay') ? 1500 : 5;
  setTimeout(() => resolve({ stdout: out, stderr: '' }), delay);
});`;
fs.writeFileSync(serverFile, serverSource.replace(requireLine, stub));

const openLog = path.join(tmp, 'open.log');
const pickFile = path.join(tmp, 'pick.txt');
const fixtureDir = path.join(tmp, '资料 夹');
fs.mkdirSync(fixtureDir, { recursive: true });
const pdfPath = path.join(fixtureDir, 'AT&T 白皮书 笔记.pdf');
fs.writeFileSync(pdfPath, '%PDF-1.4 fixture content');
const otherPath = path.join(fixtureDir, '第二篇.md');
fs.writeFileSync(otherPath, '# fixture');

let child = null;
let base = '';
const auth = { ...json };

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function startServer(port) {
  child = spawn(process.execPath, ['server.js'], {
    cwd: tmp,
    env: {
      ...process.env,
      PORT: String(port),
      DANJI_HOST: '0.0.0.0',
      DANJI_PAPERS_DIR: papers,
      DANJI_TOKEN: TOKEN,
      DANJI_OPEN_LOG: openLog,
      DANJI_PICK_FILE: pickFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));
}

async function waitUp(origin, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

async function req(method, pathname, body, headers = auth, origin = base) {
  const res = await fetch(origin + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, body: data };
}

const get = (p, h, o) => req('GET', p, undefined, h, o);
const post = (p, b, h, o) => req('POST', p, b, h, o);
const put = (p, b, h, o) => req('PUT', p, b, h, o);
const del = (p, h, o) => req('DELETE', p, undefined, h, o);

function logCalls() {
  if (!fs.existsSync(openLog)) return [];
  return fs.readFileSync(openLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** 本机的非回环 IPv4：用来以「手机端身份」访问（真身份，不改服务端代码） */
function lanIpv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '';
}

try {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  startServer(port);
  if (!await waitUp(base)) {
    console.error('✗ 隔离服务未在超时内就绪');
    process.exitCode = 1;
    throw new Error('server not up');
  }
  console.log(`临时实例：${tmp} 端口 ${port}`);

  /* ---------- 1. 保存路径：只存字符串，文件不被复制 ---------- */
  console.log('\n1. 保存与保留');
  const created = await post('/api/kb', { title: '白皮书要点', content: '要点摘录', tags: ['写作'], file_path: pdfPath });
  ok('带 file_path 的条目能存', created.status === 201 && created.body.file_path === pdfPath, JSON.stringify(created.body));
  const kbId = created.body.id;
  const list = await get('/api/kb');
  const inList = (list.body || []).find((k) => k.id === kbId);
  ok('列表里带回 file_path', !!inList && inList.file_path === pdfPath, JSON.stringify(inList));

  const kbJson = fs.readFileSync(path.join(tmp, 'data', 'kb.json'), 'utf8');
  const kbParsed = JSON.parse(kbJson);
  const savedEntry = (kbParsed.kb || []).find((k) => k.id === kbId);
  ok('落盘的只有路径字符串', !!savedEntry && savedEntry.file_path === pdfPath
    && !kbJson.includes('%PDF-1.4 fixture content'), 'kb.json 里不该出现文件内容');
  const dataFiles = fs.readdirSync(path.join(tmp, 'data'), { withFileTypes: true })
    .filter((d) => d.isFile()).map((d) => d.name);
  ok('data/ 里没有文件副本', !dataFiles.includes('AT&T 白皮书 笔记.pdf'), JSON.stringify(dataFiles));

  /* ---------- 2. 编辑：省略 = 保留；空串 = 解除 ---------- */
  const edited = await put(`/api/kb/${kbId}`, { title: '白皮书要点（改）', content: '要点摘录', tags: ['写作'] });
  ok('编辑时省略 file_path → 原关联保留', edited.status === 200 && edited.body.file_path === pdfPath, JSON.stringify(edited.body));

  const unlinked = await put(`/api/kb/${kbId}`, { title: '白皮书要点（改）', content: '要点摘录', tags: ['写作'], file_path: '' });
  ok('显式空串 → 解除关联', unlinked.status === 200 && unlinked.body.file_path === '', JSON.stringify(unlinked.body));

  const relinked = await put(`/api/kb/${kbId}`, { title: '白皮书要点（改）', content: '要点摘录', tags: ['写作'], file_path: pdfPath });
  ok('重新关联 → 路径写回', relinked.status === 200 && relinked.body.file_path === pdfPath, JSON.stringify(relinked.body));

  const quoted = await put(`/api/kb/${kbId}`, { title: '白皮书要点（改）', content: '要点摘录', tags: ['写作'], file_path: `"${pdfPath}"` });
  ok('粘贴带引号 → 剥掉引号后保存', quoted.status === 200 && quoted.body.file_path === pdfPath, JSON.stringify(quoted.body));

  /* ---------- 3. 路径校验 ---------- */
  console.log('\n2. 路径与格式校验');
  const badPaths = [
    ['相对路径', '资料/笔记.pdf'],
    ['UNC 共享路径', '\\\\server\\share\\笔记.pdf'],
    ['设备路径', '\\\\.\\C:\\笔记.pdf'],
    ['网址', 'http://example.com/a.pdf'],
    ['NTFS 数据流', `${pdfPath}:stream`],
    ['带控制字符', `${pdfPath}\u0001`],
    ['盘符根目录', 'C:\\'],
    ['文件夹路径', fixtureDir + path.sep],
  ];
  for (const [label, bad] of badPaths) {
    const res = await post('/api/kb', { title: '坏路径', content: 'x', file_path: bad });
    ok(`拒绝${label}`, res.status === 400 && !!res.body.error, `${res.status} ${JSON.stringify(res.body)}`);
  }
  const execFiles = ['a.exe', 'a.bat', 'a.cmd', 'a.ps1', 'a.js', 'a.lnk', 'a.vbs', 'a.sh'];
  for (const name of execFiles) {
    const res = await post('/api/kb', { title: '可执行', content: 'x', file_path: `C:\\tmp\\${name}` });
    ok(`拒绝可执行文件 ${name}`, res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);
  }
  const badExt = await post('/api/kb', { title: '未知格式', content: 'x', file_path: 'C:\\tmp\\a.qqq' });
  ok('拒绝未列入白名单的格式', badExt.status === 400 && /不支持|格式/.test(String(badExt.body.error || '')), JSON.stringify(badExt.body));

  // .. 段：Windows 与 POSIX 两条分支都要挡（否则「打开文件」可能指向别处）
  const dotdotPaths = [
    ['Windows 里的 ..', 'C:\\资料\\..\\笔记.pdf'],
    ['Windows 结尾的 ..', 'C:\\资料\\..'],
    ['POSIX 里的 ..', '/home/user/../notes.pdf'],
  ];
  for (const [label, bad] of dotdotPaths) {
    const res = await post('/api/kb', { title: '上级目录', content: 'x', file_path: bad });
    ok(`拒绝${label}`, res.status === 400 && !!res.body.error, `${res.status} ${JSON.stringify(res.body)}`);
  }
  // 文件名里带点不是「上级目录」，别误伤
  const dotted = await post('/api/kb', { title: '带点文件名', content: 'x', file_path: 'C:\\资料\\a..b.pdf' });
  ok('文件名里的 .. 不被误拒', dotted.status === 201, `${dotted.status} ${JSON.stringify(dotted.body)}`);
  if (dotted.status === 201) await del(`/api/kb/${dotted.body.id}`);

  /* ---------- 4. 状态：单独查，不写进记录 ---------- */
  console.log('\n3. 文件状态');
  const st = await get('/api/kb/files/status');
  ok('状态接口返回 id => 状态', st.status === 200 && st.body.statuses && st.body.statuses[kbId] === 'available', JSON.stringify(st.body));
  const again = await get('/api/kb');
  const entryNow = (again.body || []).find((k) => k.id === kbId);
  ok('状态没有写进记录', !('file_status' in (entryNow || {})) && entryNow.file_path === pdfPath, JSON.stringify(entryNow));

  // 把文件挪走 → 状态变 missing，打开报 404
  const movedPath = path.join(fixtureDir, 'moved.pdf');
  fs.renameSync(pdfPath, movedPath);
  const stMissing = await get('/api/kb/files/status?fresh=1');
  ok('文件被移走 → missing', stMissing.body.statuses[kbId] === 'missing', JSON.stringify(stMissing.body));
  const openMissing = await post(`/api/kb/${kbId}/open-file`, {});
  ok('文件不在 → 打开返回 404', openMissing.status === 404 && openMissing.body.code === 'missing_file', JSON.stringify(openMissing.body));
  fs.renameSync(movedPath, pdfPath);
  const stBack = await get('/api/kb/files/status?fresh=1');
  ok('文件放回去 → available', stBack.body.statuses[kbId] === 'available', JSON.stringify(stBack.body));

  /* ---------- 5. 打开文件：参数不经 shell ---------- */
  console.log('\n4. 打开文件');
  fs.writeFileSync(openLog, '');
  const opened = await post(`/api/kb/${kbId}/open-file`, {});
  ok('打开成功', opened.status === 200 && opened.body.ok === true, JSON.stringify(opened.body));
  const spawnCalls = logCalls().filter((c) => c.kind === 'spawn');
  ok('打开通道被调用恰好一次', spawnCalls.length === 1, JSON.stringify(spawnCalls));
  const call = spawnCalls[0] || {};
  ok('走系统默认程序 explorer.exe', call.cmd === 'explorer.exe', JSON.stringify(call));
  const target = Array.isArray(call.args) ? call.args[0] : '';
  ok('参数是完整路径（含 & 空格 中文，不被截断）', target === pdfPath, JSON.stringify(call.args));
  ok('不经 cmd（没有命令注入面）', call.cmd !== 'cmd', JSON.stringify(call));

  const noFile = await post('/api/kb', { title: '没文件', content: 'x' });
  const openNoFile = await post(`/api/kb/${noFile.body.id}/open-file`, {});
  ok('没关联文件的条目 → 400', openNoFile.status === 400 && openNoFile.body.code === 'no_file', JSON.stringify(openNoFile.body));
  const openMissingId = await post('/api/kb/00000000-0000-4000-8000-000000000000/open-file', {});
  ok('不存在的条目 → 404', openMissingId.status === 404, JSON.stringify(openMissingId.body));

  /* ---------- 6. 选文件（桩，不弹真窗口） ---------- */
  console.log('\n5. 选择文件');
  fs.writeFileSync(openLog, '');
  fs.writeFileSync(pickFile, pdfPath);
  const picked = await post('/api/kb/files/pick', {});
  ok('选择成功返回路径', picked.status === 200 && picked.body.ok === true && picked.body.path === pdfPath, JSON.stringify(picked.body));
  const execCalls = logCalls().filter((c) => c.kind === 'exec');
  const psCall = execCalls[execCalls.length - 1] || {};
  ok('用固定的 powershell 脚本（-NoProfile -STA）', psCall.cmd === 'powershell.exe'
    && Array.isArray(psCall.args) && psCall.args.includes('-NoProfile') && psCall.args.includes('-STA'), JSON.stringify(psCall));
  ok('用户路径没有进 PowerShell 代码', !JSON.stringify(psCall.args || []).includes(pdfPath), JSON.stringify(psCall.args));

  fs.writeFileSync(pickFile, '');
  const canceled = await post('/api/kb/files/pick', {});
  ok('用户取消 → 正常空路径（不是错误）', canceled.status === 200 && canceled.body.ok === true && canceled.body.path === '', JSON.stringify(canceled.body));

  fs.writeFileSync(pickFile, 'C:\\tmp\\危险.exe');
  const pickedExec = await post('/api/kb/files/pick', {});
  ok('选到可执行文件 → 拒绝并说清楚', pickedExec.status === 400 && !!pickedExec.body.error, JSON.stringify(pickedExec.body));

  // A user can leave the native dialog open: it must not monopolize JSON reads/writes.
  fs.writeFileSync(pickFile, pdfPath);
  fs.writeFileSync(pickFile + '.delay', '1');
  fs.writeFileSync(openLog, '');
  const pendingPick = post('/api/kb/files/pick', {});
  const pickStartedDeadline = Date.now() + 3000;
  while (!logCalls().some(c => c.kind === 'exec') && Date.now() < pickStartedDeadline) await sleep(10);
  const duringPickAt = Date.now();
  const [duringRead, duringWrite, secondPick] = await Promise.all([
    get('/api/kb'), post('/api/kb', { title: '选择文件期间仍可保存', content: '并发验收' }),
    post('/api/kb/files/pick', {}),
  ]);
  ok('选择窗口等待时其他知识仍能读取和保存', duringRead.status === 200
    && duringWrite.status === 201 && Date.now() - duringPickAt < 1000);
  ok('同时再次选择返回忙碌提示', secondPick.status === 409, JSON.stringify(secondPick));
  const delayedPick = await pendingPick;
  ok('等待中的选择正常结束', delayedPick.status === 200 && delayedPick.body.path === pdfPath);
  fs.unlinkSync(pickFile + '.delay');

  /* ---------- 7. 回收站：删除再恢复，关联不丢 ---------- */
  console.log('\n6. 回收站');
  const trashBefore = await get('/api/trash');
  const delRes = await del(`/api/kb/${kbId}`);
  ok('删除成功', delRes.status === 200, JSON.stringify(delRes.body));
  const trash = await get('/api/trash');
  const trashed = (trash.body.items || []).find((x) => x.id !== (trashBefore.body.items || [])[0]?.id && x.source === 'kb' && x.payload?.id === kbId);
  ok('回收站里有这条', !!trashed, JSON.stringify(trash.body).slice(0, 200));
  const restored = await post(`/api/trash/${trashed.id}/restore`, {});
  ok('恢复成功', restored.status === 200, JSON.stringify(restored.body));
  const afterRestore = await get('/api/kb');
  const back = (afterRestore.body || []).find((k) => k.id === kbId);
  ok('恢复后 file_path 还在', !!back && back.file_path === pdfPath, JSON.stringify(back));

  /* ---------- 8. 兼容与乐观锁 ---------- */
  console.log('\n7. 兼容与乐观锁');
  const plain = await post('/api/kb', { title: '普通知识', content: '没有文件', tags: [] });
  ok('没有文件的条目照常能用', plain.status === 201 && !plain.body.file_path, JSON.stringify(plain.body));
  const conflict = await put(`/api/kb/${plain.body.id}`, { title: 'x', content: 'y', base_updated_at: '2000-01-01T00:00:00.000Z' });
  ok('过期基线 → 409 冲突', conflict.status === 409 && conflict.body.code === 'conflict', JSON.stringify(conflict.body));

  /* ---------- 9. 手机端：不能选文件 / 查状态 / 打开 ---------- */
  console.log('\n8. 手机端拒绝');
  const lanIp = lanIpv4();
  let mobileOrigin = '';
  let mobileHeaders = { ...json };
  if (lanIp) {
    mobileOrigin = `http://${lanIp}:${port}`;
    const reachable = await waitUp(mobileOrigin, 4000);
    if (reachable) {
      mobileHeaders = { ...json, 'X-Danji-Token': TOKEN };
      console.log(`  · 以真实非回环地址 ${lanIp} 模拟手机端`);
    } else {
      mobileOrigin = '';
    }
  }
  if (mobileOrigin) {
    const mStatus = await get('/api/kb/files/status', mobileHeaders, mobileOrigin);
    ok('手机端查状态 → 403', mStatus.status === 403, `${mStatus.status} ${JSON.stringify(mStatus.body)}`);
    const mOpen = await post(`/api/kb/${kbId}/open-file`, {}, mobileHeaders, mobileOrigin);
    ok('手机端打开文件 → 403', mOpen.status === 403, `${mOpen.status} ${JSON.stringify(mOpen.body)}`);
    const mPick = await post('/api/kb/files/pick', {}, mobileHeaders, mobileOrigin);
    ok('手机端选文件 → 403', mPick.status === 403, `${mPick.status} ${JSON.stringify(mPick.body)}`);
    const mNoToken = await get('/api/kb/files/status', json, mobileOrigin);
    ok('手机端不带口令 → 401', mNoToken.status === 401, `${mNoToken.status} ${JSON.stringify(mNoToken.body)}`);
  } else {
    skip('手机端拒绝', '本机没有可达的非回环 IPv4 地址');
  }

  /* ---------- 10. 状态检查不拖慢 health ---------- */
  console.log('\n9. 性能');
  const t0 = Date.now();
  const health = await get('/api/health');
  const healthMs = Date.now() - t0;
  ok('health 正常', health.status === 200 && health.body.ok === true, JSON.stringify(health.body));
  ok('health 很快（状态检查不拖累它）', healthMs < 500, `${healthMs}ms`);
  const t1 = Date.now();
  await get('/api/kb/files/status?fresh=1');
  const statusMs = Date.now() - t1;
  ok('状态检查在预算内返回', statusMs < 6000, `${statusMs}ms`);

  /* ---------- 11. 路由顺序自检 ---------- */
  console.log('\n10. 路由顺序自检');
  const serverText = fs.readFileSync(serverFile, 'utf8');
  ok('server.js 里有路由顺序自检函数', serverText.includes('function assertRouteOrder()'), '找不到 assertRouteOrder');
  ok('自检在启动时执行', /assertRouteOrder\(\);/.test(serverText), 'assertRouteOrder() 没有被调用');
  // 真正的路由归属：pick 必须被 pick 路由接住，不能落到 /api/kb/:id 上
  const pickRoute = await post('/api/kb/files/pick', {}, json);
  ok('pick 命中的是文件选择路由（不是 /api/kb/:id）', pickRoute.status !== 404, `${pickRoute.status} ${JSON.stringify(pickRoute.body)}`);
  ok('pick 返回的是选择语义（ok/busy/错误码），不是知识条目的字段',
    pickRoute.status === 409 || pickRoute.body.ok === true || !!pickRoute.body.error,
    JSON.stringify(pickRoute.body));
  // 状态路由同理：不能被当成 id 查知识
  const statusRoute = await get('/api/kb/files/status');
  ok('status 命中的是状态路由（返回 statuses 而不是单条知识）',
    statusRoute.status === 200 && !!statusRoute.body.statuses && statusRoute.body.title === undefined,
    JSON.stringify(statusRoute.body).slice(0, 200));
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
  console.error('\n✗ 知识库关联文件回归失败');
} else {
  console.log(`\n✓ 知识库关联文件回归全部通过（${passed} 项${skipped ? `，跳过 ${skipped} 项` : ''}）`);
}
