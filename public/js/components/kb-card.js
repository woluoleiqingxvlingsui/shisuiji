/* ---------------- 组件：知识库卡片 ---------------- */
// 标题 + 内容（默认折 3 行）+ 标签 + 来源引用。桌面可编辑删除，手机只读。
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from '../vue-globals.js';

import { canWrite } from '../perm.js';
import { formatDate } from '../util/date.js';

const SOURCE_LABEL = { paper: '论文', site: '网页', idea: '想法', manual: '手动' };

const KbCard = {
  name: 'KbCard',
  props: { entry: { type: Object, required: true } },
  emits: ['edit', 'remove'],
  setup(props, { emit }) {
    const timeText = computed(() => formatDate(props.entry.updated_at || props.entry.created_at));
    const sourceText = computed(() => {
      const s = props.entry.source;
      if (!s || !s.label) return '';
      return `源自${SOURCE_LABEL[s.type] || '手动'}：${s.label}`;
    });
    const writable = computed(() => canWrite('kb'));

    // 与想法卡片同一套折叠：默认 3 行，细看展开
    const expanded = ref(false);
    const contentEl = ref(null);
    const clampable = ref(false);
    function measure() {
      const el = contentEl.value;
      if (!el) return;
      clampable.value = el.scrollHeight > el.clientHeight + 2;
    }
    // 内容改了必须重测。列表按 id 复用同一个卡片，onMounted 不会因为编辑再跑一遍：
    // 留着旧的 clampable，就会出现「文字被截断了却没有展开按钮」（刷新页面能恢复就是这个原因），
    // 或者反过来「没截断却挂着展开按钮」。
    watch(() => props.entry.content, async () => { await nextTick(); measure(); });
    // 展开/收起切换后也重测，clampable 始终描述「折起来时会不会被截断」
    watch(expanded, async () => { await nextTick(); measure(); });
    const onResize = () => measure();
    onMounted(async () => {
      await nextTick();
      measure();
      window.addEventListener('resize', onResize);
    });
    onUnmounted(() => window.removeEventListener('resize', onResize));
    function toggleExpand() { expanded.value = !expanded.value; }

    return {
      timeText, sourceText, writable,
      expanded, contentEl, clampable, toggleExpand,
      emitEdit: () => emit('edit'),
      emitRemove: () => emit('remove'),
    };
  },
  template: `
  <article class="card kb-card">
    <div class="card-head">
      <h3 class="title">{{ entry.title || '（没写标题）' }}</h3>
      <span class="idea-time">{{ timeText }}</span>
    </div>
    <p class="kb-content" :class="{ clamped: !expanded }" ref="contentEl" v-if="entry.content">{{ entry.content }}</p>
    <p class="kb-content empty-content" v-else>还没写内容</p>
    <button type="button" class="idea-toggle" v-if="entry.content && (clampable || expanded)" @click.stop="toggleExpand">
      {{ expanded ? '收起 ⌃' : '展开 ⌄' }}
    </button>
    <div class="ach-meta" v-if="(entry.tags && entry.tags.length) || sourceText">
      <span class="ach-tag" v-for="t in entry.tags" :key="t">#{{ t }}</span>
      <span class="kb-source" v-if="sourceText" :title="sourceText">📎 {{ sourceText }}</span>
    </div>
    <div class="card-actions" @click.stop v-if="writable">
      <span class="spacer"></span>
      <button class="btn small ghost" @click="emitEdit"><app-icon name="edit"></app-icon>编辑</button>
      <button class="btn small danger" @click="emitRemove" title="删除记录" aria-label="删除记录"><app-icon name="trash"></app-icon></button>
    </div>
  </article>
  `,
};

export { KbCard };
