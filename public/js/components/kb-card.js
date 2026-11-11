/* ---------------- 组件：知识库卡片 ---------------- */
// 标题 + 内容（默认折 3 行）+ 标签 + 来源引用。桌面可编辑删除，手机只读。
// 长内容进全屏页看（content-page）：窄列里把长文拉成一条不好读。
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from '../vue-globals.js';

import { canWrite, isDesktop } from '../perm.js';
import { state } from '../state.js';
import { formatDate } from '../util/date.js';
import { kbFileName, kbFileStatusText } from '../util/kb-file.js';

const SOURCE_LABEL = { paper: '论文', site: '网页', idea: '想法', manual: '手动' };

const KbCard = {
  name: 'KbCard',
  props: { entry: { type: Object, required: true } },
  emits: ['edit', 'remove', 'openFull', 'openFile', 'updateFile'],
  setup(props, { emit }) {
    const timeText = computed(() => formatDate(props.entry.updated_at || props.entry.created_at));
    const sourceText = computed(() => {
      const s = props.entry.source;
      if (!s || !s.label) return '';
      return `源自${SOURCE_LABEL[s.type] || '手动'}：${s.label}`;
    });
    const writable = computed(() => canWrite('kb'));
    // 关联的本地文件：只显示文件名（路径不进模板），状态单独查
    const filePath = computed(() => String(props.entry.file_path || ''));
    const fileName = computed(() => (filePath.value ? kbFileName(filePath.value) : ''));
    const fileStatus = computed(() => (state.kbFileStatus || {})[props.entry.id] || '');
    const fileWarn = computed(() => kbFileStatusText(fileStatus.value));
    const desktopApp = computed(() => isDesktop());

    // 与想法卡片同一套折叠：默认 3 行（知识卡一律折着，展开改成进全屏页）
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
    const onResize = () => measure();
    onMounted(async () => {
      await nextTick();
      measure();
      window.addEventListener('resize', onResize);
    });
    onUnmounted(() => window.removeEventListener('resize', onResize));

    return {
      timeText, sourceText, writable,
      filePath, fileName, fileStatus, fileWarn, desktopApp,
      expanded, contentEl, clampable,
      emitEdit: () => emit('edit'),
      emitRemove: () => emit('remove'),
      // 长内容进全屏页看（应用内视图，不是新标签页）
      emitOpenFull: () => emit('openFull'),
      // 打开关联的本地文件 / 重新关联（都只在电脑端）
      emitOpenFile: () => emit('openFile'),
      emitUpdateFile: () => emit('updateFile'),
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
    <button type="button" class="idea-toggle" v-if="entry.content && clampable" @click.stop="emitOpenFull">
      查看全文 ⌄
    </button>
    <div class="ach-meta" v-if="(entry.tags && entry.tags.length) || sourceText">
      <span class="ach-tag" v-for="t in entry.tags" :key="t">#{{ t }}</span>
      <span class="kb-source" v-if="sourceText" :title="sourceText">📎 {{ sourceText }}</span>
    </div>
    <!-- 关联的本地文件：只存路径，卡片上只显示文件名 -->
    <div class="kb-file" v-if="filePath">
      <span class="kb-file-name" :title="filePath">📄 {{ fileName }}</span>
      <template v-if="desktopApp">
        <button type="button" class="btn small ghost" @click.stop="emitOpenFile">打开文件</button>
        <button type="button" class="btn small ghost" @click.stop="emitUpdateFile">更新文件</button>
      </template>
      <span class="kb-file-note" v-else>（在电脑端打开）</span>
      <span class="kb-file-warn" v-if="fileWarn" role="status">⚠️ {{ fileWarn }}</span>
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
