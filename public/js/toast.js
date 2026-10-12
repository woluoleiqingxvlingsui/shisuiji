/* 拾穗集 —— 轻提示：统一入口，子组件也能通过 provide 拿到
 * 从 app.js 原样搬过来的，逻辑一字未改。
 * M18:补一个可选 opts.duration——同步回报 / 蛋到期这类重要提醒要弹得久一点
 * (6~8 秒),普通操作回执维持原来的 2.2 秒。新增 'report' 类型配强调色样式
 * (见 style.css 的 .toast.report)。旧调用 toast(msg, type) 完全兼容。
 */

import { state } from './state.js';

let toastTimer = null;
let importantActive = false;

/**
 * @param {string} msg 提示文本
 * @param {'ok'|'warn'|'report'} type 样式:ok 深色常规 / warn 红色告警 /
 *   report 强调色醒目(同步回报、蛋到期等重要提醒专用)
 * @param {{ duration?: number, important?: boolean }} [opts] 重要提醒不被普通提示覆盖
 */
function toast(msg, type = 'ok', opts = {}) {
  const important = type === 'report' || opts.important === true;
  if (state.toast.show && importantActive && !important) return;
  importantActive = important;
  state.toast = { show: true, msg, type };
  clearTimeout(toastTimer);
  const ms = Math.max(800, Number(opts && opts.duration) || 2200);
  toastTimer = setTimeout(() => { state.toast.show = false; importantActive = false; }, ms);
}

export { toast };
