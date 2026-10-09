/**
 * 拾穗集 —— 电脑端回报通道（startReportInbox）与兜底补拉（sweepReports）
 * 用法：node tools/test-desktop-report-inbox.mjs
 *
 * 为什么要有这个：以前 startReportInbox() 是
 *   if (listenerStarted) return; listenerStarted = true;   // ← 先置位
 *   if (!isDesktop()) return;                            // ← 再判角色
 * 挂载那一刻 isDesktop() 还依赖 health 探回来的 role（冷启动时是 unknown，
 * 若已进手机同步层则判 false），于是整条通道**永久判死**且永不重试：
 * 手机回报照落库、照广播，电脑端却什么都收不到，界面上也看不出来。
 *
 * 这里用「浏览器环境桩 + 桩 fetch（真流）」把四件事钉死：
 *  1. 角色没探成 desktop 时不建连接；角色变成 desktop 后 ensureReportInbox() 必须能建上；
 *  2. 已经在跑时反复 ensureReportInbox() 不重复建连接（幂等）；
 *  3. 收到 event: report 帧 → 播报 + 登记 id（兜底轮询不会再弹第二条）；
 *  4. sweepReports() 首次只建档不播报，第二次遇到新回报才播报。
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

/* M18:Windows 系统通知已拆除,播报走应用内 toast。这里用 defineProperty 把
 * state.toast 变成记录桩:每次 toast() 赋值都留下一条日志,可断言次数与内容 */
let toastLog = [];
let toastVal = { show: false, msg: '', type: 'ok' };
globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type; } };

/* ---- 桩 fetch：/api/events 给一条真的可读流（report.js 会 getReader 逐帧读），
 *      /api/messages 供 loadMessages() 补拉；其余一律当成功。 ---- */
const enc = new TextEncoder();
let sseCount = 0;              // 实际建了几条 SSE 连接
let lastStream = null;         // 最近一条流的句柄，用来推帧
let serverMessages = [];       // 桩服务端 /api/messages 返回的内容
let messagesThrow = false;     // 让 /api/messages 分支抛异常（模拟服务不可用）
globalThis.__reset = () => {
  sseCount = 0;
  lastStream = null;
  serverMessages = [];
  messagesThrow = false;
};
globalThis.__setMessages = (list) => { serverMessages = list; };
globalThis.__setMessagesThrow = (on) => { messagesThrow = !!on; };
globalThis.__sseCount = () => sseCount;
globalThis.__toasts = () => toastLog.slice();
globalThis.__clearToasts = () => { toastLog = []; };
globalThis.__pushFrame = (text) => lastStream.push(text);

globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('/api/events')) {
    sseCount += 1;
    let ctl = null;
    const body = new ReadableStream({ start(c) { ctl = c; } });
    lastStream = {
      push(text) { try { ctl.enqueue(enc.encode(text)); } catch { /* 已关闭 */ } },
      close() { try { ctl.close(); } catch { /* 已关闭 */ } },
    };
    return { ok: true, status: 200, body };
  }
  if (String(url).includes('/api/messages')) {
    if (messagesThrow) throw new Error('服务不可用');
    return { ok: true, status: 200, json: async () => serverMessages };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const { state } = await import('../public/js/state.js');
/* state 是 reactive(identity 桩)的普通对象,重定义 toast 属性为记录桩 */
Object.defineProperty(state, 'toast', {
  configurable: true,
  get: () => toastVal,
  set: (v) => { toastVal = v; toastLog.push(v); },
});
const {
  startReportInbox, ensureReportInbox, stopReportInbox,
  startReportSweep, stopReportSweep, sweepReports,
} = await import('../public/js/sync/report.js');
const { loadMessages } = await import('../public/js/boards/messages.js');

let passed = 0;
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
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const frame = (payload) => `event: report\ndata: ${JSON.stringify(payload)}\n\n`;
const msg = (id, title, syncOk = '1') => ({
  id, kind: 'bg-sync', title, body: '', read: false, created_at: '2026-10-05T00:00:00.000Z', sync_ok: syncOk,
});

/* 开跑前先把角色摆成「手机端」：isDesktop() 判 false 的确定姿势 */
state.role = 'mobile';

console.log('回报通道的启动与幂等（角色没探回来时不能把通道判死）');

await okAsync('角色还没探成 desktop 时不建连接；角色变成 desktop 后 ensureReportInbox() 必须能建上', async () => {
  globalThis.__reset();
  assert.equal(startReportInbox(), false, '手机端/角色未探明时不该建连接');
  await tick();
  assert.equal(globalThis.__sseCount(), 0, '不该发出 /api/events 请求');

  // 关键回归：以前这一句之后整条通道就永久关闭了
  state.role = 'desktop';
  assert.equal(ensureReportInbox(), true, '角色变成 desktop 后必须能补建连接');
  await tick();
  assert.equal(globalThis.__sseCount(), 1, '应该正好建起一条 SSE');
  assert.equal(state.reportInbox, 'live', '连上后状态位应为 live');
});

await okAsync('已经在跑时反复 ensureReportInbox()：不重复建连接', async () => {
  const before = globalThis.__sseCount();
  ensureReportInbox();
  ensureReportInbox();
  ensureReportInbox();
  await tick();
  assert.equal(globalThis.__sseCount(), before, '不能反复重连，否则会打爆服务端的 SSE 连接名额');
  assert.equal(state.reportInbox, 'live', '状态位仍应是 live');
});

console.log('收到回报帧：播报 + 登记（兜底轮询不重复弹）');

await okAsync('收到 event: report 帧：应用内醒目 toast 弹出且 id 被登记，随后 sweepReports 不再弹第二条', async () => {
  globalThis.__clearToasts();
  globalThis.__pushFrame(frame({ id: 'r-1', title: '手机同步成功', body: '已与电脑端同步', ok: true }));
  await tick();
  const sent = globalThis.__toasts();
  assert.equal(sent.length, 1, '收到一帧就该弹一条应用内 toast');
  assert.ok(sent[0].msg.includes('手机同步成功'), `toast 内容应含标题，实际 ${sent[0].msg}`);
  assert.equal(sent[0].type, 'report', '同步成功回报要用 report 醒目样式');
  // 下面只看兜底轮询自己播了什么，先把 SSE 这一条从计数里划掉
  globalThis.__clearToasts();

  // 第一次 sweep：只建档不播报（刷新页面不该把历史回报再弹一遍）
  globalThis.__setMessages([msg('r-1', '手机同步成功')]);
  await sweepReports();
  assert.equal(globalThis.__toasts().length, 0, '首次 sweep 只建档，不能弹');

  // 第二次 sweep：id 已在登记本里，兜底轮询不能再弹一遍
  globalThis.__setMessages([msg('r-1', '手机同步成功')]);
  await sweepReports();
  assert.equal(globalThis.__toasts().length, 0, 'SSE 已弹过的回报，兜底轮询不能重复弹');
});

console.log('兜底补拉（SSE 死了也必须收得到）');

await okAsync('sweepReports：首次只建档不播报，第二次遇到新回报才播报', async () => {
  // 承接上一条：sweepSeeded 已经是 true，这里验证「新回报才播」
  globalThis.__clearToasts();
  globalThis.__setMessages([]);
  await sweepReports();
  assert.equal(globalThis.__toasts().length, 0, '没有新回报就不该播');

  globalThis.__setMessages([msg('r-1', '手机同步成功'), msg('r-2', '手机同步失败：连不上电脑', '0')]);
  await sweepReports();
  const sent = globalThis.__toasts();
  assert.equal(sent.length, 1, '只有漏掉的那条新回报该播');
  assert.ok(sent[0].msg.includes('手机同步失败：连不上电脑'));
  assert.equal(sent[0].type, 'warn', '失败回报要用红色 warn 样式');

  // 再扫一次：不许重复弹
  await sweepReports();
  assert.equal(globalThis.__toasts().length, 1, '同一条回报不能反复弹');
});

console.log('兜底补拉失败时不许刷 toast（45 秒一次，弹了就是骚扰）');

await okAsync('兜底补拉失败时不弹 toast（45 秒一次，弹了就是刷屏）', async () => {
  globalThis.__reset();
  globalThis.__setMessagesThrow(true);          // 让 /api/messages 抛异常（服务不可用）
  state.messagesLoaded = false;
  state.toast = { show: false, msg: '', type: 'ok' };
  await sweepReports();
  assert.equal(state.toast.show, false, '静默补拉失败不该弹 toast');
  globalThis.__setMessagesThrow(false);
});

await okAsync('对照：非静默的 loadMessages 失败仍然要弹 toast（否则上面那条是空跑）', async () => {
  globalThis.__setMessagesThrow(true);
  state.toast = { show: false, msg: '', type: 'ok' };
  await loadMessages();                          // 不传 silent
  assert.equal(state.toast.show, true, '正常路径失败必须仍提示，否则静默开关会把问题一起吞掉');
  assert.equal(state.toast.msg, '消息加载失败');
  globalThis.__setMessagesThrow(false);
  state.toast = { show: false, msg: '', type: 'ok' };
});

/* 收尾：清掉轮询与看门狗定时器，否则 node 不会退出 */
stopReportSweep();
stopReportInbox();

if (process.exitCode) {
  console.error(`\n✗ test-desktop-report-inbox：有失败（通过 ${passed}）`);
} else {
  console.log(`\n✓ test-desktop-report-inbox：${passed} 项通过`);
}
