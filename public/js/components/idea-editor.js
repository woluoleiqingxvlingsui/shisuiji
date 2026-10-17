/* ---------------- 组件：随记新增 / 编辑抽屉 ---------------- */
import { reactive, ref, computed, onMounted, onUnmounted, nextTick } from '../vue-globals.js';

import { CONFIG } from '../../config.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { uploadImage } from '../api.js';
import { saveLocalImage, deleteLocalImage } from '../local-images.js';
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
    // 本次编辑里新存进本机仓的 local id：取消编辑时据此清理，不留下没人引用的 blob
    const sessionLocalIds = new Set();
    let savedFromEditor = false;
    // 题目和内容都不写就没什么可存的——但允许只写其中一个，别拦着灵感
    const canSave = computed(() => !!(form.title.trim() || form.content.trim()));
    // 离线（手机断网）：图片先存本机 IndexedDB，随记照常保存，联网后同步时自动上传
    const offline = computed(() => !!(state.sync && state.sync.enabled && state.sync.offline));
    const saving = computed(() => state.ideaSaving);

    // 预览图片：服务端图走 fetch→blob，local 图直接从本机 IDB 取（同一通道，见 img-urls.js）
    const { urls: imgUrls } = useImageUrls(computed(() => form.images));

    // 只有手机同步层在场（有 outbox，联网后会自动上传本地图）才允许把图先存本机；
    // 电脑端直连 REST 没有待发队列，local:<uuid> 发给服务端会被 sanitizeImages 丢掉，
    // 所以电脑端上传失败仍按旧行为提示失败，不落地“永远不会同步”的本地图。
    const canStoreLocal = computed(() => !!(state.sync && state.sync.enabled));

    // 在线失败的分类：4xx（口令/限流/超时除外）说明文件本身不被接受，重试也传不上去，
    // 这种不回落本地仓——否则它会永远卡在待同步队列里。
    function permanentUploadStatus(status) {
      return status >= 400 && status < 500
        && status !== 401 && status !== 403 && status !== 408 && status !== 429;
    }

    /** 先把图片存进本机仓（离线 / 在线临时失败），进 form.images 的 id 是 local:<uuid> */
    async function keepLocal(file) {
      try {
        const rec = await saveLocalImage(file, file.name);
        sessionLocalIds.add(rec.id);
        form.images.push(rec);
        return rec;
      } catch (err) {
        toast(`「${file.name}」存本机失败：${(err && err.message) || err}`, 'warn');
        return null;
      }
    }

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
      if (form.images.length + files.length > MAX_IMAGES) {
        return alert(`一条随记最多 ${MAX_IMAGES} 张图`);
      }
      uploading.value = true;
      let localCount = 0;
      try {
        for (const file of files) {
          if (form.images.length >= MAX_IMAGES) { toast(`最多 ${MAX_IMAGES} 张，多余的没加`, 'warn'); break; }
          // 已知离线：直接存本机，随记照常进 outbox，联网同步时 push 前自动上传
          if (offline.value) {
            if (await keepLocal(file)) localCount += 1;
            continue;
          }
          let r = null;
          try {
            r = await uploadImage(file);
          } catch (err) {
            // 网络异常（断网 / 超时 / 原生桥失败）：兜底存本机
            r = { ok: false, status: 0, data: { error: (err && err.message) || '网络异常' } };
          }
          if (r.ok && r.data.id) {
            form.images.push({ id: r.data.id, name: file.name });
            continue;
          }
          if (permanentUploadStatus(r.status)) {
            toast(`「${file.name}」上传失败：${(r.data && r.data.error) || r.status}`, 'warn');
            continue;
          }
          // 电脑端没有待发队列：按旧行为只提示失败，不存本地（否则 local id 存不进服务端）
          if (!canStoreLocal.value) {
            toast(`「${file.name}」上传失败：${(r.data && r.data.error) || '网络异常'}`, 'warn');
            continue;
          }
          // 服务器/网络暂时抽风：先存本机，联网后自动重传（不丢用户选的图）
          if (await keepLocal(file)) {
            toast(`「${file.name}」没传上去，已先存本机，联网后自动上传`, 'warn');
          }
        }
      } finally {
        uploading.value = false;
      }
      if (localCount) toast(`离线：${localCount} 张图已存本机，联网后自动上传 📥`, 'ok');
    }

    function removeImage(i) {
      const im = form.images[i];
      const id = im && im.id;
      // 本次编辑里刚存进本机、还没进过 outbox 的图：表单一移除就没人引用了，当场删掉；
      // 已在队列里的本地图不在这删——保存时由 engine 对比新旧 payload 统一清理，
      // 这样「移除后又取消」不会误删还没同步的本地图。
      form.images.splice(i, 1);
      if (id && sessionLocalIds.has(id)) {
        sessionLocalIds.delete(id);
        deleteLocalImage(id).catch(() => { /* 尽力而为 */ });
      }
    }

    function save() {
      if (!canSave.value) return alert('至少写一句：这条随记是关于什么的');
      savedFromEditor = true; // 已交给上层入队：本机图的清理交给同步引擎按队列引用做
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
    onUnmounted(() => {
      window.removeEventListener('keydown', onKey);
      // 本次编辑新存本机的图，若最终没保存（取消 / 点遮罩关闭），队列和随记都不会引用它们，
      // 关抽屉时尽力删掉，避免离线图片仓里越积越多。保存成功则交给 engine 按队列引用清理。
      if (!savedFromEditor) {
        for (const id of sessionLocalIds) {
          deleteLocalImage(id).catch(() => { /* 尽力而为，删不掉也不影响界面 */ });
        }
      }
    });

    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      form, titleInput, contentArea, fileInput, autoGrow, save, canSave, ideas: CONFIG.ideas,
      uploading, offline, saving, imgUrls, onPickFiles, removeImage, MAX_IMAGES,
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside v-dialog class="drawer">
      <header class="drawer-head">
        <h2>{{ initial ? '✏️ 编辑随记' : '📝 记条随记' }}</h2>
        <button class="btn ghost small" @click="close" aria-label="关闭编辑窗口">✕</button>
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
                 multiple :disabled="uploading" @change="onPickFiles">
          <span class="btn ghost small">{{ uploading ? '⏳ 处理中…' : '🖼 加图片' }}</span>
        </label>
        <p class="date-hint" v-if="offline">离线也会先存本机，联网后自动上传</p>
        <footer class="drawer-foot">
          <button type="button" class="btn ghost" @click="close">取消</button>
          <button type="submit" class="btn primary" :disabled="uploading || saving || !canSave"><app-icon name="save"></app-icon>{{ saving ? '保存中…' : '保存' }}</button>
        </footer>
      </form>
    </aside>
  </div>
  `,
};

export { IdeaEditor };
