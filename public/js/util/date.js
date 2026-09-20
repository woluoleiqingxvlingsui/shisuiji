/* 拾穗集 —— 日期解析、格式化与紧急度倒计时
 * 从 app.js 原样搬过来的纯函数，逻辑一字未改。
 */

import { CONFIG } from '../../config.js';
import { HOUR } from './const.js';

function pad2(n) {
  return String(n).padStart(2, '0');
}
function parseStoredDate(str) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return new Date(`${str}T23:59:59`);
  return new Date(str);
}
function formatDate(str) {
  if (!str) return '';
  const d = parseStoredDate(str);
  if (isNaN(d)) return str;
  const now = new Date();
  const date = `${d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '-'}${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return String(str).length > 10 ? `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : date;
}
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
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export { pad2, parseStoredDate, formatDate, parseFlexibleDate, formatRemaining, computeUrgency, todayStr };
