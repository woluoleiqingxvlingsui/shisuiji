/* 拾穗集 —— 瀑布流列表（M20 任务 E 图2 / 图3）
 *
 * 包裹各板块的卡片列表：把 items 按 util/masonry.js 的贪心算法分到 1~2 列。
 * 分列是 computed —— **只在 items 数组变化时重算**，卡片展开/收起、
 * 图片加载完这类纯高度变化都不会重新分列（这正是不用 CSS columns 的理由）。
 *
 * 过渡动画按施工图 6.2.5 简化为列内淡入：跨列 move 动画在分列模型下没有意义
 * （卡片换列时 Vue 会直接重建节点），不再强行做。
 */

import { computed, onMounted, onUnmounted, ref } from '../vue-globals.js';
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
    const onResize = () => { width.value = window.innerWidth; };
    onMounted(() => window.addEventListener('resize', onResize, { passive: true }));
    onUnmounted(() => window.removeEventListener('resize', onResize));

    const columns = computed(() => {
      if (props.layout === 'list') return [props.items || []];
      const count = props.columns || masonryColumnCount(width.value);
      return distributeIntoColumns(props.items, count, props.estimate || estimateCardHeight);
    });

    const keyOf = (item) => {
      if (!item || typeof item !== 'object') return String(item);
      const field = props.keyField || 'id';
      return field.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), item);
    };

    return { columns, keyOf };
  },
  template: `
    <div class="egg-list masonry" :class="'masonry-' + columns.length">
      <div class="masonry-col" v-for="(col, ci) in columns" :key="ci">
        <slot v-for="item in col" :item="item" :key="keyOf(item)"></slot>
      </div>
    </div>
  `,
};

export { MasonryList };