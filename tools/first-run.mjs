// First-run configuration only. Existing local configuration is never replaced.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveQrcodePath } from './qrcode-loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function exists(file) {
  try { await fs.stat(file); return true; }
  catch (err) { if (err.code === 'ENOENT') return false; throw err; }
}

export async function inspectSetup(root = ROOT) {
  const file = path.join(root, 'config.json');
  if (await exists(file)) {
    try {
      const config = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
      const valid = !!config && typeof config === 'object' && !Array.isArray(config)
        && Number.isInteger(Number(config.port ?? 8642)) && Number(config.port ?? 8642) > 0 && Number(config.port ?? 8642) <= 65535;
      return { existing: true, valid, qrReady: !!resolveQrcodePath(root) };
    } catch { return { existing: true, valid: false }; }
  }
  // A missing configuration does not prove this is a new installation.
  const data = await fs.readdir(path.join(root, 'data')).catch(err => {
    if (err.code === 'ENOENT') return []; throw err;
  });
  const legacy = data.length > 0 || await exists(path.join(root, 'local.env.ps1'))
    || await exists(path.join(root, 'danji-cert.pem')) || await exists(path.join(root, 'danji-key.pem'))
    || (await fs.readdir(path.join(root, 'papers')).catch(err => {
      if (err.code === 'ENOENT') return []; throw err;
    })).length > 0;
  return { existing: false, legacy, qrReady: !!resolveQrcodePath(root) };
}

async function checkPort(port, host) {
  // On Windows, binding a more specific address may coexist with a wildcard
  // listener. Probe loopback too, so that a running service is not missed.
  const busy = await new Promise((resolve, reject) => {
    const probe = net.createConnection({ host: '127.0.0.1', port });
    probe.setTimeout(1000);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', err => {
      probe.destroy();
      if (err.code === 'ECONNREFUSED') resolve(false);
      else reject(new Error('无法确认端口状态，请检查本机网络权限后重试'));
    });
    probe.once('timeout', () => { probe.destroy(); reject(new Error('无法确认端口状态，请换一个端口后重试')); });
  });
  if (busy) throw new Error('这个端口被占用，请换一个端口；不会结束已有进程');
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', () => reject(new Error('这个端口被占用或无法监听，请换一个端口；不会结束已有进程')));
    socket.listen(port, host, resolve);
  });
  await new Promise(resolve => socket.close(resolve));
}

export async function installQrDependency(root = ROOT) {
  if (resolveQrcodePath(root)) return;
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=1', '--fetch-timeout=60000'];
  const bundled = await exists(npmCli);
  const command = bundled ? process.execPath : (process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm');
  const commandArgs = bundled ? [npmCli, ...args] : process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm.cmd ci --ignore-scripts --no-audit --no-fund --fetch-retries=1 --fetch-timeout=60000'] : args;
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: root, windowsHide: true, stdio: 'ignore' });
    child.once('error', () => reject(new Error('无法运行 npm，请重新安装含 npm 的 Node.js 后重试')));
    child.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error('二维码依赖安装失败；请检查网络后在项目目录运行 npm ci，再重试'));
    });
  });
  if (!resolveQrcodePath(root)) throw new Error('二维码依赖仍不可用，请在项目目录运行 npm ci');
}

export async function createFirstRun({ root = ROOT, mode, port = 8642, install = installQrDependency, env = process.env } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('需要 Node.js 18 或以上版本');
  const state = await inspectSetup(root);
  if (state.existing) {
    if (!state.valid) throw new Error('已有 config.json 无法读取或端口无效，请先检查原文件；引导不会覆盖它');
    return { ok: true, existing: true }; // preserve every byte, including unknown keys
  }
  if (state.legacy) throw new Error('检测到旧数据或本机设置，请先恢复原 config.json，再启动；引导不会重置旧设置');
  if (env.DANJI_TOKEN || env.DANJI_PAPERS_DIR) {
    throw new Error('检测到已有口令或文献目录环境设置，请先核对原配置；引导不会替换这些设置');
  }
  if (!['desktop', 'android'].includes(mode)) throw new Error('请选择仅电脑使用或 Android 同步');
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口需要是 1 到 65535 的整数');
  const host = mode === 'android' ? '0.0.0.0' : '127.0.0.1';
  if ((env.PORT && Number(env.PORT) !== port) || (env.DANJI_HOST && env.DANJI_HOST !== host)) {
    throw new Error('当前环境变量覆盖了端口或监听地址，请先在新终端清除 PORT / DANJI_HOST 覆盖后重试');
  }
  if (mode === 'android' && (env.DANJI_TLS_CERT || env.DANJI_TLS_KEY)) {
    throw new Error('当前启用了 HTTPS 环境变量；Android 首次引导使用局域网 HTTP，请先取消本进程的 TLS 覆盖后重试');
  }
  await checkPort(port, host);
  if (mode === 'android' && !state.qrReady) await install(root);
  // Installation can take time. Recheck both legacy files and the port afterward.
  const latest = await inspectSetup(root);
  if (latest.existing) return createFirstRun({ root, mode, port, install, env });
  if (latest.legacy) throw new Error('初始化期间出现了已有数据或设置，请先核对原配置');
  if (mode === 'android' && !latest.qrReady) throw new Error('二维码依赖未安装成功，请重试');
  await checkPort(port, host);
  const config = { port, host, papers_dir: 'papers', sync: { token: crypto.randomBytes(32).toString('hex') } };
  try {
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code === 'EEXIST') return createFirstRun({ root, mode, port, install, env });
    throw new Error('无法创建本机配置，请将项目放在可写目录后重试');
  }
  return { ok: true, existing: false, mode, port }; // never print token or local paper paths
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, mode, port] = process.argv.slice(2);
    if (command === 'status') console.log(JSON.stringify(await inspectSetup()));
    else if (command === 'create') console.log(JSON.stringify(await createFirstRun({ mode, port: port || 8642 })));
    else throw new Error('用法：node tools/first-run.mjs status | create desktop|android [端口]');
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }));
    process.exitCode = 1;
  }
}
