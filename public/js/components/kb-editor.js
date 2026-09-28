/* ---------------- 组件：知识库新增 / 编辑抽屉 ---------------- */
import { reactive, ref, onMounted, onUnmounted, nextTick } from '../vue-globals.js';

import { CONFIG } from '../../config.js';

function splitTags(text) {
  return String(text || '').split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
}

const KbEditor = {
  name: 'KbEditor',
  props: {
    initial: { type: Object, default: null },   // 编辑已有条目
    prefill: { type: Object, default: null },   // 一键沉淀的预填（新条目）
  },
  emits: ['save', 'close'],
  setup(props, { emit }) {
    const titleInput = ref(null);
    const contentArea = ref(null);
    const cfg = CONFIG.kb;
    const base = props.initial || props.prefill || {};

    const form = reactive({
      category: base.category || 'other',
      title: base.title || '',
      content: base.content || '',
      tagsText: (base.tags || []).join(', '),
    });
    const source = base.source && base.source.label ? base.source : null;

    function autoGrow() {
      const el = contentArea.value;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }

    function save() {
      if (!form.title.trim() && !form.content.trim()) return alert('标题和内容至少写一个');
      emit('save', {
        category: form.category,
        title: form.title.trim(),
        content: form.content.trim(),
        tags: splitTags(form.tagsText),
        source: base.source || { type: 'manual' },
        // 乐观锁：编辑时带上「我改之前看到的时间」
        base_updated_at: props.initial?.updated_at || '',
      });
    }

    const onKey = (e) => { if (e.key === 'Escape') emit('close'); };
    onMounted(async () => {
      window.addEventListener('keydown', onKey);
      await nextTick();
      titleInput.value && titleInput.value.focus();
      autoGrow();
    });
    onUnmounted(() => window.removeEventListener('keydown', onKey));

    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      form, titleInput, contentArea, autoGrow, save, source, cfg,
      isDeposit: !!props.prefill && !props.initial,
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>{{ initial ? '✏️ 编辑知识' : (isDeposit ? '📚 沉淀到知识库' : '📚 记一条知识') }}</h2>
        <button class="btn ghost small" @click="close">✕</button>
      </header>
      <form class="drawer-form" @submit.prevent="save">
        <p class="drawer-section">类别</p>
        <div class="chip-picks">
          <button type="button" class="chip-pick" v-for="c in cfg.categories" :key="c.id"
                  :class="{ on: form.category === c.id }" @click="form.category = c.id">
            {{ c.emoji }} {{ c.label }}
          </button>
        </div>
        <p class="kb-source-line" v-if="source">📎 源自：{{ source.label }}</p>
        <label>标题
          <input ref="titleInput" v-model="form.title" :maxlength="cfg.titleMax" :placeholder="cfg.titlePlaceholder">
        </label>
        <label>📝 内容
          <textarea ref="contentArea" class="tall grow" v-model="form.content" rows="5"
                    @input="autoGrow" :placeholder="cfg.contentPlaceholder"></textarea>
        </label>
        <label>🏷️ 标签
          <input v-model="form.tagsText" :placeholder="cfg.tagsPlaceholder">
        </label>
        <footer class="drawer-foot">
          <button type="button" class="btn ghost" @click="close">取消</button>
          <button type="submit" class="btn primary">💾 保存</button>
        </footer>
      </form>
    </aside>
  </div>
  `,
};

export { KbEditor };
