/* 拾穗集 —— 手机 App 配对（电脑地址 + 口令）
 * M2 只做手输；配对 JSON / 扫码在 M4 复用 normalizePairBase + applyPair。
 * 校验失败只报错，绝不半写配置。
 */

import { setServerBase, setToken, getServerBase, getToken, joinApiUrl, withTimeout, HEALTH_TIMEOUT_MS } from './api.js';

/** host:port（可含主机名 / IPv6）——注意不能把 localhost:8642 当成自定义 scheme */
const HOST_PORT_RE = /^(?:localhost|\[[0-9a-fA-F:]+\]|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*):\d{1,5}$/i;

/** 校验并规范化电脑基址；非法返回 '' */
function normalizePairBase(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  s = s.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(s)) {
    // 已是 http(s)
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    // 形如 scheme:…——只放行 host:port 裸写（localhost:8642），其余（javascript:、ftp://）拒绝
    if (!HOST_PORT_RE.test(s)) return '';
    s = 'http://' + s;
  } else {
    s = 'http://' + s.replace(/^\/+/, '');
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  // 只要 origin（协议 + 主机 + 端口），丢掉误粘的路径
  return u.origin;
}

/** 写入配对；base 非法时不写任何东西 */
function applyPair({ base, token } = {}) {
  const b = normalizePairBase(base);
  if (!b) return { ok: false, error: '电脑地址不合法，应如 http://192.168.1.5:8642' };
  setServerBase(b);
  setToken(token);
  return { ok: true, base: b };
}

function clearPair() {
  setServerBase('');
  setToken('');
  return true;
}

function isPaired() {
  return !!getServerBase();
}

/** 连通测试：GET {base}/api/health，可带口令 */
async function testPair(base, token) {
  const b = normalizePairBase(base);
  if (!b) {
    return { ok: false, status: 0, data: { error: '电脑地址不合法' } };
  }
  const headers = {};
  const t = String(token || '').trim();
  if (t) headers['X-Danji-Token'] = t;
  try {
    const res = await withTimeout(fetch(joinApiUrl('/api/health', b), { headers }), HEALTH_TIMEOUT_MS);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: (err && err.message) || '连不上电脑服务' } };
  }
}

export { normalizePairBase, applyPair, clearPair, isPaired, testPair };
