/**
 * 拾穗集 —— 跨端同步回报的队列真值表
 * 用法：node tools/test-global-notify.mjs 之外单独跑：node tools/test-sync-report.mjs
 *
 * 为什么要有这个：手机回报「我同步成没成功」时，最常见的状况恰恰是**发不出去**
 * （连不上电脑）。如果失败就丢，用户永远收不到「同步失败」这条最该被看到的消息。
 * 所以回报必须排队、重试、且不刷屏——这三条全在这里钉死。
 */
import assert from 'node:assert/strict';

/* ---- 浏览器环境桩：必须在 import 之前装好 ----
 * report.js → messages.js → state.js → vue-globals.js 会摸 window.Vue，
 * 这里给个最小实现：reactive 只需要能被读写，computed 只要能返回函数结果。
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const vstub = {
  reactive: (o) => o,
  computed: (fn) => ({ get value() { return fn(); } }),
  ref: (v) => ({ value: v }),
  watch() {},
  createApp() {},
  onMounted() {}, onUnmounted() {}, nextTick() {},
  provide() {}, inject() {},
};
globalThis.window = { Vue: vstub, focus() {}, dispatchEvent() {}, addEventListener() {} };
let notifPermission = 'granted';
class FakeNotification {
  constructor(title, opts) { FakeNotification.last = { title, opts }; }
  close() {}
}
FakeNotification.last = null;
globalThis.Notification = FakeNotification;
Object.defineProperty(globalThis.Notification, 'permission', { get: () => notifPermission, configurable: true });
globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type; } };

/* ---- fetch 替身：api() 只是 fetch 的薄包装，桩住 fetch 就能测到真实链路 ---- */
let posted = [];
let nextResult = () => ({ ok: true, status: 201 });
globalThis.__setApi = (fn) => { nextResult = fn; };
globalThis.__posted = () => posted;
globalThis.fetch = async (url, init = {}) => {
  const r = nextResult(url, init) || {};
  if (r.throw) throw new Error(r.throw);
  if (!url.includes('/api/messages')) return { ok: true, status: 200, json: async () => ({}) };
  posted.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
  return {
    ok: r.ok !== false,
    status: r.status || 201,
    json: async () => ({ id: 'stub' }),
  };
};
// Node 24 的 navigator 是只读 getter，只能定义不能赋值
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

const { PENDING_KEY, PENDING_MAX, reportOutcomes, flushReports, pendingReportCount } =
  await import('../public/js/sync/report.js');

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
const readQ = () => JSON.parse(store.get(PENDING_KEY) || '[]');
function reset() {
  store.delete(PENDING_KEY);
  posted = [];
  nextResult = () => ({ ok: true });
}

console.log('回报队列（发不出去才是常态，绝不能丢）');

await okAsync('成功：立刻送达并清空队列', async () => {
  reset();
  await reportOutcomes({ ok: true, attempts: 0 });
  assert.equal(pendingReportCount(), 0, '队列应清空');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.kind, 'bg-sync');
  assert.equal(posted[0].body.sync_ok, '1');
});

await okAsync('失败：留在队列里等下一轮补报', async () => {
  reset();
  globalThis.__setApi(() => ({ ok: false, status: 500 }));
  await reportOutcomes({ ok: false, attempts: 3, reason: 'timeout' });
  assert.equal(pendingReportCount(), 1, '发不出去必须留着');
  assert.equal(posted.length, 1);
});

await okAsync('网络异常：同样留在队列里', async () => {
  reset();
  globalThis.__setApi(() => ({ throw: 'network down' }));
  await reportOutcomes({ ok: false, attempts: 1, reason: 'offline' });
  assert.equal(pendingReportCount(), 1);
});

await okAsync('补报：网络恢复后把欠的都送出去', async () => {
  reset();
  globalThis.__setApi(() => ({ throw: 'down' }));
  await reportOutcomes({ ok: false, attempts: 1, reason: 'a' });
  await reportOutcomes({ ok: false, attempts: 2, reason: 'b' });
  assert.equal(pendingReportCount(), 2);

  globalThis.__setApi(() => ({ ok: true }));
  const r = await flushReports();
  assert.equal(r.sent, 2, '两条都应补报成功');
  assert.equal(r.left, 0);
  assert.equal(pendingReportCount(), 0);
});

await okAsync('队首失败就停下：避免电脑一恢复就被陈旧结论刷屏', async () => {
  reset();
  store.set(PENDING_KEY, JSON.stringify([
    { kind: 'bg-sync', sync_ok: '0', sync_attempts: '1', sync_reason: 'x' },
    { kind: 'bg-sync', sync_ok: '0', sync_attempts: '2', sync_reason: 'y' },
  ]));
  posted = [];
  let call = 0;
  globalThis.__setApi(() => { call += 1; return call === 1 ? { ok: false, status: 503 } : { ok: true, status: 201 }; });
  const r = await flushReports();
  assert.equal(posted.length, 1, '第一条失败就不该继续发后面的');
  assert.equal(r.left, 2);
});

console.log('队列上限与字段清洗');

await okAsync('队列封顶，长期连不上也不会无限膨胀', async () => {
  reset();
  globalThis.__setApi(() => ({ ok: false }));
  for (let i = 0; i < PENDING_MAX + 8; i++) {
    await reportOutcomes({ ok: false, attempts: i, reason: 'x' });
  }
  assert.equal(pendingReportCount(), PENDING_MAX, `应封顶在 ${PENDING_MAX}`);
});

await okAsync('attempts 夹到 0~99，reason 截断到 120 字', async () => {
  reset();
  // 让发送失败，条目才会留在队列里供检查
  globalThis.__setApi(() => ({ ok: false, status: 500 }));
  await reportOutcomes({ ok: false, attempts: -5, reason: 'r'.repeat(500) });
  const one = readQ()[0];
  assert.ok(one, '发不出去时条目应留在队列里');
  assert.equal(one.sync_attempts, 0, '负数夹到 0');
  assert.equal(one.sync_reason.length, 120, 'reason 截断到 120 字');

  globalThis.__setApi(() => ({ throw: 'still down' }));
  await reportOutcomes({ ok: false, attempts: 9999, reason: '' });
  const last = readQ().at(-1); // 队列是追加的，最新的一条在末尾
  assert.equal(last.sync_attempts, 99, '超大的次数夹到 99');
  assert.equal(last.sync_reason, '');
});

await okAsync('本地存储被写坏：当作空队列，不炸', async () => {
  reset();
  store.set(PENDING_KEY, '{ 这不是 JSON');
  assert.equal(pendingReportCount(), 0);
  const r = await flushReports();
  assert.equal(r.sent, 0);
});

await okAsync('队列不是数组：同样当空', async () => {
  reset();
  store.set(PENDING_KEY, '"字符串"');
  assert.equal(pendingReportCount(), 0);
});

if (process.exitCode) {
  console.error(`\n✗ test-sync-report：有失败（通过 ${passed}）`);
} else {
  console.log(`\n✓ test-sync-report：${passed} 项通过`);
}
