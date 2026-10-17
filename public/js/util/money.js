/* 拾穗集 —— 金额解析、格式化与统计期间
 * 从 app.js 原样搬过来的纯函数，逻辑一字未改。
 * M21 任务 B：金额精度从 2 位小数放宽到最多 4 位（整数仍不带小数，非整数最少 2 位、最多 4 位）。
 */

import { CONFIG } from '../../config.js';
import { pad2, todayStr } from './date.js';

// 金额保留的最大小数位数：解析与格式化共用，前后端要一致（server.js parseAmount 同改）
const AMOUNT_DECIMALS = 4;
// 四舍五入到 1e-4。浮点乘除后会带上尾差，格式化时 toLocaleString 再按 4 位收敛
const AMOUNT_SCALE = 10 ** AMOUNT_DECIMALS;

function parseAmountInput(raw) {
  const cleaned = String(raw == null ? '' : raw).replace(/[¥￥,，\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * AMOUNT_SCALE) / AMOUNT_SCALE;
}
function formatMoney(n) {
  const v = Number(n);
  const abs = Number.isFinite(v) ? Math.abs(Math.round(v * AMOUNT_SCALE) / AMOUNT_SCALE) : 0;
  const text = abs.toLocaleString('zh-CN', {
    minimumFractionDigits: Number.isInteger(abs) ? 0 : 2,
    maximumFractionDigits: AMOUNT_DECIMALS,
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
