/* 拾穗集 —— 花销：记账、统计期间与饼图
 * 从 app.js 原样搬过来的，逻辑一字未改。
 */

/* ---- 花销板块 ---- */
/* ---- 花销板块：派生数据 ---- */

import { computed } from '../vue-globals.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { api } from '../api.js';
import { CONFIG } from '../../config.js';
import { pad2 } from '../util/date.js';
import { buildCategorySlices, buildPieSlices, groupExpenseByTitle } from '../util/expense.js';
import { formatMoney, monthOf, periodLabel } from '../util/money.js';

let expensePeriodInit = false; // 只做一次「自动跳到最近有记录的月份」
async function loadExpenses() {
  try {
    state.expenses = await api('/api/expenses').then((r) => r.json());
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
  const res = await api(url, {
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
  const res = await api(`/api/expenses/${expense.id}`, { method: 'DELETE' });
  if (!res.ok) return toast('删除失败：' + res.status, 'warn');
  state.expenses = state.expenses.filter((e) => e.id !== expense.id);
  toast('已删除 🗑');
}
function setExpenseMode(mode) {
  state.expensePeriod.mode = mode;
  // 类别下钻只属于「按年」：按月是按条目看的，切过去就把筛选清掉，别把年视图的类别带进月视图
  if (mode !== 'year') state.expenseCategory = '';
  localStorage.setItem('danji.expenseMode', mode);
}
function pickExpenseCategory(id) {
  state.expenseCategory = state.expenseCategory === id ? '' : id;
}
function clearExpenseCategory() { state.expenseCategory = ''; }
function setExpenseYear(year) { state.expensePeriod.year = year; }
function setExpenseMonth(month) { state.expensePeriod.month = month; }
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
const expenseVisibleItems = computed(() => (state.expenseCategory
  ? expensePeriodItems.value.filter((e) => e.category === state.expenseCategory)
  : expensePeriodItems.value));
const expenseTotal = computed(() => expenseVisibleItems.value.reduce((sum, e) => sum + (Number(e.amount) || 0), 0));
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
const expenseYearOptions = computed(() => {
  const years = new Set(state.expenses.map((e) => Number(String(e.date).slice(0, 4))).filter(Boolean));
  years.add(new Date().getFullYear());
  years.add(state.expensePeriod.year);
  return [...years].sort((a, b) => b - a);
});

export { expensePeriodInit, loadExpenses, openExpenseEditor, saveExpense, removeExpense, setExpenseMode, pickExpenseCategory, clearExpenseCategory, setExpenseYear, setExpenseMonth, stepExpensePeriod, expensePeriodItems, expenseVisibleItems, expenseTotal, expenseChart, expenseCategories, expensePeriodLabel, expenseYearOptions };
