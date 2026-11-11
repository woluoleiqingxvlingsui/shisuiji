#!/usr/bin/env node
/**
 * 拾穗集 —— 发布前自检
 *
 * 回答一个问题：「现在把仓库推到公开的 GitHub，会不会泄露隐私 / 会不会发出去就翻车？」
 * 全程只读：不写文件、不改配置、不动 git 索引、不推送任何东西。
 *
 * 覆盖的检查：
 *   1. 敏感文件是否被 git 跟踪（config.json / data/ / papers/ / 证书 / 签名材料…）
 *   2. 这些敏感文件是否真的被 .gitignore 规则挡住
 *   3. 跟踪文件里是否混入本机绝对路径、密钥、token、手机号
 *   4. 提交邮箱是否泄露真实邮箱（应统一用 noreply）
 *   5. git 历史里是否曾经提交过敏感文件（曾经提交过 = 删了也还在历史里）
 *   6. 四处版本号是否一致，CHANGELOG 是否与版本号对齐
 *   7. 本地 tag 是否覆盖当前版本，远端是否可连
 *
 * 用法：
 *   node tools/preflight.mjs            # 全量检查
 *   node tools/preflight.mjs --no-remote # 不访问网络（离线用）
 * 退出码：0 = 全部通过（可能有 WARN）；1 = 有 FAIL，必须先修
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectAndroidVersion } from './release-version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NO_REMOTE = process.argv.includes('--no-remote');

let failCount = 0;
let warnCount = 0;

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function ok(msg) { console.log(`  ${C.green('✓')} ${msg}`); }
function warn(msg) { warnCount++; console.log(`  ${C.yellow('!')} ${msg}`); }
function fail(msg) { failCount++; console.log(`  ${C.red('✗')} ${msg}`); }
function section(title) { console.log(`\n${C.bold(title)}`); }

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (allowFail) return '';
    throw err;
  }
}

function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

// 跟踪文件里不该出现的敏感文件名（不区分大小写）
const SENSITIVE_PATTERNS = [
  { re: /^config\.json$/i, why: '本机配置（含 sync.token 局域网口令）' },
  { re: /^local\.env\.ps1$/i, why: '本机环境变量备份' },
  { re: /^data\//i, why: '个人数据（各板块 JSON + 随记贴图原图）' },
  { re: /^papers\//i, why: '文献库 PDF 原件' },
  { re: /^backups\//i, why: '备份产物（data/ 的副本）' },
  { re: /\.pem$/i, why: 'TLS 证书/私钥' },
  { re: /\.pem\.bak$/i, why: 'TLS 证书备份' },
  { re: /\.keystore$/i, why: 'Android 签名密钥' },
  { re: /\.jks$/i, why: 'Android 签名密钥' },
  { re: /keystore\.properties$/i, why: 'Android 签名口令' },
  { re: /(?:^|\/)local\.properties$/i, why: 'Android SDK 绝对路径' },
  { re: /^runtime-options\.json$/i, why: '本机启动偏好' },
  { re: /\.(?:p12|pfx|key)$/i, why: '证书或签名密钥' },
  { re: /^\.env$/i, why: '环境变量（可能含密钥）' },
  { re: /^\.env\.(?!example)/i, why: '环境变量（可能含密钥）' },
];

// 跟踪文件内容里不该出现的模式
const CONTENT_PATTERNS = [
  { re: /[A-Za-z]:\\Users\\[^\\\s"']+/g, why: '本机用户目录绝对路径' },
  { re: /sk-[A-Za-z0-9_-]{16,}/g, why: '疑似 API 密钥（sk- 前缀）' },
  { re: /AKIA[0-9A-Z]{16}/g, why: '疑似 AWS Access Key' },
  { re: /ghp_[A-Za-z0-9]{20,}/g, why: '疑似 GitHub Personal Access Token' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, why: '疑似 Slack Token' },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, why: '私钥内容' },
];

// 已知不是隐私的用户名占位符：CI runner（RUNNER~1 是 GitHub Actions 的 8.3 短名，
// ADMINISTRATOR 是 CI 容器默认账户）、系统内置账户。命中这些不算泄露。
const BENIGN_USER_NAMES = /^(RUNNER~?\d*|runner|ADMINISTRATOR|Administrator|SYSTEM|system|Default|default|PUBLIC|user|Users|Temp|本地|当前用户)$/;

/**
 * 从命中结果里剔除明显无害的：
 *  - 用户名是 CI / 系统占位符
 *  - 出现在注释行里（示例路径，如 lib.ps1 里讲 8.3 短名的 Windows CI runner）
 */
function isBenignPathHit(rel, matchText) {
  const userMatch = /[A-Za-z]:\\Users\\([^\\\s"']+)/.exec(matchText);
  if (userMatch && BENIGN_USER_NAMES.test(userMatch[1])) return true;
  return false;
}

// 二进制/大文件不扫内容
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|jar|keystore|jks|zip|apk|aab|pdf|woff2?|ttf|so|dll|exe)$/i;

function isProbablyBinary(rel) {
  if (BINARY_EXT.test(rel)) return true;
  try {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    const probe = buf.subarray(0, 4096);
    // 有 NUL 字节视为二进制
    if (probe.includes(0)) return true;
  } catch { return true; }
  return false;
}

console.log(C.bold('拾穗集 发布前自检（只读，不改任何文件）'));
console.log(C.dim(`仓库：${ROOT}`));

// ---------- 1. 敏感文件是否被跟踪 ----------
section('1. 敏感文件是否被 git 跟踪');
let tracked = [];
try {
  tracked = git(['ls-files']).split('\n').filter(Boolean);
} catch {
  fail('不是 git 仓库，或 git 命令不可用');
  console.log('\n' + C.red('自检无法进行。'));
  process.exit(1);
}
ok(`被跟踪文件 ${tracked.length} 个`);
// 新增发布文件尚未进入 Git 索引时，也必须检查明确的发布清单。
const manifestPath = path.join(ROOT, 'release-files.json');
if (fs.existsSync(manifestPath)) {
  const manifest = readJson('release-files.json');
  if (!manifest || !Array.isArray(manifest.extraSourceFiles)) fail('发布清单无法读取');
  else {
    for (const rel of manifest.extraSourceFiles) {
      if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.includes('\\') || rel.split('/').includes('..')) {
        fail('发布清单包含非法路径'); continue;
      }
      if (!fs.existsSync(path.join(ROOT, rel))) fail(`发布清单中的文件缺失：${rel}`);
      if (!tracked.includes(rel)) tracked.push(rel);
    }
  }
}

const leaked = [];
// Windows PowerShell 5.1 needs UTF-8 BOM for Chinese scripts; a second BOM
// becomes executable content and can prevent the leading param() from working.
for (const rel of tracked.filter((name) => name.endsWith('.ps1'))) {
  if (!fs.existsSync(path.join(ROOT, rel))) continue;
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (source.startsWith('\uFEFF\uFEFF')) fail(`${rel} 有重复 UTF-8 BOM，参数可能失效`);
}
for (const rel of tracked) {
  for (const p of SENSITIVE_PATTERNS) {
    if (p.re.test(rel)) { leaked.push({ rel, why: p.why }); break; }
  }
}
if (leaked.length) {
  for (const l of leaked) fail(`${l.rel} —— ${l.why}`);
} else {
  ok('没有敏感文件进入版本库');
}

// ---------- 2. 敏感文件是否被 ignore 挡住 ----------
section('2. 本机敏感文件是否被 .gitignore 挡住');
const probeFiles = [
  'config.json', 'local.env.ps1',
  'data/ideas.json', 'data/images', 'papers',
  'backups/backup-test', 'danji-cert.pem', 'danji-key.pem',
  'app/android/keystore.properties', 'app/android/local.properties',
  'app/android/danji-release.keystore', '.env',
];
let ignoredAll = true;
for (const p of probeFiles) {
  const r = git(['check-ignore', '-v', '--', p], { allowFail: true });
  if (!r) {
    // 文件不存在时 check-ignore 仍可判断规则；但规则缺失要靠 patterns 兜底
    const rules = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    if (!rules.includes(p.replace(/^app\/android\//, '').replace(/^data\/.*/, 'data/'))) {
      ignoredAll = false;
      fail(`${p} 没有被任何 ignore 规则覆盖`);
    }
  }
}
if (ignoredAll) ok('全部敏感路径都有 ignore 规则覆盖');

// ---------- 3. 跟踪文件内容里的隐私 ----------
section('3. 跟踪文件内容里的隐私线索');
let hits = 0;
for (const rel of tracked) {
  if (isProbablyBinary(rel)) continue;
  let text;
  try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
  for (const p of CONTENT_PATTERNS) {
    const found = text.match(p.re);
    if (found) {
      const real = found.filter((m) => !isBenignPathHit(rel, m));
      if (!real.length) continue;
      const uniq = [...new Set(real)].slice(0, 3);
      fail(`${rel} 含${p.why}：${uniq.join(' / ')}`);
      hits++;
    }
  }
  // 手机号（中国大陆 11 位）——排除注释里的时间戳等误报
  const phones = text.match(/(?<![0-9])1[3-9][0-9]{9}(?![0-9])/g);
  if (phones) {
    const uniq = [...new Set(phones)].slice(0, 3);
    fail(`${rel} 含疑似手机号：${uniq.join(' / ')}`);
    hits++;
  }
}
if (!hits) ok('跟踪文件里没有绝对路径 / 密钥 / 手机号');

// ---------- 4. 提交邮箱 ----------
section('4. 提交者邮箱');
const emails = [...new Set(
  git(['log', '--all', '--format=%ae|%ce']).split('\n').filter(Boolean)
    .flatMap((l) => l.split('|'))
    .map((e) => e.trim())
    .filter(Boolean),
)];
if (!emails.length) {
  warn('没有历史提交，跳过');
} else {
  const leaky = emails.filter((e) => !/@users\.noreply\.github\.com$/i.test(e));
  if (leaky.length) {
    for (const e of leaky) fail(`提交邮箱不是 noreply：${e}（会永久公开真实邮箱）`);
  } else {
    ok(`全部 ${emails.length} 个邮箱均为 noreply：${emails.join(', ')}`);
  }
}

// ---------- 5. 历史里的敏感文件 ----------
section('5. git 历史里的敏感文件');
const histFiles = [...new Set(
  git(['log', '--all', '--pretty=format:', '--name-only']).split('\n').filter(Boolean),
)];
const histLeak = histFiles.filter((rel) =>
  SENSITIVE_PATTERNS.some((p) => p.re.test(rel)));
if (histLeak.length) {
  // 曾经提交过不等于泄露过：逐个文件看它在历史里的最后内容，
  // 只有当内容里真的带着口令/绝对路径/密钥时才判定为泄露。
  // 注意要匹配「值」而不是字段名：papers_dir 这个键本身无害，
  // 有害的是 papers_dir 指向本机绝对路径（形如 C:\... 或 /home/...）。
  const REAL_LEAK = [
    /"sync"\s*:\s*\{[^}]*"token"\s*:\s*"[^"\s][^"]*"/i, // 非空 token 值
    /"papers_dir"\s*:\s*"[A-Za-z]:\\/i,                      // 指向盘符绝对路径
    /"papers_dir"\s*:\s*"\/[^"\s]/i,                        // 指向 POSIX 绝对路径
    /"token"\s*:\s*"[A-Za-z0-9]{16,}"/i,                    // 独立长 token
    /-----BEGIN/,                                          // 私钥
    /sk-[A-Za-z0-9_-]{16,}/,                               // API 密钥
    /DANJI_TOKEN\s*=\s*\S/i,                               // 环境变量里写死口令
  ];
  for (const rel of histLeak) {
    let verdict = null;
    // 取这个文件在历史中的最后一次存在（删除它的那次提交之前）
    const commits = git(['log', '--all', '--pretty=format:%H', '--', rel], { allowFail: true })
      .split('\n').filter(Boolean);
    for (const c of commits) {
      const content = git(['show', `${c}:${rel}`], { allowFail: true });
      if (!content) continue;
      if (REAL_LEAK.some((re) => re.test(content))) { verdict = 'bad'; break; }
      verdict = 'clean';
    }
    if (verdict === 'bad') {
      fail(`历史上 ${rel} 曾含真实敏感内容 —— 已删文件不等于从历史消失，需要改写历史`);
    } else {
      warn(`历史上出现过 ${rel}，但已核对其内容为示例/空值（无口令、无绝对路径），无需改写历史`);
    }
  }
} else {
  ok('历史中没有敏感文件');
}

// ---------- 6. 版本一致性 ----------
section('6. 版本号与 CHANGELOG');
const rootPkg = readJson('package.json');
const rootLock = readJson('package-lock.json');
const appPkg = readJson('app/package.json');
const appLock = readJson('app/package-lock.json');
if (!rootPkg || !rootLock || !appPkg || !appLock) {
  fail('读不到某个 package.json / package-lock.json');
} else {
  const versions = {
    'package.json': rootPkg.version,
    'package-lock.json': rootLock.version,
    'package-lock.json packages[""]': rootLock.packages?.['']?.version,
    'app/package.json': appPkg.version,
    'app/package-lock.json': appLock.version,
    'app/package-lock.json packages[""]': appLock.packages?.['']?.version,
  };
  const uniq = [...new Set(Object.values(versions))];
  if (uniq.length === 1 && typeof uniq[0] === 'string' && uniq[0]) {
    ok(`六处版本号一致：${uniq[0]}`);
  } else {
    for (const [k, v] of Object.entries(versions)) {
      if (v !== uniq[0]) fail(`${k} = ${v}，与其他处不一致`);
    }
  }
  try {
    const android = inspectAndroidVersion(ROOT);
    ok(`Android 构建与根版本一致：${android.name} / versionCode ${android.code}`);
  } catch (err) {
    fail(err.message);
  }
  // CHANGELOG 是否包含当前版本
  let changelog = '';
  try { changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'); } catch { /* ignore */ }
  if (!changelog) {
    warn('找不到 CHANGELOG.md');
  } else if (changelog.includes(`[${rootPkg.version}]`)) {
    ok(`CHANGELOG 已有 [${rootPkg.version}] 段`);
  } else {
    fail(`CHANGELOG 里没有 [${rootPkg.version}] 段（Unreleased 未定版？）`);
  }
}

// ---------- 7. tag 与远端 ----------
section('7. tag 与远端');
const tags = git(['tag', '-l']).split('\n').filter(Boolean);
if (!tags.length) {
  warn('本地没有任何 tag');
} else {
  ok(`本地 tag：${tags.join(', ')}`);
}
const ver = rootPkg?.version;
if (ver && !tags.includes(`v${ver}`)) {
  warn(`本地没有 v${ver} tag（发布前应打）`);
} else if (ver) {
  ok(`v${ver} tag 已存在`);
}
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
const ahead = git(['rev-list', '--count', `origin/${branch}..HEAD`], { allowFail: true });
if (ahead) {
  const behind = git(['rev-list', '--count', `HEAD..origin/${branch}`], { allowFail: true });
  ok(`本地比 origin/${branch} 领先 ${ahead} 个提交${behind ? `，落后 ${behind} 个` : ''}`);
}
if (NO_REMOTE) {
  warn('--no-remote：跳过远端连通性检查');
} else {
  const remote = git(['remote', 'get-url', 'origin'], { allowFail: true });
  if (!remote) {
    warn('没有配置 origin 远端');
  } else {
    const probe = git(['ls-remote', '--heads', 'origin'], { allowFail: true });
    if (probe) {
      ok('远端可访问');
      const remoteBranches = probe.split('\n').map((l) => l.split(/\s+/)[1]).filter(Boolean);
      for (const b of remoteBranches) {
        const name = b.replace('refs/heads/', '');
        const localSha = git(['rev-parse', `refs/heads/${name}`], { allowFail: true });
        const remoteSha = probe.split('\n').find((l) => l.endsWith(b))?.split(/\s+/)[0];
        if (localSha && remoteSha && localSha !== remoteSha) {
          warn(`${name} 与远端不一致：本地 ${localSha.slice(0, 7)} / 远端 ${remoteSha.slice(0, 7)}`);
        }
      }
    } else {
      warn('远端不可访问（网络不通或需鉴权）—— 推送前请确认网络');
    }
  }
}

// ---------- 汇总 ----------
console.log('\n' + C.bold('汇总'));
if (failCount) {
  console.log(`  ${C.red('FAIL ' + failCount)} 项必须修复后才能发到公开仓库`);
  console.log(`  ${C.yellow('WARN ' + warnCount)} 项建议确认`);
  process.exit(1);
}
console.log(`  ${C.green('PASS')} 未发现隐私泄露风险${warnCount ? `（另有 ${C.yellow(warnCount)} 项 WARN 待确认）` : ''}`);
process.exit(0);
