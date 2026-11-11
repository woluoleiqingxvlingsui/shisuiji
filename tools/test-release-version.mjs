import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidVersion, inspectAndroidVersion } from './release-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.deepEqual(androidVersion('1.5.1'), { name: '1.5.1', code: 10501 });
assert.ok(androidVersion('1.10.0').code > androidVersion('1.9.99').code);
for (const bad of ['1.5', '1.5.1-beta', '1.100.0', '0.0.0', '999999.1.1']) {
  assert.throws(() => androidVersion(bad));
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'danji-release-version-'));
try {
  fs.mkdirSync(path.join(temp, 'app/android/app'), { recursive: true });
  fs.copyFileSync(path.join(root, 'app/android/app/build.gradle'), path.join(temp, 'app/android/app/build.gradle'));
  fs.writeFileSync(path.join(temp, 'package.json'), '{"version":"1.5.2"}');
  assert.deepEqual(inspectAndroidVersion(temp), { name: '1.5.2', code: 10502 });
  const file = path.join(temp, 'app/android/app/build.gradle');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('versionName releaseVersion', 'versionName "1.4.0"'));
  assert.throws(() => inspectAndroidVersion(temp), /统一生成版本/);
  fs.writeFileSync(file, original.replace('versionCode releaseCode', 'versionCode 10400'));
  assert.throws(() => inspectAndroidVersion(temp), /统一生成版本/);
} finally {
  if (path.dirname(temp) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('danji-release-version-')) throw new Error('Unsafe cleanup');
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('✓ Android 版本派生、升级顺序和过期硬编码检查通过');
