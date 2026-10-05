/**
 * 拾穗集 —— 后台同步门闩 + 事件驱动重试策略真值表
 * 用法：node tools/test-bg-sync.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  shouldRunBackgroundService, isBackgroundSyncOk,
  classifySyncResult, nextSyncRetry,
  SYNC_RETRY_DELAY_MS, SYNC_QUIET_RETRIES,
} from '../public/js/sync/net.js';

// server.js 是 CJS 且一 require 就起服务，防抖策略因此拆在 lib/ 里，这里用 require 拿
const require = createRequire(import.meta.url);
const { SYNC_DEBOUNCE_MS, debounceElapsed } = require('../lib/sync-debounce.js');

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

console.log('shouldRunBackgroundService');

ok('三者齐全才跑服务', () => {
  assert.equal(
    shouldRunBackgroundService({ pluginAvailable: true, wanted: true, paired: true }),
    true
  );
});

ok('插件不可用（浏览器 / 旧 APK）：不跑', () => {
  assert.equal(
    shouldRunBackgroundService({ pluginAvailable: false, wanted: true, paired: true }),
    false
  );
});

ok('用户关掉开关：不跑', () => {
  assert.equal(
    shouldRunBackgroundService({ pluginAvailable: true, wanted: false, paired: true }),
    false
  );
});

ok('未配对：不跑（起了也只会白耗电 + 白挂常驻通知）', () => {
  assert.equal(
    shouldRunBackgroundService({ pluginAvailable: true, wanted: true, paired: false }),
    false
  );
});

ok('缺省参数一律按「不该跑」处理', () => {
  assert.equal(shouldRunBackgroundService(), false);
  assert.equal(shouldRunBackgroundService({}), false);
  assert.equal(shouldRunBackgroundService({ pluginAvailable: true }), false);
});

console.log('isBackgroundSyncOk');

ok('成功：不退避', () => {
  assert.equal(isBackgroundSyncOk({ ok: true, push: {}, pull: {} }), true);
});

ok('明确失败：退避', () => {
  assert.equal(isBackgroundSyncOk({ ok: false, error: 'timeout' }), false);
});

ok('skipped 各种原因是中性结果：不退避', () => {
  assert.equal(isBackgroundSyncOk({ skipped: true, reason: 'running' }), true);
  assert.equal(isBackgroundSyncOk({ skipped: true, reason: 'disabled' }), true);
  assert.equal(isBackgroundSyncOk({ skipped: true, reason: 'offline' }), true);
  assert.equal(isBackgroundSyncOk({ skipped: true, reason: 'need_token' }), true);
});

ok('意外形状（undefined / null / 空对象）按中性处理，不误触退避', () => {
  assert.equal(isBackgroundSyncOk(undefined), true);
  assert.equal(isBackgroundSyncOk(null), true);
  assert.equal(isBackgroundSyncOk({}), true);
});

console.log('classifySyncResult（事件驱动的结论分流）');

ok('ok:true → success', () => {
  assert.equal(classifySyncResult({ ok: true, push: {}, pull: {} }), 'success');
});

ok('ok:false → fail（要计入重试、最终通知）', () => {
  assert.equal(classifySyncResult({ ok: false, error: 'timeout' }), 'fail');
});

ok('各种 skipped → defer（不算失败，不误报「同步失败」）', () => {
  for (const reason of ['running', 'disabled', 'offline', 'need_token']) {
    assert.equal(classifySyncResult({ skipped: true, reason }), 'defer', reason);
  }
});

ok('意外形状 → defer（宁可重试也不误报故障）', () => {
  assert.equal(classifySyncResult(undefined), 'defer');
  assert.equal(classifySyncResult(null), 'defer');
  assert.equal(classifySyncResult({}), 'defer');
});

console.log('nextSyncRetry（失败后 5 分钟重试、两次后通知）');

ok('第 1 次失败：等 5 分钟，不通知', () => {
  const p = nextSyncRetry(1);
  assert.equal(p.delayMs, SYNC_RETRY_DELAY_MS);
  assert.equal(p.delayMs, 5 * 60 * 1000, '必须是 5 分钟');
  assert.equal(p.notify, false);
});

ok('第 2 次失败：还是等 5 分钟，仍不通知', () => {
  const p = nextSyncRetry(2);
  assert.equal(p.delayMs, 5 * 60 * 1000);
  assert.equal(p.notify, false, '连着两次失败还没到通知线');
});

ok(`第 ${SYNC_QUIET_RETRIES + 1} 次失败：该用「消息 + 通知」告知用户了`, () => {
  const p = nextSyncRetry(SYNC_QUIET_RETRIES + 1);
  assert.equal(p.notify, true);
  assert.equal(p.reset, true, '通知过之后归零，后续失败不反复刷屏');
});

ok('通知之后仍保持 5 分钟重试（不放弃）', () => {
  assert.equal(nextSyncRetry(50).delayMs, 5 * 60 * 1000);
});

ok('attempts 为 0 / 非法值：静默继续等', () => {
  assert.equal(nextSyncRetry(0).notify, false);
  assert.equal(nextSyncRetry(NaN).notify, false);
  assert.equal(nextSyncRetry(undefined).notify, false);
});

console.log('debounceElapsed（最后一次改动后 5 分钟才推）');

ok('窗口就是 5 分钟', () => {
  assert.equal(SYNC_DEBOUNCE_MS, 5 * 60 * 1000);
});

ok('没有待推送的改动：不推', () => {
  assert.equal(debounceElapsed(0, 1e12), false);
  assert.equal(debounceElapsed(undefined, 1e12), false);
});

ok('刚改完 1 秒：还没到 5 分钟，不推', () => {
  const t0 = 1_000_000;
  assert.equal(debounceElapsed(t0, t0 + 1000), false);
});

ok('改完 4 分 59 秒：还差 1 秒，不推', () => {
  const t0 = 1_000_000;
  assert.equal(debounceElapsed(t0, t0 + SYNC_DEBOUNCE_MS - 1), false);
});

ok('改完正好 5 分钟：推', () => {
  const t0 = 1_000_000;
  assert.equal(debounceElapsed(t0, t0 + SYNC_DEBOUNCE_MS), true);
});

ok('连改 10 条（每次都顺延窗口）：只有最后一条安静满 5 分钟才推', () => {
  const t0 = 1_000_000;
  let pendingAt = 0;
  // 模拟每 30 秒改一次，持续 5 分钟
  for (let i = 0; i <= 10; i++) {
    pendingAt = t0 + i * 30 * 1000;          // markDataChanged：每次刷新窗口
    assert.equal(debounceElapsed(pendingAt, pendingAt), false, `第 ${i} 次改动当下不该推`);
  }
  // 最后一次改动后 5 分钟：推
  assert.equal(debounceElapsed(pendingAt, pendingAt + SYNC_DEBOUNCE_MS), true);
  // 推完之后 pendingSince 归零，不会连着推
  assert.equal(debounceElapsed(0, pendingAt + SYNC_DEBOUNCE_MS + 1), false);
});

ok('可覆盖安静窗口长度（便于将来调参而不必改逻辑）', () => {
  const t0 = 1_000_000;
  assert.equal(debounceElapsed(t0, t0 + 60 * 1000, 90 * 1000), false);
  assert.equal(debounceElapsed(t0, t0 + 90 * 1000, 90 * 1000), true);
});

if (process.exitCode) {
  console.error(`\n✗ test-bg-sync：有失败（通过 ${passed}）`);
} else {
  console.log(`\n✓ test-bg-sync：${passed} 项通过`);
}
