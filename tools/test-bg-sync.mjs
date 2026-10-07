/**
 * 拾穗集 —— 后台同步门闩 + 事件驱动重试策略真值表
 * 用法：node tools/test-bg-sync.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  shouldRunBackgroundService, isBackgroundSyncOk,
  classifySyncResult, nextSyncRetry, pickIntervalMs, isCaughtUp,
  SYNC_RETRY_DELAY_MS, SYNC_QUIET_RETRIES,
  SYNC_INTERVAL_BUSY_MS, SYNC_INTERVAL_FALLBACK_MS,
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

console.log('debounceElapsed（最后一次改动后 60 秒才推）');

ok('窗口就是 60 秒', () => {
  assert.equal(SYNC_DEBOUNCE_MS, 60 * 1000);
});

ok('没有待推送的改动：不推', () => {
  assert.equal(debounceElapsed(0, 1e12), false);
  assert.equal(debounceElapsed(undefined, 1e12), false);
});

ok('刚改完 1 秒：还没满窗口，不推', () => {
  const t0 = 1_000_000;
  assert.equal(debounceElapsed(t0, t0 + 1000), false);
});

ok('改完 59 秒：还差 1 秒，不推', () => {
  const t0 = 1_000_000;
  assert.equal(debounceElapsed(t0, t0 + SYNC_DEBOUNCE_MS - 1), false);
});

ok('改完正好 60 秒：推', () => {
  const t0 = 1_000_000;
  assert.equal(debounceElapsed(t0, t0 + SYNC_DEBOUNCE_MS), true);
});

ok('连改 10 条（每次都顺延窗口）：只有最后一条安静满 60 秒才推', () => {
  const t0 = 1_000_000;
  let pendingAt = 0;
  // 模拟每 30 秒改一次,连续 11 次,窗口每次顺延
  for (let i = 0; i <= 10; i++) {
    pendingAt = t0 + i * 30 * 1000;          // markDataChanged：每次刷新窗口
    assert.equal(debounceElapsed(pendingAt, pendingAt), false, `第 ${i} 次改动当下不该推`);
  }
  // 最后一次改动后满窗口:推
  assert.equal(debounceElapsed(pendingAt, pendingAt + SYNC_DEBOUNCE_MS), true);
  // 推完之后 pendingSince 归零，不会连着推
  assert.equal(debounceElapsed(0, pendingAt + SYNC_DEBOUNCE_MS + 1), false);
});

ok('可覆盖安静窗口长度（便于将来调参而不必改逻辑）', () => {
  const t0 = 1_000_000;
  assert.equal(debounceElapsed(t0, t0 + 60 * 1000, 90 * 1000), false);
  assert.equal(debounceElapsed(t0, t0 + 90 * 1000, 90 * 1000), true);
});

console.log('pickIntervalMs（三态：只有前台才信任推送连接）');

ok('有待推送数据：8 秒快轮询（往上传，优先级最高，与前后台无关）', () => {
  assert.equal(pickIntervalMs(2, true, false), SYNC_INTERVAL_BUSY_MS);
  assert.equal(pickIntervalMs(2, true, true), SYNC_INTERVAL_BUSY_MS);
  assert.equal(pickIntervalMs(2, false, false), SYNC_INTERVAL_BUSY_MS);
});

ok('前台 + 推送连着 + 没待推送：返回 0，完全不轮询', () => {
  assert.equal(pickIntervalMs(0, true, false), 0);
});

ok('前台 + 推送断了 + 没待推送：退回慢速兜底', () => {
  assert.equal(pickIntervalMs(0, false, false), SYNC_INTERVAL_FALLBACK_MS);
});

ok('后台 + 推送“连着”：不许返回 0 —— 冻结时 pushLive 是假象，后台必须保留兜底轮询（2026-10-06 回归钉子）', () => {
  assert.equal(pickIntervalMs(0, true, true), SYNC_INTERVAL_FALLBACK_MS);
});

ok('缺省第三参（老调用方）：按前台处理，行为与旧版一致', () => {
  assert.equal(pickIntervalMs(0, true), 0);
  assert.equal(pickIntervalMs(0, false), SYNC_INTERVAL_FALLBACK_MS);
});

console.log('isCaughtUp（这一轮是不是把睡着期间漏掉的更新补上了）');

ok('首次同步（没存过版本）：不算落后', () => {
  assert.equal(isCaughtUp({ prevVersion: 0, prevBoot: '', serverVersion: 9, serverBoot: 'B1' }), false);
});

ok('同一次进程、服务端版本上升：补齐了，该回报', () => {
  assert.equal(isCaughtUp({ prevVersion: 9, prevBoot: 'B1', serverVersion: 12, serverBoot: 'B1' }), true);
});

ok('服务端重启过：boot 对不上就不算补齐（版本号跨进程不可比，不能拿它比大小）', () => {
  // 关键：serverVersion 必须**大于** prevVersion，否则去掉 boot 比较也照样返回 false，
  // 这条断言就成了测不到任何东西的假钉子。restart 后版本会归 1，但手机存着的大数
  // 可能被后续写入超过，所以「版本变大但 boot 不同」才是真正区分这两种情况的用例。
  assert.equal(isCaughtUp({ prevVersion: 5, prevBoot: 'B1', serverVersion: 9, serverBoot: 'B2' }), false,
    'boot 不同就不该报，哪怕版本号看起来变大了');
});

ok('老手机没存 bootId：沿用旧逻辑，只比版本号', () => {
  assert.equal(isCaughtUp({ prevVersion: 9, prevBoot: '', serverVersion: 12, serverBoot: 'B1' }), true);
});

ok('版本没变（同一次进程内没有任何新写入）：不报', () => {
  assert.equal(isCaughtUp({ prevVersion: 12, prevBoot: 'B1', serverVersion: 12, serverBoot: 'B1' }), false);
});

if (process.exitCode) {
  console.error(`\n✗ test-bg-sync：有失败（通过 ${passed}）`);
} else {
  console.log(`\n✓ test-bg-sync：${passed} 项通过`);
}
