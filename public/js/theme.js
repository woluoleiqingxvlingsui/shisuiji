/* 拾穗集 —— 明暗主题：跟随系统 → 浅色 → 深色
 * 从 app.js 原样搬过来的，逻辑一字未改。
 */

import { ref, computed } from './vue-globals.js';
import { toast } from './toast.js';

const THEME_KEY = 'danji.theme';
const THEME_MODES = ['auto', 'light', 'dark'];
const THEME_ICON = { auto: '🖥️', light: '☀️', dark: '🌙' };
const THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function readThemeMode() {
  // ?theme=light|dark 临时强制某个明暗（调试/截图用，不写入偏好）
  try {
    const q = new URLSearchParams(location.search).get('theme');
    if (q === 'light' || q === 'dark') return q;
  } catch (e) {}
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return THEME_MODES.includes(saved) ? saved : 'auto';
  } catch (e) { return 'auto'; }
}
const themeMode = ref(readThemeMode());

function applyTheme() {
  const dark = themeMode.value === 'dark' || (themeMode.value === 'auto' && systemDark.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

function cycleTheme() {
  themeMode.value = THEME_MODES[(THEME_MODES.indexOf(themeMode.value) + 1) % THEME_MODES.length];
  try { localStorage.setItem(THEME_KEY, themeMode.value); } catch (e) {}
  applyTheme();
  toast(`主题：${THEME_LABEL[themeMode.value]}`);
}

const themeIcon = computed(() => THEME_ICON[themeMode.value]);
const themeTitle = computed(() => {
  const next = THEME_LABEL[THEME_MODES[(THEME_MODES.indexOf(themeMode.value) + 1) % THEME_MODES.length]];
  return `当前主题：${THEME_LABEL[themeMode.value]}，点击切换到「${next}」`;
});

// 系统偏好变化时（auto 模式下）实时跟随；另一个标签页改了主题也同步
const onSystemThemeChange = () => { if (themeMode.value === 'auto') applyTheme(); };
const onStorageTheme = (e) => {
  if (e.key !== THEME_KEY) return;
  themeMode.value = readThemeMode();
  applyTheme();
};

export { applyTheme, cycleTheme, themeIcon, themeTitle, systemDark, themeMode, onSystemThemeChange, onStorageTheme };
