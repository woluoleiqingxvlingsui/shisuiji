/* 拾穗集 —— 知识库：可反复复用的精华沉淀
 * 手动记录 + 论文/网页笔记、想法一键沉淀；类别 + 标签 + 全文叠加检索。
 * 桌面端直连 REST 管理；手机端在线只读浏览（不接 outbox）。
 */

import { computed } from '../vue-globals.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { api } from '../api.js';
import { CONFIG } from '../../config.js';
import { NOTE_TEXT_FIELDS, NOTE_FIELD_LABEL } from '../util/paper-note.js';
import { siteNoteFields, siteNoteFieldLabel } from '../util/site-note.js';

// paper-note 的标签表只覆盖三个基本字段，其余沉淀时用这份补全
const PAPER_LABEL_FALLBACK = {
  usable: '能用吗', quotable: '可引用吗', next: '还想查什么',
  limits: '坑/局限', impression: '一句话感受', excerpt: '原文摘录',
};

async function loadKb() {
  try {
    const res = await api('/api/kb');
    state.kb = await res.json();
  } catch {
    toast('知识库加载失败', 'warn');
  }
  state.kbLoaded = true;
}

const kbCategories = computed(() => CONFIG.kb.categories);

const filteredKb = computed(() => {
  const kw = state.kbSearch.trim().toLowerCase();
  const cat = state.kbCategoryFilter;
  const tag = state.kbTagFilter;
  return state.kb.filter((k) => {
    if (cat && k.category !== cat) return false;
    if (tag && !(k.tags || []).includes(tag)) return false;
    if (!kw) return true;
    return [k.title, k.content, (k.tags || []).join(' '), (k.source && k.source.label) || '']
      .join(' ').toLowerCase().includes(kw);
  });
});

// 标签云选项：按条数倒序，点一下筛选、再点取消
const kbTagOptions = computed(() => {
  const counts = new Map();
  for (const k of state.kb) for (const t of k.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([tag, count]) => ({ tag, count }));
});

function openKbEditor(entry) {
  state.editingKb = entry ? { ...entry } : null;
  state.kbPrefill = null;
  state.kbEditorOpen = true;
}

// 一键沉淀：带着预填内容开编辑器，作为新条目保存
function openKbWithPrefill(prefill) {
  state.editingKb = null;
  state.kbPrefill = prefill;
  state.kbEditorOpen = true;
}

function pickKbCategory(id) {
  state.kbCategoryFilter = state.kbCategoryFilter === id ? '' : id;
}

function pickKbTag(tag) {
  state.kbTagFilter = state.kbTagFilter === tag ? '' : tag;
}

async function saveKb(payload) {
  const isEdit = !!state.editingKb;
  const url = isEdit ? `/api/kb/${state.editingKb.id}` : '/api/kb';
  const res = await api(url, {
    method: isEdit ? 'PUT' : 'POST',
    body: JSON.stringify(payload),
  });
  const saved = await res.json().catch(() => ({}));
  if (res.status === 409) {
    state.kbEditorOpen = false;
    toast('这条知识在别处改过，已刷新为最新内容', 'warn');
    loadKb();
    return;
  }
  if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
  state.kb = [saved, ...state.kb.filter((k) => k.id !== saved.id)]
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  state.kbEditorOpen = false;
  state.kbPrefill = null;
  toast(isEdit ? '已保存 ✅' : '已沉淀进知识库 📚');
}

async function removeKb(entry) {
  const name = entry.title || '这条知识';
  if (!confirm(`确定删除「${name}」吗？`)) return;
  const res = await api(`/api/kb/${entry.id}`, { method: 'DELETE' });
  if (!res.ok) return toast('删除失败：' + res.status, 'warn');
  state.kb = state.kb.filter((k) => k.id !== entry.id);
  toast('已删除 🗑');
}

/* ---- 一键沉淀入口：从各板块把精华预填进知识库编辑器 ---- */
function depositFromIdea(idea) {
  openKbWithPrefill({
    title: idea.title || '',
    content: idea.content || '',
    category: 'inspiration',
    tags: [],
    source: { type: 'idea', ref_id: idea.id || '', label: idea.title || '想法' },
  });
}

function depositFromPaperLog(paper, log) {
  const lines = NOTE_TEXT_FIELDS
    .filter((f) => String(log[f] || '').trim())
    .map((f) => `${NOTE_FIELD_LABEL[f] || PAPER_LABEL_FALLBACK[f] || f}：${String(log[f]).trim()}`);
  openKbWithPrefill({
    title: paper && paper.title ? `${paper.title} · 沉淀` : '论文沉淀',
    content: lines.join('\n'),
    category: 'method',
    tags: [],
    source: { type: 'paper', ref_id: (paper && paper.id) || '', label: (paper && paper.title) || '' },
  });
}

function depositFromSiteNote(site, log) {
  const fields = siteNoteFields((log && log.kind) || (site && site.kind) || 'tech');
  const lines = fields
    .filter((f) => String(log[f.key] || '').trim())
    .map((f) => `${siteNoteFieldLabel(f.key)}：${String(log[f.key]).trim()}`);
  openKbWithPrefill({
    title: site && site.title ? `${site.title} · 沉淀` : '网页沉淀',
    content: lines.join('\n'),
    category: 'method',
    tags: [],
    source: { type: 'site', ref_id: (site && site.id) || '', label: (site && site.title) || '' },
  });
}

/* ---- 自动沉淀：阅读笔记保存时同步进知识库 ----
 * 规则（用户定）：条目不存在 → 新建；存在且上次自动同步后没被手动调整过 → 直接覆盖；
 * 存在且被手动调整过 → 弹合并层，由用户在「笔记版 / 手动版 / 自己合并」里定稿。
 */
function paperLogContent(log) {
  return NOTE_TEXT_FIELDS
    .filter((f) => String(log[f] || '').trim())
    .map((f) => `${NOTE_FIELD_LABEL[f] || PAPER_LABEL_FALLBACK[f] || f}：${String(log[f]).trim()}`)
    .join('\n');
}

function siteNoteContent(site, log) {
  const fields = siteNoteFields((log && log.kind) || (site && site.kind) || 'tech');
  return fields
    .filter((f) => String(log[f.key] || '').trim())
    .map((f) => `${siteNoteFieldLabel(f.key)}：${String(log[f.key]).trim()}`)
    .join('\n');
}

function manualTouched(entry) {
  return !!(entry.manual_at && (!entry.auto || !entry.auto.at || String(entry.manual_at) > String(entry.auto.at)));
}

async function autoSyncFromNote({ type, refId, label, title, content, noteUpdatedAt }) {
  if (!String(content || '').trim() || state.role !== 'desktop') return;
  const existing = state.kb.find((k) => k.source && k.source.ref_id === refId);
  const base = {
    title: title || label || '未命名',
    content,
    source: { type, ref_id: refId, label },
    auto_sync: true,
    ref_updated_at: noteUpdatedAt || '',
  };
  if (!existing) {
    const res = await api('/api/kb', {
      method: 'POST',
      body: JSON.stringify({ ...base, category: 'method', tags: [] }),
    });
    if (!res.ok) return;
    const saved = await res.json();
    state.kb = [saved, ...state.kb];
    toast('📚 已自动沉淀到知识库');
    return;
  }
  if (manualTouched(existing)) {
    // 手动调整过：不覆盖，交给用户定稿；关掉底层笔记抽屉，合并层单独呈现
    state.kbMerge = {
      entry: { ...existing },
      incoming: { title: base.title, content },
      noteUpdatedAt: noteUpdatedAt || '',
    };
    state.siteNoteOpen = false;
    state.logOpen = false;
    return;
  }
  const res = await api(`/api/kb/${existing.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      ...base,
      category: existing.category,
      tags: existing.tags,
      base_updated_at: existing.updated_at,
    }),
  });
  if (res.status === 409) { loadKb(); return; }
  if (!res.ok) return;
  const saved = await res.json();
  state.kb = state.kb.map((k) => (k.id === saved.id ? saved : k));
  toast('📚 知识库条目已随笔记更新');
}

function autoSyncFromPaperLog(paper, log) {
  return autoSyncFromNote({
    type: 'paper',
    refId: `${paper.id}:${log.id}`,
    label: paper.title || '',
    title: paper && paper.title ? `${paper.title} · 沉淀` : '论文沉淀',
    content: paperLogContent(log),
    noteUpdatedAt: log.updated_at || '',
  });
}

function autoSyncFromSiteNote(site, log) {
  return autoSyncFromNote({
    type: 'site',
    refId: `${site.id}:${log.id}`,
    label: site.title || '',
    title: site && site.title ? `${site.title} · 沉淀` : '网页沉淀',
    content: siteNoteContent(site, log),
    noteUpdatedAt: log.updated_at || '',
  });
}

/* ---- 合并层：笔记版 vs 手动版，由用户定稿 ---- */
async function resolveKbMerge(choice) {
  const m = state.kbMerge;
  if (!m) return;
  state.kbMerge = null;
  if (choice === 'edit') {
    state.editingKb = { ...m.entry };
    state.kbPrefill = null;
    state.kbEditorOpen = true;
    return;
  }
  const body = choice === 'note'
    ? {
      title: m.incoming.title,
      content: m.incoming.content,
      category: m.entry.category,
      tags: m.entry.tags,
      source: m.entry.source,
    }
    : {}; // 保留手动版：只更新 auto 基线，避免同一笔记版本反复弹
  const res = await api(`/api/kb/${m.entry.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      ...body,
      auto_sync: true,
      ref_updated_at: m.noteUpdatedAt,
      base_updated_at: m.entry.updated_at,
    }),
  });
  if (!res.ok) return toast('合并保存失败：' + res.status, 'warn');
  toast(choice === 'note' ? '📚 已采用笔记版本' : '📚 已保留手动版本');
  loadKb();
}

export {
  loadKb, kbCategories, filteredKb, kbTagOptions,
  openKbEditor, pickKbCategory, pickKbTag, saveKb, removeKb,
  depositFromIdea, depositFromPaperLog, depositFromSiteNote,
  autoSyncFromPaperLog, autoSyncFromSiteNote, resolveKbMerge,
};
