/* 拾穗集 —— 是否发起同步请求 / 轮询间隔
 * WebView 的 navigator.onLine 常不可靠：原生已配对时一律尝试，失败再标离线。
 * 网页仍尊重 online，避免断网时刷一串失败。
 */

const SYNC_INTERVAL_BUSY_MS = 8 * 1000;
// 推送连着的时候完全不轮询（0）；推送断了才用这个慢速兜底
const SYNC_INTERVAL_FALLBACK_MS = 3 * 60 * 1000;

// ---------- 后台同步的重试节奏（电脑端推送触发的那一轮）----------
// 需求原文：同步失败就等 5 分钟再试；若再次失败，再过 5 分钟再试；如果还失败，
// 才用「消息 + 通知」告知用户。即 1 次首发 + 2 次重试 = 第 3 次失败才播报。
// 播报过之后仍然每 5 分钟继续尝试（只播报一次故障，不反复刷屏），成功即算恢复。
const SYNC_RETRY_DELAY_MS = 5 * 60 * 1000;
const SYNC_QUIET_RETRIES = 2;

// App 壳内置版本（P10 / M5）：与 health.minClient 比对，过旧提示重装 APK。
// 每次改到「旧壳会静默出错」的前端/协议行为时递增。
// v2：后台同步改为事件驱动。服务端推的聚合事件从 changed 改名 sync（旧壳只认 changed，
//     配新服务端会一条推送都收不到、只剩 15 分钟兜底闹钟，正是「静默出错」），
//     hello 帧也多了 pendingSince 字段。升到 2 让旧壳主动提示重装，而不是默默不同步。
const CLIENT_VERSION = 2;

/** health.minClient 大于内置版本即为过旧；字段缺失（老服务）视为不过旧 */
function isClientOutdated(minClient) {
  const min = Number(minClient);
  if (!Number.isFinite(min)) return false;
  return CLIENT_VERSION < min;
}

/**
 * @param {{ native?: boolean, paired?: boolean, online?: boolean }} input
 * @returns {boolean} 是否应发起 push/pull
 */
function shouldAttemptSync({ native = false, paired = false, online } = {}) {
  if (native) return !!paired;
  return online !== false;
}

/**
 * 原生后台同步服务该不该跑。
 * 未配对时 shouldAttemptSync 恒 false，服务只会白耗电 + 白挂常驻通知，所以一并挡住。
 * @param {{ pluginAvailable?: boolean, wanted?: boolean, paired?: boolean }} input
 * @returns {boolean}
 */
function shouldRunBackgroundService({ pluginAvailable = false, wanted = true, paired = false } = {}) {
  return !!(pluginAvailable && wanted && paired);
}

/**
 * 后台踢同步的回报口径：只有明确失败才算失败。
 * skipped（running / disabled / offline / need_token）算中性——电脑端临时不可达
 * 不代表同步通道有问题；真失败时 syncNow 返回 { ok: false }。
 * 原生侧间隔已固定为 15 分钟兜底（主通道是 SSE 推送），回报只作日志观察。
 * @param {{ ok?: boolean, skipped?: boolean }} result syncNow 的返回值
 * @returns {boolean} true = 同步通道正常
 */
function isBackgroundSyncOk(result) {
  return !result || result.ok !== false;
}

/**
 * syncNow 返回值 → 本轮同步的结论。调用方据此决定「发成功消息 / 记一次失败重试 / 原样挂着等下次」。
 * - 'success'  真同步成功（ok:true）
 * - 'fail'     真失败（ok:false），要计入重试并最终通知
 * - 'defer'    没成但也不算失败：offline / need_token / disabled / 上一轮还在跑。
 *               挂起这次同步，5 分钟后重试，但不计入连续失败次数——
 *               否则「电脑关机了」会被误报成「后台同步失败」。
 * @param {{ ok?: boolean, skipped?: boolean, reason?: string }} result
 * @returns {'success'|'fail'|'defer'}
 */
function classifySyncResult(result) {
  if (!result) return 'defer';
  if (result.ok === true) return 'success';
  if (result.ok === false) return 'fail';
  return 'defer';
}

/**
 * 连续失败 attempts 次之后，下一步怎么走。
 * attempts 记的是「已经失败了几次」：首发那次失败是 1，之后每重试失败一次 +1。
 * 首发 + 2 次重试都失败（attempts 达到 3）才播报。
 * @param {number} attempts 已经连续失败的次数
 * @returns {{ delayMs: number, notify: boolean, reset: boolean }}
 *   notify = 该用「消息 + 通知」告知用户了；reset = 通知后不再重复播报
 */
function nextSyncRetry(attempts) {
  const n = Number(attempts) || 0;
  return {
    delayMs: SYNC_RETRY_DELAY_MS,
    notify: n > SYNC_QUIET_RETRIES,
    reset: n > SYNC_QUIET_RETRIES,
  };
}

/**
 * 该以什么节奏轮询。
 * pendingCount>0  有待推送数据 → 8 秒快轮询。这是**往上传**本地改动，优先级最高，
 *                 与推送广播无关，必须保留。
 * pushConnected   SSE 推送连着 → 0（不轮询）。服务端本来就会广播，
 *                 再自己每分钟全量拉一遍纯属浪费电和流量。
 * 否则            推送断了 → 3 分钟慢速兜底，不至于彻底瞎掉。
 * @param {number} pendingCount
 * @param {boolean} pushConnected
 * @returns {number} 毫秒；0 表示关掉轮询
 */
function pickIntervalMs(pendingCount, pushConnected) {
  if (pendingCount > 0) return SYNC_INTERVAL_BUSY_MS;
  if (pushConnected) return 0;
  return SYNC_INTERVAL_FALLBACK_MS;
}

export { shouldAttemptSync, shouldRunBackgroundService, isBackgroundSyncOk, classifySyncResult, nextSyncRetry, pickIntervalMs, isClientOutdated, CLIENT_VERSION, SYNC_INTERVAL_FALLBACK_MS, SYNC_INTERVAL_BUSY_MS, SYNC_RETRY_DELAY_MS, SYNC_QUIET_RETRIES };
