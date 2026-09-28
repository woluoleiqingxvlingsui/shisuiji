/* 拾穗集 · 原页阅读进度 —— 后台 service worker
 * 配置（base + token）存 chrome.storage.local；
 * 收到内容脚本的消息后，按 URL 匹配拾穗集里的网页记录，读写其阅读进度。
 */

const CFG_KEY = 'danjiCfg';

async function getCfg() {
  const o = await chrome.storage.local.get(CFG_KEY);
  const cfg = o[CFG_KEY];
  return cfg && cfg.base ? cfg : null;
}

function norm(u) {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch { return ''; }
}

async function fetchJson(cfg, path) {
  const base = cfg.base.replace(/\/+$/, '');
  const res = await fetch(base + path, { headers: { 'X-Danji-Token': cfg.token || '' } });
  if (!res.ok) return null;
  return res.json();
}

async function findSite(cfg, url) {
  const list = await fetchJson(cfg, '/api/sites');
  if (!Array.isArray(list)) return null;
  const target = norm(url);
  if (!target) return null;
  return list.find((s) => norm(s.url) === target) || null;
}

// 同一页面的连续 save 合并：800ms 内只发最后一次
const pending = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // ping 优先处理：popup「测试连接」带表单值，未保存也能测
      if (msg.type === 'ping' && msg.cfg && msg.cfg.base) {
        const h = await fetchJson(msg.cfg, '/api/health');
        sendResponse({ ok: !!h, health: h });
        return;
      }
      const cfg = await getCfg();
      if (!cfg) { sendResponse({ ok: false, error: '未配置拾穗集地址' }); return; }
      if (msg.type === 'ping') {
        const h = await fetchJson(cfg, '/api/health');
        sendResponse({ ok: !!h, health: h });
        return;
      }
      if (msg.type === 'get') {
        const site = await findSite(cfg, msg.url);
        sendResponse({
          progress: site ? (Number(site.read_progress) || 0) : 0,
          // 锚点（标题/文本片段 + 偏移）：恢复时优先按它定位，页面长高也不漂
          anchor: (site && site.read_anchor) || null,
        });
        return;
      }
      if (msg.type === 'save') {
        const old = pending.get(msg.url);
        if (old) clearTimeout(old);
        pending.set(msg.url, setTimeout(async () => {
          pending.delete(msg.url);
          try {
            const site = await findSite(cfg, msg.url);
            if (!site) return;
            const base = cfg.base.replace(/\/+$/, '');
            const r = await fetch(base + '/api/sites/' + encodeURIComponent(site.id) + '/progress', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Danji-Token': cfg.token || '' },
              body: JSON.stringify({ ratio: msg.ratio, anchor: msg.anchor || null }),
            });
          } catch { /* 电脑没开/不在同网：静默放弃，下次再报 */ }
        }, 800));
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // 异步 sendResponse
});
