/* 拾穗集 —— 电脑端变更推送 + 后台同步重试状态机
 *
 * 需求原文（照着实现，别再退回固定轮询）：
 * 1. 电脑端改了内容（不限随记，所有板块都算）→ 手机自动同步，不需要固定间隔轮询；
 * 2. 服务端在「最后一次改动完成后的 5 分钟」发一条 sync 事件（防抖在 server.js 里做），
 *    手机收到才真正发起同步——所以连改 10 条也只同步一次；
 * 3. 同步成功 → 用「消息 + 通知」告知用户（**仅电脑端**）；
 * 4. 同步失败 → 等 5 分钟重试；再失败再等 5 分钟；还失败 → 用「消息 + 通知」告知用户失败；
 * 5. 通知过之后仍每 5 分钟继续尝试（只播报一次故障，不反复刷屏），成功即报「已恢复」。
 *
 * 为什么播报只落在电脑端：手机在手上、连着同一 WiFi 改东西时走的是前台同步，
 * 本来就即时可见，弹通知纯属打扰；而真正需要后台同步的场景（手机不在身边）
 * 恰恰看不到它的提示栏。提醒留在电脑端，那才是人真正盯着的地方。
 * 手机端仍会照常把记录写进本机消息与 localStorage（上限 20 条），只是不弹通知——
 * 留着是为了用户哪天改主意时历史还在，手机上也不占任何界面位置。
 * 手机上看同步状态靠顶栏的同步胶囊。
 *
 * 两条触发源汇进同一个「欠一次同步」队列，共用 engine 的 syncing 互斥锁：
 *  - SSE 的 sync 事件（主通道，来自电脑端真实改动）
 *  - 原生 15 分钟兜底闹钟（保活 + 断流时补同步，不带成功播报，免得每 15 分钟刷一条）
 *
 * 用 fetch 流式读取而不是 EventSource：后者带不了 X-Danji-Token 请求头。
 * 浏览器 / 旧 APK 也能跑（不依赖 BackgroundSync 插件），未配对时是 no-op。
 */

import { getToken, resolveApiUrl } from '../api.js';
import { isPaired } from '../pair.js';
import { syncNow } from './engine.js';
import { pushLocalMessage } from '../boards/messages.js';
import { createSseParser } from './sse-parse.js';
import { classifySyncResult, nextSyncRetry, SYNC_QUIET_RETRIES } from './net.js';
import { formatDate } from '../util/date.js';
import { reportOutcomes } from './report.js';

// 传输层重连：手机退到后台被系统掐了流，要尽快接回来。这里的节奏对用户不可见，
// 刻意比「同步失败重试」快得多——通道本身不通不该让用户干等 5 分钟。
const RECONNECT_DELAYS_MS = [5 * 1000, 15 * 1000, 30 * 1000, 60 * 1000];
const RECONNECT_STEADY_MS = 5 * 60 * 1000; // 连上几次之后固定 5 分钟一次，不再无限退避
const HEARTBEAT_TIMEOUT_MS = 3 * 60 * 1000;  // 超过 3 分钟没有任何字节视为断流
const WATCHDOG_TICK_MS = 60 * 1000;

/* ---- 传输层状态 ---- */
let controller = null;          // 当前流的 AbortController；null = 未连接
let lastServerActivity = 0;     // 最后一次收到字节的时刻（心跳也续命）
let watchdogTimer = null;
let reconnectTimer = null;
let reconnects = 0;             // 连续重连次数
let running = false;            // 监听器总开关

/* ---- 同步队列状态 ---- */
let owed = false;               // 是否欠一次同步
let owedFromEvent = false;      // 欠账是否来自电脑端真实改动（决定要不要播报成功）
let owedRecovery = false;       // 这轮欠账要不要按「恢复」播报
let lastReason = 'push';
let attempts = 0;               // 本轮连续「真失败」次数（播报过一次后归零）
let incidentNotified = false;   // 本轮故障是否已播报过
let retryTimer = null;          // 失败后 5 分钟的重试闹钟
let draining = false;           // 正在跑同步
let trailing = false;           // 跑的过程中又来一次，跑完补一轮
let waiters = [];               // 等这一轮结果的人（原生兜底闹钟要拿结果打日志）

/** 是否还欠着一次同步（含等待重试中）——给顶栏状态用 */
function hasPendingSync() {
  return owed;
}

/* ---- 传输层 ---- */

async function connect() {
  if (!running || !isPaired() || controller) return;
  const my = new AbortController();
  controller = my;
  try {
    const headers = { Accept: 'text/event-stream', 'Cache-Control': 'no-store' };
    const token = getToken();
    if (token) headers['X-Danji-Token'] = token;
    const res = await fetch(resolveApiUrl('/api/events'), { headers, signal: my.signal });
    if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
    lastServerActivity = Date.now();
    onConnected();
    const parser = createSseParser();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastServerActivity = Date.now();
      for (const evt of parser.push(decoder.decode(value, { stream: true }))) {
        // 'changed' 是 1.2 之前服务端推的事件名，留着兼容老服务端
        if (evt.event === 'sync' || evt.event === 'changed') requestSync({ reason: 'push', fromEvent: true });
      }
    }
    throw new Error('SSE stream ended'); // 服务端正常关流也按断流处理
  } catch {
    // 被 stop / 重连 / 看门狗取代的旧流，报错不作数
    if (controller !== my) return;
    controller = null;
    if (running && isPaired()) scheduleReconnect();
  }
}

function onConnected() {
  // 注意：这里的「恢复」只认 incidentNotified（真的同步失败过），不认 wasReconnecting。
  // 传输层抖一下就重连是常事，WiFi 反复掉线时若把它当恢复，电脑端会被「已恢复」刷屏。
  // 单纯重连的补同步保持安静：它本来就不是失败恢复，只是把断流期间漏的改动补上。
  requestSync({ reason: 'reconnect', fromEvent: false, recovery: incidentNotified });
  reconnects = 0;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = RECONNECT_DELAYS_MS[reconnects] ?? RECONNECT_STEADY_MS;
  reconnects += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/* ---- 同步队列：请求 / 执行 / 判定 / 播报 ---- */

/**
 * 记一次「欠同步」，能立刻跑就立刻跑。
 * 重复请求不会重复排队：已有欠账时只把 fromEvent / recovery 往上抬
 * （电脑端真实改动比兜底闹钟更值得播报成功）。
 * @param {{ reason?: string, fromEvent?: boolean, recovery?: boolean }} opts
 * @returns {Promise<'success'|'fail'|'defer'>} 这一轮跑完的结论
 */
function requestSync({ reason = 'push', fromEvent = false, recovery = false } = {}) {
  // waiter 必须先入队再 drain：否则同步可能在 Promise 建好之前就同步地跑完了
  const p = new Promise((resolve) => { waiters.push(resolve); });
  if (!owed) {
    owedFromEvent = false;
    owedRecovery = false;
  }
  owed = true;
  if (fromEvent) owedFromEvent = true;
  if (recovery) owedRecovery = true;
  lastReason = reason;
  drain();
  return p;
}

function clearRetry() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

/** 把本轮结论交给所有等待者 */
function flushWaiters(verdict) {
  if (!waiters.length) return;
  const list = waiters;
  waiters = [];
  for (const resolve of list) { try { resolve(verdict); } catch { /* ignore */ } }
}

async function drain() {
  if (draining) { trailing = true; return; }
  if (!owed) return;
  draining = true;
  let synced = false;
  let verdict = 'defer';
  try {
    // 跑的过程中又来事件：记下 trailing，这轮跑完再补一轮，保证不漏
    do {
      trailing = false;
      owed = false;
      const fromEvent = owedFromEvent;
      const recovery = owedRecovery;
      owedFromEvent = false;
      owedRecovery = false;
      const r = await syncNow({ reason: lastReason });
      verdict = classifySyncResult(r);
      if (verdict === 'success') {
        synced = true;
        onSyncSuccess(r, fromEvent, recovery);
      } else if (verdict === 'fail') {
        onSyncFail(r);
      } else {
        onSyncDeferred();
      }
      // 失败 / 挂起时这轮不算完结，等重试再给结论；成功则立刻回复等待者
      if (verdict !== 'defer') flushWaiters(verdict);
    } while (trailing);
  } catch { /* syncNow 自吞网络错误，这里兜一层 */ }
  finally {
    draining = false;
  }
  // 同步通了才让根应用重载各板块（app.js 挂在 danji:remote-change 上）。
  // 失败 / 挂起时数据没补齐，重载只会把旧镜像再画一遍。
  if (synced) {
    try { window.dispatchEvent(new CustomEvent('danji:remote-change')); } catch { /* ignore */ }
  }
}

function onSyncSuccess(result, fromEvent, recovery) {
  clearRetry();
  const wasFailing = attempts > 0 || incidentNotified;
  const tried = attempts;
  attempts = 0;
  incidentNotified = false;
  // 播报条件：电脑端真的改了东西（fromEvent），或者这轮是从「失败」恢复的。
  // 兜底闹钟 / 单纯重连触发的补同步保持安静，否则每 15 分钟刷一条通知。
  const worthTelling = !!(fromEvent || recovery || wasFailing);
  if (!worthTelling) return;
  const pushed = (result && result.push && result.push.pushed) || 0;
  const extra = pushed ? `，另把本机 ${pushed} 条改动推了上去` : '';
  pushLocalMessage({
    platform: '同步',
    title: (recovery || wasFailing) ? '后台同步已恢复 ✅' : '后台同步完成 ✅',
    body: `${formatDate(new Date().toISOString())} 已与电脑端同步${extra}`,
    notify: true,
  });
  // 手机端自己的提示没人看，结论要送到电脑端去——那才是人盯着的地方
  reportOutcomes({
    ok: true,
    attempts: tried,
    reason: wasFailing ? `此前重试 ${tried} 次失败后恢复` : '',
  });
}

function onSyncFail(result) {
  attempts += 1;
  owed = true; // 还欠着这次同步，重试时接着试
  const plan = nextSyncRetry(attempts);
  const why = (result && result.error) || '未知原因';
  // 每次失败都回报，不等到播报那一刻：连不上电脑时这条会留在本机队列里，
  // 等下次能连上时补报，于是「失败」最终也能出现在电脑的消息中心。
  // 但连续失败会连着排多条，超过上限会自动丢弃最旧的，flushReports 也只在队首成功时才继续发。
  reportOutcomes({ ok: false, attempts: attempts, reason: why });
  if (plan.notify && !incidentNotified) {
    incidentNotified = true;
    // 播报过就归零：后续失败不再重复打扰，但仍按 5 分钟继续重试
    attempts = 0;
    owedFromEvent = false;
    pushLocalMessage({
      platform: '同步',
      title: '后台同步失败 ❌',
      body: `电脑端有更新，但重试 ${SYNC_QUIET_RETRIES} 次（每次隔 ${plan.delayMs / 60000} 分钟）都没成功：${why}。之后仍每 ${plan.delayMs / 60000} 分钟继续尝试，恢复后会再告诉你。`,
      notify: true,
    });
  }
  scheduleRetry(plan.delayMs);
}

function onSyncDeferred() {
  // offline / need_token / disabled / 上一轮还在跑：不算失败，也不播报。
  // 挂起欠账，5 分钟后再试一次——「电脑关机了」不该被报成同步故障。
  owed = true;
  scheduleRetry(SYNC_RETRY_DELAY_MS);
}

function scheduleRetry(delayMs) {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!running) return;
    drain();
  }, delayMs);
}

/* ---- 看门狗：心跳停了但 socket 没报错的静默断流（NAT 超时 / 网络切换）---- */
function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (!controller) return;
    if (Date.now() - lastServerActivity <= HEARTBEAT_TIMEOUT_MS) return;
    const my = controller;
    controller = null;
    try { my.abort(); } catch { /* ignore */ }
    if (running && isPaired()) scheduleReconnect();
  }, WATCHDOG_TICK_MS);
}

/** 开始监听（幂等）。未配对时是 no-op。 */
function startPushListener() {
  if (running || !isPaired()) return;
  running = true;
  startWatchdog();
  connect();
}

/** 停止监听并清理（清除配对 / 页面卸载时调） */
function stopPushListener() {
  running = false;
  reconnects = 0;
  owed = false;
  owedFromEvent = false;
  owedRecovery = false;
  attempts = 0;
  incidentNotified = false;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  if (controller) {
    const my = controller;
    controller = null;
    try { my.abort(); } catch { /* ignore */ }
  }
  // 别让还在等结果的调用方（原生兜底闹钟）永远挂着
  flushWaiters('defer');
}

/** 供兜底闹钟踢成功后调用：连接若已断就重连（Doze 醒来后的自愈入口） */
function ensurePushConnected() {
  if (running && isPaired() && !controller && !reconnectTimer) connect();
}

export { startPushListener, stopPushListener, ensurePushConnected, requestSync, hasPendingSync };
