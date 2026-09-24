/* 拾穗集 —— 是否发起同步请求 / 轮询间隔
 * WebView 的 navigator.onLine 常不可靠：原生已配对时一律尝试，失败再标离线。
 * 网页仍尊重 online，避免断网时刷一串失败。
 */

const SYNC_INTERVAL_MS = 60 * 1000;
const SYNC_INTERVAL_BUSY_MS = 8 * 1000;

/**
 * @param {{ native?: boolean, paired?: boolean, online?: boolean }} input
 * @returns {boolean} 是否应发起 push/pull
 */
function shouldAttemptSync({ native = false, paired = false, online } = {}) {
  if (native) return !!paired;
  return online !== false;
}

/** 待同步时短轮询，空闲 60s */
function pickIntervalMs(pendingCount) {
  return (pendingCount > 0) ? SYNC_INTERVAL_BUSY_MS : SYNC_INTERVAL_MS;
}

export { shouldAttemptSync, pickIntervalMs, SYNC_INTERVAL_MS, SYNC_INTERVAL_BUSY_MS };
