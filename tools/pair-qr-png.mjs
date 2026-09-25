/**
 * 拾穗集 —— 配对二维码出图（PNG）
 * 供图形控制台 control-ui.ps1 调用：把配对载荷渲染成 PNG 文件，窗口里直接显示可扫。
 * 用法（仓库根目录）：
 *   node tools/pair-qr-png.mjs --base http://192.168.1.5:8642 --token SECRET --out C:\path\qr.png
 * 依赖 qrcode（npm install）。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const out = { base: '', token: '', file: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = String(argv[++i] || '').trim();
    else if (a === '--token') out.token = String(argv[++i] || '').trim();
    else if (a === '--out') out.file = String(argv[++i] || '').trim();
  }
  if (!out.base && process.env.DANJI_BASE) out.base = String(process.env.DANJI_BASE).trim();
  if (!out.token && process.env.DANJI_TOKEN) out.token = String(process.env.DANJI_TOKEN).trim();
  return out;
}

async function main() {
  const { base, token, file } = parseArgs(process.argv.slice(2));
  if (!base) {
    console.error('缺少 --base，例如 --base http://192.168.1.5:8642');
    process.exit(1);
  }
  if (!file) {
    console.error('缺少 --out，指定 PNG 输出路径');
    process.exit(1);
  }
  let QRCode;
  try {
    QRCode = require('qrcode');
  } catch {
    console.error('找不到 qrcode，请先在仓库根目录执行：npm install');
    process.exit(1);
  }

  const payload = JSON.stringify({ v: 1, base, token });
  await QRCode.toFile(file, payload, {
    errorCorrectionLevel: 'M',
    width: 480,
    margin: 2,
    color: { dark: '#17191F', light: '#FFFFFF' },
  });
  // 只回显成功标记与路径，PowerShell 据此加载图片
  console.log(file);
}

main().catch((err) => {
  console.error('生成二维码失败：' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
