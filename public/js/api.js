/* 拾穗集 —— 统一 API 客户端
 * 所有前端请求都走这里：局域网手机端自动带上 X-Danji-Token，
 * 电脑端本地通常没有口令，行为与直接 fetch 一致。
 */

const TOKEN_KEY = 'danji.syncToken';

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

/** 带可选口令头的 fetch 封装 */
async function api(path, init = {}) {
  const headers = { ...(init.headers || {}) };
  const token = getToken();
  if (token && !headers['X-Danji-Token'] && !headers['x-danji-token']) {
    headers['X-Danji-Token'] = token;
  }
  if (init.body != null && typeof init.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(path, { ...init, headers });
}

/** 读 JSON：统一返回 { ok, status, data, res }，网络层异常会 throw */
async function apiJson(path, init = {}) {
  const res = await api(path, init);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data, res };
}

export { TOKEN_KEY, getToken, setToken, api, apiJson };
