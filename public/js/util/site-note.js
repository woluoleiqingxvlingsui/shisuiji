/* 拾穗集 —— 网页笔记：词表、摘要、归档门槛
 * 从 app.js 原样搬过来的纯函数，逻辑一字未改。
 */

import { CONFIG } from '../../config.js';
import { todayStr } from './date.js';

function kindMeta(id) {
  return CONFIG.siteNote.kinds.find((k) => k.id === id) || CONFIG.siteNote.kinds[0];
}
function usageMeta(id) {
  return CONFIG.siteNote.usage.find((u) => u.id === id) || null;
}
function siteNoteKeys() {
  return Object.values(CONFIG.siteNote.fields).flat().map((f) => f.key);
}
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
function siteNoteMissing(log) {
  const gate = CONFIG.siteNote.gate[log.kind] || CONFIG.siteNote.gate.tech;
  return gate.filter((k) => !String(log[k] || '').trim());
}
function siteNoteSummary(log) {
  if (!log) return '';
  for (const k of ['gist', 'facts', 'finding', 'method', 'excerpt', 'credibility']) {
    const v = String(log[k] || '').trim();
    if (v) return v;
  }
  return '';
}
function siteNoteRows(log) {
  return siteNoteFields(log.kind).filter((f) => String(log[f.key] || '').trim());
}

export { kindMeta, usageMeta, siteNoteKeys, siteNoteFields, siteNoteFieldLabel, blankSiteNote, siteNoteIsEmpty, siteNoteMissing, siteNoteSummary, siteNoteRows };
