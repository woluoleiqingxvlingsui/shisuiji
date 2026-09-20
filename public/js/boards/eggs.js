/* 拾穗集 —— 赛博鸡蛋：记录、状态流转、紧急横幅、过期扫描与提醒
 * 从 app.js 原样搬过来的，逻辑一字未改。
 */

// 「已提醒过」记录持久化：刷新/重开页面不会对同一颗蛋重复弹通知
/* ---- 数据加载与提交 ---- */
/* ---- 派生数据 ---- */
/* ---- 其他交互 ---- */
/* ---- 定位：横幅条目 / 系统通知 / 消息卡片都走这里 ---- */
/* ---- 示例数据 ---- */

import { computed, nextTick } from '../vue-globals.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { api } from '../api.js';
import { flashCard } from '../ui.js';
import { CONFIG } from '../../config.js';
import { FLASH_MS, HOUR } from '../util/const.js';
import { computeUrgency, formatDate, formatRemaining, pad2, parseStoredDate } from '../util/date.js';
import { statusMeta } from '../util/meta.js';
import { pushExpiredMessage } from './messages.js';
import { pushClosedMessage } from './messages.js';

const NOTIFIED_KEY = 'danji.notified';
function rememberNotified(key) {
  notifiedKeys.add(key);
  const arr = [...notifiedKeys];
  if (arr.length > 200) arr.splice(0, arr.length - 200); // 只留最近 200 条，防止无限膨胀
  localStorage.setItem(NOTIFIED_KEY, JSON.stringify(arr));
}
async function load() {
  try {
    const res = await api('/api/activities');
    state.activities = await res.json();
    state.loaded = true;
    state.loadError = false;
  } catch (e) {
    // 服务连不上：标记错误态让页面显示重试按钮；不向上抛，避免中断 onMounted 后续初始化
    state.loadError = true;
  }
}
async function saveActivity(payload) {
  if (state.saving) return; // 请求进行中忽略重复提交（连点按钮 / 表单里按回车）
  state.saving = true;      // 同步置位：按钮立即变「保存中…」，不等网络结论
  const isEdit = !!state.editing;
  const url = isEdit ? `/api/activities/${state.editing.id}` : '/api/activities';
  let saved;
  try {
    const res = await api(url, {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return toast('保存失败：' + res.status, 'warn');
    saved = await res.json();
  } catch (e) {
    // 服务连不上：抽屉保持打开，已填内容不丢
    return toast('保存失败：无法连接服务，请确认拾穗集服务已启动', 'warn');
  } finally {
    state.saving = false;
  }
  if (isEdit) {
    const idx = state.activities.findIndex((a) => a.id === saved.id);
    if (idx !== -1) state.activities.splice(idx, 1, saved);
  } else {
    state.activities.push(saved);
  }
  state.editorOpen = false;
  toast(isEdit ? '已保存 ✅' : '记好了，一颗新蛋 🥚');
}
async function patchActivity(activity, patch) {
  const res = await api(`/api/activities/${activity.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...activity, ...patch }),
  });
  if (!res.ok) return null;
  const saved = await res.json();
  const idx = state.activities.findIndex((a) => a.id === saved.id);
  if (idx !== -1) state.activities.splice(idx, 1, saved);
  return saved;
}
async function setStatus(activity, status) {
  const saved = await patchActivity(activity, { status });
  if (!saved) return toast('更新失败', 'warn');
  toast(`已标记为「${statusMeta(status).label}」${statusMeta(status).emoji}`);
}
async function removeActivity(activity) {
  if (!confirm(`确定删除「${activity.platform} · ${activity.title}」吗？`)) return;
  const res = await api(`/api/activities/${activity.id}`, { method: 'DELETE' });
  if (!res.ok) return toast('删除失败：' + res.status, 'warn');
  state.activities = state.activities.filter((a) => a.id !== activity.id);
  toast('已删除 🗑');
}
const platformOptions = computed(() => {
  const set = new Set(state.activities.map((a) => a.platform).filter(Boolean));
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
});
const counts = computed(() => {
  const c = { all: state.activities.length };
  for (const s of CONFIG.statuses) c[s.id] = 0;
  for (const a of state.activities) c[a.status] = (c[a.status] || 0) + 1;
  return c;
});
const statusTabs = computed(() => [
  { id: 'all', label: '全部', count: counts.value.all },
  ...CONFIG.statuses.map((s) => ({ id: s.id, label: `${s.emoji} ${s.label}`, count: counts.value[s.id] || 0 })),
]);
const filteredActivities = computed(() => {
  const kw = state.search.toLowerCase();
  let list = state.activities.filter((a) => {
    if (state.statusFilter !== 'all' && a.status !== state.statusFilter) return false;
    if (state.platformFilter && a.platform !== state.platformFilter) return false;
    if (!kw) return true;
    const hay = [a.title, a.platform, a.value, a.notes, a.claim_steps, ...(a.tags || [])].join(' ').toLowerCase();
    return hay.includes(kw);
  });
  const sortTime = (a) => {
    const urg = computeUrgency(a, state.now);
    return urg.deadline ? urg.deadline.getTime() : Infinity;
  };
  list = list.slice().sort((a, b) => {
    const ta = computeUrgency(a, state.now).tier;
    const tb = computeUrgency(b, state.now).tier;
    if (ta !== tb) return ta - tb;
    const sa = sortTime(a), sb = sortTime(b);
    if (sa !== sb) return sa - sb;
    return (b.updated_at || '').localeCompare(a.updated_at || '');
  });
  return list;
});
const urgentItems = computed(() => {
  const items = [];
  for (const a of state.activities) {
    const urg = computeUrgency(a, state.now);
    const isClaimUrgent = a.status === 'pending' && urg.remainingMs !== null && urg.remainingMs <= CONFIG.urgent.yellow * HOUR;
    const isValidUrgent = a.status === 'claimed' && urg.remainingMs !== null && urg.remainingMs <= 48 * HOUR;
    const isUnknown = urg.level === 'unknown';
    if (!isClaimUrgent && !isValidUrgent && !isUnknown) continue;
    const meta = statusMeta(a.status);
    items.push({
      key: a.id + (a.claim_deadline || '') + (a.valid_until || ''),
      id: a.id, platform: a.platform, title: a.title,
      shortTitle: a.title.length > 12 ? a.title.slice(0, 12) + '…' : a.title,
      status: a.status, statusEmoji: meta.emoji, statusLabel: meta.label,
      level: urg.level, label: urg.label,
      remainingText: isUnknown ? '待确认 ❓' : formatRemaining(urg.remainingMs),
    });
  }
  return items.sort((x, y) => {
    const order = ['over', 'red', 'orange', 'yellow', 'unknown'];
    return order.indexOf(x.level) - order.indexOf(y.level);
  });
});
function openEditor(activity) {
  state.editing = activity ? { ...activity } : null;
  state.editorOpen = true;
}
function focusActivity(id) {
  const target = state.activities.find((a) => a.id === id);
  if (!target) return null;
  if (state.board !== 'eggs') switchBoard('eggs');
  state.statusFilter = target.status; // 属于哪个分类就跳到哪个分类
  state.platformFilter = '';
  state.search = '';
  return target;
}

function jumpTo(id) {
  const target = focusActivity(id);
  if (!target) return toast('这颗蛋已经不在了，可能已被删除', 'warn');
  const meta = statusMeta(target.status);
  toast(`已跳到「${meta.emoji} ${meta.label}」`);
  nextTick(() => requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = document.getElementById('card-' + id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flashCard(id);
  })));
}
function gotoActivity(id) {
  if (!state.activities.some((a) => a.id === id)) return toast('这条消息对应的蛋已经删掉了', 'warn');
  jumpTo(id);
}
function setNotify(on) {
  state.notifyOn = on;
  localStorage.setItem('danji.notifyOn', on ? '1' : '0');
}
async function toggleNotify() {
  if (typeof Notification === 'undefined') return toast('此浏览器不支持桌面通知', 'warn');
  if (state.notifPermission === 'denied') {
    return toast('通知被浏览器拒绝了，可在地址栏权限里重新允许', 'warn');
  }
  if (state.notifPermission !== 'granted') {
    const perm = await Notification.requestPermission();
    state.notifPermission = perm;
    if (perm !== 'granted') {
      return toast(perm === 'denied' ? '通知被浏览器拒绝了，可在地址栏权限里重新允许' : '没有授权，随时点铃铛再试', 'warn');
    }
    setNotify(true);
    toast(`桌面通知已开启 🔔（${CONFIG.remind.hours} 小时内到期的蛋会提醒你）`);
    checkReminders();
    return;
  }
  // 已授权：铃铛就是真开关
  if (state.notifyOn) {
    setNotify(false);
    toast('已关闭桌面通知 🔕，到期不再弹提醒，点铃铛可重新打开');
  } else {
    setNotify(true);
    toast(`已开启桌面通知 🔔（${CONFIG.remind.hours} 小时内到期的蛋会提醒你）`);
    checkReminders();
  }
}
function checkReminders() {
  // 仅电脑端跑到期提醒：手机时钟/权限不同，且会干扰服务端状态机
  if (state.role !== 'desktop') return;
  if (!state.notifyOn) return; // 用户关掉了提醒开关
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const now = Date.now();
  for (const a of state.activities) {
    const urg = computeUrgency(a, now);
    if (!urg.deadline || urg.remainingMs <= 0 || urg.remainingMs > CONFIG.remind.hours * HOUR) continue;
    const key = `${a.id}|${a.claim_deadline}|${a.valid_until}`;
    if (notifiedKeys.has(key)) continue;
    rememberNotified(key);
    const isClaim = a.status === 'pending';
    const n = new Notification(`${isClaim ? '🥚 蛋快不能领了' : '⏳ 领到的蛋快过期了'} · ${a.platform}`, {
      body: `${a.title}\n${urg.label} ${formatDate(a.claim_deadline || a.valid_until)}，${formatRemaining(urg.remainingMs)}`,
      tag: a.id,
    });
    n.onclick = () => { window.focus(); jumpTo(a.id); n.close(); };
  }
}
let settleRunning = false;
async function settleOverdue() {
  // 仅电脑端自动流转：手机端用本地时钟改 status 会误标过期并打一堆 403
  if (state.role !== 'desktop') return;
  if (settleRunning) return;
  settleRunning = true;
  try {
    const now = Date.now();
    const isEditing = (a) => state.editorOpen && state.editing && state.editing.id === a.id; // 正在编辑的先别动
    const expiredDue = state.activities.filter((a) => {
      if (a.status !== 'claimed' || !a.valid_until || isEditing(a)) return false;
      const d = parseStoredDate(a.valid_until);
      return !isNaN(d.getTime()) && d.getTime() <= now;
    });
    const closedDue = state.activities.filter((a) => {
      if (a.status !== 'pending' || !a.claim_deadline || isEditing(a)) return false;
      const d = parseStoredDate(a.claim_deadline);
      return !isNaN(d.getTime()) && d.getTime() <= now;
    });
    if (!expiredDue.length && !closedDue.length) return;
    const expired = [];
    const closed = [];
    for (const a of expiredDue) {
      if (await patchActivity(a, { status: 'expired' })) expired.push(a);
    }
    for (const a of closedDue) {
      if (await patchActivity(a, { status: 'closed' })) closed.push(a);
    }
    // toast 是单例，多条必须聚合成一条，否则只看到最后一条
    const parts = [];
    if (closed.length) {
      parts.push(closed.length === 1
        ? `⏳ ${closed[0].platform} · ${closed[0].title} 过了领取截止，已自动移入「已截止」`
        : `⏳ ${closed.length} 颗蛋过了领取截止，已自动移入「已截止」`);
    }
    if (expired.length) {
      parts.push(expired.length === 1
        ? `💤 ${expired[0].platform} · ${expired[0].title} 过了使用截止，已自动移入「已过期」`
        : `💤 ${expired.length} 颗蛋过了使用截止，已自动移入「已过期」`);
    }
    if (!parts.length) return;
    toast(parts.join('；'), 'warn');
    for (const a of closed) { notifyClosed(a); pushClosedMessage(a); }
    for (const a of expired) { notifyExpired(a); pushExpiredMessage(a); }
  } finally {
    settleRunning = false;
  }
}
function notifyExpired(activity) {
  if (!state.notifyOn) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const key = `expired|${activity.id}|${activity.valid_until}`;
  if (notifiedKeys.has(key)) return;
  rememberNotified(key);
  const n = new Notification(`💤 蛋过期了 · ${activity.platform}`, {
    body: `${activity.title}\n使用截止 ${formatDate(activity.valid_until)} 已过，已移入「已过期」`,
    tag: activity.id,
  });
  n.onclick = () => { window.focus(); jumpTo(activity.id); n.close(); };
}
function notifyClosed(activity) {
  if (!state.notifyOn) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const key = `closed|${activity.id}|${activity.claim_deadline}`;
  if (notifiedKeys.has(key)) return;
  rememberNotified(key);
  const n = new Notification(`⏳ 蛋已截止 · ${activity.platform}`, {
    body: `${activity.title}\n领取截止 ${formatDate(activity.claim_deadline)} 已过，已移入「已截止」`,
    tag: activity.id,
  });
  n.onclick = () => { window.focus(); jumpTo(activity.id); n.close(); };
}
async function loadSamples() {
  const now = Date.now();
  const iso = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const day = (n) => now + n * 24 * HOUR;
  const samples = [
    {
      platform: 'Claude', title: '周末积分返场', type: 'voucher', value: '$5 额度',
      claim_deadline: iso(now + 5 * HOUR), valid_until: '', link: 'https://example.com/claude',
      claim_steps: '登录 → Settings → Billing → 点击 Redeem', tags: ['示例'], notes: '每个账号限领一次',
      status: 'pending',
    },
    {
      platform: 'Kimi', title: '开学季月卡 7 折', type: 'discount', value: '月卡 7 折',
      claim_deadline: iso(day(2)), valid_until: '', link: 'https://example.com/kimi',
      claim_steps: '打开活动页 → 登录 → 点领取后下单生效', tags: ['示例'], notes: '',
      status: 'pending',
    },
    {
      platform: 'Gemini', title: '学生认证送 12 个月 Pro', type: 'trial', value: '12 个月 Pro',
      claim_deadline: iso(day(5)), valid_until: iso(day(370)).slice(0, 10), link: 'https://example.com/gemini',
      claim_steps: '用学生邮箱验证 → 活动页一键开通', tags: ['示例'], notes: '需要 .edu 邮箱',
      status: 'pending',
    },
    {
      platform: 'DeepSeek', title: '新用户注册额度', type: 'free_credits', value: '100 万 tokens',
      claim_deadline: null, valid_until: '', link: '', claim_steps: '注册即送，无需操作', tags: ['示例'], notes: '',
      status: 'pending',
    },
  ];
  for (const s of samples) {
    await api('/api/activities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    });
  }
  await load();
  toast('已填入 4 条示例数据，可随意编辑或删除 🧪');
}

export { NOTIFIED_KEY, rememberNotified, load, saveActivity, patchActivity, setStatus, removeActivity, platformOptions, counts, statusTabs, filteredActivities, urgentItems, openEditor, focusActivity, jumpTo, gotoActivity, setNotify, toggleNotify, checkReminders, settleRunning, settleOverdue, notifyExpired, notifyClosed, loadSamples };
