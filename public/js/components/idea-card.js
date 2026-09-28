/* ---------------- 组件：随记卡片 ---------------- */
// 随记：一行点题 + 一段内容 + 贴图。origin 标明这条是从哪儿来的，
// 手机记的能改，电脑记的在手机上只能看。
// 灵感默认折叠 3 行：列表要能一屏扫完，细看再展开。
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from '../vue-globals.js';

import { state } from '../state.js';
import { canWrite } from '../perm.js';
import { formatDate } from '../util/date.js';
import { useImageUrls } from '../img-urls.js';

const IdeaCard = {
  name: 'IdeaCard',
  props: { idea: { type: Object, required: true } },
  emits: ['edit', 'remove', 'deposit', 'pin'],
  setup(props, { emit }) {
    const timeText = computed(() => formatDate(props.idea.updated_at || props.idea.created_at));
    // 手机可写随记，但电脑端 origin 的条目服务端会拒写，UI 也不给编辑/删除
    const writable = computed(() => {
      if (!canWrite('ideas')) return false;
      if (state.role === 'desktop') return true;
      return props.idea.origin !== 'desktop';
    });
    const images = computed(() => props.idea.images || []);
    // 贴图走 fetch→blob 通道（见 img-urls.js），解析出 objectURL 后才渲染 <img>
    const { urls: imgUrls } = useImageUrls(images);

    // 全屏看图层：←/→ 翻页、Esc/点遮罩关闭
    const viewer = ref(null);
    function openViewer(i) { viewer.value = i; }
    function closeViewer() { viewer.value = null; }
    function stepViewer(d) {
      const n = images.value.length;
      if (!n) return;
      viewer.value = (viewer.value + d + n) % n;
    }
    const onViewerKey = (e) => {
      if (viewer.value === null) return;
      if (e.key === 'Escape') viewer.value = null;
      else if (e.key === 'ArrowLeft') stepViewer(-1);
      else if (e.key === 'ArrowRight') stepViewer(1);
    };
    // 看图层打开时锁背景滚动：否则滚轮滚的是底下页面，观感发飘
    watch(viewer, (v) => {
      try {
        document.body.style.overflow = v === null ? '' : 'hidden';
      } catch { /* ignore */ }
    });
    onMounted(() => window.addEventListener('keydown', onViewerKey));
    onUnmounted(() => {
      window.removeEventListener('keydown', onViewerKey);
      try { document.body.style.overflow = ''; } catch { /* ignore */ }
    });

    const expanded = ref(false);
    const contentEl = ref(null);
    const clampable = ref(false);
    // 带 clamped 类时 scrollHeight 仍是全文高度、clientHeight 是 3 行高度，
    // 两者差就是"被折掉的部分"；窗口宽度变了行数会变，重测
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
    function toggleExpand() {
      expanded.value = !expanded.value;
    }

    return {
      timeText, writable, images, imgUrls,
      viewer, openViewer, stepViewer, closeViewer,
      expanded, contentEl, clampable, toggleExpand,
      emitEdit: () => emit('edit'),
      emitRemove: () => emit('remove'),
      emitDeposit: () => emit('deposit'),
      emitPin: () => emit('pin'),
    };
  },
  template: `
  <article class="card idea-card" :class="{ pinned: idea.pinned }">
    <div class="card-head">
      <span class="st-pin" v-if="idea.pinned" title="已置顶">📌</span>
      <h3 class="title">{{ idea.title || '（没写题目）' }}</h3>
      <span class="idea-origin" v-if="idea.origin === 'mobile'" title="这条是在手机上记的">📱</span>
      <span class="idea-time">{{ timeText }}</span>
    </div>
    <p class="idea-content" :class="{ clamped: !expanded }" ref="contentEl" v-if="idea.content">{{ idea.content }}</p>
    <p class="idea-content empty-content" v-else>还没写内容</p>
    <button type="button" class="idea-toggle" v-if="idea.content && (clampable || expanded)" @click.stop="toggleExpand">
      {{ expanded ? '收起 ⌃' : '展开 ⌄' }}
    </button>
    <div class="idea-imgs" v-if="images.length" @click.stop>
      <template v-for="(im, i) in images" :key="im.id">
        <img v-if="imgUrls[im.id]" :src="imgUrls[im.id]" :alt="im.name" :title="im.name"
             loading="lazy" @click="openViewer(i)">
        <span v-else class="idea-img idea-img-loading" :title="im.name"></span>
      </template>
    </div>
    <div class="card-actions" @click.stop v-if="writable">
      <span class="spacer"></span>
      <button class="btn small ghost" @click="emitPin" :title="idea.pinned ? '取消置顶' : '置顶，紧急内容不遗漏'">
        {{ idea.pinned ? '📌 取消置顶' : '📌 置顶' }}
      </button>
      <button class="btn small ghost" @click="emitEdit">✏️ 编辑</button>
      <button class="btn small ghost" @click="emitDeposit" title="沉淀到知识库">📚</button>
      <button class="btn small danger" @click="emitRemove">🗑</button>
    </div>

    <!-- 全屏看图层：teleport 到 body——卡片带 transform（hover 上浮），
         fixed 定位在 transform 祖先里会失效，挂 body 才能铺满视口不抽搐 -->
    <teleport to="body">
      <div class="overlay img-viewer" v-if="viewer !== null" @click="closeViewer">
        <div class="img-viewer-bar" @click.stop>
          <span class="img-viewer-name">{{ images[viewer] && images[viewer].name }}</span>
          <span class="img-viewer-count">{{ viewer + 1 }} / {{ images.length }}</span>
          <button class="btn ghost small" @click="closeViewer">✕ 关闭</button>
        </div>
        <button class="img-viewer-nav prev" v-if="images.length > 1" @click.stop="stepViewer(-1)">←</button>
        <img v-if="imgUrls[images[viewer].id]" :src="imgUrls[images[viewer].id]" :alt="images[viewer].name" @click.stop>
        <button class="img-viewer-nav next" v-if="images.length > 1" @click.stop="stepViewer(1)">→</button>
      </div>
    </teleport>
  </article>
  `,
};

export { IdeaCard };
