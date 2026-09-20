/* 拾穗集 —— PWA Service Worker 注册
 * SW 只能在安全上下文注册：https 或 localhost/127.0.0.1。
 * 局域网 http://192.168.x.x 会静默跳过并 console.warn——
 * 这时「关掉浏览器再打开」是打不开的，必须配 HTTPS 才能离线冷启动。
 */

function isSecurePwaContext() {
  if (typeof location === 'undefined') return false;
  if (location.protocol === 'https:') return true;
  const host = location.hostname;
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '[::1]'
    || host === '::1';
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!isSecurePwaContext()) {
    console.warn(
      '[shisuiji] 当前不是安全上下文（需 https 或 localhost），已跳过 Service Worker 注册。'
      + '局域网 http 下关掉浏览器再打开无法离线冷启动；配置 DANJI_TLS_CERT/DANJI_TLS_KEY 启用 HTTPS 后会自动注册。',
    );
    return;
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[shisuiji] Service Worker 注册失败', err);
    });
  });
}

registerServiceWorker();

export { isSecurePwaContext, registerServiceWorker };
