/* 拾穗集 —— 回收站的展示辅助（M20 任务 D）
 * 纯函数，不碰 state 与网络，便于单测与复用。
 *
 * M21-A：回收站卡片默认展开、要能确认「删掉的到底是什么」，所以这里按来源板块
 * 把原记录（payload 全文）拍平成「完整详情行」：每行 { label, value, multiline? }，
 * 值一律完整不截断；空字段直接跳过，绝不出现 undefined / 空白行。
 * 卡片只负责排版与图片缩略图，本文件不碰 DOM。
 */

import { CONFIG } from '../../config.js';
import { formatDate } from './date.js';
import { formatMoney } from './money.js';
import { typeMeta, statusMeta } from './meta.js';
import { expenseCategoryMeta } from './expense.js';
import { NOTE_TEXT_FIELDS, NOTE_FIELD_LABEL, noteRelMeta, notePartsText } from './paper-note.js';
import { siteNoteKeys, siteNoteFieldLabel, kindMeta, usageMeta } from './site-note.js';

// 来源板块徽标。activities 是赛博鸡蛋的内部数组名，用户看到的是「赛博鸡蛋」
const TRASH_SOURCE_META = {
  ideas: { label: '随记', emoji: '📝' },
  activities: { label: '赛博鸡蛋', emoji: '🥚' },
  expenses: { label: '花销', emoji: '💰' },
  achievements: { label: '成果', emoji: '🏅' },
  kb: { label: '知识库', emoji: '📚' },
  sites: { label: '网页', emoji: '🌐' },
  papers: { label: '文献', emoji: '📄' },
};

// 知识库来源类型的中文名（与 kb-card.js 的 SOURCE_LABEL 一致）
const KB_SOURCE_LABEL = { paper: '论文', site: '网页', idea: '想法', manual: '手动' };

// paper-note 的标签表只覆盖三个基本字段，其余字段这里补全（与 boards/kb.js 的同名表一致）
const PAPER_LABEL_FALLBACK = {
  usable: '能用吗', quotable: '可引用吗', next: '还想查什么',
  limits: '坑/局限', impression: '一句话感受', excerpt: '原文摘录',
};

/** 标题：各板块的主标题字段不一样；都没有就退回「未命名」 */
function trashTitle(entry) {
  const p = (entry && entry.payload) || {};
  const t = p.title || p.content || p.name;
  return t ? String(t).trim() : '（无标题）';
}

/** 摘要：帮助认出删掉的是什么。有标题时只补正文/来源线索，不堆无关字段 */
function trashSummary(entry) {
  const p = (entry && entry.payload) || {};
  const title = p.title || p.content || p.name;
  if (title) {
    // 有标题又同时有正文：补一句正文；否则到此为止（再堆字段只会变噪音）
    return p.content && p.content !== p.title ? String(p.content).trim().slice(0, 60) : '';
  }
  // 没有标题的记录（花销、知识库等）才用别的字段顶上
  if (p.platform) return String(p.platform);
  if (p.url) return String(p.url);
  if (p.file_name) return String(p.file_name);
  if (p.amount !== undefined && p.amount !== null && p.amount !== '') return '¥' + p.amount;
  return '';
}

/** 还剩几天（不足一天按 1 天算；已到期返回 0） */
function trashDaysLeft(entry, now = Date.now()) {
  const t = Date.parse((entry && entry.expire_at) || '');
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t - now) / 86400000));
}

/* ---------------- M21-A：完整详情行 ---------------- */

/** 统一取值：null/undefined/纯空白都当没有，返回去空白的字符串 */
function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** 推入一行非空详情；multiline 的行按「标签一行、正文多行」排版 */
function pushRow(rows, label, value, multiline = false) {
  const text = cleanText(value);
  if (!text) return;
  rows.push(multiline ? { label, value: text, multiline: true } : { label, value: text });
}

/** 标签 / 链接这类数组：逐项去空后用顿号连起来（没有内容就不显示这一行） */
function joinList(list) {
  return (Array.isArray(list) ? list : []).map(cleanText).filter(Boolean).join('、');
}

/** 日志按时间倒序（新的在前，与阅读记录抽屉一致） */
function sortLogsDesc(logs) {
  return (Array.isArray(logs) ? logs : []).slice()
    .sort((a, b) => String((b && b.read_at) || '').localeCompare(String((a && a.read_at) || '')));
}

function ideaDetailRows(rows, p) {
  pushRow(rows, '标题', p.title);
  pushRow(rows, '内容', p.content, true);
  if (p.pinned) pushRow(rows, '置顶', '📌 已置顶');
  const images = Array.isArray(p.images) ? p.images : [];
  if (images.length) pushRow(rows, '图片', `${images.length} 张（缩略图见下方）`);
}

function activityDetailRows(rows, p) {
  pushRow(rows, '平台', p.platform);
  pushRow(rows, '标题', p.title);
  // 枚举字段只认合法 id：缺失时查表会回落成默认项，凭空显示「其他 / 待领取」是假信息
  if (cleanText(p.type)) pushRow(rows, '类型', typeMeta(p.type).label);
  if (cleanText(p.status)) pushRow(rows, '状态', statusMeta(p.status).label);
  pushRow(rows, '价值', p.value);
  if (cleanText(p.claim_deadline)) pushRow(rows, '领取截止', formatDate(p.claim_deadline));
  if (cleanText(p.valid_until)) pushRow(rows, '有效期', formatDate(p.valid_until));
  pushRow(rows, '领取步骤', p.claim_steps, true);
  pushRow(rows, '链接', p.link);
  pushRow(rows, '标签', joinList(p.tags));
  pushRow(rows, '备注', p.notes, true);
}

function expenseDetailRows(rows, p) {
  pushRow(rows, '标题', p.title);
  // 金额 0 是合法数据，不能用真值判断
  if (p.amount !== undefined && p.amount !== null && cleanText(p.amount) !== '') {
    pushRow(rows, '金额', formatMoney(p.amount));
  }
  if (cleanText(p.date)) pushRow(rows, '日期', formatDate(p.date));
  if (cleanText(p.category)) {
    const category = expenseCategoryMeta(p.category);
    pushRow(rows, '类别', `${category.emoji} ${category.label}`);
  }
  pushRow(rows, '备注', p.notes, true);
}

function achievementDetailRows(rows, p) {
  pushRow(rows, '标题', p.title);
  const category = CONFIG.achievements.categories.find((c) => c.id === p.category);
  if (category) pushRow(rows, '类别', `${category.emoji} ${category.label}`);
  const status = CONFIG.achievements.statuses.find((s) => s.id === p.status);
  if (status) pushRow(rows, '状态', `${status.emoji} ${status.label}`);
  pushRow(rows, '日期', p.date);
  pushRow(rows, '内容', p.content, true);
  pushRow(rows, '亮点', p.highlight, true);
  pushRow(rows, '标签', joinList(p.tags));
  if (Array.isArray(p.links) && p.links.length) pushRow(rows, '链接', p.links.join('\n'), true);
}

function kbDetailRows(rows, p) {
  pushRow(rows, '标题', p.title);
  pushRow(rows, '内容', p.content, true);
  pushRow(rows, '标签', joinList(p.tags));
  const source = p.source && typeof p.source === 'object' ? p.source : null;
  if (source) {
    const label = cleanText(source.label) || KB_SOURCE_LABEL[source.type] || '';
    pushRow(rows, '来源', label);
  }
}

function siteDetailRows(rows, p) {
  pushRow(rows, '标题', p.title);
  pushRow(rows, '链接', p.url);
  if (cleanText(p.kind)) {
    const kind = kindMeta(p.kind);
    pushRow(rows, '类型', `${kind.emoji} ${kind.label}`);
  }
  if (cleanText(p.status)) pushRow(rows, '状态', p.status === 'read' ? '✅ 已读' : '📖 待读');
  pushRow(rows, '标签', joinList(p.tags));
  pushRow(rows, '备注', p.notes, true);
  // 阅读笔记：每条一个详情行，read_at + 该条所有写过的字段全文展示
  for (const log of sortLogsDesc(p.logs)) {
    const lines = [];
    if (cleanText(log.kind)) {
      const kind = kindMeta(log.kind);
      lines.push(`${kind.emoji} ${kind.label}`);
    }
    const usage = usageMeta(log.usage);
    if (usage) lines.push(`${usage.emoji} ${usage.label}`);
    for (const key of siteNoteKeys()) {
      const value = cleanText(log[key]);
      if (value) lines.push(`${siteNoteFieldLabel(key)}：${value}`);
    }
    if (!lines.length) lines.push('（这条阅读笔记没有文字内容）');
    rows.push({
      label: `阅读笔记 · ${cleanText(log.read_at) ? formatDate(log.read_at) : '未填日期'}`,
      value: lines.join('\n'),
      multiline: true,
    });
  }
}

function paperDetailRows(rows, p) {
  pushRow(rows, '标题', p.title);
  pushRow(rows, '类别', p.category);
  if (cleanText(p.status)) pushRow(rows, '状态', p.status === 'read' ? '✅ 已读' : '📖 待读');
  pushRow(rows, '文件名', p.file_name);
  pushRow(rows, '备注', p.notes, true);
  // 阅读日志：每条一个详情行，read_at + 关联度/最有用的部分 + 所有写过的字段全文
  for (const log of sortLogsDesc(p.logs)) {
    const lines = [];
    const rel = noteRelMeta(log.rel);
    if (rel) lines.push(`关联度：${rel.emoji} ${rel.label}`);
    const parts = notePartsText(log);
    if (parts.length) lines.push(`最有用的部分：${parts.join(' · ')}`);
    for (const key of NOTE_TEXT_FIELDS) {
      const value = cleanText(log[key]);
      if (value) lines.push(`${NOTE_FIELD_LABEL[key] || PAPER_LABEL_FALLBACK[key] || key}：${value}`);
    }
    if (!lines.length) lines.push('（这条阅读日志没有文字内容）');
    rows.push({
      label: `阅读日志 · ${cleanText(log.read_at) ? formatDate(log.read_at) : '未填日期'}`,
      value: lines.join('\n'),
      multiline: true,
    });
  }
}

const DETAIL_ROW_BUILDERS = {
  ideas: ideaDetailRows,
  activities: activityDetailRows,
  expenses: expenseDetailRows,
  achievements: achievementDetailRows,
  kb: kbDetailRows,
  sites: siteDetailRows,
  papers: paperDetailRows,
};

/**
 * 把一条回收站记录拍平成按来源定制的完整详情行。
 * @returns {{label: string, value: string, multiline?: boolean}[]}
 */
function trashDetailRows(entry) {
  const p = (entry && entry.payload) || {};
  const rows = [];
  const build = DETAIL_ROW_BUILDERS[(entry && entry.source) || ''];
  if (build) {
    build(rows, p);
  } else {
    // 未知来源（未来新增板块 / 老数据）：至少把能认出来的标题与正文展示出来
    pushRow(rows, '标题', p.title || p.name);
    pushRow(rows, '内容', p.content, true);
  }
  return rows;
}

/** 详情文本：供回收站搜索把被删记录的正文也纳入 haystack */
function trashDetailText(entry) {
  return trashDetailRows(entry).map((row) => `${row.label} ${row.value}`).join('\n');
}

export {
  TRASH_SOURCE_META, trashTitle, trashSummary, trashDaysLeft,
  trashDetailRows, trashDetailText,
};
