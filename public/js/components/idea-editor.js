/* ---------------- 组件：想法新增 / 编辑抽屉 ---------------- */

import { CONFIG } from '../../config.js';

const IdeaEditor = {
  name: 'IdeaEditor',
  props: { initial: { type: Object, default: null } },
  emits: ['save', 'close'],
  setup(props, { emit }) {
    const { reactive, ref, computed, onMounted, onUnmounted, nextTick } = Vue;
    const titleInput = ref(null);
    const form = reactive({
      title: props.initial?.title || '',
      content: props.initial?.content || '',
    });
    // 题目和内容都不写就没什么可存的——但允许只写其中一个，别拦着灵感
    const canSave = computed(() => !!(form.title.trim() || form.content.trim()));

    function save() {
      if (!canSave.value) return alert('至少写一句：这条灵感是关于什么的');
      emit('save', {
        title: form.title.trim(),
        content: form.content.trim(),
        // 乐观锁：编辑时带上「我改之前看到的时间」，服务端对不上会返回 409
        base_updated_at: props.initial?.updated_at || '',
      });
    }

    const onKey = (e) => { if (e.key === 'Escape') emit('close'); };
    onMounted(async () => {
      window.addEventListener('keydown', onKey);
      await nextTick();
      titleInput.value && titleInput.value.focus();
    });
    onUnmounted(() => window.removeEventListener('keydown', onKey));

    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      form, titleInput, save, canSave, ideas: CONFIG.ideas,
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>{{ initial ? '✏️ 编辑想法' : '💡 记个想法' }}</h2>
        <button class="btn ghost small" @click="close">✕</button>
      </header>
      <form class="drawer-form" @submit.prevent="save">
        <label>💡 这条是关于什么的
          <input ref="titleInput" v-model="form.title" :maxlength="ideas.titleMax"
                 :placeholder="ideas.titlePlaceholder">
        </label>
        <label>📝 灵感
          <textarea class="tall" v-model="form.content" :rows="ideas.contentRows"
                    :placeholder="ideas.contentPlaceholder"></textarea>
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

export { IdeaEditor };
