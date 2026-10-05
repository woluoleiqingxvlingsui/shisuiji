/* 拾穗集 —— 全局系统通知
 *
 * 需求：把赛博鸡蛋的「消息 / 通知」能力开放给全局用。后台同步成功、失败、恢复都要
 * 经由这里发一条系统通知，而不只是往消息中心塞一条本机记录——App 在后台时用户
 * 看不到消息中心，通知栏才是真正能立刻看见的那条路。
 *
 * 与赛博鸡蛋铃铛（eggs.js）的关系：两者共用 Web Notification 通道和系统权限，
 * 但开关分开存。铃铛只管「蛋到期」且 checkReminders 仅电脑端跑；这里的开关
 * 管全局通知（含后台同步成败），默认开，不去动用户对蛋提醒的既有偏好。
 */

import { state } from './state.js';
import { isDesktop } from './perm.js';

const SYNC_NOTIFY_KEY = 'danji.notifySync'; // '0' = 关，缺省 = 开
const NOTIF_TAG = 'danji-global';

/**
 * 全局通知开关（默认开）。和蛋到期的铃铛互不影响。
 * 读的是 state 上的响应式副本，不是 localStorage —— 顶栏铃铛是 computed，
 * 直接读 localStorage 它不跟踪，切换后界面不刷新，看起来就「没区别」。
 */
function globalNotifyOn() {
  return state.notifyGlobalOn !== false;
}

function setGlobalNotifyOn(on) {
  const v = !!on;
  state.notifyGlobalOn = v;
  try {
    localStorage.setItem(SYNC_NOTIFY_KEY, v ? '1' : '0');
  } catch { /* 隐私模式等场景忽略 */ }
  return v;
}

function notifSupported() {
  return typeof Notification !== 'undefined';
}

/** 权限字符串；不支持时统一报 'unsupported'，免得 UI 到处判 undefined */
function notifPermission() {
  if (!notifSupported()) return 'unsupported';
  return Notification.permission;
}

/* ---- 发不出去的原因：UI 靠它区分「我关了」和「这台机器根本发不了」 ----
 * 以前 notifySystem() 只是静默 return false，顶栏只能显示一个开/关，
 * 用户看到「灰掉 + 斜线」根本不知道是自己关的还是被系统拦的。 */
const WHY = {
  UNSUPPORTED: 'unsupported',   // 环境没有 Notification（非安全上下文等）
  DEFAULT: 'permission_default',// 从没申请过，点一下铃铛即可
  DENIED: 'permission_denied',  // 被浏览器/系统拦截，只能去设置里改
  OFF: 'switch_off',            // 用户自己关的软开关
  MOBILE: 'mobile',             // 手机端不弹（提醒只留电脑端）
};

/**
 * 当前发不出去通知的卡点；空串 = 可以正常发。
 * 纯判断，不发任何通知，UI（顶栏胶囊、测试通知按钮）都可以直接问它。
 */
function notifBlockReason() {
  if (!notifSupported()) return WHY.UNSUPPORTED;
  const perm = Notification.permission;
  if (perm === 'denied') return WHY.DENIED;
  if (perm !== 'granted') return WHY.DEFAULT;
  if (!globalNotifyOn()) return WHY.OFF;
  if (!isDesktop()) return WHY.MOBILE;
  return '';
}

/* ---- 顶栏胶囊的三态 ----
 * 刻意放在这里、而不是写成模板表达式：之前就栽在模板表达式上——
 * 「有没有卡点」和「卡点是不是我主动关的」是两回事，
 * 而 switch_off 也是非空字符串，于是「我关的」被画成了「坏了」。
 * 收敛成一个函数 + 单测钉死，这类错误就不可能再回来了。 */
const PILL = {
  on: { cls: 'on', icon: '🔔' },
  off: { cls: 'off', icon: '🔕' },
  blocked: { cls: 'blocked', icon: '⚠️' },
};

/** 当前该显示哪一态：只有「用户主动关的」是中性 off，
 *  其余一切发不出去的原因（未授权 / 被拦截 / 环境不支持）都是 blocked。 */
function notifPillState() {
  const why = notifBlockReason();
  if (!why) return PILL.on;
  if (why === WHY.OFF) return PILL.off;
  return PILL.blocked;
}

/**
 * 发一条系统通知。永远不抛：通知是锦上添花，失败了也不该把同步状态机带崩。
 *
 * **只在电脑端发**。手机在手上、连着 WiFi 改东西时走的是前台同步，本来就即时可见，
 * 弹通知纯属打扰；而真正需要后台同步的场景（手机不在身边）恰恰看不到它的提示栏。
 * 所以提醒只留在电脑端——那才是人真正盯着的地方。
 * @param {{ title: string, body?: string, tag?: string }} opts
 * @returns {boolean} 是否真的发出去了
 */
function notifySystem({ title, body = '', tag = NOTIF_TAG } = {}) {
  try {
    if (notifBlockReason()) return false;
    const n = new Notification(String(title || ''), { body: String(body || ''), tag });
    n.onclick = () => {
      try { window.focus(); } catch { /* ignore */ }
      try { n.close(); } catch { /* ignore */ }
    };
    return true;
  } catch {
    return false;
  }
}

/**
 * 申请通知权限。**必须**在用户手势里调（onClick），否则被浏览器静默拒绝。
 * @returns {Promise<'granted'|'denied'|'default'|'unsupported'>}
 */
async function requestNotifPermission() {
  if (!notifSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  let perm = 'default';
  try {
    perm = await Notification.requestPermission();
  } catch {
    return 'denied';
  }
  state.notifPermission = perm;
  return perm;
}

/** 权限是否还没问过（顶栏那个小圆点就靠它） */
function notifPermissionUnasked() {
  return notifPermission() === 'default';
}

/** 权限可能被用户在浏览器设置里改过：把最新值同步回 state，供 UI 读。
 *  页面加载、切回前台、点击铃铛之后都该调一次。 */
function refreshNotifPermission() {
  const p = notifPermission();          // 'granted' | 'denied' | 'default' | 'unsupported'
  state.notifPermission = p;
  return p;
}

export {
  SYNC_NOTIFY_KEY, NOTIF_TAG, WHY, PILL,
  globalNotifyOn, setGlobalNotifyOn, notifSupported, notifPermission,
  notifySystem, notifBlockReason, notifPillState, refreshNotifPermission,
  requestNotifPermission, notifPermissionUnasked,
};
