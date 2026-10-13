/* 拾穗集 —— 网页笔记：词表、摘要、归档门槛
 * 从 app.js 原样搬过来的纯函数，逻辑一字未改。
 */

import { CONFIG } from '../../config.js';
import { todayStr } from './date.js';

// 自定义类型的展示兜底 emoji（M20 任务 C）：没有 emoji 的自定义类型
// 用它，取代以前「回落 tech 后显示成 🔧技术」的错误表现
const CUSTOM_KIND_EMOJI = '🌐';
// 类型名长度上限：自定义类型是手写短词，过长只会挤坏卡片与筛选栏
const KIND_MAX_LEN = 12;

/** 内置类型 id 集合（config 里的 tech / misc） */
function isBuiltinKind(id) {
  return CONFIG.siteNote.kinds.some((k) => k.id === id);
}

/** 自定义类型的规范化：去空白、限长；空串返回 ''（不静默塞个默认类型） */
function sanitizeKind(value) {
  return String(value == null ? '' : value).trim().slice(0, KIND_MAX_LEN);
}

/**
 * 类型元信息。内置类型走 config；自定义类型（不在 config 里的 kind）
 * 如实显示它自己的名字，emoji 用固定兜底 —— 绝不显示 undefined 或空白。
 */
function kindMeta(id) {
  const built = CONFIG.siteNote.kinds.find((k) => k.id === id);
  if (built) return built;
  const label = sanitizeKind(id);
  return label ? { id: label, label, emoji: CUSTOM_KIND_EMOJI, custom: true } : CONFIG.siteNote.kinds[0];
}
function usageMeta(id) {
  return CONFIG.siteNote.usage.find((u) => u.id === id) || null;
}
function siteNoteKeys() {
  return Object.values(CONFIG.siteNote.fields).flat().map((f) => f.key);
}
/** 表单字段 = 共用 + 类型专属。自定义类型走 misc 那一套宽松字段（M20 任务 C） */
function siteNoteFields(kind) {
  const f = CONFIG.siteNote.fields;
  const own = isBuiltinKind(kind) ? f[kind] : f.misc;
  return [...f.common, ...(own || f.misc)];
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
  // 自定义类型走 misc 的宽松门槛（M20 任务 C）：只要求写一句话，
  // 不该拿「技术严」那套三字段去卡一条自建分类的笔记
  const gate = (isBuiltinKind(log.kind) && CONFIG.siteNote.gate[log.kind]) || CONFIG.siteNote.gate.misc;
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

export { kindMeta, usageMeta, siteNoteKeys, siteNoteFields, siteNoteFieldLabel, blankSiteNote, siteNoteIsEmpty, siteNoteMissing, siteNoteSummary, siteNoteRows, isBuiltinKind, sanitizeKind, CUSTOM_KIND_EMOJI, KIND_MAX_LEN };
