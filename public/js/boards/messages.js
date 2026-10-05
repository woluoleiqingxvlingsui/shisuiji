/* 拾穗集 —— 消息中心：蛋到期自动记一条 + 全局系统通知（手机本地），可已读 / 清空
 * 从 app.js 原样搬过来的，逻辑一字未改。
 */

/* ---- 消息中心 ---- */

import { computed } from '../vue-globals.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { api } from '../api.js';
import { formatDate } from '../util/date.js';
import { notifySystem } from '../notify.js';

/* ---- 本地消息：只存本机 localStorage 的全局通知 ----
 * 断连告警这类「服务端都连不上」的通知发不进服务端，只能存手机本地；
 * 与服务端消息合并展示。local: true 的消息已读 / 删除都只动本机。
 */
const LOCAL_MESSAGES_KEY = 'danji.localMessages';
const LOCAL_MESSAGES_MAX = 20; // 只留最近 20 条，防止无限膨胀

function readLocalMessages() {
  try {
    const list = JSON.parse(localStorage.getItem(LOCAL_MESSAGES_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
function writeLocalMessages(list) {
  try {
    localStorage.setItem(LOCAL_MESSAGES_KEY, JSON.stringify(list.slice(0, LOCAL_MESSAGES_MAX)));
  } catch { /* 隐私模式等场景忽略 */ }
}
function replaceLocalMessage(updated) {
  const idx = state.messages.findIndex((m) => m.id === updated.id);
  if (idx !== -1) state.messages.splice(idx, 1, updated);
}
function localId() {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch { /* ignore */ }
  return Date.now() + '-' + Math.random().toString(16).slice(2);
}

/**
 * 全局播报入口：任何板块都能发一条「消息 + 系统通知」。
 * 消息存本机（服务端都连不上的时候通知也发不进去），通知走 notify.js 的全局通道。
 * App 在前台时两条都发得着；在后台时用户先看见通知，回头打开 App 还能翻到消息记录。
 * @param {{ platform?: string, title: string, body?: string, notify?: boolean, tag?: string }} opts
 * @param {{ quiet?: boolean }} [flags] quiet=true 时静默：不发系统通知（也跳过 toast）
 */
async function pushLocalMessage({ platform = '系统', title, body, notify = false, tag }, flags = {}) {
  const msg = {
    id: 'local-' + localId(),
    local: true,
    platform,
    title: String(title || ''),
    body: String(body || ''),
    read: false,
    created_at: new Date().toISOString(),
  };
  const list = readLocalMessages();
  list.unshift(msg);
  writeLocalMessages(list);
  state.messages = [msg, ...state.messages];
  if (notify && !flags.quiet) {
    notifySystem({ title: msg.title, body: msg.body, tag: tag || 'danji-sync' });
  }
  return msg;
}

/**
 * 拉消息中心。
 * @param {{ silent?: boolean }} [opts] silent=true 时失败不弹 toast。
 *   兜底轮询每 45 秒调一次，这里弹 toast 会直接变成刷屏；
 *   至于「服务连不上」这件事，顶栏通道状态与全局错误提示已经在管了，不必再重复。
 */
async function loadMessages(opts = {}) {
  try {
    const res = await api('/api/messages');
    const server = await res.json();
    // 服务端消息 + 本地消息合并，统一按时间倒序
    state.messages = [...server, ...readLocalMessages()]
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  } catch {
    if (!opts.silent) toast('消息加载失败', 'warn');
  }
  state.messagesLoaded = true;
}
async function pushExpiredMessage(activity) {
  const res = await api('/api/messages', {
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
  const res = await api('/api/messages', {
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
  if (msg.local) {
    const updated = { ...msg, read: true };
    writeLocalMessages(readLocalMessages().map((m) => (m.id === msg.id ? updated : m)));
    replaceLocalMessage(updated);
    return;
  }
  const res = await api(`/api/messages/${msg.id}`, {
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
  if (msg.local) {
    writeLocalMessages(readLocalMessages().filter((m) => m.id !== msg.id));
    state.messages = state.messages.filter((m) => m.id !== msg.id);
    return;
  }
  const res = await api(`/api/messages/${msg.id}`, { method: 'DELETE' });
  if (!res.ok) return toast('删除失败', 'warn');
  state.messages = state.messages.filter((m) => m.id !== msg.id);
}
async function markAllRead() {
  // 本地消息直接改本机；服务端消息仍走 API（离线时只标本地，服务端的等连通后再说）
  const locals = readLocalMessages();
  writeLocalMessages(locals.map((m) => ({ ...m, read: true })));
  let updated = 0;
  let serverOk = false;
  try {
    const res = await api('/api/messages/read-all', { method: 'POST' });
    if (res.ok) { serverOk = true; updated = (await res.json()).updated || 0; }
  } catch { /* 离线：只标本地 */ }
  state.messages = state.messages.map((m) => (m.local || serverOk ? { ...m, read: true } : m));
  const n = updated + locals.filter((m) => !m.read).length;
  toast(n ? `${n} 条消息已标为已读 ✅` : '没有未读消息');
}
async function clearReadMessages() {
  // 同 markAllRead：本地已读只动本机；离线时服务端已读消息保留不动
  const allLocals = readLocalMessages();
  const keepLocals = allLocals.filter((m) => !m.read);
  writeLocalMessages(keepLocals);
  let removed = 0;
  let serverOk = false;
  try {
    const res = await api('/api/messages/clear-read', { method: 'POST' });
    if (res.ok) { serverOk = true; removed = (await res.json()).removed || 0; }
  } catch { /* 离线：只清本地 */ }
  state.messages = state.messages.filter((m) => (m.local || serverOk ? !m.read : true));
  const total = removed + (allLocals.length - keepLocals.length);
  toast(total ? `已清空 ${total} 条已读消息 🧹` : '没有已读消息');
}
const unreadCount = computed(() => state.messages.filter((m) => !m.read).length);

export { loadMessages, pushExpiredMessage, pushClosedMessage, pushLocalMessage, markMessageRead, removeMessage, markAllRead, clearReadMessages, unreadCount };