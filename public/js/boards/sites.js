/* 拾穗集 —— 网页：待读链接与分类型笔记
 * 从 app.js 原样搬过来的，逻辑一字未改。
 */

/* ---- 网页板块 ---- */
/* ---- 网页笔记（logs） ---- */
/* ---- 网页板块：派生数据 ---- */

import { computed } from '../vue-globals.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { api } from '../api.js';
import { CONFIG } from '../../config.js';
import { SITE_DRAFT_PREFIX, clearDraft, readDraft, writeDraft } from '../util/draft.js';
import { blankSiteNote, siteNoteFieldLabel, siteNoteIsEmpty, siteNoteKeys, siteNoteMissing } from '../util/site-note.js';
import { readSortKey } from '../util/sort.js';
import { normalizeUrl } from '../util/text.js';
import { flashCard } from '../ui.js';

async function loadSites() {
  try {
    state.sites = await api('/api/sites').then((r) => r.json());
  } catch {
    toast('网页数据加载失败', 'warn');
  }
  state.sitesLoaded = true;
}
function openSiteEditor(site) {
  state.editingSite = site ? { ...site } : null;
  state.siteEditorOpen = true;
}
async function saveSite(payload) {
  const isEdit = !!state.editingSite;
  const url = isEdit ? `/api/sites/${state.editingSite.id}` : '/api/sites';
  const res = await api(url, {
    method: isEdit ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const saved = await res.json().catch(() => ({}));
  if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
  if (isEdit) {
    const idx = state.sites.findIndex((s) => s.id === saved.id);
    if (idx !== -1) state.sites.splice(idx, 1, saved);
  } else {
    state.sites.push(saved);
  }
  state.siteEditorOpen = false;
  toast(isEdit ? '已保存 ✅' : '记好了，一个待读网页 🌐');
}
async function setSiteStatus(site, status) {
  const res = await api(`/api/sites/${site.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...site, status }),
  });
  const saved = await res.json().catch(() => ({}));
  if (!res.ok) return toast('更新失败：' + (saved.error || res.status), 'warn');
  const idx = state.sites.findIndex((s) => s.id === saved.id);
  if (idx !== -1) state.sites.splice(idx, 1, saved);
  toast(status === 'read' ? '已移入「已读」✅' : '已移回「待读」📖');
}
async function openSite(site) {
  const url = normalizeUrl(site.url);
  if (!url) return toast('这条记录的链接不合法，编辑一下试试', 'warn');
  // 别写成 window.open(url, '_blank', 'noopener')：带 noopener 时浏览器按规范一律返回 null
  // （不给句柄），那样会把「打开成功」误判成「被拦截」。这里正常打开后立刻抹掉 opener，效果等价。
  const win = window.open(url, '_blank');
  if (win) {
    try { win.opener = null; } catch (e) {}
    toast('🌐 已打开，这张卡已置顶');
  } else {
    try {
      await navigator.clipboard.writeText(url);
      toast('浏览器拦截了弹窗，链接已复制 📋', 'warn');
    } catch { toast('浏览器拦截了弹窗，请手动打开链接', 'warn'); }
  }
  const res = await api(`/api/sites/${site.id}/open`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.site) return; // 时间没记上也不打扰你阅读
  const idx = state.sites.findIndex((s) => s.id === data.site.id);
  if (idx !== -1) state.sites.splice(idx, 1, data.site);
  flashCard(data.site.id);
}
async function removeSite(site) {
  if (!confirm(`确定删除「${site.title}」吗？`)) return;
  const res = await api(`/api/sites/${site.id}`, { method: 'DELETE' });
  if (!res.ok) return toast('删除失败：' + res.status, 'warn');
  state.sites = state.sites.filter((s) => s.id !== site.id);
  toast('已删除 🗑');
}
const siteNoteItem = computed(() => state.sites.find((s) => s.id === state.siteNoteId) || null);
function openSiteNote(site, mode = 'list', pendingRead = false) {
  state.siteNoteId = site.id;
  state.siteNotePendingRead = pendingRead;
  const draft = mode === 'new' ? readDraft(SITE_DRAFT_PREFIX, site.id) : null; // 没写完的草稿自动带回
  state.siteNoteRestored = !!draft;
  state.siteNoteDraftSnapshot = draft;
  state.siteNoteEditing = draft
    ? { ...blankSiteNote(site.kind), ...draft }
    : ((mode === 'new' || !(site.logs || []).length) ? blankSiteNote(site.kind) : null);
  state.siteNoteOpen = true;
}
function startSiteRead(site) { openSiteNote(site, 'new', true); }
function newSiteNote() {
  state.siteNotePendingRead = false;
  state.siteNoteRestored = false;
  state.siteNoteDraftSnapshot = null;
  const site = siteNoteItem.value;
  state.siteNoteEditing = blankSiteNote(site ? site.kind : 'tech');
}
function editSiteNote(log) { state.siteNoteEditing = { ...log }; }
function backToSiteNoteList() {
  if (state.siteNotePendingRead) return closeSiteNote(); // 还没归档，回列表没意义
  state.siteNoteEditing = null;
}
let siteDraftTimer = null;
function saveSiteNoteDraft(form) {
  if (!state.siteNotePendingRead || !state.siteNoteId) return;
  state.siteNoteDraftSnapshot = form;
  clearTimeout(siteDraftTimer);
  const id = state.siteNoteId;
  siteDraftTimer = setTimeout(() => writeDraft(SITE_DRAFT_PREFIX, id, form, siteNoteIsEmpty), 400);
}
function discardSiteNoteDraft() {
  clearTimeout(siteDraftTimer);
  clearDraft(SITE_DRAFT_PREFIX, state.siteNoteId);
  state.siteNoteRestored = false;
  state.siteNoteDraftSnapshot = null;
  toast('草稿已丢弃 🧹');
}
function closeSiteNote() {
  clearTimeout(siteDraftTimer);
  const wasPendingRead = state.siteNotePendingRead;
  const siteId = state.siteNoteId;
  if (wasPendingRead && siteId && state.siteNoteDraftSnapshot) {
    writeDraft(SITE_DRAFT_PREFIX, siteId, state.siteNoteDraftSnapshot, siteNoteIsEmpty);
  }
  state.siteNotePendingRead = false;
  state.siteNoteRestored = false;
  state.siteNoteDraftSnapshot = null;
  state.siteNoteOpen = false;
  state.siteNoteId = null;
  state.siteNoteEditing = null;
  if (wasPendingRead && siteId) {
    toast(readDraft(SITE_DRAFT_PREFIX, siteId)
      ? '没写满，这个网页还留在「待读」，内容已存草稿'
      : '没记笔记，这个网页还留在「待读」');
  }
}
async function saveSiteNote(form) {
  const site = siteNoteItem.value;
  if (!site) return;

  // 读完引导：技术网页要写满三栏、杂项网页只要一句话；已读后的补记非空即可
  if (state.siteNotePendingRead) {
    const missing = siteNoteMissing(form);
    if (missing.length) {
      return toast(`还差「${missing.map(siteNoteFieldLabel).join('、')}」，这个网页先留在「待读」`, 'warn');
    }
  } else if (siteNoteIsEmpty(form)) {
    return toast('这条笔记还是空的，写点内容再保存', 'warn');
  }

  const logs = [...(site.logs || [])];
  const idx = logs.findIndex((l) => l.id === form.id);
  if (idx === -1) logs.push(form); else logs.splice(idx, 1, form);
  const patch = { ...site, logs };
  const wasPendingRead = state.siteNotePendingRead;
  if (wasPendingRead) patch.status = 'read'; // 笔记与状态同一次 PUT，原子落盘

  const res = await api(`/api/sites/${site.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const saved = await res.json().catch(() => ({}));
  if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
  const i = state.sites.findIndex((s) => s.id === saved.id);
  if (i !== -1) state.sites.splice(i, 1, saved);

  clearTimeout(siteDraftTimer);
  clearDraft(SITE_DRAFT_PREFIX, site.id);
  state.siteNotePendingRead = false;
  state.siteNoteRestored = false;
  state.siteNoteDraftSnapshot = null;
  state.siteNoteEditing = null; // 保存后回到列表
  toast(wasPendingRead
    ? '读完了！已移入「已读」🎉'
    : (idx === -1 ? '已记下这条笔记 📝' : '笔记已更新 ✅'));
}
async function removeSiteNote(log) {
  const site = siteNoteItem.value;
  if (!site) return;
  if (!confirm(`删除 ${log.read_at || '这条'} 的笔记吗？`)) return;
  const logs = (site.logs || []).filter((l) => l.id !== log.id);
  const res = await api(`/api/sites/${site.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...site, logs }),
  });
  const saved = await res.json().catch(() => ({}));
  if (!res.ok) return toast('删除失败：' + (saved.error || res.status), 'warn');
  const i = state.sites.findIndex((s) => s.id === saved.id);
  if (i !== -1) state.sites.splice(i, 1, saved);
  toast('已删除这条笔记 🗑');
}
const siteCounts = computed(() => ({
  all: state.sites.length,
  to_read: state.sites.filter((s) => s.status === 'to_read').length,
  read: state.sites.filter((s) => s.status === 'read').length,
  noted: state.sites.filter((s) => (s.logs || []).length).length,
  unnoted: state.sites.filter((s) => !(s.logs || []).length).length,
}));
const siteKindOptions = computed(() => CONFIG.siteNote.kinds);
const siteUsageOptions = computed(() => CONFIG.siteNote.usage);
const siteUrls = computed(() => state.sites.map((s) => normalizeUrl(s.url)).filter(Boolean));
function siteHaystack(site) {
  return [
    site.title, site.domain, site.url, site.notes, ...(site.tags || []),
    ...(site.logs || []).flatMap((l) => [l.read_at, l.usage, ...siteNoteKeys().map((k) => l[k])]),
  ].filter(Boolean);
}
const filteredSites = computed(() => {
  const kw = state.siteSearch.toLowerCase();
  return state.sites
    .filter((s) => {
      if (state.siteFilter.status !== 'all' && s.status !== state.siteFilter.status) return false;
      if (state.siteFilter.kind && s.kind !== state.siteFilter.kind) return false;
      const logs = s.logs || [];
      if (state.siteFilter.usage === 'none') {
        if (logs.length) return false;
      } else if (state.siteFilter.usage && !logs.some((l) => l.usage === state.siteFilter.usage)) {
        return false;
      }
      if (!kw) return true;
      return siteHaystack(s).join(' ').toLowerCase().includes(kw);
    })
    // 排序规则与文献一致：最近阅读时间倒序（点过「🌐 打开」的置顶），没读过按添加时间
    .sort((a, b) => readSortKey(b) - readSortKey(a)
      || String(b.created_at || '').localeCompare(String(a.created_at || ''))
      || String(a.title || '').localeCompare(String(b.title || ''), 'zh'));
});

export { loadSites, openSiteEditor, saveSite, setSiteStatus, openSite, removeSite, siteNoteItem, openSiteNote, startSiteRead, newSiteNote, editSiteNote, backToSiteNoteList, siteDraftTimer, saveSiteNoteDraft, discardSiteNoteDraft, closeSiteNote, saveSiteNote, removeSiteNote, siteCounts, siteKindOptions, siteUsageOptions, siteUrls, siteHaystack, filteredSites };
