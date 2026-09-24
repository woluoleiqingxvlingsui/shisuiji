/* 拾穗集 —— 是否发起同步请求
 * WebView 的 navigator.onLine 常不可靠：原生已配对时一律尝试，失败再标离线。
 * 网页仍尊重 online，避免断网时刷一串失败。
 */

/**
 * @param {{ native?: boolean, paired?: boolean, online?: boolean }} input
 * @returns {boolean} 是否应发起 push/pull
 */
function shouldAttemptSync({ native = false, paired = false, online } = {}) {
  if (native) return !!paired;
  return online !== false;
}

export { shouldAttemptSync };
