/**
 * 拾穗集 —— 变更聚合（防抖）策略
 *
 * 需求：电脑端可能连着改好几条内容，没道理每改一条就推一次同步。
 * 规则是「最后一次内容修改完成后的 5 分钟」才发起同步——所以每次改动都把窗口
 * 往后顺延，只有安静满 5 分钟才算一次可推送的改动。
 *
 * 单独拆成 CommonJS 小模块：server.js 是 CJS 且一 require 就会起服务，
 * 策略本身必须是能脱离进程单独测的纯函数。
 */

/** 安静窗口：最后一次改动之后再等这么久才推。
 *  M17 从 5 分钟压到 60 秒:后台同步已改为原生秒级通道(见 docs/m17),这条聚合窗口
 *  成了延迟大头;60 秒仍足够把「连改 10 条」聚合成一次同步。检查粒度 5 秒不变。 */
const SYNC_DEBOUNCE_MS = 60 * 1000;

/** 检查粒度：窗口一满就推，不差这几秒 */
const SYNC_DEBOUNCE_TICK_MS = 5 * 1000;

/**
 * 聚合窗口是否已满。
 * @param {number} pendingAt 最近一次改动的时刻；0 / 假值 = 窗口内没有待推送的改动
 * @param {number} now 当前时刻
 * @param {number} [quietMs] 安静窗口长度
 * @returns {boolean}
 */
function debounceElapsed(pendingAt, now, quietMs = SYNC_DEBOUNCE_MS) {
  if (!pendingAt) return false;
  return now - pendingAt >= quietMs;
}

module.exports = { SYNC_DEBOUNCE_MS, SYNC_DEBOUNCE_TICK_MS, debounceElapsed };
