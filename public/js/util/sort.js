/* 拾穗集 —— 列表排序：按最近阅读时间刷新（文献与网页共用）
 * 从 app.js 原样搬过来的纯函数，逻辑一字未改。
 */

import { parseStoredDate } from './date.js';

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
function readSortKey(item) {
  return Math.max(Date.parse(item.created_at || '') || 0, readSortTime(item));
}

export { readSortTime, readSortKey };
