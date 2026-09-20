/* 拾穗集 —— 文献：待读 / 已读管理与阅读记录
 * 从 app.js 原样搬过来的，逻辑一字未改。
 */

/* ---- 文献板块 ---- */
/* ---- 阅读记录（logs） ---- */

import { computed } from '../vue-globals.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { api } from '../api.js';
import { LOG_DRAFT_PREFIX, clearDraft, readDraft, writeDraft } from '../util/draft.js';
import { NOTE_FIELD_LABEL, NOTE_TEXT_FIELDS, blankPaperLog, noteBasicMissing, noteIsEmpty, notePartsText } from '../util/paper-note.js';
import { readSortKey } from '../util/sort.js';
import { flashCard } from '../ui.js';

async function loadPapers() {
  try {
    const [papers, cats] = await Promise.all([
      api('/api/papers').then((r) => r.json()),
      api('/api/papers/categories').then((r) => r.json()),
    ]);
    state.papers = papers;
    state.paperCategories = cats;
  } catch {
    toast('论文数据加载失败', 'warn');
  }
  state.papersLoaded = true;
}
function openPaperEditor(paper) {
  state.editingPaper = paper ? { ...paper } : null;
  state.paperEditorOpen = true;
}
async function savePaper(payload) {
  const isEdit = !!state.editingPaper;
  const url = isEdit ? `/api/papers/${state.editingPaper.id}` : '/api/papers';
  const res = await api(url, {
    method: isEdit ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const saved = await res.json().catch(() => ({}));
  if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
  if (isEdit) {
    const idx = state.papers.findIndex((p) => p.id === saved.id);
    if (idx !== -1) state.papers.splice(idx, 1, saved);
  } else {
    state.papers.push(saved);
  }
  state.paperEditorOpen = false;
  loadPapers(); // 类别/文件状态可能变了，顺手刷新
  if (saved.missing) toast('文件没找到，已仅创建记录', 'warn');
  else if (saved.moved) toast(`已归档到 ${saved.status === 'read' ? '已读' : '待读'}/${saved.category} 📂`);
  else toast(isEdit ? '已保存 ✅' : '记好了，一篇论文 📄');
}
async function setPaperStatus(paper, status) {
  const res = await api(`/api/papers/${paper.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...paper, status }),
  });
  const saved = await res.json().catch(() => ({}));
  if (!res.ok) return toast('更新失败：' + (saved.error || res.status), 'warn');
  const idx = state.papers.findIndex((p) => p.id === saved.id);
  if (idx !== -1) state.papers.splice(idx, 1, saved);
  toast(status === 'read' ? `已移入 已读/${saved.category} ✅` : `已移回 待读/${saved.category} 📖`);
}
const logPaper = computed(() => state.papers.find((p) => p.id === state.logPaperId) || null);
function openPaperLog(paper, mode = 'list', pendingRead = false) {
  state.logPaperId = paper.id;
  state.logPendingRead = pendingRead;
  const draft = mode === 'new' ? readDraft(LOG_DRAFT_PREFIX, paper.id) : null; // 没写完的草稿自动带回
  state.logRestored = !!draft;
  state.logDraftSnapshot = draft;
  state.logEditing = draft
    ? { ...blankPaperLog(), ...draft, parts: [...(draft.parts || [])] }
    : ((mode === 'new' || !(paper.logs || []).length) ? blankPaperLog() : null);
  state.logOpen = true;
}
function startPaperRead(paper) { openPaperLog(paper, 'new', true); }
function newPaperLog() {
  state.logPendingRead = false;
  state.logRestored = false;
  state.logDraftSnapshot = null;
  state.logEditing = blankPaperLog();
}
function editPaperLog(log) { state.logEditing = { ...log, parts: [...(log.parts || [])] }; }
function backToLogList() {
  if (state.logPendingRead) return closePaperLog(); // 还没归档，回列表没意义
  state.logEditing = null;
}
let draftTimer = null;
function saveLogDraft(form) {
  if (!state.logPendingRead || !state.logPaperId) return;
  state.logDraftSnapshot = form;
  clearTimeout(draftTimer);
  const paperId = state.logPaperId;
  draftTimer = setTimeout(() => writeDraft(LOG_DRAFT_PREFIX, paperId, form, noteIsEmpty), 400);
}
function discardLogDraft() {
  clearTimeout(draftTimer);
  clearDraft(LOG_DRAFT_PREFIX, state.logPaperId);
  state.logRestored = false;
  state.logDraftSnapshot = null;
  toast('草稿已丢弃 🧹');
}
function closePaperLog() {
  clearTimeout(draftTimer);
  const wasPendingRead = state.logPendingRead;
  const paperId = state.logPaperId;
  if (wasPendingRead && paperId && state.logDraftSnapshot) writeDraft(LOG_DRAFT_PREFIX, paperId, state.logDraftSnapshot, noteIsEmpty);
  state.logPendingRead = false;
  state.logRestored = false;
  state.logDraftSnapshot = null;
  state.logOpen = false;
  state.logPaperId = null;
  state.logEditing = null;
  if (wasPendingRead && paperId) {
    toast(readDraft(LOG_DRAFT_PREFIX, paperId) ? '没写满，这篇还留在「待读」，内容已存草稿' : '没记笔记，这篇还留在「待读」');
  }
}
async function savePaperLog(form) {
  const paper = logPaper.value;
  if (!paper) return;

  // 读完引导：三行速记写满才允许归档；已读补记只要非空即可
  if (state.logPendingRead) {
    const missing = noteBasicMissing(form);
    if (missing.length) {
      return toast(`还差「${missing.map((f) => NOTE_FIELD_LABEL[f]).join('、')}」，这篇先留在「待读」`, 'warn');
    }
  } else if (noteIsEmpty(form)) {
    return toast('这条记录还是空的，写点内容再保存', 'warn');
  }

  const logs = [...(paper.logs || [])];
  const idx = logs.findIndex((l) => l.id === form.id);
  if (idx === -1) logs.push(form); else logs.splice(idx, 1, form);
  const patch = { ...paper, logs };
  const wasPendingRead = state.logPendingRead;
  if (wasPendingRead) patch.status = 'read'; // 笔记与状态同一次 PUT，原子落盘

  const res = await api(`/api/papers/${paper.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const saved = await res.json().catch(() => ({}));
  if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
  const i = state.papers.findIndex((p) => p.id === saved.id);
  if (i !== -1) state.papers.splice(i, 1, saved);

  clearTimeout(draftTimer);
  clearDraft(LOG_DRAFT_PREFIX, paper.id);
  state.logPendingRead = false;
  state.logRestored = false;
  state.logDraftSnapshot = null;
  state.logEditing = null; // 保存后回到列表
  toast(wasPendingRead
    ? `读完了！已归档到 已读/${saved.category} 🎉`
    : (idx === -1 ? '已记下这条阅读记录 📝' : '记录已更新 ✅'));
}
async function removePaperLog(log) {
  const paper = logPaper.value;
  if (!paper) return;
  if (!confirm(`删除 ${log.read_at || '这条'} 的阅读记录吗？`)) return;
  const logs = (paper.logs || []).filter((l) => l.id !== log.id);
  const res = await api(`/api/papers/${paper.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...paper, logs }),
  });
  const saved = await res.json().catch(() => ({}));
  if (!res.ok) return toast('删除失败：' + (saved.error || res.status), 'warn');
  const i = state.papers.findIndex((p) => p.id === saved.id);
  if (i !== -1) state.papers.splice(i, 1, saved);
  toast('已删除这条记录 🗑');
}
async function openPaper(paper) {
  toast('正在打开…');
  const res = await api(`/api/papers/${paper.id}/open`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return toast(data.error || '打开失败', 'warn');
  // 服务端已记下 last_read_at，用它替换本地这条 → 列表按阅读时间重排，这张卡升到顶部
  if (data.paper) {
    const idx = state.papers.findIndex((p) => p.id === data.paper.id);
    if (idx !== -1) state.papers.splice(idx, 1, data.paper);
    flashCard(data.paper.id);
    toast('📖 已打开，这张卡已置顶');
  } else {
    toast('📖 已打开');
  }
}
async function openPaperReveal(paper) {
  const res = await api(`/api/papers/${paper.id}/reveal`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) toast(data.error || '打开失败', 'warn');
}
async function removePaper(paper) {
  if (!confirm(`确定删除记录「${paper.title}」吗？（磁盘上的文件不会被删）`)) return;
  const res = await api(`/api/papers/${paper.id}`, { method: 'DELETE' });
  if (!res.ok) return toast('删除失败：' + res.status, 'warn');
  state.papers = state.papers.filter((p) => p.id !== paper.id);
  toast('已删除记录 🗑（文件保留）');
}
const paperCounts = computed(() => ({
  all: state.papers.length,
  to_read: state.papers.filter((p) => p.status === 'to_read').length,
  read: state.papers.filter((p) => p.status === 'read').length,
  noted: state.papers.filter((p) => (p.logs || []).length).length,
  unnoted: state.papers.filter((p) => !(p.logs || []).length).length,
}));
function logHaystack(logs) {
  return logs.flatMap((l) => [
    l.read_at, ...NOTE_TEXT_FIELDS.map((f) => l[f]), ...notePartsText(l),
  ]).filter(Boolean);
}
const filteredPapers = computed(() => {
  const kw = state.paperSearch.toLowerCase();
  return state.papers
    .filter((p) => {
      if (state.paperFilter.status !== 'all' && p.status !== state.paperFilter.status) return false;
      if (state.paperFilter.category && p.category !== state.paperFilter.category) return false;
      const logs = p.logs || [];
      if (state.paperFilter.note === 'has' && !logs.length) return false;
      if (state.paperFilter.note === 'none' && logs.length) return false;
      if (!kw) return true;
      const hay = [p.title, p.category, p.file_name, p.notes, ...logHaystack(logs)].join(' ').toLowerCase();
      return hay.includes(kw);
    })
    // 排序：最近阅读时间倒序（点过「📖 阅读」的置顶，没读过按添加时间）；
    // 键相同时用添加时间、标题兜底，保证顺序稳定不抖动
    .sort((a, b) => readSortKey(b) - readSortKey(a)
      || String(b.created_at || '').localeCompare(String(a.created_at || ''))
      || String(a.title || '').localeCompare(String(b.title || ''), 'zh'));
});

export { loadPapers, openPaperEditor, savePaper, setPaperStatus, logPaper, openPaperLog, startPaperRead, newPaperLog, editPaperLog, backToLogList, draftTimer, saveLogDraft, discardLogDraft, closePaperLog, savePaperLog, removePaperLog, openPaper, openPaperReveal, removePaper, paperCounts, logHaystack, filteredPapers };
