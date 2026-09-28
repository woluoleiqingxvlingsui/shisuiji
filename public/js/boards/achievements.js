/* 拾穗集 —— 成果：项目/奖项/论文/证书，时间线倒序展示
 * 桌面端直连 REST 管理；手机端在线只读浏览（不接 outbox）。
 */

import { computed } from '../vue-globals.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { api } from '../api.js';
import { CONFIG } from '../../config.js';

const achievementCategories = computed(() => CONFIG.achievements.categories);

// 各类别条数（不受搜索/筛选影响，tab 上的角标）
const achievementCategoryCounts = computed(() => {
  const counts = {};
  for (const a of state.achievements) counts[a.category] = (counts[a.category] || 0) + 1;
  return counts;
});

async function loadAchievements() {
  try {
    const res = await api('/api/achievements');
    state.achievements = await res.json();
  } catch {
    toast('成果加载失败', 'warn');
  }
  state.achievementsLoaded = true;
}

// 与服务端 achievementSortDesc 一致：猜出的时间键倒序（猜不到排最后），再按更新时间倒序
function byDateDesc(a, b) {
  return String(b.date_key || '').localeCompare(String(a.date_key || ''))
    || String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
}

const filteredAchievements = computed(() => {
  const kw = state.achievementSearch.trim().toLowerCase();
  const cat = state.achievementCategoryFilter;
  return state.achievements.filter((a) => {
    if (cat && a.category !== cat) return false;
    if (!kw) return true;
    return [a.title, a.content, a.highlight, (a.tags || []).join(' '), (a.links || []).join(' ')]
      .join(' ').toLowerCase().includes(kw);
  });
});

// 时间线：按猜出的年份分组（倒序），猜不到归「时间不明」；组内保持时间键倒序
const achievementTimeline = computed(() => {
  const items = [...filteredAchievements.value].sort(byDateDesc);
  const groups = [];
  let current = null;
  for (const item of items) {
    const year = String(item.date_key || '').slice(0, 4) || '时间不明';
    if (!current || current.year !== year) {
      current = { year, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
});

function openAchievementEditor(achievement) {
  state.editingAchievement = achievement ? { ...achievement } : null;
  state.achievementEditorOpen = true;
}

function pickAchievementCategory(id) {
  state.achievementCategoryFilter = state.achievementCategoryFilter === id ? '' : id;
}

async function saveAchievement(payload) {
  const isEdit = !!state.editingAchievement;
  const url = isEdit ? `/api/achievements/${state.editingAchievement.id}` : '/api/achievements';
  const res = await api(url, {
    method: isEdit ? 'PUT' : 'POST',
    body: JSON.stringify(payload),
  });
  const saved = await res.json().catch(() => ({}));
  if (res.status === 409) {
    state.achievementEditorOpen = false;
    toast('这条成果在别处改过，已刷新为最新内容', 'warn');
    loadAchievements();
    return;
  }
  if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
  // 新增和编辑都重排到正确的时间线位置（刚编辑过的同日期条目靠 updated_at 置顶）
  state.achievements = [saved, ...state.achievements.filter((a) => a.id !== saved.id)].sort(byDateDesc);
  state.achievementEditorOpen = false;
  toast(isEdit ? '已保存 ✅' : '记下一项成果 🏅');
}

async function removeAchievement(achievement) {
  const name = achievement.title || '这条成果';
  if (!confirm(`确定删除「${name}」吗？`)) return;
  const res = await api(`/api/achievements/${achievement.id}`, { method: 'DELETE' });
  if (!res.ok) return toast('删除失败：' + res.status, 'warn');
  state.achievements = state.achievements.filter((a) => a.id !== achievement.id);
  toast('已删除 🗑');
}

export {
  loadAchievements, filteredAchievements, achievementTimeline,
  achievementCategories, achievementCategoryCounts,
  openAchievementEditor, pickAchievementCategory, saveAchievement, removeAchievement,
};
