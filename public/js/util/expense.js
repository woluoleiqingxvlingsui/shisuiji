/* 拾穗集 —— 花销归类、饼图切片与体感评价素材凝练
 * 从 app.js 原样搬过来的纯函数，逻辑一字未改。
 */

import { CONFIG } from '../../config.js';
import { formatDate } from './date.js';
import { formatMoney } from './money.js';
import { platformHue } from './text.js';

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
function buildCategorySlices(items) {
  const rows = CONFIG.expenses.categories.map((c) => ({
    id: c.id,
    title: `${c.emoji} ${c.label}`,
    hue: c.hue,
    amount: (items || []).filter((e) => e.category === c.id).reduce((sum, e) => sum + (Number(e.amount) || 0), 0),
  }));
  return buildPieSlices(rows, rows.length);
}
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
function expenseHitsSubject(expense, subject) {
  const text = `${expense.title || ''}\n${expense.notes || ''}`.toLowerCase();
  return (subject.keywords || []).some((k) => text.includes(k.toLowerCase()));
}
function matchSubjects(expense) {
  return CONFIG.expenses.subjects.filter((s) => expenseHitsSubject(expense, s));
}
function splitSentences(text) {
  return String(text || '')
    .split(/[。！？!?；;\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}
function quoteTagOf(sentence) {
  const s = String(sentence).toLowerCase();
  for (const t of CONFIG.expenses.insightTags) {
    if ((t.keywords || []).some((k) => s.includes(k))) return t;
  }
  return CONFIG.expenses.insightDefaultTag;
}
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
function buildVerdictDraft(insight) {
  if (!insight.count) return '';
  const head = `累计 ${formatMoney(insight.total)} / ${insight.count} 笔`
    + (insight.lastDate ? `，最近 ${formatDate(insight.lastDate)}` : '') + '。';
  const points = insight.quotes.slice(0, 4).map((q) => `- ${String(q.date).slice(5)}：${q.sentence}`);
  return [head, ...points].join('\n');
}

export { guessExpenseCategory, expenseCategoryMeta, buildCategorySlices, groupExpenseByTitle, buildPieSlices, expenseHitsSubject, matchSubjects, splitSentences, quoteTagOf, pickQuotes, buildSubjectInsight, buildVerdictDraft };
