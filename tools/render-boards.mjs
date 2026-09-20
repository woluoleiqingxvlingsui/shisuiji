/**
 * 拾穗集 —— 六板块无头渲染回归
 * 启动临时服务 → Edge headless dump-dom → 检查每个板块主容器与关键节点。
 * 用法：node tools/render-boards.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DANJI_RENDER_PORT || 8765);
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = Number(process.env.DANJI_RENDER_TIMEOUT || 20000);

const BOARDS = [
  { id: 'ideas', name: '想法', markers: ['想法', '记想法'] },
  { id: 'eggs', name: '赛博鸡蛋', markers: ['赛博鸡蛋', '记蛋'] },
  { id: 'papers', name: '文献', markers: ['文献', '记论文'] },
  { id: 'sites', name: '网页', markers: ['网页', '记网页'] },
  { id: 'expenses', name: '花销', markers: ['花销', '记一笔'] },
  { id: 'messages', name: '消息', markers: ['msg-summary'] },
];

function findBrowser() {
  const candidates = [
    process.env.EDGE_PATH,
    process.env.CHROME_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft\\Edge\\Application\\msedge.exe'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  // PATH 上的 msedge / chrome
  return null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitHealth(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function dumpDom(browser, url) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `--virtual-time-budget=10000`,
    '--dump-dom',
    url,
  ];
  const res = await run(browser, args, { timeout: TIMEOUT_MS });
  return res.stdout || '';
}

function checkDom(id, html, markers) {
  const problems = [];
  if (!html || html.length < 200) problems.push('DOM 过短，页面可能未渲染');
  if (!html.includes('id="app"') && !html.includes("id='app'")) problems.push('缺少 #app');
  if (html.includes('v-cloak') && !html.includes('class="topbar"') && !html.includes('class="container"')) {
    // v-cloak 属性可能残留，但至少要有 topbar
  }
  if (!html.includes('topbar') && !html.includes('🧺')) problems.push('顶栏未渲染');
  // 板块主区：Vue 挂载后当前板块有 main.container 或 empty
  const hasMain = html.includes('class="container"') || html.includes('class="empty"') || html.includes('egg-list') || html.includes('msg-');
  if (!hasMain) problems.push('未找到板块主容器 container/empty');
  for (const m of markers) {
    if (!html.includes(m)) problems.push(`缺少标记「${m}」`);
  }
  // 桌面端不应出现同步胶囊（P6：电脑端不走同步层）
  if (html.includes('data-testid="sync-status"') && !url.includes('danji-mobile=1')) {
    problems.push('桌面端不应渲染同步胶囊');
  }
  return problems;
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('✗ 未找到 Edge/Chrome，可设置 EDGE_PATH 环境变量');
    process.exit(1);
  }
  console.log(`browser: ${browser}`);
  console.log(`server:  ${BASE} (port ${PORT})`);

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DANJI_HOST: '127.0.0.1' },
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString('utf8'); });
  server.stderr.on('data', (d) => { serverLog += d.toString('utf8'); });

  const health = await waitHealth(15000);
  if (!health) {
    console.error('✗ 服务未在超时内就绪');
    console.error(serverLog.slice(-800));
    server.kill();
    process.exit(1);
  }
  console.log(`health: role=${health.role} needToken=${health.needToken}`);

  let failed = 0;
  try {
    for (const board of BOARDS) {
      const url = `${BASE}/?board=${board.id}&theme=light`;
      const html = await dumpDom(browser, url);
      const problems = checkDom(board.id, html, board.markers);
      if (problems.length) {
        failed += 1;
        console.error(`  ✗ ${board.id} (${board.name})`);
        for (const p of problems) console.error(`      - ${p}`);
        const snippet = html.replace(/\s+/g, ' ').slice(0, 240);
        console.error(`      DOM: ${snippet}`);
      } else {
        console.log(`  ✓ ${board.id} (${board.name})`);
      }
    }

    // 手机端强制模式必须渲染同步胶囊（服务端本机仍是 desktop 权限）
    const mobileUrl = `${BASE}/?board=ideas&danji-mobile=1&theme=light`;
    const mobileHtml = await dumpDom(browser, mobileUrl);
    if (mobileHtml.includes('data-testid="sync-status"') || mobileHtml.includes('sync-pill-btn')) {
      console.log('  ✓ mobile-force (danji-mobile=1) 渲染同步胶囊');
    } else {
      failed += 1;
      console.error('  ✗ mobile-force 未渲染同步胶囊 data-testid=sync-status');
      console.error(`      DOM: ${mobileHtml.replace(/\s+/g, ' ').slice(0, 240)}`);
    }
  } finally {
    server.kill();
  }

  if (failed) {
    console.error(`\n✗ 六板块无头渲染回归：${failed} 项失败`);
    process.exit(1);
  }
  console.log('\n✓ 六板块无头渲染回归全部通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
