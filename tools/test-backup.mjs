// Exercise backup.ps1 only against synthetic data and controlled port verdicts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'danji-backup-test-'));
let passed = 0;
function check(name, action) { action(); passed++; console.log('  ✓ ' + name); }
try {
  await fs.copyFile(path.join(root, 'backup.ps1'), path.join(temp, 'backup.ps1'));
  // This fixture never imports the user's local.env.ps1 or config.json.
  await fs.writeFile(path.join(temp, 'lib.ps1'), `$Base = $PSScriptRoot
function Get-PortOwner { return @{ State = $env:DANJI_TEST_OWNER; Pid = 123 } }
`, 'utf8');
  await fs.mkdir(path.join(temp, 'data', 'images'), { recursive: true });
  await fs.writeFile(path.join(temp, 'data', 'ideas.json'), '{"ideas":[]}');
  await fs.writeFile(path.join(temp, 'data', 'images', 'demo.png'), Buffer.from([1, 2, 3, 4]));
  const run = (state, args = []) => spawnSync('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(temp, 'backup.ps1'), ...args],
    { cwd: temp, windowsHide: true, encoding: 'utf8', env: { ...process.env, DANJI_TEST_OWNER: state } });
  for (const state of ['Project', 'Foreign', 'Unknown']) {
    check(state + ' 不会被误判为已停服务', () => assert.equal(run(state).status, 2));
  }
  check('无法确认状态时 -Force 也不会绕过门禁', () => assert.equal(run('Unknown', ['-Force']).status, 2));
  assert.equal(await fs.stat(path.join(temp, 'backups')).then(() => true, () => false), false);
  check('输出到源 data/ 内被拒绝', () => assert.equal(run('Free', ['-OutDir', path.join(temp, 'data', 'nested')]).status, 1));
  for (let i = 0; i < 2; i++) {
    const result = run('Free');
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const copies = await fs.readdir(path.join(temp, 'backups'));
  check('连续备份产生两个独立目录', () => assert.equal(copies.length, 2));
  for (const copy of copies) {
    assert.equal(await fs.readFile(path.join(temp, 'backups', copy, 'data', 'ideas.json'), 'utf8'), '{"ideas":[]}');
    assert.deepEqual(await fs.readFile(path.join(temp, 'backups', copy, 'data', 'images', 'demo.png')), Buffer.from([1, 2, 3, 4]));
  }
  check('已停止服务时完整复制 JSON 与图片且通过哈希校验', () => {});
  check('明确识别为本项目服务时仍可显式强制复制', () => assert.equal(run('Project', ['-Force']).status, 0));
} finally {
  if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('danji-backup-test-')) throw new Error('Unsafe test cleanup target');
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}
console.log(`✓ ${passed} 项备份回归通过`);
