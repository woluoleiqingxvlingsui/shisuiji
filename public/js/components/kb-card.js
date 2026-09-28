/* ---------------- 组件：知识库卡片 ---------------- */
// 类别徽章 + 标题 + 内容（默认折 3 行）+ 标签 + 来源引用。桌面可编辑删除，手机只读。
import { computed, ref, onMounted, onUnmounted, nextTick } from '../vue-globals.js';

import { CONFIG } from '../../config.js';
import { canWrite } from '../perm.js';
import { formatDate } from '../util/date.js';

function categoryMeta(id) {
  return CONFIG.kb.categories.find((c) => c.id === id)
    || { id: 'other', label: '其他', emoji: '✨', hue: 320 };
}

const SOURCE_LABEL = { paper: '论文', site: '网页', idea: '想法', manual: '手动' };

const KbCard = {
  name: 'KbCard',
  props: { entry: { type: Object, required: true } },
  emits: ['edit', 'remove'],
  setup(props, { emit }) {
    const cat = computed(() => categoryMeta(props.entry.category));
    const catStyle = computed(() => ({ '--h': cat.value.hue }));
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
    const onResize = () => measure();
    onMounted(async () => {
      await nextTick();
      measure();
      window.addEventListener('resize', onResize);
    });
    onUnmounted(() => window.removeEventListener('resize', onResize));
    function toggleExpand() { expanded.value = !expanded.value; }

    return {
      cat, catStyle, timeText, sourceText, writable,
      expanded, contentEl, clampable, toggleExpand,
      emitEdit: () => emit('edit'),
      emitRemove: () => emit('remove'),
    };
  },
  template: `
  <article class="card kb-card">
    <div class="card-head">
      <span class="cat-chip" :style="catStyle">{{ cat.emoji }} {{ cat.label }}</span>
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
      <button class="btn small ghost" @click="emitEdit">✏️ 编辑</button>
      <button class="btn small danger" @click="emitRemove">🗑</button>
    </div>
  </article>
  `,
};

export { KbCard };
