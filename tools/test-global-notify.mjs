/**
 * 拾穗集 —— 全局通知开关的响应式真值表
 * 用法：node tools/test-global-notify.mjs
 *
 * 回归背景：顶栏那个 🔔 曾经「开了和关了没区别」。
 * 根因不是样式，是开关状态只写进了 localStorage——顶栏按钮的 computed 只跟踪
 * 响应式依赖，localStorage 不是响应式的，切换后 computed 不重算，图标纹丝不动。
 * 蛋到期的铃铛没这问题，因为它写的是 state.notifyOn（在 reactive 里）。
 *
 * 这里用一个最小的响应式桩（Proxy + 依赖收集）把「computed 会不会刷新」变成可断言的，
 * 以后谁再把开关挪回 localStorage，这项立刻红。
 */
import assert from 'node:assert/strict';

/* ---- 最小响应式实现：够验证「computed 是否重算」，不引入真 Vue ---- */
const deps = new Map();
let currentEffect = null;

function track(key) {
  if (!currentEffect) return;
  if (!deps.has(key)) deps.set(key, new Set());
  deps.get(key).add(currentEffect);
}
function trigger(key) {
  for (const eff of [...(deps.get(key) || [])]) eff.dirty = true;
}
function reactive(obj) {
  return new Proxy(obj, {
    get(t, k) { track(k); return t[k]; },
    set(t, k, v) { t[k] = v; trigger(k); return true; },
  });
}
function computed(fn) {
  const eff = {
    dirty: true,
    value: undefined,
    own: new Set(),
    run() {
      for (const d of this.own) d.own.delete(this);
      this.own.clear();
      const prev = currentEffect;
      currentEffect = this;
      try { this.value = fn(); } finally { currentEffect = prev; }
    },
  };
  return { get value() { if (eff.dirty) { eff.run(); eff.dirty = false; } return eff.value; } };
}

/* ---- 浏览器环境桩：必须在 import 之前装好 ---- */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
let notifPermission = 'granted';
class FakeNotification {
  constructor(title, opts) { FakeNotification.last = { title, opts }; }
  close() {}
}
FakeNotification.last = null;
globalThis.Notification = FakeNotification;
Object.defineProperty(globalThis.Notification, 'permission', {
  get: () => notifPermission,
  configurable: true,
});
globalThis.window = {
  Vue: { reactive, computed, ref: (v) => ({ value: v }), watch() {}, createApp() {} },
  focus() {},
  dispatchEvent() {},
};
globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type; } };

const { state } = await import('../public/js/state.js');
const { globalNotifyOn, setGlobalNotifyOn, notifySystem, notifPillState, SYNC_NOTIFY_KEY } = await import('../public/js/notify.js');

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

console.log('全局通知开关的响应式（顶栏铃铛的 computed 会不会跟着变）');

ok('默认是开的', () => {
  store.delete(SYNC_NOTIFY_KEY);
  assert.equal(state.notifyGlobalOn, true);
  assert.equal(globalNotifyOn(), true);
});

ok('核心回归：setGlobalNotifyOn(false) 必须改到 state 上，computed 要能重算', () => {
  // 模拟顶栏那个 computed 的真实写法
  const active = computed(() => state.notifPermission === 'granted' && globalNotifyOn());
  assert.equal(active.value, true, '初始应为开');

  setGlobalNotifyOn(false);
  assert.equal(active.value, false, '关掉后 computed 仍显示开 —— 就是「没区别」那个 bug');

  setGlobalNotifyOn(true);
  assert.equal(active.value, true, '再开后也要跟着变回来');
});

ok('localStorage 与 state 双向一致（刷新页面后还是同一个状态）', () => {
  setGlobalNotifyOn(false);
  assert.equal(localStorage.getItem(SYNC_NOTIFY_KEY), '0');
  assert.equal(state.notifyGlobalOn, false);
  setGlobalNotifyOn(true);
  assert.equal(localStorage.getItem(SYNC_NOTIFY_KEY), '1');
  assert.equal(state.notifyGlobalOn, true);
});

ok('非法入参一律归一成布尔，不让 undefined 混进 state', () => {
  assert.equal(setGlobalNotifyOn(0), false);
  assert.equal(setGlobalNotifyOn(''), false);
  assert.equal(setGlobalNotifyOn('yes'), true);
  assert.equal(typeof state.notifyGlobalOn, 'boolean');
});

console.log('notifySystem（全局系统通知）');

ok('权限已授予 + 开关打开 + 电脑端：真的发出去了', () => {
  setGlobalNotifyOn(true);
  notifPermission = 'granted';
  state.role = 'desktop';
  FakeNotification.last = null;
  assert.equal(notifySystem({ title: '后台同步完成', body: '已与电脑端同步' }), true);
  assert.equal(FakeNotification.last.title, '后台同步完成');
});

ok('手机端：一条都不弹（提醒只留在电脑端）', () => {
  setGlobalNotifyOn(true);
  notifPermission = 'granted';
  state.role = 'mobile';
  FakeNotification.last = null;
  assert.equal(notifySystem({ title: '后台同步完成' }), false);
  assert.equal(notifySystem({ title: '后台同步失败' }), false);
  assert.equal(FakeNotification.last, null, '手机端不该有任何通知落到系统');
  state.role = 'desktop';
});

ok('手机端：开关开着也不弹（不能靠开回来绕过）', () => {
  state.role = 'mobile';
  setGlobalNotifyOn(true);
  FakeNotification.last = null;
  assert.equal(notifySystem({ title: 'x' }), false);
  setGlobalNotifyOn(false);
  assert.equal(notifySystem({ title: 'x' }), false);
  assert.equal(FakeNotification.last, null);
  state.role = 'desktop';
});

ok('用户关了开关：一条都不发（消息中心仍有记录）', () => {
  setGlobalNotifyOn(false);
  FakeNotification.last = null;
  assert.equal(notifySystem({ title: '后台同步失败' }), false);
  assert.equal(FakeNotification.last, null);
});

ok('未授权：静默不炸（不能把同步状态机带崩）', () => {
  setGlobalNotifyOn(true);
  notifPermission = 'default';
  FakeNotification.last = null;
  assert.equal(notifySystem({ title: 'x' }), false);
  notifPermission = 'denied';
  assert.equal(notifySystem({ title: 'x' }), false);
  notifPermission = 'granted';
});

ok('标题/正文为空或非法：不抛异常', () => {
  setGlobalNotifyOn(true);
  notifPermission = 'granted';
  assert.equal(notifySystem({}), true);
  assert.equal(notifySystem({ title: null, body: undefined }), true);
  assert.equal(notifySystem(), true);
});
console.log('顶栏胶囊的三态（回归：switch_off 曾被误判成 blocked）');

ok('已授权 + 用户主动关掉开关 → 中性 off / 🔕（不是 blocked！）', () => {
  setGlobalNotifyOn(false);
  notifPermission = 'granted';
  assert.equal(notifPillState().cls, 'off', '「我关的」必须是 off，不能画成「坏了」');
  assert.equal(notifPillState().icon, '🔕');
});

ok('已授权 + 开关打开 → on / 🔔', () => {
  setGlobalNotifyOn(true);
  notifPermission = 'granted';
  assert.equal(notifPillState().cls, 'on');
  assert.equal(notifPillState().icon, '🔔');
});

ok('权限被拦截 → blocked / ⚠️', () => {
  setGlobalNotifyOn(true);
  notifPermission = 'denied';
  assert.equal(notifPillState().cls, 'blocked');
  notifPermission = 'default';
  assert.equal(notifPillState().cls, 'blocked', '从未授权也属 blocked');
  notifPermission = 'granted';
});

ok('环境不支持 Notification → blocked / ⚠️', () => {
  const saved = globalThis.Notification;
  delete globalThis.Notification;
  assert.equal(notifPillState().cls, 'blocked');
  globalThis.Notification = saved;
});

if (process.exitCode) {
  console.error(`\n✗ test-global-notify：有失败（通过 ${passed}）`);
} else {
  console.log(`\n✓ test-global-notify：${passed} 项通过`);
}
