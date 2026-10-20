/**
 * 拾穗集 —— ESM 边界 + 依赖加载回归
 * 用法：node tools/test-esm-boundary.mjs
 *
 * 钉死的规则：
 *   1. public/ 下的 .js 全部是 ES module。Node 18 没有 Node 22+ 的
 *      「模块语法自动探测」，边界必须由 public/package.json 显式声明；
 *      少了它，tools/*.mjs 直接 import 前端 .js 会被当 CommonJS 解析 → SyntaxError。
 *   2. 仓库根仍然是 CommonJS（server.js 要能直接 node server.js 起），
 *      public/package.json 只标定 public/ 这一棵子树，不许外溢。
 *   3. 依赖真的被安装并加载：CI 干净检出必须先 npm ci，
 *      否则本文件会在「qrcode 解析不出来」这一条上失败。
 *
 * 断言全部落在行为上：真的起子进程 import、真的 require 依赖，
 * 不靠匹配源码字符串。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

let passed = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}${extra ? ` ${extra}` : ''}`);
    process.exitCode = 1;
  }
}

function warn(name, extra = '') {
  console.warn(`  ! ${name}${extra ? ` ${extra}` : ''}`);
}

/* 前端模块清单：跨目录取样，证明整棵 public/ 子树都在 ESM 边界内 */
const PUBLIC_MODULES = [
  { rel: 'public/js/api.js', expect: 'getServerBase' },
  { rel: 'public/js/util/money.js', expect: 'formatMoney' },
  { rel: 'public/js/sync/outbox.js', expect: 'enqueueOutbox' },
  { rel: 'public/js/util/const.js', expect: 'HOUR' },
];

/* 子进程脚本：真的 import 一次，导出名回传父进程 */
const CHILD = `const urls = process.argv.slice(2);
// 前端模块在浏览器里才有 window/localStorage，Node 下按仓库既有测试的惯例打桩
globalThis.window = globalThis.window || {};
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
const out = [];
for (const u of urls) {
  const m = await import(u);
  out.push([u, Object.keys(m).sort()]);
}
console.log(JSON.stringify(out));
`;

let childDir = null;
function childScriptPath() {
  if (!childDir) {
    childDir = fs.mkdtempSync(path.join(os.tmpdir(), 'danji-esm-child-'));
    fs.writeFileSync(path.join(childDir, 'child.mjs'), CHILD, 'utf8');
  }
  return path.join(childDir, 'child.mjs');
}

/** 起子进程 import 一组 public 模块；返回 { status, out, err, names } */
function importPublicModules(flags = []) {
  const urls = PUBLIC_MODULES.map((m) => pathToFileURL(path.join(REPO, ...m.rel.split('/'))).href);
  const res = spawnSync(process.execPath, [...flags, childScriptPath(), ...urls], {
    cwd: REPO,
    encoding: 'utf8',
  });
  let names = null;
  if (res.status === 0 && res.stdout) {
    try {
      names = JSON.parse(res.stdout.trim().split('\n').pop());
    } catch { names = null; }
  }
  return { status: res.status, out: res.stdout || '', err: res.stderr || '', names };
}

/**
 * 找一个能把当前 Node 变成「Node 18 语义」的开关：
 *   --no-experimental-detect-module   Node 22.7+/23+/24：关掉语法自动探测
 *   --experimental-default-type=commonjs  Node 18.19+/20.10+：.js 默认按 CommonJS
 * 两者都不可用时返回 null（本条检查跳过，不算通过也不算失败）。
 */
function detectNode18SemanticsFlag() {
  const candidates = [
    ['--no-experimental-detect-module'],
    ['--experimental-default-type=commonjs'],
  ];
  for (const flags of candidates) {
    const probe = spawnSync(process.execPath, [...flags, '-e', '0'], { encoding: 'utf8' });
    if (probe.status === 0) return flags;
  }
  return null;
}

try {
  /* ---------- 1. 边界声明存在 ---------- */
  const pkgFile = path.join(REPO, 'public', 'package.json');
  let boundaryType = null;
  if (fs.existsSync(pkgFile)) {
    try {
      boundaryType = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).type || null;
    } catch (err) {
      ok('public/package.json 可解析', false, String(err));
    }
  }
  ok('public/package.json 声明 type=module（ESM 边界）', boundaryType === 'module', `type=${boundaryType}`);

  /* ---------- 2. 前端模块真的能被 import ---------- */
  const plain = importPublicModules();
  ok('public/ 下的 .js 能被真正 import 成功', plain.status === 0,
    `exit=${plain.status} ${(plain.err || plain.out).trim().split('\n').slice(0, 3).join(' | ')}`);
  if (plain.status === 0) {
    for (const mod of PUBLIC_MODULES) {
      const entry = (plain.names || []).find(([u]) => u.endsWith(mod.rel.split('/').join('/')));
      const keys = entry ? entry[1] : [];
      ok(`${mod.rel} 导出 ${mod.expect}`, keys.includes(mod.expect), `exports=${keys.join(',')}`);
    }
  }

  /* ---------- 3. 关掉语法自动探测（= Node 18 语义）仍能 import ---------- */
  const flag = detectNode18SemanticsFlag();
  if (!flag) {
    warn('本 Node 不支持关闭语法自动探测，跳过「Node 18 语义」检查');
  } else {
    const strict = importPublicModules(flag);
    ok(`Node 18 语义下（${flag[0]}）public/ 仍按 ESM 加载`, strict.status === 0,
      `exit=${strict.status} ${(strict.err || strict.out).trim().split('\n').slice(0, 3).join(' | ')}`);
    if (strict.status === 0) {
      for (const mod of PUBLIC_MODULES) {
        const entry = (strict.names || []).find(([u]) => u.endsWith(mod.rel.split('/').join('/')));
        const keys = entry ? entry[1] : [];
        ok(`Node 18 语义下 ${mod.rel} 导出 ${mod.expect}`, keys.includes(mod.expect), `exports=${keys.join(',')}`);
      }
    }
  }

  /* ---------- 4. 仓库根仍是 CommonJS（server.js 启动路径没被带歪） ---------- */
  const cjs = spawnSync(process.execPath, ['-e',
    "const m = require('./lib/sync-debounce.js'); if (!m || m.SYNC_DEBOUNCE_MS === undefined) { throw new Error('bad cjs export'); } console.log('cjs-ok');"],
    { cwd: REPO, encoding: 'utf8' });
  ok('仓库根仍按 CommonJS 解析（require 根目录 .js 可用）', cjs.status === 0 && cjs.stdout.includes('cjs-ok'),
    `exit=${cjs.status} ${(cjs.err || '').trim().split('\n').slice(0, 3).join(' | ')}`);

  /* ---------- 5. 依赖真的被安装并加载 ---------- */
  let qrcodePath = null;
  try {
    qrcodePath = require.resolve('qrcode', { paths: [REPO] });
  } catch (err) {
    ok('qrcode 依赖已安装（仓库根 node_modules）', false,
      `${String(err)} —— CI 干净检出必须先在仓库根执行 npm ci`);
  }
  if (qrcodePath) {
    ok('qrcode 依赖已安装（仓库根 node_modules）', true);
    const { loadQrcode } = await import('./qrcode-loader.mjs');
    let qr = null;
    let loadErr = '';
    try { qr = loadQrcode(); } catch (err) { loadErr = String(err); }
    ok('qrcode 真的能被加载（toString/toFile 可用）',
      !!qr && typeof qr.toString === 'function' && typeof qr.toFile === 'function', loadErr);
  }
} catch (err) {
  if (!process.exitCode) {
    console.error(err);
    process.exitCode = 1;
  }
} finally {
  if (childDir) fs.rmSync(childDir, { recursive: true, force: true });
}

if (process.exitCode) {
  console.error('\n✗ ESM 边界回归失败');
} else {
  console.log(`\n✓ ESM 边界回归全部通过（${passed} 项）`);
}
