/* 拾穗集 —— 知识库：可反复复用的精华沉淀
 * 手动记录 + 论文/网页笔记、想法一键沉淀；标签 + 全文叠加检索（类别已废弃）。
 * 桌面端直连 REST 管理；手机端在线只读浏览（不接 outbox），也不提供沉淀入口。
 */

import { computed } from '../vue-globals.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { api } from '../api.js';
import { isDesktop } from '../perm.js';
import { kbMergeDecision } from '../util/kb-guard.js';
import { NOTE_TEXT_FIELDS, NOTE_FIELD_LABEL } from '../util/paper-note.js';
import { siteNoteFields, siteNoteFieldLabel } from '../util/site-note.js';
import { kbFileName, refreshKbFileStatus, openLocalKbFile } from '../util/kb-file.js';
import { loadBoardWithMirror } from '../offline.js';

// paper-note 的标签表只覆盖三个基本字段，其余沉淀时用这份补全
const PAPER_LABEL_FALLBACK = {
  usable: '能用吗', quotable: '可引用吗', next: '还想查什么',
  limits: '坑/局限', impression: '一句话感受', excerpt: '原文摘录',
};

async function loadKb() {
  // M20 任务 A：REST 优先，手机端离线/请求失败时静默回落镜像（并置离线提示）
  const r = await loadBoardWithMirror('/api/kb', 'kb', (items) => {
    state.kb = items;
  });
  if (r.failed) toast('知识库加载失败', 'warn');
  state.kbLoaded = true;
  // 文件状态单独查（只电脑端）：不阻塞卡片显示，失败了也不打扰用户
  refreshKbFileStatus();
}

const filteredKb = computed(() => {
  // 允许直接输入 #标签 当搜索词：先剥掉井号，标签命中按整词匹配优先
  const raw = state.kbSearch.trim().toLowerCase();
  const kw = raw.replace(/^#/, '');
  const tag = state.kbTagFilter;
  return state.kb.filter((k) => {
    if (tag && !(k.tags || []).includes(tag)) return false;
    if (!kw) return true;
    const tags = (k.tags || []).map((t) => String(t).toLowerCase());
    if (tags.includes(kw)) return true;              // 标签整词命中
    // 文件名也能被搜到（只搜文件名，不把整条路径塞进检索串）
    const fileName = k.file_path ? kbFileName(k.file_path) : '';
    return [k.title, k.content, tags.join(' '), (k.source && k.source.label) || '', fileName]
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
  // 知识库管理（新增/编辑）只在电脑端：手机端只读浏览
  if (!isDesktop()) {
    toast('知识库管理只在电脑端可用', 'warn');
    return;
  }
  state.kbEditorConfirmRef = '';
  state.editingKb = entry ? { ...entry } : null;
  state.kbPrefill = null;
  state.kbEditorOpen = true;
}

// 一键沉淀：带着预填内容开编辑器，作为新条目保存
// 沉淀属于「知识库管理」，只在电脑端做：手机端知识库只读，入口已隐藏，这里再兜一道
function openKbWithPrefill(prefill) {
  if (!isDesktop()) {
    toast('沉淀到知识库只在电脑端可用', 'warn');
    return;
  }
  state.editingKb = null;
  state.kbEditorConfirmRef = '';
  state.kbPrefill = prefill;
  state.kbEditorOpen = true;
}

function pickKbTag(tag) {
  state.kbTagFilter = state.kbTagFilter === tag ? '' : tag;
}

async function saveKb(payload) {
  // 兜底：知识库的写入（尤其是关联本地文件）只在电脑端
  if (!isDesktop()) {
    toast('知识库管理只在电脑端可用', 'warn');
    return;
  }
  const isEdit = !!state.editingKb;
  // 自己合并保存：带上 confirm_ref（这一版源笔记已处理，不再重复问）
  const confirmRef = state.kbEditorConfirmRef || '';
  const url = isEdit ? `/api/kb/${state.editingKb.id}` : '/api/kb';
  const res = await api(url, {
    method: isEdit ? 'PUT' : 'POST',
    body: JSON.stringify({ ...payload, ...(confirmRef ? { confirm_ref: confirmRef } : {}) }),
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
  state.kbEditorConfirmRef = '';
  toast(isEdit ? '已保存 ✅' : '已沉淀进知识库 📚');
  // 关联的文件可能有变：刷新一次状态（后台，不阻塞）
  refreshKbFileStatus();
}

async function removeKb(entry) {
  if (!isDesktop()) {
    toast('知识库管理只在电脑端可用', 'warn');
    return;
  }
  const name = entry.title || '这条知识';
  if (!confirm(`确定删除「${name}」吗？`)) return;
  const res = await api(`/api/kb/${entry.id}`, { method: 'DELETE' });
  if (!res.ok) return toast('删除失败：' + res.status, 'warn');
  state.kb = state.kb.filter((k) => k.id !== entry.id);
  toast('已删除 🗑');
}

/* ---- 打开关联的本地文件（只电脑端；手机端看不到这个入口） ---- */
async function openKbFile(entry) {
  if (!isDesktop()) {
    toast('打开文件只在电脑端可用', 'warn');
    return;
  }
  await openLocalKbFile(entry);
}

/* ---- 一键沉淀入口：从各板块把精华预填进知识库编辑器 ---- */
function depositFromIdea(idea) {
  openKbWithPrefill({
    title: idea.title || '',
    content: idea.content || '',
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

async function autoSyncFromNote({ type, refId, label, title, content, noteUpdatedAt }) {
  if (!String(content || '').trim() || state.role !== 'desktop') return;
  const existing = state.kb.find((k) => k.source && k.source.ref_id === refId);
  const base = {
    title: title || label || '未命名',
    content,
    source: { type, ref_id: refId, label },
    auto_sync: true,
    auto_mode: 'auto',
    ref_updated_at: noteUpdatedAt || '',
  };
  if (!existing) {
    const res = await api('/api/kb', {
      method: 'POST',
      body: JSON.stringify({ ...base, tags: [] }),
    });
    if (!res.ok) return;
    const saved = await res.json();
    state.kb = [saved, ...state.kb];
    toast('📚 已自动沉淀到知识库');
    return;
  }
  // 决策口径（见 public/js/util/kb-guard.js，与服务端一致）：
  //  - skip：这一版源笔记用户已经定过稿（保留手动版只确认这一版）→ 不再问、不覆盖；
  //  - ask：手动加工过 → 弹合并层让用户定稿（下一版源笔记仍会问）；
  //  - auto：未被手动改动 → 静默自动更新。
  const decision = kbMergeDecision(existing, noteUpdatedAt);
  if (decision === 'skip') return;
  if (decision === 'ask') {
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
      tags: existing.tags,
      base_updated_at: existing.updated_at,
    }),
  });
  if (res.status === 409) {
    const err = await res.json().catch(() => ({}));
    if (err.code === 'manual_protected') {
      // 服务端判定为受保护（两边口径不一致时以服务端为准）：走合并层
      state.kbMerge = {
        entry: { ...existing },
        incoming: { title: base.title, content },
        noteUpdatedAt: noteUpdatedAt || '',
      };
      state.siteNoteOpen = false;
      state.logOpen = false;
      return;
    }
    loadKb(); return;
  }
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
  if (choice === 'dismiss') {
    // 关闭弹窗只是「稍后处理」：不确认任何版本，不改任何东西。
    // 下一版源笔记更新时仍会重新询问。
    return;
  }
  if (choice === 'edit') {
    // 自己合并：打开编辑器改；保存时带上 confirm_ref（这一版源笔记已处理）
    state.editingKb = { ...m.entry };
    state.kbPrefill = null;
    state.kbEditorConfirmRef = m.noteUpdatedAt || '';
    state.kbEditorOpen = true;
    return;
  }
  const body = {
    source: m.entry.source,
    // 标签与关联文件不因正文同步而丢失
    tags: m.entry.tags,
    base_updated_at: m.entry.updated_at,
    confirm_ref: m.noteUpdatedAt || '',
    ref_updated_at: m.noteUpdatedAt || '',
  };
  if (choice === 'note') {
    // 用笔记版：恢复自动跟随（之后的源笔记更新不再询问）
    body.title = m.incoming.title;
    body.content = m.incoming.content;
    body.auto_sync = true;
    body.auto_mode = 'note';
  } else {
    // 保留手动版：正文与标签、关联文件一个字节都不动
    body.auto_sync = true;
    body.auto_mode = 'manual';
  }
  const res = await api(`/api/kb/${m.entry.id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return toast(err.error || ('合并保存失败：' + res.status), 'warn');
  }
  const saved = await res.json();
  state.kb = state.kb.map((k) => k.id === saved.id ? saved : k);
  toast(choice === 'note' ? '📚 已采用笔记版本' : '📚 已保留手动版本');
  loadKb();
}

export {
  loadKb, filteredKb, kbTagOptions,
  openKbEditor, pickKbTag, saveKb, removeKb, openKbFile,
  refreshKbFileStatus,
  depositFromIdea, depositFromPaperLog, depositFromSiteNote,
  autoSyncFromPaperLog, autoSyncFromSiteNote, resolveKbMerge,
};
