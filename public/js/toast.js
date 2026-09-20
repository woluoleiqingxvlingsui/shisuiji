/* 拾穗集 —— 轻提示：统一入口，子组件也能通过 provide 拿到
 * 从 app.js 原样搬过来的，逻辑一字未改。
 */

import { state } from './state.js';

let toastTimer = null;

function toast(msg, type = 'ok') {
  state.toast = { show: true, msg, type };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { state.toast.show = false; }, 2200);
}

export { toast };
