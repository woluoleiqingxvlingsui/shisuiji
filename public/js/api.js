/* 拾穗集 —— 统一 API 客户端
 * 所有前端请求都走这里：局域网手机端自动带上 X-Danji-Token，
 * 电脑端本地通常没有口令，行为与直接 fetch 一致。
 * Capacitor 原生壳可配置 serverBase，把 /api/... 拼到电脑服务地址；
 * 未配置时保持相对路径（网页行为不变）。
 */

const TOKEN_KEY = 'danji.syncToken';
const SERVER_BASE_KEY = 'danji.serverBase';

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

function setToken(token) {
  const t = String(token || '').trim();
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* 隐私模式等场景忽略 */ }
  return t;
}

/** 规范化基址：trim + 去掉尾部斜杠；空/非法一律空串 */
function normalizeServerBase(base) {
  return String(base || '').trim().replace(/\/+$/, '');
}

function getServerBase() {
  try { return normalizeServerBase(localStorage.getItem(SERVER_BASE_KEY)); } catch { return ''; }
}

/** 写入基址；传空表示清除，回到相对路径。返回规范化后的值 */
function setServerBase(base) {
  const t = normalizeServerBase(base);
  try {
    if (t) localStorage.setItem(SERVER_BASE_KEY, t);
    else localStorage.removeItem(SERVER_BASE_KEY);
  } catch { /* 隐私模式等场景忽略 */ }
  return t;
}

/** 纯拼接：无 base 时原样返回 path，便于网页零变化 */
function joinApiUrl(path, base) {
  const b = normalizeServerBase(base);
  return b ? b + path : path;
}

function resolveApiUrl(path) {
  return joinApiUrl(path, getServerBase());
}

const DEFAULT_TIMEOUT_MS = 12000;
const HEALTH_TIMEOUT_MS = 4000;

/** 超时控制：Promise.race + 定时器；超时抛 TimeoutError（不中断底层 fetch） */
function withTimeout(promise, timeoutMs) {
  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`timeout after ${ms}ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 带可选口令头的 fetch 封装（默认 12s 超时） */
async function api(path, init = {}) {
  const { timeoutMs, ...rest } = init;
  const headers = { ...(rest.headers || {}) };
  const token = getToken();
  if (token && !headers['X-Danji-Token'] && !headers['x-danji-token']) {
    headers['X-Danji-Token'] = token;
  }
  if (rest.body != null && typeof rest.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  return withTimeout(fetch(resolveApiUrl(path), { ...rest, headers }), timeoutMs);
}

/** 读 JSON：统一返回 { ok, status, data, res }，网络层异常会 throw */
async function apiJson(path, init = {}) {
  const res = await api(path, init);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data, res };
}

export {
  TOKEN_KEY,
  SERVER_BASE_KEY,
  DEFAULT_TIMEOUT_MS,
  HEALTH_TIMEOUT_MS,
  getToken,
  setToken,
  normalizeServerBase,
  getServerBase,
  setServerBase,
  joinApiUrl,
  resolveApiUrl,
  withTimeout,
  api,
  apiJson,
};
