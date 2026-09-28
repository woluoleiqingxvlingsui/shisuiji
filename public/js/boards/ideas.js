/* 拾穗集 —— 随记（内部 id 仍为 ideas）：一行点题 + 一段内容 + 贴图
 * 桌面端直连 REST；手机端走 IndexedDB 镜像 + outbox（P6）。
 */

import { computed } from '../vue-globals.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { api } from '../api.js';
import { enqueueIdeaLocal } from '../sync/engine.js';

function mobileSyncOn() {
  return !!(state.sync && state.sync.enabled);
}

async function loadIdeas() {
  if (mobileSyncOn()) {
    // 引擎 install/init 会拉镜像并叠加 outbox；这里只保证有加载态
    try {
      const { reloadIdeasDisplay } = await import('../sync/engine.js');
      await reloadIdeasDisplay();
    } catch {
      state.ideasLoaded = true;
    }
    return;
  }
  try {
    const res = await api('/api/ideas');
    state.ideas = await res.json();
  } catch {
    toast('随记加载失败', 'warn');
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

// 与服务端 ideaSortDesc / outbox.mergeDisplayItems 同一套排序：
// 置顶组优先，组内按"最近动作"（置顶或编辑取较新）倒序——编辑过的置顶随记浮到最前
function pinKey(i) {
  const p = String(i.pinned_at || '');
  const u = String(i.updated_at || '');
  return p > u ? p : u;
}
function ideaSortLocal(a, b) {
  return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
    || pinKey(b).localeCompare(pinKey(a))
    || String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
    || String(b.created_at || '').localeCompare(String(a.created_at || ''));
}

function openIdeaEditor(idea) {
  state.editingIdea = idea ? { ...idea } : null;
  state.ideaEditorOpen = true;
}

async function saveIdea(payload) {
  const isEdit = !!state.editingIdea;

  if (mobileSyncOn()) {
    const id = isEdit ? state.editingIdea.id : null;
    // 乐观锁基线必须是「最后一次服务端时间」：优先 base_updated_at
    // （镜像∪队列叠加时写回），其次才是镜像/服务端 updated_at
    const base = isEdit
      ? (state.editingIdea.base_updated_at || state.editingIdea.updated_at || '')
      : '';
    // 手机端只允许写自己 origin 的想法；电脑端 origin 由 push 的 forbidden 处理
    await enqueueIdeaLocal({
      op: isEdit ? 'update' : 'create',
      id,
      payload: {
        title: payload.title,
        content: payload.content,
        images: payload.images || [],
        created_at: isEdit ? state.editingIdea.created_at : undefined,
      },
      baseUpdatedAt: base,
    });
    state.ideaEditorOpen = false;
    toast(isEdit ? '已记入本地队列 📝' : '已记下（待同步）📝');
    return;
  }

  const url = isEdit ? `/api/ideas/${state.editingIdea.id}` : '/api/ideas';
  const res = await api(url, {
    method: isEdit ? 'PUT' : 'POST',
    body: JSON.stringify(payload),
  });
  const saved = await res.json().catch(() => ({}));
  if (res.status === 409) {
    // 乐观锁没过：这条在别处先改了。不静默覆盖，刷新拿最新的让用户自己看
    state.ideaEditorOpen = false;
    toast('这条随记在别处改过，已刷新为最新内容', 'warn');
    loadIdeas();
    return;
  }
  if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
  // 编辑过 = 刚被想起，移到最前；置顶的留在置顶组内，统一按服务端同款排序
  const idx = state.ideas.findIndex((i) => i.id === saved.id);
  if (idx !== -1) state.ideas.splice(idx, 1);
  state.ideas.unshift(saved);
  state.ideas.sort(ideaSortLocal);
  state.ideaEditorOpen = false;
  toast(isEdit ? '已保存 ✅' : '记下了 📝');
}

async function togglePin(idea) {
  const next = !idea.pinned;

  if (mobileSyncOn()) {
    // 队列 payload 必须带全字段：push 时服务端按整条覆盖。
    // idea 是 Vue reactive Proxy，直接进 IndexedDB 会 DataCloneError，深拷贝成普通对象
    const plain = JSON.parse(JSON.stringify(idea));
    await enqueueIdeaLocal({
      op: 'update',
      id: idea.id,
      payload: {
        title: plain.title,
        content: plain.content,
        images: plain.images || [],
        pinned: next,
        created_at: plain.created_at,
      },
      baseUpdatedAt: plain.base_updated_at || plain.updated_at || '',
    });
    toast(next ? '已置顶 📌' : '已取消置顶');
    return;
  }

  const res = await api(`/api/ideas/${idea.id}`, {
    method: 'PUT',
    body: JSON.stringify({ pinned: next }),
  });
  const saved = await res.json().catch(() => ({}));
  if (res.status === 409) {
    toast('这条随记在别处改过，已刷新为最新内容', 'warn');
    loadIdeas();
    return;
  }
  if (!res.ok) return toast('操作失败：' + (saved.error || res.status), 'warn');
  const idx = state.ideas.findIndex((i) => i.id === saved.id);
  if (idx !== -1) state.ideas.splice(idx, 1, saved);
  state.ideas.sort(ideaSortLocal);
  toast(next ? '已置顶 📌' : '已取消置顶');
}

async function removeIdea(idea) {
  const name = idea.title || (idea.content || '').slice(0, 20) || '这条随记';
  if (!confirm(`确定删除「${name}」吗？`)) return;

  if (mobileSyncOn()) {
    await enqueueIdeaLocal({
      op: 'delete',
      id: idea.id,
      payload: null,
      // 与 save 同一优先级：base_updated_at 是最后一次服务端时间，
      // display 叠加后的 updated_at 是本地编辑时间，不能当乐观锁基线
      baseUpdatedAt: idea.base_updated_at || idea.updated_at || '',
    });
    toast('已加入删除队列 🗑');
    return;
  }

  const res = await api(`/api/ideas/${idea.id}`, { method: 'DELETE' });
  if (!res.ok) return toast('删除失败：' + res.status, 'warn');
  state.ideas = state.ideas.filter((i) => i.id !== idea.id);
  toast('已删除 🗑');
}

export { loadIdeas, filteredIdeas, openIdeaEditor, saveIdea, removeIdea, togglePin };
