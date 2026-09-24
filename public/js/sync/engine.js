/* 拾穗集 —— 手机端同步引擎
 * 电脑端（health.role=desktop）完全不启用。
 * 触发：打开 / 切前台 / 联网 / 每 60 秒 / 用户点同步。
 * push 按服务端 status 出队；pull 写镜像；界面 = 镜像 ∪ outbox。
 */

import { state } from '../state.js';
import { toast } from '../toast.js';
import { apiJson, getToken, setToken, HEALTH_TIMEOUT_MS } from '../api.js';
import { isNativePlatform } from '../pwa.js';
import { isPaired } from '../pair.js';
import { shouldAttemptSync, pickIntervalMs } from './net.js';
import { idbAvailable } from './idb.js';
import {
  readCollection,
  writeMirror,
  upsertMirrorItem,
  removeMirrorItem,
} from './mirror.js';
import {
  listOutbox,
  enqueueOutbox,
  dequeueOutbox,
  putOutbox,
  mergeDisplayItems,
  toPushPayload,
} from './outbox.js';

const MOBILE_FORCE_KEY = 'danji-mobile';

let syncing = false;
let started = false;
let intervalTimer = null;
let intervalMs = 0;
let listenersBound = false;

function uuid() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fallthrough */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function syncEnabled() {
  return !!state.sync && state.sync.enabled;
}

function forceMobileFromQuery() {
  try {
    return new URLSearchParams(location.search).get(MOBILE_FORCE_KEY) === '1';
  } catch {
    return false;
  }
}

/** 布局视口：只影响样式密度，不参与权限判断 */
function syncIsPhone() {
  try {
    state.isPhone = window.matchMedia('(max-width: 640px)').matches;
  } catch {
    state.isPhone = false;
  }
  return state.isPhone;
}

function refreshPendingCount() {
  return listOutbox().then((ops) => {
    state.sync.pendingCount = ops.length;
    try { rearmInterval(); } catch { /* 尚未启动 interval 时忽略 */ }
    return ops.length;
  }).catch(() => 0);
}

/** 显示列表 = 镜像 ∪ outbox（目前 UI 只接 ideas） */
async function reloadIdeasDisplay() {
  if (!syncEnabled()) return;
  try {
    const mirror = await readCollection('ideas');
    const ops = await listOutbox();
    state.ideas = mergeDisplayItems(mirror.items, ops);
    state.ideasLoaded = true;
  } catch (e) {
    console.error('[shisuiji] 读取想法镜像失败', e);
    toast('本地想法镜像读取失败', 'warn');
  }
}

function setStatus(status, extra = {}) {
  Object.assign(state.sync, { status }, extra);
}

async function detectRole() {
  try {
    const { ok, data } = await apiJson('/api/health', { timeoutMs: HEALTH_TIMEOUT_MS });
    if (!ok || !data) return { role: 'unknown', needToken: false, reachable: false };
    return { role: data.role || 'unknown', needToken: !!data.needToken, reachable: true };
  } catch {
    return { role: 'unknown', needToken: false, reachable: false };
  }
}

function lastKnownRole() {
  try {
    return localStorage.getItem('danji.lastRole') || '';
  } catch {
    return '';
  }
}

function rememberRole(role) {
  try {
    if (role === 'desktop' || role === 'mobile') localStorage.setItem('danji.lastRole', role);
  } catch { /* ignore */ }
}

/**
 * 初始化（离线优先）：
 * - health 成功：按 role 决定是否启用同步层
 * - health 失败：若上次是 mobile / 强制 mobile / 视口像手机 → 进入离线 mobile，
 *   IndexedDB 镜像∪队列仍可记想法；服务恢复后自动同步
 * - Capacitor 原生壳：强制 mobile，health 只作可达 / 口令探测
 */
async function initSync() {
  const force = forceMobileFromQuery();
  const native = isNativePlatform();
  const needPair = native && !isPaired();
  const pairedNative = (native || force) && !needPair;

  // 原生已配对：先开本地同步层（IDB 立刻可读可写），health 后台探
  if (pairedNative) {
    bindIsPhoneMq();
    syncIsPhone();
    state.role = 'mobile';
    state.sync.role = 'mobile';
    state.sync.offline = true;
    state.sync.needPair = false;
    state.sync.pairOpen = false;
    state.sync.needToken = false;
    state.sync.enabled = true;
    if (!idbAvailable()) {
      setStatus('error', { lastError: '当前环境不支持 IndexedDB，无法离线同步' });
      return false;
    }
    setStatus('offline');
    bindListeners();
    startInterval();
    tryPersistStorage();
    await refreshPendingCount();
    await reloadIdeasDisplay();
    // 后台探测可达性，成功则立刻同步并通知根应用补拉板块
    detectRole().then(async ({ needToken, reachable }) => {
      state.sync.needToken = reachable && needToken && !getToken();
      state.sync.offline = !reachable;
      if (!reachable) {
        setStatus('offline');
        return;
      }
      const result = await syncNow({ reason: 'init' });
      // 仅同步真正成功后再通知补拉，避免失败时误标在线
      if (result && result.ok) {
        try {
          window.dispatchEvent(new CustomEvent('danji:online'));
        } catch { /* ignore */ }
      }
    }).catch(() => { /* 已在 offline */ });
    return true;
  }

  const { role, needToken, reachable } = await detectRole();
  bindIsPhoneMq();
  syncIsPhone();

  let effectiveRole;
  let offline = false;
  if (force || native) {
    // 原生壳始终是手机同步端，不看 health.role / lastRole
    effectiveRole = 'mobile';
    offline = !reachable || needPair;
  } else if (reachable && (role === 'desktop' || role === 'mobile')) {
    effectiveRole = role;
    rememberRole(role);
  } else {
    // 服务不可达：离线优先
    offline = true;
    const prev = lastKnownRole();
    effectiveRole = prev || 'mobile';
  }

  state.role = effectiveRole;
  state.sync.role = effectiveRole;
  state.sync.offline = offline;
  state.sync.needPair = needPair;
  state.sync.pairOpen = needPair;
  // 未配对时用配对表单收口令，不走旧的 need_token 弹层
  state.sync.needToken = !needPair && reachable && needToken && !getToken();
  state.sync.enabled = force || native || effectiveRole === 'mobile';

  if (!state.sync.enabled) {
    setStatus('idle');
    return false;
  }
  if (!idbAvailable()) {
    setStatus('error', { lastError: '当前环境不支持 IndexedDB，无法离线同步' });
    return false;
  }
  if (offline) {
    setStatus('offline');
  } else if (state.sync.needToken) {
    setStatus('need_token');
  }
  bindListeners();
  startInterval();
  tryPersistStorage();
  await refreshPendingCount();
  await reloadIdeasDisplay();
  if (offline) {
    // 不发起网络请求，避免离线启动时弹一串失败
    return true;
  }
  await syncNow({ reason: 'init' });
  return true;
}

function bindIsPhoneMq() {
  try {
    const mq = window.matchMedia('(max-width: 640px)');
    if (mq._danjiPhoneBound) return;
    mq._danjiPhoneBound = true;
    if (mq.addEventListener) mq.addEventListener('change', syncIsPhone);
    else if (mq.addListener) mq.addListener(syncIsPhone);
  } catch { /* 老环境忽略 */ }
}

/** 尽力申请持久化存储，降低系统回收导致未同步 outbox 丢失的概率 */
function tryPersistStorage() {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
      Promise.resolve(navigator.storage.persist()).catch(() => { /* 拒绝也不阻断 */ });
    }
  } catch { /* 无 storage API 时忽略 */ }
}

function bindListeners() {
  if (listenersBound) return;
  listenersBound = true;
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  bindIsPhoneMq();
  syncIsPhone();
}

function unbindListeners() {
  if (!listenersBound) return;
  listenersBound = false;
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('online', onOnline);
  try {
    const mq = window.matchMedia('(max-width: 640px)');
    if (mq.removeEventListener) mq.removeEventListener('change', syncIsPhone);
    else if (mq.removeListener) mq.removeListener(syncIsPhone);
  } catch { /* ignore */ }
}

function onVisibility() {
  if (!syncEnabled()) return;
  if (document.visibilityState === 'visible') syncNow({ reason: 'visibility' });
}

function onOnline() {
  if (!syncEnabled()) return;
  syncNow({ reason: 'online' });
}

function stopInterval() {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  intervalMs = 0;
}

function startInterval() {
  const want = pickIntervalMs(state.sync.pendingCount || 0);
  if (intervalTimer && intervalMs === want) return;
  stopInterval();
  intervalMs = want;
  intervalTimer = setInterval(() => {
    if (syncEnabled()) syncNow({ reason: 'interval' });
  }, want);
}

/** pending 变化后切换 60s / 8s */
function rearmInterval() {
  if (!intervalTimer && intervalMs === 0 && !started) return;
  startInterval();
}

function disposeSync() {
  stopInterval();
  unbindListeners();
  syncing = false;
  started = false;
}

/** 按 push 结果处理单条：出队 / 留队 / 删本地 / 回滚 */
async function applyPushResult(entry, result) {
  const status = result && result.status;
  if (status === 'ok') {
    await dequeueOutbox(entry.id);
    if (result.deleted) {
      await removeMirrorItem('ideas', entry.id);
      return { action: 'dequeue', status };
    }
    if (result.idea) {
      await upsertMirrorItem('ideas', result.idea);
    }
    return { action: 'dequeue', status };
  }
  if (status === 'conflict') {
    // 留队，进冲突列表等用户二选一
    const server = result.server || null;
    const localView = entry.payload
      ? { ...(server || {}), ...entry.payload, id: entry.id }
      : null;
    const exists = state.sync.conflicts.some((c) => c.id === entry.id);
    if (!exists) {
      state.sync.conflicts.push({
        id: entry.id,
        op: entry.op,
        entry,
        server,
        local: localView,
      });
    } else {
      const idx = state.sync.conflicts.findIndex((c) => c.id === entry.id);
      state.sync.conflicts[idx] = {
        id: entry.id,
        op: entry.op,
        entry,
        server,
        local: localView,
      };
    }
    return { action: 'keep', status };
  }
  if (status === 'missing') {
    await dequeueOutbox(entry.id);
    await removeMirrorItem('ideas', entry.id);
    state.sync.conflicts = state.sync.conflicts.filter((c) => c.id !== entry.id);
    return { action: 'dequeue_missing', status };
  }
  if (status === 'forbidden') {
    // 电脑端记的，手机改不了：出队并回滚到服务端观点（pull 稍后会覆盖；这里先删本地覆盖）
    await dequeueOutbox(entry.id);
    state.sync.conflicts = state.sync.conflicts.filter((c) => c.id !== entry.id);
    // mirror 保持不动；若是本地 create 则不要插入
    return { action: 'dequeue_forbidden', status };
  }
  // error：参数非法，重试无用，出队
  await dequeueOutbox(entry.id);
  state.sync.lastError = result && result.error ? String(result.error) : '同步参数错误';
  return { action: 'dequeue_error', status: status || 'error' };
}

async function pushOnce() {
  // 冲突中且未解决的条目先不重复推，避免每 60 秒打一轮同样的 conflict
  const conflictIds = new Set((state.sync.conflicts || []).map((c) => c.id));
  const ops = (await listOutbox()).filter((o) => !conflictIds.has(o.id));
  if (!ops.length) return { pushed: 0, results: [] };
  const payload = ops.map(toPushPayload).filter(Boolean);
  if (!payload.length) return { pushed: 0, results: [] };
  const { ok, status, data } = await apiJson('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ ideas: payload }),
  });
  if (status === 401) {
    setStatus('need_token');
    return { pushed: 0, results: [], needToken: true };
  }
  if (!ok) {
    throw new Error((data && data.error) || `push 失败 HTTP ${status}`);
  }
  const results = Array.isArray(data.results) ? data.results : [];
  const byId = new Map(results.map((r) => [r.id, r]));
  for (const entry of ops) {
    const result = byId.get(entry.id) || { id: entry.id, status: 'error', error: '服务端未返回该条结果' };
    await applyPushResult(entry, result);
  }
  return { pushed: ops.length, results };
}

async function pullOnce() {
  const { ok, status, data } = await apiJson('/api/sync/pull');
  if (status === 401) {
    setStatus('need_token');
    return { needToken: true };
  }
  if (!ok || !data) {
    throw new Error((data && data.error) || `pull 失败 HTTP ${status}`);
  }
  await writeMirror(data);
  return { pulled: true, server_time: data.server_time };
}

/** 主同步循环 */
async function syncNow(opts = {}) {
  if (!syncEnabled()) return { skipped: true, reason: 'disabled' };
  if (syncing) return { skipped: true, reason: 'running' };
  // 先过同步门闩，避免「syncing → offline」空闪
  const online = typeof navigator === 'undefined' ? undefined : navigator.onLine;
  if (!shouldAttemptSync({ native: isNativePlatform(), paired: isPaired(), online })) {
    await refreshPendingCount();
    setStatus('offline', { lastError: '' });
    await reloadIdeasDisplay();
    return { skipped: true, reason: 'offline' };
  }
  syncing = true;
  setStatus('syncing');
  try {
    if (!getToken() && state.sync.needToken) {
      setStatus('need_token');
      return { skipped: true, reason: 'need_token' };
    }

    const push = await pushOnce();
    if (push.needToken) {
      await reloadIdeasDisplay();
      return { skipped: true, reason: 'need_token' };
    }

    const pull = await pullOnce();
    if (pull && pull.needToken) {
      await reloadIdeasDisplay();
      return { skipped: true, reason: 'need_token' };
    }

    await refreshPendingCount();
    await reloadIdeasDisplay();

    state.sync.lastSyncAt = new Date().toISOString();
    state.sync.lastError = '';
    state.sync.offline = false;
    if (state.sync.conflicts.length) {
      setStatus('conflicts');
    } else if (state.sync.pendingCount > 0) {
      setStatus('offline');
    } else {
      setStatus('synced');
    }
    return { ok: true, push, pull, reason: opts.reason };
  } catch (e) {
    state.sync.lastError = (e && e.message) || String(e);
    state.sync.offline = true;
    await refreshPendingCount();
    setStatus('offline');
    if (opts.reason === 'manual') {
      toast('同步失败：' + state.sync.lastError, 'warn');
    }
    return { ok: false, error: state.sync.lastError };
  } finally {
    syncing = false;
  }
}

/** 冲突二选一：keepMobile=用手机端（以本地 payload 为基准重推）；否则用电脑端 */
async function resolveConflict(id, choice) {
  const idx = state.sync.conflicts.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  const conflict = state.sync.conflicts[idx];
  state.sync.conflicts.splice(idx, 1);

  if (choice === 'mobile') {
    const server = conflict.server || {};
    const payload = conflict.entry && conflict.entry.payload
      ? { ...conflict.entry.payload, id }
      : { id };
    const next = {
      id,
      op: conflict.op === 'delete' ? 'delete' : 'update',
      payload,
      // 强制覆盖：base 对齐服务端当前版本，服务端不会再报同一冲突
      base_updated_at: server.updated_at || '',
      confirmed: true,
      updated_at: new Date().toISOString(),
      origin: 'mobile',
    };
    await putOutbox(next);
  } else {
    // 用电脑端：丢掉本地待发，镜像改成服务端版本
    await dequeueOutbox(id);
    if (conflict.server) await upsertMirrorItem('ideas', conflict.server);
  }
  await refreshPendingCount();
  await reloadIdeasDisplay();
  if (state.sync.conflicts.length) setStatus('conflicts');
  else setStatus(state.sync.pendingCount > 0 ? 'offline' : 'synced');
  syncNow({ reason: 'conflict-resolved' });
  return true;
}

/** 手机端本地写入：入队 + 立刻刷新显示 */
async function enqueueIdeaLocal({ op, id, payload, baseUpdatedAt }) {
  const entryId = id || uuid();
  const now = new Date().toISOString();
  let confirmed = false;
  try {
    const mirror = await readCollection('ideas');
    confirmed = !!(mirror.items || []).some((i) => i.id === entryId);
  } catch { /* 镜像读失败时按未确认处理 */ }
  if (op === 'delete' || op === 'update') confirmed = true;
  // 乐观锁基线：优先用调用方传入的「最后一次服务端 updated_at」；
  // 其次才回落到镜像里的服务端版本。绝不能用本地编辑时间。
  let serverBase = baseUpdatedAt || '';
  if (!serverBase) {
    try {
      const mirror = await readCollection('ideas');
      const hit = (mirror.items || []).find((i) => i.id === entryId);
      if (hit) serverBase = hit.updated_at || '';
    } catch { /* ignore */ }
  }
  const merged = {
    id: entryId,
    op,
    payload: payload
      ? {
        id: entryId,
        title: payload.title || '',
        content: payload.content || '',
        origin: 'mobile',
        created_at: payload.created_at || now,
        updated_at: now,
      }
      : null,
    base_updated_at: serverBase,
    confirmed,
    origin: 'mobile',
    updated_at: now,
  };
  await enqueueOutbox(merged);
  await refreshPendingCount();
  await reloadIdeasDisplay();
  const online = typeof navigator === 'undefined' ? undefined : navigator.onLine;
  const attempt = shouldAttemptSync({ native: isNativePlatform(), paired: isPaired(), online });
  if (!attempt) {
    setStatus('offline');
  } else if (state.sync.status !== 'syncing') {
    setStatus(state.sync.conflicts.length ? 'conflicts' : (state.sync.pendingCount ? 'offline' : 'synced'));
  }
  // 能发请求就顺手推一把（原生已配对忽略 onLine）
  if (attempt) {
    syncNow({ reason: 'local-write' });
  }
  return entryId;
}

/** 用户提交口令 */
function submitToken(token) {
  const t = setToken(token);
  state.sync.needToken = !t;
  if (t) {
    setStatus(state.sync.pendingCount ? 'offline' : 'idle');
    syncNow({ reason: 'token' });
  }
  return t;
}

/** 配对成功后收尾：关表单、恢复可达状态并立刻同步 */
function notifyPaired() {
  state.sync.needPair = false;
  state.sync.pairOpen = false;
  state.sync.offline = false;
  state.sync.needToken = false;
  if (state.sync.pendingCount > 0) setStatus('offline');
  else setStatus('idle');
  syncNow({ reason: 'pair' });
}

function openPair() {
  state.sync.pairOpen = true;
}

function closePair() {
  // 未配对时允许关闭（离线记想法），但仍标 needPair
  state.sync.pairOpen = false;
}

function installSync() {
  if (started) return Promise.resolve(state.sync.enabled);
  started = true;
  return initSync();
}

export {
  uuid,
  initSync,
  installSync,
  syncNow,
  resolveConflict,
  enqueueIdeaLocal,
  submitToken,
  notifyPaired,
  openPair,
  closePair,
  reloadIdeasDisplay,
  disposeSync,
  refreshPendingCount,
  syncIsPhone,
  shouldAttemptSync,
};
