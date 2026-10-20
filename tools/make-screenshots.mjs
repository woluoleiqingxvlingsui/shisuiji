/**
 * 拾穗集 —— README 配图生成
 *
 * 独立临时服务 + 独立浏览器配置 + 独立数据目录：真实的 data/ 与文献库一律不碰
 * （AGENTS.md 红线 1、2）。赛博鸡蛋的示例数据走页面上的「填入示例数据看看效果」，
 * 截图内容与用户第一次打开看到的一致。
 *
 * 用法：node tools/make-screenshots.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'assets', 'screenshots');
const WIDTH = 1280;
const HEIGHT = 720;

const browserCandidates = [
  process.env.EDGE_PATH,
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
].filter(Boolean);
let browserPath;
for (const candidate of browserCandidates) {
  try { await fs.access(candidate); browserPath = candidate; break; } catch { /* 下一个安装目录 */ }
}
if (!browserPath) {
  console.error('✗ 未找到 Edge，可用 EDGE_PATH 指定浏览器路径');
  process.exit(1);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
async function eventually(test, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await test(); if (value) return value; } catch { /* 渲染尚未完成 */ }
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}

// 演示数据：金额、厂商、日期都是示例（AGENTS.md 红线 5），不要写成真实花销
const today = new Date();
const thisMonth = (back) => {
  const day = Math.max(1, today.getDate() - back);
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const EXPENSES = [
  { title: 'DeepSeek API 充值', amount: 71.81, back: 2, category: 'api', notes: '写代码时用主力模型，量比上月多一点。' },
  { title: '豆包 Pro 套餐', amount: 69, back: 5, category: 'plan', notes: '团队共用，折合下来人均不贵。' },
  { title: 'Kimi 会员月费', amount: 49, back: 8, category: 'plan', notes: '长文档阅读体验不错。' },
  { title: '机场订阅（梯子）', amount: 18, back: 11, category: 'ladder', notes: '按月付，随时能停。' },
  { title: '通用 API 额度包', amount: 30, back: 14, category: 'plan', notes: '偶尔跑批处理用。' },
  { title: '算力租用', amount: 35.2, back: 17, category: 'compute', notes: '周末跑了一次实验。' },
  { title: '智谱 API 调用', amount: 25.5, back: 20, category: 'api', notes: '日常问答与摘要。' },
];

const IDEAS = [
  { title: '周五组会：把「问题拆小」这条讲清楚', content: '准备三个真实例子：一次是论文里的方法拆解，一次是自己写代码时定位到的卡点，一次是读文献时看不懂的段落。\n\n下次记得提前把例子贴进文档，别现场想。', pinned: true, back: 0 },
  { title: '读《Designing Data-Intensive Applications》第三章', content: '副本与一致性那一节值得慢读。整理三个问题：\n\n1. 什么时候能接受最终一致？\n2. 冲突合并的策略分别适合什么场景？\n3. 幂等写为什么能省掉很多麻烦？', pinned: false, back: 1 },
  { title: '今天的小发现：把任务写成一句话，模糊的地方会自己暴露出来', content: '「优化一下模型」这种说法看不出边界；写成「让这段推理在三秒内返回，且不丢关键步骤」，立刻就知道要测什么。', pinned: false, back: 3 },
  { title: '下周要买的书', content: '《思考，快与慢》——解决推理的小书，买之前先看看二手价。', pinned: false, back: 5 },
];

const KB = [
  { title: '先理解问题，再选择方法', content: '方法不是拿来套的。\n\n拿到一个陌生问题，先花二十分钟把「我到底想知道什么」写下来：谁需要它、用来做什么决定、失败了会怎样。很多时候写到这一步，问题就已经变小了。', tags: ['研究方法', '知识积累'], back: 0 },
  { title: '把大问题拆成可验证的小问题', content: '大问题的进展感来自小问题的回答。\n\n拆分的标准是「能查证」：拆完的每个小问题，都能用一次检索或一次实验给出是/否的答案。', tags: ['研究方法', '问题拆解'], back: 2 },
  { title: '好文献的三个特征', content: '一、问题界定得清楚——读完能一句话说出它要解决什么。\n二、方法与问题匹配——不会为了炫技上重方法。\n三、边界写得到位——作者自己说清在什么条件下不成立，这比结论本身更值钱。', tags: ['阅读笔记', '文献筛选'], back: 4 },
];

let server, browser, ws;
try {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'danji-shots-'));
  await fs.copyFile(path.join(root, 'server.js'), path.join(tmp, 'server.js'));
  await fs.cp(path.join(root, 'lib'), path.join(tmp, 'lib'), { recursive: true });
  await fs.cp(path.join(root, 'public'), path.join(tmp, 'public'), { recursive: true });
  const port = await freePort();
  const debugPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(tmp, 'server.js')], {
    cwd: tmp,
    windowsHide: true,
    env: { ...process.env, PORT: String(port), DANJI_HOST: '127.0.0.1', DANJI_TOKEN: '', DANJI_PAPERS_DIR: path.join(tmp, 'papers') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stderr.on('data', (chunk) => { serverLog += chunk; });
  await eventually(async () => {
    if (server.exitCode !== null) throw new Error(serverLog);
    return (await fetch(base + '/api/health')).ok;
  }, 'isolated server');
  console.log('· 临时服务已就绪：' + base);

  const post = async (api, body) => {
    const res = await fetch(base + api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(api + ' 写入失败：' + res.status + ' ' + await res.text());
    return res.json();
  };
  for (const item of EXPENSES) {
    const { back, ...payload } = item;
    await post('/api/expenses', { ...payload, date: thisMonth(back) });
  }
  for (const item of IDEAS) {
    const { back, ...payload } = item;
    await post('/api/ideas', { ...payload, images: [] });
  }
  for (const item of KB) {
    const { back, ...payload } = item;
    await post('/api/kb', { ...payload, source: { type: 'manual' } });
  }
  console.log('· 示例数据已写入临时实例');

  browser = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--hide-scrollbars',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(tmp, 'browser-profile')}`,
    'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await eventually(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === 'page'), 'headless browser');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result);
  });
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout ' + method)); }, 20000);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

  async function navigate(board) {
    await cdp('Page.navigate', { url: `${base}/?board=${board}&theme=light` });
    await eventually(() => evaluate(`!!document.querySelector('#app:not([v-cloak]) .container') && document.querySelector('.workspace')?.dataset.board === '${board}'`), 'render ' + board);
    await pause(200);
  }
  async function waitCards(selector, count) {
    await eventually(() => evaluate(`document.querySelectorAll('${selector}').length >= ${count}`), `${selector} >= ${count}`);
    await pause(250);
  }
  // 提示条会盖住界面，等它自己消失再截
  async function waitToastGone() {
    await eventually(() => evaluate(`!document.querySelector('.toast')`), 'toast 消失');
    await pause(200);
  }
  async function capture(name) {
    await waitToastGone();
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    await fs.mkdir(OUT, { recursive: true });
    const file = path.join(OUT, name + '.png');
    await fs.writeFile(file, Buffer.from(shot.data, 'base64'));
    const { size } = await fs.stat(file);
    console.log('  ✓ ' + path.relative(root, file) + '（' + Math.round(size / 1024) + ' KB）');
  }

  // 赛博鸡蛋：走页面上的「填入示例数据看看效果」，与用户第一次打开看到的一致
  await navigate('eggs');
  await evaluate(`[...document.querySelectorAll('.empty-actions button')].find(b => b.textContent.includes('示例数据')).click()`);
  await waitCards('.egg-list .card', 4);
  await capture('eggs');

  // 记蛋抽屉
  await evaluate(`document.querySelector('.create-button').click()`);
  await eventually(() => evaluate(`!!document.querySelector('.drawer[role="dialog"]')`), '记蛋抽屉');
  await pause(500); // 等抽屉入场动画走完
  await capture('editor');
  await evaluate(`document.querySelector('.drawer-head .btn.ghost').click()`);
  await eventually(() => evaluate(`!document.querySelector('.drawer')`), '关闭抽屉');

  await navigate('expenses');
  await waitCards('.expense-card', EXPENSES.length);
  await capture('expenses');

  await navigate('ideas');
  await waitCards('.idea-card', IDEAS.length);
  await capture('ideas');

  await navigate('kb');
  await waitCards('.kb-card', KB.length);
  await capture('kb');

  console.log('\n✓ README 配图已更新到 ' + path.relative(root, OUT));
} catch (err) {
  console.error('✗ ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
} finally {
  try { if (ws) ws.close(); } catch { /* ignore */ }
  try { if (browser) browser.kill(); } catch { /* ignore */ }
  try { if (server) server.kill(); } catch { /* ignore */ }
}
