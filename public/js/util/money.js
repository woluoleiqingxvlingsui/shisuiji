/* 拾穗集 —— 金额解析、格式化与统计期间
 * 从 app.js 原样搬过来的纯函数，逻辑一字未改。
 */

import { CONFIG } from '../../config.js';
import { pad2, todayStr } from './date.js';

function parseAmountInput(raw) {
  const cleaned = String(raw == null ? '' : raw).replace(/[¥￥,，\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}
function formatMoney(n) {
  const v = Number(n);
  const abs = Number.isFinite(v) ? Math.abs(Math.round(v * 100) / 100) : 0;
  const text = abs.toLocaleString('zh-CN', {
    minimumFractionDigits: Number.isInteger(abs) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${v < 0 ? '-' : ''}${CONFIG.expenses.currency}${text}`;
}
function monthOf(dateStr) {
  const s = String(dateStr || '');
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : '';
}
function periodLabel(period) {
  return period.mode === 'year' ? `${period.year} 年` : `${period.year} 年 ${period.month} 月`;
}
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

export { parseAmountInput, formatMoney, monthOf, periodLabel, defaultExpenseDate };
