/* 拾穗集 —— 手机端板块离线可读（M20 任务 A）
 *
 * 镜像层早就有全部 9 个集合的全量数据（pull 每次都返回），缺的只是「UI 读它」：
 * 本模块给 eggs / expenses / achievements / kb / insights 提供统一的
 * 「REST 优先，失败或已知离线时静默回落 IndexedDB 镜像」读法。
 *
 * 两条不变量：
 *   1. 在线行为与改造前逐字一致 —— 先发 REST，拿到就按各板块原有逻辑写 state；
 *   2. 镜像数据绝不无提示地冒充实时数据 —— 回落时登记 pulled_at，
 *      由 workspace 的离线提示条如实显示「数据截至 hh:mm」。
 */

import { state } from './state.js';
import { api } from './api.js';
import { readCollection } from './sync/mirror.js';

/** 已知离线（health 探不通）时连 REST 都不必发，省掉一串必然失败的超时请求 */
function knownOffline() {
  return !!(state.sync && state.sync.offline);
}

function mobileLayerOn() {
  return !!(state.sync && state.sync.enabled);
}

/** 登记「这个集合当前展示的是镜像数据」；pulled_at 为空表示本机还没有镜像 */
function markStale(key, pulledAt) {
  state.staleBoards[key] = pulledAt || '';
}

function clearStale(key) {
  delete state.staleBoards[key];
}

/** 某集合当前是否正显示镜像数据 */
function isStale(key) {
  return Object.prototype.hasOwnProperty.call(state.staleBoards || {}, key);
}

/**
 * 板块读数据：REST 优先 → 失败/离线回落镜像。
 * @param {string} url   REST 地址
 * @param {string} key   镜像集合名（= boards[].collection）
 * @param {(items: any[], meta: {fromMirror: boolean, cached: boolean}) => void} apply
 *        写 state 的回调，REST 与镜像两条路都走它
 * @returns {Promise<{fromMirror: boolean, failed: boolean, count: number}>}
 *          failed=true 表示既没拿到 REST 也没有可用镜像，交给调用方沿用
 *          它自己原有的失败语义（错误态 / toast），不在这里替它决定。
 */
async function loadBoardWithMirror(url, key, apply) {
  if (!knownOffline()) {
    try {
      const items = await api(url).then((r) => r.json());
      clearStale(key);
      apply(items, { fromMirror: false, cached: false });
      return { fromMirror: false, failed: false, count: items.length };
    } catch (e) {
      // 网络层异常或非 JSON 响应 → 落镜像
    }
  }

  try {
    const mirror = await readCollection(key);
    // pulled_at 为空 = 从没同步成功过，镜像里是空壳，当作没有缓存
    if (mirror && mirror.pulled_at && Array.isArray(mirror.items)) {
      markStale(key, mirror.pulled_at);
      apply(mirror.items, { fromMirror: true, cached: true });
      return { fromMirror: true, failed: false, count: mirror.items.length };
    }
  } catch (e) {
    // IndexedDB 不可用等：继续走失败语义
  }

  if (mobileLayerOn()) {
    // 手机同步层在场却没有任何镜像：如实展示空态 + 离线提示，
    // 而不是弹一串「加载失败」打扰用户
    markStale(key, '');
    apply([], { fromMirror: true, cached: false });
    return { fromMirror: true, failed: false, count: 0 };
  }
  return { fromMirror: false, failed: true, count: 0 };
}

export { loadBoardWithMirror, knownOffline, markStale, clearStale, isStale };