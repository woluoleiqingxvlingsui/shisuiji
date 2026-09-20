/* ---------------- 组件：网页新增 / 编辑抽屉 ---------------- */
import { reactive, ref, computed, onMounted, onUnmounted, nextTick } from '../vue-globals.js';

import { CONFIG } from '../../config.js';
import { api } from '../api.js';
import { normalizeUrl } from '../util/text.js';

const SiteEditor = {
  name: 'SiteEditor',
  props: {
    initial: { type: Object, default: null },
    knownUrls: { type: Array, default: () => [] }, // 已记录过的链接，用来提示重复
  },
  emits: ['save', 'close'],
  setup(props, { emit }) {
    const urlInput = ref(null);

    const form = reactive({
      url: props.initial?.url || '',
      title: props.initial?.title || '',
      kind: props.initial?.kind || localStorage.getItem('danji.lastSiteKind') || 'tech',
      status: props.initial?.status || 'to_read',
      tagsText: (props.initial?.tags || []).join(', '),
      notes: props.initial?.notes || '',
    });

    const fetching = ref(false);
    const titleHint = ref('');
    const duplicate = computed(() => {
      if (props.initial) return false; // 编辑自己不算重复
      const url = normalizeUrl(form.url);
      return !!url && props.knownUrls.includes(url);
    });

    // 抓标题：只在标题还空着的时候自动填，不覆盖手写的内容；force=true 是点「自动取标题」
    async function fetchTitle(force = false) {
      const url = normalizeUrl(form.url);
      if (!url) return;
      if (!force && form.title.trim()) return;
      fetching.value = true;
      titleHint.value = '';
      try {
        const r = await api('/api/sites/title?url=' + encodeURIComponent(url)).then((x) => x.json());
        if (r.title) {
          form.title = r.title;
          titleHint.value = '已自动取到网页标题，可以自己改';
        } else {
          titleHint.value = '没取到标题（页面可能要 JS 渲染），手填一个就行';
        }
      } catch {
        titleHint.value = '没取到标题，手填一个就行';
      }
      fetching.value = false;
    }

    // 离开链接输入框时自动取一次标题（防抖 150ms，避免边打字边请求）
    let blurTimer = null;
    function onUrlBlur() {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(() => fetchTitle(false), 150);
    }

    function save() {
      const url = normalizeUrl(form.url);
      if (!url) return alert('请填写合法的链接（http / https，裸域名会自动补 https://）');
      if (!form.title.trim()) return alert('请填写标题，或点「自动取标题」');
      localStorage.setItem('danji.lastSiteKind', form.kind);
      emit('save', {
        url,
        title: form.title.trim(),
        kind: form.kind,
        status: form.status,
        tags: form.tagsText.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
        notes: form.notes.trim(),
      });
    }

    const onKey = (e) => { if (e.key === 'Escape') emit('close'); };
    onMounted(async () => {
      window.addEventListener('keydown', onKey);
      await nextTick();
      urlInput.value && urlInput.value.focus();
    });
    onUnmounted(() => window.removeEventListener('keydown', onKey));

    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      form, urlInput, fetching, titleHint, duplicate, onUrlBlur, fetchTitle, save,
      kindOptions: CONFIG.siteNote.kinds,
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>{{ initial ? '✏️ 编辑网页' : '🌐 记一个待读网页' }}</h2>
        <button class="btn ghost small" @click="close">✕</button>
      </header>
      <form class="drawer-form" @submit.prevent="save">
        <label>🔗 链接 *
          <input ref="urlInput" v-model="form.url" @blur="onUrlBlur"
                 placeholder="粘贴网址，或直接写 example.com">
          <span class="date-hint" v-if="duplicate">⚠️ 这个链接已经记过了，保存会出现两条</span>
        </label>
        <label>标题 *
          <input v-model="form.title" placeholder="标题；留空点下面的按钮自动取">
          <button type="button" class="mini-link" :disabled="fetching" @click="fetchTitle(true)">
            {{ fetching ? '取标题中…' : '🔄 自动取标题' }}
          </button>
          <span class="date-hint" v-if="titleHint">{{ titleHint }}</span>
        </label>

        <p class="drawer-section">类型（决定读完时的引导表单）</p>
        <div class="chip-picks">
          <button type="button" class="chip-pick" v-for="k in kindOptions" :key="k.id"
                  :class="{ on: form.kind === k.id }" @click="form.kind = k.id">
            {{ k.emoji }} {{ k.label }}
          </button>
        </div>

        <div class="row">
          <label>状态
            <select v-model="form.status">
              <option value="to_read">📖 待读</option>
              <option value="read">✅ 已读</option>
            </select>
          </label>
        </div>
        <label>🏷️ 标签
          <input v-model="form.tagsText" placeholder="逗号分隔，如：RAG, 工具, 长文">
        </label>
        <label>📝 备注（为什么收藏它）
          <textarea v-model="form.notes" rows="2" placeholder="例：群里推荐的，说是把 KV cache 讲得最清楚的一篇"></textarea>
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

export { SiteEditor };
