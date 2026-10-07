/* 拾穗集 —— 原生后台同步桥（仅 Capacitor 壳生效）
 *
 * 主通道：push.js 监听电脑端 /api/events 的 SSE 推送。电脑端一改数据，服务端安静
 * 5 分钟后推一条 sync，手机端立刻同步——不需要固定间隔轮询。
 * 兜底通道：原生 SyncForegroundService 保活 + AlarmManager 每 15 分钟踢一次，
 * 防 Doze 断流漏单。两者的成败都汇进 push.js 的同一个重试状态机：
 * 失败等 5 分钟重试、两次都失败才用「消息 + 通知」告知用户。
 *
 * 浏览器 / 旧 APK（没有 BackgroundSync 插件）下 getPlugin() 返回 null，
 * 闹钟部分静默降级；SSE 推送监听不依赖插件，已配对就会开启。
 */

import { isNativePlatform } from '../pwa.js';
import { getToken, getServerBase } from '../api.js';
import { isPaired } from '../pair.js';
import { shouldRunBackgroundService } from './net.js';
import { startPushListener, stopPushListener, ensurePushConnected, requestSync } from './push.js';

const BG_KEY = 'danji.bgSync'; // '0' = 关，缺省 = 开

function getPlugin() {
  try {
    if (isNativePlatform() && window.Capacitor && window.Capacitor.Plugins) {
      return window.Capacitor.Plugins.BackgroundSync || null;
    }
  } catch { /* ignore */ }
  return null;
}

function bgSyncWanted() {
  try {
    return localStorage.getItem(BG_KEY) !== '0';
  } catch {
    return true;
  }
}

function setBgSyncWanted(on) {
  try {
    localStorage.setItem(BG_KEY, on ? '1' : '0');
  } catch { /* ignore */ }
}

function report(verdict) {
  const plugin = getPlugin();
  if (!plugin || !plugin.reportResult) return;
  Promise.resolve()
    .then(() => plugin.reportResult({ ok: verdict !== 'fail' }))
    .catch(() => {});
}


// 必须是 window 级、同步可见的函数：原生侧写成 `window.__danjiBackgroundSync && ...()`，
// 模块还没加载完时被踢到是安全的 no-op。
if (typeof window !== 'undefined') {
  window.__danjiBackgroundSync = async function backgroundSyncKick(reason) {
    try {
      // 汇进 push.js 的队列：失败会自动走「5 分钟 × 2 重试 → 通知」的节奏，
      // 这里不再自己调 syncNow，否则绕过重试状态机、失败就静默没了
      const verdict = await requestSync({ reason: reason || 'bg-tick', fromEvent: false });
      report(verdict);
      // Doze 醒来后 SSE 流往往已经死了：兜底踢成功一次就顺手把推送连接拉起来
      ensurePushConnected();
      return verdict !== 'fail';
    } catch (e) {
      console.warn('[shisuiji] 后台同步异常', e);
      report('fail');
      return false;
    }
  };
}

/** 后台服务是否可用（= 跑在带 BackgroundSync 插件的新 APK 里）。浏览器 / 旧 APK 恒 false */
function bgSyncAvailable() {
  return !!getPlugin();
}

/** 唯一的开关入口：App 启动 / 配对成功 / 清除配对 / 用户拨开关后都调它 */
async function refreshBackgroundService() {
  const plugin = getPlugin();
  let want = false;
  if (plugin) {
    want = shouldRunBackgroundService({
      pluginAvailable: true,
      wanted: bgSyncWanted(),
      paired: isPaired(),
    });
    try {
      // M17:把配对凭据交给原生——之后原生 SSE/同步轮不再依赖 WebView 是否活着
      if (want) await plugin.start({ token: getToken() || '', baseUrl: getServerBase() || '' });
      else await plugin.stop();
    } catch (e) {
      console.warn('[shisuiji] 后台同步服务开关失败', e);
    }
  }
  // SSE 变更推送与后台服务解耦：已配对就监听（前台即时同步；后台靠服务保活）
  if (isPaired()) startPushListener();
  else stopPushListener();
  return want;
}

export { BG_KEY, bgSyncWanted, setBgSyncWanted, bgSyncAvailable, refreshBackgroundService };
