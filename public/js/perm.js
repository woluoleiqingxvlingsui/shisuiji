/* 拾穗集 —— 写权限（按 role，与布局 isPhone 无关）
 * desktop：全功能。
 * mobile / 离线 mobile：仅「想法」可写（走 outbox）；消息已读也不开放。
 */

import { state } from './state.js';

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

/** 消息中心：手机端只读，不标已读 */
function canMarkMessages() {
  return isDesktop();
}

/** 展示用说明条 */
function mobileReadOnlyHint() {
  return isDesktop() ? '' : '手机端可浏览 · 想法可离线记';
}

export { isDesktop, canWrite, canMarkMessages, mobileReadOnlyHint };
