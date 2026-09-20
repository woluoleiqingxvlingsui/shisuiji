/* 拾穗集 —— 文献阅读记录：词表、摘要、归档门槛
 * 从 app.js 原样搬过来的纯函数，逻辑一字未改。
 */

import { CONFIG } from '../../config.js';
import { todayStr } from './date.js';

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
function noteSummary(log) {
  if (!log) return '';
  for (const f of ['finding', 'impression', 'usable', 'method', 'problem']) {
    const v = String(log[f] || '').trim();
    if (v) return v;
  }
  return '';
}
const NOTE_BASIC_FIELDS = ['problem', 'method', 'finding'];
const NOTE_FIELD_LABEL = { problem: '核心问题', method: '核心做法', finding: '核心发现' };
function noteBasicMissing(log) {
  return NOTE_BASIC_FIELDS.filter((f) => !String(log[f] || '').trim());
}

export { NOTE_TEXT_FIELDS, noteRelMeta, notePartLabel, notePartsText, blankPaperLog, noteIsEmpty, noteSummary, NOTE_BASIC_FIELDS, NOTE_FIELD_LABEL, noteBasicMissing };
