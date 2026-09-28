/* ---------------- 组件：成果新增 / 编辑抽屉 ---------------- */
import { reactive, ref, onMounted, onUnmounted, nextTick } from '../vue-globals.js';

import { CONFIG } from '../../config.js';

function splitLinks(text) {
  return String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

function splitTags(text) {
  return String(text || '').split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
}

const AchievementEditor = {
  name: 'AchievementEditor',
  props: { initial: { type: Object, default: null } },
  emits: ['save', 'close'],
  setup(props, { emit }) {
    const titleInput = ref(null);
    const cfg = CONFIG.achievements;

    const form = reactive({
      category: props.initial?.category || 'project',
      status: props.initial?.status || 'done',
      title: props.initial?.title || '',
      date: props.initial?.date || '',
      content: props.initial?.content || '',
      highlight: props.initial?.highlight || '',
      linksText: (props.initial?.links || []).join('\n'),
      tagsText: (props.initial?.tags || []).join(', '),
    });

    function save() {
      if (!form.title.trim()) return alert('给这项成果起个标题');
      emit('save', {
        category: form.category,
        status: form.status,
        title: form.title.trim(),
        date: form.date.trim(),
        content: form.content.trim(),
        highlight: form.highlight.trim(),
        links: splitLinks(form.linksText),
        tags: splitTags(form.tagsText),
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
      form, titleInput, save, cfg,
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>{{ initial ? '✏️ 编辑成果' : '🏅 记一项成果' }}</h2>
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

        <p class="drawer-section">状态</p>
        <div class="chip-picks">
          <button type="button" class="chip-pick" v-for="s in cfg.statuses" :key="s.id"
                  :class="{ on: form.status === s.id }" @click="form.status = s.id">
            {{ s.emoji }} {{ s.label }}
          </button>
        </div>

        <label>标题 *
          <input ref="titleInput" v-model="form.title" :maxlength="cfg.titleMax" :placeholder="cfg.titlePlaceholder">
        </label>
        <div class="row">
          <label>时间
            <input v-model="form.date" :placeholder="cfg.datePlaceholder">
            <span class="date-hint">随便写：2026-06、2026 年夏、记不清就写个大概，甚至一句话都行</span>
          </label>
        </div>
        <label>📝 内容：做了什么
          <textarea v-model="form.content" rows="5" class="tall" :placeholder="cfg.contentPlaceholder"></textarea>
        </label>
        <label>📌 亮点摘要（简历可直接用）
          <textarea v-model="form.highlight" rows="2" :placeholder="cfg.highlightPlaceholder"></textarea>
        </label>
        <label>🔗 链接（仓库 / 演示 / DOI）
          <textarea v-model="form.linksText" rows="2" :placeholder="cfg.linksPlaceholder"></textarea>
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

export { AchievementEditor };
