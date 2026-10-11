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

const {
  PENDING_KEY, PENDING_MAX, SUCCESS_COOLDOWN_MS, REPORT_TTL_MS,
  reportOutcomes, reportSyncSuccess, shouldReportSuccess, shouldJsReportCatchUp,
  flushReports, pendingReportCount, purgeFailedReports,
} = await import('../public/js/sync/report.js');

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
// ---- M17 假时钟(2026-10-07 裁定):冷却读 Date.now(),夹具接管,被测代码零改动 ----
// reset() 刻意不推进时钟——既有用例「60 秒内的连续成功合并成一条」依赖
// 『上一条 reportSyncSuccess 刚成功过』;只在需要跨冷却的新用例内显式推进。
let fakeNow = 1_700_000_000_000;
Date.now = () => fakeNow;
const readQ = () => JSON.parse(store.get(PENDING_KEY) || '[]');
async function reset() {
  // 先等在途 flush 落地(flushing 守卫会复用它),再清场——
  // 否则上一条用例 fire-and-forget 的 flush 会泄漏到下一条用例(2026-10-07 实测)
  try { await flushReports(); } catch { /* 队列可能被上一条用例写坏,下面兜底清掉 */ }
  store.delete(PENDING_KEY);
  posted = [];
  nextResult = () => ({ ok: true });
}

console.log('回报队列（发不出去才是常态，绝不能丢）');

await okAsync('成功：立刻送达并清空队列', async () => {
  await reset();
  await reportOutcomes({ ok: true, attempts: 0 });
  assert.equal(pendingReportCount(), 0, '队列应清空');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.kind, 'bg-sync');
  assert.equal(posted[0].body.sync_ok, '1');
});

await okAsync('失败：留在队列里等下一轮补报', async () => {
  await reset();
  globalThis.__setApi(() => ({ ok: false, status: 500 }));
  await reportOutcomes({ ok: false, attempts: 3, reason: 'timeout' });
  assert.equal(pendingReportCount(), 1, '发不出去必须留着');
  assert.equal(posted.length, 1);
});

await okAsync('网络异常：同样留在队列里', async () => {
  await reset();
  globalThis.__setApi(() => ({ throw: 'network down' }));
  await reportOutcomes({ ok: false, attempts: 1, reason: 'offline' });
  assert.equal(pendingReportCount(), 1);
});

await okAsync('补报：网络恢复后把欠的都送出去（M18：积压改用成功条目构造，失败已只留最新一条）', async () => {
  await reset();
  globalThis.__setApi(() => ({ throw: 'down' }));
  // M18 起失败回报入队即去重,积压改用成功条目构造——现实对应
  // 「同步成功但回报 POST 失败(401/5xx/网络断)」的窗口,成功条目不去重
  await reportOutcomes({ ok: true, pushed: 1 });
  await reportOutcomes({ ok: true, pushed: 2 });
  assert.equal(pendingReportCount(), 2);

  globalThis.__setApi(() => ({ ok: true }));
  const r = await flushReports();
  assert.equal(r.sent, 2, '两条都应补报成功');
  assert.equal(r.left, 0);
  assert.equal(pendingReportCount(), 0);
});

await okAsync('队首失败就停下：避免电脑一恢复就被陈旧结论刷屏', async () => {
  await reset();
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

await okAsync('毒丸：服务端明确拒收（4xx）的条目丢弃，后面的继续发（不再队首堵死）', async () => {
  await reset();
  store.set(PENDING_KEY, JSON.stringify([
    { kind: 'bg-sync', sync_ok: '0', sync_attempts: '1', sync_reason: 'bad' },
    { kind: 'bg-sync', sync_ok: '1', sync_attempts: '0', sync_reason: '' },
  ]));
  posted = [];
  let call = 0;
  globalThis.__setApi(() => { call += 1; return call === 1 ? { ok: false, status: 403 } : { ok: true, status: 201 }; });
  const r = await flushReports();
  assert.equal(posted.length, 2, '两条都要尝试');
  assert.equal(r.sent, 1, '第二条送达');
  assert.equal(r.dropped, 1, '第一条按毒丸丢弃');
  assert.equal(r.left, 0);
});

await okAsync('401 / 网络错：仍然保留等待，不丢弃', async () => {
  await reset();
  store.set(PENDING_KEY, JSON.stringify([
    { kind: 'bg-sync', sync_ok: '1', sync_attempts: '0', sync_reason: '' },
    { kind: 'bg-sync', sync_ok: '0', sync_attempts: '1', sync_reason: 'x' },
  ]));
  posted = [];
  globalThis.__setApi(() => ({ ok: false, status: 401 }));
  let r = await flushReports();
  assert.equal(r.left, 2, '401 口令问题:保留等下次');
  assert.equal(r.dropped, 0);

  await reset();
  store.set(PENDING_KEY, JSON.stringify([{ kind: 'bg-sync', sync_ok: '1' }]));
  globalThis.__setApi(() => ({ throw: 'timeout' }));
  r = await flushReports();
  assert.equal(r.left, 1, '网络错:保留');
  assert.equal(r.dropped, 0);
});

console.log('队列上限与字段清洗');

await okAsync('队列封顶，长期连不上也不会无限膨胀（M18：成功条目压队列，失败已只留一条）', async () => {
  await reset();
  globalThis.__setApi(() => ({ ok: false, status: 500 }));
  // M18 起失败只留最新一条,封顶回归改用成功条目压队列(回报 POST 持续 5xx 的现实窗口)
  for (let i = 0; i < PENDING_MAX + 8; i++) {
    await reportOutcomes({ ok: true, pushed: i });
  }
  assert.equal(pendingReportCount(), PENDING_MAX, `应封顶在 ${PENDING_MAX}`);
});

await okAsync('attempts 夹到 0~99，reason 截断到 120 字', async () => {
  await reset();
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

await okAsync('sync_background 落库：缺省 0，传 true 为 1（前台/后台文案靠它）', async () => {
  await reset();
  globalThis.__setApi(() => ({ ok: false, status: 500 }));  // 发不出去才留在队列里供检查
  await reportOutcomes({ ok: true, caughtUp: true });
  assert.equal(readQ().at(-1).sync_background, '0', '缺省必须是 0（= 前台）');
  await reportOutcomes({ ok: true, caughtUp: true, background: true });
  assert.equal(readQ().at(-1).sync_background, '1');
});

await okAsync('M19 原生壳：后台补齐不再被无条件压制（是否让位交给归属裁决）', async () => {
  await reset();
  globalThis.window.Capacitor = { Plugins: { BackgroundSync: {} } };
  try {
    // M17 曾在这一层把后台 caughtUp 一律抹掉，结果灰色窗口(退后台后 WebView 尚未冻结)
    // 里 JS 抢先拉到的补齐没人汇报——原生账本已被 noteSynced 对齐，它随后也沉默，
    // 这条改动的通知就永久丢了(2026-10-11 实测两次广播秒拉零回报)。
    // 现在本层只做冷却判定,「谁报」由 engine.js 的 shouldJsReportCatchUp 裁决后再传进来。
    const sent = reportSyncSuccess({ pushed: 0, caughtUp: true, background: true });
    assert.equal(sent, true, '原生在场不等于不许报：裁决说该报就得报');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].body.sync_caught_up, '1', 'caughtUp 不许在本层被抹掉');
    assert.equal(posted[0].body.sync_background, '1', '后台属性照传,文案靠它');
  } finally { delete globalThis.window.Capacitor; }
});

console.log('M19 归属裁决（纯函数：这条补齐该由 JS 报，还是原生已经报过了）');

await okAsync('裁决·前台：一律 JS 汇报（原生在前台从不跑同步轮）', () => {
  // 原生账本故意给得很大:只要不裁决,返回值就必须仍然是 true
  assert.equal(shouldJsReportCatchUp({
    background: false, nativePresent: true, nativeVersion: 999, serverVersion: 3,
  }), true);
});

await okAsync('裁决·无原生壳（浏览器 / 旧 APK）：一律 JS 汇报', () => {
  assert.equal(shouldJsReportCatchUp({
    background: true, nativePresent: false, nativeVersion: 0, serverVersion: 3,
  }), true);
});

await okAsync('裁决·后台+原生落后：JS 抢先拉到，由 JS 汇报（bug 2 的正路）', () => {
  assert.equal(shouldJsReportCatchUp({
    background: true, nativePresent: true, nativeVersion: 27, serverVersion: 28,
  }), true, '原生账本低于服务端版本 = 原生没到过这条改动');
  // 版本号缺失/非数字一律按 0 处理,不让 undefined 把裁决翻成「让位」而吞掉通知
  assert.equal(shouldJsReportCatchUp({
    background: true, nativePresent: true, nativeVersion: undefined, serverVersion: 28,
  }), true);
});

await okAsync('裁决·后台+原生已到（或超前）：原生报过了，JS 让位（单响律）', () => {
  assert.equal(shouldJsReportCatchUp({
    background: true, nativePresent: true, nativeVersion: 28, serverVersion: 28,
  }), false, '原生只在回报 POST 成功后才落账本,账本到位 = 通知已发出');
  assert.equal(shouldJsReportCatchUp({
    background: true, nativePresent: true, nativeVersion: 29, serverVersion: 28,
  }), false, '超前同样让位');
  // 缺省调用不炸,退化成「可报」
  assert.equal(shouldJsReportCatchUp(), true);
});

await okAsync('M17 原生壳：前台补齐仍由 JS 报（原生在页面可见时不跑）', async () => {
  await reset();
  fakeNow += 61_000;   // 跨出第 1 段成功回报的 60 秒冷却(夹具假时钟,见文件头)
  globalThis.window.Capacitor = { Plugins: { BackgroundSync: {} } };
  try {
    const sent = reportSyncSuccess({ pushed: 0, caughtUp: true, background: false });
    assert.equal(sent, true);
    assert.equal(posted[0].body.sync_caught_up, '1');
  } finally { delete globalThis.window.Capacitor; }
});

await okAsync('M18 失败回报只留最新一条(断网期间不逐条积攒)', async () => {
  await reset();
  globalThis.__setApi(() => ({ ok: false, status: 500 }));
  await reportOutcomes({ ok: false, attempts: 1, reason: 'a' });
  await reportOutcomes({ ok: false, attempts: 2, reason: 'b' });
  await reportOutcomes({ ok: false, attempts: 3, reason: 'c' });
  const fails = readQ().filter((x) => x.sync_ok === '0');
  assert.equal(fails.length, 1, '三次失败只该留最新一条');
  assert.equal(fails[0].sync_reason, 'c');
  // 成功条目不受失败去重影响
  await reportOutcomes({ ok: true, pushed: 1 });
  assert.equal(readQ().filter((x) => x.sync_ok === '1').length, 1);
});

await okAsync('M18 过期回报丢弃:排队超过 10 分钟的旧闻不再发送', async () => {
  await reset();
  const staleAt = new Date(fakeNow - (REPORT_TTL_MS + 60_000)).toISOString();
  const freshAt = new Date(fakeNow - 1_000).toISOString();
  store.set(PENDING_KEY, JSON.stringify([
    { kind: 'bg-sync', sync_ok: '0', sync_reason: '旧闻', rid: 'rid-stale', queued_at: staleAt },
    { kind: 'bg-sync', sync_ok: '1', sync_reason: '', rid: 'rid-fresh', queued_at: freshAt },
  ]));
  posted = [];
  globalThis.__setApi(() => ({ ok: true, status: 201 }));
  const r = await flushReports();
  assert.equal(r.sent, 1, '只有新鲜那条送达');
  assert.equal(r.dropped, 1, '过期那条按旧闻丢弃');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.rid, 'rid-fresh');
});

await okAsync('M18 同步成功后清空积压的失败回报(恢复后不再补发旧闻)', async () => {
  await reset();
  globalThis.__setApi(() => ({ ok: false, status: 500 }));
  await reportOutcomes({ ok: false, attempts: 2, reason: 'timeout' });
  assert.equal(readQ().filter((x) => x.sync_ok === '0').length, 1);
  assert.equal(purgeFailedReports(), true, '有失败可清时应返回 true');
  assert.equal(pendingReportCount(), 0, '失败积压应被清空');
  assert.equal(purgeFailedReports(), false, '没有失败可清时返回 false');
});

await okAsync('M17 flush 并发共用同一次：同一轮只发一遍', async () => {
  await reset();
  let release;
  const gate = new Promise((r) => { release = r; });
  globalThis.__setApi(() => gate.then(() => ({ ok: true, status: 201 })));
  const pA = reportOutcomes({ ok: true, caughtUp: true });  // 内部触发的 flush 挂在闸门上
  const pB = flushReports();                                 // 与 A 并发:有守卫时复用 A
  release();
  await Promise.all([pA, pB]);
  const posts = posted.filter((x) => x.url.includes('/api/messages'));
  assert.equal(posts.length, 1, `并发 flush 不得重复发送,实际 ${posts.length}`);
});

await okAsync('本地存储被写坏：当作空队列，不炸', async () => {
  await reset();
  store.set(PENDING_KEY, '{ 这不是 JSON');
  assert.equal(pendingReportCount(), 0);
  const r = await flushReports();
  assert.equal(r.sent, 0);
});

await okAsync('队列不是数组：同样当空', async () => {
  await reset();
  store.set(PENDING_KEY, '"字符串"');
  assert.equal(pendingReportCount(), 0);
});

console.log('成功回报的唯一入口（回归：以前只有 push 那条路会报）');

await okAsync('pushed>0：无论从哪条路进来都会回报电脑端', async () => {
  await reset();
  globalThis.__setApi(() => ({ ok: true }));
  const r = reportSyncSuccess({ pushed: 3 });
  assert.equal(r, true, '真的推了东西上去就必须回报');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.sync_pushed, '3', '要带上推了几条，服务端据此写文案');
  assert.equal(posted[0].body.sync_ok, '1');
});

await okAsync('空跑一轮（pushed=0、无补齐）：不回报', async () => {
  await reset();
  globalThis.__setApi(() => ({ ok: true }));
  assert.equal(reportSyncSuccess({ pushed: 0, caughtUp: false }), false);
  assert.equal(posted.length, 0);
});

await okAsync('caughtUp：电脑端推来的变更被拉下来时报一次', async () => {
  await reset();
  globalThis.__setApi(() => ({ ok: true }));
  // 判定只看 caughtUp（服务端版本上升 = 真的落后过），不看 fromEvent
  assert.equal(shouldReportSuccess({ caughtUp: true, now: 10_000_000, lastAt: 0 }), true);
  await reportOutcomes({ ok: true, caughtUp: true });
  assert.equal(posted[0].body.sync_pushed, '0');
  assert.equal(posted[0].body.sync_caught_up, '1');
});

await okAsync('fromEvent 本身不再触发（否则自己引发的广播会多报一次）', async () => {
  // fromEvent 由任何 sync 帧置位，包括手机自己那次写入引发的广播，
  // 它和「补齐」不是独立信号 —— 当触发条件只会多出一条噪音通知
  assert.equal(shouldReportSuccess({ fromEvent: true, now: 10_000_000, lastAt: 0 }), false);
  assert.equal(shouldReportSuccess({ fromEvent: true, caughtUp: true, now: 10_000_000, lastAt: 0 }), true,
    '配合 caughtUp 仍然要报（它只是不再单独触发）');
});

await okAsync('不传 now 时用真实时间，而不是恒定判成「冷却中」', async () => {
  // 旧默认值 now=0,lastAt=0 → 0-0<60000 恒成立 → 不传时间永远返回 false
  assert.equal(shouldReportSuccess({ pushed: 1 }), true, '不传时间参数也该能正常判定');
});

await okAsync('60 秒内的连续成功合并成一条（连记三条随记不该响三回）', async () => {
  // 上一条已经报过一次，冷却期内再报必须被吞掉
  await reset();
  globalThis.__setApi(() => ({ ok: true }));
  assert.equal(reportSyncSuccess({ pushed: 1 }), false, '冷却期内应被吞掉');
  assert.equal(posted.length, 0);
  // 冷却本身用纯函数钉死（时间由调用方给，能反复断言而互不干扰）
  const t0 = 1_000_000;
  assert.equal(shouldReportSuccess({ pushed: 1, now: t0, lastAt: 0, lastPushedAt: 0 }), true, '第一次必报');
  assert.equal(shouldReportSuccess({ pushed: 1, now: t0 + 1, lastAt: t0, lastPushedAt: t0 }), false, '刚报过就再报：吞');
  assert.equal(shouldReportSuccess({ pushed: 1, now: t0 + SUCCESS_COOLDOWN_MS - 1, lastAt: t0, lastPushedAt: t0 }), false, '差 1 毫秒仍在窗口内');
  assert.equal(shouldReportSuccess({ pushed: 1, now: t0 + SUCCESS_COOLDOWN_MS, lastAt: t0, lastPushedAt: t0 }), true, '满 60 秒才放行');
});

await okAsync('「已补齐」不冷却「推来了」：进前台补齐后马上记随记，回执照样要报（2026-10-06 实测被吞）', async () => {
  const t0 = 2_000_000;
  assert.equal(
    shouldReportSuccess({ pushed: 1, now: t0, lastAt: t0 - 5000, lastPushedAt: 0 }),
    true,
    '5 秒前刚报过「已补齐」，随记回执不许被它吞掉'
  );
});

await okAsync('「推来了」之后 60 秒内的「已补齐」仍被吞（防刷屏方向不变）', async () => {
  const t0 = 3_000_000;
  assert.equal(
    shouldReportSuccess({ caughtUp: true, now: t0 + 5000, lastAt: t0, lastPushedAt: t0 }),
    false,
    '刚推送过一次（lastAt 已随推送刷新），60 秒内的补齐不再单独报'
  );
});

await okAsync('字段清洗：sync_pushed 夹到 0~999，缺省为 0', async () => {
  await reset();
  globalThis.__setApi(() => ({ ok: false, status: 500 }));  // 发不出去才留在队列里供检查
  await reportOutcomes({ ok: true, pushed: -8 });
  assert.equal(readQ().at(-1).sync_pushed, '0');
  await reportOutcomes({ ok: true, pushed: 99999 });
  assert.equal(readQ().at(-1).sync_pushed, '999');
  await reportOutcomes({ ok: true });                       // 老客户端不带这两个字段
  assert.equal(readQ().at(-1).sync_pushed, '0');
  assert.equal(readQ().at(-1).sync_caught_up, '0', '缺省必须是 0，不能是 undefined');
});

await okAsync('成功回报只有一个出口：push.js 里不许再单独报成功', async () => {
  // 回归钉子：成功回报下沉到 engine.syncNow() 后，push.js 里的 onSyncSuccess
  // 必须不再调 reportOutcomes({ok:true}) —— 两处都留着就是每轮报两次。
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../public/js/sync/push.js', import.meta.url), 'utf8'));
  assert.ok(!/reportOutcomes\(\s*\{\s*ok:\s*true/.test(src), 'push.js 里仍有第二处成功回报');
  assert.ok(src.includes('reportSyncSuccess'), 'engine.js 的 syncNow 必须走 reportSyncSuccess');
});

await okAsync('自己推上去的东西，5 分钟后的广播补拉不该再报一次', async () => {
  // 场景 A：手机写一条随记
  //   (1) 推送并同步 → 该报；这里顺带钉住「自己推的也会被本轮 pull 吸收成最新版本」
  assert.equal(shouldReportSuccess({ pushed: 1, caughtUp: true, now: 1_000_000, lastAt: 0 }), true);
  //   (2) 5 分钟后广播引发的补拉：pushed=0、版本没再上升 → caughtUp=false → 不报
  assert.equal(shouldReportSuccess({ pushed: 0, caughtUp: false, now: 1_300_000, lastAt: 1_000_000 }), false,
    '手机自己引发的广播不该让电脑端再响一次');
});

await okAsync('电脑端真的改了：版本上升 → 该报', async () => {
  // 场景 B/C：电脑端改一条（连改两次也各自报，不会互相吞掉）
  assert.equal(shouldReportSuccess({ pushed: 0, caughtUp: true, now: 2_000_000, lastAt: 0 }), true);
  assert.equal(shouldReportSuccess({ pushed: 0, caughtUp: true, now: 3_000_000, lastAt: 2_000_000 }), true,
    '第二次改动间隔够久，也要独立报一次');
});

if (process.exitCode) {
  console.error(`\n✗ test-sync-report：有失败（通过 ${passed}）`);
} else {
  console.log(`\n✓ test-sync-report：${passed} 项通过`);
}
