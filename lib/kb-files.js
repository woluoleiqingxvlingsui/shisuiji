/**
 * 拾穗集 —— 知识库「关联本地文件」的后端纯逻辑
 *
 * 铁律（与需求一一对应）：
 *   1. 只保存**路径字符串**：不复制、不上传、不解析文件内容；
 *   2. 路径必须是本机绝对路径（Windows 盘符形式或 POSIX 绝对路径），
 *      拒绝 UNC / 设备路径 / NTFS 数据流 / 控制字符 / 相对路径 / 网址；
 *   3. 只做**格式**校验：文件暂时不在原位也允许先保存（状态另行查询）；
 *   4. 文件类型走固定白名单：可执行文件（exe/bat/cmd/ps1/js/lnk…）一律拒绝。
 *
 * 这个文件不依赖 server.js，可单测；打开文件用注入的 spawn，方便测试替换成记录桩。
 */
const fsp = require('fs/promises');

// 允许关联的文件类型（固定白名单，不接受扩展名之外的任何"类型推断"）
const ALLOWED_EXTENSIONS = new Set([
  // 文档
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt', 'md', 'csv', 'rtf', 'odt', 'epub',
  // 图片
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp',
  // 音视频
  'mp3', 'm4a', 'wav', 'mp4', 'mov', 'webm',
  // 压缩包
  'zip', '7z', 'rar', 'tar', 'gz',
]);

// 明确拒绝的可执行类型：给出更清楚的提示（白名单已经会拒，这里只是说人话）
const DENIED_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'com', 'scr', 'msi', 'msp', 'jar', 'app', 'lnk', 'url',
  'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'wsf', 'wsh', 'js', 'mjs', 'cjs', 'sh', 'bash', 'py',
]);

const MAX_PATH_LENGTH = 1024;

// Windows 保留设备名（CON / PRN / AUX / NUL / COM1-9 / LPT1-9）：带扩展名也照样是设备
const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

function fail(error, code) {
  return { ok: false, path: '', error, code: code || 'bad_path' };
}

/** 剥掉用户粘贴时带在两侧的引号（中英文都处理），顺手去掉不可见空白 */
function stripOuterQuotes(text) {
  let s = String(text || '');
  const pairs = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』']];
  let changed = true;
  while (changed) {
    changed = false;
    s = s.trim();
    for (const [open, close] of pairs) {
      if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
        s = s.slice(open.length, s.length - close.length);
        changed = true;
      }
    }
  }
  return s.trim();
}

/** 取路径最后一段（同时认 / 与 \） */
function kbFileName(filePath) {
  const s = String(filePath || '');
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return cut >= 0 ? s.slice(cut + 1) : s;
}

/** 取小写扩展名（不含点）；没有扩展名返回空串 */
function kbFileExtension(filePath) {
  const name = kbFileName(filePath);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

function isReservedDeviceName(name) {
  const base = kbFileName(name).split('.')[0].toLowerCase();
  return RESERVED_DEVICE_NAMES.has(base);
}

/**
 * 校验并规范化一个"本机绝对文件路径"。
 * 返回 { ok: true, path } 或 { ok: false, error, code }。
 */
function normalizeKbFilePath(raw) {
  if (typeof raw !== 'string') return fail('文件路径必须是文本', 'bad_path');
  const s = stripOuterQuotes(raw);
  if (!s) return fail('文件路径不能为空', 'empty');
  if (s.length > MAX_PATH_LENGTH) return fail('文件路径太长', 'too_long');
  // 控制字符（含换行）一律拒绝：路径里出现它们几乎一定是粘贴串行
  if (/[\u0000-\u001f\u007f]/.test(s)) return fail('文件路径里不能有控制字符', 'control_char');
  // 网址不是本机文件路径
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return fail('这是网址，不是本机文件路径', 'url');
  // 设备路径 \\.\ 与扩展 UNC \\?\ 一并拒（都是 \\ 开头）
  if (/^[\\/]{2}/.test(s)) return fail('不支持网络共享或设备路径（\\\\ 开头）', 'unc');
  // 路径里不能有 .. 段：留着会让「打开文件」指向别处，也让路径规范化变复杂。
  // 按分隔符切段判断，只认完整的 ".." 段，文件名里带点（如 a..b.pdf）不受影响。
  const segments = s.split(/[\\/]+/);
  if (segments.some((seg) => seg === '..')) {
    return fail('文件路径里不能有 ..（上级目录）', 'dotdot');
  }

  const win = /^([A-Za-z]):([\\/])(.*)$/.exec(s);
  if (win) {
    const rest = win[3];
    // 第二个冒号 = NTFS 数据流（file.txt:stream），不是普通文件
    if (rest.includes(':')) return fail('不支持 NTFS 数据流（路径里的第二个冒号）', 'ads');
    if (!rest) return fail('请选择具体文件，不能是盘符根目录', 'directory');
    if (/[\\/]$/.test(rest)) return fail('这看起来是文件夹，请选择具体文件', 'directory');
    if (isReservedDeviceName(rest)) return fail('这是系统保留设备名，不是普通文件', 'device');
  } else if (s.startsWith('/')) {
    if (s.endsWith('/')) return fail('这看起来是文件夹，请选择具体文件', 'directory');
  } else {
    return fail('请填写完整路径（Windows 以盘符开头，如 D:\\资料\\笔记.pdf）', 'relative');
  }

  const name = kbFileName(s);
  if (!name || name === '.' || name === '..') return fail('文件路径不完整', 'bad_path');
  const ext = kbFileExtension(s);
  if (!ext) return fail('这不像一个文件（没有扩展名）', 'bad_format');
  if (DENIED_EXTENSIONS.has(ext)) {
    return fail(`不能关联可执行文件（.${ext}）`, 'executable');
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return fail(`暂不支持这种文件格式（.${ext}），可以关联文档、图片、音视频或压缩包`, 'bad_format');
  }
  return { ok: true, path: s, ext, name };
}

/**
 * 检查一个已保存路径当前是否可用（不读内容，只看 stat）。
 * 返回 { status: 'available' | 'missing' | 'unavailable', error? }
 */
async function statKbFile(filePath, timeoutMs = 2500) {
  let timer = null;
  try {
    const stat = await Promise.race([
      fsp.stat(filePath),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('检查文件超时'), { code: 'ETIMEDOUT' })), timeoutMs);
      }),
    ]);
    if (stat.isFile()) return { status: 'available' };
    if (stat.isDirectory()) return { status: 'unavailable', error: '这是一个文件夹，不是文件' };
    return { status: 'unavailable', error: '不是普通文件' };
  } catch (err) {
    const code = err && err.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing' };
    if (code === 'ETIMEDOUT') return { status: 'unavailable', error: '检查文件超时（磁盘可能未连接）' };
    return { status: 'unavailable', error: (err && err.message) || '无法访问这个文件' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 并发受限的 map：避免一次几百个 stat 同时打出去把服务拖住 */
async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  if (!list.length) return out;
  const width = Math.max(1, Math.min(limit || 1, list.length));
  let cursor = 0;
  const workers = new Array(width).fill(0).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      out[index] = await fn(list[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 打开一个本机文件（默认程序）。
 * - 不经 shell：spawn 的参数是数组，文件名里的 & 空格 中文都原样到达；
 * - 只启动进程，不读文件内容，也不返回内容；
 * - spawn 失败（程序不存在等）以 reject 抛出，由调用方转成 4xx/5xx。
 */
function openLocalFile(filePath, { spawn, platform = process.platform } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof spawn !== 'function') {
      reject(Object.assign(new Error('没有可用的打开通道'), { code: 'no_spawn' }));
      return;
    }
    let child;
    try {
      if (platform === 'win32') {
        child = spawn('explorer.exe', [filePath], { detached: true, stdio: 'ignore', windowsHide: true });
      } else {
        child = spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' });
      }
    } catch (err) {
      reject(err);
      return;
    }
    // 测试桩可能只返回普通对象（没有 once）：那就认为"已经启动"
    if (!child || typeof child.once !== 'function') {
      resolve({ ok: true });
      return;
    }
    let settled = false;
    const done = (fn2, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn2(value);
    };
    const timer = setTimeout(() => {
      // 进程迟迟没有回音：按"已启动"处理，不让服务卡在这里
      done(resolve, { ok: true, slow: true });
    }, 3000);
    child.once('spawn', () => {
      try { if (typeof child.unref === 'function') child.unref(); } catch { /* ignore */ }
      done(resolve, { ok: true });
    });
    child.once('error', (err) => done(reject, err));
  });
}

module.exports = {
  ALLOWED_EXTENSIONS,
  DENIED_EXTENSIONS,
  MAX_PATH_LENGTH,
  stripOuterQuotes,
  kbFileName,
  kbFileExtension,
  normalizeKbFilePath,
  statKbFile,
  mapLimit,
  openLocalFile,
};
