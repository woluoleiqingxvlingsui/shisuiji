/* 拾穗集 —— 是否发起同步请求 / 轮询间隔
 * WebView 的 navigator.onLine 常不可靠：原生已配对时一律尝试，失败再标离线。
 * 网页仍尊重 online，避免断网时刷一串失败。
 */

const SYNC_INTERVAL_MS = 60 * 1000;
const SYNC_INTERVAL_BUSY_MS = 8 * 1000;

// App 壳内置版本（P10 / M5）：与 health.minClient 比对，过旧提示重装 APK。
// 每次改到「旧壳会静默出错」的前端/协议行为时递增。
const CLIENT_VERSION = 1;

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

/** 待同步时短轮询，空闲 60s */
function pickIntervalMs(pendingCount) {
  return (pendingCount > 0) ? SYNC_INTERVAL_BUSY_MS : SYNC_INTERVAL_MS;
}

export { shouldAttemptSync, pickIntervalMs, isClientOutdated, CLIENT_VERSION, SYNC_INTERVAL_MS, SYNC_INTERVAL_BUSY_MS };
