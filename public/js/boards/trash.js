/* 拾穗集 —— 回收站（M20 任务 D）
 * 纯电脑端板块：数据只走新的 REST，不进镜像、不参与同步
 * （服务端 pull 里根本没有 trash 键，手机端视角永远看不到这里）。
 */

import { computed } from '../vue-globals.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { api } from '../api.js';
import { trashDaysLeft, trashSummary, trashTitle, trashDetailText } from '../util/trash.js';

const loadTrash = async () => {
  try {
    const res = await api('/api/trash');
    const body = await res.json();
    state.trash = Array.isArray(body.items) ? body.items : [];
    state.trashRetentionDays = Number(body.retention_days) || 30;
  } catch {
    toast('回收站加载失败', 'warn');
  }
  state.trashLoaded = true;
};

// 恢复：服务端把 payload 放回原板块且保留原时间戳；成功后刷新回收站与来源板块
async function restoreTrashEntry(entry) {
  try {
    const res = await api(`/api/trash/${encodeURIComponent(entry.id)}/restore`, { method: 'POST' });
    const body = await res.json();
    if (!res.ok) return toast(body.error || '恢复失败', 'warn');
    toast(body.duplicate_id ? '已恢复（原 id 被占用，换了新 id）' : '已恢复到原板块 ↩︎');
    await loadTrash();
    await reloadSource(entry.source);
  } catch {
    toast('恢复失败', 'warn');
  }
}

// 彻底删除：不可反悔，必须二次确认
async function purgeTrashEntry(entry) {
  if (!confirm(`彻底删除「${trashTitle(entry)}」？\n这一步无法恢复。`)) return;
  try {
    const res = await api(`/api/trash/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
    if (!res.ok) return toast('彻底删除失败', 'warn');
    toast('已彻底删除');
    await loadTrash();
  } catch {
    toast('彻底删除失败', 'warn');
  }
}

async function emptyTrash() {
  if (!state.trash.length) return toast('回收站已经是空的');
  if (!confirm(`清空回收站里的 ${state.trash.length} 条记录？\n这一步无法恢复。`)) return;
  try {
    const res = await api('/api/trash', { method: 'DELETE' });
    if (!res.ok) return toast('清空失败', 'warn');
    toast('回收站已清空');
    await loadTrash();
  } catch {
    toast('清空失败', 'warn');
  }
}

// 恢复后要把记录放回的那个板块也要重拉，否则用户看不到刚恢复的东西
async function reloadSource(source) {
  const { load } = await import('./eggs.js');
  const { loadIdeas } = await import('./ideas.js');
  const { loadExpenses } = await import('./expenses.js');
  const { loadAchievements } = await import('./achievements.js');
  const { loadKb } = await import('./kb.js');
  const { loadPapers } = await import('./papers.js');
  const { loadSites } = await import('./sites.js');
  const reload = {
    activities: load, ideas: loadIdeas, expenses: loadExpenses,
    achievements: loadAchievements, kb: loadKb, papers: loadPapers, sites: loadSites,
  }[source];
  if (reload) await reload();
}

const filteredTrash = computed(() => {
  const kw = state.trashSearch.trim().toLowerCase();
  if (!kw) return state.trash;
  return state.trash.filter((t) => {
    const p = t.payload || {};
    // M21-A：详情行里的完整正文/字段也纳入搜索（被删记录不再只有标题可搜）
    return [trashTitle(t), trashSummary(t), trashDetailText(t), p.url, p.platform, t.source]
      .filter(Boolean).join(' ').toLowerCase().includes(kw);
  });
});

export {
  loadTrash, restoreTrashEntry, purgeTrashEntry, emptyTrash, reloadSource,
  filteredTrash, trashDaysLeft,
};