/* 拾穗集 —— 消息中心：蛋到期自动记一条，可已读 / 清空
 * 从 app.js 原样搬过来的，逻辑一字未改。
 */

/* ---- 消息中心 ---- */

import { computed } from '../vue-globals.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { formatDate } from '../util/date.js';

async function loadMessages() {
  try {
    const res = await fetch('/api/messages');
    state.messages = await res.json();
  } catch {
    toast('消息加载失败', 'warn');
  }
  state.messagesLoaded = true;
}
async function pushExpiredMessage(activity) {
  const res = await fetch('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      activity_id: activity.id,
      platform: activity.platform,
      title: activity.title,
      body: `使用截止 ${formatDate(activity.valid_until)} 已过，已自动移入「已过期」`,
      valid_until: activity.valid_until || '',
      read: false,
    }),
  });
  if (!res.ok) return;
  const saved = await res.json();
  if (!state.messages.some((m) => m.id === saved.id)) state.messages.unshift(saved);
}
async function pushClosedMessage(activity) {
  const res = await fetch('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      activity_id: activity.id,
      platform: activity.platform,
      title: activity.title,
      body: `领取截止 ${formatDate(activity.claim_deadline)} 已过，已自动移入「已截止」`,
      valid_until: '',
      claim_deadline: activity.claim_deadline || '',
      read: false,
    }),
  });
  if (!res.ok) return;
  const saved = await res.json();
  if (!state.messages.some((m) => m.id === saved.id)) state.messages.unshift(saved);
}
async function markMessageRead(msg) {
  if (msg.read) return;
  const res = await fetch(`/api/messages/${msg.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...msg, read: true }),
  });
  if (!res.ok) return;
  const saved = await res.json();
  const idx = state.messages.findIndex((m) => m.id === saved.id);
  if (idx !== -1) state.messages.splice(idx, 1, saved);
}
async function removeMessage(msg) {
  const res = await fetch(`/api/messages/${msg.id}`, { method: 'DELETE' });
  if (!res.ok) return toast('删除失败', 'warn');
  state.messages = state.messages.filter((m) => m.id !== msg.id);
}
async function markAllRead() {
  const res = await fetch('/api/messages/read-all', { method: 'POST' });
  if (!res.ok) return toast('操作失败', 'warn');
  const { updated } = await res.json();
  state.messages = state.messages.map((m) => ({ ...m, read: true }));
  toast(updated ? `${updated} 条消息已标为已读 ✅` : '没有未读消息');
}
async function clearReadMessages() {
  const res = await fetch('/api/messages/clear-read', { method: 'POST' });
  if (!res.ok) return toast('操作失败', 'warn');
  const { removed } = await res.json();
  state.messages = state.messages.filter((m) => !m.read);
  toast(removed ? `已清空 ${removed} 条已读消息 🧹` : '没有已读消息');
}
const unreadCount = computed(() => state.messages.filter((m) => !m.read).length);

export { loadMessages, pushExpiredMessage, pushClosedMessage, markMessageRead, removeMessage, markAllRead, clearReadMessages, unreadCount };
