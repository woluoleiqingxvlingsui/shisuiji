/**
 * 拾穗集 shisuiji —— 后端服务
 * 仅用 Node 标准库，无任何 npm 依赖。
 * 职责：1) 托管 public/ 静态前端  2) 提供 /api 数据接口
 *       3) 读写 data/eggs.json（赛博鸡蛋）与 data/papers.json（文献）
 *       4) 文献板块：管理磁盘论文库（待读/已读归档、文件匹配、打开阅读）
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');

// 共用配置：根目录 config.json（port/host）。优先级：环境变量 > config.json > 内置默认。
// lib.ps1 读同一份文件，保证图形控制台与服务端端口一致。
function validPort(n) {
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}
function loadAppConfig() {
  try {
    // 容忍 Windows 记事本/PowerShell 写入的 UTF-8 BOM
    const raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    const sync = parsed.sync || {};
    return {
      port: validPort(Number(parsed.port)) || 8642,
      host: String(parsed.host || '127.0.0.1').trim() || '127.0.0.1',
      // 手机端访问口令。不配 = 不校验（和以前一样，只靠监听地址保护）；
      // 配了之后局域网设备每次请求要带 X-Danji-Token，本机回环永远免口令
      token: readToken(sync) || readToken(process.env),
      // 论文库根目录（可选）。不配则回落到项目目录 papers\
      papersDir: String(parsed.papers_dir || '').trim(),
    };
  } catch {
    return { port: 8642, host: '127.0.0.1', token: readToken(process.env), papersDir: '' };
  }
}

function readToken(source) {
  return String((source && (source.token || source.DANJI_TOKEN)) || '').trim();
}
const APP_CONFIG = loadAppConfig();
const PORT = validPort(Number(process.env.PORT)) || APP_CONFIG.port;
// 只监听本机回环：局域网/外网不可达（API 无鉴权，不能暴露给同网段）。
// 确需局域网访问时显式设 DANJI_HOST=0.0.0.0（或改 config.json 的 host）
const HOST = process.env.DANJI_HOST || APP_CONFIG.host;
const DATA_FILE = path.join(DATA_DIR, 'eggs.json');
const PAPERS_FILE = path.join(DATA_DIR, 'papers.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const SITES_FILE = path.join(DATA_DIR, 'sites.json');
const EXPENSES_FILE = path.join(DATA_DIR, 'expenses.json');
const IDEAS_FILE = path.join(DATA_DIR, 'ideas.json');
const MAX_BODY = 2 * 1024 * 1024; // 请求体上限 2MB，防止误传大文件

// 论文库根目录：下载的论文直接丢进来
// 优先级：环境变量 DANJI_PAPERS_DIR > config.json 的 papers_dir > 项目目录 papers\
const PAPERS_DIR = process.env.DANJI_PAPERS_DIR
  || APP_CONFIG.papersDir
  || path.join(ROOT, 'papers');

const SCHEMA_VERSION = 1;
const STATUSES = ['pending', 'claimed', 'used', 'expired', 'closed'];
// 老数据里的状态名 → 现在的名字，遇到就顺手升级，别把它当非法值打回 pending
const LEGACY_STATUS = { missed: 'closed' };
const ACTIVITY_FIELDS = [
  'platform', 'title', 'type', 'value',
  'claim_deadline', 'valid_until', 'claim_steps', 'link',
  'status', 'tags', 'notes',
];

const PAPER_STATUSES = ['to_read', 'read'];
const PAPER_STATUS_DIRS = { to_read: '待读', read: '已读' };
const PAPER_FIELDS = ['title', 'file_name', 'category', 'status', 'reader', 'notes', 'link'];
// 阅读记录：一篇论文可以记多条（阅读日志），存在 paper.logs 数组里
const PAPER_LOG_FIELDS = [
  'read_at', 'problem', 'method', 'finding', 'rel',
  'usable', 'quotable', 'next', 'limits', 'impression', 'excerpt',
];
const PAPER_LOG_LIST_FIELDS = ['parts'];

// 网页板块：待读/已读的网页链接（没有磁盘文件，只存链接与笔记）
const SITE_STATUSES = ['to_read', 'read'];
const SITE_KINDS = ['tech', 'misc'];
const SITE_USAGES = ['now', 'later', 'wide'];
const SITE_FIELDS = ['title', 'url', 'domain', 'kind', 'status', 'notes'];
// 网页笔记：一个网页可以记多条（重读再记）；字段按类型分两套，共用核心那几个
const SITE_NOTE_FIELDS = [
  'kind', 'read_at', 'usage',
  'gist', 'method', 'finding', 'refs', 'limits',
  'facts', 'use_when', 'credibility',
  'excerpt', 'next',
];

// 花销板块：按条目记账，金额单独按数字处理；category 只用于归纳展示
const EXPENSE_FIELDS = ['title', 'date', 'notes', 'category'];
const EXPENSE_CATEGORIES = ['plan', 'api', 'compute'];
// 自动归类关键词（与 public/config.js 的 expenses.categories 同步）；套餐优先，所以 token 包算套餐
const EXPENSE_PLAN_KEYWORDS = ['套餐', '会员', '订阅', '包月', '年费', '额度', 'token', '资源包', 'pro', 'plus'];
const EXPENSE_API_KEYWORDS = ['api', '接口', '调用'];
const EXPENSE_COMPUTE_KEYWORDS = ['算力', '租用', 'autodl', 'gpu'];

// 花销体感评价：只存用户敲定的结论（主体识别与摘录凝练在 config.js + 前端做），按 subject 唯一
// decision 是「后续打算」：continue 继续 / reduce 减少 / hold 观望 / stop 停掉
const INSIGHTS_FILE = path.join(DATA_DIR, 'insights.json');
const INSIGHT_DECISIONS = ['continue', 'reduce', 'hold', 'stop'];

// 消息中心：目前有「已过期」（过了使用截止）与「已截止」（过了领取截止）两个来源
const MESSAGE_FIELDS = ['activity_id', 'platform', 'title', 'body', 'valid_until', 'claim_deadline'];

// 想法板块：一行点题 + 一段灵感，手机端唯一能写的板块
const IDEA_FIELDS = ['title', 'content'];
// origin 记这条是从哪儿来的：手机写的只有手机能改，电脑全能
const IDEA_ORIGINS = ['desktop', 'mobile'];

// ---------- 数据层 ----------
let db = null;

function defaultData() {
  return { schema_version: SCHEMA_VERSION, activities: [] };
}

// 字段升级钩子：以后数据结构变更时，在这里按 schema_version 逐级迁移
function migrate(data) {
  return data;
}

async function loadData() {
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    db = migrate(JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    db = defaultData();
    await saveData();
  }
}

// 原子写入：先写临时文件再改名，避免写一半损坏数据
async function saveData() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await fsp.rename(tmp, DATA_FILE);
}

// ---------- 数据校验与清洗 ----------
function newId() {
  return crypto.randomUUID();
}

function normalizeActivity(input, existing = {}) {
  const activity = { ...existing };
  for (const field of ACTIVITY_FIELDS) {
    if (!(field in input)) continue;
    let value = input[field];
    if (field === 'tags') {
      value = Array.isArray(value)
        ? value.map((t) => String(t).trim()).filter(Boolean)
        : [];
    } else if (value !== null) {
      value = String(value).trim();
      if (value === '') value = field === 'status' ? 'pending' : '';
    }
    activity[field] = value;
  }
  if (!activity.id) activity.id = newId();
  const legacy = LEGACY_STATUS[activity.status];
  if (legacy) activity.status = legacy;
  if (!activity.status || !STATUSES.includes(activity.status)) {
    activity.status = 'pending';
  }
  // 截止时间由前端解析为 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm 文本，空则置 null，方便排序与比较
  for (const field of ['claim_deadline', 'valid_until']) {
    if (activity[field] === undefined || activity[field] === '') {
      activity[field] = null;
    }
  }
  activity.created_at = existing.created_at || new Date().toISOString();
  activity.updated_at = new Date().toISOString();
  return activity;
}

// ---------- API 路由 ----------
// 新增端点时在 routes 表里加一行即可
const routes = [];
function route(method, pattern, handler) {
  // pattern 如 '/api/activities/:id'，:id 为路径参数
  const keys = [];
  const regex = new RegExp(
    '^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$'
  );
  routes.push({ method, regex, keys, handler });
}

// 健康检查免口令（见 createServer）：手机要先能问「我是什么端、要不要口令」
route('GET', '/api/health', async (ctx) => ctx.json({
  ok: true,
  app: 'shisuiji',
  schema_version: SCHEMA_VERSION,
  role: ctx.role,
  needToken: !!APP_CONFIG.token && ctx.role !== 'desktop',
  server_time: new Date().toISOString(),
}));

route('GET', '/api/activities', async (ctx) => ctx.json(db.activities));

route('POST', '/api/activities', async (ctx) => {
  const activity = normalizeActivity(ctx.body);
  db.activities.push(activity);
  await saveData();
  ctx.json(activity, 201);
});

route('PUT', '/api/activities/:id', async (ctx) => {
  const index = db.activities.findIndex((a) => a.id === ctx.params.id);
  if (index === -1) return ctx.json({ error: '记录不存在' }, 404);
  const activity = normalizeActivity(ctx.body, db.activities[index]);
  db.activities[index] = activity;
  await saveData();
  ctx.json(activity);
});

route('DELETE', '/api/activities/:id', async (ctx) => {
  const index = db.activities.findIndex((a) => a.id === ctx.params.id);
  if (index === -1) return ctx.json({ error: '记录不存在' }, 404);
  const [removed] = db.activities.splice(index, 1);
  await saveData();
  ctx.json({ ok: true, deleted: removed.id });
});

// ---------- 文献板块：数据层 ----------
let paperDb = null;

function defaultPaperData() {
  return { schema_version: SCHEMA_VERSION, papers: [] };
}

async function loadPapers() {
  try {
    const raw = await fsp.readFile(PAPERS_FILE, 'utf8');
    paperDb = JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    paperDb = defaultPaperData();
    await savePapers();
  }
}

async function savePapers() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = PAPERS_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(paperDb, null, 2), 'utf8');
  await fsp.rename(tmp, PAPERS_FILE);
}

// 类别清洗：去掉 Windows 非法字符与路径穿越，锁死在论文库内
function safeCategory(raw) {
  const s = String(raw || '').trim();
  const clean = s.replace(/[\\/:*?"<>|]/g, '').replace(/^\.+/, '').slice(0, 60).trim();
  return clean || '未分类';
}

// 文件名清洗：去掉路径分隔符与穿越前缀，避免 file_name 被用来写出论文库
function safeFileName(raw) {
  const s = String(raw || '').trim();
  return s.replace(/[\\/:*?"<>|]/g, '').replace(/^\.+/, '').slice(0, 200).trim();
}

// 一条阅读记录：按 id 合并既有内容，便于单独编辑/删除
function normalizePaperLog(input, existing = {}) {
  const log = { ...existing };
  for (const field of PAPER_LOG_FIELDS) {
    if (!(field in input)) continue;
    const value = input[field];
    log[field] = value === null || value === undefined ? '' : String(value).trim();
  }
  for (const field of PAPER_LOG_LIST_FIELDS) {
    if (!(field in input)) continue;
    log[field] = Array.isArray(input[field])
      ? input[field].map((v) => String(v).trim()).filter(Boolean)
      : [];
  }
  if (!log.id) log.id = crypto.randomUUID();
  log.created_at = existing.created_at || new Date().toISOString();
  log.updated_at = new Date().toISOString();
  return log;
}

function normalizePaper(input, existing = {}) {
  const paper = { ...existing };
  for (const field of PAPER_FIELDS) {
    if (!(field in input)) continue;
    const value = input[field];
    paper[field] = value === null || value === undefined ? '' : String(value).trim();
  }
  // last_read_at（最近一次点「📖 阅读」的时间，只用于前端排序）同样不进 PAPER_FIELDS：
  // 它由 /open 路由独占写入，靠上面的 {...existing} 原样保留，客户端 PUT 覆盖不了也清不掉
  // logs 单独处理：不能进 PAPER_FIELDS，否则会被上面的 String() 拍成 "[object Object]"
  if ('logs' in input) {
    const prev = new Map((Array.isArray(existing.logs) ? existing.logs : []).map((l) => [l.id, l]));
    const incoming = Array.isArray(input.logs) ? input.logs : [];
    paper.logs = incoming
      .filter((l) => l && typeof l === 'object')
      .map((l) => normalizePaperLog(l, prev.get(l.id) || {}));
  } else if (!Array.isArray(paper.logs)) {
    paper.logs = [];
  }
  if (!paper.id) paper.id = crypto.randomUUID();
  if (!PAPER_STATUSES.includes(paper.status)) paper.status = 'to_read';
  paper.category = safeCategory(paper.category);
  paper.file_name = safeFileName(paper.file_name);
  paper.created_at = existing.created_at || new Date().toISOString();
  paper.updated_at = new Date().toISOString();
  return paper;
}

// ---------- 网页板块：数据层 ----------
let siteDb = null;

function defaultSiteData() {
  return { schema_version: SCHEMA_VERSION, sites: [] };
}

async function loadSites() {
  try {
    const raw = await fsp.readFile(SITES_FILE, 'utf8');
    siteDb = JSON.parse(raw);
    if (!Array.isArray(siteDb.sites)) siteDb.sites = [];
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    siteDb = defaultSiteData();
    await saveSites();
  }
}

async function saveSites() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = SITES_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(siteDb, null, 2), 'utf8');
  await fsp.rename(tmp, SITES_FILE);
}

// 链接规范化：裸域名补 https://；只放行 http/https（javascript:、ftp: 之类一律拒）
function normalizeSiteUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s.replace(/^\/+/, '');
  let u;
  try { u = new URL(withScheme); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return u.href;
}

// 卡片上显示的域名（去掉 www.），也参与搜索
function siteDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return ''; }
}

// 一条网页笔记：按 id 合并既有内容，便于单独编辑/删除
function normalizeSiteNote(input, existing = {}) {
  const log = { ...existing };
  for (const field of SITE_NOTE_FIELDS) {
    if (!(field in input)) continue;
    const value = input[field];
    log[field] = value === null || value === undefined ? '' : String(value).trim();
  }
  if (!log.id) log.id = crypto.randomUUID();
  if (!SITE_KINDS.includes(log.kind)) log.kind = 'tech';
  if (!SITE_USAGES.includes(log.usage)) log.usage = '';
  log.created_at = existing.created_at || new Date().toISOString();
  log.updated_at = new Date().toISOString();
  return log;
}

function normalizeSite(input, existing = {}) {
  const site = { ...existing };
  for (const field of SITE_FIELDS) {
    if (!(field in input)) continue;
    const value = input[field];
    site[field] = value === null || value === undefined ? '' : String(value).trim();
  }
  if ('tags' in input) {
    site.tags = Array.isArray(input.tags)
      ? input.tags.map((t) => String(t).trim()).filter(Boolean)
      : [];
  } else if (!Array.isArray(site.tags)) {
    site.tags = [];
  }
  // last_read_at（最近一次点「🌐 打开」的时间，只用于排序）不进 SITE_FIELDS：
  // 它由 /open 路由独占写入，靠上面的 {...existing} 原样保留，客户端 PUT 覆盖不了
  if ('logs' in input) {
    const prev = new Map((Array.isArray(existing.logs) ? existing.logs : []).map((l) => [l.id, l]));
    const incoming = Array.isArray(input.logs) ? input.logs : [];
    site.logs = incoming
      .filter((l) => l && typeof l === 'object')
      .map((l) => normalizeSiteNote(l, prev.get(l.id) || {}));
  } else if (!Array.isArray(site.logs)) {
    site.logs = [];
  }
  if (!site.id) site.id = crypto.randomUUID();
  if (!SITE_KINDS.includes(site.kind)) site.kind = 'tech';
  if (!SITE_STATUSES.includes(site.status)) site.status = 'to_read';
  site.url = normalizeSiteUrl(site.url) || '';
  site.domain = siteDomain(site.url);
  if (!site.title) site.title = site.domain || '未命名网页';
  site.created_at = existing.created_at || new Date().toISOString();
  site.updated_at = new Date().toISOString();
  return site;
}

// ---------- 网页板块：自动取标题 ----------
// 只抓 HTML 的 <title>，超时/失败一律当没有，不阻塞用户手填
function httpGetText(url, { timeout = 2000, maxBytes = 256 * 1024, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const go = (target, left) => {
      let parsed;
      try { parsed = new URL(target); } catch { return done(reject, new Error('URL 不合法')); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return done(reject, new Error('只支持 http/https'));
      }
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.get(target, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (shisuiji-link-title)',
          Accept: 'text/html,application/xhtml+xml',
        },
      }, (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && left > 0) {
          res.resume();
          return go(new URL(location, target).href, left - 1);
        }
        if (status < 200 || status >= 300) { res.resume(); return done(reject, new Error('HTTP ' + status)); }
        const contentType = String(res.headers['content-type'] || '');
        if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
          res.resume();
          return done(reject, new Error('不是 HTML'));
        }
        const chunks = [];
        let size = 0;
        const finish = () => done(resolve, {
          body: Buffer.concat(chunks).subarray(0, maxBytes),
          contentType,
          finalUrl: target,
        });
        res.on('data', (chunk) => {
          size += chunk.length;
          chunks.push(chunk);
          if (size >= maxBytes) { finish(); res.destroy(); }
        });
        res.on('end', finish);
        res.on('error', (err) => done(reject, err));
      });
      req.setTimeout(timeout, () => req.destroy(new Error('取标题超时')));
      req.on('error', (err) => done(reject, err));
    };

    go(url, redirects);
  });
}

// 按 Content-Type 或 <meta charset> 解码：GBK 等老编码靠 Node 自带的 TextDecoder
function decodeHtml(buf, contentType) {
  const head = buf.subarray(0, 4096).toString('latin1'); // 只用头部找 charset
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '')
    || /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  const charset = (m ? m[1] : 'utf-8').toLowerCase();
  try { return new TextDecoder(charset).decode(buf); } catch { return buf.toString('utf8'); }
}

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  middot: '·', hellip: '…', mdash: '—', ndash: '–',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
};

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole;
    }
    const key = body.toLowerCase();
    return key in HTML_ENTITIES ? HTML_ENTITIES[key] : whole;
  });
}

function extractTitle(buf, contentType) {
  const html = decodeHtml(buf, contentType);
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return '';
  const title = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  return title.length > 200 ? title.slice(0, 200) + '…' : title;
}

// ---------- 花销板块：数据层 ----------
let expenseDb = null;

function defaultExpenseData() {
  return { schema_version: SCHEMA_VERSION, expenses: [] };
}

async function loadExpenses() {
  try {
    const raw = await fsp.readFile(EXPENSES_FILE, 'utf8');
    expenseDb = JSON.parse(raw);
    if (!Array.isArray(expenseDb.expenses)) expenseDb.expenses = [];
    // 一次性回填：老记录没有 category（或值非法）时按标题猜一个；只有真改了才写盘
    let changed = 0;
    for (const e of expenseDb.expenses) {
      if (!EXPENSE_CATEGORIES.includes(e.category)) {
        e.category = guessExpenseCategory(e.title);
        changed += 1;
      }
    }
    if (changed) await saveExpenses();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    expenseDb = defaultExpenseData();
    await saveExpenses();
  }
}

async function saveExpenses() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = EXPENSES_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(expenseDb, null, 2), 'utf8');
  await fsp.rename(tmp, EXPENSES_FILE);
}

// 金额解析：容忍 ¥ / ￥ / 千分位 / 空格；负数与非法值一律返回 null
function parseAmount(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/[¥￥,，\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  const rounded = Math.round(n * 100) / 100;
  if (rounded > 1e8) return null;
  return rounded;
}

// 日期规范：2026-9-10 / 2026/9/10 都补成 2026-09-10；非法或空回落今天
function normalizeExpenseDate(raw) {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(String(raw || '').trim());
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const probe = new Date(y, mo - 1, d);
    if (probe.getFullYear() === y && probe.getMonth() === mo - 1 && probe.getDate() === d) {
      return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// 按标题猜类别：套餐关键词优先（token 包、资源包算套餐），再匹配 API、算力租用，都没命中兜底套餐
function guessExpenseCategory(title) {
  const s = String(title || '').toLowerCase();
  if (EXPENSE_PLAN_KEYWORDS.some((k) => s.includes(k))) return 'plan';
  if (EXPENSE_API_KEYWORDS.some((k) => s.includes(k))) return 'api';
  if (EXPENSE_COMPUTE_KEYWORDS.some((k) => s.includes(k))) return 'compute';
  return 'plan';
}

function normalizeExpense(input, existing = {}) {
  const expense = { ...existing };
  for (const field of EXPENSE_FIELDS) {
    if (!(field in input)) continue;
    const value = input[field];
    expense[field] = value === null || value === undefined ? '' : String(value).trim();
  }
  if ('amount' in input) {
    const n = parseAmount(input.amount);
    if (n !== null) expense.amount = n;
  }
  if (typeof expense.amount !== 'number' || !Number.isFinite(expense.amount)) expense.amount = 0;
  expense.date = normalizeExpenseDate(expense.date);
  if (!EXPENSE_CATEGORIES.includes(expense.category)) expense.category = guessExpenseCategory(expense.title);
  if (!expense.id) expense.id = crypto.randomUUID();
  expense.created_at = existing.created_at || new Date().toISOString();
  expense.updated_at = new Date().toISOString();
  return expense;
}

// ---------- 文献板块：论文库文件系统 ----------
function paperDir(status) {
  return path.join(PAPERS_DIR, PAPER_STATUS_DIRS[status] || PAPER_STATUS_DIRS.to_read);
}
function categoryDir(status, category) {
  return path.join(paperDir(status), category);
}

async function ensurePaperDirs() {
  for (const status of PAPER_STATUSES) {
    await fsp.mkdir(paperDir(status), { recursive: true });
  }
}

// 论文文件夹（收件箱）：用户下载的论文先落在这里
async function listInbox() {
  await ensurePaperDirs();
  const entries = await fsp.readdir(PAPERS_DIR, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const st = await fsp.stat(path.join(PAPERS_DIR, e.name)).catch(() => null);
    if (st) out.push({ name: e.name, size: st.size, mtime: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// 已有类别 = 待读/已读下的子目录并集
async function listCategories() {
  await ensurePaperDirs();
  const set = new Set();
  for (const status of PAPER_STATUSES) {
    const entries = await fsp.readdir(paperDir(status), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) set.add(e.name);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
}

// 定位记录的文件：当前状态/类别 → 收件箱 → 各状态根 → 各状态的其他类别
function findPaperFile(paper, prevCategory) {
  const fileName = safeFileName(paper && paper.file_name);
  if (!fileName) return null;
  const dirs = [categoryDir(paper.status, safeCategory(paper.category)), PAPERS_DIR];
  for (const st of PAPER_STATUSES) {
    dirs.push(paperDir(st), categoryDir(st, safeCategory(prevCategory || paper.category)));
  }
  for (const dir of dirs) {
    const p = path.join(dir, fileName);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 文件系统报错 → 人话提示：EPERM/EACCES/EBUSY 基本都是「不可写」或「文件被占用」
function fsError(err, action, target) {
  const code = (err && err.code) || '未知错误';
  const hint = ['EPERM', 'EACCES', 'EBUSY', 'EROFS'].includes(code)
    ? '论文文件夹不可写，或文件正被其它程序占用（比如 PDF 还开着）'
    : '请检查论文文件夹是否存在、磁盘是否可写';
  return `论文文件夹操作失败（${code}）：${action} ${target}。${hint}。`;
}

// 归档：把文件挪到 目标状态/目标类别/ 下；找不到不报错，返回 missing 让前端提示
async function filePaper(fileName, prevCategory, targetStatus, targetCategory) {
  const cat = safeCategory(targetCategory);
  const safeName = safeFileName(fileName);
  if (!safeName) return { file_name: '', category: cat, moved: false, missing: false };
  const targetDir = categoryDir(targetStatus, cat);
  try {
    await fsp.mkdir(targetDir, { recursive: true });
  } catch (err) {
    throw new Error(fsError(err, '创建目录', targetDir));
  }
  const target = path.join(targetDir, safeName);
  if (fs.existsSync(target)) return { file_name: safeName, category: cat, moved: false, missing: false };
  const dirs = [PAPERS_DIR];
  for (const st of PAPER_STATUSES) {
    dirs.push(paperDir(st), categoryDir(st, safeCategory(prevCategory || cat)));
  }
  const source = dirs.map((d) => path.join(d, safeName)).find((p) => fs.existsSync(p));
  if (!source) return { file_name: safeName, category: cat, moved: false, missing: true };
  let name = safeName;
  const ext = path.extname(name);
  let n = 2;
  while (fs.existsSync(path.join(targetDir, name))) {
    name = `${path.basename(safeName, ext)} ${n}${ext}`;
    n += 1;
  }
  try {
    await fsp.rename(source, path.join(targetDir, name));
  } catch (err) {
    throw new Error(fsError(err, '移动文件到', targetDir));
  }
  return { file_name: name, category: cat, moved: true, missing: false };
}

// ---------- 文献板块：文件名模糊匹配 ----------
// 归一化：全角→半角、小写、标点/分隔符压成空格，消除命名噪声
function normName(s) {
  return String(s)
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .replace(/[【】()[\]{}<>《》“”‘’"'·、，。：；！？!?\-_.—–,;:|\\/+#@%&=$^~*\s]+/g, ' ')
    .trim();
}

// 分词：ASCII 词 + 中文双字组（bigram），供 Dice 相似度用
function nameTokens(s) {
  const tokens = [];
  for (const w of normName(s).split(' ').filter(Boolean)) {
    if (/^[\x00-\x7F]+$/.test(w)) {
      tokens.push(w);
    } else {
      for (let i = 0; i < w.length - 1; i++) tokens.push(w.slice(i, i + 2));
    }
  }
  return tokens;
}

function diceScore(a, b) {
  if (!a.length || !b.length) return 0;
  const bag = new Map();
  for (const t of a) bag.set(t, (bag.get(t) || 0) + 1);
  let hit = 0;
  for (const t of b) {
    const n = bag.get(t) || 0;
    if (n > 0) { hit += 1; bag.set(t, n - 1); }
  }
  return (2 * hit) / (a.length + b.length);
}

// 文件名打分：精确 100 / 连续片段包含 70-95 / 分词相似度与词前缀兜底
function scoreFileName(query, fileName) {
  const base = fileName.replace(/\.[a-z0-9]+$/i, '');
  const q = normName(query);
  const f = normName(base);
  if (!q || !f) return 0;
  if (q === f) return 100;
  if (f.includes(q)) {
    // 输入是文件名中一段连续文字（部分输入的主力），按覆盖比例给分
    return Math.round(70 + 25 * Math.min(1, (2 * q.length) / (q.length + f.length)));
  }
  const qWords = q.split(' ').filter(Boolean);
  const fWords = f.split(' ').filter(Boolean);
  // 词前缀：atten → attention
  let prefixHit = 0;
  for (const qt of qWords) {
    if (fWords.some((ft) => ft.startsWith(qt))) prefixHit += 1;
  }
  const prefixRatio = qWords.length ? prefixHit / qWords.length : 0;
  const d = diceScore(nameTokens(query), nameTokens(base));
  const raw = Math.max(d, prefixRatio * 0.85);
  return raw >= 0.3 ? Math.round(raw * 75) : 0;
}

// 候选排序 + 自动选中规则：≥80 直接选；≥70 且唯一领先（甩开第二名 10 分）也直接选
function matchInbox(query, files) {
  const scored = files
    .map((f) => ({ ...f, score: scoreFileName(query, f.name) }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  const top = scored[0];
  const auto = !!top && (top.score >= 80
    || (top.score >= 70 && (scored.length === 1 || top.score - scored[1].score >= 10)));
  return { candidates: scored.slice(0, 6), auto };
}

// ---------- 文献板块：路由 ----------
route('GET', '/api/papers', async (ctx) => {
  ctx.json(paperDb.papers.map((p) => ({ ...p, file_exists: !!findPaperFile(p) })));
});

route('GET', '/api/papers/inbox', async (ctx) => ctx.json(await listInbox()));

route('GET', '/api/papers/categories', async (ctx) => ctx.json(await listCategories()));

route('GET', '/api/papers/match', async (ctx) => {
  const q = (ctx.query.get('name') || '').trim();
  if (!q) return ctx.json({ candidates: [], auto: false });
  ctx.json(matchInbox(q, await listInbox()));
});

route('POST', '/api/papers', async (ctx) => {
  await ensurePaperDirs();
  const paper = normalizePaper(ctx.body);
  const res = await filePaper(paper.file_name, paper.category, paper.status, paper.category);
  Object.assign(paper, { file_name: res.file_name, category: res.category });
  paperDb.papers.push(paper);
  await savePapers();
  ctx.json({ ...paper, moved: res.moved, missing: res.missing }, 201);
});

route('PUT', '/api/papers/:id', async (ctx) => {
  const idx = paperDb.papers.findIndex((p) => p.id === ctx.params.id);
  if (idx === -1) return ctx.json({ error: '记录不存在' }, 404);
  const prev = paperDb.papers[idx];
  const paper = normalizePaper(ctx.body, prev);
  const res = await filePaper(paper.file_name, prev.category, paper.status, paper.category);
  Object.assign(paper, { file_name: res.file_name, category: res.category });
  paperDb.papers[idx] = paper;
  await savePapers();
  ctx.json({ ...paper, moved: res.moved, missing: res.missing });
});

route('DELETE', '/api/papers/:id', async (ctx) => {
  // 只删记录，磁盘上的文件保持原位
  const idx = paperDb.papers.findIndex((p) => p.id === ctx.params.id);
  if (idx === -1) return ctx.json({ error: '记录不存在' }, 404);
  const [removed] = paperDb.papers.splice(idx, 1);
  await savePapers();
  ctx.json({ ok: true, deleted: removed.id });
});

// 用记录指定的阅读软件打开论文；没配则走系统默认打开方式
route('POST', '/api/papers/:id/open', async (ctx) => {
  const paper = paperDb.papers.find((p) => p.id === ctx.params.id);
  if (!paper) return ctx.json({ error: '记录不存在' }, 404);
  if (!paper.file_name) return ctx.json({ error: '这条记录没有关联文件' }, 400);
  const filePath = findPaperFile(paper);
  if (!filePath) return ctx.json({ error: '文件不在预期位置，可能被移动或重命名了' }, 404);
  if (paper.reader) {
    if (!fs.existsSync(paper.reader)) {
      return ctx.json({ error: '阅读软件路径不存在：' + paper.reader }, 400);
    }
    spawn(paper.reader, [filePath], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore' }).unref();
  }
  // 打开成功 = 这次真的在读它：记下阅读时间，前端据此把这张卡刷到列表顶部
  paper.last_read_at = new Date().toISOString();
  await savePapers();
  ctx.json({ ok: true, paper });
});

// ---------- 文献板块：本机阅读软件检测 ----------
// 想支持新软件：往这里加一组关键词/候选 exe 名即可
const READER_DEFS = [
  { name: 'Zotero', keys: ['zotero'], exes: ['zotero.exe'] },
  { name: 'WPS Office', keys: ['wps office', 'wps办公', '金山办公'], exes: ['wps.exe', 'wpspdf.exe'] },
  { name: 'CAJViewer', keys: ['cajviewer', 'caj viewer'], exes: ['cajviewer.exe'] },
  { name: '小绿鲸文献阅读器', keys: ['小绿鲸'], exes: [] },
  { name: '知网研学', keys: ['知网研学', 'e-study'], exes: [] },
  { name: 'Adobe Acrobat', keys: ['adobe acrobat'], exes: ['acrobat.exe'] },
  { name: 'Adobe Reader', keys: ['adobe reader', 'acrobat reader'], exes: ['acrord32.exe'] },
  { name: '福昕阅读器', keys: ['foxit', '福昕'], exes: ['foxitpdfreader.exe', 'foxitreader.exe'] },
  { name: 'SumatraPDF', keys: ['sumatra'], exes: ['sumatrapdf.exe'] },
  { name: 'Mendeley', keys: ['mendeley'], exes: ['mendeley.exe'] },
  { name: 'EndNote', keys: ['endnote'], exes: ['endnote.exe'] },
  { name: 'Calibre', keys: ['calibre'], exes: ['calibre.exe', 'ebook-viewer.exe'] },
  { name: 'Koodo Reader', keys: ['koodo'], exes: ['koodo-reader.exe', 'koodo.exe'] },
  { name: 'BookxNote', keys: ['bookxnote'], exes: ['bookxnotepro.exe', 'bookxnote.exe'] },
  { name: '超星阅读器', keys: ['超星阅读', 'ssreader'], exes: ['ssreader.exe'] },
  { name: 'Microsoft Edge', keys: ['microsoft edge'], exes: ['msedge.exe'] },
  { name: 'Google Chrome', keys: ['google chrome'], exes: ['chrome.exe'] },
];

// WPS 按用户安装且不进标准卸载表：扫 %LOCALAPPDATA%\Kingsoft\WPS Office\<版本>\office6\
function wpsProbe() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Kingsoft', 'WPS Office');
  try {
    const versions = fs.readdirSync(base)
      .filter((d) => /^\d+(\.\d+){3}$/.test(d))
      .sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < 4; i++) {
          if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
        }
        return 0;
      });
    for (const v of versions) {
      for (const exe of ['wps.exe', 'wpspdf.exe']) {
        const p = path.join(base, v, 'office6', exe);
        if (fs.existsSync(p)) return { name: 'WPS Office', exe: p };
      }
    }
  } catch { /* 没装 WPS 就算了 */ }
  return null;
}

// 固定路径兜底：便携版/没进卸载表的也能扫到
function readerFixedProbes() {
  const env = process.env;
  const pf = env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const lad = env['LOCALAPPDATA'] || path.join(env.USERPROFILE || '', 'AppData', 'Local');
  return [
    { name: 'Microsoft Edge', exe: path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Microsoft Edge', exe: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Google Chrome', exe: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Google Chrome', exe: path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Google Chrome', exe: path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'SumatraPDF', exe: path.join(lad, 'Programs', 'SumatraPDF', 'SumatraPDF.exe') },
    { name: 'SumatraPDF', exe: path.join(pf, 'SumatraPDF', 'SumatraPDF.exe') },
    { name: 'Zotero', exe: path.join(pf, 'Zotero', 'zotero.exe') },
  ];
}

// reg.exe 在中文系统输出 GBK 编码，要按 GBK 解
function decodeRegOutput(buf) {
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

// 解析 `reg query xxx /s` 输出：HKEY 行分块，块内是「值名  类型  值」
function parseRegDump(text) {
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('HKEY_')) {
      if (current) entries.push(current);
      current = {};
    } else if (current) {
      const m = line.match(/^\s{4}(.+?)\s{2,}REG_[A-Z_]+\s{2,}(.*)$/);
      if (m) current[m[1]] = m[2];
    }
  }
  if (current) entries.push(current);
  return entries;
}

function resolveReaderExe(entry, def) {
  const icon = entry['DisplayIcon'];
  if (icon) {
    const p = icon.split(',')[0].trim().replace(/^"(.*)"$/, '$1');
    if (/\.exe$/i.test(p) && fs.existsSync(p)) return p;
  }
  const loc = entry['InstallLocation'];
  if (loc) {
    const dir = loc.trim().replace(/^"(.*)"$/, '$1');
    for (const exe of def.exes) {
      const p = path.join(dir, exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

let readersCache = null;

async function detectReaders() {
  if (readersCache) return readersCache;
  const found = [];
  const seen = new Set();
  const addReader = (name, exe) => {
    const key = path.resolve(exe).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ name, exe: path.resolve(exe) });
  };

  if (process.platform === 'win32') {
    const hives = [
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ];
    for (const hive of hives) {
      let entries = [];
      try {
        const { stdout } = await execFileAsync('reg', [hive, '/s'], {
          encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 10000,
        });
        entries = parseRegDump(decodeRegOutput(stdout));
      } catch { /* 单个 hive 读不到就跳过 */ }
      for (const entry of entries) {
        const display = (entry['DisplayName'] || '').trim();
        if (!display) continue;
        const lower = display.toLowerCase();
        const def = READER_DEFS.find((d) => d.keys.some((k) => lower.includes(k)));
        if (!def) continue;
        const exe = resolveReaderExe(entry, def);
        if (exe) addReader(display, exe);
      }
    }
  }
  const wps = wpsProbe();
  if (wps) addReader(wps.name, wps.exe);
  for (const probe of readerFixedProbes()) {
    if (fs.existsSync(probe.exe)) addReader(probe.name, probe.exe);
  }
  readersCache = found;
  return found;
}

route('GET', '/api/papers/readers', async (ctx) => ctx.json({ readers: await detectReaders() }));

// 在资源管理器中打开文件所在位置并选中该文件
route('POST', '/api/papers/:id/reveal', async (ctx) => {
  const paper = paperDb.papers.find((p) => p.id === ctx.params.id);
  if (!paper) return ctx.json({ error: '记录不存在' }, 404);
  if (!paper.file_name) return ctx.json({ error: '这条记录没有关联文件' }, 400);
  const filePath = findPaperFile(paper);
  if (!filePath) return ctx.json({ error: '文件不在预期位置，可能被移动或重命名了' }, 404);
  if (process.platform === 'win32') {
    spawn('explorer', ['/select,', filePath], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [path.dirname(filePath)], { detached: true, stdio: 'ignore' }).unref();
  }
  ctx.json({ ok: true });
});

// ---------- 网页板块：路由 ----------
route('GET', '/api/sites', async (ctx) => ctx.json(siteDb.sites));

// 根据链接自动取网页标题（失败返回空标题，前端留着让用户手填）
route('GET', '/api/sites/title', async (ctx) => {
  const url = normalizeSiteUrl(ctx.query.get('url') || '');
  if (!url) return ctx.json({ title: '', domain: '', finalUrl: '' });
  try {
    const { body, contentType, finalUrl } = await httpGetText(url);
    ctx.json({ title: extractTitle(body, contentType), domain: siteDomain(finalUrl), finalUrl });
  } catch {
    ctx.json({ title: '', domain: siteDomain(url), finalUrl: url });
  }
});

route('POST', '/api/sites', async (ctx) => {
  const url = normalizeSiteUrl(ctx.body.url);
  if (!url) return ctx.json({ error: '链接不是合法的 http/https 网址' }, 400);
  const site = normalizeSite({ ...ctx.body, url });
  siteDb.sites.push(site);
  await saveSites();
  ctx.json(site, 201);
});

route('PUT', '/api/sites/:id', async (ctx) => {
  const idx = siteDb.sites.findIndex((s) => s.id === ctx.params.id);
  if (idx === -1) return ctx.json({ error: '记录不存在' }, 404);
  const raw = ctx.body.url === undefined ? siteDb.sites[idx].url : ctx.body.url;
  const url = normalizeSiteUrl(raw);
  if (!url) return ctx.json({ error: '链接不是合法的 http/https 网址' }, 400);
  const site = normalizeSite({ ...ctx.body, url }, siteDb.sites[idx]);
  siteDb.sites[idx] = site;
  await saveSites();
  ctx.json(site);
});

route('DELETE', '/api/sites/:id', async (ctx) => {
  const idx = siteDb.sites.findIndex((s) => s.id === ctx.params.id);
  if (idx === -1) return ctx.json({ error: '记录不存在' }, 404);
  const [removed] = siteDb.sites.splice(idx, 1);
  await saveSites();
  ctx.json({ ok: true, deleted: removed.id });
});

// 打开网页 = 这次真的在读它：记下阅读时间，前端据此把这张卡刷到列表顶部
route('POST', '/api/sites/:id/open', async (ctx) => {
  const site = siteDb.sites.find((s) => s.id === ctx.params.id);
  if (!site) return ctx.json({ error: '记录不存在' }, 404);
  site.last_read_at = new Date().toISOString();
  await saveSites();
  ctx.json({ ok: true, site });
});

// ---------- 花销板块：路由 ----------
const AMOUNT_ERROR = '金额得是正数（可写 1280、1280.5、¥1,280）';

route('GET', '/api/expenses', async (ctx) => ctx.json(expenseDb.expenses));

route('POST', '/api/expenses', async (ctx) => {
  const title = String(ctx.body.title || '').trim();
  if (!title) return ctx.json({ error: '请填写花销内容' }, 400);
  const amount = parseAmount(ctx.body.amount);
  if (amount === null) return ctx.json({ error: AMOUNT_ERROR }, 400);
  const expense = normalizeExpense({ ...ctx.body, title, amount });
  expenseDb.expenses.push(expense);
  await saveExpenses();
  ctx.json(expense, 201);
});

route('PUT', '/api/expenses/:id', async (ctx) => {
  const idx = expenseDb.expenses.findIndex((e) => e.id === ctx.params.id);
  if (idx === -1) return ctx.json({ error: '记录不存在' }, 404);
  const prev = expenseDb.expenses[idx];
  const title = ctx.body.title === undefined ? prev.title : String(ctx.body.title).trim();
  if (!title) return ctx.json({ error: '请填写花销内容' }, 400);
  const amount = ctx.body.amount === undefined ? prev.amount : parseAmount(ctx.body.amount);
  if (amount === null) return ctx.json({ error: AMOUNT_ERROR }, 400);
  const expense = normalizeExpense({ ...ctx.body, title, amount }, prev);
  expenseDb.expenses[idx] = expense;
  await saveExpenses();
  ctx.json(expense);
});

route('DELETE', '/api/expenses/:id', async (ctx) => {
  const idx = expenseDb.expenses.findIndex((e) => e.id === ctx.params.id);
  if (idx === -1) return ctx.json({ error: '记录不存在' }, 404);
  const [removed] = expenseDb.expenses.splice(idx, 1);
  await saveExpenses();
  ctx.json({ ok: true, deleted: removed.id });
});

// ---------- 花销体感评价：数据层 ----------
let insightDb = null;

function defaultInsightData() {
  return { schema_version: SCHEMA_VERSION, verdicts: [] };
}

async function loadInsights() {
  try {
    const raw = await fsp.readFile(INSIGHTS_FILE, 'utf8');
    insightDb = JSON.parse(raw);
    if (!Array.isArray(insightDb.verdicts)) insightDb.verdicts = [];
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    insightDb = defaultInsightData();
    await saveInsights();
  }
}

async function saveInsights() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = INSIGHTS_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(insightDb, null, 2), 'utf8');
  await fsp.rename(tmp, INSIGHTS_FILE);
}

// 评价清洗：verdict 是用户敲定的总评；rating 收敛成 1-5 整数或 null；
// decision 必须是四个枚举之一（没传保留旧值，非法一律清空）；subject 作唯一键，由路由层校验非空
function normalizeInsight(input, existing = {}) {
  const insight = { ...existing, subject: input.subject };
  if ('verdict' in input) {
    insight.verdict = input.verdict === null || input.verdict === undefined ? '' : String(input.verdict).trim();
  }
  if ('decision' in input) {
    insight.decision = INSIGHT_DECISIONS.includes(input.decision) ? input.decision : '';
  }
  if ('rating' in input) {
    const r = Number(input.rating);
    insight.rating = Number.isInteger(r) && r >= 1 && r <= 5 ? r : null;
  }
  if (!insight.id) insight.id = crypto.randomUUID();
  insight.created_at = existing.created_at || new Date().toISOString();
  insight.updated_at = new Date().toISOString();
  return insight;
}

// ---------- 花销体感评价：路由 ----------
// subject 直接当 URL 一段（前端 encodeURIComponent，这里对应解码）；按 subject upsert，省得前端先查 id
route('GET', '/api/insights', async (ctx) => ctx.json(insightDb.verdicts));

route('PUT', '/api/insights/:subject', async (ctx) => {
  const subject = decodeURIComponent(ctx.params.subject || '').trim();
  if (!subject) return ctx.json({ error: '缺少主体' }, 400);
  const idx = insightDb.verdicts.findIndex((v) => v.subject === subject);
  const insight = normalizeInsight({ ...ctx.body, subject }, idx === -1 ? {} : insightDb.verdicts[idx]);
  if (idx === -1) insightDb.verdicts.push(insight);
  else insightDb.verdicts[idx] = insight;
  await saveInsights();
  ctx.json(insight);
});

route('DELETE', '/api/insights/:subject', async (ctx) => {
  const subject = decodeURIComponent(ctx.params.subject || '').trim();
  const idx = insightDb.verdicts.findIndex((v) => v.subject === subject);
  if (idx === -1) return ctx.json({ error: '评价不存在' }, 404);
  const [removed] = insightDb.verdicts.splice(idx, 1);
  await saveInsights();
  ctx.json({ ok: true, deleted: removed.subject });
});

// ---------- 消息中心：数据层 ----------
let messageDb = null;

function defaultMessageData() {
  return { schema_version: SCHEMA_VERSION, messages: [] };
}

async function loadMessages() {
  try {
    const raw = await fsp.readFile(MESSAGES_FILE, 'utf8');
    messageDb = JSON.parse(raw);
    if (!Array.isArray(messageDb.messages)) messageDb.messages = [];
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    messageDb = defaultMessageData();
    await saveMessages();
  }
}

async function saveMessages() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = MESSAGES_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(messageDb, null, 2), 'utf8');
  await fsp.rename(tmp, MESSAGES_FILE);
}

function normalizeMessage(input, existing = {}) {
  const msg = { ...existing };
  for (const field of MESSAGE_FIELDS) {
    if (!(field in input)) continue;
    const value = input[field];
    msg[field] = value === null || value === undefined ? '' : String(value).trim();
  }
  msg.read = input.read === undefined ? !!msg.read : !!input.read;
  if (!msg.id) msg.id = crypto.randomUUID();
  msg.created_at = existing.created_at || new Date().toISOString();
  return msg;
}

// ---------- 消息中心：路由 ----------
route('GET', '/api/messages', async (ctx) => {
  ctx.json([...messageDb.messages].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
});

// 新增消息：同一颗蛋同一类到期（activity_id + 使用截止 + 领取截止）只记一条，
// 多个标签页各扫一遍也不会写出重复消息；两侧 || '' 归一，兼容没有 claim_deadline 的老消息
route('POST', '/api/messages', async (ctx) => {
  const msg = normalizeMessage(ctx.body);
  const dup = messageDb.messages.find(
    (m) => m.activity_id === msg.activity_id
      && (m.valid_until || '') === (msg.valid_until || '')
      && (m.claim_deadline || '') === (msg.claim_deadline || '')
  );
  if (dup) return ctx.json(dup, 200);
  messageDb.messages.push(msg);
  await saveMessages();
  ctx.json(msg, 201);
});

route('PUT', '/api/messages/:id', async (ctx) => {
  const idx = messageDb.messages.findIndex((m) => m.id === ctx.params.id);
  if (idx === -1) return ctx.json({ error: '消息不存在' }, 404);
  const msg = normalizeMessage(ctx.body, messageDb.messages[idx]);
  messageDb.messages[idx] = msg;
  await saveMessages();
  ctx.json(msg);
});

route('DELETE', '/api/messages/:id', async (ctx) => {
  const idx = messageDb.messages.findIndex((m) => m.id === ctx.params.id);
  if (idx === -1) return ctx.json({ error: '消息不存在' }, 404);
  const [removed] = messageDb.messages.splice(idx, 1);
  await saveMessages();
  ctx.json({ ok: true, deleted: removed.id });
});

// 全部标为已读
route('POST', '/api/messages/read-all', async (ctx) => {
  let n = 0;
  for (const m of messageDb.messages) {
    if (!m.read) { m.read = true; n += 1; }
  }
  await saveMessages();
  ctx.json({ ok: true, updated: n });
});

// 清掉所有已读的，只留未读
route('POST', '/api/messages/clear-read', async (ctx) => {
  const keep = messageDb.messages.filter((m) => !m.read);
  const removed = messageDb.messages.length - keep.length;
  messageDb.messages = keep;
  await saveMessages();
  ctx.json({ ok: true, removed });
});

// ---------- 想法板块：数据层 ----------
let ideaDb = null;

function defaultIdeaData() {
  return { schema_version: SCHEMA_VERSION, ideas: [] };
}

async function loadIdeas() {
  try {
    const raw = await fsp.readFile(IDEAS_FILE, 'utf8');
    ideaDb = JSON.parse(raw);
    if (!Array.isArray(ideaDb.ideas)) ideaDb.ideas = [];
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    ideaDb = defaultIdeaData();
    await saveIdeasNow();
  }
}

async function saveIdeasNow() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = IDEAS_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(ideaDb, null, 2), 'utf8');
  await fsp.rename(tmp, IDEAS_FILE);
}

// 写盘串行化：同一集合并发写会共用同一个 .tmp 文件名，不排队会互相覆盖
let ioQueue = Promise.resolve();
function queueWrite(fn) {
  const run = ioQueue.then(fn, fn);
  ioQueue = run.catch(() => {}); // 出错不能把队列毒死
  return run;
}
function saveIdeas() {
  return queueWrite(saveIdeasNow);
}

// id 可能是客户端自己生成的（离线想法带着 UUID 重放），只认 UUID 形态，别让奇怪的值落进 JSON
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOrNull(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return UUID_RE.test(s) ? s : null;
}

// 客户端带来的时间：手机时钟可能不准，越界的一律用服务端时间
function isoOrNow(v) {
  const t = Date.parse(String(v || ''));
  if (!Number.isFinite(t)) return new Date().toISOString();
  const now = Date.now();
  if (t < now - 30 * 24 * 3600 * 1000 || t > now + 5 * 60 * 1000) return new Date().toISOString();
  return new Date(t).toISOString();
}

// 乐观锁：带了 base_updated_at 就必须和服务端现存的字符串完全一致。
// 比的是字符串而不是时刻，所以两端时钟不准也不影响判定。
function conflicted(prev, body) {
  const base = body && body.base_updated_at;
  if (base === undefined || base === null || base === '') return false;
  return String(base) !== String(prev.updated_at);
}

function normalizeIdea(input, existing = {}) {
  const idea = { ...existing };
  for (const field of IDEA_FIELDS) {
    if (!(field in input)) continue;
    idea[field] = input[field] === null || input[field] === undefined ? '' : String(input[field]).trim();
  }
  for (const field of IDEA_FIELDS) if (idea[field] === undefined) idea[field] = '';
  const incomingId = uuidOrNull(input.id);
  if (incomingId) idea.id = incomingId;
  if (!idea.id) idea.id = newId();
  if (IDEA_ORIGINS.includes(input.origin)) idea.origin = input.origin;
  if (!IDEA_ORIGINS.includes(idea.origin)) idea.origin = 'desktop';
  idea.created_at = existing.created_at || isoOrNow(input.created_at);
  idea.updated_at = new Date().toISOString();
  return idea;
}

// ---------- 想法板块：路由 ----------
route('GET', '/api/ideas', async (ctx) => {
  ctx.json([...ideaDb.ideas].sort((a, b) =>
    String(b.updated_at).localeCompare(String(a.updated_at))
    || String(b.created_at).localeCompare(String(a.created_at))));
});

// 幂等新增：手机离线时自己生成 id，队列重放遇到同一个 id 就直接返回已有记录
route('POST', '/api/ideas', async (ctx) => {
  const id = uuidOrNull(ctx.body.id);
  const hit = id ? ideaDb.ideas.find((i) => i.id === id) : null;
  if (hit) return ctx.json(hit, 200);
  const idea = normalizeIdea(ctx.body);
  if (ctx.role === 'mobile') idea.origin = 'mobile';
  ideaDb.ideas.push(idea);
  await saveIdeas();
  ctx.json(idea, 201);
});

route('PUT', '/api/ideas/:id', async (ctx) => {
  const idx = ideaDb.ideas.findIndex((i) => i.id === ctx.params.id);
  if (idx === -1) return ctx.json({ error: '想法不存在', code: 'missing' }, 404);
  const prev = ideaDb.ideas[idx];
  if (ctx.role === 'mobile' && prev.origin !== 'mobile') {
    return ctx.json({ error: '这条是电脑端记的，手机上改不了', code: 'forbidden' }, 403);
  }
  if (conflicted(prev, ctx.body)) {
    return ctx.json({ error: '这条想法在别处改过', code: 'conflict', server: prev }, 409);
  }
  const idea = normalizeIdea(ctx.body, prev);
  ideaDb.ideas[idx] = idea;
  await saveIdeas();
  ctx.json(idea);
});

route('DELETE', '/api/ideas/:id', async (ctx) => {
  const idx = ideaDb.ideas.findIndex((i) => i.id === ctx.params.id);
  if (idx === -1) return ctx.json({ error: '想法不存在', code: 'missing' }, 404);
  const prev = ideaDb.ideas[idx];
  if (ctx.role === 'mobile' && prev.origin !== 'mobile') {
    return ctx.json({ error: '这条是电脑端记的，手机上删不了', code: 'forbidden' }, 403);
  }
  const [removed] = ideaDb.ideas.splice(idx, 1);
  await saveIdeas();
  ctx.json({ ok: true, deleted: removed.id });
});

// ---------- 手机同步 ----------
// pull 一次返回全部集合：手机要是发 7 个并行 GET，两个请求之间电脑端改的数据会让它拿到撕裂的快照
route('GET', '/api/sync/pull', async (ctx) => {
  ctx.json({
    schema_version: SCHEMA_VERSION,
    server_time: new Date().toISOString(),
    activities: db.activities,
    papers: paperDb.papers.map((p) => ({ ...p, file_exists: !!findPaperFile(p) })),
    sites: siteDb.sites,
    expenses: expenseDb.expenses,
    insights: insightDb.verdicts,
    messages: [...messageDb.messages].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    ideas: ideaDb.ideas,
  });
});

// push 批量应用手机端的想法变更（目前只有想法能由手机写）。一次 push 只落一次盘。
route('POST', '/api/sync/push', async (ctx) => {
  const ops = Array.isArray(ctx.body && ctx.body.ideas) ? ctx.body.ideas : [];
  const results = [];
  let changed = false;
  for (const op of ops) {
    const r = applyIdeaOp(op, ctx.role);
    results.push(r);
    if (r.applied) changed = true;
  }
  if (changed) await saveIdeas();
  ctx.json({ ok: true, results });
});

// 返回五种 status，前端据此决定出队还是留队：
// ok（含重放幂等）/ conflict（留队等用户选）/ missing（电脑端删了，弃掉）
// forbidden（想改电脑端的）/ error（参数不对，重试也没用）
function applyIdeaOp(op, role) {
  const id = uuidOrNull(op && op.id);
  if (!id) return { id: '', status: 'error', error: '缺少合法 id' };
  const idx = ideaDb.ideas.findIndex((i) => i.id === id);
  const prev = idx === -1 ? null : ideaDb.ideas[idx];
  const kind = op.op === 'update' || op.op === 'delete' ? op.op : 'create';

  if (kind === 'create') {
    // 已经有 = 这次是重放，直接把服务端的版本还回去，别写第二条
    if (prev) return { id, status: 'ok', applied: false, idea: prev, already: true };
    const idea = normalizeIdea(op);
    idea.id = id;
    if (role === 'mobile') idea.origin = 'mobile';
    ideaDb.ideas.push(idea);
    return { id, status: 'ok', applied: true, idea };
  }
  if (!prev) return { id, status: 'missing', applied: false };
  if (role === 'mobile' && prev.origin !== 'mobile') return { id, status: 'forbidden', applied: false };
  if (conflicted(prev, op)) return { id, status: 'conflict', applied: false, server: prev };
  if (kind === 'delete') {
    ideaDb.ideas.splice(idx, 1);
    return { id, status: 'ok', applied: true, deleted: true };
  }
  const idea = normalizeIdea(op, prev);
  ideaDb.ideas[idx] = idea;
  return { id, status: 'ok', applied: true, idea };
}

// ---------- HTTP 基础设施 ----------
function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, pathname) {
  // 解析到 public/ 内，拒绝越权路径
  const safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safePath);
  const rel = path.relative(PUBLIC_DIR, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const stat = await fsp.stat(filePath).catch(() => null);
  if (stat && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  const data = await fsp.readFile(filePath).catch(() => null);
  if (!data) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // 本地自用的小工具：前端文件一律不缓存，改完刷新就能看到效果。
    // （原来的 max-age=300 会让浏览器 5 分钟内不回服务器，很容易误以为改动没生效）
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

// Origin 白名单：防浏览器跨域伪造写请求（CSRF）。放行三类：
// 1) 不带 Origin（curl 等本地工具）；2) 本机回环来源；
// 3) 同源局域网访问（DANJI_HOST 开放后手机访问：Origin 的 host 与请求 Host 一致，
//    且 Host 必须是 IP/localhost 形式——Host 是域名意味着 DNS rebinding，拒绝）
function originAllowed(origin, reqHost) {
  if (!origin) return true;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(parsed.host)) return true;
  if (!reqHost) return false;
  const host = String(reqHost).toLowerCase();
  return parsed.host === host
    && /^(localhost|(\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(:\d+)?$/i.test(host);
}

// ---------- 访问身份 ----------
// 本机回环 = 电脑端（免口令、全能）；其余来源 = 手机端（要口令、只读 + 只能写自己的想法）。
// 按来源 IP 判而不是让客户端自己声明：声明可以撒谎，IP 不行。
const LOCAL_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function clientRole(req) {
  const ip = String(req.socket.remoteAddress || '');
  if (LOCAL_ADDRS.has(ip) || /^::ffff:127\./.test(ip)) return 'desktop';
  return 'mobile';
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// 没配口令 = 不校验（保持原有行为，只靠监听地址保护）；配了则只有本机回环免口令
function tokenOk(req) {
  if (!APP_CONFIG.token) return true;
  if (clientRole(req) === 'desktop') return true;
  return safeEqual(req.headers['x-danji-token'] || '', APP_CONFIG.token);
}

// 手机端写白名单：能读全部板块、能写自己记的想法、能处理消息已读，其余一律挡住。
// 这是「防误操作 + 防同网段邻居」级别，不是防攻击。
function mobileMayWrite(method, pathname) {
  if (method === 'GET' || method === 'HEAD') return true;
  if (method === 'POST' && (pathname === '/api/ideas' || pathname === '/api/sync/push')) return true;
  if ((method === 'PUT' || method === 'DELETE') && /^\/api\/ideas\/[^/]+$/.test(pathname)) return true;
  if (method === 'PUT' && /^\/api\/messages\/[^/]+$/.test(pathname)) return true;
  if (method === 'POST' && (pathname === '/api/messages/read-all' || pathname === '/api/messages/clear-read')) return true;
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/') && !originAllowed(req.headers.origin, req.headers.host)) {
    console.error(`[shisuiji] 已拒绝非本机来源的 API 请求: Origin=${req.headers.origin || '(无)'} Host=${req.headers.host || '(无)'}`);
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  if (pathname.startsWith('/api/')) {
    // /api/health 免口令：手机要先能问「我算哪一端、要不要口令」
    if (pathname !== '/api/health' && !tokenOk(req)) {
      sendJson(res, 401, { error: '需要访问口令', needToken: true });
      return;
    }
    const role = clientRole(req);
    if (role === 'mobile' && !mobileMayWrite(req.method, pathname)) {
      sendJson(res, 403, { error: '手机端只能浏览和新增想法', code: 'forbidden' });
      return;
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = pathname.match(r.regex);
      if (!match) continue;
      const params = {};
      r.keys.forEach((key, i) => { params[key] = match[i + 1]; });
      try {
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
        await r.handler({
          req, res, params, body, query: url.searchParams, role,
          json: (data, code = 200) => sendJson(res, code, data),
        });
      } catch (err) {
        console.error('[shisuiji] 接口错误:', err.message);
        sendJson(res, err.message.includes('JSON') || err.message.includes('过大') ? 400 : 500, { error: err.message });
      }
      return;
    }
    sendJson(res, 404, { error: '接口不存在' });
    return;
  }

  try {
    await serveStatic(req, res, pathname === '/' ? '/index.html' : pathname);
  } catch (err) {
    console.error('[shisuiji] 静态服务错误:', err.message);
    res.writeHead(500); res.end('Internal Error');
  }
});

if (!fs.existsSync(PUBLIC_DIR)) {
    console.error('[shisuiji] 缺少 public 目录，请确认程序完整性');
  process.exit(1);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[shisuiji] 端口 ${PORT} 被占用，拾穗集可能已经在运行了，直接访问 http://localhost:${PORT}`);
    process.exit(1);
  }
  throw err;
});

Promise.all([
  loadData(), loadPapers(), loadMessages(), loadSites(), loadExpenses(), loadInsights(), loadIdeas(),
]).then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`\n  🧺 拾穗集 已启动（监听 ${HOST}:${PORT}）`);
    console.log(`  ➜  本机访问:  http://localhost:${PORT}`);
    console.log(`  ➜  手机同步:  ${APP_CONFIG.token ? '已开启口令校验' : '未设口令（局域网内可直接读写）'}${HOST === '0.0.0.0' ? ' · 已监听局域网' : ''}`);
    console.log(`  ➜  鸡蛋数据:  ${DATA_FILE}`);
    console.log(`  ➜  文献数据:  ${PAPERS_FILE}`);
    console.log(`  ➜  网页数据:  ${SITES_FILE}`);
    console.log(`  ➜  花销数据:  ${EXPENSES_FILE}`);
  console.log(`  ➜  评价数据:  ${INSIGHTS_FILE}`);
  console.log(`  ➜  消息数据:  ${MESSAGES_FILE}`);
  console.log(`  ➜  想法数据:  ${IDEAS_FILE}`);
    console.log(`  ➜  论文库:    ${PAPERS_DIR}`);
    console.log(`  按 Ctrl+C 停止服务\n`);
  });
});
