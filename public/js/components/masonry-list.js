/* 拾穗集 —— 瀑布流列表（M20 任务 E 图2 / 图3）
 *
 * 包裹各板块的卡片列表：把 items 分到 1~2 列。
 *
 * 分列依据：**卡片真实渲染高度**，不是预估。
 *   首屏先用预估（或上次量过的高度）分一次，渲染完立刻量真实高度再重分一次；
 *   两次都在同一个微任务里完成，浏览器只画一次，看不到中间态。
 *   为什么不再只靠预估：估错会翻掉「两列谁更短」的判定，一次翻错会级联 ——
 *   实际出现过 3/5 分列、短列空 340px，起因只是某个标题折行判错 28px。
 *
 * 仍然守住的规矩：只在 items / 列数 / 视口宽度变化时重分。
 *   卡片展开 / 收起、图片加载完都不重分，卡片不会跨列乱跳。
 */

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from '../vue-globals.js';
import { distributeIntoColumns, estimateCardHeight, masonryColumnCount } from '../util/masonry.js';

const MasonryList = {
  name: 'MasonryList',
  props: {
    items: { type: Array, default: () => [] },
    // 'grid' 双列瀑布流 / 'list' 单列；与 workspace 的布局开关同源
    layout: { type: String, default: 'grid' },
    // 单列布局下由 CSS 负责，这里不参与分列
    estimate: { type: Function, default: null },
    // 显式列数覆盖：null = 跟随断点（宽屏 2 列）。
    // 成果时间线按年份分组、组内条目少且卡片高，强制 1 列 —— 必须在组件层
    // 就只分一列，不能靠 CSS 事后合并：两个 .masonry-col 纵向堆叠会把卡片
    // 顺序错成 1,3,5…2,4,6…。
    columns: { type: Number, default: null },
    // 取哪个字段当 key：绝大多数板块用 item.id；
    // 花销体感行的数据形状是 { subject, insight, verdict }，要走 subject.id
    keyField: { type: String, default: 'id' },
  },
  setup(props) {
    const width = ref(typeof window === 'undefined' ? 1280 : window.innerWidth);
    const listEl = ref(null);
    // 量完之后 bump 一下，让 columns 拿真实高度重算
    const rev = ref(0);
    // item key -> 真实渲染高度。只用于「两列谁更短」的相对比较
    const heightCache = new Map();

    const onResize = () => { width.value = window.innerWidth; };
    onMounted(() => window.addEventListener('resize', onResize, { passive: true }));
    onUnmounted(() => window.removeEventListener('resize', onResize));

    const keyOf = (item) => {
      if (!item || typeof item !== 'object') return String(item);
      const field = props.keyField || 'id';
      return field.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), item);
    };

    const count = computed(() => {
      if (props.layout === 'list') return 1;
      return props.columns || masonryColumnCount(width.value);
    });
    // 双列时桌面端正文是折叠态，预估要跟着截断（只影响首屏那一瞬）
    const options = computed(() => ({ clampRows: count.value > 1 }));

    // 量过就用真实高度，没量过才回落到预估
    const estimate = (item, opts) => {
      const measured = heightCache.get(keyOf(item));
      if (typeof measured === 'number' && measured > 0) return measured;
      return (props.estimate || estimateCardHeight)(item, opts);
    };

    const columns = computed(() => {
      void rev.value; // 依赖：量完真实高度后重算
      const list = props.items || [];
      if (count.value <= 1) return [list];
      return distributeIntoColumns(list, count.value, estimate, options.value);
    });

    // 渲染完把真实高度读回来；有变化就重分一次（同一个微任务里完成，不闪）
    async function measure() {
      if (count.value <= 1) return;
      await nextTick();
      const el = listEl.value;
      if (!el) return;
      const colEls = el.querySelectorAll('.masonry-col');
      if (!colEls.length) return;
      const snapshot = columns.value;
      let changed = false;
      for (let ci = 0; ci < colEls.length; ci++) {
        const items = snapshot[ci] || [];
        const kids = colEls[ci].children;
        for (let j = 0; j < kids.length; j++) {
          const item = items[j];
          if (!item) continue;
          const h = kids[j].getBoundingClientRect().height;
          if (!h) continue;
          const k = keyOf(item);
          const prev = heightCache.get(k);
          if (prev === undefined || Math.abs(prev - h) > 1) {
            heightCache.set(k, h);
            changed = true;
          }
        }
      }
      if (changed) rev.value++;
    }

    // 只在「条目变了 / 列数变了」时重分：展开收起、图片加载完都不会触发
    watch([() => props.items, count], () => { measure(); });
    // 视口宽度变了列宽也变，卡片高度会变 —— 缓存作废重新量
    watch(width, () => { heightCache.clear(); measure(); });
    onMounted(() => { measure(); });

    return { columns, keyOf, listEl };
  },
  template: `
    <div class="egg-list masonry" :class="'masonry-' + columns.length" ref="listEl">
      <div class="masonry-col" v-for="(col, ci) in columns" :key="ci">
        <slot v-for="item in col" :item="item" :key="keyOf(item)"></slot>
      </div>
    </div>
  `,
};

export { MasonryList };
