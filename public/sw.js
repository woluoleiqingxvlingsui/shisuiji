/* 拾穗集 —— Service Worker
 * 必须放在 public/ 根目录，注册后的 scope 才是 /。
 *
 * 策略：
 *   /api/*              不缓存（离线数据由 IndexedDB 镜像 + outbox 提供）
 *   导航（HTML）        network-first，失败回落缓存的 index.html
 *   代码与样式          network-first（/js/*.js、/*.css）：
 *                       改完前端下次刷新必须生效，绝不能喂旧代码（旧版看图层抽搐事故的根因）
 *   其它静态资源        stale-while-revalidate（图标/图片/vendor，变化少）
 *
 * 改了缓存策略或预缓存清单就把 VERSION +1，activate 会清掉所有旧缓存。
 */
const VERSION = 'p9-v2';
const STATIC_CACHE = `danji-static-${VERSION}`;
const NAV_CACHE = `danji-nav-${VERSION}`;
const OFFLINE_URL = '/index.html';
// 代码/样式走 network-first：保证修复与新版界面一次刷新即到位
const FRESH_RE = /^\/(js\/.+\.js|[^/]+\.css)$/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(NAV_CACHE);
    await cache.add(new Request(OFFLINE_URL, { cache: 'reload' }));
    // 常用静态一并预缓存，冷启动更快
    const sw = await caches.open(STATIC_CACHE);
    await Promise.allSettled([
      sw.add(new Request('/style.css', { cache: 'reload' })),
      sw.add(new Request('/js/app.js', { cache: 'reload' })),
      sw.add(new Request('/manifest.webmanifest', { cache: 'reload' })),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('danji-static-') || k.startsWith('danji-nav-'))
      .filter((k) => k !== STATIC_CACHE && k !== NAV_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API 一律走网络，绝不进 SW 缓存
  if (url.pathname.startsWith('/api/')) return;

  // 导航：network-first → 回落离线壳（只缓存成功响应，避免 4xx/5xx 污染离线页）
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          const cache = await caches.open(NAV_CACHE);
          cache.put(OFFLINE_URL, fresh.clone());
        }
        return fresh;
      } catch {
        const cache = await caches.open(NAV_CACHE);
        return (await cache.match(OFFLINE_URL)) || Response.error();
      }
    })());
    return;
  }

  // 代码与样式：network-first，失败才回落缓存（离线兜底）
  if (FRESH_RE.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch {
        return (await cache.match(req)) || Response.error();
      }
    })());
    return;
  }

  // 静态：stale-while-revalidate
  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (cached) {
      network; // 后台更新
      return cached;
    }
    const fresh = await network;
    return fresh || Response.error();
  })());
});
