/**
 * 拾穗集 —— 前端语法检查
 *
 * 前端改成原生 ES module 之后，原来的 `node --check public/app.js` 会失效：
 * 它按文件扩展名把 .js 当 CommonJS 解析，遇到 import 直接 SyntaxError。
 *
 * 这里统一把每个文件按 ESM 检查。做法是拷成 .mjs 再 node --check ——
 * 扩展名判定在所有 Node 版本都成立，不依赖 Node 22+ 才有的 ESM 语法自动探测，
 * 也不用赌 CI 上老版本 Node 支不支持 stdin + --input-type=module。
 *
 * 用法：node tools/check-syntax.mjs
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
// vendor 是第三方构建产物，icons 不是脚本
const SKIP_DIRS = new Set(['vendor', 'icons']);

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const files = collect(PUBLIC_DIR).sort();
if (!files.length) {
  console.error('✗ public/ 下没找到要检查的 js 文件');
  process.exit(1);
}

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'danji-syntax-'));
const tmp = path.join(tmpDir, 'check.mjs');
let bad = 0;

try {
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    await fsp.writeFile(tmp, fs.readFileSync(file), 'utf8');
    const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    if (res.status === 0) {
      console.log(`  ✓ ${rel}`);
    } else {
      bad += 1;
      const detail = (res.stderr || '').trim().split('\n').slice(0, 6).join('\n        ');
      console.error(`  ✗ ${rel}\n        ${detail}`);
    }
  }
} finally {
  await fsp.rm(tmpDir, { recursive: true, force: true });
}

console.log(bad
  ? `\n✗ ${bad}/${files.length} 个文件有语法错误`
  : `\n✓ ${files.length} 个文件语法通过`);
process.exit(bad ? 1 : 0);
