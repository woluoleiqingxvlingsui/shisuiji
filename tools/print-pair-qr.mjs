/**
 * 拾穗集 —— 控制台配对码（终端二维码 + 纯文本 JSON）
 * 用法（仓库根目录）：
 *   node tools/print-pair-qr.mjs --base http://192.168.1.5:8642 --token SECRET
 *   node tools/print-pair-qr.mjs --base http://192.168.1.5:8642   # 口令可空
 * 依赖 qrcode：在仓库根目录执行一次 npm install 即可（见 README）。
 */
import { loadQrcode } from './qrcode-loader.mjs';

function parseArgs(argv) {
  const out = { base: '', token: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = String(argv[++i] || '').trim();
    else if (a === '--token') out.token = String(argv[++i] || '').trim();
  }
  if (!out.base && process.env.DANJI_BASE) out.base = String(process.env.DANJI_BASE).trim();
  if (!out.token && process.env.DANJI_TOKEN) out.token = String(process.env.DANJI_TOKEN).trim();
  return out;
}

async function main() {
  const { base, token } = parseArgs(process.argv.slice(2));
  if (!base) {
    console.error('缺少 --base，例如 --base http://192.168.1.5:8642');
    process.exit(1);
  }
  const QRCode = loadQrcode();

  const payload = JSON.stringify({ v: 1, base: base.replace(/\/+$/, ''), token: token || '' });
  const ascii = await QRCode.toString(payload, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
  console.log(ascii);
  console.log('----- 配对 JSON（扫码失败时可手工排查用） -----');
  console.log(payload);
  console.log('--------------------------------------');
  console.log('用「拾穗集」App 扫码配对。含口令，请勿截图外传。');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
