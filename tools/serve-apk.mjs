/**
 * 拾穗集 —— 临时局域网 APK 下载服务（用完即停，别长期开着）
 *
 * 为什么需要它：微信 / QQ 收到文件会自动改名（app-release.apk → app-release.apk.1），
 * 扩展名一坏，手机浏览器就当普通文本渲染，压根不给你下载安装。走 HTTP 下载可以
 * 精确控制 Content-Type 和 Content-Disposition，文件名和类型都原样落地。
 *
 * 刻意不放进 public/：那是要进 git 的目录，塞 27MB 二进制进去会污染仓库。
 * 也刻意不用 python -m http.server：它把 .apk 认成 application/octet-stream 之外的
 * 奇怪类型，且不带 Content-Disposition，部分手机浏览器会直接内联打开而不是下载。
 *
 * 用法：node tools/serve-apk.mjs [port]     默认 8899
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 8899;
const APK = path.resolve(HERE, '..', 'app', 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');

if (!fs.existsSync(APK)) {
  console.error(`[shisuiji] 找不到 APK：${APK}`);
  process.exit(1);
}

const SIZE = fs.statSync(APK).size;
const TYPE = 'application/vnd.android.package-archive';

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/**
 * 哈希按 mtime+size 缓存，而不是启动时算一次。
 * 之前启动时算死了：中途重打 APK 后，页面上显示的还是旧包的 SHA256，
 * 照着它校验反而会误判「文件坏了」。这里跟着文件走。
 */
let hashCache = { key: '', sha: '' };
function apkSha() {
  const st = fs.statSync(APK);
  const key = `${st.mtimeMs}:${st.size}`;
  if (hashCache.key !== key) {
    hashCache = { key, sha: crypto.createHash('sha256').update(fs.readFileSync(APK)).digest('hex').toUpperCase() };
  }
  return hashCache.sha;
}

http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/index')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8">
<title>拾穗集 APK 下载</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.7}
a{display:inline-block;background:#3b7;border-radius:10px;color:#fff;padding:.8rem 1.4rem;text-decoration:none;font-weight:600}
code{background:#eee;padding:.1rem .4rem;border-radius:4px}</style>
<h1>拾穗集 APK</h1>
<p>构建时间 ${new Date(fs.statSync(APK).mtime).toLocaleString('zh-CN')} · ${(SIZE / 1048576).toFixed(2)} MB</p>
<p><a href="/app-release.apk" download>下载 app-release.apk</a></p>
<p><b>装不上时按顺序试：</b></p>
<ol>
<li>点上面链接下载（文件名会是 app-release.apk，不会被微信改名）</li>
<li>用<b>文件管理</b>（不是浏览器）找到它 → 点安装 → 允许「安装未知应用」</li>
<li>若提示「与已安装应用签名不一致」，先卸载旧版再装（会丢本地数据）</li>
</ol>
<p>装完记得<b>重启电脑端服务</b>，否则后台同步还是旧逻辑。</p>
<p>SHA256：<code style="font-size:.75rem;word-break:break-all">${apkSha()}</code></p>`);
    return;
  }

  if (req.url.startsWith('/app-release.apk')) {
    const headers = {
      'Content-Type': TYPE,
      'Content-Length': SIZE,
      // 关键：告诉浏览器「这是附件，文件名就叫 app-release.apk」
      'Content-Disposition': 'attachment; filename="app-release.apk"',
      'Cache-Control': 'no-store',
    };
    const range = String(req.headers.range || '');
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : SIZE - 1;
      if (start >= SIZE || end >= SIZE || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${SIZE}` });
        return res.end();
      }
      res.writeHead(206, {
        ...headers,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${SIZE}`,
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(APK, { start, end }).pipe(res);
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    console.log(`[shisuiji] 已发送 APK → ${req.socket.remoteAddress}`);
    return fs.createReadStream(APK).pipe(res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}).listen(PORT, '0.0.0.0', () => {
  console.log('[shisuiji] APK 下载服务已启动（临时，用完请停）');
  console.log(`  文件：${APK}`);
  console.log(`  大小：${(SIZE / 1048576).toFixed(2)} MB`);
  for (const ip of lanIPs()) console.log(`  下载：http://${ip}:${PORT}/`);
  console.log(`  SHA256：${apkSha()}`);
  console.log('  提示：中途重打 APK 也不用重启本页，SHA256 会跟着文件自动更新');
});
