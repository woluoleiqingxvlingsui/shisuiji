import fs from 'node:fs';
import path from 'node:path';

export function androidVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('版本必须是 major.minor.patch');
  const [major, minor, patch] = version.split('.').map(Number);
  const code = major * 10000 + minor * 100 + patch;
  if (minor > 99 || patch > 99 || !Number.isSafeInteger(code) || code < 1 || code > 2100000000) {
    throw new Error('Android 版本编号越界，minor/patch 必须小于 100');
  }
  return { name: version, code };
}

export function inspectAndroidVersion(root) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, '')).version;
  const expected = androidVersion(version);
  const gradle = fs.readFileSync(path.join(root, 'app/android/app/build.gradle'), 'utf8');
  const compact = gradle.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');
  for (const required of [
    "newgroovy.json.JsonSlurper().parse(rootProject.file('../../package.json')).version.toString()",
    'versionNamereleaseVersion', 'versionCodereleaseCode',
    'releaseParts[0].toInteger()*10000+releaseParts[1].toInteger()*100+releaseParts[2].toInteger()',
  ]) {
    if (!compact.includes(required)) throw new Error('Android 构建未按根 package.json 统一生成版本，请检查 build.gradle');
  }
  return expected;
}
