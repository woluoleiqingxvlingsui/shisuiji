/**
 * 拾穗集 —— withTimeout / pickIntervalMs 单测
 * 用法：node tools/test-latency.mjs
 */
import assert from 'node:assert/strict';
import { withTimeout, DEFAULT_TIMEOUT_MS, HEALTH_TIMEOUT_MS } from '../public/js/api.js';
import { pickIntervalMs, SYNC_INTERVAL_MS, SYNC_INTERVAL_BUSY_MS } from '../public/js/sync/net.js';

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

async function okAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

console.log('latency');

ok('timeout 常量', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 12000);
  assert.equal(HEALTH_TIMEOUT_MS, 4000);
});

ok('pickIntervalMs：空闲 60s / 待同步 8s', () => {
  assert.equal(pickIntervalMs(0), 60000);
  assert.equal(pickIntervalMs(1), 8000);
  assert.equal(pickIntervalMs(5), 8000);
});

await okAsync('withTimeout：快速 resolve 原样返回', async () => {
  const v = await withTimeout(Promise.resolve(42), 50);
  assert.equal(v, 42);
});

await okAsync('withTimeout：挂起 promise 超时 reject', async () => {
  const hang = new Promise(() => {});
  let name = '';
  try {
    await withTimeout(hang, 30);
  } catch (e) {
    name = e && e.name;
  }
  assert.equal(name, 'TimeoutError');
});

if (process.exitCode) {
  console.error(`\n✗ test-latency：有失败（通过 ${passed}）`);
} else {
  console.log(`\n✓ test-latency：${passed} 项通过`);
}
