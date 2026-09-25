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

/**
 * 明文收紧（M5）：http 明文只允许连私网 / 回环 / 单标签与 .local 等局域网主机名；
 * 公网地址必须走 https。https 一律放行（自签证书连不上会由 testPair 报错）。
 */
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  if (/^127\./.test(h)) return true;                       // 回环
  if (/^10\./.test(h)) return true;                         // 10/8
  if (/^192\.168\./.test(h)) return true;                   // 192.168/16
  if (/^169\.254\./.test(h)) return true;                   // link-local
  const m = h.match(/^172\.(\d{1,3})\./);                   // 172.16/12
  if (m) {
    const o = Number(m[1]);
    if (o >= 16 && o <= 31) return true;
  }
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return true;          // IPv6 ULA
  if (/^fe80:/.test(h)) return true;                        // IPv6 link-local
  if (!h.includes('.')) return true;                        // 单标签主机名（局域网 NetBIOS 等）
  return /\.(local|lan|internal|home|fritz\.box)$/i.test(h); // 常见局域网域名后缀
}

/** http 明文基址是否指向私网；https 恒真 */
function isAllowedPairBase(base) {
  let u;
  try {
    u = new URL(base);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  return isPrivateHost(u.hostname);
}

/** 写入配对；base 非法或 http 指向公网时不写任何东西 */
function applyPair({ base, token } = {}) {
  const b = normalizePairBase(base);
  if (!b) return { ok: false, error: '电脑地址不合法，应如 http://192.168.1.5:8642' };
  if (!isAllowedPairBase(b)) {
    return { ok: false, error: 'HTTP 明文只允许连局域网私网地址（如 192.168.x.x / 10.x.x.x）；公网请使用 https://' };
  }
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

/**
 * 解析配对载荷（扫码 / 粘贴同一入口）。
 * 形如 {"v":1,"base":"http://192.168.1.5:8642","token":"..."}
 * 失败只报错，不写配置。
 */
function parsePairPayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: '内容为空' };
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, error: '不是合法 JSON 配对码' };
  }
  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: '配对码格式不正确' };
  }
  if (obj.v !== 1) {
    return { ok: false, error: '配对码版本不支持（需要 v:1）' };
  }
  const base = normalizePairBase(obj.base);
  if (!base) {
    return { ok: false, error: '配对码里的电脑地址不合法' };
  }
  if (!isAllowedPairBase(base)) {
    return { ok: false, error: '配对码是公网 HTTP 地址，出于安全不接受；请在同一局域网用 http://192.168.x.x 出码' };
  }
  const token = String(obj.token == null ? '' : obj.token).trim();
  return { ok: true, base, token, payload: { v: 1, base, token } };
}

export { normalizePairBase, isPrivateHost, isAllowedPairBase, applyPair, clearPair, isPaired, testPair, parsePairPayload };
