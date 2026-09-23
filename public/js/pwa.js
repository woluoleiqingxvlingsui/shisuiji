/* 拾穗集 —— PWA Service Worker 注册
 * SW 只能在安全上下文注册：https 或 localhost/127.0.0.1。
 * 局域网 http://192.168.x.x 会静默跳过并 console.warn——
 * 这时「关掉浏览器再打开」是打不开的，必须配 HTTPS 才能离线冷启动。
 * Capacitor 原生壳资源已打进 APK，跳过 SW。
 */

/** 是否运行在 Capacitor 原生壳（WebView）里 */
function isNativePlatform() {
  try {
    return !!(
      typeof window !== 'undefined'
      && window.Capacitor
      && typeof window.Capacitor.isNativePlatform === 'function'
      && window.Capacitor.isNativePlatform()
    );
  } catch {
    return false;
  }
}

function isSecurePwaContext() {
  if (typeof location === 'undefined') return false;
  if (location.protocol === 'https:') return true;
  const host = location.hostname;
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '[::1]'
    || host === '::1';
}

/** 离线壳是否已接管（冷启动能否不连电脑打开） */
function isPwaShellActive() {
  try {
    return !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  } catch {
    return false;
  }
}

function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (isNativePlatform()) {
    // 原生壳本地资源已内置，不需要 PWA 离线壳
    console.info('[shisuiji] Capacitor 原生环境，跳过 Service Worker 注册');
    return;
  }
  if (!isSecurePwaContext()) {
    console.warn(
      '[shisuiji] 当前不是安全上下文（需 https 或 localhost），已跳过 Service Worker 注册。'
      + '局域网 http://192.168.x.x 会静默跳过并 console.warn——关掉浏览器再打开无法离线冷启动；配置 HTTPS 后会自动注册。',
    );
    return;
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      console.info('[shisuiji] Service Worker 已注册', reg.scope);
    }).catch((err) => {
      console.warn('[shisuiji] Service Worker 注册失败', err);
    });
  });
}

registerServiceWorker();

export { isNativePlatform, isSecurePwaContext, isPwaShellActive, registerServiceWorker };
