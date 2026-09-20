/* 拾穗集 —— Vue 全局 API 的出口
 * vendor/vue.global.prod.js 是经典脚本，一定先于 module 执行，所以这里能拿到全局 Vue。
 * 所有模块都从这里 import，不再各自去摸全局，将来换加载方式只改这一个文件。
 */
const {
  createApp, ref, reactive, computed, watch,
  onMounted, onUnmounted, nextTick, provide, inject,
} = window.Vue;

export { createApp, ref, reactive, computed, watch, onMounted, onUnmounted, nextTick, provide, inject };
