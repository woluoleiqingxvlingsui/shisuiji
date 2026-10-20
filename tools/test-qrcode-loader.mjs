/**
 * 拾穗集 —— qrcode 依赖加载回归（Node）
 * 用法：node tools/test-qrcode-loader.mjs
 *
 * 钉死的规则：
 *   1. 两条配对码路径（print-pair-qr / pair-qr-png）共用同一个加载器，
 *      仓库根 node_modules 优先、app/node_modules 回落——按 README
 *      「在仓库根目录执行 npm install」装依赖时两条路径都必须能工作；
 *   2. 都装不上时，错误提示与 README 描述一致。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveQrcodePath, loadQrcode, QRCODE_MISSING_ERROR } from './qrcode-loader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

let passed = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name} ${extra}`);
    process.exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'danji-qrcode-loader-'));

/** 造一个最小 qrcode 桩包（加载器只 require 路径，不关心包内容） */
function stubPackage(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'qrcode', main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = { toString: async () => "", toFile: async () => {} };');
}

try {
  /* ---------- 1. 真实仓库：加载成功 ---------- */
  const QRCode = loadQrcode();
  ok('真实仓库能加载 qrcode', typeof QRCode.toString === 'function' && typeof QRCode.toFile === 'function');

  /* ---------- 2. 只有根目录装了（README 的标准装法） ---------- */
  const rootOnly = path.join(tmp, 'root-only');
  stubPackage(path.join(rootOnly, 'node_modules', 'qrcode'));
  const hitRoot = resolveQrcodePath(rootOnly);
  ok('根目录优先命中', hitRoot === path.join(rootOnly, 'node_modules', 'qrcode'), String(hitRoot));

  /* ---------- 3. 只有 app 目录装了（回落路径，print-pair-qr 以前唯一认这个） ---------- */
  const appOnly = path.join(tmp, 'app-only');
  stubPackage(path.join(appOnly, 'app', 'node_modules', 'qrcode'));
  const hitApp = resolveQrcodePath(appOnly);
  ok('app 目录回落命中', hitApp === path.join(appOnly, 'app', 'node_modules', 'qrcode'), String(hitApp));

  /* ---------- 4. 两处都没有 ---------- */
  const none = path.join(tmp, 'none');
  fs.mkdirSync(none, { recursive: true });
  ok('都没有时返回 null', resolveQrcodePath(none) === null);
  ok('错误提示与 README 一致（仓库根目录 npm install）',
    QRCODE_MISSING_ERROR.includes('npm install') && QRCODE_MISSING_ERROR.includes('仓库根目录'),
    QRCODE_MISSING_ERROR);

  /* ---------- 5. 两条 CLI 路径端到端可跑 ---------- */
  const runCli = (script, args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, script), ...args],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
  const ascii = await runCli('print-pair-qr.mjs', ['--base', 'http://192.168.1.5:8642', '--token', 'SECRET']);
  ok('print-pair-qr.mjs 终端二维码可跑通', ascii.code === 0 && ascii.out.includes('192.168.1.5:8642'),
    `exit=${ascii.code} ${ascii.out.slice(0, 200)}`);
  const pngPath = path.join(tmp, 'pair-qr.png');
  const png = await runCli('pair-qr-png.mjs', ['--base', 'http://192.168.1.5:8642', '--token', 'SECRET', '--out', pngPath]);
  ok('pair-qr-png.mjs 出图可跑通', png.code === 0 && fs.existsSync(pngPath) && fs.statSync(pngPath).size > 500,
    `exit=${png.code}`);
} catch (err) {
  if (!process.exitCode) {
    console.error(err);
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}

if (process.exitCode) {
  console.error('\n✗ qrcode 加载回归失败');
} else {
  console.log(`\n✓ qrcode 加载回归全部通过（${passed} 项）`);
}
