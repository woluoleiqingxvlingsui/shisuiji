/* 拾穗集 —— 界面辅助：板块切换与顶栏高度同步
 * 从 app.js 原样搬过来的，逻辑一字未改。
 */

import { state } from './state.js';
import { nextTick } from './vue-globals.js';
import { FLASH_MS } from './util/const.js';

let topbarObserver = null;
function syncTopbarHeight() {
  const el = document.querySelector('.topbar');
  if (el) document.documentElement.style.setProperty('--topbar-h', el.offsetHeight + 'px');
}
function switchBoard(board) {
  state.board = board;
  localStorage.setItem('danji.board', board);
}



// 顶栏换行后高度会变，用 ResizeObserver 实时同步 --topbar-h，保证紧急横幅吸顶位置正确
export function observeTopbar() {
  const el = document.querySelector('.topbar');
  if (el && typeof ResizeObserver !== 'undefined') {
    topbarObserver = new ResizeObserver(syncTopbarHeight);
    topbarObserver.observe(el);
  }
}
export function stopObserveTopbar() {
  if (topbarObserver) topbarObserver.disconnect();
}

export { switchBoard, syncTopbarHeight, flashCard };

let flashTimer = null;
function flashCard(id) {
  clearTimeout(flashTimer);
  const start = () => {
    state.flashId = id;
    flashTimer = setTimeout(() => { state.flashId = null; }, FLASH_MS);
  };
  if (state.flashId === id) { state.flashId = null; nextTick(start); } else start();
}
