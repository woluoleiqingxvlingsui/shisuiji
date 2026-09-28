/* ---------------- 组件：随记新增 / 编辑抽屉 ---------------- */
import { reactive, ref, computed, onMounted, onUnmounted, nextTick } from '../vue-globals.js';

import { CONFIG } from '../../config.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { uploadImage } from '../api.js';
import { useImageUrls } from '../img-urls.js';

const MAX_IMAGES = 9;

const IdeaEditor = {
  name: 'IdeaEditor',
  props: { initial: { type: Object, default: null } },
  emits: ['save', 'close'],
  setup(props, { emit }) {
    const titleInput = ref(null);
    const contentArea = ref(null);
    const fileInput = ref(null);
    const form = reactive({
      title: props.initial?.title || '',
      content: props.initial?.content || '',
      images: (props.initial?.images || []).map((im) => ({ ...im })),
    });
    const uploading = ref(false);
    // 题目和内容都不写就没什么可存的——但允许只写其中一个，别拦着灵感
    const canSave = computed(() => !!(form.title.trim() || form.content.trim()));
    // 离线（手机断网）传不了图：上传要走电脑端
    const offline = computed(() => !!(state.sync && state.sync.enabled && state.sync.offline));

    // 预览已上传的图：与卡片同一 fetch→blob 通道
    const { urls: imgUrls } = useImageUrls(computed(() => form.images));

    // 灵感框随内容自动增高（min/max-height 由 CSS 兜底，超长时框内滚动）
    function autoGrow() {
      const el = contentArea.value;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }

    async function onPickFiles(ev) {
      const files = [...(ev.target.files || [])];
      ev.target.value = ''; // 同名文件也能重复选
      if (!files.length) return;
      if (offline.value) return toast('传图需要连上电脑端，离线时先记文字', 'warn');
      if (form.images.length + files.length > MAX_IMAGES) {
        return alert(`一条随记最多 ${MAX_IMAGES} 张图`);
      }
      uploading.value = true;
      try {
        for (const file of files) {
          if (form.images.length >= MAX_IMAGES) { toast(`最多 ${MAX_IMAGES} 张，多余的没加`, 'warn'); break; }
          const r = await uploadImage(file);
          if (!r.ok || !r.data.id) {
            toast(`「${file.name}」上传失败：${(r.data && r.data.error) || r.status}`, 'warn');
            continue;
          }
          form.images.push({ id: r.data.id, name: file.name });
        }
      } finally {
        uploading.value = false;
      }
    }

    function removeImage(i) {
      form.images.splice(i, 1);
    }

    function save() {
      if (!canSave.value) return alert('至少写一句：这条随记是关于什么的');
      emit('save', {
        title: form.title.trim(),
        content: form.content.trim(),
        images: form.images.map((im) => ({ id: im.id, name: im.name })),
        // 乐观锁：编辑时带上「我改之前看到的时间」，服务端对不上会返回 409
        base_updated_at: props.initial?.updated_at || '',
      });
    }

    const onKey = (e) => { if (e.key === 'Escape') emit('close'); };
    onMounted(async () => {
      window.addEventListener('keydown', onKey);
      await nextTick();
      titleInput.value && titleInput.value.focus();
      autoGrow(); // 编辑已有长内容时，初始高度就要撑开
    });
    onUnmounted(() => window.removeEventListener('keydown', onKey));

    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      form, titleInput, contentArea, fileInput, autoGrow, save, canSave, ideas: CONFIG.ideas,
      uploading, offline, imgUrls, onPickFiles, removeImage, MAX_IMAGES,
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>{{ initial ? '✏️ 编辑随记' : '📝 记条随记' }}</h2>
        <button class="btn ghost small" @click="close">✕</button>
      </header>
      <form class="drawer-form" @submit.prevent="save">
        <label>📝 这条是关于什么的
          <input ref="titleInput" v-model="form.title" :maxlength="ideas.titleMax"
                 :placeholder="ideas.titlePlaceholder">
        </label>
        <label>📝 内容
          <textarea ref="contentArea" class="tall grow" v-model="form.content" :rows="ideas.contentRows"
                    @input="autoGrow" :placeholder="ideas.contentPlaceholder"></textarea>
        </label>
        <p class="drawer-section">🖼 图片（原图保存，最多 {{ MAX_IMAGES }} 张）</p>
        <div class="idea-imgs" v-if="form.images.length">
          <span class="idea-img" v-for="(im, i) in form.images" :key="im.id" :title="im.name">
            <img v-if="imgUrls[im.id]" :src="imgUrls[im.id]" :alt="im.name" loading="lazy">
            <button type="button" class="idea-img-x" @click="removeImage(i)" title="移除这张图">✕</button>
          </span>
        </div>
        <label class="idea-img-add">
          <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/gif,image/webp"
                 multiple :disabled="uploading || offline" @change="onPickFiles">
          <span class="btn ghost small">
            {{ uploading ? '⏳ 上传中…' : (offline ? '🖼 加图片（需连上电脑端）' : '🖼 加图片') }}
          </span>
        </label>
        <footer class="drawer-foot">
          <button type="button" class="btn ghost" @click="close">取消</button>
          <button type="submit" class="btn primary" :disabled="uploading">💾 保存</button>
        </footer>
      </form>
    </aside>
  </div>
  `,
};

export { IdeaEditor };
