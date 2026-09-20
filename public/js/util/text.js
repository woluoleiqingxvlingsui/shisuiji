/* 拾穗集 —— 平台配色与网址归一化
 * 从 app.js 原样搬过来的纯函数，逻辑一字未改。
 */

function platformHue(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
function platformStyle(name) {
  return { '--h': String(platformHue(name || '其他')) };
}
function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return '';
  return 'https://' + s.replace(/^\/+/, '');
}

export { platformHue, platformStyle, normalizeUrl };
