/**
 * 拾穗集 —— 同步门闩 shouldAttemptSync 真值表
 * 用法：node tools/test-net-gate.mjs
 */
import assert from 'node:assert/strict';
import { shouldAttemptSync, isClientOutdated, CLIENT_VERSION } from '../public/js/sync/net.js';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log('shouldAttemptSync');

ok('原生未配对：不请求（online 任意）', () => {
  assert.equal(shouldAttemptSync({ native: true, paired: false, online: true }), false);
  assert.equal(shouldAttemptSync({ native: true, paired: false, online: false }), false);
  assert.equal(shouldAttemptSync({ native: true, paired: false }), false);
});

ok('原生已配对：不论 online 都请求', () => {
  assert.equal(shouldAttemptSync({ native: true, paired: true, online: true }), true);
  assert.equal(shouldAttemptSync({ native: true, paired: true, online: false }), true);
  assert.equal(shouldAttemptSync({ native: true, paired: true }), true);
});

ok('网页：尊重 online（false 不请求）', () => {
  assert.equal(shouldAttemptSync({ native: false, paired: true, online: true }), true);
  assert.equal(shouldAttemptSync({ native: false, paired: false, online: true }), true);
  assert.equal(shouldAttemptSync({ native: false, paired: true, online: false }), false);
  assert.equal(shouldAttemptSync({ online: false }), false);
  assert.equal(shouldAttemptSync({ online: true }), true);
  assert.equal(shouldAttemptSync({}), true);
});

ok('isClientOutdated：minClient 大于内置版本才过旧', () => {
  assert.equal(isClientOutdated(CLIENT_VERSION), false);
  assert.equal(isClientOutdated(CLIENT_VERSION + 1), true);
  assert.equal(isClientOutdated(CLIENT_VERSION - 1), false);
});

ok('isClientOutdated：老服务缺字段 / 非法值不误报', () => {
  assert.equal(isClientOutdated(undefined), false);
  assert.equal(isClientOutdated(null), false);
  assert.equal(isClientOutdated('abc'), false);
  assert.equal(isClientOutdated(String(CLIENT_VERSION + 1)), true);
});

if (process.exitCode) {
  console.error(`\n✗ test-net-gate：有失败（通过 ${passed}）`);
} else {
  console.log(`\n✓ test-net-gate：${passed} 项通过`);
}
