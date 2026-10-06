/* 拾穗集 —— 后台同步结果的跨端回报（手机 → 电脑）
 *
 * 背景：同步状态机跑在手机上，但电脑是数据源、也是人真正盯着的地方。
 * 之前「同步成功/失败用消息+通知告知用户」只在手机本机生效，电脑端永远收不到——
 * 手机连不上电脑的时候更没辙，那正是最该提醒的场合。
 *
 * 闭环拆成两半：
 *  - 手机（reportOutcomes）：把结论排队 POST /api/messages（kind=bg-sync）。
 *    失败不丢，留在本机队列里，等下一次能连上时补报——所以「同步失败」也能最终送达电脑。
 *  - 电脑（startReportInbox）：监听 /api/events 的 report 帧，立刻弹系统通知并刷新消息中心。
 *    服务端对这类回报是「立即广播」的，不走那条 5 分钟防抖：防抖是为数据改动设计的，
 *    而同步结论低频且用户在等，延迟 5 分钟等于没做。
 *
 * 文案由服务端统一生成（addSyncReport），手机只传 ok/attempts/reason，
 * 免得任意一端往对方消息中心塞任意文本。
 */

import { api, getToken, resolveApiUrl } from '../api.js';
import { isDesktop } from '../perm.js';
import { state } from '../state.js';
import { loadMessages } from '../boards/messages.js';
import { notifySystem } from '../notify.js';
import { createSseParser } from './sse-parse.js';

const PENDING_KEY = 'danji.pendingReports';
const PENDING_MAX = 10;          // 最多留 10 条待报，再多说明一直连不上，不值得无限堆
const RECONNECT_DELAY_MS = 5 * 1000;
const HEARTBEAT_TIMEOUT_MS = 3 * 60 * 1000;
const WATCHDOG_TICK_MS = 60 * 1000;

/* ---------------- 手机端：排队 + 补报 ---------------- */

function readPending() {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function writePending(list) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(0, PENDING_MAX)));
  } catch { /* 隐私模式等场景忽略 */ }
}

/**
 * 记一条待回报的同步结论。**不直接发**——发不出去正是常态（连不上电脑），
 * 直接发等于白丢。真正的发送交给 flushReports，由同步流程每轮捎带。
 * @param {{ ok: boolean, reason?: string, attempts?: number, pushed?: number, caughtUp?: boolean }} o
 */
function reportOutcomes({ ok, reason = '', attempts = 0, pushed = 0, caughtUp = false, background = false }) {
  const list = readPending();
  list.push({
    sync_ok: ok ? '1' : '0',
    sync_attempts: Math.max(0, Math.min(99, attempts | 0)),
    sync_reason: String(reason || '').slice(0, 120),
    sync_pushed: String(Math.max(0, Math.min(999, pushed | 0))),
    sync_caught_up: caughtUp ? '1' : '0',
    sync_background: background ? '1' : '0',
    kind: 'bg-sync',
    queued_at: new Date().toISOString(),
  });
  writePending(list);
  return flushReports();
}

/**
 * 尽力把队列里的结论发给电脑。逐条独立处理:
 *  - 成功 → 出队,继续下一条;
 *  - 服务端明确拒收(4xx,除 401/429 外)→ 视为毒丸,丢弃该条、继续发后面的
 *    (否则一条坏数据把队首选死,后面的永远发不出去);
 *  - 401(口令)/ 429(限流)/ 5xx(服务端临时故障)/ 网络错误、超时 → 保留,下次再试。
 * @returns {Promise<{ sent: number, dropped: number, left: number }>}
 */
async function flushReports() {
  let list = readPending();
  if (!list.length) return { sent: 0, dropped: 0, left: 0 };
  let sent = 0;
  let dropped = 0;
  while (list.length) {
    const one = list[0];
    try {
      const res = await api('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(one),
      });
      if (res.ok) {
        list = list.slice(1);
        sent += 1;
        writePending(list);
        continue;
      }
      if (res.status === 401 || res.status === 429 || res.status >= 500) break; // 值得等下次
      list = list.slice(1);   // 其余 4xx:服务端永远不会收这条,留着只会堵死后面的
      dropped += 1;
      writePending(list);
    } catch {
      break; // 网络错误 / 超时:留着下次再试
    }
  }
  return { sent, dropped, left: list.length };
}

function pendingReportCount() {
  return readPending().length;
}

/* ---------------- 手机端：成功回报（唯一入口） ---------------- */

/** 成功回报的合并窗口:连着记三条随记,电脑端只响一次 */
const SUCCESS_COOLDOWN_MS = 60 * 1000;
let lastSuccessAt = 0;   // 上一次成功回报(任意种类)
let lastPushedAt = 0;    // 上一次「推来了 N 条」回报(用户动作的直接回执)

/**
 * 这一轮同步成功,要不要回报电脑端?**纯函数**:时间与上次时间都由调用方给进来。
 *
 * 冷却分槽(2026-10-06 实测):「推来了 N 条」只被上一条「推来了」冷却,
 * **不被「已补齐」冷却**——否则进前台补齐后的第一条随记回执会悄无声息。
 * 「已补齐」仍被任意成功回报冷却(它是低频兜底,防刷屏方向不变)。
 *
 * @param {{ pushed?: number, caughtUp?: boolean, now?: number, lastAt?: number, lastPushedAt?: number }} o
 * @returns {boolean}
 */
function shouldReportSuccess({ pushed = 0, caughtUp = false, now = Date.now(), lastAt = 0, lastPushedAt = 0 } = {}) {
  const n = Math.max(0, pushed | 0);
  // 三样都没有 = 这一轮什么都没发生(打开 App 看了眼、定时器空转…),不必打扰
  if (n === 0 && !caughtUp) return false;
  if (n > 0) return now - lastPushedAt >= SUCCESS_COOLDOWN_MS;
  return now - lastAt >= SUCCESS_COOLDOWN_MS;
}

/**
 * 同步成功后回报电脑端 —— **成功回报的唯一入口**。
 * @param {{ pushed?: number, caughtUp?: boolean }} info
 * @returns {boolean} 该不该发(真正的发送交给 reportOutcomes → flushReports 异步去做)
 */
function reportSyncSuccess({ pushed = 0, caughtUp = false, background = false } = {}) {
  const now = Date.now();
  if (!shouldReportSuccess({ pushed, caughtUp, now, lastAt: lastSuccessAt, lastPushedAt })) return false;
  lastSuccessAt = now;
  if ((pushed | 0) > 0) lastPushedAt = now;
  // 发报本身是异步的(flushReports 自己吞异常),这里只回答「该不该报」,
  // 所以不等它 —— 同步流程是主线程路径,不该被一次网络往返挂住。
  reportOutcomes({ ok: true, pushed, caughtUp, background });
  return true;
}

/* ---------------- 电脑端：监听回报并提醒 ---------------- */

let controller = null;
let lastActivity = 0;
let watchdog = null;
let retryTimer = null;
let inboxRunning = false;

/** 电脑端订阅回报。幂等：反复调用只在没连上时才新建连接。
 *  绝不能像原来那样「先置 listenerStarted 再判角色」—— 挂载那一刻角色还没探回来
 *  就会把整条通道永久判死，且永远不会重试。 */
function startReportInbox() {
  if (!isDesktop()) return false;
  if (inboxRunning) return true;
  inboxRunning = true;
  startWatchdog();
  connect();
  return true;
}

/** 兜底重试口：定时器 / 页面重新可见 / 网络恢复时调它。
 *  已经在跑就直接返回，绝不重复建连接。 */
function ensureReportInbox() {
  return startReportInbox();
}

function connect() {
  if (!inboxRunning || controller) return;
  state.reportInbox = 'connecting';
  const my = new AbortController();
  controller = my;
  (async () => {
    try {
      const headers = { Accept: 'text/event-stream', 'Cache-Control': 'no-store' };
      const token = getToken();
      if (token) headers['X-Danji-Token'] = token;
      // 必须用裸 fetch + resolveApiUrl，**不能用 api()**：api() 带 12 秒超时，
      // 会把这条本该长连的流直接掐死。
      const res = await fetch(resolveApiUrl('/api/events'), { headers, signal: my.signal });
      if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
      lastActivity = Date.now();
      state.reportInbox = 'live';
      const parser = createSseParser();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastActivity = Date.now();
        for (const evt of parser.push(decoder.decode(value, { stream: true }))) {
          if (evt.event !== 'report') continue;
          onReport(evt);
        }
      }
      throw new Error('stream ended');
    } catch {
      if (controller !== my) return;
      controller = null;
      state.reportInbox = 'down';
      if (inboxRunning) scheduleReconnect();
    }
  })();
}

function scheduleReconnect() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
}

function startWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(() => {
    if (!controller) return;
    if (Date.now() - lastActivity <= HEARTBEAT_TIMEOUT_MS) return;
    const my = controller;
    controller = null;
    try { my.abort(); } catch { /* ignore */ }
    if (inboxRunning) scheduleReconnect();
  }, WATCHDOG_TICK_MS);
}

function stopReportInbox() {
  inboxRunning = false;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
  if (controller) {
    const my = controller;
    controller = null;
    try { my.abort(); } catch { /* ignore */ }
  }
  state.reportInbox = 'idle';
}

/** 收到手机回报：立刻弹通知 + 刷新消息中心。通知发不出去也没关系，消息一定在。 */
function onReport(evt) {
  let data = {};
  try { data = JSON.parse(evt.data || '{}'); } catch { /* ignore */ }
  markAnnounced(data.id);                    // 登记：兜底轮询别再弹一遍
  announceReport({ title: data.title, body: data.body });
  try { window.dispatchEvent(new CustomEvent('danji:remote-change')); } catch { /* ignore */ }
  loadMessages().catch(() => {});
}

/* ---- 兜底：SSE 活着就靠它；被浏览器掐了 / 压根没连上，就靠定时补拉 ----
 * 电脑端只是个网页，唯一的信息通道就是这条 SSE，它一死用户就什么都收不到，
 * 而且界面上看不出来。这里用一次很轻的 GET /api/messages 兜底：
 * 即使漏了推送帧，回报最迟也在一个轮询周期内变成一条消息 + 一条系统通知。 */
const POLL_MS = 45 * 1000;
const ANNOUNCED_MAX = 200;
const announced = new Set();
let sweepSeeded = false;
let pollTimer = null;

/** 标记一条回报已播报过；返回 true 表示「这条是新的，之前没播过」 */
function markAnnounced(id) {
  if (!id) return false;
  if (announced.has(id)) return false;
  announced.add(id);
  if (announced.size > ANNOUNCED_MAX) {
    // Set 按插入序，裁最早的一批
    for (const old of [...announced].slice(0, announced.size - ANNOUNCED_MAX)) announced.delete(old);
  }
  return true;
}

/** 播报一条回报（弹系统通知）。通知发不出去也不抛，消息一定在。 */
function announceReport({ title, body }) {
  notifySystem({ title: title || '手机同步回报', body: body || '', tag: 'danji-bgsync' });
}

/**
 * 补拉消息中心并播报漏掉的回报。
 * 首次只建档不播报：刷新页面不该把历史上所有回报再弹一遍。
 */
async function sweepReports() {
  if (!isDesktop()) return;
  // silent：失败不弹 toast。45 秒一次，弹了就是刷屏；
  // 同时把 try/catch 去掉 —— loadMessages 自己吞异常，这个 catch 本来就永远进不去。
  await loadMessages({ silent: true });
  const fresh = state.messages.filter((m) => m.kind === 'bg-sync' && markAnnounced(m.id));
  if (!sweepSeeded) { sweepSeeded = true; return; }
  for (const m of fresh) announceReport({ title: m.title, body: m.body });
}

/** 启动兜底轮询（幂等）。和 SSE 并存，互为保险。 */
function startReportSweep() {
  if (!isDesktop()) return;   // 手机端不轮询
  if (pollTimer) return;
  sweepReports();
  pollTimer = setInterval(sweepReports, POLL_MS);
}

/** 兜底重试口：角色判定有延迟时（health 还没回来）靠它补上，幂等。 */
function ensureReportSweep() {
  return startReportSweep();
}

function stopReportSweep() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

export {
  PENDING_KEY, PENDING_MAX, POLL_MS, SUCCESS_COOLDOWN_MS,
  reportOutcomes, reportSyncSuccess, shouldReportSuccess, flushReports, pendingReportCount,
  startReportInbox, ensureReportInbox, stopReportInbox,
  startReportSweep, ensureReportSweep, stopReportSweep, sweepReports,
};
