/* ---------------- 组件：知识库新增 / 编辑抽屉 ---------------- */
import { reactive, ref, onMounted, onUnmounted, nextTick } from '../vue-globals.js';

import { CONFIG } from '../../config.js';

function splitTags(text) {
  // 支持中英文逗号、顿号、分号与换行；存盘格式仍是 string[]
  return String(text || '').split(/[,，、;；\n]/).map((s) => s.trim()).filter(Boolean);
}

const KbEditor = {
  name: 'KbEditor',
  props: {
    initial: { type: Object, default: null },   // 编辑已有条目
    prefill: { type: Object, default: null },   // 一键沉淀的预填（新条目）
    // 已有标签快捷胶囊：boards/kb.js 的 kbTagOptions（[{ tag, count }]，按使用次数倒序）
    knownTags: { type: Array, default: () => [] },
  },
  emits: ['save', 'close'],
  setup(props, { emit }) {
    const titleInput = ref(null);
    const contentArea = ref(null);
    const cfg = CONFIG.kb;
    const base = props.initial || props.prefill || {};

    const form = reactive({
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

    // 已有标签快捷胶囊：点一下把标签加进输入框；已经在输入框里的再点一次移除。
    // 匹配按 splitTags 得到的整词（支持中英文逗号/顿号分隔），输入框始终可自由手打新标签。
    function hasTag(tag) {
      return splitTags(form.tagsText).includes(String(tag));
    }
    function toggleTag(tag) {
      const t = String(tag || '').trim();
      if (!t) return;
      const list = splitTags(form.tagsText);
      const i = list.indexOf(t);
      if (i >= 0) list.splice(i, 1); else list.push(t);
      form.tagsText = list.join(', ');
    }

    function save() {
      if (!form.title.trim() && !form.content.trim()) return alert('标题和内容至少写一个');
      emit('save', {
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
      hasTag, toggleTag,
      isDeposit: !!props.prefill && !props.initial,
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside v-dialog class="drawer">
      <header class="drawer-head">
        <h2>{{ initial ? '✏️ 编辑知识' : (isDeposit ? '📚 沉淀到知识库' : '📚 记一条知识') }}</h2>
        <button class="btn ghost small" @click="close" aria-label="关闭编辑窗口">✕</button>
      </header>
      <form class="drawer-form" @submit.prevent="save">
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
        <!-- M21-B：复用输入过的标签。点一下加入输入框，已加入的再点一下移除 -->
        <div class="kb-tag-picks" v-if="knownTags.length">
          <span class="kb-tag-picks-label">已有标签</span>
          <button type="button" class="chip" v-for="t in knownTags" :key="t.tag"
                  :class="{ on: hasTag(t.tag) }" :aria-pressed="hasTag(t.tag) ? 'true' : 'false'"
                  :title="hasTag(t.tag) ? '点一下从标签输入框移除' : '点一下把此标签加入输入框'"
                  @click="toggleTag(t.tag)">
            #{{ t.tag }}<sup>{{ t.count }}</sup>
          </button>
        </div>
        <footer class="drawer-foot">
          <button type="button" class="btn ghost" @click="close">取消</button>
          <button type="submit" class="btn primary"><app-icon name="save"></app-icon> 保存</button>
        </footer>
      </form>
    </aside>
  </div>
  `,
};

export { KbEditor };
