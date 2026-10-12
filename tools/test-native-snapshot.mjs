/** 使用本机 JDK 验证正式 APK 使用的快照写入器，只写临时目录。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const javaRoot = process.env.JAVA_HOME || path.join(os.homedir(), 'tools', 'jdk-21');
const suffix = process.platform === 'win32' ? '.exe' : '';
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'danji-native-snapshot-'));
try {
  const source = path.join(root, 'app/android/app/src/main/java/app/shisuiji/danji/SnapshotStore.java');
  const fixture = path.join(root, 'tools/native/SnapshotStoreTest.java');
  const compile = spawnSync(path.join(javaRoot, 'bin', 'javac' + suffix),
    ['-encoding', 'UTF-8', '-d', temporary, source, fixture], { encoding: 'utf8', windowsHide: true });
  assert.equal(compile.status, 0, compile.error?.message || compile.stderr);
  const execute = spawnSync(path.join(javaRoot, 'bin', 'java' + suffix),
    ['-cp', temporary, 'app.shisuiji.danji.SnapshotStoreTest', temporary], { encoding: 'utf8', windowsHide: true });
  assert.equal(execute.status, 0, execute.error?.message || execute.stderr);
  console.log(execute.stdout.trim());
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
