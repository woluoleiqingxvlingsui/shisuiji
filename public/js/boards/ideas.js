/* 拾穗集 —— 想法：一行点题 + 一段灵感
 * 从 app.js 原样搬过来的，逻辑一字未改。
 */

/* ---- 想法板块：一行点题 + 一段灵感。目前桌面直连 REST，P6 起手机端改走同步队列 ---- */

import { computed } from '../vue-globals.js';
import { state } from '../state.js';
import { toast } from '../toast.js';

async function loadIdeas() {
  try {
    state.ideas = await fetch('/api/ideas').then((r) => r.json());
  } catch {
    toast('想法加载失败', 'warn');
  }
  state.ideasLoaded = true;
}
const filteredIdeas = computed(() => {
  const kw = state.ideaSearch.trim().toLowerCase();
  if (!kw) return state.ideas;
  return state.ideas.filter((i) =>
    String(i.title || '').toLowerCase().includes(kw)
    || String(i.content || '').toLowerCase().includes(kw));
});
function openIdeaEditor(idea) {
  state.editingIdea = idea ? { ...idea } : null;
  state.ideaEditorOpen = true;
}
async function saveIdea(payload) {
  const isEdit = !!state.editingIdea;
  const url = isEdit ? `/api/ideas/${state.editingIdea.id}` : '/api/ideas';
  const res = await fetch(url, {
    method: isEdit ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const saved = await res.json().catch(() => ({}));
  if (res.status === 409) {
    // 乐观锁没过：这条在别处先改了。不静默覆盖，刷新拿最新的让用户自己看
    state.ideaEditorOpen = false;
    toast('这条想法在别处改过，已刷新为最新内容', 'warn');
    loadIdeas();
    return;
  }
  if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
  if (isEdit) {
    const idx = state.ideas.findIndex((i) => i.id === saved.id);
    if (idx !== -1) state.ideas.splice(idx, 1, saved);
  } else {
    state.ideas.unshift(saved);
  }
  state.ideaEditorOpen = false;
  toast(isEdit ? '已保存 ✅' : '记下了 💡');
}
async function removeIdea(idea) {
  const name = idea.title || (idea.content || '').slice(0, 20) || '这条想法';
  if (!confirm(`确定删除「${name}」吗？`)) return;
  const res = await fetch(`/api/ideas/${idea.id}`, { method: 'DELETE' });
  if (!res.ok) return toast('删除失败：' + res.status, 'warn');
  state.ideas = state.ideas.filter((i) => i.id !== idea.id);
  toast('已删除 🗑');
}

export { loadIdeas, filteredIdeas, openIdeaEditor, saveIdea, removeIdea };
