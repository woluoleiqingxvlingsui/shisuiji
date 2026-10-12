/* 工作台的导航、检索和概览只读取现有状态，不改变板块的数据与权限。 */
import { computed, ref, onMounted, onUnmounted } from './vue-globals.js';
import { state } from './state.js';
import { canWrite, isDesktop } from './perm.js';
import { switchBoard } from './ui.js';
import { openIdeaEditor } from './boards/ideas.js';
import { openEditor } from './boards/eggs.js';
import { openPaperEditor } from './boards/papers.js';
import { openSiteEditor } from './boards/sites.js';
import { openExpenseEditor } from './boards/expenses.js';
import { openAchievementEditor } from './boards/achievements.js';
import { openKbEditor } from './boards/kb.js';

const boards = [
  { id: 'ideas', label: '随记', eyebrow: 'DAILY NOTES', description: '把一闪而过的灵感，变成随时能找回的记录。', collection: 'ideas', search: 'ideaSearch', placeholder: '搜索标题或随记内容…', action: '记随记', open: openIdeaEditor },
  { id: 'papers', label: '文献', eyebrow: 'READING ROOM', description: '从待读到读懂，让每一篇文献都留下收获。', collection: 'papers', search: 'paperSearch', placeholder: '搜索论文、类别或阅读笔记…', action: '记论文', open: openPaperEditor },
  { id: 'sites', label: '网页', eyebrow: 'BOOKMARKS', description: '收藏值得停留的网页，也留住当时的思考。', collection: 'sites', search: 'siteSearch', placeholder: '搜索网页、域名或笔记…', action: '记网页', open: openSiteEditor },
  { id: 'kb', label: '知识库', eyebrow: 'PERSONAL LIBRARY', description: '把零散的收获沉淀下来，成为可以复用的知识。', collection: 'kb', search: 'kbSearch', placeholder: '搜索知识、来源，或输入 #标签…', action: '记知识', open: openKbEditor },
  { id: 'eggs', label: '赛博鸡蛋', eyebrow: 'LITTLE FINDS', description: '收好每一个小惊喜，在到期之前从容用上。', collection: 'activities', search: 'search', placeholder: '搜索活动、平台或备注…', action: '记蛋', open: openEditor },
  { id: 'expenses', label: '花销', eyebrow: 'SPENDING JOURNAL', description: '清楚记下每一笔投入，让花销与体感都有迹可循。', collection: 'expenses', search: 'expenseSearch', placeholder: '搜索花销内容或备注…', action: '记一笔', open: openExpenseEditor },
  { id: 'achievements', label: '成果', eyebrow: 'MILESTONES', description: '把走过的路与完成的事，慢慢积累成自己的履历。', collection: 'achievements', search: 'achievementSearch', placeholder: '搜索成果、标签或链接…', action: '记成果', open: openAchievementEditor },
  { id: 'messages', label: '消息', eyebrow: 'UPDATES', description: '同步进展与到期提醒，都在这里及时了解。', collection: 'messages' },
];
const primaryIds = ['ideas', 'papers', 'sites', 'kb'];
const secondaryIds = ['eggs', 'expenses', 'achievements'];

export function useWorkspace(visibleCount) {
  const moreOpen = ref(false);
  let savedLayout = 'grid';
  try { savedLayout = localStorage.getItem('danji.layout') === 'list' ? 'list' : 'grid'; } catch { /* 默认双列 */ }
  const layout = ref(savedLayout);
  const currentBoard = computed(() => boards.find(b => b.id === state.board) || boards[0]);
  const searchTerm = computed({
    get: () => currentBoard.value.search ? state[currentBoard.value.search] : '',
    set: value => { if (currentBoard.value.search) state[currentBoard.value.search] = value; },
  });
  const totalCount = computed(() => state[currentBoard.value.collection].length);
  const canCreate = computed(() => !!currentBoard.value.open && canWrite(state.board));
  const collectionCount = computed(() => boards.filter(b => b.id !== 'messages').reduce((sum, b) => sum + state[b.collection].length, 0));
  const summaries = computed(() => {
    const records = state[currentBoard.value.collection];
    switch (state.board) {
      case 'ideas': return [{ label: '全部随记', value: records.length }, { label: '置顶记录', value: records.filter(i => i.pinned).length }, { label: '带图随记', value: records.filter(i => i.images?.length).length }];
      case 'papers': return [{ label: '全部文献', value: records.length }, { label: '等待阅读', value: records.filter(i => i.status === 'to_read').length }, { label: '已经读过', value: records.filter(i => i.status === 'read').length }];
      case 'sites': return [{ label: '收藏网页', value: records.length }, { label: '等待阅读', value: records.filter(i => i.status === 'to_read').length }, { label: '已经读过', value: records.filter(i => i.status === 'read').length }];
      case 'kb': return [{ label: '知识条目', value: records.length }, { label: '知识标签', value: new Set(records.flatMap(i => i.tags || [])).size }, { label: '有来源的知识', value: records.filter(i => i.source?.type && i.source.type !== 'manual').length }];
      case 'eggs': return [{ label: '收集的鸡蛋', value: records.length }, { label: '等待领取', value: records.filter(i => i.status === 'pending').length }, { label: '已经领取', value: records.filter(i => i.status === 'claimed').length }];
      case 'achievements': return [{ label: '全部成果', value: records.length }, { label: '已经完成', value: records.filter(i => i.status === 'done').length }, { label: '正在进行', value: records.filter(i => i.status === 'doing').length }];
      default: return [];
    }
  });
  const todayLabel = computed(() => new Date(state.now).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }));
  const moreActive = computed(() => secondaryIds.includes(state.board) || state.board === 'messages');
  function navigate(id) {
    moreOpen.value = false;
    switchBoard(id);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function createEntry() { if (canCreate.value) currentBoard.value.open(null); }
  function setLayout(value) {
    layout.value = value;
    try { localStorage.setItem('danji.layout', value); } catch { /* 保留当前会话 */ }
  }
  function onKey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !document.querySelector('.overlay')) {
      const input = document.querySelector('.workspace-search input');
      if (input) { e.preventDefault(); input.focus(); }
    }
    if (e.key === 'Escape') moreOpen.value = false;
    if (e.altKey && e.key.toLowerCase() === 'n' && !document.querySelector('.overlay')) { e.preventDefault(); createEntry(); }
  }
  onMounted(() => window.addEventListener('keydown', onKey));
  onUnmounted(() => window.removeEventListener('keydown', onKey));
  return {
    currentBoard, searchTerm, totalCount, visibleCount, canCreate, collectionCount, summaries,
    primaryBoards: boards.filter(b => primaryIds.includes(b.id)),
    secondaryBoards: boards.filter(b => secondaryIds.includes(b.id)),
    moreBoards: computed(() => boards.filter(b => secondaryIds.includes(b.id) || (b.id === 'messages' && isDesktop()))),
    boardCount: id => state[boards.find(b => b.id === id).collection].length,
    moreOpen, moreActive, layout, setLayout, todayLabel, navigate, createEntry,
  };
}

// 给现有抽屉统一补上焦点圈定、背景滚动锁定和键盘保存。
let dialogCount = 0;
let originalOverflow = '';
let dialogId = 0;
export const dialogDirective = {
  mounted(el) {
    const previousFocus = document.activeElement;
    if (dialogCount++ === 0) { originalOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    const heading = el.querySelector('h2');
    if (heading) { heading.id ||= `drawer-title-${++dialogId}`; el.setAttribute('aria-labelledby', heading.id); }
    el.tabIndex = -1;
    const keydown = e => {
      if (!el.contains(document.activeElement)) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing) {
        const form = el.querySelector('form');
        const submit = form?.querySelector('button[type="submit"]');
        if (form && submit && !submit.disabled) { e.preventDefault(); form.requestSubmit(submit); }
      }
      if (e.key !== 'Tab') return;
      const focusable = [...el.querySelectorAll('button, input, textarea, select, a[href], [tabindex="0"]')]
        .filter(node => !node.disabled && node.getClientRects().length);
      if (!focusable.length) { e.preventDefault(); el.focus(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    const focusin = e => {
      const top = [...document.querySelectorAll('.drawer')].at(-1);
      if (top === el && !el.contains(e.target)) el.focus();
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('focusin', focusin);
    el._disposeDialog = () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('focusin', focusin);
      if (--dialogCount === 0) document.body.style.overflow = originalOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
    if (!el.contains(document.activeElement)) el.focus();
  },
  unmounted(el) { el._disposeDialog?.(); },
};
