/* 拾穗集 · 原页阅读进度 —— 配置弹窗 */
const CFG_KEY = 'danjiCfg';
const $ = (id) => document.getElementById(id);

function normBase(v) {
  const s = String(v || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : 'http://' + s;
}

// 地址必须是 http(s)://host[:port] 形态；纯 token 串/中文等一眼识别出来给明确提示
function baseProblem(raw) {
  const s = String(raw || '').trim();
  if (!s) return '请填写电脑端地址，形如 http://localhost:8642';
  if (!/^https?:\/\//i.test(s) && !/[./:]/.test(s)) {
    return '地址要形如 http://localhost:8642；口令（那串 token）填在下面一格，不是地址';
  }
  const b = normBase(s);
  try {
    const u = new URL(b);
    if (!u.hostname) return '地址缺少主机名，形如 http://localhost:8642';
    return '';
  } catch {
    return '地址不合法，形如 http://localhost:8642';
  }
}

chrome.storage.local.get(CFG_KEY, (o) => {
  const cfg = o[CFG_KEY] || {};
  $('base').value = cfg.base || 'http://localhost:8642';
  $('token').value = cfg.token || '';
  if (cfg && cfg.base) {
    $('msg').textContent = '当前生效：' + cfg.base + (cfg.token ? '（带口令）' : '（无口令）');
    $('msg').className = 'msg ok';
  }
});

function currentCfg() {
  return { base: normBase($('base').value), token: $('token').value.trim() };
}

function saveCfg(cfg, done) {
  chrome.storage.local.set({ [CFG_KEY]: cfg }, done);
}

$('save').addEventListener('click', () => {
  const bad = baseProblem($('base').value);
  if (bad) { $('msg').textContent = bad; $('msg').className = 'msg bad'; return; }
  saveCfg(currentCfg(), () => {
    $('msg').textContent = '已保存 ✅ 去原页阅读即可自动记进度';
    $('msg').className = 'msg ok';
  });
});

// 测试连接：直接用表单当前值（没点保存也能测），测通顺带保存，省一步
$('test').addEventListener('click', () => {
  const bad = baseProblem($('base').value);
  if (bad) { $('msg').textContent = bad; $('msg').className = 'msg bad'; return; }
  const cfg = currentCfg();
  $('msg').textContent = '连接中…';
  $('msg').className = 'msg';
  chrome.runtime.sendMessage({ type: 'ping', cfg }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      $('msg').textContent = '连不上：' + ((res && res.error) || chrome.runtime.lastError?.message || '未知错误')
        + '\n自查：电脑服务已启动？地址端口对？口令与 config.json 的 sync.token 一致？';
      $('msg').className = 'msg bad';
      return;
    }
    saveCfg(cfg, () => {
      $('msg').textContent = `连通 ✅ 已保存配置（${cfg.base}）· ${res.health.app} apiVersion=${res.health.apiVersion}`;
      $('msg').className = 'msg ok';
    });
  });
});
