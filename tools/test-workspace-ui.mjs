/** 工作台的真实浏览器验收。独立临时服务、文献库和浏览器配置，不接触个人数据。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserCandidates = [process.env.EDGE_PATH, process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
  .filter(Boolean).map((location, index) => process.env.EDGE_PATH && index === 0 ? location : path.join(location, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
let browserPath;
for (const candidate of browserCandidates) { try { await fs.access(candidate); browserPath = candidate; break; } catch { /* 下一个安装目录 */ } }
assert.ok(browserPath, '需要本机 Edge，或用 EDGE_PATH 指定浏览器路径');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'danji-workspace-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function eventually(test, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await test(); if (value) return value; } catch { /* 启动或渲染尚未完成 */ }
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}
let server, browser, ws;
try {
  await fs.copyFile(path.join(root, 'server.js'), path.join(tmp, 'server.js'));
  await fs.cp(path.join(root, 'lib'), path.join(tmp, 'lib'), { recursive: true });
  await fs.cp(path.join(root, 'public'), path.join(tmp, 'public'), { recursive: true });
  const port = await freePort(), debugPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(tmp, 'server.js')], {
    cwd: tmp, windowsHide: true,
    env: { ...process.env, PORT: String(port), DANJI_HOST: '127.0.0.1', DANJI_TOKEN: '', DANJI_PAPERS_DIR: path.join(tmp, 'test-papers') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stderr.on('data', chunk => { serverLog += chunk; });
  await eventually(async () => { if (server.exitCode !== null) throw new Error(serverLog); return (await fetch(base + '/api/health')).ok; }, 'isolated server');
  const fixtureTitles = ['从一个小问题开始，记下今天的研究灵感', '把阅读变成自己的知识', '周末，留一点时间给生活', '下一步的产品改进清单'];
  for (const [i, title] of fixtureTitles.entries()) {
    const res = await fetch(base + '/api/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content: i === 0 ? '今天读到一个有趣的方法：先把问题拆小，再逐个验证。\n\n可以把这份思考带到下一次讨论里。\n' + '这是一段用于检查展开、长内容和阅读体验的演示文字。'.repeat(10) : '记下那些值得停留的瞬间。\n让灵感有处可去，让日常有迹可循。', images: [] }) });
    assert.ok(res.ok, 'create isolated fixture');
    if (i === 0) {
      const idea = await res.json();
      const pinned = await fetch(base + '/api/ideas/' + idea.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...idea, pinned: true }) });
      assert.ok(pinned.ok);
    }
  }
  const longTitle = '这是一条用于确认长标题完整显示与小屏阅读的演示记录：' + '理解、思考与实践，'.repeat(5);
  const fixtures = {
    papers: { title: longTitle, category: '方法研究', status: 'to_read', notes: '从问题出发，先记录值得回看的方法，再整理阅读笔记。' },
    sites: { title: longTitle, url: 'https://example.com/' + 'long-url-path'.repeat(20), status: 'to_read', kind: 'tech', tags: ['研究工具', '待读'] },
    expenses: { title: '学习工具订阅（演示）', amount: 128.5, date: new Date().toISOString().slice(0, 10), category: 'subscription', notes: '这是临时服务中的演示数据，用于检查金额和统计图。' },
    achievements: { title: longTitle, category: 'project', status: 'done', date: '2026-10', content: '完成了一个值得记录的项目。', highlight: '让学习的过程，也成为自己的收获。', tags: ['个人项目'], links: ['https://example.com/'] },
    kb: { title: '先理解问题，再选择方法', content: '一条可复用的知识。\n' + '通过分解问题，建立自己的理解框架。'.repeat(15), tags: ['研究方法', '知识积累'], source: { type: 'manual' } },
    activities: { title: longTitle, platform: '示例平台', type: 'credit', status: 'pending', value: '免费体验', claim_deadline: new Date(Date.now() + 36 * 3600000).toISOString(), notes: '用于检查到期横幅与卡片展开。', tags: ['学习'] },
  };
  for (const [collection, fixture] of Object.entries(fixtures)) {
    const result = await fetch(base + '/api/' + collection, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fixture) });
    assert.ok(result.ok, 'fixture ' + collection + ': ' + await result.text());
  }
  browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(tmp, 'browser-profile')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const target = await eventually(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(t => t.type === 'page'), 'headless browser');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map(), errors = [];
  ws.addEventListener('message', e => {
    const message = JSON.parse(e.data);
    if (message.id) {
      const callback = pending.get(message.id);
      if (callback) { pending.delete(message.id); message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result); }
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(a => a.value || a.description).join(' '));
  });
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout ' + method)); }, 15000);
      pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  await cdp('Runtime.enable');
  async function viewport(width, height, mobile = false) { await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); }
  async function navigate(board = 'ideas', theme = 'light', forceMobile = false) {
    await cdp('Page.navigate', { url: `${base}/?board=${board}&theme=${theme}${forceMobile ? '&danji-mobile=1' : ''}` });
    await eventually(() => evaluate(`!!document.querySelector('#app:not([v-cloak]) .container') && document.querySelector('.workspace').dataset.board === '${board}' && !document.querySelector('.empty')?.textContent.includes('加载中')`), 'render ' + board);
    await pause(150);
  }
  async function checkLayout(label) {
    const result = await evaluate(`({ overflow: document.documentElement.scrollWidth > innerWidth + 1, title: document.querySelector('#board-title').textContent, nav: document.querySelectorAll('.mobile-nav button').length })`);
    assert.equal(result.overflow, false, label + ': horizontal overflow');
    assert.ok(result.title, label + ': title');
    console.log('✓ ' + label);
  }
  async function screenshot(name) {
    if (!process.env.DANJI_UI_SCREENSHOTS) return;
    await pause(300); // 等待抽屉入场动画完成，截图与用户看到的稳定画面一致。
    const output = path.join(root, 'output', 'ui-preview');
    await fs.mkdir(output, { recursive: true });
    const capture = await cdp('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(output, name + '.png'), Buffer.from(capture.data, 'base64'));
  }
  await viewport(1440, 1050);
  await navigate();
  assert.equal(await evaluate(`document.querySelectorAll('.idea-card').length`), 4);
  // M20 任务 E：双列瀑布流（不再是等宽 CSS Grid）。断言列数与「两列高度不同」
  // ——后者正是 masonry 相对 grid 的核心收益：矮卡下方不再留整行空白。
  assert.equal(await evaluate(`document.querySelectorAll('.egg-list.masonry .masonry-col').length`), 2, 'desktop masonry renders 2 columns');
  const colFill = await evaluate(`[...document.querySelectorAll('.egg-list.masonry .masonry-col')].map(c => c.children.length)`);
  assert.ok(colFill.reduce((a, b) => a + b, 0) === 4, 'all 4 cards distributed: ' + JSON.stringify(colFill));
  assert.notDeepEqual(colFill[0], colFill[1], 'masonry balances uneven cards across columns: ' + JSON.stringify(colFill));
  console.log('✓ masonry distributes cards into two balanced columns');
  await checkLayout('desktop card layout');
  await screenshot('desktop-notes');
  await evaluate(`document.querySelector('.layout-switch button:last-child').click()`);
  await pause(100);
  // 列表布局：单列纵向排布，且 4 张卡全在唯一一列里（分列不生效）
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.egg-list')).display`), 'flex');
  assert.equal(await evaluate(`document.querySelectorAll('.egg-list.masonry .masonry-col').length`), 1, 'list layout stays single column');
  await evaluate(`document.querySelector('.layout-switch button:first-child').click()`);
  await evaluate(`const search = document.querySelector('.search'); search.value = '研究灵感'; search.dispatchEvent(new Event('input', { bubbles: true }))`);
  await eventually(() => evaluate(`document.querySelectorAll('.idea-card').length === 1`), 'search results after leave animation');
  await evaluate(`document.querySelector('.clear-search').click()`);
  await eventually(() => evaluate(`document.querySelectorAll('.idea-card').length === 4`), 'clear search');
  await evaluate(`document.querySelector('.create-button').click()`);
  await eventually(() => evaluate(`!!document.querySelector('.drawer input')`), 'idea editor');
  assert.equal(await evaluate(`document.querySelector('.drawer').getAttribute('aria-modal')`), 'true');
  assert.equal(await evaluate(`getComputedStyle(document.body).overflow`), 'hidden');
  await evaluate(`const form = document.querySelector('.drawer-form'); const input = form.querySelector('input'); input.value = '浏览器验收：保存随记'; input.dispatchEvent(new Event('input', { bubbles: true })); const textarea = form.querySelector('textarea'); textarea.value = '这条文字只写入临时隔离服务。'; textarea.dispatchEvent(new Event('input', { bubbles: true }))`);
  await screenshot('desktop-editor');
  await evaluate(`const last = document.querySelector('.drawer button[type="submit"]'); last.focus(); last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))`);
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.drawer button')`), true, 'focus cycles within dialog');
  await evaluate(`document.querySelector('.drawer input').focus(); for (let i = 0; i < 2; i++) document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await eventually(() => evaluate(`!document.querySelector('.drawer') && [...document.querySelectorAll('.idea-card')].some(card => card.textContent.includes('浏览器验收'))`), 'keyboard save');
  assert.notEqual(await evaluate(`getComputedStyle(document.body).overflow`), 'hidden');
  assert.equal((await (await fetch(base + '/api/ideas')).json()).length, 5, 'rapid save does not duplicate record');
  console.log('✓ search, layout toggle, dialog focus, Ctrl+Enter save');
  for (const board of ['eggs', 'papers', 'sites', 'expenses', 'achievements', 'kb', 'messages']) {
    await navigate(board);
    await checkLayout('desktop ' + board);
    if (board !== 'messages') {
      await evaluate(`document.querySelector('.create-button').click()`);
      await eventually(() => evaluate(`!!document.querySelector('.drawer[role="dialog"]')`), board + ' editor');
      await checkLayout('desktop ' + board + ' editor');
    }
  }
  await viewport(390, 844, true);
  await navigate('ideas');
  await checkLayout('phone 390px');
  assert.notEqual(await evaluate(`getComputedStyle(document.querySelector('.mobile-nav')).display`), 'none');
  await screenshot('phone-notes');
  await evaluate(`document.querySelector('.mobile-nav button:last-child').click()`);
  await eventually(() => evaluate(`!!document.querySelector('.more-panel')`), 'more navigation');
  await screenshot('phone-more');
  await evaluate(`document.querySelector('.more-grid button').click()`);
  await eventually(() => evaluate(`document.querySelector('.workspace').dataset.board === 'eggs' && !document.querySelector('.more-panel')`), 'more board change');
  assert.equal(await evaluate(`document.querySelector('.mobile-nav button:last-child').classList.contains('active')`), true);
  for (const width of [320, 640, 760, 768, 1024]) {
    await viewport(width, 844, width < 768);
    for (const board of ['ideas', 'eggs', 'papers', 'sites', 'expenses', 'achievements', 'kb']) {
      await navigate(board);
      await checkLayout(width + 'px ' + board);
    }
  }
  await viewport(390, 844, true);
  await navigate('ideas', 'dark');
  assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'light', 'dark query must stay light');
  await screenshot('phone-light');
  await evaluate(`document.querySelector('.create-button').click()`);
  await eventually(() => evaluate(`!!document.querySelector('.drawer')`), 'phone editor');
  await screenshot('phone-editor');
  await checkLayout('phone light editor');
  const footer = await evaluate(`(() => { const r = document.querySelector('.drawer-foot').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()`);
  assert.ok(footer.top >= 0 && footer.bottom <= 845, 'phone save footer visible');
  await navigate('ideas', 'light', true);
  assert.ok(await evaluate(`!!document.querySelector('[data-testid="sync-status"]')`), 'mobile sync capsule');
  console.log('✓ mobile sync capsule retained');
  await screenshot('phone-sync');
  await evaluate(`(async () => { const { state } = await import('/js/state.js'); state.role = 'mobile'; state.sync.role = 'mobile'; })()`);
  await pause(100);
  assert.ok(await evaluate(`!!document.querySelector('.create-button')`), 'mobile can write notes');
  // M20 任务 B：手机端视角隐藏「文献」「网页」入口 —— 手机底部导航只剩 随记 / 知识库 / 更多
  const phoneNav = await evaluate(`[...document.querySelectorAll('.mobile-nav button')].map(b => b.textContent.trim())`);
  assert.ok(!phoneNav.some(t => t.includes('文献')), 'mobile nav hides 文献: ' + JSON.stringify(phoneNav));
  assert.ok(!phoneNav.some(t => t.includes('网页')), 'mobile nav hides 网页: ' + JSON.stringify(phoneNav));
  await evaluate(`document.querySelector('.mobile-nav button:last-child').click()`);
  await eventually(() => evaluate(`!!document.querySelector('.more-panel')`), 'mobile more panel');
  const moreLabels = await evaluate(`[...document.querySelectorAll('.more-grid button strong')].map(e => e.textContent.trim())`);
  assert.ok(!moreLabels.includes('文献') && !moreLabels.includes('网页'), 'more panel hides papers/sites: ' + JSON.stringify(moreLabels));
  await evaluate(`document.querySelector('.more-panel .btn.ghost').click()`);
  await pause(100);
  console.log('✓ mobile nav and more panel hide 文献/网页');
  // 旧版本 localStorage 停在 papers 时，手机端冷启动兜底送回随记
  await navigate('ideas', 'light', true);
  await evaluate(`(async () => { const { state } = await import('/js/state.js'); state.role = 'mobile'; state.sync.role = 'mobile'; localStorage.setItem('danji.board', 'papers'); })()`);
  await cdp('Page.navigate', { url: `${base}/?theme=light&danji-mobile=1` });
  await eventually(() => evaluate(`!!document.querySelector('#app:not([v-cloak]) .container')`), 'mobile stale-board reload');
  await pause(300);
  assert.equal(await evaluate(`document.querySelector('.workspace').dataset.board`), 'ideas', 'mobile lands on ideas when stale board was papers');
  console.log('✓ mobile stale board papers falls back to ideas');
  await cdp('Network.enable');
  await cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await evaluate(`(async () => { const { state } = await import('/js/state.js'); state.sync.offline = true; state.sync.status = 'offline'; })()`);
  await evaluate(`document.querySelector('.create-button').click()`);
  await eventually(() => evaluate(`!!document.querySelector('.drawer input')`), 'offline editor');
  await evaluate(`const input = document.querySelector('.drawer input'); input.value = '离线随记验收'; input.dispatchEvent(new Event('input', { bubbles: true }))`);
  await evaluate(`document.querySelector('.drawer button[type="submit"]').click()`);
  await eventually(() => evaluate(`!document.querySelector('.drawer') && [...document.querySelectorAll('.idea-card')].some(card => card.textContent.includes('离线随记验收'))`), 'offline local save');
  assert.equal((await (await fetch(base + '/api/ideas')).json()).length, 5, 'offline note stays in local queue');
  console.log('✓ offline mobile note saves locally');
  await cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log('\n✓ 工作台浏览器验收通过（全部写入均在隔离实例）');
} finally {
  ws?.close();
  for (const child of [browser, server]) {
    if (child && child.exitCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill();
      await closed;
    }
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}
