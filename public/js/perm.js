/* 拾穗集 —— 写权限（按 role，与布局 isPhone 无关）
 * desktop：全功能。
 * mobile / 离线 mobile：仅「随记」可写（走 outbox）；消息已读也不开放。
 */

import { state } from './state.js';
import { isSecurePwaContext, isPwaShellActive, isNativePlatform } from './pwa.js';

function isDesktop() {
  if (state.role === 'desktop') return true;
  if (state.role === 'mobile') return false;
  // health 尚未返回（unknown）：只要没明确进手机同步层，先按桌面完整功能，
  // 避免电脑启动瞬间闪成只读
  return !(state.sync && state.sync.enabled);
}

/** 板块是否允许写操作（含新增按钮） */
function canWrite(board) {
  if (isDesktop()) return true;
  return board === 'ideas';
}

/**
 * 某条随记能不能在手机上改：
 * 只有**明确** origin === 'mobile' 的才可写。desktop 的、以及老数据里没写来源的
 * （旧记录没有 origin 字段）一律当只读——不猜来源，也不改真实数据。
 * 服务端对非 mobile 来源的推送会回 forbidden，前端口径必须一致，
 * 否则用户在手机上改了半天，提交时才发现这条根本改不了。
 */
function canWriteIdea(idea) {
  if (!canWrite('ideas')) return false;
  if (isDesktop()) return true;
  return !!(idea && idea.origin === 'mobile');
}

/** 消息中心：手机端只读，不标已读 */
function canMarkMessages() {
  return isDesktop();
}

/** 展示用说明条 */
function mobileReadOnlyHint() {
  if (isDesktop()) return '';
  // 原生壳：本地已内置应用，不谈 HTTPS / PWA 离线壳。
  // M20 任务 A 起手机端各板块都能离线读，只有「记」仍限随记
  if (isNativePlatform()) {
    return 'App 模式：可离线浏览 · 可记随记';
  }
  const base = '手机端可浏览开放板块 · 随记可离线记';
  if (!isSecurePwaContext()) {
    return base + ' · 未配 HTTPS：关掉浏览器后不能冷启动';
  }
  if (!isPwaShellActive()) {
    return base + ' · 离线壳未生效：请刷新一次再「添加到主屏幕」';
  }
  return base + ' · 离线壳已就绪';
}

export { isDesktop, canWrite, canWriteIdea, canMarkMessages, mobileReadOnlyHint };
