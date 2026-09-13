/* 拾穗集 —— 前端应用（Vue 3 运行时编译，无构建步骤）
   板块：🥚 赛博鸡蛋（原蛋记） / 📄 文献（论文待读已读管理） */
const { createApp, ref, reactive, computed, onMounted, onUnmounted, nextTick, provide } = Vue;

const CONFIG = window.DANJI_CONFIG;
const HOUR = 3600 * 1000;
const FLASH_MS = 2600; // 定位高亮的持续时长，与 style.css 的 .card.flash 动画（1.3s × 2）对齐

/* ---------------- 工具函数 ---------------- */

// 平台名 → 稳定色相，同平台永远同色
function platformHue(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

// 平台/类别胶囊：只把色相写进 CSS 变量 --h，浅色与深色各自取明度（见 style.css），
// 这样切主题时不用重新渲染列表
function platformStyle(name) {
  return { '--h': String(platformHue(name || '其他')) };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 存储日期 → Date。纯日期（YYYY-MM-DD）按本地时间当天 23:59 解析（截止日当天全天有效），
// 避免 new Date('2026-09-06') 按 UTC 零点解析带来的时区偏差
function parseStoredDate(str) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return new Date(`${str}T23:59:59`);
  return new Date(str);
}

// 展示用日期：同年省略年份，带时间则显示到分钟
function formatDate(str) {
  if (!str) return '';
  const d = parseStoredDate(str);
  if (isNaN(d)) return str;
  const now = new Date();
  const date = `${d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '-'}${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return String(str).length > 10 ? `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : date;
}

// 自由文本 → 截止时间。支持：9-8、9/8、9.8、9月8日、2026-9-8，
// 可选时间 18:00 / 18点 / 18点半 / 晚上8点，支持 今天/明天/后天。
// 不写年份默认今年（月日已过则顺延一年）；只写时间默认今天。
// 返回 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm，识别不了返回 null。
function parseFlexibleDate(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  // 「时间不明」标记：待定/未知等作为一种合法状态，存为哨兵值「待定」
  if (/^(待定|暂定|未知|不清楚|不知道|tbd|\?|？)$/i.test(s)) return '待定';
  const now = new Date();
  let y = now.getFullYear();
  let month = null, day = null, hasYear = false;

  const kw = s.match(/^(今天|今日|明天|明日|后天)/);
  if (kw) {
    const base = new Date(now);
    base.setDate(base.getDate() + { '今天': 0, '今日': 0, '明天': 1, '明日': 1, '后天': 2 }[kw[1]]);
    y = base.getFullYear();
    month = base.getMonth() + 1;
    day = base.getDate();
    s = s.slice(kw[1].length);
  } else {
    const m = s.match(/^(?:(\d{4})[-./年])?(\d{1,2})[-./月](\d{1,2})[日号]?/);
    if (m) {
      if (m[1]) { y = parseInt(m[1], 10); hasYear = true; }
      month = parseInt(m[2], 10);
      day = parseInt(m[3], 10);
      s = s.slice(m[0].length);
    }
  }

  let hour = null, minute = 0;
  // 组1: 上午/晚上等前缀，组2: 时，组3: 半或"数字分"整体，组4: 分钟数字
  const t = s.match(/(上午|早上|凌晨|中午|下午|傍晚|晚上)?\s*(\d{1,2})[点:：时]\s*(半|(\d{1,2})\s*分?)?/);
  if (t) {
    hour = parseInt(t[2], 10);
    minute = t[3] === '半' ? 30 : t[4] ? parseInt(t[4], 10) : 0;
    if (['下午', '傍晚', '晚上'].includes(t[1]) && hour < 12) hour += 12;
  }

  if (month === null && hour === null) return null;
  if (month !== null && (month < 1 || month > 12)) return null;
  if (hour !== null && (hour > 23 || minute > 59)) return null;
  // 没写年份：月日早于今天则视为明年（截止时间一般朝前看）
  if (!kw && !hasYear && month !== null &&
      (month < now.getMonth() + 1 || (month === now.getMonth() + 1 && day < now.getDate()))) {
    y += 1;
  }
  if (month !== null) {
    const probe = new Date(y, month - 1, day);
    if (probe.getMonth() !== month - 1 || probe.getDate() !== day) return null; // 如 2月30日
  } else {
    month = now.getMonth() + 1; // 只写时间 = 今天
    day = now.getDate();
  }
  const dateStr = `${y}-${pad2(month)}-${pad2(day)}`;
  return hour === null ? dateStr : `${dateStr}T${pad2(hour)}:${pad2(minute)}`;
}

function formatRemaining(ms) {
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60000);
  const hours = Math.floor(abs / HOUR);
  const days = Math.floor(abs / (24 * HOUR));
  let text;
  if (days >= 2) text = `${days} 天 ${hours % 24} 小时`;
  else if (hours >= 1) text = `${hours} 小时 ${minutes % 60} 分`;
  else if (minutes >= 1) text = `${minutes} 分钟`;
  else text = '不到 1 分钟';
  return ms >= 0 ? `剩 ${text}` : `已过 ${text}`;
}

// 链接 → 可安全跳转的 URL。只放行 http(s)：没写协议的裸域名补 https://，
// 其它协议（javascript:、weixin:// 等）一律判空，不渲染成可点链接
function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return '';
  return 'https://' + s.replace(/^\/+/, '');
}

// 紧急度核心逻辑：待领取看「领取截止」，已领取看「使用截止」
// level: over 已超时 / red / orange / yellow / unknown 截止待确认 / null 无
// tier 排序：紧急的(0-3) ≈ 已领取截止待确认(3) > 待领取截止待确认(4) > 无截止(pending 5 / claimed 9)
// 已领取的「待定」没有倒计时可看，只能人工核验，所以和黄档同级靠前
function computeUrgency(item, now) {
  let deadlineStr = null;
  let label = '';
  if (item.status === 'pending' && item.claim_deadline) {
    deadlineStr = item.claim_deadline;
    label = '领取截止';
  } else if (item.status === 'claimed' && item.valid_until) {
    deadlineStr = item.valid_until;
    label = '使用截止';
  }
  if (!deadlineStr) {
    return { tier: item.status === 'pending' ? 5 : 9, level: null, label: '', deadline: null, remainingMs: null };
  }
  const deadline = parseStoredDate(deadlineStr);
  // 「待定」等无法解析的截止时间：不算倒计时，只标记待确认（deadline 置 null，
  // 让排序、桌面通知等依赖 deadline 的逻辑天然跳过）
  if (isNaN(deadline.getTime())) {
    // 已领取且使用截止待定：不知道何时过期，需频繁人工核验，排序与黄档(≤7天)同级
    const unknownTier = item.status === 'claimed' ? 3 : 4;
    return { tier: unknownTier, level: 'unknown', label, deadline: null, remainingMs: null };
  }
  const remainingMs = deadline - now;
  let tier, level;
  if (remainingMs < 0) { tier = 0; level = 'over'; }
  else if (remainingMs <= CONFIG.urgent.red * HOUR) { tier = 1; level = 'red'; }
  else if (remainingMs <= CONFIG.urgent.orange * HOUR) { tier = 2; level = 'orange'; }
  else if (remainingMs <= CONFIG.urgent.yellow * HOUR) { tier = 3; level = 'yellow'; }
  else { tier = item.status === 'pending' ? 5 : 9; level = null; }
  return { tier, level, label, deadline, remainingMs };
}

function statusMeta(id) {
  return CONFIG.statuses.find((s) => s.id === id) || CONFIG.statuses[0];
}
function typeMeta(id) {
  return CONFIG.types.find((t) => t.id === id) || CONFIG.types[CONFIG.types.length - 1];
}

/* ---- 文献阅读记录：词表查询与摘要 ---- */
const NOTE_TEXT_FIELDS = [
  'problem', 'method', 'finding', 'usable', 'quotable', 'next', 'limits', 'impression', 'excerpt',
];
function noteRelMeta(id) {
  return CONFIG.paperNote.relevance.find((r) => r.id === id) || null;
}
function notePartLabel(id) {
  const p = CONFIG.paperNote.parts.find((x) => x.id === id);
  return p ? p.label : '';
}
function notePartsText(log) {
  return (log.parts || []).map(notePartLabel).filter(Boolean);
}
function blankPaperLog() {
  const log = { id: '', read_at: todayStr(), rel: '', parts: [] };
  for (const f of NOTE_TEXT_FIELDS) log[f] = '';
  return log;
}
function noteIsEmpty(log) {
  return !NOTE_TEXT_FIELDS.some((f) => String(log[f] || '').trim()) && !(log.parts || []).length;
}
// 卡片上显示的一行摘要：核心发现 → 一句话感受 → 我能借鉴 → 核心做法 → 核心问题
function noteSummary(log) {
  if (!log) return '';
  for (const f of ['finding', 'impression', 'usable', 'method', 'problem']) {
    const v = String(log[f] || '').trim();
    if (v) return v;
  }
  return '';
}

/* ---- 列表排序：按「最近阅读时间」刷新，没读过就按添加时间（文献与网页共用） ---- */
// 最近一次阅读时间（毫秒）= 点「📖 阅读 / 🌐 打开」记下的 last_read_at 与笔记里手填的「读完日期」取较大者；
// 从没读过返回 0。日期串解析不了就忽略那一条，不参与比较。
function readSortTime(item) {
  let best = 0;
  const clicked = Date.parse(item.last_read_at || '');
  if (!isNaN(clicked)) best = clicked;
  for (const log of item.logs || []) {
    if (!log || !log.read_at) continue;
    const t = parseStoredDate(log.read_at).getTime(); // 纯日期按当天 23:59
    if (!isNaN(t) && t > best) best = t;
  }
  return best;
}
// 列表排序键：阅读时间优先（点过阅读的立刻置顶），没读过的回落到「添加时间」
function readSortKey(item) {
  return Math.max(Date.parse(item.created_at || '') || 0, readSortTime(item));
}

/* ---- 网页笔记：词表查询、摘要、归档门槛 ---- */
function kindMeta(id) {
  return CONFIG.siteNote.kinds.find((k) => k.id === id) || CONFIG.siteNote.kinds[0];
}
function usageMeta(id) {
  return CONFIG.siteNote.usage.find((u) => u.id === id) || null;
}
// 所有网页笔记字段（两套类型合起来，用于生成空表单和搜索）
function siteNoteKeys() {
  return Object.values(CONFIG.siteNote.fields).flat().map((f) => f.key);
}
// 表单要渲染的字段 = 共用 + 当前所选类型专属
function siteNoteFields(kind) {
  const f = CONFIG.siteNote.fields;
  return [...f.common, ...(f[kind] || f.tech)];
}
function siteNoteFieldLabel(key) {
  const hit = Object.values(CONFIG.siteNote.fields).flat().find((f) => f.key === key);
  if (!hit) return key;
  return hit.label.replace(/^\S+\s*/, ''); // 去掉开头的 emoji，用于提示文案
}
function blankSiteNote(kind) {
  const log = { id: '', read_at: todayStr(), kind: kind || 'tech', usage: '' };
  for (const key of siteNoteKeys()) log[key] = '';
  return log;
}
function siteNoteIsEmpty(log) {
  return !String(log.usage || '').trim() && !siteNoteKeys().some((k) => String(log[k] || '').trim());
}
// 归档门槛：技术严（一句话 + 关键做法 + 结论）、杂项松（一句话）
function siteNoteMissing(log) {
  const gate = CONFIG.siteNote.gate[log.kind] || CONFIG.siteNote.gate.tech;
  return gate.filter((k) => !String(log[k] || '').trim());
}
// 卡片上露的一行摘要：一句话 → 关键事实 → 结论 → 做法 → 摘抄
function siteNoteSummary(log) {
  if (!log) return '';
  for (const k of ['gist', 'facts', 'finding', 'method', 'excerpt', 'credibility']) {
    const v = String(log[k] || '').trim();
    if (v) return v;
  }
  return '';
}
// 笔记里真正填了内容的字段（按 schema 顺序），列表模式逐行展示
function siteNoteRows(log) {
  return siteNoteFields(log.kind).filter((f) => String(log[f.key] || '').trim());
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/* ---- 读完的门槛与草稿 ---- */
// 「读完」的判定：三行速记都写了才算完成基本记录
const NOTE_BASIC_FIELDS = ['problem', 'method', 'finding'];
const NOTE_FIELD_LABEL = { problem: '核心问题', method: '核心做法', finding: '核心发现' };
function noteBasicMissing(log) {
  return NOTE_BASIC_FIELDS.filter((f) => !String(log[f] || '').trim());
}

// 没写完的笔记存本地草稿（按记录 id + 命名空间），下次打开自动带回；不产生正式记录
const LOG_DRAFT_PREFIX = 'danji.logDraft.';       // 文献笔记（键名保持不变，老草稿还在）
const SITE_DRAFT_PREFIX = 'danji.siteNoteDraft.'; // 网页笔记
function readDraft(prefix, id) {
  try {
    const raw = localStorage.getItem(prefix + id);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function writeDraft(prefix, id, form, isEmpty) {
  try {
    if (!id || !form) return;
    if (isEmpty(form)) localStorage.removeItem(prefix + id); // 全空就别留空壳
    else localStorage.setItem(prefix + id, JSON.stringify({
      ...form, parts: [...(form.parts || [])], saved_at: new Date().toISOString(),
    }));
  } catch (e) {}
}
function clearDraft(prefix, id) {
  try { localStorage.removeItem(prefix + id); } catch (e) {}
}

/* ---- 花销：金额、期间与饼图 ---- */
// 金额输入容错：¥ / ￥ / 千分位 / 空格都能吃；负数与非法值返回 null
function parseAmountInput(raw) {
  const cleaned = String(raw == null ? '' : raw).replace(/[¥￥,，\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}
// 金额显示：¥1,280 / ¥1,280.50（整数不留小数）
function formatMoney(n) {
  const v = Number(n);
  const abs = Number.isFinite(v) ? Math.abs(Math.round(v * 100) / 100) : 0;
  const text = abs.toLocaleString('zh-CN', {
    minimumFractionDigits: Number.isInteger(abs) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${v < 0 ? '-' : ''}${CONFIG.expenses.currency}${text}`;
}
// 记录日期 → 'YYYY-MM'（期间分组用）
function monthOf(dateStr) {
  const s = String(dateStr || '');
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : '';
}
function periodLabel(period) {
  return period.mode === 'year' ? `${period.year} 年` : `${period.year} 年 ${period.month} 月`;
}
// 新记一笔时的默认日期：当前所选期间就是本月（今年）→ 今天；否则给该期间的第一天。
// 补记过去的账多半记不清具体哪天，先落在当月/当年，改日子比翻月份快。
function defaultExpenseDate(period, today) {
  const t = today || todayStr();
  if (!period) return t;
  const ty = Number(t.slice(0, 4));
  const tm = Number(t.slice(5, 7));
  if (period.mode === 'year') {
    return period.year === ty ? t : `${period.year}-01-01`;
  }
  if (period.year === ty && period.month === tm) return t;
  return `${period.year}-${pad2(period.month)}-01`;
}
// 按标题猜类别（规则与 server.js 的 guessExpenseCategory 一致）：按 categories 顺序匹配关键词，都没命中兜底第一个类别
function guessExpenseCategory(title) {
  const s = String(title || '').toLowerCase();
  const cats = CONFIG.expenses.categories;
  for (const c of cats) {
    if ((c.keywords || []).some((k) => s.includes(k))) return c.id;
  }
  return cats[0].id;
}
function expenseCategoryMeta(id) {
  return CONFIG.expenses.categories.find((c) => c.id === id) || CONFIG.expenses.categories[0];
}
// 年视图的类别层：先把期间内记录按类别汇总，再走同一套饼图逻辑（占比 / 补满 / 排序 / 零值过滤都复用）
function buildCategorySlices(items) {
  const rows = CONFIG.expenses.categories.map((c) => ({
    id: c.id,
    title: `${c.emoji} ${c.label}`,
    hue: c.hue,
    amount: (items || []).filter((e) => e.category === c.id).reduce((sum, e) => sum + (Number(e.amount) || 0), 0),
  }));
  return buildPieSlices(rows, rows.length);
}
// 年视图逐笔层：同名记录合并成一笔（按年看的是「这一年在这个名目上花了多少」，
// 同一个名字多次充值不用分开）；颜色按名字稳定生成，同名每次刷新同色
function groupExpenseByTitle(items) {
  const groups = new Map();
  for (const e of items || []) {
    const title = String(e.title || '').trim().replace(/\s+/g, ' ') || '未命名';
    const key = title.toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = { id: `title:${key}`, title, hue: platformHue(`title:${key}`), amount: 0, count: 0 };
      groups.set(key, g);
    }
    g.amount += Number(e.amount) || 0;
    g.count += 1;
  }
  return [...groups.values()];
}
// 饼图数据：每笔记录一个扇区（按金额倒序）；超过 maxSlices 时把最小的若干笔合并成「其余 N 笔」
function buildPieSlices(items, maxSlices) {
  const limit = Math.max(2, Number(maxSlices) || 24);
  const rows = (items || [])
    // count 是年视图同名合并后的笔数（逐笔记录没有），一并带下去给图例显示 ×N
    .map((e) => ({ id: e.id, title: String(e.title || '未命名'), amount: Number(e.amount) || 0, hue: e.hue, count: e.count }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount || String(a.title).localeCompare(String(b.title), 'zh'));
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  if (!total) return { slices: [], total: 0, merged: 0 };
  let kept = rows;
  let merged = 0;
  if (rows.length > limit) {
    kept = rows.slice(0, limit - 1);
    const rest = rows.slice(limit - 1);
    merged = rest.length;
    kept = [...kept, {
      id: '__rest__',
      title: `其余 ${merged} 笔`,
      merged: true,
      amount: rest.reduce((sum, r) => sum + r.amount, 0),
    }];
  }
  let acc = 0;
  const slices = kept.map((r, i) => {
    const pct = (r.amount / total) * 100;
    const from = acc;
    acc += pct;
    const to = i === kept.length - 1 ? 100 : acc; // 最后一个补到 100%，避免累积误差留下缝隙
    // 行数据自带色相就用它（类别层固定颜色），否则按 id 稳定取色（逐笔层）
    return { ...r, pct, from, to, hue: r.hue !== undefined ? r.hue : platformHue(r.id) };
  });
  return { slices, total, merged };
}

/* ---- 花销：体感评价（主体识别与摘录凝练全在前端算，server 只存用户敲定的结论） ---- */
// 一笔花销是否认领到某个主体：标题或备注（小写化）包含任一关键词即命中
function expenseHitsSubject(expense, subject) {
  const text = `${expense.title || ''}\n${expense.notes || ''}`.toLowerCase();
  return (subject.keywords || []).some((k) => text.includes(k.toLowerCase()));
}
// 一笔花销命中了 config 里的哪些主体（一笔可以同时喂多家，备注里点名谁就算谁的）
function matchSubjects(expense) {
  return CONFIG.expenses.subjects.filter((s) => expenseHitsSubject(expense, s));
}
// 把备注切成句子：按中英文句读和换行切开，太短的碎片丢掉（不然「嗯」「好」也占一行）
function splitSentences(text) {
  return String(text || '')
    .split(/[。！？!?；;\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}
// 摘录打标：按 config 的顺序先中先用（价格 → 决策），都没命中归「体验」；
// 目的是把「token 价格 / 划不划算」这类句子一眼扫出来
function quoteTagOf(sentence) {
  const s = String(sentence).toLowerCase();
  for (const t of CONFIG.expenses.insightTags) {
    if ((t.keywords || []).some((k) => s.includes(k))) return t;
  }
  return CONFIG.expenses.insightDefaultTag;
}
// 从一笔花销里挑出与主体相关的句子：
//   句子本身提到主体关键词 → 必收（哪怕标题不是它，备注里点名了也算数）；
//   标题命中主体时 → 提到价格 / 决策词的句子也收；实在没有就收首句兜底，保证有话可看
function pickQuotes(expense, subject) {
  const sentences = splitSentences(expense.notes);
  if (!sentences.length) return [];
  const titleHit = (subject.keywords || []).some((k) => String(expense.title || '').toLowerCase().includes(k.toLowerCase()));
  const picked = sentences.filter((s) => {
    const low = s.toLowerCase();
    if ((subject.keywords || []).some((k) => low.includes(k.toLowerCase()))) return true;
    if (!titleHit) return false;
    return CONFIG.expenses.insightTags.some((t) => (t.keywords || []).some((k) => low.includes(k)));
  });
  if (!picked.length && titleHit) picked.push(sentences[0]);
  return picked.map((s) => ({ sentence: s, tag: quoteTagOf(s).id }));
}
// 汇总一个主体的全部素材：累计花费、笔数、类别拆分、最近一笔、原话摘录（新 → 旧，封顶 6 条）
function buildSubjectInsight(subject, expenses) {
  const matched = (expenses || []).filter((e) => expenseHitsSubject(e, subject));
  const byCategory = new Map();
  let total = 0;
  let last = null;
  const quotes = [];
  for (const e of matched) {
    const amount = Number(e.amount) || 0;
    total += amount;
    byCategory.set(e.category, (byCategory.get(e.category) || 0) + amount);
    if (!last || String(e.date).localeCompare(String(last.date)) > 0) last = e;
    for (const q of pickQuotes(e, subject)) {
      quotes.push({ ...q, date: e.date, amount, title: e.title });
    }
  }
  quotes.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return {
    subject,
    total,
    count: matched.length,
    categorySplit: [...byCategory].map(([id, amount]) => ({ id, amount })),
    lastDate: last ? last.date : '',
    quotes: quotes.slice(0, CONFIG.expenses.maxQuotes || 6),
    quoteTotal: quotes.length,
  };
}
// 由素材拼一段总评草稿：一句合计 + 带日期的要点摘录，填进总评框让用户改成自己的话
function buildVerdictDraft(insight) {
  if (!insight.count) return '';
  const head = `累计 ${formatMoney(insight.total)} / ${insight.count} 笔`
    + (insight.lastDate ? `，最近 ${formatDate(insight.lastDate)}` : '') + '。';
  const points = insight.quotes.slice(0, 4).map((q) => `- ${String(q.date).slice(5)}：${q.sentence}`);
  return [head, ...points].join('\n');
}

/* ---------------- 组件：蛋卡片 ---------------- */
const EggCard = {
  name: 'EggCard',
  props: { activity: { type: Object, required: true }, now: { type: Number, required: true }, flash: Boolean },
  emits: ['edit', 'remove', 'status'],
  setup(props, { emit }) {
    const { computed, ref } = Vue;
    const expanded = ref(false);

    const urgency = computed(() => computeUrgency(props.activity, props.now));
    const status = computed(() => statusMeta(props.activity.status));
    const type = computed(() => typeMeta(props.activity.type));
    const isOverdue = computed(() => props.activity.status === 'pending' && urgency.value.level === 'over');
    // 没有明确领取截止（为空 /「待定」/ 看不懂）的待领取蛋永远不会自动流转，
    // 常驻一个「错过了」按钮，什么时候想清掉它都行
    const canMissManually = computed(() => {
      if (props.activity.status !== 'pending') return false;
      const d = props.activity.claim_deadline;
      return !d || d === '待定' || isNaN(parseStoredDate(d).getTime());
    });

    const deadlineText = computed(() => {
      if (!props.activity.claim_deadline) return '';
      if (props.activity.claim_deadline === '待定') return '⏰ 领取截止待确认 ❓';
      const base = `⏰ 领取截止 ${formatDate(props.activity.claim_deadline)}`;
      if (props.activity.status === 'pending' && urgency.value.remainingMs !== null) {
        return `${base} · ${formatRemaining(urgency.value.remainingMs)}`;
      }
      return base;
    });
    const validText = computed(() => {
      if (!props.activity.valid_until) return '';
      if (props.activity.valid_until === '待定') return '⏳ 使用截止待确认 ❓';
      return `⏳ 使用截止 ${formatDate(props.activity.valid_until)}`;
    });

    // 有链接就有直达按钮：待领取去领，已领取去查用量，其余状态只是打开链接
    const linkUrl = computed(() => normalizeUrl(props.activity.link));
    const linkLabel = computed(() => ({
      pending: '🚀 去领取',
      claimed: '🔍 查用量',
    }[props.activity.status] || '↗ 打开链接'));

    function openLink() {
      if (linkUrl.value) window.open(linkUrl.value, '_blank', 'noopener');
    }

    return {
      expanded, urgency, status, type, isOverdue, canMissManually, deadlineText, validText,
      linkUrl, linkLabel, openLink, platformStyle, formatDate,
      emitEdit: () => emit('edit'), emitRemove: () => emit('remove'),
      emitStatus: (s) => emit('status', s),
    };
  },
  template: `
  <article class="card" :class="['lv-' + (urgency.level || 'none'), 'st-' + activity.status, { flash, expanded }]"
           @click="expanded = !expanded">
    <div class="card-head">
      <span class="platform" :style="platformStyle(activity.platform)">{{ activity.platform }}</span>
      <h3 class="title">{{ activity.title }}</h3>
      <span class="status-badge" :class="'st-' + activity.status">{{ status.emoji }} {{ status.label }}</span>
    </div>

    <div class="meta">
      <span class="chip value-chip" v-if="activity.value">{{ type.icon }} {{ activity.value }}</span>
      <span class="chip">{{ type.label }}</span>
      <span class="chip tag" v-for="tag in activity.tags" :key="tag">#{{ tag }}</span>
    </div>

    <div class="deadline-lines">
      <div class="deadline" :class="'lv-' + (urgency.level || 'none')" v-if="deadlineText">
        {{ deadlineText }}
        <span class="overdue-warn" v-if="isOverdue">⚠️ 可能已过期，点下方按钮确认</span>
      </div>
      <div class="deadline" v-if="validText" :class="{ soon: activity.status === 'claimed' && urgency.level && urgency.level !== 'unknown' }">{{ validText }}</div>
    </div>

    <div class="expand-body" v-if="expanded">
      <p v-if="activity.claim_steps"><b>🧭 领取方法：</b><span class="pre-wrap">{{ activity.claim_steps || '—' }}</span></p>
      <p v-if="activity.notes"><b>📝 备注：</b><span class="pre-wrap">{{ activity.notes }}</span></p>
      <p v-if="linkUrl"><b>🔗 链接：</b><a :href="linkUrl" target="_blank" rel="noopener" @click.stop>{{ activity.link }}</a></p>
      <p v-if="!activity.claim_steps && !activity.notes && !linkUrl" class="muted">没有更多细节</p>
    </div>

    <div class="card-actions" @click.stop>
      <button class="btn small primary" v-if="activity.link" @click="openLink">{{ linkLabel }}</button>
      <template v-if="isOverdue">
        <button class="btn small ghost" @click="emitStatus('claimed')">✅ 其实领到了</button>
        <button class="btn small ghost" @click="emitStatus('missed')">😢 错过了</button>
      </template>
      <template v-else-if="activity.status === 'missed'">
        <!-- 自动移入「已错过」可能误判（其实领到了只是没记），留个一键改回的口子 -->
        <button class="btn small ghost" @click="emitStatus('claimed')">✅ 其实领到了</button>
      </template>
      <template v-else>
        <button class="btn small" :class="activity.link ? 'ghost' : 'primary'"
                v-if="activity.status === 'pending'" @click="emitStatus('claimed')">🧺 已领取</button>
        <button class="btn small ghost" v-if="canMissManually" @click="emitStatus('missed')">😢 错过了</button>
        <button class="btn small ghost" v-if="activity.status === 'claimed'" @click="emitStatus('used')">🏁 用完了</button>
      </template>
      <span class="spacer"></span>
      <button class="btn small ghost" @click="emitEdit">✏️ 编辑</button>
      <button class="btn small danger" @click="emitRemove">🗑</button>
    </div>
  </article>
  `,
};

/* ---------------- 组件：新增 / 编辑抽屉 ---------------- */
const EggEditor = {
  name: 'EggEditor',
  props: {
    initial: { type: Object, default: null },
    // 已在数据里出现过的平台，和 config 常用列表合并做建议
    knownPlatforms: { type: Array, default: () => [] },
    // 保存请求进行中（父组件 saveActivity 在 fetch 期间置 true）
    saving: Boolean,
  },
  emits: ['save', 'close'],
  setup(props, { emit }) {
    const { reactive, computed, onMounted, onUnmounted, nextTick, ref } = Vue;
    const titleInput = ref(null);
    const lastPlatform = localStorage.getItem('danji.lastPlatform') || CONFIG.platforms[0];

    // 记录类型：claim 待领取 / use 待使用。新建沿用上次选择，编辑按当前状态定位
    const mode = ref(props.initial
      ? (props.initial.status === 'pending' ? 'claim' : 'use')
      : (localStorage.getItem('danji.lastEggKind') === 'use' ? 'use' : 'claim'));

    const form = reactive({
      platform: props.initial?.platform || lastPlatform,
      title: props.initial?.title || '',
      type: props.initial?.type || 'free_credits',
      value: props.initial?.value || '',
      claim_deadline: props.initial?.claim_deadline || '',
      valid_until: props.initial?.valid_until || '',
      claim_steps: props.initial?.claim_steps || '',
      link: props.initial?.link || '',
      status: props.initial?.status || 'pending',
      tagsText: (props.initial?.tags || []).join(', '),
      notes: props.initial?.notes || '',
    });

    // ---- 平台自定义下拉（替代不可靠的原生 datalist）----
    const comboOpen = ref(false);
    const comboIndex = ref(-1);
    const comboRoot = ref(null);
    const platformInput = ref(null);
    // 点箭头强制看全量；一旦继续输入就恢复过滤
    const comboShowAll = ref(false);

    // 建议列表：config 常用在前，已用平台补充在后，去重
    const platformSuggestions = computed(() => {
      const seen = new Set();
      const out = [];
      for (const p of [...CONFIG.platforms, ...props.knownPlatforms]) {
        const v = String(p || '').trim();
        if (!v) continue;
        const key = v.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
      }
      return out;
    });

    const filteredPlatforms = computed(() => {
      if (comboShowAll.value) return platformSuggestions.value;
      const q = String(form.platform || '').trim().toLowerCase();
      if (!q) return platformSuggestions.value;
      return platformSuggestions.value.filter((p) => p.toLowerCase().includes(q));
    });

    function openCombo(opts) {
      comboOpen.value = true;
      comboIndex.value = -1;
      comboShowAll.value = !!(opts && opts.showAll);
    }
    function toggleCombo() {
      if (comboOpen.value) closeCombo();
      else openCombo({ showAll: true });
    }
    function closeCombo() {
      comboOpen.value = false;
      comboIndex.value = -1;
      comboShowAll.value = false;
    }
    function pickPlatform(p) {
      form.platform = p;
      closeCombo();
      // 聚焦输入框方便继续改，但别触发 focus → 再次 openCombo
      suppressFocusOpen = true;
      platformInput.value && platformInput.value.focus();
    }
    function highlightNext() {
      if (!comboOpen.value) { openCombo(); return; }
      const n = filteredPlatforms.value.length;
      if (!n) return;
      comboIndex.value = comboIndex.value < n - 1 ? comboIndex.value + 1 : 0;
      scrollComboItemIntoView();
    }
    function highlightPrev() {
      if (!comboOpen.value) { openCombo(); return; }
      const n = filteredPlatforms.value.length;
      if (!n) return;
      comboIndex.value = comboIndex.value > 0 ? comboIndex.value - 1 : n - 1;
      scrollComboItemIntoView();
    }
    // 键盘换高亮时保证项在可视区内（列表长了以后不至于划出 max-height）
    async function scrollComboItemIntoView() {
      await nextTick();
      const menu = comboRoot.value && comboRoot.value.querySelector('.combo-menu');
      if (!menu) return;
      const item = menu.children[comboIndex.value];
      if (item && item.scrollIntoView) item.scrollIntoView({ block: 'nearest' });
    }
    function onComboEnter(e) {
      // 只有真的要选中高亮项时才拦 Enter；否则留给表单提交
      if (comboOpen.value && comboIndex.value >= 0) {
        const p = filteredPlatforms.value[comboIndex.value];
        if (p) {
          e.preventDefault();
          pickPlatform(p);
        }
      }
    }
    // 选中后主动 focus 时不要立刻把列表再拉开
    let suppressFocusOpen = false;
    function onComboFocus() {
      if (suppressFocusOpen) {
        suppressFocusOpen = false;
        return;
      }
      openCombo();
    }
    function onComboInput() { openCombo(); }
    // Esc：仅在列表打开时拦截；关着时放行给抽屉关闭逻辑
    function onComboEsc(e) {
      if (!comboOpen.value) return;
      e.preventDefault();
      e.stopPropagation();
      closeCombo();
    }
    // 点组件外部收起（mousedown 先于 blur，避免列表闪一下再关）
    function onDocMousedown(e) {
      if (!comboOpen.value) return;
      if (comboRoot.value && comboRoot.value.contains(e.target)) return;
      closeCombo();
    }

    // 切换记蛋类型：待领取 ↔ 待使用，联动状态；被隐藏字段的已有值保留不丢
    function switchMode(next) {
      mode.value = next;
      form.status = next === 'claim' ? 'pending' : 'claimed';
    }
    // 编辑时的状态下拉与切换器联动
    function onStatusChange() {
      mode.value = form.status === 'pending' ? 'claim' : 'use';
    }

    // 截止时间实时解析预览，返回 null 时不显示提示
    const dateError = ref('');
    function preview(raw) {
      const v = String(raw || '').trim();
      if (!v) return null;
      if (v === '待定') return { state: 'ok', text: '→ 截止时间待确认，卡片会显示「待确认 ❓」并进横幅提醒' };
      const parsed = parseFlexibleDate(raw);
      return parsed
        ? { state: 'ok', text: `→ ${parsed.replace('T', ' ')}` }
        : { state: 'bad', text: '看不懂这个日期，试试 9-8、9/8 18:00、明天 14点' };
    }
    const claimPreview = computed(() => preview(form.claim_deadline));
    const validPreview = computed(() => preview(form.valid_until));
    // 一键标记/取消「截止时间待定」
    function markUnknown(field) {
      form[field] = form[field] === '待定' ? '' : '待定';
    }

    function save() {
      if (!form.platform.trim()) return alert('请填写平台名称');
      if (!form.title.trim()) return alert('请填写活动名称');
      for (const field of ['claim_deadline', 'valid_until']) {
        if (String(form[field] || '').trim() && !parseFlexibleDate(form[field])) {
          dateError.value = field; // 识别不了就拦截，让用户改写或清空
          return;
        }
      }
      dateError.value = '';
      localStorage.setItem('danji.lastPlatform', form.platform.trim());
      if (!props.initial) localStorage.setItem('danji.lastEggKind', mode.value);
      emit('save', {
        platform: form.platform.trim(),
        title: form.title.trim(),
        type: form.type,
        value: form.value.trim(),
        claim_deadline: form.claim_deadline.trim() ? parseFlexibleDate(form.claim_deadline) : null,
        valid_until: form.valid_until.trim() ? parseFlexibleDate(form.valid_until) : null,
        claim_steps: form.claim_steps.trim(),
        link: form.link.trim(),
        status: form.status,
        tags: form.tagsText.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
        notes: form.notes.trim(),
      });
    }
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // 下拉开着时 Esc 只收列表，不关整个抽屉
      if (comboOpen.value) { closeCombo(); return; }
      emit('close');
    };
    onMounted(async () => {
      window.addEventListener('keydown', onKey);
      document.addEventListener('mousedown', onDocMousedown);
      await nextTick();
      titleInput.value && titleInput.value.focus();
    });
    onUnmounted(() => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDocMousedown);
    });

    // 只有按下和松开都发生在遮罩空白处才关闭——
    // 从面板里圈选文字拖到面板外松手，click 会落在遮罩上，但不能算关闭意图
    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      form, save, titleInput, CONFIG, mode, switchMode, onStatusChange,
      claimPreview, validPreview, dateError, markUnknown,
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
      comboOpen, comboIndex, comboRoot, platformInput, filteredPlatforms,
      toggleCombo, pickPlatform, highlightNext, highlightPrev, onComboEnter,
      onComboFocus, onComboInput, onComboEsc, closeCombo,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>{{ initial ? '✏️ 编辑蛋' : (mode === 'claim' ? '🥚 记待领取的蛋' : '🧺 记待使用的蛋') }}</h2>
        <button class="btn ghost small" @click="close">✕</button>
      </header>
      <form class="drawer-form" @submit.prevent="save">
        <div class="seg">
          <button type="button" :class="{ active: mode === 'claim' }" @click="switchMode('claim')">🥚 待领取</button>
          <button type="button" :class="{ active: mode === 'use' }" @click="switchMode('use')">🧺 待使用</button>
        </div>
        <label>平台 *
          <div class="combo" ref="comboRoot">
            <div class="combo-control">
              <input ref="platformInput" v-model="form.platform"
                     placeholder="如 Kimi / Gemini / 即梦…"
                     autocomplete="off"
                     role="combobox" :aria-expanded="comboOpen ? 'true' : 'false'"
                     @focus="onComboFocus" @input="onComboInput"
                     @keydown.down.prevent="highlightNext"
                     @keydown.up.prevent="highlightPrev"
                     @keydown.enter="onComboEnter"
                     @keydown.esc="onComboEsc">
              <button type="button" class="combo-arrow" tabindex="-1"
                      :aria-expanded="comboOpen ? 'true' : 'false'"
                      aria-label="打开平台列表"
                      @click.stop="toggleCombo">▼</button>
            </div>
            <ul class="combo-menu" v-if="comboOpen && filteredPlatforms.length" role="listbox">
              <li v-for="(p, i) in filteredPlatforms" :key="p"
                  role="option" :class="{ on: i === comboIndex }"
                  @mouseenter="comboIndex = i"
                  @mousedown.prevent="pickPlatform(p)">{{ p }}</li>
            </ul>
          </div>
        </label>
        <label>活动名称 *
          <input ref="titleInput" v-model="form.title" placeholder="如：开学季 Pro 月卡 5 折"></label>
        <div class="row">
          <label>优惠形式
            <select v-model="form.type">
              <option v-for="t in CONFIG.types" :key="t.id" :value="t.id">{{ t.icon }} {{ t.label }}</option>
            </select>
          </label>
          <label>优惠力度
            <input v-model="form.value" placeholder="如：50 元额度 / 7 折"></label>
        </div>
        <label v-if="mode === 'claim'">⏰ 领取截止
          <div class="field-line">
            <input type="text" v-model="form.claim_deadline" :class="{ invalid: dateError === 'claim_deadline' }"
                   placeholder="如：9-8、9/8 18:00、明天 14点（可不填年份）" @input="dateError = ''">
            <button type="button" class="mini-link" @click="markUnknown('claim_deadline')" title="不清楚截止时间就先标记待定，之后卡片会提醒你确认">❓ 待定</button>
          </div>
          <span class="date-hint" v-if="claimPreview" :class="claimPreview.state">{{ claimPreview.text }}</span>
        </label>
        <label v-else>⏳ 使用截止
          <div class="field-line">
            <input type="text" v-model="form.valid_until" :class="{ invalid: dateError === 'valid_until' }"
                   placeholder="如：10-1、12月31日 23:59（可不填年份）" @input="dateError = ''">
            <button type="button" class="mini-link" @click="markUnknown('valid_until')" title="不清楚截止时间就先标记待定，之后卡片会提醒你确认">❓ 待定</button>
          </div>
          <span class="date-hint" v-if="validPreview" :class="validPreview.state">{{ validPreview.text }}</span>
        </label>
        <label v-if="mode === 'claim'">🧭 领取方法
          <textarea v-model="form.claim_steps" rows="3" placeholder="一步步写清楚，如：登录 → 个人中心 → 活动页点击领取"></textarea></label>
        <label>🔗 活动链接
          <input v-model="form.link" placeholder="https://…"></label>
        <label v-if="initial">状态
          <select v-model="form.status" @change="onStatusChange">
            <option v-for="s in CONFIG.statuses" :key="s.id" :value="s.id">{{ s.emoji }} {{ s.label }}</option>
          </select>
        </label>
        <label>🏷️ 标签
          <input v-model="form.tagsText" placeholder="逗号分隔，如：新用户, 限时"></label>
        <label>📝 备注
          <textarea v-model="form.notes" rows="2" placeholder="额度多少、注意事项…"></textarea></label>
        <footer class="drawer-foot">
          <button type="button" class="btn ghost" @click="close">取消</button>
          <button type="submit" class="btn primary" :disabled="saving">{{ saving ? '⏳ 保存中…' : '💾 保存' }}</button>
        </footer>
      </form>
    </aside>
  </div>
  `,
};

/* ---------------- 组件：论文卡片 ---------------- */
const PaperCard = {
  name: 'PaperCard',
  props: { paper: { type: Object, required: true }, flash: Boolean },
  emits: ['open', 'reveal', 'status', 'edit', 'remove', 'log', 'read'],
  setup(props, { emit }) {
    const { computed } = Vue;
    const isRead = computed(() => props.paper.status === 'read');
    const catStyle = computed(() => platformStyle(props.paper.category || '未分类'));
    const fileMissing = computed(() => !!props.paper.file_name && props.paper.file_exists === false);
    // 最近一次点「📖 阅读」的时间（列表就是按它排的，写在卡片上让人看得懂顺序）
    const lastReadText = computed(() => (props.paper.last_read_at ? formatDate(props.paper.last_read_at) : ''));

    // 阅读记录：按读完日期倒序，卡片上只露最新一条的摘要
    const logs = computed(() => [...(props.paper.logs || [])]
      .sort((a, b) => String(b.read_at || '').localeCompare(String(a.read_at || ''))));
    const logCount = computed(() => logs.value.length);
    const latestLog = computed(() => logs.value[0] || null);
    const logSummary = computed(() => noteSummary(latestLog.value));
    const relMeta = computed(() => (latestLog.value ? noteRelMeta(latestLog.value.rel) : null));

    return {
      isRead, catStyle, fileMissing, lastReadText, logs, logCount, latestLog, logSummary, relMeta,
      emitOpen: () => emit('open'),
      emitReveal: () => emit('reveal'),
      emitStatus: (s) => emit('status', s),
      emitEdit: () => emit('edit'),
      emitRemove: () => emit('remove'),
      emitLog: () => emit('log', logCount.value ? 'list' : 'new'),
      emitRead: () => emit('read'),
    };
  },
  template: `
  <article class="card paper-card" :class="{ 'is-read': isRead, flash }">
    <div class="card-head">
      <span class="platform" :style="catStyle">{{ paper.category || '未分类' }}</span>
      <h3 class="title">{{ paper.title }}</h3>
      <span class="status-badge" :class="isRead ? 'st-read' : 'st-to_read'">{{ isRead ? '✅ 已读' : '📖 待读' }}</span>
    </div>
    <div class="paper-file" v-if="paper.file_name" :title="paper.file_name">
      📎 {{ paper.file_name }}<span class="file-missing" v-if="fileMissing">⚠️ 文件不在预期位置</span>
    </div>
    <div class="paper-file" v-else>未关联文件（仅记录）</div>
    <div class="read-stamp" v-if="lastReadText" title="最近一次点「阅读」的时间，列表按它排序">🕘 最近阅读 {{ lastReadText }}</div>
    <p class="paper-notes" v-if="paper.notes" :title="paper.notes">📝 {{ paper.notes }}</p>

    <!-- 阅读记录：读完才有，卡片上只露最新一条的摘要 -->
    <div class="paper-log" v-if="isRead && logCount" @click.stop="emitLog" title="点开看全部阅读记录">
      <span class="rel-badge" :class="'rel-' + latestLog.rel" v-if="relMeta">{{ relMeta.emoji }} {{ relMeta.label }}</span>
      <span class="paper-log-line" v-if="logSummary">{{ logSummary }}</span>
      <span class="paper-log-line muted" v-else>（最新一条还没写内容）</span>
      <span class="log-count" v-if="logCount > 1">共 {{ logCount }} 条</span>
    </div>
    <div class="paper-log log-hint" v-else-if="isRead" @click.stop="emitLog" title="点这里补一条阅读记录">
      📝 还没记阅读记录，点这里补一条
    </div>

    <div class="card-actions" @click.stop>
      <button class="btn small primary" v-if="paper.file_name && !fileMissing" @click="emitOpen">📖 阅读</button>
      <button class="btn small ghost" v-if="paper.file_name && !fileMissing" @click="emitReveal">📁 所在位置</button>
      <button class="btn small ghost" v-if="!isRead" @click="emitRead">✅ 读完了</button>
      <button class="btn small ghost" v-else @click="emitStatus('to_read')">↩️ 移回待读</button>
      <button class="btn small ghost" v-if="isRead" @click="emitLog">{{ logCount ? '📝 记录 ' + logCount : '📝 记一条' }}</button>
      <span class="spacer"></span>
      <button class="btn small ghost" @click="emitEdit">✏️ 编辑</button>
      <button class="btn small danger" @click="emitRemove">🗑</button>
    </div>
  </article>
  `,
};

/* ---------------- 组件：网页卡片 ---------------- */
const SiteCard = {
  name: 'SiteCard',
  props: { site: { type: Object, required: true }, flash: Boolean },
  emits: ['open', 'status', 'edit', 'remove', 'note', 'read'],
  setup(props, { emit }) {
    const { computed } = Vue;
    const isRead = computed(() => props.site.status === 'read');
    const kind = computed(() => kindMeta(props.site.kind));
    const url = computed(() => normalizeUrl(props.site.url));
    const catStyle = computed(() => platformStyle(props.site.domain || props.site.title));
    // 最近一次点「🌐 打开」的时间（列表就是按它排的）
    const lastReadText = computed(() => (props.site.last_read_at ? formatDate(props.site.last_read_at) : ''));

    // 笔记：按读完日期倒序，卡片上只露最新一条的摘要
    const logs = computed(() => [...(props.site.logs || [])]
      .sort((a, b) => String(b.read_at || '').localeCompare(String(a.read_at || ''))));
    const logCount = computed(() => logs.value.length);
    const latestLog = computed(() => logs.value[0] || null);
    const logSummary = computed(() => siteNoteSummary(latestLog.value));
    const usage = computed(() => (latestLog.value ? usageMeta(latestLog.value.usage) : null));

    return {
      isRead, kind, url, catStyle, lastReadText, logs, logCount, latestLog, logSummary, usage,
      emitOpen: () => emit('open'),
      emitStatus: (s) => emit('status', s),
      emitEdit: () => emit('edit'),
      emitRemove: () => emit('remove'),
      emitNote: () => emit('note', logCount.value ? 'list' : 'new'),
      emitRead: () => emit('read'),
    };
  },
  template: `
  <article class="card paper-card" :class="{ 'is-read': isRead, flash }">
    <div class="card-head">
      <span class="platform" :style="catStyle">{{ site.domain || '未填域名' }}</span>
      <h3 class="title">{{ site.title }}</h3>
      <span class="kind-badge" :class="'k-' + site.kind">{{ kind.emoji }} {{ kind.label }}</span>
      <span class="status-badge" :class="isRead ? 'st-read' : 'st-to_read'">{{ isRead ? '✅ 已读' : '📖 待读' }}</span>
    </div>
    <div class="site-url" v-if="site.url">🔗 <a :href="url" target="_blank" rel="noopener" @click.stop>{{ site.url }}</a></div>
    <div class="read-stamp" v-if="lastReadText" title="最近一次点「打开」的时间，列表按它排序">🕘 最近阅读 {{ lastReadText }}</div>
    <div class="meta" v-if="(site.tags || []).length">
      <span class="chip tag" v-for="tag in site.tags" :key="tag">#{{ tag }}</span>
    </div>
    <p class="paper-notes" v-if="site.notes" :title="site.notes">📝 {{ site.notes }}</p>

    <!-- 笔记：读完才有，卡片上只露最新一条的摘要 -->
    <div class="paper-log" v-if="isRead && logCount" @click.stop="emitNote" title="点开看全部笔记">
      <span class="usage-badge" :class="'usage-' + latestLog.usage" v-if="usage">{{ usage.emoji }} {{ usage.label }}</span>
      <span class="paper-log-line" v-if="logSummary">{{ logSummary }}</span>
      <span class="paper-log-line muted" v-else>（最新一条还没写内容）</span>
      <span class="log-count" v-if="logCount > 1">共 {{ logCount }} 条</span>
    </div>
    <div class="paper-log log-hint" v-else-if="isRead" @click.stop="emitNote" title="点这里补一条笔记">
      📝 还没记笔记，点这里补一条
    </div>

    <div class="card-actions" @click.stop>
      <button class="btn small primary" v-if="site.url" @click="emitOpen">🌐 打开</button>
      <button class="btn small ghost" v-if="!isRead" @click="emitRead">✅ 读完了</button>
      <button class="btn small ghost" v-else @click="emitStatus('to_read')">↩️ 移回待读</button>
      <button class="btn small ghost" v-if="isRead" @click="emitNote">{{ logCount ? '📝 笔记 ' + logCount : '📝 记一条' }}</button>
      <span class="spacer"></span>
      <button class="btn small ghost" @click="emitEdit">✏️ 编辑</button>
      <button class="btn small danger" @click="emitRemove">🗑</button>
    </div>
  </article>
  `,
};

/* ---------------- 组件：论文新增 / 编辑抽屉 ---------------- */
const PaperEditor = {
  name: 'PaperEditor',
  props: { initial: { type: Object, default: null } },
  emits: ['save', 'close'],
  setup(props, { emit }) {
    const { reactive, ref, computed, onMounted, onUnmounted, nextTick, watch } = Vue;
    const titleInput = ref(null);

    const form = reactive({
      title: props.initial?.title || '',
      file_name: props.initial?.file_name || '',
      category: props.initial?.category || '',
      reader: props.initial?.reader || '',
      status: props.initial?.status || 'to_read',
      notes: props.initial?.notes || '',
    });
    // 新建时带上上次用的阅读软件，省得重复填
    if (!props.initial) {
      const lastReader = localStorage.getItem('danji.lastReader');
      if (lastReader) form.reader = lastReader;
    }

    const inbox = ref([]);       // 论文文件夹里的待归档文件
    const categories = ref([]);  // 已有类别（待读/已读下的子目录）
    const matches = ref(null);   // 标题联想结果 { candidates, auto }
    const manualPicked = ref(!!props.initial); // 用户手动选过文件后就不再自动改

    // 阅读软件下拉：自动检测本机已装的阅读软件
    const readers = ref([]);
    const readersLoading = ref(true);
    const readerChoice = ref(form.reader || ''); // ''=系统默认；'__custom__'=手动填路径
    const customOption = computed(() => {
      const r = form.reader;
      if (!r || readers.value.some((x) => x.exe === r)) return null;
      const base = r.split(/[\\/]/).pop().replace(/\.exe$/i, '');
      return { exe: r, name: `${base}（自定义）` };
    });
    watch(readerChoice, (v) => {
      if (v !== '__custom__') form.reader = v;
    });

    async function loadMeta() {
      try {
        const [inb, cats, rs] = await Promise.all([
          fetch('/api/papers/inbox').then((r) => r.json()),
          fetch('/api/papers/categories').then((r) => r.json()),
          fetch('/api/papers/readers').then((r) => r.json()).catch(() => ({ readers: [] })),
        ]);
        inbox.value = inb;
        categories.value = cats;
        readers.value = rs.readers || [];
      } catch { /* 拉不到就先空着，保存时服务端还会兜底 */ }
      readersLoading.value = false;
    }

    // 标题输入 → 防抖匹配论文文件夹；高置信自动选中
    let matchTimer = null;
    watch(() => form.title, (val) => {
      clearTimeout(matchTimer);
      if (!val.trim()) { matches.value = null; return; }
      matchTimer = setTimeout(async () => {
        try {
          matches.value = await fetch('/api/papers/match?name=' + encodeURIComponent(val.trim())).then((r) => r.json());
          if (matches.value.auto && !manualPicked.value) {
            form.file_name = matches.value.candidates[0].name;
          }
        } catch { matches.value = null; }
      }, 300);
    });

    // 文件下拉选项：有匹配按匹配度排，否则按收件箱时间；当前已关联的文件始终在列
    const fileOptions = computed(() => {
      const list = (matches.value && matches.value.candidates.length)
        ? matches.value.candidates.map((f) => ({ ...f }))
        : inbox.value.map((f) => ({ ...f, score: 0 }));
      if (form.file_name && !list.some((f) => f.name === form.file_name)) {
        list.unshift({ name: form.file_name, score: 0, current: true });
      }
      return list;
    });

    function save() {
      if (!form.title.trim()) return alert('请填写论文标题');
      localStorage.setItem('danji.lastReader', form.reader.trim());
      emit('save', {
        title: form.title.trim(),
        file_name: form.file_name,
        category: form.category.trim(),
        status: form.status,
        reader: form.reader.trim(),
        notes: form.notes.trim(),
        link: '',
      });
    }

    const onKey = (e) => { if (e.key === 'Escape') emit('close'); };
    onMounted(async () => {
      window.addEventListener('keydown', onKey);
      loadMeta();
      await nextTick();
      titleInput.value && titleInput.value.focus();
    });
    onUnmounted(() => window.removeEventListener('keydown', onKey));

    // 只有按下和松开都发生在遮罩空白处才关闭（防止圈选文字误关）
    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      form, save, titleInput, categories, matches, fileOptions,
      readers, readersLoading, readerChoice, customOption,
      onFilePick: () => { manualPicked.value = true; },
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>{{ initial ? '✏️ 编辑论文' : '📄 记一篇论文' }}</h2>
        <button class="btn ghost small" @click="close">✕</button>
      </header>
      <form class="drawer-form" @submit.prevent="save">
        <label>标题 *
          <input ref="titleInput" v-model="form.title" placeholder="输入部分标题即可，会自动匹配论文文件夹里的文件">
        </label>
        <label>📄 论文文件
          <select v-model="form.file_name" @change="onFilePick">
            <option value="">不关联文件（仅记录）</option>
            <option v-for="f in fileOptions" :key="f.name" :value="f.name">
              {{ f.name }}{{ f.current ? '（当前）' : (f.score ? '（匹配 ' + f.score + '%）' : '') }}
            </option>
          </select>
          <span class="date-hint ok" v-if="matches && matches.auto && form.file_name">已自动匹配到论文文件夹里的文件，可在上面改选</span>
          <span class="date-hint" v-else-if="matches && !matches.candidates.length && form.title">论文文件夹里没找到相似文件，可先把 PDF 丢进论文文件夹</span>
        </label>
        <label>📚 类别
          <input v-model="form.category" list="paper-category-suggestions" placeholder="输入或选择，如：深度学习；新类别保存时自动建文件夹">
          <datalist id="paper-category-suggestions">
            <option v-for="c in categories" :key="c" :value="c"></option>
          </datalist>
        </label>
        <label>🖥️ 阅读软件
          <select v-model="readerChoice">
            <option value="">系统默认打开方式</option>
            <option v-if="customOption" :value="customOption.exe">{{ customOption.name }}</option>
            <option v-for="r in readers" :key="r.exe" :value="r.exe">{{ r.name }}</option>
            <option value="__custom__">其他（手动填路径）…</option>
          </select>
          <input v-if="readerChoice === '__custom__'" v-model="form.reader"
                 placeholder="粘贴阅读软件的 exe 完整路径，如 D:\\Soft\\SumatraPDF.exe">
          <span class="date-hint" v-if="readersLoading">正在扫描本机已装的阅读软件…</span>
          <span class="date-hint" v-else-if="!readers.length">没扫到常见阅读软件，可用系统默认或手动填路径</span>
        </label>
        <div class="row">
          <label>状态
            <select v-model="form.status">
              <option value="to_read">📖 待读</option>
              <option value="read">✅ 已读</option>
            </select>
          </label>
        </div>
        <label>📝 备注
          <textarea v-model="form.notes" rows="2" placeholder="来源、DOI、为什么读…"></textarea>
        </label>
        <footer class="drawer-foot">
          <button type="button" class="btn ghost" @click="close">取消</button>
          <button type="submit" class="btn primary">💾 保存</button>
        </footer>
      </form>
    </aside>
  </div>
  `,
};

/* ---------------- 组件：网页新增 / 编辑抽屉 ---------------- */
const SiteEditor = {
  name: 'SiteEditor',
  props: {
    initial: { type: Object, default: null },
    knownUrls: { type: Array, default: () => [] }, // 已记录过的链接，用来提示重复
  },
  emits: ['save', 'close'],
  setup(props, { emit }) {
    const { reactive, ref, computed, onMounted, onUnmounted, nextTick } = Vue;
    const urlInput = ref(null);

    const form = reactive({
      url: props.initial?.url || '',
      title: props.initial?.title || '',
      kind: props.initial?.kind || localStorage.getItem('danji.lastSiteKind') || 'tech',
      status: props.initial?.status || 'to_read',
      tagsText: (props.initial?.tags || []).join(', '),
      notes: props.initial?.notes || '',
    });

    const fetching = ref(false);
    const titleHint = ref('');
    const duplicate = computed(() => {
      if (props.initial) return false; // 编辑自己不算重复
      const url = normalizeUrl(form.url);
      return !!url && props.knownUrls.includes(url);
    });

    // 抓标题：只在标题还空着的时候自动填，不覆盖手写的内容；force=true 是点「自动取标题」
    async function fetchTitle(force = false) {
      const url = normalizeUrl(form.url);
      if (!url) return;
      if (!force && form.title.trim()) return;
      fetching.value = true;
      titleHint.value = '';
      try {
        const r = await fetch('/api/sites/title?url=' + encodeURIComponent(url)).then((x) => x.json());
        if (r.title) {
          form.title = r.title;
          titleHint.value = '已自动取到网页标题，可以自己改';
        } else {
          titleHint.value = '没取到标题（页面可能要 JS 渲染），手填一个就行';
        }
      } catch {
        titleHint.value = '没取到标题，手填一个就行';
      }
      fetching.value = false;
    }

    // 离开链接输入框时自动取一次标题（防抖 150ms，避免边打字边请求）
    let blurTimer = null;
    function onUrlBlur() {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(() => fetchTitle(false), 150);
    }

    function save() {
      const url = normalizeUrl(form.url);
      if (!url) return alert('请填写合法的链接（http / https，裸域名会自动补 https://）');
      if (!form.title.trim()) return alert('请填写标题，或点「自动取标题」');
      localStorage.setItem('danji.lastSiteKind', form.kind);
      emit('save', {
        url,
        title: form.title.trim(),
        kind: form.kind,
        status: form.status,
        tags: form.tagsText.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
        notes: form.notes.trim(),
      });
    }

    const onKey = (e) => { if (e.key === 'Escape') emit('close'); };
    onMounted(async () => {
      window.addEventListener('keydown', onKey);
      await nextTick();
      urlInput.value && urlInput.value.focus();
    });
    onUnmounted(() => window.removeEventListener('keydown', onKey));

    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      form, urlInput, fetching, titleHint, duplicate, onUrlBlur, fetchTitle, save,
      kindOptions: CONFIG.siteNote.kinds,
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>{{ initial ? '✏️ 编辑网页' : '🌐 记一个待读网页' }}</h2>
        <button class="btn ghost small" @click="close">✕</button>
      </header>
      <form class="drawer-form" @submit.prevent="save">
        <label>🔗 链接 *
          <input ref="urlInput" v-model="form.url" @blur="onUrlBlur"
                 placeholder="粘贴网址，或直接写 example.com">
          <span class="date-hint" v-if="duplicate">⚠️ 这个链接已经记过了，保存会出现两条</span>
        </label>
        <label>标题 *
          <input v-model="form.title" placeholder="标题；留空点下面的按钮自动取">
          <button type="button" class="mini-link" :disabled="fetching" @click="fetchTitle(true)">
            {{ fetching ? '取标题中…' : '🔄 自动取标题' }}
          </button>
          <span class="date-hint" v-if="titleHint">{{ titleHint }}</span>
        </label>

        <p class="drawer-section">类型（决定读完时的引导表单）</p>
        <div class="chip-picks">
          <button type="button" class="chip-pick" v-for="k in kindOptions" :key="k.id"
                  :class="{ on: form.kind === k.id }" @click="form.kind = k.id">
            {{ k.emoji }} {{ k.label }}
          </button>
        </div>

        <div class="row">
          <label>状态
            <select v-model="form.status">
              <option value="to_read">📖 待读</option>
              <option value="read">✅ 已读</option>
            </select>
          </label>
        </div>
        <label>🏷️ 标签
          <input v-model="form.tagsText" placeholder="逗号分隔，如：RAG, 工具, 长文">
        </label>
        <label>📝 备注（为什么收藏它）
          <textarea v-model="form.notes" rows="2" placeholder="例：群里推荐的，说是把 KV cache 讲得最清楚的一篇"></textarea>
        </label>
        <footer class="drawer-foot">
          <button type="button" class="btn ghost" @click="close">取消</button>
          <button type="submit" class="btn primary">💾 保存</button>
        </footer>
      </form>
    </aside>
  </div>
  `,
};

/* ---------------- 组件：阅读记录抽屉（一篇论文可记多条） ---------------- */
const PaperLogDrawer = {
  name: 'PaperLogDrawer',
  props: {
    paper: { type: Object, required: true },
    editing: { type: Object, default: null }, // null = 列表模式
    pendingRead: Boolean,                     // 这是"读完引导"：三行速记写满才会归档
    restored: Boolean,                        // 表单内容来自上次没写完的草稿
  },
  emits: ['save', 'remove', 'edit', 'new', 'back', 'empty', 'draft', 'discard-draft', 'close'],
  setup(props, { emit }) {
    const { reactive, computed, watch, onMounted, onUnmounted } = Vue;

    const relevance = CONFIG.paperNote.relevance;
    const parts = CONFIG.paperNote.parts;
    // 列表模式里逐条展示的字段（有内容才显示）
    const ROWS = [
      { key: 'problem', label: '🎯 核心问题' },
      { key: 'method', label: '🔧 核心做法' },
      { key: 'finding', label: '📈 核心发现' },
      { key: 'usable', label: '💡 我能借鉴' },
      { key: 'quotable', label: '📝 可引用观点' },
      { key: 'next', label: '🚀 下一步' },
      { key: 'limits', label: '⚠️ 存疑或局限' },
      { key: 'impression', label: '💭 一句话感受' },
      { key: 'excerpt', label: '📖 表达与摘抄' },
    ];

    function blank() { return blankPaperLog(); }

    const form = reactive(blank());
    watch(() => props.editing, (v) => {
      const base = blank();
      if (v) {
        for (const key of Object.keys(base)) {
          base[key] = key === 'parts' ? [...(v.parts || [])] : (v[key] || '');
        }
      }
      Object.assign(form, base);
    }, { immediate: true });

    const logs = computed(() => [...(props.paper.logs || [])]
      .sort((a, b) => String(b.read_at || '').localeCompare(String(a.read_at || ''))));

    const logRows = (log) => ROWS.filter((r) => String(log[r.key] || '').trim());
    const relMeta = (log) => noteRelMeta(log.rel);
    const partLabels = (log) => notePartsText(log);

    function togglePart(id) {
      const i = form.parts.indexOf(id);
      if (i === -1) form.parts.push(id); else form.parts.splice(i, 1);
    }
    function save() {
      if (noteIsEmpty(form)) return emit('empty');
      emit('save', { ...form, parts: [...form.parts] });
    }
    function cancel() { emit(logs.value.length ? 'back' : 'close'); }

    // 表单每次变化都把快照交给根应用（根应用负责防抖写 localStorage），
    // 这样"打完字立刻关抽屉"也不会丢内容
    const snapshot = () => ({ ...form, parts: [...form.parts] });
    watch(form, () => emit('draft', snapshot()), { deep: true });

    function discardDraft() {
      Object.assign(form, blankPaperLog());
      emit('discard-draft');
    }

    const onKey = (e) => { if (e.key === 'Escape') emit('close'); };
    onMounted(() => window.addEventListener('keydown', onKey));
    onUnmounted(() => window.removeEventListener('keydown', onKey));

    // 只有按下和松开都发生在遮罩空白处才关闭（防止圈选文字误关）
    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      relevance, parts, form, logs, logRows, relMeta, partLabels, togglePart, save, cancel, discardDraft,
      emitNew: () => emit('new'),
      emitEdit: (log) => emit('edit', log),
      emitRemove: (log) => emit('remove', log),
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>{{ editing ? (editing.id ? '✏️ 编辑阅读记录' : '📝 记一条阅读记录') : '📝 阅读记录' }}</h2>
        <button class="btn ghost small" @click="close">✕</button>
      </header>

      <!-- 列表模式：按读完日期倒序，一条一张小卡片 -->
      <div class="drawer-body" v-if="!editing">
        <p class="log-paper">📄 {{ paper.title }}</p>
        <button class="btn primary small" @click="emitNew">＋ 再记一条</button>
        <p class="log-empty" v-if="!logs.length">
          还没有阅读记录。读完记一条，日后写 related work、找 gap、做对比实验都能翻回来用。
        </p>
        <article class="log-item" v-for="log in logs" :key="log.id">
          <div class="log-item-head">
            <span class="log-date">🗓 {{ log.read_at || '未填日期' }}</span>
            <span class="rel-badge" :class="'rel-' + log.rel" v-if="relMeta(log)">{{ relMeta(log).emoji }} {{ relMeta(log).label }}</span>
            <span class="spacer"></span>
            <button class="btn small ghost" @click="emitEdit(log)" title="编辑这条记录">✏️</button>
            <button class="btn small danger" @click="emitRemove(log)" title="删除这条记录">🗑</button>
          </div>
          <div class="log-row" v-for="row in logRows(log)" :key="row.key">
            <b>{{ row.label }}</b><span class="pre-wrap">{{ log[row.key] }}</span>
          </div>
          <div class="log-row" v-if="partLabels(log).length">
            <b>🧩 最有用的部分</b><span>{{ partLabels(log).join(' · ') }}</span>
          </div>
          <p class="log-blank" v-if="!logRows(log).length && !partLabels(log).length">（这条记录还没写内容）</p>
        </article>
      </div>

      <!-- 表单模式：什么都不强制，但全空会被拦下 -->
      <form class="drawer-form" v-else @submit.prevent="save">
        <p class="log-paper">📄 {{ paper.title }}</p>
        <p class="log-tip">{{ pendingRead
          ? '写满下面三行速记并保存，才会归档到「已读」；直接关掉就还算「待读」，内容会存成草稿。'
          : '趁热记下能复用的东西。不用全填，写你有感觉的那几栏就行。' }}</p>
        <p class="log-restored" v-if="restored">
          ↩️ 已恢复上次没写完的草稿
          <button type="button" class="mini-link" @click="discardDraft">🗑 丢弃草稿</button>
        </p>

        <label>🗓 读完日期
          <input v-model="form.read_at" placeholder="2026-09-08">
        </label>

        <p class="drawer-section">一句话速记</p>
        <label>🎯 核心问题（它指出的 gap）
          <textarea v-model="form.problem" rows="2" placeholder="例：现有 UDA 方法依赖目标域无标注数据，目标域完全不可见时不适用"></textarea>
        </label>
        <label>🔧 核心做法（关键机制）
          <textarea v-model="form.method" rows="2" placeholder="例：用风格随机化构造虚拟域，配不变性正则学习域不变表征"></textarea>
        </label>
        <label>📈 核心发现（结论 / 关键数字）
          <textarea v-model="form.finding" rows="2" placeholder="例：DomainBed 上平均 +2.3%，且对域的数量不敏感"></textarea>
        </label>

        <p class="drawer-section">课题对接</p>
        <label>🔗 和我的课题什么关系</label>
        <div class="chip-picks">
          <button type="button" class="chip-pick" v-for="r in relevance" :key="r.id"
                  :class="{ on: form.rel === r.id }" @click="form.rel = form.rel === r.id ? '' : r.id">
            {{ r.emoji }} {{ r.label }}
          </button>
        </div>
        <label>💡 我能借鉴什么
          <textarea v-model="form.usable" rows="2" placeholder="例：域随机化模块可替换我的特征对齐项，验证在 DG 下是否仍有效"></textarea>
        </label>
        <label>📝 可引用的观点（结论 + 页码/小节）
          <textarea v-model="form.quotable" rows="2" placeholder="例：p.5 “domain-invariant features alone are insufficient for unseen domains”（可放在 motivation）"></textarea>
        </label>
        <label>🚀 下一步能做什么
          <textarea v-model="form.next" rows="2" placeholder="例：它没处理域标签不可得的情形，可以往这个方向做"></textarea>
        </label>

        <p class="drawer-section">判断与摘抄</p>
        <label>🧩 最有用的部分</label>
        <div class="chip-picks">
          <button type="button" class="chip-pick" v-for="p in parts" :key="p.id"
                  :class="{ on: form.parts.includes(p.id) }" @click="togglePart(p.id)">{{ p.label }}</button>
        </div>
        <label>💭 一句话感受
          <input v-model="form.impression" placeholder="例：方法巧但实验偏弱，思路值得借">
        </label>
        <label>⚠️ 存疑或局限
          <textarea v-model="form.limits" rows="2" placeholder="例：只验证了 3 个域，域标签假设过强"></textarea>
        </label>
        <label>📖 表达与摘抄（金句 / 句式 / 词组搭配 / 逻辑连接词，一行一条）
          <textarea v-model="form.excerpt" rows="4" placeholder="例：&#10;表示对比：in contrast to / by contrast&#10;句式：X is not merely A but B&#10;金句：generalization requires invariance, not invariance alone."></textarea>
        </label>

        <footer class="drawer-foot">
          <button type="button" class="btn ghost" @click="cancel">取消</button>
          <button type="submit" class="btn primary">💾 保存记录</button>
        </footer>
      </form>
    </aside>
  </div>
  `,
};

/* ---------------- 组件：网页笔记抽屉（一个网页可记多条） ---------------- */
const SiteNoteDrawer = {
  name: 'SiteNoteDrawer',
  props: {
    site: { type: Object, required: true },
    editing: { type: Object, default: null }, // null = 列表模式
    pendingRead: Boolean,                     // 这是"读完引导"：写满门槛字段才会归档
    restored: Boolean,                        // 表单内容来自上次没写完的草稿
  },
  emits: ['save', 'remove', 'edit', 'new', 'back', 'empty', 'draft', 'discard-draft', 'close'],
  setup(props, { emit }) {
    const { reactive, computed, watch, onMounted, onUnmounted } = Vue;

    const kindOptions = CONFIG.siteNote.kinds;
    const usageOptions = CONFIG.siteNote.usage;

    function blank() { return blankSiteNote(props.site.kind); }

    const form = reactive(blank());
    watch(() => props.editing, (v) => {
      const base = blank();
      if (v) {
        for (const key of Object.keys(base)) base[key] = v[key] || '';
      }
      Object.assign(form, base);
    }, { immediate: true });

    // 当前要渲染的字段：共用 + 所选类型专属（切类型时另一套已填的内容保留在 form 里，只是不显示）
    const fields = computed(() => siteNoteFields(form.kind));

    const logs = computed(() => [...(props.site.logs || [])]
      .sort((a, b) => String(b.read_at || '').localeCompare(String(a.read_at || ''))));

    const logRows = (log) => siteNoteRows(log);
    const logKind = (log) => kindMeta(log.kind);
    const logUsage = (log) => usageMeta(log.usage);

    function save() {
      if (siteNoteIsEmpty(form)) return emit('empty');
      emit('save', { ...form });
    }
    function cancel() { emit(logs.value.length ? 'back' : 'close'); }

    // 表单每次变化都把快照交给根应用（根应用负责防抖写 localStorage），
    // 这样"打完字立刻关抽屉"也不会丢内容
    const snapshot = () => ({ ...form });
    watch(form, () => emit('draft', snapshot()), { deep: true });

    function discardDraft() {
      Object.assign(form, blank());
      emit('discard-draft');
    }

    const onKey = (e) => { if (e.key === 'Escape') emit('close'); };
    onMounted(() => window.addEventListener('keydown', onKey));
    onUnmounted(() => window.removeEventListener('keydown', onKey));

    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      kindOptions, usageOptions, form, fields, logs, logRows, logKind, logUsage,
      save, cancel, discardDraft,
      emitNew: () => emit('new'),
      emitEdit: (log) => emit('edit', log),
      emitRemove: (log) => emit('remove', log),
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>{{ editing ? (editing.id ? '✏️ 编辑笔记' : '📝 记一条笔记') : '📝 笔记' }}</h2>
        <button class="btn ghost small" @click="close">✕</button>
      </header>

      <!-- 列表模式：按读完日期倒序，一条一张小卡片 -->
      <div class="drawer-body" v-if="!editing">
        <p class="log-paper">🌐 {{ site.title }}</p>
        <button class="btn primary small" @click="emitNew">＋ 再记一条</button>
        <p class="log-empty" v-if="!logs.length">
          还没有笔记。读完记一条，下次想复用的时候能直接搜回来。
        </p>
        <article class="log-item" v-for="log in logs" :key="log.id">
          <div class="log-item-head">
            <span class="log-date">🗓 {{ log.read_at || '未填日期' }}</span>
            <span class="kind-badge" :class="'k-' + log.kind">{{ logKind(log).emoji }} {{ logKind(log).label }}</span>
            <span class="usage-badge" :class="'usage-' + log.usage" v-if="logUsage(log)">{{ logUsage(log).emoji }} {{ logUsage(log).label }}</span>
            <span class="spacer"></span>
            <button class="btn small ghost" @click="emitEdit(log)" title="编辑这条笔记">✏️</button>
            <button class="btn small danger" @click="emitRemove(log)" title="删除这条笔记">🗑</button>
          </div>
          <div class="log-row" v-for="row in logRows(log)" :key="row.key">
            <b>{{ row.label }}</b><span class="pre-wrap">{{ log[row.key] }}</span>
          </div>
          <p class="log-blank" v-if="!logRows(log).length">（这条笔记还没写内容）</p>
        </article>
      </div>

      <!-- 表单模式 -->
      <form class="drawer-form" v-else @submit.prevent="save">
        <p class="log-paper">🌐 {{ site.title }}</p>
        <p class="log-tip">{{ pendingRead
          ? (form.kind === 'tech'
              ? '技术网页：写满「一句话 + 关键做法 + 结论」才会归档到「已读」；直接关掉就还算「待读」，内容会存成草稿。'
              : '杂项网页：写一句「它讲了什么」就能归档到「已读」；直接关掉就还算「待读」，内容会存成草稿。')
          : '重读补记：写你有感觉的那几栏就行。' }}</p>
        <p class="log-restored" v-if="restored">
          ↩️ 已恢复上次没写完的草稿
          <button type="button" class="mini-link" @click="discardDraft">🗑 丢弃草稿</button>
        </p>

        <p class="drawer-section">这是哪类网页？</p>
        <div class="chip-picks">
          <button type="button" class="chip-pick" v-for="k in kindOptions" :key="k.id"
                  :class="{ on: form.kind === k.id }" @click="form.kind = k.id">
            {{ k.emoji }} {{ k.label }}
          </button>
        </div>

        <label>🗓 读完日期
          <input v-model="form.read_at" placeholder="2026-09-10">
        </label>

        <p class="drawer-section">用得上吗</p>
        <div class="chip-picks">
          <button type="button" class="chip-pick" v-for="u in usageOptions" :key="u.id"
                  :class="{ on: form.usage === u.id }" @click="form.usage = form.usage === u.id ? '' : u.id">
            {{ u.emoji }} {{ u.label }}
          </button>
        </div>

        <label v-for="f in fields" :key="f.key">{{ f.label }}
          <textarea v-model="form[f.key]" :rows="f.rows || 2" :placeholder="f.placeholder || ''"></textarea>
        </label>

        <footer class="drawer-foot">
          <button type="button" class="btn ghost" @click="cancel">取消</button>
          <button type="submit" class="btn primary">💾 保存笔记</button>
        </footer>
      </form>
    </aside>
  </div>
  `,
};

/* ---------------- 组件：花销统计卡（期间切换 + 饼图 + 图例） ---------------- */
const ExpenseStats = {
  name: 'ExpenseStats',
  props: {
    period: { type: Object, required: true },
    slices: { type: Array, required: true },
    total: { type: Number, required: true },
    count: { type: Number, required: true },
    yearOptions: { type: Array, required: true },
    label: { type: String, required: true },
    level: { type: String, default: 'item' },              // 'category' = 套餐/API 总览，可点下钻
    selectedCategory: { type: String, default: '' },       // 已下钻的类别
    categories: { type: Array, default: () => [] },
  },
  emits: ['mode', 'year', 'month', 'step', 'pick', 'clear'],
  setup(props, { emit }) {
    const { computed } = Vue;
    const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    // 饼图：每笔 / 每个类别一个扇区，颜色由 id（或类别自带色相）稳定生成。
    // conic-gradient 的 0% 起点在 12 点方向、顺时针增大，和 onPieClick 的角度算法同一套约定
    const gradient = computed(() => {
      if (!props.slices.length) return '';
      const stops = props.slices.map((s) => `hsl(${s.hue} 62% 52%) ${s.from.toFixed(2)}% ${s.to.toFixed(2)}%`);
      return `conic-gradient(${stops.join(', ')})`;
    });
    const pctText = (p) => (p >= 10 ? p.toFixed(1) : p.toFixed(2)) + '%';
    const dotStyle = (s) => ({ background: `hsl(${s.hue} 62% 52%)` });
    const selectedMeta = computed(() => props.categories.find((c) => c.id === props.selectedCategory) || null);
    const canPick = computed(() => props.level === 'category');

    // 点饼图：按点击位置算角度（12 点方向为 0°、顺时针，与 conic-gradient 的 0% 起点一致），
    // 落在哪个扇区就下钻到哪个类别；点在圆外忽略
    function onPieClick(e) {
      if (!canPick.value) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      if (Math.hypot(dx, dy) > rect.width / 2) return;
      let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
      if (deg < 0) deg += 360;
      const pct = (deg / 360) * 100;
      const hit = props.slices.find((s) => pct >= s.from && pct < s.to);
      if (hit) emit('pick', hit.id);
    }
    function onLegendClick(s) {
      if (canPick.value) emit('pick', s.id);
    }

    return {
      MONTHS, gradient, pctText, dotStyle, selectedMeta, canPick, onPieClick, onLegendClick, formatMoney,
      setMode: (m) => emit('mode', m),
      setYear: (e) => emit('year', Number(e.target.value)),
      setMonth: (e) => emit('month', Number(e.target.value)),
      step: (d) => emit('step', d),
      clear: () => emit('clear'),
    };
  },
  template: `
  <section class="stat-card">
    <header class="stat-head">
      <div class="stat-modes">
        <button class="tab" :class="{ active: period.mode === 'month' }" @click="setMode('month')">按月</button>
        <button class="tab" :class="{ active: period.mode === 'year' }" @click="setMode('year')">按年</button>
      </div>
      <div class="stat-picker">
        <button class="btn small ghost" @click="step(-1)" title="上一个期间">←</button>
        <select class="platform-select" :value="period.year" @change="setYear">
          <option v-for="y in yearOptions" :key="y" :value="y">{{ y }} 年</option>
        </select>
        <select class="platform-select" v-if="period.mode === 'month'" :value="period.month" @change="setMonth">
          <option v-for="m in MONTHS" :key="m" :value="m">{{ m }} 月</option>
        </select>
        <button class="btn small ghost" @click="step(1)" title="下一个期间">→</button>
      </div>
      <span class="stat-right">
        <span class="stat-count" v-if="count">共 {{ count }} 笔 · <b class="money">{{ formatMoney(total) }}</b></span>
        <button class="filter-chip" v-if="selectedMeta" @click="clear"
                :title="'返回套餐 / API 总览'">
          正在看 {{ selectedMeta.emoji }} {{ selectedMeta.label }} ✕
        </button>
      </span>
    </header>

    <div class="stat-body" v-if="slices.length">
      <div class="pie" :class="{ clickable: canPick }" :style="{ background: gradient }"
           :title="canPick ? '点扇区看这个类别的明细' : ''" @click="onPieClick"></div>
      <ul class="pie-legend">
        <li class="legend-row" :class="{ clickable: canPick }" v-for="s in slices" :key="s.id"
            :title="canPick ? '点这一行看 ' + s.title + ' 的明细' : s.title + ' · ' + formatMoney(s.amount)"
            @click="onLegendClick(s)">
          <span class="legend-dot" :style="dotStyle(s)"></span>
          <span class="legend-title" :class="{ merged: s.merged }">{{ s.title }}</span>
          <span class="legend-count" v-if="s.count > 1">×{{ s.count }}</span>
          <span class="legend-amount">{{ formatMoney(s.amount) }}</span>
          <span class="legend-pct">{{ pctText(s.pct) }}</span>
        </li>
      </ul>
    </div>
    <div class="stat-empty" v-else>
      <div class="pie-empty"></div>
      <p>{{ label }} 还没有花销记录</p>
    </div>
  </section>
  `,
};

/* ---------------- 组件：花销卡片 ---------------- */
const ExpenseCard = {
  name: 'ExpenseCard',
  props: { expense: { type: Object, required: true } },
  emits: ['edit', 'remove'],
  setup(props, { emit }) {
    const { computed } = Vue;
    const amountText = computed(() => formatMoney(props.expense.amount));
    const category = computed(() => expenseCategoryMeta(props.expense.category));
    return {
      amountText, category, formatDate,
      emitEdit: () => emit('edit'),
      emitRemove: () => emit('remove'),
    };
  },
  template: `
  <article class="card expense-card">
    <div class="card-head">
      <span class="expense-date">🗓 {{ formatDate(expense.date) }}</span>
      <span class="cat-chip" :style="{ '--h': category.hue }">{{ category.emoji }} {{ category.label }}</span>
      <h3 class="title">{{ expense.title }}</h3>
      <span class="expense-amount">{{ amountText }}</span>
    </div>
    <p class="expense-notes" v-if="expense.notes">{{ expense.notes }}</p>
    <div class="card-actions" @click.stop>
      <span class="spacer"></span>
      <button class="btn small ghost" @click="emitEdit">✏️ 编辑</button>
      <button class="btn small danger" @click="emitRemove">🗑</button>
    </div>
  </article>
  `,
};

/* ---------------- 组件：花销新增 / 编辑抽屉 ---------------- */
const ExpenseEditor = {
  name: 'ExpenseEditor',
  props: {
    initial: { type: Object, default: null },
    defaultDate: { type: String, default: '' }, // 按当前所选期间算出来的默认日期
  },
  emits: ['save', 'close'],
  setup(props, { emit }) {
    const { reactive, ref, computed, watch, onMounted, onUnmounted, nextTick } = Vue;
    const titleInput = ref(null);

    const form = reactive({
      title: props.initial?.title || '',
      amountText: props.initial ? String(props.initial.amount) : '',
      date: props.initial?.date || props.defaultDate || todayStr(),
      notes: props.initial?.notes || '',
      category: props.initial?.category || guessExpenseCategory(props.initial?.title || ''),
    });
    // 用户手动点过类别之后就不再被标题自动改（编辑已有记录同理）
    const categoryTouched = ref(!!props.initial);
    watch(() => form.title, (t) => {
      if (categoryTouched.value) return;
      form.category = guessExpenseCategory(t);
    });
    function pickCategory(id) {
      categoryTouched.value = true;
      form.category = id;
    }

    // 新记一笔且默认日期不是今天时，说明是按所选期间填的，提示一句免得以为写错了
    const dateHint = computed(() => {
      if (props.initial || !form.date || form.date === todayStr()) return '';
      return `默认按你当前选的期间填了 ${formatDate(form.date)}，记不清具体哪天就留着`;
    });

    // 边输边预览金额解析结果，省得保存后才发现写错
    const amountPreview = computed(() => {
      const raw = form.amountText.trim();
      if (!raw) return null;
      const n = parseAmountInput(raw);
      return n === null
        ? { bad: true, text: '金额得是正数，可以写 1280、1280.5、¥1,280' }
        : { bad: false, text: `→ ${formatMoney(n)}` };
    });

    function save() {
      if (!form.title.trim()) return alert('请填写花销内容');
      const amount = parseAmountInput(form.amountText);
      if (amount === null) return alert('金额得是正数，可以写 1280、1280.5、¥1,280');
      const date = form.date.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return alert('日期写成 2026-09-10 这样');
      emit('save', { title: form.title.trim(), amount, date, notes: form.notes.trim(), category: form.category });
    }

    const onKey = (e) => { if (e.key === 'Escape') emit('close'); };
    onMounted(async () => {
      window.addEventListener('keydown', onKey);
      await nextTick();
      titleInput.value && titleInput.value.focus();
    });
    onUnmounted(() => window.removeEventListener('keydown', onKey));

    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      form, titleInput, amountPreview, dateHint, save, pickCategory,
      categories: CONFIG.expenses.categories,
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>{{ initial ? '✏️ 编辑花销' : '💰 记一笔花销' }}</h2>
        <button class="btn ghost small" @click="close">✕</button>
      </header>
      <form class="drawer-form" @submit.prevent="save">
        <label>花销内容 *
          <input ref="titleInput" v-model="form.title" placeholder="例：Coursera 年费 / 打印机墨盒 / 文献数据库会员">
        </label>
        <label>金额 *
          <input v-model="form.amountText" inputmode="decimal" placeholder="1280 或 1280.5 或 ¥1,280">
          <span class="date-hint" v-if="amountPreview" :class="amountPreview.bad ? 'bad' : 'ok'">{{ amountPreview.text }}</span>
        </label>

        <p class="drawer-section">类别（年视图按它归纳）</p>
        <div class="chip-picks">
          <button type="button" class="chip-pick" v-for="c in categories" :key="c.id"
                  :class="{ on: form.category === c.id }" @click="pickCategory(c.id)">
            {{ c.emoji }} {{ c.label }}
          </button>
        </div>

        <div class="row">
          <label>日期
            <input type="date" v-model="form.date">
            <span class="date-hint" v-if="dateHint">{{ dateHint }}</span>
          </label>
        </div>
        <label>📝 备注（一句简记）
          <textarea v-model="form.notes" rows="5" class="tall" placeholder="例：报了吴恩达的课，能开发票；续费前记得看看有没有学生优惠"></textarea>
        </label>
        <footer class="drawer-foot">
          <button type="button" class="btn ghost" @click="close">取消</button>
          <button type="submit" class="btn primary">💾 保存</button>
        </footer>
      </form>
    </aside>
  </div>
  `,
};

/* ---------------- 组件：体感评价卡（主体素材 + 我的评价） ---------------- */
const InsightCard = {
  name: 'InsightCard',
  props: {
    insight: { type: Object, required: true },  // 自动凝练的素材：花费 / 类别拆分 / 原话摘录
    verdict: { type: Object, default: null },   // 已保存的我的评价（没保存过是 null）
  },
  emits: ['save', 'clear'],
  setup(props, { emit }) {
    const { reactive, computed, watch } = Vue;

    // 本地可编辑副本：保存成功后根组件会换上 server 返回的新 verdict，watch 到了就同步，
    // 保证卡片上看到的永远是已保存的内容
    const form = reactive({ rating: null, decision: '', verdict: '' });
    function syncFromVerdict(v) {
      form.rating = v ? v.rating : null;
      form.decision = v ? v.decision || '' : '';
      form.verdict = v ? v.verdict || '' : '';
    }
    syncFromVerdict(props.verdict);
    watch(() => props.verdict, syncFromVerdict);

    const hasSaved = computed(() => !!props.verdict);
    const catSplits = computed(() => props.insight.categorySplit
      .map((c) => ({ ...c, meta: expenseCategoryMeta(c.id) })));

    function pickStar(n) {
      form.rating = form.rating === n ? null : n;
    }
    function pickDecision(id) {
      form.decision = form.decision === id ? '' : id;
    }
    // 没写过总评时，把凝练好的要点填进框里当草稿，改两笔就是自己的话了
    function fillDraft() {
      form.verdict = buildVerdictDraft(props.insight);
    }
    function save() {
      emit('save', {
        subject: props.insight.subject.id,
        rating: form.rating,
        decision: form.decision,
        verdict: form.verdict.trim(),
      });
    }

    return {
      form, hasSaved, catSplits, pickStar, pickDecision, fillDraft, save,
      decisions: CONFIG.expenses.decisions,
      defaultTag: CONFIG.expenses.insightDefaultTag,
      tagLabel(id) {
        return (CONFIG.expenses.insightTags.find((t) => t.id === id) || CONFIG.expenses.insightDefaultTag).label;
      },
      formatMoney, formatDate,
      clear: () => emit('clear'),
    };
  },
  template: `
  <article class="card insight-card">
    <div class="card-head">
      <h3 class="title">🧭 {{ insight.subject.label }}</h3>
      <span class="insight-total" v-if="insight.count">
        累计 <b class="money">{{ formatMoney(insight.total) }}</b> · {{ insight.count }} 笔
      </span>
      <span class="insight-total" v-else>还没有相关花销</span>
    </div>

    <div class="insight-facts" v-if="insight.count">
      <span class="cat-chip" v-for="c in catSplits" :key="c.id" :style="{ '--h': c.meta.hue }">
        {{ c.meta.emoji }} {{ formatMoney(c.amount) }}
      </span>
      <span class="insight-last">最近一笔 {{ formatDate(insight.lastDate) }}</span>
    </div>

    <div class="insight-quotes" v-if="insight.quotes.length">
      <p class="insight-label">📎 记录里的原话<sup v-if="insight.quoteTotal > insight.quotes.length">共 {{ insight.quoteTotal }} 句，显示最近的 {{ insight.quotes.length }} 句</sup></p>
      <div class="insight-quote" v-for="(q, i) in insight.quotes" :key="i"
           :title="'来自：' + q.title + ' · ' + formatDate(q.date)">
        <p class="quote-text"><span class="quote-tag">{{ tagLabel(q.tag) }}</span>“{{ q.sentence }}”</p>
        <p class="quote-src">{{ formatDate(q.date) }} · {{ q.title }} · {{ formatMoney(q.amount) }}</p>
      </div>
    </div>

    <div class="insight-mine">
      <p class="insight-label">🧠 我的评价</p>
      <div class="insight-controls">
        <div class="star-row" title="体感评分：点星打分，再点同一颗取消">
          <button v-for="n in 5" :key="n" type="button" class="star"
                  :class="{ on: form.rating >= n }" @click="pickStar(n)">★</button>
          <span class="star-num" v-if="form.rating">{{ form.rating }} / 5</span>
        </div>
        <div class="chip-picks insight-decisions">
          <button v-for="d in decisions" :key="d.id" type="button" class="chip-pick"
                  :class="{ on: form.decision === d.id }" @click="pickDecision(d.id)">{{ d.label }}</button>
        </div>
      </div>
      <textarea v-model="form.verdict" rows="4"
                placeholder="这家值不值、价格怎样、下次还买不买……点「✨ 依记录生成草稿」再改成自己的话"></textarea>
      <div class="insight-actions">
        <button class="btn small ghost" v-if="!form.verdict && insight.quotes.length" @click="fillDraft">✨ 依记录生成草稿</button>
        <button class="btn small ghost" v-if="hasSaved" @click="clear">🧹 清除</button>
        <span class="spacer"></span>
        <button class="btn small primary" @click="save">💾 保存</button>
      </div>
    </div>
  </article>
  `,
};

/* ---------------- 组件：消息卡片 ---------------- */
const MessageCard = {
  name: 'MessageCard',
  props: { message: { type: Object, required: true } },
  emits: ['read', 'remove', 'goto'],
  setup(props, { emit }) {
    return {
      platformStyle, formatDate,
      emitRead: () => emit('read'), emitRemove: () => emit('remove'),
      emitGoto: () => emit('goto'),
    };
  },
  template: `
  <article class="card" :class="{ 'is-read': message.read }" @click="emitRead">
    <div class="card-head">
      <span class="platform" :style="platformStyle(message.platform)">{{ message.platform }}</span>
      <h3 class="title">{{ message.title }}</h3>
      <span class="msg-flag unread" v-if="!message.read">未读</span>
      <span class="msg-flag" v-else>✓ 已读</span>
    </div>
    <div class="meta">
      <span class="chip">💬 {{ message.body }}</span>
      <span class="chip">{{ formatDate(message.created_at) }}</span>
    </div>
    <div class="card-actions" @click.stop>
      <button class="btn small ghost" @click="emitGoto">→ 查看原蛋</button>
      <span class="spacer"></span>
      <button class="btn small danger" @click="emitRemove">🗑</button>
    </div>
  </article>
  `,
};

/* ---------------- 根应用 ---------------- */
// 全局兜底用的 toast 引用：toast 定义在 setup 里，挂载后由 setup 回填
let toastBridge = null;

const app = createApp({
  setup() {
    const state = reactive({
      board: localStorage.getItem('danji.board') || 'eggs',
      activities: [],
      loaded: false,
      loadError: false, // 首屏加载失败（服务未启动等）：页面显示错误态和重试按钮，而不是永远「加载中…」
      search: '',
      statusFilter: 'pending',
      platformFilter: '',
      editorOpen: false,
      editing: null,
      saving: false, // 保存请求进行中：按钮立即显示「保存中…」并禁用，网络再慢也有即时反馈，且防重复提交
      papers: [],
      papersLoaded: false,
      paperCategories: [],
      paperFilter: { status: 'to_read', category: '', note: '' },
      paperSearch: '',
      paperEditorOpen: false,
      editingPaper: null,
      logOpen: false,
      logPaperId: null,
      logEditing: null, // null = 列表模式，对象 = 表单模式（新建时 id 为空）
      logPendingRead: false, // 这次打开是"读完引导"：写满三行速记才归档
      logRestored: false,    // 表单内容来自上次没写完的草稿
      logDraftSnapshot: null, // 最新草稿快照（关闭时用它兜底写盘）
      sites: [],
      sitesLoaded: false,
      siteFilter: { status: 'to_read', kind: '', usage: '' },
      siteSearch: '',
      siteEditorOpen: false,
      editingSite: null,
      siteNoteOpen: false,
      siteNoteId: null,
      siteNoteEditing: null,      // null = 列表模式，对象 = 表单模式
      siteNotePendingRead: false, // 这次打开是"读完引导"：写满门槛字段才归档
      siteNoteRestored: false,
      siteNoteDraftSnapshot: null,
      expenses: [],
      expensesLoaded: false,
      expenseSearch: '',
      expenseEditorOpen: false,
      editingExpense: null,
      expenseCategory: '', // 年视图下钻的类别（'' = 套餐 / API 总览）；同时作用于列表筛选
      // 花销板块视图：明细记账 / 体感评价，选择记在本地，刷新后保持
      expenseView: localStorage.getItem('danji.expenseView') === 'insight' ? 'insight' : 'list',
      // 体感评价：用户敲定的评价（rating / verdict / decision）存在 server；
      // 主体识别与摘录凝练是纯前端计算，每次都从花销记录现算
      insights: [],
      insightsLoaded: false,
      // 统计期间：默认当前月；「按月 / 按年」的选择记在本地，刷新后保持
      expensePeriod: {
        mode: localStorage.getItem('danji.expenseMode') === 'year' ? 'year' : 'month',
        year: new Date().getFullYear(),
        month: new Date().getMonth() + 1,
      },
      messages: [],
      messagesLoaded: false,
      now: Date.now(),
      flashId: null,
      toast: { show: false, msg: '', type: 'ok' },
      notifPermission: typeof Notification !== 'undefined' ? Notification.permission : 'denied',
      // 用户级软开关：浏览器权限无法被 JS 撤销，关闭提醒只能靠自己存状态
      notifyOn: localStorage.getItem('danji.notifyOn') !== '0',
    });

    // 「已提醒过」记录持久化：刷新/重开页面不会对同一颗蛋重复弹通知
    const NOTIFIED_KEY = 'danji.notified';
    let savedNotified = [];
    try { savedNotified = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '[]'); } catch (e) {}
    const notifiedKeys = new Set(Array.isArray(savedNotified) ? savedNotified : []);
    function rememberNotified(key) {
      notifiedKeys.add(key);
      const arr = [...notifiedKeys];
      if (arr.length > 200) arr.splice(0, arr.length - 200); // 只留最近 200 条，防止无限膨胀
      localStorage.setItem(NOTIFIED_KEY, JSON.stringify(arr));
    }
    let toastTimer = null;

    function toast(msg, type = 'ok') {
      state.toast = { show: true, msg, type };
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { state.toast.show = false; }, 2200);
    }
    provide('toast', toast); // 子组件（卡片等）通过 inject 使用
    toastBridge = toast;     // 回填给全局兜底，服务异常时也能给出可见提示

    /* ---- 主题：跟随系统 → 浅色 → 深色（首屏由 index.html 的内联脚本先定好，避免闪白） ---- */
    const THEME_KEY = 'danji.theme';
    const THEME_MODES = ['auto', 'light', 'dark'];
    const THEME_ICON = { auto: '🖥️', light: '☀️', dark: '🌙' };
    const THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

    function readThemeMode() {
      // ?theme=light|dark 临时强制某个明暗（调试/截图用，不写入偏好）
      try {
        const q = new URLSearchParams(location.search).get('theme');
        if (q === 'light' || q === 'dark') return q;
      } catch (e) {}
      try {
        const saved = localStorage.getItem(THEME_KEY);
        return THEME_MODES.includes(saved) ? saved : 'auto';
      } catch (e) { return 'auto'; }
    }
    const themeMode = ref(readThemeMode());

    function applyTheme() {
      const dark = themeMode.value === 'dark' || (themeMode.value === 'auto' && systemDark.matches);
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    }

    function cycleTheme() {
      themeMode.value = THEME_MODES[(THEME_MODES.indexOf(themeMode.value) + 1) % THEME_MODES.length];
      try { localStorage.setItem(THEME_KEY, themeMode.value); } catch (e) {}
      applyTheme();
      toast(`主题：${THEME_LABEL[themeMode.value]}`);
    }

    const themeIcon = computed(() => THEME_ICON[themeMode.value]);
    const themeTitle = computed(() => {
      const next = THEME_LABEL[THEME_MODES[(THEME_MODES.indexOf(themeMode.value) + 1) % THEME_MODES.length]];
      return `当前主题：${THEME_LABEL[themeMode.value]}，点击切换到「${next}」`;
    });

    // 系统偏好变化时（auto 模式下）实时跟随；另一个标签页改了主题也同步
    const onSystemThemeChange = () => { if (themeMode.value === 'auto') applyTheme(); };
    const onStorageTheme = (e) => {
      if (e.key !== THEME_KEY) return;
      themeMode.value = readThemeMode();
      applyTheme();
    };

    // 顶栏换行后高度会变，实时同步 --topbar-h，保证紧急横幅吸顶位置正确
    let topbarObserver = null;
    function syncTopbarHeight() {
      const el = document.querySelector('.topbar');
      if (el) document.documentElement.style.setProperty('--topbar-h', el.offsetHeight + 'px');
    }

    /* ---- 数据加载与提交 ---- */
    async function load() {
      try {
        const res = await fetch('/api/activities');
        state.activities = await res.json();
        state.loaded = true;
        state.loadError = false;
      } catch (e) {
        // 服务连不上：标记错误态让页面显示重试按钮；不向上抛，避免中断 onMounted 后续初始化
        state.loadError = true;
      }
    }

    async function saveActivity(payload) {
      if (state.saving) return; // 请求进行中忽略重复提交（连点按钮 / 表单里按回车）
      state.saving = true;      // 同步置位：按钮立即变「保存中…」，不等网络结论
      const isEdit = !!state.editing;
      const url = isEdit ? `/api/activities/${state.editing.id}` : '/api/activities';
      let saved;
      try {
        const res = await fetch(url, {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) return toast('保存失败：' + res.status, 'warn');
        saved = await res.json();
      } catch (e) {
        // 服务连不上：抽屉保持打开，已填内容不丢
        return toast('保存失败：无法连接服务，请确认拾穗集服务已启动', 'warn');
      } finally {
        state.saving = false;
      }
      if (isEdit) {
        const idx = state.activities.findIndex((a) => a.id === saved.id);
        if (idx !== -1) state.activities.splice(idx, 1, saved);
      } else {
        state.activities.push(saved);
      }
      state.editorOpen = false;
      toast(isEdit ? '已保存 ✅' : '记好了，一颗新蛋 🥚');
    }

    // 改一条记录的若干个字段，成功后就地替换本地数据，失败返回 null
    async function patchActivity(activity, patch) {
      const res = await fetch(`/api/activities/${activity.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...activity, ...patch }),
      });
      if (!res.ok) return null;
      const saved = await res.json();
      const idx = state.activities.findIndex((a) => a.id === saved.id);
      if (idx !== -1) state.activities.splice(idx, 1, saved);
      return saved;
    }

    async function setStatus(activity, status) {
      const saved = await patchActivity(activity, { status });
      if (!saved) return toast('更新失败', 'warn');
      toast(`已标记为「${statusMeta(status).label}」${statusMeta(status).emoji}`);
    }

    async function removeActivity(activity) {
      if (!confirm(`确定删除「${activity.platform} · ${activity.title}」吗？`)) return;
      const res = await fetch(`/api/activities/${activity.id}`, { method: 'DELETE' });
      if (!res.ok) return toast('删除失败：' + res.status, 'warn');
      state.activities = state.activities.filter((a) => a.id !== activity.id);
      toast('已删除 🗑');
    }

    /* ---- 文献板块 ---- */
    function switchBoard(board) {
      state.board = board;
      localStorage.setItem('danji.board', board);
    }

    async function loadPapers() {
      try {
        const [papers, cats] = await Promise.all([
          fetch('/api/papers').then((r) => r.json()),
          fetch('/api/papers/categories').then((r) => r.json()),
        ]);
        state.papers = papers;
        state.paperCategories = cats;
      } catch {
        toast('论文数据加载失败', 'warn');
      }
      state.papersLoaded = true;
    }

    /* ---- 消息中心 ---- */
    async function loadMessages() {
      try {
        const res = await fetch('/api/messages');
        state.messages = await res.json();
      } catch {
        toast('消息加载失败', 'warn');
      }
      state.messagesLoaded = true;
    }

    // 蛋过期时写一条消息；服务端按「蛋 + 使用截止 + 领取截止」去重，重复调用不会攒出多条
    async function pushExpiredMessage(activity) {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activity_id: activity.id,
          platform: activity.platform,
          title: activity.title,
          body: `使用截止 ${formatDate(activity.valid_until)} 已过，已自动移入「已过期」`,
          valid_until: activity.valid_until || '',
          read: false,
        }),
      });
      if (!res.ok) return;
      const saved = await res.json();
      if (!state.messages.some((m) => m.id === saved.id)) state.messages.unshift(saved);
    }

    // 蛋错过领取截止时写一条消息，claim_deadline 参与服务端去重
    async function pushMissedMessage(activity) {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activity_id: activity.id,
          platform: activity.platform,
          title: activity.title,
          body: `领取截止 ${formatDate(activity.claim_deadline)} 已过，已自动移入「已错过」`,
          valid_until: '',
          claim_deadline: activity.claim_deadline || '',
          read: false,
        }),
      });
      if (!res.ok) return;
      const saved = await res.json();
      if (!state.messages.some((m) => m.id === saved.id)) state.messages.unshift(saved);
    }

    async function markMessageRead(msg) {
      if (msg.read) return;
      const res = await fetch(`/api/messages/${msg.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...msg, read: true }),
      });
      if (!res.ok) return;
      const saved = await res.json();
      const idx = state.messages.findIndex((m) => m.id === saved.id);
      if (idx !== -1) state.messages.splice(idx, 1, saved);
    }

    async function removeMessage(msg) {
      const res = await fetch(`/api/messages/${msg.id}`, { method: 'DELETE' });
      if (!res.ok) return toast('删除失败', 'warn');
      state.messages = state.messages.filter((m) => m.id !== msg.id);
    }

    async function markAllRead() {
      const res = await fetch('/api/messages/read-all', { method: 'POST' });
      if (!res.ok) return toast('操作失败', 'warn');
      const { updated } = await res.json();
      state.messages = state.messages.map((m) => ({ ...m, read: true }));
      toast(updated ? `${updated} 条消息已标为已读 ✅` : '没有未读消息');
    }

    async function clearReadMessages() {
      const res = await fetch('/api/messages/clear-read', { method: 'POST' });
      if (!res.ok) return toast('操作失败', 'warn');
      const { removed } = await res.json();
      state.messages = state.messages.filter((m) => !m.read);
      toast(removed ? `已清空 ${removed} 条已读消息 🧹` : '没有已读消息');
    }

    function openPaperEditor(paper) {
      state.editingPaper = paper ? { ...paper } : null;
      state.paperEditorOpen = true;
    }

    async function savePaper(payload) {
      const isEdit = !!state.editingPaper;
      const url = isEdit ? `/api/papers/${state.editingPaper.id}` : '/api/papers';
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
      if (isEdit) {
        const idx = state.papers.findIndex((p) => p.id === saved.id);
        if (idx !== -1) state.papers.splice(idx, 1, saved);
      } else {
        state.papers.push(saved);
      }
      state.paperEditorOpen = false;
      loadPapers(); // 类别/文件状态可能变了，顺手刷新
      if (saved.missing) toast('文件没找到，已仅创建记录', 'warn');
      else if (saved.moved) toast(`已归档到 ${saved.status === 'read' ? '已读' : '待读'}/${saved.category} 📂`);
      else toast(isEdit ? '已保存 ✅' : '记好了，一篇论文 📄');
    }

    async function setPaperStatus(paper, status) {
      const res = await fetch(`/api/papers/${paper.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...paper, status }),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('更新失败：' + (saved.error || res.status), 'warn');
      const idx = state.papers.findIndex((p) => p.id === saved.id);
      if (idx !== -1) state.papers.splice(idx, 1, saved);
      toast(status === 'read' ? `已移入 已读/${saved.category} ✅` : `已移回 待读/${saved.category} 📖`);
    }

    /* ---- 阅读记录（logs） ---- */
    const logPaper = computed(() => state.papers.find((p) => p.id === state.logPaperId) || null);

    // mode: 'list' 看记录列表（没有记录时直接进表单） / 'new' 直接新建
    // pendingRead: 这次是"读完引导"，三行速记写满并保存后才真正归档
    function openPaperLog(paper, mode = 'list', pendingRead = false) {
      state.logPaperId = paper.id;
      state.logPendingRead = pendingRead;
      const draft = mode === 'new' ? readDraft(LOG_DRAFT_PREFIX, paper.id) : null; // 没写完的草稿自动带回
      state.logRestored = !!draft;
      state.logDraftSnapshot = draft;
      state.logEditing = draft
        ? { ...blankPaperLog(), ...draft, parts: [...(draft.parts || [])] }
        : ((mode === 'new' || !(paper.logs || []).length) ? blankPaperLog() : null);
      state.logOpen = true;
    }

    // 点「✅ 读完了」：先写笔记，保存那一刻才归档，论文此刻状态与文件都不动
    function startPaperRead(paper) { openPaperLog(paper, 'new', true); }

    function newPaperLog() {
      state.logPendingRead = false;
      state.logRestored = false;
      state.logDraftSnapshot = null;
      state.logEditing = blankPaperLog();
    }
    function editPaperLog(log) { state.logEditing = { ...log, parts: [...(log.parts || [])] }; }
    function backToLogList() {
      if (state.logPendingRead) return closePaperLog(); // 还没归档，回列表没意义
      state.logEditing = null;
    }

    // 草稿：内存留最新快照，写盘防抖 400ms；关闭时立刻补写，兜住"打完字就关"
    let draftTimer = null;
    function saveLogDraft(form) {
      if (!state.logPendingRead || !state.logPaperId) return;
      state.logDraftSnapshot = form;
      clearTimeout(draftTimer);
      const paperId = state.logPaperId;
      draftTimer = setTimeout(() => writeDraft(LOG_DRAFT_PREFIX, paperId, form, noteIsEmpty), 400);
    }
    function discardLogDraft() {
      clearTimeout(draftTimer);
      clearDraft(LOG_DRAFT_PREFIX, state.logPaperId);
      state.logRestored = false;
      state.logDraftSnapshot = null;
      toast('草稿已丢弃 🧹');
    }

    function closePaperLog() {
      clearTimeout(draftTimer);
      const wasPendingRead = state.logPendingRead;
      const paperId = state.logPaperId;
      if (wasPendingRead && paperId && state.logDraftSnapshot) writeDraft(LOG_DRAFT_PREFIX, paperId, state.logDraftSnapshot, noteIsEmpty);
      state.logPendingRead = false;
      state.logRestored = false;
      state.logDraftSnapshot = null;
      state.logOpen = false;
      state.logPaperId = null;
      state.logEditing = null;
      if (wasPendingRead && paperId) {
        toast(readDraft(LOG_DRAFT_PREFIX, paperId) ? '没写满，这篇还留在「待读」，内容已存草稿' : '没记笔记，这篇还留在「待读」');
      }
    }

    async function savePaperLog(form) {
      const paper = logPaper.value;
      if (!paper) return;

      // 读完引导：三行速记写满才允许归档；已读补记只要非空即可
      if (state.logPendingRead) {
        const missing = noteBasicMissing(form);
        if (missing.length) {
          return toast(`还差「${missing.map((f) => NOTE_FIELD_LABEL[f]).join('、')}」，这篇先留在「待读」`, 'warn');
        }
      } else if (noteIsEmpty(form)) {
        return toast('这条记录还是空的，写点内容再保存', 'warn');
      }

      const logs = [...(paper.logs || [])];
      const idx = logs.findIndex((l) => l.id === form.id);
      if (idx === -1) logs.push(form); else logs.splice(idx, 1, form);
      const patch = { ...paper, logs };
      const wasPendingRead = state.logPendingRead;
      if (wasPendingRead) patch.status = 'read'; // 笔记与状态同一次 PUT，原子落盘

      const res = await fetch(`/api/papers/${paper.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
      const i = state.papers.findIndex((p) => p.id === saved.id);
      if (i !== -1) state.papers.splice(i, 1, saved);

      clearTimeout(draftTimer);
      clearDraft(LOG_DRAFT_PREFIX, paper.id);
      state.logPendingRead = false;
      state.logRestored = false;
      state.logDraftSnapshot = null;
      state.logEditing = null; // 保存后回到列表
      toast(wasPendingRead
        ? `读完了！已归档到 已读/${saved.category} 🎉`
        : (idx === -1 ? '已记下这条阅读记录 📝' : '记录已更新 ✅'));
    }

    async function removePaperLog(log) {
      const paper = logPaper.value;
      if (!paper) return;
      if (!confirm(`删除 ${log.read_at || '这条'} 的阅读记录吗？`)) return;
      const logs = (paper.logs || []).filter((l) => l.id !== log.id);
      const res = await fetch(`/api/papers/${paper.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...paper, logs }),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('删除失败：' + (saved.error || res.status), 'warn');
      const i = state.papers.findIndex((p) => p.id === saved.id);
      if (i !== -1) state.papers.splice(i, 1, saved);
      toast('已删除这条记录 🗑');
    }

    async function openPaper(paper) {
      toast('正在打开…');
      const res = await fetch(`/api/papers/${paper.id}/open`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return toast(data.error || '打开失败', 'warn');
      // 服务端已记下 last_read_at，用它替换本地这条 → 列表按阅读时间重排，这张卡升到顶部
      if (data.paper) {
        const idx = state.papers.findIndex((p) => p.id === data.paper.id);
        if (idx !== -1) state.papers.splice(idx, 1, data.paper);
        flashCard(data.paper.id);
        toast('📖 已打开，这张卡已置顶');
      } else {
        toast('📖 已打开');
      }
    }

    async function openPaperReveal(paper) {
      const res = await fetch(`/api/papers/${paper.id}/reveal`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast(data.error || '打开失败', 'warn');
    }

    async function removePaper(paper) {
      if (!confirm(`确定删除记录「${paper.title}」吗？（磁盘上的文件不会被删）`)) return;
      const res = await fetch(`/api/papers/${paper.id}`, { method: 'DELETE' });
      if (!res.ok) return toast('删除失败：' + res.status, 'warn');
      state.papers = state.papers.filter((p) => p.id !== paper.id);
      toast('已删除记录 🗑（文件保留）');
    }

    /* ---- 网页板块 ---- */
    async function loadSites() {
      try {
        state.sites = await fetch('/api/sites').then((r) => r.json());
      } catch {
        toast('网页数据加载失败', 'warn');
      }
      state.sitesLoaded = true;
    }

    function openSiteEditor(site) {
      state.editingSite = site ? { ...site } : null;
      state.siteEditorOpen = true;
    }

    async function saveSite(payload) {
      const isEdit = !!state.editingSite;
      const url = isEdit ? `/api/sites/${state.editingSite.id}` : '/api/sites';
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
      if (isEdit) {
        const idx = state.sites.findIndex((s) => s.id === saved.id);
        if (idx !== -1) state.sites.splice(idx, 1, saved);
      } else {
        state.sites.push(saved);
      }
      state.siteEditorOpen = false;
      toast(isEdit ? '已保存 ✅' : '记好了，一个待读网页 🌐');
    }

    async function setSiteStatus(site, status) {
      const res = await fetch(`/api/sites/${site.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...site, status }),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('更新失败：' + (saved.error || res.status), 'warn');
      const idx = state.sites.findIndex((s) => s.id === saved.id);
      if (idx !== -1) state.sites.splice(idx, 1, saved);
      toast(status === 'read' ? '已移入「已读」✅' : '已移回「待读」📖');
    }

    // 打开网页：先同步 window.open（放到 await 之后会被浏览器当弹窗拦掉），再回服务端记阅读时间
    async function openSite(site) {
      const url = normalizeUrl(site.url);
      if (!url) return toast('这条记录的链接不合法，编辑一下试试', 'warn');
      // 别写成 window.open(url, '_blank', 'noopener')：带 noopener 时浏览器按规范一律返回 null
      // （不给句柄），那样会把「打开成功」误判成「被拦截」。这里正常打开后立刻抹掉 opener，效果等价。
      const win = window.open(url, '_blank');
      if (win) {
        try { win.opener = null; } catch (e) {}
        toast('🌐 已打开，这张卡已置顶');
      } else {
        try {
          await navigator.clipboard.writeText(url);
          toast('浏览器拦截了弹窗，链接已复制 📋', 'warn');
        } catch { toast('浏览器拦截了弹窗，请手动打开链接', 'warn'); }
      }
      const res = await fetch(`/api/sites/${site.id}/open`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.site) return; // 时间没记上也不打扰你阅读
      const idx = state.sites.findIndex((s) => s.id === data.site.id);
      if (idx !== -1) state.sites.splice(idx, 1, data.site);
      flashCard(data.site.id);
    }

    async function removeSite(site) {
      if (!confirm(`确定删除「${site.title}」吗？`)) return;
      const res = await fetch(`/api/sites/${site.id}`, { method: 'DELETE' });
      if (!res.ok) return toast('删除失败：' + res.status, 'warn');
      state.sites = state.sites.filter((s) => s.id !== site.id);
      toast('已删除 🗑');
    }

    /* ---- 网页笔记（logs） ---- */
    const siteNoteItem = computed(() => state.sites.find((s) => s.id === state.siteNoteId) || null);

    // mode: 'list' 看笔记列表（没有笔记时直接进表单） / 'new' 直接新建
    // pendingRead: 这次是"读完引导"，写满门槛字段并保存后才真正归档到「已读」
    function openSiteNote(site, mode = 'list', pendingRead = false) {
      state.siteNoteId = site.id;
      state.siteNotePendingRead = pendingRead;
      const draft = mode === 'new' ? readDraft(SITE_DRAFT_PREFIX, site.id) : null; // 没写完的草稿自动带回
      state.siteNoteRestored = !!draft;
      state.siteNoteDraftSnapshot = draft;
      state.siteNoteEditing = draft
        ? { ...blankSiteNote(site.kind), ...draft }
        : ((mode === 'new' || !(site.logs || []).length) ? blankSiteNote(site.kind) : null);
      state.siteNoteOpen = true;
    }

    // 点「✅ 读完了」：先写笔记，保存那一刻才归档，网页状态此刻不动
    function startSiteRead(site) { openSiteNote(site, 'new', true); }

    function newSiteNote() {
      state.siteNotePendingRead = false;
      state.siteNoteRestored = false;
      state.siteNoteDraftSnapshot = null;
      const site = siteNoteItem.value;
      state.siteNoteEditing = blankSiteNote(site ? site.kind : 'tech');
    }
    function editSiteNote(log) { state.siteNoteEditing = { ...log }; }
    function backToSiteNoteList() {
      if (state.siteNotePendingRead) return closeSiteNote(); // 还没归档，回列表没意义
      state.siteNoteEditing = null;
    }

    // 草稿：内存留最新快照，写盘防抖 400ms；关闭时立刻补写，兜住"打完字就关"
    let siteDraftTimer = null;
    function saveSiteNoteDraft(form) {
      if (!state.siteNotePendingRead || !state.siteNoteId) return;
      state.siteNoteDraftSnapshot = form;
      clearTimeout(siteDraftTimer);
      const id = state.siteNoteId;
      siteDraftTimer = setTimeout(() => writeDraft(SITE_DRAFT_PREFIX, id, form, siteNoteIsEmpty), 400);
    }
    function discardSiteNoteDraft() {
      clearTimeout(siteDraftTimer);
      clearDraft(SITE_DRAFT_PREFIX, state.siteNoteId);
      state.siteNoteRestored = false;
      state.siteNoteDraftSnapshot = null;
      toast('草稿已丢弃 🧹');
    }

    function closeSiteNote() {
      clearTimeout(siteDraftTimer);
      const wasPendingRead = state.siteNotePendingRead;
      const siteId = state.siteNoteId;
      if (wasPendingRead && siteId && state.siteNoteDraftSnapshot) {
        writeDraft(SITE_DRAFT_PREFIX, siteId, state.siteNoteDraftSnapshot, siteNoteIsEmpty);
      }
      state.siteNotePendingRead = false;
      state.siteNoteRestored = false;
      state.siteNoteDraftSnapshot = null;
      state.siteNoteOpen = false;
      state.siteNoteId = null;
      state.siteNoteEditing = null;
      if (wasPendingRead && siteId) {
        toast(readDraft(SITE_DRAFT_PREFIX, siteId)
          ? '没写满，这个网页还留在「待读」，内容已存草稿'
          : '没记笔记，这个网页还留在「待读」');
      }
    }

    async function saveSiteNote(form) {
      const site = siteNoteItem.value;
      if (!site) return;

      // 读完引导：技术网页要写满三栏、杂项网页只要一句话；已读后的补记非空即可
      if (state.siteNotePendingRead) {
        const missing = siteNoteMissing(form);
        if (missing.length) {
          return toast(`还差「${missing.map(siteNoteFieldLabel).join('、')}」，这个网页先留在「待读」`, 'warn');
        }
      } else if (siteNoteIsEmpty(form)) {
        return toast('这条笔记还是空的，写点内容再保存', 'warn');
      }

      const logs = [...(site.logs || [])];
      const idx = logs.findIndex((l) => l.id === form.id);
      if (idx === -1) logs.push(form); else logs.splice(idx, 1, form);
      const patch = { ...site, logs };
      const wasPendingRead = state.siteNotePendingRead;
      if (wasPendingRead) patch.status = 'read'; // 笔记与状态同一次 PUT，原子落盘

      const res = await fetch(`/api/sites/${site.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
      const i = state.sites.findIndex((s) => s.id === saved.id);
      if (i !== -1) state.sites.splice(i, 1, saved);

      clearTimeout(siteDraftTimer);
      clearDraft(SITE_DRAFT_PREFIX, site.id);
      state.siteNotePendingRead = false;
      state.siteNoteRestored = false;
      state.siteNoteDraftSnapshot = null;
      state.siteNoteEditing = null; // 保存后回到列表
      toast(wasPendingRead
        ? '读完了！已移入「已读」🎉'
        : (idx === -1 ? '已记下这条笔记 📝' : '笔记已更新 ✅'));
    }

    async function removeSiteNote(log) {
      const site = siteNoteItem.value;
      if (!site) return;
      if (!confirm(`删除 ${log.read_at || '这条'} 的笔记吗？`)) return;
      const logs = (site.logs || []).filter((l) => l.id !== log.id);
      const res = await fetch(`/api/sites/${site.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...site, logs }),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('删除失败：' + (saved.error || res.status), 'warn');
      const i = state.sites.findIndex((s) => s.id === saved.id);
      if (i !== -1) state.sites.splice(i, 1, saved);
      toast('已删除这条笔记 🗑');
    }

    /* ---- 花销板块 ---- */
    let expensePeriodInit = false; // 只做一次「自动跳到最近有记录的月份」

    async function loadExpenses() {
      try {
        state.expenses = await fetch('/api/expenses').then((r) => r.json());
      } catch {
        toast('花销数据加载失败', 'warn');
      }
      state.expensesLoaded = true;
      // 当前期间一笔都没有、但历史里有记录 → 自动跳到最近有记录的月份，免得一进来看到空板
      if (!expensePeriodInit) {
        expensePeriodInit = true;
        const p = state.expensePeriod;
        const hasCurrent = state.expenses.some((e) => monthOf(e.date) === `${p.year}-${pad2(p.month)}`);
        if (!hasCurrent) {
          const latest = state.expenses.map((e) => monthOf(e.date)).filter(Boolean).sort().pop();
          if (latest) {
            p.year = Number(latest.slice(0, 4));
            p.month = Number(latest.slice(5, 7));
          }
        }
      }
    }

    function openExpenseEditor(expense) {
      state.editingExpense = expense ? { ...expense } : null;
      state.expenseEditorOpen = true;
    }

    async function saveExpense(payload) {
      const isEdit = !!state.editingExpense;
      const url = isEdit ? `/api/expenses/${state.editingExpense.id}` : '/api/expenses';
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
      if (isEdit) {
        const idx = state.expenses.findIndex((e) => e.id === saved.id);
        if (idx !== -1) state.expenses.splice(idx, 1, saved);
      } else {
        state.expenses.push(saved);
      }
      state.expenseEditorOpen = false;
      // 跳到这笔所属的期间，保证刚记的立刻看得见（比如补记上个月的账）
      const m = monthOf(saved.date);
      if (m) {
        state.expensePeriod.year = Number(m.slice(0, 4));
        state.expensePeriod.month = Number(m.slice(5, 7));
      }
      toast(isEdit ? '已保存 ✅' : `记好了：${saved.title} ${formatMoney(saved.amount)} 💰`);
    }

    async function removeExpense(expense) {
      if (!confirm(`确定删除「${expense.title}」这笔 ${formatMoney(expense.amount)} 吗？`)) return;
      const res = await fetch(`/api/expenses/${expense.id}`, { method: 'DELETE' });
      if (!res.ok) return toast('删除失败：' + res.status, 'warn');
      state.expenses = state.expenses.filter((e) => e.id !== expense.id);
      toast('已删除 🗑');
    }

    /* ---- 花销板块：体感评价 ---- */
    async function loadInsights() {
      try {
        state.insights = await fetch('/api/insights').then((r) => r.json());
      } catch {
        toast('评价数据加载失败', 'warn');
      }
      state.insightsLoaded = true;
    }

    function setExpenseView(view) {
      state.expenseView = view === 'insight' ? 'insight' : 'list';
      localStorage.setItem('danji.expenseView', state.expenseView);
    }

    // 保存某个主体的评价：按 subject upsert，卡片上的本地编辑在保存成功后由组件自己同步
    async function saveInsightVerdict(payload) {
      const res = await fetch(`/api/insights/${encodeURIComponent(payload.subject)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: payload.rating, decision: payload.decision, verdict: payload.verdict }),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
      const i = state.insights.findIndex((v) => v.subject === saved.subject);
      if (i === -1) state.insights.push(saved);
      else state.insights.splice(i, 1, saved);
      toast('评价已保存 🧭');
    }

    // 清除评价 = 回到纯记录视角：只删我的结论，花销记录和凝练出来的原话都不动
    async function clearInsightVerdict(row) {
      if (!confirm(`清空「${row.subject.label}」的评价吗？（记录原话还在，随时能重新写）`)) return;
      const res = await fetch(`/api/insights/${encodeURIComponent(row.subject.id)}`, { method: 'DELETE' });
      if (!res.ok) return toast('删除失败：' + res.status, 'warn');
      state.insights = state.insights.filter((v) => v.subject !== row.subject.id);
      toast('已清除 🧹');
    }

    function setExpenseMode(mode) {
      state.expensePeriod.mode = mode;
      // 类别下钻只属于「按年」：按月是按条目看的，切过去就把筛选清掉，别把年视图的类别带进月视图
      if (mode !== 'year') state.expenseCategory = '';
      localStorage.setItem('danji.expenseMode', mode);
    }
    // 点类别 = 下钻；再点同一个 = 回到总览
    function pickExpenseCategory(id) {
      state.expenseCategory = state.expenseCategory === id ? '' : id;
    }
    function clearExpenseCategory() { state.expenseCategory = ''; }
    function setExpenseYear(year) { state.expensePeriod.year = year; }
    function setExpenseMonth(month) { state.expensePeriod.month = month; }
    // 期间步进：按月时跨年自动进位/退位
    function stepExpensePeriod(delta) {
      const p = state.expensePeriod;
      if (p.mode === 'year') { p.year += delta; return; }
      let m = p.month + delta;
      let y = p.year;
      while (m > 12) { m -= 12; y += 1; }
      while (m < 1) { m += 12; y -= 1; }
      p.month = m;
      p.year = y;
    }

    /* ---- 派生数据 ---- */
    const platformOptions = computed(() => {
      const set = new Set(state.activities.map((a) => a.platform).filter(Boolean));
      return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
    });

    const counts = computed(() => {
      const c = { all: state.activities.length };
      for (const s of CONFIG.statuses) c[s.id] = 0;
      for (const a of state.activities) c[a.status] = (c[a.status] || 0) + 1;
      return c;
    });

    const statusTabs = computed(() => [
      { id: 'all', label: '全部', count: counts.value.all },
      ...CONFIG.statuses.map((s) => ({ id: s.id, label: `${s.emoji} ${s.label}`, count: counts.value[s.id] || 0 })),
    ]);

    const filteredActivities = computed(() => {
      const kw = state.search.toLowerCase();
      let list = state.activities.filter((a) => {
        if (state.statusFilter !== 'all' && a.status !== state.statusFilter) return false;
        if (state.platformFilter && a.platform !== state.platformFilter) return false;
        if (!kw) return true;
        const hay = [a.title, a.platform, a.value, a.notes, a.claim_steps, ...(a.tags || [])].join(' ').toLowerCase();
        return hay.includes(kw);
      });
      const sortTime = (a) => {
        const urg = computeUrgency(a, state.now);
        return urg.deadline ? urg.deadline.getTime() : Infinity;
      };
      list = list.slice().sort((a, b) => {
        const ta = computeUrgency(a, state.now).tier;
        const tb = computeUrgency(b, state.now).tier;
        if (ta !== tb) return ta - tb;
        const sa = sortTime(a), sb = sortTime(b);
        if (sa !== sb) return sa - sb;
        return (b.updated_at || '').localeCompare(a.updated_at || '');
      });
      return list;
    });

    // 顶栏消息红点：有未读就显示条数
    const unreadCount = computed(() => state.messages.filter((m) => !m.read).length);

    const paperCounts = computed(() => ({
      all: state.papers.length,
      to_read: state.papers.filter((p) => p.status === 'to_read').length,
      read: state.papers.filter((p) => p.status === 'read').length,
      noted: state.papers.filter((p) => (p.logs || []).length).length,
      unnoted: state.papers.filter((p) => !(p.logs || []).length).length,
    }));

    // 笔记全文（含「最有用的部分」标签），供搜索使用
    function logHaystack(logs) {
      return logs.flatMap((l) => [
        l.read_at, ...NOTE_TEXT_FIELDS.map((f) => l[f]), ...notePartsText(l),
      ]).filter(Boolean);
    }

    const filteredPapers = computed(() => {
      const kw = state.paperSearch.toLowerCase();
      return state.papers
        .filter((p) => {
          if (state.paperFilter.status !== 'all' && p.status !== state.paperFilter.status) return false;
          if (state.paperFilter.category && p.category !== state.paperFilter.category) return false;
          const logs = p.logs || [];
          if (state.paperFilter.note === 'has' && !logs.length) return false;
          if (state.paperFilter.note === 'none' && logs.length) return false;
          if (!kw) return true;
          const hay = [p.title, p.category, p.file_name, p.notes, ...logHaystack(logs)].join(' ').toLowerCase();
          return hay.includes(kw);
        })
        // 排序：最近阅读时间倒序（点过「📖 阅读」的置顶，没读过按添加时间）；
        // 键相同时用添加时间、标题兜底，保证顺序稳定不抖动
        .sort((a, b) => readSortKey(b) - readSortKey(a)
          || String(b.created_at || '').localeCompare(String(a.created_at || ''))
          || String(a.title || '').localeCompare(String(b.title || ''), 'zh'));
    });

    /* ---- 网页板块：派生数据 ---- */
    const siteCounts = computed(() => ({
      all: state.sites.length,
      to_read: state.sites.filter((s) => s.status === 'to_read').length,
      read: state.sites.filter((s) => s.status === 'read').length,
      noted: state.sites.filter((s) => (s.logs || []).length).length,
      unnoted: state.sites.filter((s) => !(s.logs || []).length).length,
    }));

    const siteKindOptions = computed(() => CONFIG.siteNote.kinds);
    const siteUsageOptions = computed(() => CONFIG.siteNote.usage);
    // 已记录过的链接（新建时用来提示重复）
    const siteUrls = computed(() => state.sites.map((s) => normalizeUrl(s.url)).filter(Boolean));

    // 网页全文（标题 / 域名 / 链接 / 标签 / 备注 + 所有笔记字段），供搜索使用
    function siteHaystack(site) {
      return [
        site.title, site.domain, site.url, site.notes, ...(site.tags || []),
        ...(site.logs || []).flatMap((l) => [l.read_at, l.usage, ...siteNoteKeys().map((k) => l[k])]),
      ].filter(Boolean);
    }

    const filteredSites = computed(() => {
      const kw = state.siteSearch.toLowerCase();
      return state.sites
        .filter((s) => {
          if (state.siteFilter.status !== 'all' && s.status !== state.siteFilter.status) return false;
          if (state.siteFilter.kind && s.kind !== state.siteFilter.kind) return false;
          const logs = s.logs || [];
          if (state.siteFilter.usage === 'none') {
            if (logs.length) return false;
          } else if (state.siteFilter.usage && !logs.some((l) => l.usage === state.siteFilter.usage)) {
            return false;
          }
          if (!kw) return true;
          return siteHaystack(s).join(' ').toLowerCase().includes(kw);
        })
        // 排序规则与文献一致：最近阅读时间倒序（点过「🌐 打开」的置顶），没读过按添加时间
        .sort((a, b) => readSortKey(b) - readSortKey(a)
          || String(b.created_at || '').localeCompare(String(a.created_at || ''))
          || String(a.title || '').localeCompare(String(b.title || ''), 'zh'));
    });

    /* ---- 花销板块：派生数据 ---- */
    // 当前期间（年 / 月）内的记录，再按搜索词过滤；日期倒序，同一天按录入时间倒序
    const expensePeriodItems = computed(() => {
      const kw = state.expenseSearch.toLowerCase();
      const { mode, year, month } = state.expensePeriod;
      const ym = `${year}-${pad2(month)}`;
      return state.expenses
        .filter((e) => {
          const m = monthOf(e.date);
          if (mode === 'year' ? !m.startsWith(String(year)) : m !== ym) return false;
          if (!kw) return true;
          return [e.title, e.notes, e.date].join(' ').toLowerCase().includes(kw);
        })
        .sort((a, b) => String(b.date).localeCompare(String(a.date))
          || String(b.created_at || '').localeCompare(String(a.created_at || '')));
    });

    // 列表与合计再叠加类别筛选（年视图下钻后，列表只留这一类）
    const expenseVisibleItems = computed(() => (state.expenseCategory
      ? expensePeriodItems.value.filter((e) => e.category === state.expenseCategory)
      : expensePeriodItems.value));

    const expenseTotal = computed(() => expenseVisibleItems.value.reduce((sum, e) => sum + (Number(e.amount) || 0), 0));

    // 饼图两级：
    //   年视图未下钻 → 类别层（📦 套餐 / 🔌 API 两个扇区）
    //   年视图已下钻 → 按名字合并的逐笔层（这一年在这个名目上花了多少）
    //   月视图 → 条目层（每笔一个扇区，超过 maxSlices 时合并「其余 N 笔」）
    const expenseChart = computed(() => {
      if (state.expensePeriod.mode === 'year' && !state.expenseCategory) {
        const cat = buildCategorySlices(expensePeriodItems.value);
        return { level: 'category', slices: cat.slices, total: cat.total };
      }
      const rows = state.expensePeriod.mode === 'year'
        ? groupExpenseByTitle(expenseVisibleItems.value)
        : expenseVisibleItems.value;
      const item = buildPieSlices(rows, CONFIG.expenses.maxSlices);
      return { level: 'item', slices: item.slices, total: item.total };
    });

    const expenseCategories = computed(() => CONFIG.expenses.categories);
    const expensePeriodLabel = computed(() => periodLabel(state.expensePeriod));
    // 年份下拉：有记录的年份 + 今年 + 当前所选年份
    const expenseYearOptions = computed(() => {
      const years = new Set(state.expenses.map((e) => Number(String(e.date).slice(0, 4))).filter(Boolean));
      years.add(new Date().getFullYear());
      years.add(state.expensePeriod.year);
      return [...years].sort((a, b) => b - a);
    });

    /* ---- 花销板块：体感评价（全量历史视角，不随月 / 年期间切换） ---- */
    const expenseInsights = computed(() => {
      const verdictOf = new Map(state.insights.map((v) => [v.subject, v]));
      const rows = [];
      for (const subject of CONFIG.expenses.subjects) {
        const insight = buildSubjectInsight(subject, state.expenses);
        const verdict = verdictOf.get(subject.id) || null;
        // 有匹配花销、或用户写过评价的主体才上板；只写了评价没花过钱的排后面
        if (insight.count || verdict) rows.push({ subject, insight, verdict });
      }
      rows.sort((a, b) => b.insight.total - a.insight.total);
      // 没认领到任何主体的花销：提示用户去 config.js 加关键词，免得体感悄悄漏掉
      const unmatched = state.expenses.filter((e) => !matchSubjects(e).length);
      return { rows, unmatched };
    });
    // 未识别提示条的文字：列前 5 个标题，多了用「等 N 笔」收尾
    const expenseUnmatchedText = computed(() => {
      const list = expenseInsights.value.unmatched;
      const titles = list.slice(0, 5).map((e) => String(e.title || '未命名'));
      return titles.join('、') + (list.length > 5 ? ` 等 ${list.length} 笔` : '');
    });

    // 横幅：待领取且领取截止 ≤7 天（含已超时） + 已领取且使用截止 ≤48 小时 + 截止待确认的蛋
    const urgentItems = computed(() => {
      const items = [];
      for (const a of state.activities) {
        const urg = computeUrgency(a, state.now);
        const isClaimUrgent = a.status === 'pending' && urg.remainingMs !== null && urg.remainingMs <= CONFIG.urgent.yellow * HOUR;
        const isValidUrgent = a.status === 'claimed' && urg.remainingMs !== null && urg.remainingMs <= 48 * HOUR;
        const isUnknown = urg.level === 'unknown';
        if (!isClaimUrgent && !isValidUrgent && !isUnknown) continue;
        const meta = statusMeta(a.status);
        items.push({
          key: a.id + (a.claim_deadline || '') + (a.valid_until || ''),
          id: a.id, platform: a.platform, title: a.title,
          shortTitle: a.title.length > 12 ? a.title.slice(0, 12) + '…' : a.title,
          status: a.status, statusEmoji: meta.emoji, statusLabel: meta.label,
          level: urg.level, label: urg.label,
          remainingText: isUnknown ? '待确认 ❓' : formatRemaining(urg.remainingMs),
        });
      }
      return items.sort((x, y) => {
        const order = ['over', 'red', 'orange', 'yellow', 'unknown'];
        return order.indexOf(x.level) - order.indexOf(y.level);
      });
    });

    /* ---- 其他交互 ---- */
    function openEditor(activity) {
      state.editing = activity ? { ...activity } : null;
      state.editorOpen = true;
    }

    /* ---- 定位：横幅条目 / 系统通知 / 消息卡片都走这里 ---- */

    // 切到这颗蛋自己的状态分类，并清掉平台与搜索筛选，保证它一定出现在列表里
    function focusActivity(id) {
      const target = state.activities.find((a) => a.id === id);
      if (!target) return null;
      if (state.board !== 'eggs') switchBoard('eggs');
      state.statusFilter = target.status; // 属于哪个分类就跳到哪个分类
      state.platformFilter = '';
      state.search = '';
      return target;
    }

    // 卡片高亮：同一张卡被重复触发时先熄一次，让 CSS 动画能重新播放
    let flashTimer = null;
    function flashCard(id) {
      clearTimeout(flashTimer);
      const start = () => {
        state.flashId = id;
        flashTimer = setTimeout(() => { state.flashId = null; }, FLASH_MS);
      };
      if (state.flashId === id) { state.flashId = null; nextTick(start); } else start();
    }

    function jumpTo(id) {
      const target = focusActivity(id);
      if (!target) return toast('这颗蛋已经不在了，可能已被删除', 'warn');
      const meta = statusMeta(target.status);
      toast(`已跳到「${meta.emoji} ${meta.label}」`);
      nextTick(() => requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = document.getElementById('card-' + id);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        flashCard(id);
      })));
    }

    // 从消息跳回对应的蛋：分类与筛选处理跟横幅、通知完全一致
    function gotoActivity(id) {
      if (!state.activities.some((a) => a.id === id)) return toast('这条消息对应的蛋已经删掉了', 'warn');
      jumpTo(id);
    }

    function setNotify(on) {
      state.notifyOn = on;
      localStorage.setItem('danji.notifyOn', on ? '1' : '0');
    }

    async function toggleNotify() {
      if (typeof Notification === 'undefined') return toast('此浏览器不支持桌面通知', 'warn');
      if (state.notifPermission === 'denied') {
        return toast('通知被浏览器拒绝了，可在地址栏权限里重新允许', 'warn');
      }
      if (state.notifPermission !== 'granted') {
        const perm = await Notification.requestPermission();
        state.notifPermission = perm;
        if (perm !== 'granted') {
          return toast(perm === 'denied' ? '通知被浏览器拒绝了，可在地址栏权限里重新允许' : '没有授权，随时点铃铛再试', 'warn');
        }
        setNotify(true);
        toast(`桌面通知已开启 🔔（${CONFIG.remind.hours} 小时内到期的蛋会提醒你）`);
        checkReminders();
        return;
      }
      // 已授权：铃铛就是真开关
      if (state.notifyOn) {
        setNotify(false);
        toast('已关闭桌面通知 🔕，到期不再弹提醒，点铃铛可重新打开');
      } else {
        setNotify(true);
        toast(`已开启桌面通知 🔔（${CONFIG.remind.hours} 小时内到期的蛋会提醒你）`);
        checkReminders();
      }
    }

    function checkReminders() {
      if (!state.notifyOn) return; // 用户关掉了提醒开关
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const now = Date.now();
      for (const a of state.activities) {
        const urg = computeUrgency(a, now);
        if (!urg.deadline || urg.remainingMs <= 0 || urg.remainingMs > CONFIG.remind.hours * HOUR) continue;
        const key = `${a.id}|${a.claim_deadline}|${a.valid_until}`;
        if (notifiedKeys.has(key)) continue;
        rememberNotified(key);
        const isClaim = a.status === 'pending';
        const n = new Notification(`${isClaim ? '🥚 蛋快不能领了' : '⏳ 领到的蛋快过期了'} · ${a.platform}`, {
          body: `${a.title}\n${urg.label} ${formatDate(a.claim_deadline || a.valid_until)}，${formatRemaining(urg.remainingMs)}`,
          tag: a.id,
        });
        n.onclick = () => { window.focus(); jumpTo(a.id); n.close(); };
      }
    }

    // 到点的蛋自动流转：已领取的过了使用截止 →「已过期」；待领取的过了领取截止 →「已错过」。
    // 只有填了明确截止时间才能自动判；没填 /「待定」/ 看不懂的仍留给用户手动确认。
    // 串行提交：服务端每次写盘都用同一个临时文件
    let settleRunning = false;
    async function settleOverdue() {
      if (settleRunning) return;
      settleRunning = true;
      try {
        const now = Date.now();
        const isEditing = (a) => state.editorOpen && state.editing && state.editing.id === a.id; // 正在编辑的先别动
        const expiredDue = state.activities.filter((a) => {
          if (a.status !== 'claimed' || !a.valid_until || isEditing(a)) return false;
          const d = parseStoredDate(a.valid_until);
          return !isNaN(d.getTime()) && d.getTime() <= now;
        });
        const missedDue = state.activities.filter((a) => {
          if (a.status !== 'pending' || !a.claim_deadline || isEditing(a)) return false;
          const d = parseStoredDate(a.claim_deadline);
          return !isNaN(d.getTime()) && d.getTime() <= now;
        });
        if (!expiredDue.length && !missedDue.length) return;
        const expired = [];
        const missed = [];
        for (const a of expiredDue) {
          if (await patchActivity(a, { status: 'expired' })) expired.push(a);
        }
        for (const a of missedDue) {
          if (await patchActivity(a, { status: 'missed' })) missed.push(a);
        }
        // toast 是单例，多条必须聚合成一条，否则只看到最后一条
        const parts = [];
        if (missed.length) {
          parts.push(missed.length === 1
            ? `😢 ${missed[0].platform} · ${missed[0].title} 过了领取截止，已自动移入「已错过」`
            : `😢 ${missed.length} 颗蛋过了领取截止，已自动移入「已错过」`);
        }
        if (expired.length) {
          parts.push(expired.length === 1
            ? `💤 ${expired[0].platform} · ${expired[0].title} 过了使用截止，已自动移入「已过期」`
            : `💤 ${expired.length} 颗蛋过了使用截止，已自动移入「已过期」`);
        }
        if (!parts.length) return;
        toast(parts.join('；'), 'warn');
        for (const a of missed) { notifyMissed(a); pushMissedMessage(a); }
        for (const a of expired) { notifyExpired(a); pushExpiredMessage(a); }
      } finally {
        settleRunning = false;
      }
    }

    function notifyExpired(activity) {
      if (!state.notifyOn) return;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const key = `expired|${activity.id}|${activity.valid_until}`;
      if (notifiedKeys.has(key)) return;
      rememberNotified(key);
      const n = new Notification(`💤 蛋过期了 · ${activity.platform}`, {
        body: `${activity.title}\n使用截止 ${formatDate(activity.valid_until)} 已过，已移入「已过期」`,
        tag: activity.id,
      });
      n.onclick = () => { window.focus(); jumpTo(activity.id); n.close(); };
    }

    function notifyMissed(activity) {
      if (!state.notifyOn) return;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const key = `missed|${activity.id}|${activity.claim_deadline}`;
      if (notifiedKeys.has(key)) return;
      rememberNotified(key);
      const n = new Notification(`😢 蛋错过了 · ${activity.platform}`, {
        body: `${activity.title}\n领取截止 ${formatDate(activity.claim_deadline)} 已过，已移入「已错过」`,
        tag: activity.id,
      });
      n.onclick = () => { window.focus(); jumpTo(activity.id); n.close(); };
    }

    /* ---- 示例数据 ---- */
    async function loadSamples() {
      const now = Date.now();
      const iso = (ms) => {
        const d = new Date(ms);
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      };
      const day = (n) => now + n * 24 * HOUR;
      const samples = [
        {
          platform: 'Claude', title: '周末积分返场', type: 'voucher', value: '$5 额度',
          claim_deadline: iso(now + 5 * HOUR), valid_until: '', link: 'https://example.com/claude',
          claim_steps: '登录 → Settings → Billing → 点击 Redeem', tags: ['示例'], notes: '每个账号限领一次',
          status: 'pending',
        },
        {
          platform: 'Kimi', title: '开学季月卡 7 折', type: 'discount', value: '月卡 7 折',
          claim_deadline: iso(day(2)), valid_until: '', link: 'https://example.com/kimi',
          claim_steps: '打开活动页 → 登录 → 点领取后下单生效', tags: ['示例'], notes: '',
          status: 'pending',
        },
        {
          platform: 'Gemini', title: '学生认证送 12 个月 Pro', type: 'trial', value: '12 个月 Pro',
          claim_deadline: iso(day(5)), valid_until: iso(day(370)).slice(0, 10), link: 'https://example.com/gemini',
          claim_steps: '用学生邮箱验证 → 活动页一键开通', tags: ['示例'], notes: '需要 .edu 邮箱',
          status: 'pending',
        },
        {
          platform: 'DeepSeek', title: '新用户注册额度', type: 'free_credits', value: '100 万 tokens',
          claim_deadline: null, valid_until: '', link: '', claim_steps: '注册即送，无需操作', tags: ['示例'], notes: '',
          status: 'pending',
        },
      ];
      for (const s of samples) {
        await fetch('/api/activities', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(s),
        });
      }
      await load();
      toast('已填入 4 条示例数据，可随意编辑或删除 🧪');
    }

    /* ---- 定时器 ---- */
    let tickTimer = null, remindTimer = null;
    function onVisibility() {
      // 浏览器会把后台标签页的定时器拖慢到几分钟一次，切回来的瞬间立刻补查一次
      if (document.visibilityState === 'visible') checkReminders();
    }
    onMounted(async () => {
      applyTheme(); // 内联脚本已经设过，这里兜一次（也覆盖脚本被禁用的情况）
      if (systemDark.addEventListener) systemDark.addEventListener('change', onSystemThemeChange);
      else if (systemDark.addListener) systemDark.addListener(onSystemThemeChange);
      window.addEventListener('storage', onStorageTheme);
      const topbarEl = document.querySelector('.topbar');
      if (topbarEl && typeof ResizeObserver !== 'undefined') {
        topbarObserver = new ResizeObserver(syncTopbarHeight);
        topbarObserver.observe(topbarEl);
      }
      syncTopbarHeight();

      await load();
      try {
        await loadMessages(); // 必须先加载完消息，再扫过期，否则新消息会被加载结果覆盖
      } catch (e) {
        // 服务不可用时不中断初始化：否则重试成功后提醒定时器也不会跑
      }
      settleOverdue();
      loadPapers();
      loadSites();
      loadExpenses();
      loadInsights();
      tickTimer = setInterval(() => { state.now = Date.now(); settleOverdue(); }, 30 * 1000);
      remindTimer = setInterval(checkReminders, CONFIG.remind.checkIntervalSec * 1000);
      document.addEventListener('visibilitychange', onVisibility);
    });
    onUnmounted(() => {
      clearInterval(tickTimer);
      clearInterval(remindTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      if (topbarObserver) topbarObserver.disconnect();
      if (systemDark.removeEventListener) systemDark.removeEventListener('change', onSystemThemeChange);
      else if (systemDark.removeListener) systemDark.removeListener(onSystemThemeChange);
      window.removeEventListener('storage', onStorageTheme);
    });

    return {
      state, statusTabs, filteredActivities, urgentItems, platformOptions, toast,
      openEditor, saveActivity, setStatus, removeActivity, jumpTo,
      loadSamples, toggleNotify, load,
      paperCounts, filteredPapers, switchBoard,
      openPaperEditor, savePaper, setPaperStatus, openPaper, openPaperReveal, removePaper,
      logPaper, startPaperRead, openPaperLog, savePaperLog, removePaperLog, editPaperLog, newPaperLog,
      backToLogList, closePaperLog, saveLogDraft, discardLogDraft,
      siteCounts, filteredSites, siteNoteItem, siteKindOptions, siteUsageOptions, siteUrls,
      openSiteEditor, saveSite, setSiteStatus, openSite, removeSite,
      startSiteRead, openSiteNote, saveSiteNote, removeSiteNote, editSiteNote, newSiteNote,
      backToSiteNoteList, closeSiteNote, saveSiteNoteDraft, discardSiteNoteDraft,
      expensePeriodItems, expenseVisibleItems, expenseTotal, expenseChart, expenseCategories,
      expensePeriodLabel, expenseYearOptions,
      expenseInsights, expenseUnmatchedText,
      openExpenseEditor, saveExpense, removeExpense, setExpenseMode, setExpenseYear, setExpenseMonth,
      stepExpensePeriod, formatMoney, defaultExpenseDate, pickExpenseCategory, clearExpenseCategory,
      setExpenseView, saveInsightVerdict, clearInsightVerdict,
      unreadCount, gotoActivity, markMessageRead, removeMessage, markAllRead, clearReadMessages,
      cycleTheme, themeIcon, themeTitle,
      notifActive: computed(() => state.notifPermission === 'granted' && state.notifyOn),
      notifTitle: computed(() => {
        const h = CONFIG.remind.hours;
        if (state.notifPermission === 'denied') return '桌面通知被浏览器拒绝，可在浏览器设置里重新允许';
        if (state.notifPermission !== 'granted') return `开启桌面通知：到期前 ${h} 小时提醒`;
        return state.notifyOn
          ? `桌面通知已开启：到期前 ${h} 小时提醒，点击关闭`
          : '桌面通知已关闭，点击重新开启';
      }),
    };
  },
});

app.component('egg-card', EggCard);
app.component('egg-editor', EggEditor);
app.component('paper-card', PaperCard);
app.component('paper-editor', PaperEditor);
app.component('paper-log-drawer', PaperLogDrawer);
app.component('site-card', SiteCard);
app.component('site-editor', SiteEditor);
app.component('site-note-drawer', SiteNoteDrawer);
app.component('expense-stats', ExpenseStats);
app.component('expense-card', ExpenseCard);
app.component('expense-editor', ExpenseEditor);
app.component('insight-card', InsightCard);
app.component('message-card', MessageCard);

// 全局兜底：未被处理的网络/脚本错误给出可见提示，不再静默失败（覆盖删除、状态流转等所有板块的请求）
const describeError = (e) => (e instanceof TypeError)
  ? '网络请求失败：无法连接服务，请确认拾穗集服务已启动'
  : ('操作失败：' + ((e && e.message) ? e.message : e));
app.config.errorHandler = (err) => {
  console.error('[shisuiji] 前端错误:', err);
  if (toastBridge) toastBridge(describeError(err), 'warn');
};
window.addEventListener('unhandledrejection', (e) => {
  console.error('[shisuiji] 未处理的请求错误:', e.reason);
  if (toastBridge) toastBridge(describeError(e.reason), 'warn');
});

app.mount('#app');
