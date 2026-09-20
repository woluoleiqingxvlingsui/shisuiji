/* 拾穗集 —— 花销体感评价：按主体凝练记录里的原话
 * 从 app.js 原样搬过来的，逻辑一字未改。
 */

/* ---- 花销板块：体感评价 ---- */
/* ---- 花销板块：体感评价（全量历史视角，不随月 / 年期间切换） ---- */

import { computed } from '../vue-globals.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { CONFIG } from '../../config.js';
import { buildSubjectInsight, matchSubjects } from '../util/expense.js';

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
async function clearInsightVerdict(row) {
  if (!confirm(`清空「${row.subject.label}」的评价吗？（记录原话还在，随时能重新写）`)) return;
  const res = await fetch(`/api/insights/${encodeURIComponent(row.subject.id)}`, { method: 'DELETE' });
  if (!res.ok) return toast('删除失败：' + res.status, 'warn');
  state.insights = state.insights.filter((v) => v.subject !== row.subject.id);
  toast('已清除 🧹');
}
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
const expenseUnmatchedText = computed(() => {
  const list = expenseInsights.value.unmatched;
  const titles = list.slice(0, 5).map((e) => String(e.title || '未命名'));
  return titles.join('、') + (list.length > 5 ? ` 等 ${list.length} 笔` : '');
});

export { loadInsights, setExpenseView, saveInsightVerdict, clearInsightVerdict, expenseInsights, expenseUnmatchedText };
