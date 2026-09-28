/* 拾穗集 —— 随记贴图取图通道
 * <img> 直连 http://局域网IP 在原生壳里受 WebView 混合内容策略限制（页面源是
 * https://localhost），而同一个地址走 fetch 却没问题（原生壳下 fetch 被
 * CapacitorHttp 接管走原生桥，同步/上传一直靠它）。所以贴图统一 fetch 成
 * blob 再转 objectURL 给 <img>，两条通道合一，不再看 WebView 脸色。
 */
import { ref, watch } from './vue-globals.js';
import { api, resolveApiUrl, getToken } from './api.js';

const cache = new Map(); // id -> Promise<objectURL>

// 原生壳的 fetch/XHR 都被 Capacitor  polyfill 接管，且都不传 responseType，
// 二进制会被当 UTF-8 文本读坏；只有直连 CapacitorHttp 插件并显式
// responseType:'blob' 才走 base64 完整回传。Web 端没有 window.Capacitor，走普通 fetch。
async function fetchImageBlob(id) {
  const path = '/api/images/' + encodeURIComponent(id);
  const token = getToken();
  const headers = token ? { 'X-Danji-Token': token } : {};
  const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
  if (plugin) {
    const r = await plugin.request({ url: resolveApiUrl(path), method: 'GET', headers, responseType: 'blob' });
    if (!r || r.status < 200 || r.status >= 300) throw new Error('image ' + ((r && r.status) || '?'));
    const b64 = String(r.data == null ? '' : r.data).replace(/\s/g, '');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ct = (r.headers && (r.headers['Content-Type'] || r.headers['content-type'])) || 'application/octet-stream';
    return new Blob([bytes], { type: ct });
  }
  const res = await api(path);
  if (!res.ok) throw new Error('image ' + res.status);
  return res.blob();
}

function imageObjectUrl(id) {
  if (!cache.has(id)) {
    const p = (async () => URL.createObjectURL(await fetchImageBlob(id)))();
    p.catch(() => cache.delete(id)); // 失败不缓存（离线时稍后还能重试）
    cache.set(id, p);
  }
  return cache.get(id);
}

// 传入响应式的图片数组；返回 id -> objectURL 的 ref 映射，列表变化自动补解析
function useImageUrls(imagesRef) {
  const urls = ref({});
  async function resolve(list) {
    for (const im of list || []) {
      if (!im || !im.id || urls.value[im.id]) continue;
      try {
        const u = await imageObjectUrl(im.id);
        urls.value = { ...urls.value, [im.id]: u };
      } catch { /* 离线/图缺失：保持空，UI 显示占位 */ }
    }
  }
  watch(imagesRef, (v) => resolve(v), { immediate: true, deep: true });
  return { urls, resolve };
}

export { imageObjectUrl, useImageUrls };
