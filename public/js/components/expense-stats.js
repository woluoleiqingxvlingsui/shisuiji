/* ---------------- 组件：花销统计卡（期间切换 + 饼图 + 图例） ---------------- */

import { formatMoney } from '../util/money.js';

const ExpenseStats = {
  name: 'ExpenseStats',
  props: {
    period: { type: Object, required: true },
    slices: { type: Array, required: true },
    total: { type: Number, required: true },
    count: { type: Number, required: true },
    yearOptions: { type: Array, required: true },
    label: { type: String, required: true },
    level: { type: String, default: 'item' },              // 'category' = 套餐/API 总览，可点下钻
    selectedCategory: { type: String, default: '' },       // 已下钻的类别
    categories: { type: Array, default: () => [] },
  },
  emits: ['mode', 'year', 'month', 'step', 'pick', 'clear'],
  setup(props, { emit }) {
    const { computed } = Vue;
    const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    // 饼图：每笔 / 每个类别一个扇区，颜色由 id（或类别自带色相）稳定生成。
    // conic-gradient 的 0% 起点在 12 点方向、顺时针增大，和 onPieClick 的角度算法同一套约定
    const gradient = computed(() => {
      if (!props.slices.length) return '';
      const stops = props.slices.map((s) => `hsl(${s.hue} 62% 52%) ${s.from.toFixed(2)}% ${s.to.toFixed(2)}%`);
      return `conic-gradient(${stops.join(', ')})`;
    });
    const pctText = (p) => (p >= 10 ? p.toFixed(1) : p.toFixed(2)) + '%';
    const dotStyle = (s) => ({ background: `hsl(${s.hue} 62% 52%)` });
    const selectedMeta = computed(() => props.categories.find((c) => c.id === props.selectedCategory) || null);
    const canPick = computed(() => props.level === 'category');

    // 点饼图：按点击位置算角度（12 点方向为 0°、顺时针，与 conic-gradient 的 0% 起点一致），
    // 落在哪个扇区就下钻到哪个类别；点在圆外忽略
    function onPieClick(e) {
      if (!canPick.value) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      if (Math.hypot(dx, dy) > rect.width / 2) return;
      let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
      if (deg < 0) deg += 360;
      const pct = (deg / 360) * 100;
      const hit = props.slices.find((s) => pct >= s.from && pct < s.to);
      if (hit) emit('pick', hit.id);
    }
    function onLegendClick(s) {
      if (canPick.value) emit('pick', s.id);
    }

    return {
      MONTHS, gradient, pctText, dotStyle, selectedMeta, canPick, onPieClick, onLegendClick, formatMoney,
      setMode: (m) => emit('mode', m),
      setYear: (e) => emit('year', Number(e.target.value)),
      setMonth: (e) => emit('month', Number(e.target.value)),
      step: (d) => emit('step', d),
      clear: () => emit('clear'),
    };
  },
  template: `
  <section class="stat-card">
    <header class="stat-head">
      <div class="stat-modes">
        <button class="tab" :class="{ active: period.mode === 'month' }" @click="setMode('month')">按月</button>
        <button class="tab" :class="{ active: period.mode === 'year' }" @click="setMode('year')">按年</button>
      </div>
      <div class="stat-picker">
        <button class="btn small ghost" @click="step(-1)" title="上一个期间">←</button>
        <select class="platform-select" :value="period.year" @change="setYear">
          <option v-for="y in yearOptions" :key="y" :value="y">{{ y }} 年</option>
        </select>
        <select class="platform-select" v-if="period.mode === 'month'" :value="period.month" @change="setMonth">
          <option v-for="m in MONTHS" :key="m" :value="m">{{ m }} 月</option>
        </select>
        <button class="btn small ghost" @click="step(1)" title="下一个期间">→</button>
      </div>
      <span class="stat-right">
        <span class="stat-count" v-if="count">共 {{ count }} 笔 · <b class="money">{{ formatMoney(total) }}</b></span>
        <button class="filter-chip" v-if="selectedMeta" @click="clear"
                :title="'返回套餐 / API 总览'">
          正在看 {{ selectedMeta.emoji }} {{ selectedMeta.label }} ✕
        </button>
      </span>
    </header>

    <div class="stat-body" v-if="slices.length">
      <div class="pie" :class="{ clickable: canPick }" :style="{ background: gradient }"
           :title="canPick ? '点扇区看这个类别的明细' : ''" @click="onPieClick"></div>
      <ul class="pie-legend">
        <li class="legend-row" :class="{ clickable: canPick }" v-for="s in slices" :key="s.id"
            :title="canPick ? '点这一行看 ' + s.title + ' 的明细' : s.title + ' · ' + formatMoney(s.amount)"
            @click="onLegendClick(s)">
          <span class="legend-dot" :style="dotStyle(s)"></span>
          <span class="legend-title" :class="{ merged: s.merged }">{{ s.title }}</span>
          <span class="legend-count" v-if="s.count > 1">×{{ s.count }}</span>
          <span class="legend-amount">{{ formatMoney(s.amount) }}</span>
          <span class="legend-pct">{{ pctText(s.pct) }}</span>
        </li>
      </ul>
    </div>
    <div class="stat-empty" v-else>
      <div class="pie-empty"></div>
      <p>{{ label }} 还没有花销记录</p>
    </div>
  </section>
  `,
};

export { ExpenseStats };
