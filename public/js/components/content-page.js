/* ---------------- 组件：长内容全屏阅读页 ----------------
 *
 * 为什么是「应用内全屏视图」而不是浏览器新标签页：
 *   APK（Capacitor 壳）里开真新标签会丢登录态与离线队列。
 *   所以复用已有的 .overlay + .drawer 结构，加一个 full 形态铺满窗口，不新建路由。
 *
 * 为什么只存 { board, id } 不存内容快照：
 *   快照会过期 —— 从全屏页跳去编辑、保存完再回来，看到的还是旧内容。
 *   按 id 去对应板块的 state 数组里取实时对象，才是「所见即当前」。
 *
 * 手机端：全屏页可看（只读浏览本来就允许）；编辑入口只给电脑端，
 * 不在手机端凭空多出管理能力（见 AGENTS.md 第 6 条）。
 *
 * 贴图：随记的图也在这里照常显示（缩略图与卡片同一套 84px 样式），
 * 取图一律走 img-urls.js 的 fetch→blob 通道 —— 手机端的本机图（local:<uuid>）
 * 从 IndexedDB 取，绕开它就会在离线场景丢图。
 */
import { computed, onMounted, onUnmounted, ref } from '../vue-globals.js';

import { state } from '../state.js';
import { isDesktop } from '../perm.js';
import { formatDate } from '../util/date.js';
import { useImageUrls } from '../img-urls.js';
import { openIdeaEditor } from '../boards/ideas.js';
import { openKbEditor } from '../boards/kb.js';
import { openAchievementEditor } from '../boards/achievements.js';

/** 哪些板块的长正文能进全屏页：board → state 里对应的集合名 */
const BOARD_COLLECTION = { ideas: 'ideas', kb: 'kb', achievements: 'achievements' };

/** 打开某条的长正文 */
function openContentPage(board, id) {
  if (!BOARD_COLLECTION[board] || !id) return;
  state.contentPage = { open: true, board, id };
}

/** 关掉全屏页（回到列表） */
function closeContentPage() {
  state.contentPage = { open: false, board: '', id: '' };
}

/** 按 id 取实时对象：内容被改过，这里读到的就是改过之后的 */
const contentPageItem = computed(() => {
  const cp = state.contentPage;
  if (!cp || !cp.open) return null;
  const list = state[BOARD_COLLECTION[cp.board]] || [];
  return list.find((x) => x && x.id === cp.id) || null;
});

/** 顶部那一行元信息（可空） */
const contentPageMeta = computed(() => {
  const cp = state.contentPage;
  const item = contentPageItem.value;
  if (!item) return '';
  if (cp.board === 'achievements') {
    return [item.date, item.status].filter(Boolean).join(' · ');
  }
  return formatDate(item.updated_at || item.created_at);
});

/** 「编辑」= 关掉全屏页 + 打开该板块现有的编辑器。
 *  保存成功后不自动重开全屏页 —— 编辑器保存会自己关掉，回到列表即可。 */
function editContentPage() {
  const cp = state.contentPage;
  const item = contentPageItem.value;
  closeContentPage();
  if (!item) return;
  if (cp.board === 'ideas') openIdeaEditor(item);
  else if (cp.board === 'kb') openKbEditor(item);
  else if (cp.board === 'achievements') openAchievementEditor(item);
}

const ContentPage = {
  name: 'ContentPage',
  props: {
    title: { type: String, default: '' },
    content: { type: String, default: '' },
    meta: { type: String, default: '' },
    // 随记的贴图（其它板块没有就传空）：没有贴图时整块不渲染，不留空容器
    images: { type: Array, default: () => [] },
  },
  emits: ['close', 'edit'],
  setup(props, { emit }) {
    // 编辑入口只给电脑端：手机端知识库 / 成果本来就只读，别凭空多出管理能力
    const canEdit = computed(() => isDesktop());

    const images = computed(() => props.images || []);
    // 贴图走 fetch→blob 通道（见 img-urls.js）：服务端图与手机本机图（local:<uuid>）
    // 都由这一条通道解析，离线时也能看到缩略图 —— 不要自己 fetch 或拼 URL
    const { urls: imgUrls } = useImageUrls(images);

    // 全屏看图层：与 idea-card 同一套（.img-viewer 样式复用，teleport 到 body）
    const viewer = ref(null);
    function openViewer(i) { viewer.value = i; }
    function closeViewer() { viewer.value = null; }
    function stepViewer(d) {
      const n = images.value.length;
      if (!n) return;
      viewer.value = (viewer.value + d + n) % n;
    }

    const onKey = (e) => {
      // 看图层开着时，Esc / 方向键归它；否则 Esc 关整页
      if (viewer.value !== null) {
        if (e.key === 'Escape') viewer.value = null;
        else if (e.key === 'ArrowLeft') stepViewer(-1);
        else if (e.key === 'ArrowRight') stepViewer(1);
        return;
      }
      if (e.key === 'Escape') emit('close');
    };
    onMounted(() => window.addEventListener('keydown', onKey));
    onUnmounted(() => window.removeEventListener('keydown', onKey));

    // 点遮罩空白处关闭（和别的抽屉同一套手感：按下与抬起都在遮罩上才关）
    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      canEdit,
      images, imgUrls,
      viewer, openViewer, closeViewer, stepViewer,
      onOverlayMousedown, onOverlayMouseup,
      close: () => emit('close'),
      edit: () => emit('edit'),
    };
  },
  template: `
  <div class="overlay full" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside v-dialog class="drawer">
      <header class="drawer-head">
        <h2 class="content-page-title">{{ title || '全文' }}</h2>
        <button type="button" class="btn ghost small" v-if="canEdit" @click="edit" title="编辑这条内容">
          <app-icon name="edit"></app-icon>编辑
        </button>
        <button type="button" class="btn ghost small" @click="close" aria-label="关闭全文">✕</button>
      </header>
      <div class="drawer-body content-page-body">
        <p class="content-page-meta" v-if="meta">{{ meta }}</p>
        <div class="content-page-text">{{ content }}</div>
        <!-- 贴图：和卡片上同一套标记与样式（.idea-imgs → 84px 缩略图） -->
        <div class="idea-imgs" v-if="images.length" @click.stop>
          <template v-for="(im, i) in images" :key="im.id">
            <img v-if="imgUrls[im.id]" :src="imgUrls[im.id]" :alt="im.name" :title="im.name"
                 loading="lazy" @click="openViewer(i)">
            <span v-else class="idea-img idea-img-loading" :title="im.name"></span>
          </template>
        </div>
      </div>
    </aside>

    <!-- 全屏看图层：teleport 到 body（.drawer 有 overflow:hidden，挂里面会被裁）
         样式与 idea-card 的看图层完全一致，不另起一套 -->
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
  </div>
  `,
};

export { ContentPage, openContentPage, closeContentPage, editContentPage, contentPageItem, contentPageMeta };
