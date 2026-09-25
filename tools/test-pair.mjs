/**
 * 拾穗集 —— 配对纯逻辑单测（Node）
 * 用法：node tools/test-pair.mjs
 */
import assert from 'node:assert/strict';
import {
  normalizePairBase,
  applyPair,
  clearPair,
  isPaired,
  parsePairPayload,
} from '../public/js/pair.js';
import { getServerBase, getToken, SERVER_BASE_KEY, TOKEN_KEY } from '../public/js/api.js';

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

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

console.log('pair');

ok('normalizePairBase：补 http、去尾斜杠、只留 origin', () => {
  assert.equal(normalizePairBase('192.168.1.5:8642'), 'http://192.168.1.5:8642');
  assert.equal(normalizePairBase('localhost:8642'), 'http://localhost:8642');
  assert.equal(normalizePairBase('localhost:8642/'), 'http://localhost:8642');
  assert.equal(normalizePairBase('myhost.local:8642'), 'http://myhost.local:8642');
  assert.equal(normalizePairBase('http://10.0.0.2:8642/'), 'http://10.0.0.2:8642');
  assert.equal(normalizePairBase('http://10.0.0.2:8642/api/health'), 'http://10.0.0.2:8642');
  assert.equal(normalizePairBase('https://10.0.0.2:8642'), 'https://10.0.0.2:8642');
});

ok('normalizePairBase：拒绝非法输入', () => {
  assert.equal(normalizePairBase(''), '');
  assert.equal(normalizePairBase('   '), '');
  assert.equal(normalizePairBase('ftp://10.0.0.1'), '');
  assert.equal(normalizePairBase('javascript:alert(1)'), '');
  assert.equal(normalizePairBase('not a url'), '');
  assert.equal(normalizePairBase('data:text/html,x'), '');
});

ok('applyPair：成功写入 base+token', () => {
  store.clear();
  const r = applyPair({ base: '192.168.1.5:8642/', token: ' secret ' });
  assert.equal(r.ok, true);
  assert.equal(r.base, 'http://192.168.1.5:8642');
  assert.equal(getServerBase(), 'http://192.168.1.5:8642');
  assert.equal(getToken(), 'secret');
  assert.equal(store.get(SERVER_BASE_KEY), 'http://192.168.1.5:8642');
  assert.equal(store.get(TOKEN_KEY), 'secret');
  assert.equal(isPaired(), true);
});

ok('applyPair：非法 base 不半写', () => {
  store.clear();
  applyPair({ base: 'http://10.0.0.8:8642', token: 'keep' });
  const r = applyPair({ base: 'ftp://x', token: 'new' });
  assert.equal(r.ok, false);
  assert.equal(getServerBase(), 'http://10.0.0.8:8642');
  assert.equal(getToken(), 'keep');
});

ok('clearPair：清空配置', () => {
  store.clear();
  applyPair({ base: 'http://10.0.0.8:8642', token: 't' });
  clearPair();
  assert.equal(getServerBase(), '');
  assert.equal(getToken(), '');
  assert.equal(isPaired(), false);
});

ok('parsePairPayload：合法 JSON', () => {
  const r = parsePairPayload('{"v":1,"base":"http://192.168.1.5:8642","token":"abc"}');
  assert.equal(r.ok, true);
  assert.equal(r.base, 'http://192.168.1.5:8642');
  assert.equal(r.token, 'abc');
  const r2 = parsePairPayload(' { "v" : 1 , "base" : "10.0.0.2:8642/" } ');
  assert.equal(r2.ok, true);
  assert.equal(r2.base, 'http://10.0.0.2:8642');
  assert.equal(r2.token, '');
});

ok('parsePairPayload：非法输入不写配置', () => {
  store.clear();
  applyPair({ base: 'http://10.0.0.8:8642', token: 'keep' });
  const bad = parsePairPayload('not-json');
  assert.equal(bad.ok, false);
  const badV = parsePairPayload('{"v":2,"base":"http://10.0.0.8:8642"}');
  assert.equal(badV.ok, false);
  const badBase = parsePairPayload('{"v":1,"base":"ftp://x"}');
  assert.equal(badBase.ok, false);
  const missingBase = parsePairPayload('{"v":1,"token":"x"}');
  assert.equal(missingBase.ok, false);
  assert.equal(getServerBase(), 'http://10.0.0.8:8642');
  assert.equal(getToken(), 'keep');
});

if (process.exitCode) {
  console.error(`\n✗ test-pair：有失败（通过 ${passed}）`);
} else {
  console.log(`\n✓ test-pair：${passed} 项通过`);
}
