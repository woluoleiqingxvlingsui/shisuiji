/**
 * 拾穗集 —— API 基址 / 原生探测纯逻辑单测（Node，无需浏览器）
 * 用法：node tools/test-api-base.mjs
 */
import assert from 'node:assert/strict';
import {
  normalizeServerBase,
  joinApiUrl,
  getServerBase,
  setServerBase,
  resolveApiUrl,
  SERVER_BASE_KEY,
} from '../public/js/api.js';
import { isNativePlatform } from '../public/js/pwa.js';

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

// Node 下无 localStorage：用可写 stub 模拟浏览器
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

console.log('api base / native probe');

ok('normalizeServerBase：trim 与去尾斜杠', () => {
  assert.equal(normalizeServerBase('  http://192.168.1.5:8642/  '), 'http://192.168.1.5:8642');
  assert.equal(normalizeServerBase('http://10.0.0.2:8642///'), 'http://10.0.0.2:8642');
  assert.equal(normalizeServerBase(''), '');
  assert.equal(normalizeServerBase(null), '');
});

ok('joinApiUrl：无 base 时原样返回 path（网页零变化）', () => {
  assert.equal(joinApiUrl('/api/health', ''), '/api/health');
  assert.equal(joinApiUrl('/api/health', null), '/api/health');
  assert.equal(joinApiUrl('/api/sync/pull', '   '), '/api/sync/pull');
});

ok('joinApiUrl：有 base 时前缀拼接', () => {
  assert.equal(
    joinApiUrl('/api/health', 'http://192.168.1.5:8642'),
    'http://192.168.1.5:8642/api/health',
  );
  assert.equal(
    joinApiUrl('/api/sync/push', 'http://192.168.1.5:8642/'),
    'http://192.168.1.5:8642/api/sync/push',
  );
});

ok('setServerBase / getServerBase：写入规范化，空串清除', () => {
  store.clear();
  assert.equal(getServerBase(), '');
  assert.equal(setServerBase('http://10.0.0.8:8642/'), 'http://10.0.0.8:8642');
  assert.equal(getServerBase(), 'http://10.0.0.8:8642');
  assert.equal(store.get(SERVER_BASE_KEY), 'http://10.0.0.8:8642');
  assert.equal(setServerBase(''), '');
  assert.equal(getServerBase(), '');
  assert.equal(store.has(SERVER_BASE_KEY), false);
});

ok('resolveApiUrl：跟 getServerBase 联动', () => {
  store.clear();
  assert.equal(resolveApiUrl('/api/health'), '/api/health');
  setServerBase('http://192.168.1.5:8642');
  assert.equal(resolveApiUrl('/api/health'), 'http://192.168.1.5:8642/api/health');
  setServerBase('');
});

ok('isNativePlatform：Node / 无 Capacitor 为 false', () => {
  assert.equal(isNativePlatform(), false);
  globalThis.window = { Capacitor: { isNativePlatform: () => true } };
  assert.equal(isNativePlatform(), true);
  globalThis.window = { Capacitor: { isNativePlatform: () => false } };
  assert.equal(isNativePlatform(), false);
  globalThis.window = {};
  assert.equal(isNativePlatform(), false);
  delete globalThis.window;
});

if (process.exitCode) {
  console.error(`\n✗ test-api-base：有失败（通过 ${passed}）`);
} else {
  console.log(`\n✓ test-api-base：${passed} 项通过`);
}
