import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFirstRun, inspectSetup, installQrDependency } from './first-run.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'danji-first-run-'));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
async function check(name, action) { await action(); passed++; console.log('  ✓ ' + name); }
async function fresh(name) { const root = path.join(temp, name); await fs.mkdir(root, { recursive: true }); return root; }
async function freePort() {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '0.0.0.0', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
async function qrStub(root) {
  const dir = path.join(root, 'node_modules', 'qrcode'); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.js'), 'module.exports = {toFile(){},toString(){}};');
}
const configAt = root => path.join(root, 'config.json');
const readConfig = async root => JSON.parse(await fs.readFile(configAt(root), 'utf8'));
try {
  await check('仅电脑模式创建相对文献目录和随机口令，且不安装依赖', async () => {
    const root = await fresh('desktop');
    const result = await createFirstRun({ root, mode: 'desktop', port: await freePort(), env: {}, install: () => assert.fail('desktop must not install') });
    const config = await readConfig(root);
    assert.equal(result.existing, false); assert.equal(config.host, '127.0.0.1');
    assert.equal(config.papers_dir, 'papers'); assert.match(config.sync.token, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(result).includes(config.sync.token), false);
  });
  await check('Android 模式先安装二维码依赖再生成配置', async () => {
    const root = await fresh('android'); let installs = 0;
    await createFirstRun({ root, mode: 'android', port: await freePort(), env: {}, install: async location => { installs++; await qrStub(location); } });
    assert.equal((await readConfig(root)).host, '0.0.0.0'); assert.equal(installs, 1);
    assert.equal((await inspectSetup(root)).qrReady, true);
  });
  await check('已有配置逐字节保留，未知字段、口令与文献路径不重写', async () => {
    const root = await fresh('existing');
    const original = '\ufeff{ "port": 8642, "host":"custom", "papers_dir":"original-library", "sync":{"token":"old-token"}, "extra":true }\n';
    await fs.writeFile(configAt(root), original);
    assert.deepEqual(await createFirstRun({ root, mode: 'android', install: () => assert.fail('must not install') }), { ok: true, existing: true });
    assert.equal(await fs.readFile(configAt(root), 'utf8'), original);
  });
  await check('损坏配置明确报错且原文件保留', async () => {
    const root = await fresh('invalid'); await fs.writeFile(configAt(root), 'broken');
    await assert.rejects(createFirstRun({ root, mode: 'desktop' }), /不会覆盖/);
    assert.equal(await fs.readFile(configAt(root), 'utf8'), 'broken');
  });
  for (const entry of ['data/ideas.json', 'local.env.ps1', 'papers/example.pdf', 'danji-key.pem']) {
    await check('缺配置但有 ' + entry + ' 时拒绝初始化', async () => {
      const root = await fresh('legacy-' + passed);
      await fs.mkdir(path.dirname(path.join(root, entry)), { recursive: true });
      await fs.writeFile(path.join(root, entry), 'example');
      await assert.rejects(createFirstRun({ root, mode: 'desktop' }), /旧数据或本机设置/);
      await assert.rejects(fs.stat(configAt(root)), { code: 'ENOENT' });
    });
  }
  await check('无效模式、端口和冲突环境不生成配置', async () => {
    const root = await fresh('bad-input');
    for (const options of [{ mode: 'other' }, { mode: 'desktop', port: 0 }, { mode: 'desktop', port: 65536 },
      { mode: 'desktop', env: { DANJI_HOST: '0.0.0.0' } }, { mode: 'android', env: { DANJI_TLS_KEY: 'example' } },
      { mode: 'desktop', env: { DANJI_PAPERS_DIR: 'existing-library' } }, { mode: 'android', env: { DANJI_TOKEN: 'existing-token' } }]) {
      await assert.rejects(createFirstRun({ root, env: {}, ...options }));
    }
    await assert.rejects(fs.stat(configAt(root)), { code: 'ENOENT' });
  });
  await check('端口被占时不结束占用者，也不生成配置', async () => {
    const root = await fresh('port-busy'); const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '0.0.0.0', resolve));
    try {
      await assert.rejects(createFirstRun({ root, mode: 'desktop', port: listener.address().port, env: {} }), /端口被占用/);
      assert.equal(listener.listening, true); await assert.rejects(fs.stat(configAt(root)), { code: 'ENOENT' });
    } finally { await new Promise(resolve => listener.close(resolve)); }
  });
  await check('依赖安装失败不留下半份配置，允许重试', async () => {
    const root = await fresh('install-failed'); const port = await freePort();
    await assert.rejects(createFirstRun({ root, mode: 'android', port, env: {}, install: () => { throw new Error('network failed'); } }), /network failed/);
    await assert.rejects(fs.stat(configAt(root)), { code: 'ENOENT' });
    await createFirstRun({ root, mode: 'android', port, env: {}, install: qrStub });
    assert.equal((await readConfig(root)).host, '0.0.0.0');
  });
  await check('初始化竞态不会覆盖另一进程先创建的配置', async () => {
    const root = await fresh('race'); const other = '{"port":9321,"host":"127.0.0.1","papers_dir":"keep","sync":{"token":"keep"}}';
    await createFirstRun({ root, mode: 'android', port: await freePort(), env: {}, install: async location => { await qrStub(location); await fs.writeFile(configAt(root), other); } });
    assert.equal(await fs.readFile(configAt(root), 'utf8'), other);
  });
  await check('真实 npm ci 分支只在临时项目安装本地依赖，不访问网络', async () => {
    const root = await fresh('npm-local'); const pkg = path.join(root, 'fixture-qrcode');
    await fs.mkdir(pkg); await fs.writeFile(path.join(pkg, 'package.json'), '{"name":"qrcode","version":"1.0.0","main":"index.js"}');
    await fs.writeFile(path.join(pkg, 'index.js'), 'module.exports = {};');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'isolated-setup', version: '1.0.0', dependencies: { qrcode: 'file:fixture-qrcode' } }));
    await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'isolated-setup', version: '1.0.0', lockfileVersion: 3, packages: {
      '': { name: 'isolated-setup', version: '1.0.0', dependencies: { qrcode: 'file:fixture-qrcode' } },
      'node_modules/qrcode': { resolved: 'fixture-qrcode', link: true },
      'fixture-qrcode': { name: 'qrcode', version: '1.0.0' },
    } }));
    await installQrDependency(root);
    assert.equal((await inspectSetup(root)).qrReady, true);
  });
  await check('控制台已连接首次引导；既有配置跳过引导且不启动服务', async () => {
    const source = await fs.readFile(path.join(repo, 'control-ui.ps1'), 'utf8');
    assert.ok(source.indexOf('Show-FirstRunSetup') < source.indexOf("'lib.ps1'"));
    const root = await fresh('ps-existing'); await fs.writeFile(configAt(root), '{"port":8642}');
    const original = await fs.readFile(configAt(root));
    const script = path.join(temp, 'skip.ps1');
    await fs.writeFile(script, `\ufeff. '${path.join(repo, 'first-run.ps1').replaceAll("'", "''")}'\nif (-not (Show-FirstRunSetup -ProjectRoot '${root.replaceAll("'", "''")}')) { exit 1 }\n`);
    const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(await fs.readFile(configAt(root)), original);
  });
} finally { if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('danji-first-run-')) throw new Error('Unsafe test cleanup target');
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); }
console.log(`✓ ${passed} 项首次配置回归通过（仅临时目录）`);
