/* 拾穗集 —— 前端应用（Vue 3 运行时编译，无构建步骤）
   板块：🥚 赛博鸡蛋（原蛋记） / 📄 文献（论文待读已读管理） */
const { createApp, ref, reactive, computed, onMounted, onUnmounted, nextTick, provide } = Vue;

import { CONFIG } from '../config.js';
import { HOUR, FLASH_MS } from './util/const.js';
import { platformHue, platformStyle, normalizeUrl } from './util/text.js';
import { pad2, parseStoredDate, formatDate, parseFlexibleDate, formatRemaining, computeUrgency, todayStr } from './util/date.js';
import { statusMeta, typeMeta } from './util/meta.js';
import { NOTE_TEXT_FIELDS, noteRelMeta, notePartLabel, notePartsText, blankPaperLog, noteIsEmpty, noteSummary, NOTE_BASIC_FIELDS, NOTE_FIELD_LABEL, noteBasicMissing } from './util/paper-note.js';
import { readSortTime, readSortKey } from './util/sort.js';
import { kindMeta, usageMeta, siteNoteKeys, siteNoteFields, siteNoteFieldLabel, blankSiteNote, siteNoteIsEmpty, siteNoteMissing, siteNoteSummary, siteNoteRows } from './util/site-note.js';
import { LOG_DRAFT_PREFIX, SITE_DRAFT_PREFIX, readDraft, writeDraft, clearDraft } from './util/draft.js';
import { parseAmountInput, formatMoney, monthOf, periodLabel, defaultExpenseDate } from './util/money.js';
import { guessExpenseCategory, expenseCategoryMeta, buildCategorySlices, groupExpenseByTitle, buildPieSlices, expenseHitsSubject, matchSubjects, splitSentences, quoteTagOf, pickQuotes, buildSubjectInsight, buildVerdictDraft } from './util/expense.js';



// 平台名 → 稳定色相，同平台永远同色

// 平台/类别胶囊：只把色相写进 CSS 变量 --h，浅色与深色各自取明度（见 style.css），
// 这样切主题时不用重新渲染列表


// 存储日期 → Date。纯日期（YYYY-MM-DD）按本地时间当天 23:59 解析（截止日当天全天有效），
// 避免 new Date('2026-09-06') 按 UTC 零点解析带来的时区偏差

// 展示用日期：同年省略年份，带时间则显示到分钟

// 自由文本 → 截止时间。支持：9-8、9/8、9.8、9月8日、2026-9-8，
// 可选时间 18:00 / 18点 / 18点半 / 晚上8点，支持 今天/明天/后天。
// 不写年份默认今年（月日已过则顺延一年）；只写时间默认今天。
// 返回 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm，识别不了返回 null。


// 链接 → 可安全跳转的 URL。只放行 http(s)：没写协议的裸域名补 https://，
// 其它协议（javascript:、weixin:// 等）一律判空，不渲染成可点链接

// 紧急度核心逻辑：待领取看「领取截止」，已领取看「使用截止」
// level: over 已超时 / red / orange / yellow / unknown 截止待确认 / null 无
// tier 排序：紧急的(0-3) ≈ 已领取截止待确认(3) > 待领取截止待确认(4) > 无截止(pending 5 / claimed 9)
// 已领取的「待定」没有倒计时可看，只能人工核验，所以和黄档同级靠前


// 卡片上显示的一行摘要：核心发现 → 一句话感受 → 我能借鉴 → 核心做法 → 核心问题

// 最近一次阅读时间（毫秒）= 点「📖 阅读 / 🌐 打开」记下的 last_read_at 与笔记里手填的「读完日期」取较大者；
// 从没读过返回 0。日期串解析不了就忽略那一条，不参与比较。
// 列表排序键：阅读时间优先（点过阅读的立刻置顶），没读过的回落到「添加时间」

// 所有网页笔记字段（两套类型合起来，用于生成空表单和搜索）
// 表单要渲染的字段 = 共用 + 当前所选类型专属
// 归档门槛：技术严（一句话 + 关键做法 + 结论）、杂项松（一句话）
// 卡片上露的一行摘要：一句话 → 关键事实 → 结论 → 做法 → 摘抄
// 笔记里真正填了内容的字段（按 schema 顺序），列表模式逐行展示


// 「读完」的判定：三行速记都写了才算完成基本记录

// 没写完的笔记存本地草稿（按记录 id + 命名空间），下次打开自动带回；不产生正式记录

// 金额输入容错：¥ / ￥ / 千分位 / 空格都能吃；负数与非法值返回 null
// 金额显示：¥1,280 / ¥1,280.50（整数不留小数）
// 记录日期 → 'YYYY-MM'（期间分组用）
// 新记一笔时的默认日期：当前所选期间就是本月（今年）→ 今天；否则给该期间的第一天。
// 补记过去的账多半记不清具体哪天，先落在当月/当年，改日子比翻月份快。
// 按标题猜类别（规则与 server.js 的 guessExpenseCategory 一致）：按 categories 顺序匹配关键词，都没命中兜底第一个类别
// 年视图的类别层：先把期间内记录按类别汇总，再走同一套饼图逻辑（占比 / 补满 / 排序 / 零值过滤都复用）
// 年视图逐笔层：同名记录合并成一笔（按年看的是「这一年在这个名目上花了多少」，
// 同一个名字多次充值不用分开）；颜色按名字稳定生成，同名每次刷新同色
// 饼图数据：每笔记录一个扇区（按金额倒序）；超过 maxSlices 时把最小的若干笔合并成「其余 N 笔」

// 一笔花销是否认领到某个主体：标题或备注（小写化）包含任一关键词即命中
// 一笔花销命中了 config 里的哪些主体（一笔可以同时喂多家，备注里点名谁就算谁的）
// 把备注切成句子：按中英文句读和换行切开，太短的碎片丢掉（不然「嗯」「好」也占一行）
// 摘录打标：按 config 的顺序先中先用（价格 → 决策），都没命中归「体验」；
// 目的是把「token 价格 / 划不划算」这类句子一眼扫出来
// 从一笔花销里挑出与主体相关的句子：
//   句子本身提到主体关键词 → 必收（哪怕标题不是它，备注里点名了也算数）；
//   标题命中主体时 → 提到价格 / 决策词的句子也收；实在没有就收首句兜底，保证有话可看
// 汇总一个主体的全部素材：累计花费、笔数、类别拆分、最近一笔、原话摘录（新 → 旧，封顶 6 条）
// 由素材拼一段总评草稿：一句合计 + 带日期的要点摘录，填进总评框让用户改成自己的话
















import { EggCard } from './components/egg-card.js';
import { EggEditor } from './components/egg-editor.js';
import { PaperCard } from './components/paper-card.js';
import { SiteCard } from './components/site-card.js';
import { PaperEditor } from './components/paper-editor.js';
import { SiteEditor } from './components/site-editor.js';
import { PaperLogDrawer } from './components/paper-log-drawer.js';
import { SiteNoteDrawer } from './components/site-note-drawer.js';
import { ExpenseStats } from './components/expense-stats.js';
import { ExpenseCard } from './components/expense-card.js';
import { ExpenseEditor } from './components/expense-editor.js';
import { InsightCard } from './components/insight-card.js';
import { MessageCard } from './components/message-card.js';
import { IdeaCard } from './components/idea-card.js';
import { IdeaEditor } from './components/idea-editor.js';

/* ---------------- 根应用 ---------------- */
// 全局兜底用的 toast 引用：toast 定义在 setup 里，挂载后由 setup 回填
let toastBridge = null;

const app = createApp({
  setup() {
    const state = reactive({
      board: localStorage.getItem('danji.board') || 'eggs',
      activities: [],
      loaded: false,
      loadError: false, // 首屏加载失败（服务未启动等）：页面显示错误态和重试按钮，而不是永远「加载中…」
      search: '',
      statusFilter: 'pending',
      platformFilter: '',
      editorOpen: false,
      editing: null,
      saving: false, // 保存请求进行中：按钮立即显示「保存中…」并禁用，网络再慢也有即时反馈，且防重复提交
      papers: [],
      papersLoaded: false,
      paperCategories: [],
      paperFilter: { status: 'to_read', category: '', note: '' },
      paperSearch: '',
      paperEditorOpen: false,
      editingPaper: null,
      logOpen: false,
      logPaperId: null,
      logEditing: null, // null = 列表模式，对象 = 表单模式（新建时 id 为空）
      logPendingRead: false, // 这次打开是"读完引导"：写满三行速记才归档
      logRestored: false,    // 表单内容来自上次没写完的草稿
      logDraftSnapshot: null, // 最新草稿快照（关闭时用它兜底写盘）
      sites: [],
      sitesLoaded: false,
      siteFilter: { status: 'to_read', kind: '', usage: '' },
      siteSearch: '',
      siteEditorOpen: false,
      editingSite: null,
      siteNoteOpen: false,
      siteNoteId: null,
      siteNoteEditing: null,      // null = 列表模式，对象 = 表单模式
      siteNotePendingRead: false, // 这次打开是"读完引导"：写满门槛字段才归档
      siteNoteRestored: false,
      siteNoteDraftSnapshot: null,
      expenses: [],
      expensesLoaded: false,
      expenseSearch: '',
      expenseEditorOpen: false,
      editingExpense: null,
      expenseCategory: '', // 年视图下钻的类别（'' = 套餐 / API 总览）；同时作用于列表筛选
      // 花销板块视图：明细记账 / 体感评价，选择记在本地，刷新后保持
      expenseView: localStorage.getItem('danji.expenseView') === 'insight' ? 'insight' : 'list',
      // 体感评价：用户敲定的评价（rating / verdict / decision）存在 server；
      // 主体识别与摘录凝练是纯前端计算，每次都从花销记录现算
      insights: [],
      insightsLoaded: false,
      // 统计期间：默认当前月；「按月 / 按年」的选择记在本地，刷新后保持
      expensePeriod: {
        mode: localStorage.getItem('danji.expenseMode') === 'year' ? 'year' : 'month',
        year: new Date().getFullYear(),
        month: new Date().getMonth() + 1,
      },
      messages: [],
      messagesLoaded: false,
      ideas: [],
      ideasLoaded: false,
      ideaSearch: '',
      ideaEditorOpen: false,
      editingIdea: null,
      now: Date.now(),
      flashId: null,
      toast: { show: false, msg: '', type: 'ok' },
      notifPermission: typeof Notification !== 'undefined' ? Notification.permission : 'denied',
      // 用户级软开关：浏览器权限无法被 JS 撤销，关闭提醒只能靠自己存状态
      notifyOn: localStorage.getItem('danji.notifyOn') !== '0',
    });

    // 「已提醒过」记录持久化：刷新/重开页面不会对同一颗蛋重复弹通知
    const NOTIFIED_KEY = 'danji.notified';
    let savedNotified = [];
    try { savedNotified = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '[]'); } catch (e) {}
    const notifiedKeys = new Set(Array.isArray(savedNotified) ? savedNotified : []);
    function rememberNotified(key) {
      notifiedKeys.add(key);
      const arr = [...notifiedKeys];
      if (arr.length > 200) arr.splice(0, arr.length - 200); // 只留最近 200 条，防止无限膨胀
      localStorage.setItem(NOTIFIED_KEY, JSON.stringify(arr));
    }
    let toastTimer = null;

    function toast(msg, type = 'ok') {
      state.toast = { show: true, msg, type };
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { state.toast.show = false; }, 2200);
    }
    provide('toast', toast); // 子组件（卡片等）通过 inject 使用
    toastBridge = toast;     // 回填给全局兜底，服务异常时也能给出可见提示

    /* ---- 主题：跟随系统 → 浅色 → 深色（首屏由 index.html 的内联脚本先定好，避免闪白） ---- */
    const THEME_KEY = 'danji.theme';
    const THEME_MODES = ['auto', 'light', 'dark'];
    const THEME_ICON = { auto: '🖥️', light: '☀️', dark: '🌙' };
    const THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

    function readThemeMode() {
      // ?theme=light|dark 临时强制某个明暗（调试/截图用，不写入偏好）
      try {
        const q = new URLSearchParams(location.search).get('theme');
        if (q === 'light' || q === 'dark') return q;
      } catch (e) {}
      try {
        const saved = localStorage.getItem(THEME_KEY);
        return THEME_MODES.includes(saved) ? saved : 'auto';
      } catch (e) { return 'auto'; }
    }
    const themeMode = ref(readThemeMode());

    function applyTheme() {
      const dark = themeMode.value === 'dark' || (themeMode.value === 'auto' && systemDark.matches);
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    }

    function cycleTheme() {
      themeMode.value = THEME_MODES[(THEME_MODES.indexOf(themeMode.value) + 1) % THEME_MODES.length];
      try { localStorage.setItem(THEME_KEY, themeMode.value); } catch (e) {}
      applyTheme();
      toast(`主题：${THEME_LABEL[themeMode.value]}`);
    }

    const themeIcon = computed(() => THEME_ICON[themeMode.value]);
    const themeTitle = computed(() => {
      const next = THEME_LABEL[THEME_MODES[(THEME_MODES.indexOf(themeMode.value) + 1) % THEME_MODES.length]];
      return `当前主题：${THEME_LABEL[themeMode.value]}，点击切换到「${next}」`;
    });

    // 系统偏好变化时（auto 模式下）实时跟随；另一个标签页改了主题也同步
    const onSystemThemeChange = () => { if (themeMode.value === 'auto') applyTheme(); };
    const onStorageTheme = (e) => {
      if (e.key !== THEME_KEY) return;
      themeMode.value = readThemeMode();
      applyTheme();
    };

    // 顶栏换行后高度会变，实时同步 --topbar-h，保证紧急横幅吸顶位置正确
    let topbarObserver = null;
    function syncTopbarHeight() {
      const el = document.querySelector('.topbar');
      if (el) document.documentElement.style.setProperty('--topbar-h', el.offsetHeight + 'px');
    }

    /* ---- 数据加载与提交 ---- */
    async function load() {
      try {
        const res = await fetch('/api/activities');
        state.activities = await res.json();
        state.loaded = true;
        state.loadError = false;
      } catch (e) {
        // 服务连不上：标记错误态让页面显示重试按钮；不向上抛，避免中断 onMounted 后续初始化
        state.loadError = true;
      }
    }

    async function saveActivity(payload) {
      if (state.saving) return; // 请求进行中忽略重复提交（连点按钮 / 表单里按回车）
      state.saving = true;      // 同步置位：按钮立即变「保存中…」，不等网络结论
      const isEdit = !!state.editing;
      const url = isEdit ? `/api/activities/${state.editing.id}` : '/api/activities';
      let saved;
      try {
        const res = await fetch(url, {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) return toast('保存失败：' + res.status, 'warn');
        saved = await res.json();
      } catch (e) {
        // 服务连不上：抽屉保持打开，已填内容不丢
        return toast('保存失败：无法连接服务，请确认拾穗集服务已启动', 'warn');
      } finally {
        state.saving = false;
      }
      if (isEdit) {
        const idx = state.activities.findIndex((a) => a.id === saved.id);
        if (idx !== -1) state.activities.splice(idx, 1, saved);
      } else {
        state.activities.push(saved);
      }
      state.editorOpen = false;
      toast(isEdit ? '已保存 ✅' : '记好了，一颗新蛋 🥚');
    }

    // 改一条记录的若干个字段，成功后就地替换本地数据，失败返回 null
    async function patchActivity(activity, patch) {
      const res = await fetch(`/api/activities/${activity.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...activity, ...patch }),
      });
      if (!res.ok) return null;
      const saved = await res.json();
      const idx = state.activities.findIndex((a) => a.id === saved.id);
      if (idx !== -1) state.activities.splice(idx, 1, saved);
      return saved;
    }

    async function setStatus(activity, status) {
      const saved = await patchActivity(activity, { status });
      if (!saved) return toast('更新失败', 'warn');
      toast(`已标记为「${statusMeta(status).label}」${statusMeta(status).emoji}`);
    }

    async function removeActivity(activity) {
      if (!confirm(`确定删除「${activity.platform} · ${activity.title}」吗？`)) return;
      const res = await fetch(`/api/activities/${activity.id}`, { method: 'DELETE' });
      if (!res.ok) return toast('删除失败：' + res.status, 'warn');
      state.activities = state.activities.filter((a) => a.id !== activity.id);
      toast('已删除 🗑');
    }

    /* ---- 文献板块 ---- */
    function switchBoard(board) {
      state.board = board;
      localStorage.setItem('danji.board', board);
    }

    async function loadPapers() {
      try {
        const [papers, cats] = await Promise.all([
          fetch('/api/papers').then((r) => r.json()),
          fetch('/api/papers/categories').then((r) => r.json()),
        ]);
        state.papers = papers;
        state.paperCategories = cats;
      } catch {
        toast('论文数据加载失败', 'warn');
      }
      state.papersLoaded = true;
    }

    /* ---- 消息中心 ---- */
    async function loadMessages() {
      try {
        const res = await fetch('/api/messages');
        state.messages = await res.json();
      } catch {
        toast('消息加载失败', 'warn');
      }
      state.messagesLoaded = true;
    }

    // 蛋过期时写一条消息；服务端按「蛋 + 使用截止 + 领取截止」去重，重复调用不会攒出多条
    async function pushExpiredMessage(activity) {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activity_id: activity.id,
          platform: activity.platform,
          title: activity.title,
          body: `使用截止 ${formatDate(activity.valid_until)} 已过，已自动移入「已过期」`,
          valid_until: activity.valid_until || '',
          read: false,
        }),
      });
      if (!res.ok) return;
      const saved = await res.json();
      if (!state.messages.some((m) => m.id === saved.id)) state.messages.unshift(saved);
    }

    // 蛋过了领取截止时写一条消息，claim_deadline 参与服务端去重
    async function pushClosedMessage(activity) {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activity_id: activity.id,
          platform: activity.platform,
          title: activity.title,
          body: `领取截止 ${formatDate(activity.claim_deadline)} 已过，已自动移入「已截止」`,
          valid_until: '',
          claim_deadline: activity.claim_deadline || '',
          read: false,
        }),
      });
      if (!res.ok) return;
      const saved = await res.json();
      if (!state.messages.some((m) => m.id === saved.id)) state.messages.unshift(saved);
    }

    async function markMessageRead(msg) {
      if (msg.read) return;
      const res = await fetch(`/api/messages/${msg.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...msg, read: true }),
      });
      if (!res.ok) return;
      const saved = await res.json();
      const idx = state.messages.findIndex((m) => m.id === saved.id);
      if (idx !== -1) state.messages.splice(idx, 1, saved);
    }

    async function removeMessage(msg) {
      const res = await fetch(`/api/messages/${msg.id}`, { method: 'DELETE' });
      if (!res.ok) return toast('删除失败', 'warn');
      state.messages = state.messages.filter((m) => m.id !== msg.id);
    }

    async function markAllRead() {
      const res = await fetch('/api/messages/read-all', { method: 'POST' });
      if (!res.ok) return toast('操作失败', 'warn');
      const { updated } = await res.json();
      state.messages = state.messages.map((m) => ({ ...m, read: true }));
      toast(updated ? `${updated} 条消息已标为已读 ✅` : '没有未读消息');
    }

    async function clearReadMessages() {
      const res = await fetch('/api/messages/clear-read', { method: 'POST' });
      if (!res.ok) return toast('操作失败', 'warn');
      const { removed } = await res.json();
      state.messages = state.messages.filter((m) => !m.read);
      toast(removed ? `已清空 ${removed} 条已读消息 🧹` : '没有已读消息');
    }

    function openPaperEditor(paper) {
      state.editingPaper = paper ? { ...paper } : null;
      state.paperEditorOpen = true;
    }

    async function savePaper(payload) {
      const isEdit = !!state.editingPaper;
      const url = isEdit ? `/api/papers/${state.editingPaper.id}` : '/api/papers';
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
      if (isEdit) {
        const idx = state.papers.findIndex((p) => p.id === saved.id);
        if (idx !== -1) state.papers.splice(idx, 1, saved);
      } else {
        state.papers.push(saved);
      }
      state.paperEditorOpen = false;
      loadPapers(); // 类别/文件状态可能变了，顺手刷新
      if (saved.missing) toast('文件没找到，已仅创建记录', 'warn');
      else if (saved.moved) toast(`已归档到 ${saved.status === 'read' ? '已读' : '待读'}/${saved.category} 📂`);
      else toast(isEdit ? '已保存 ✅' : '记好了，一篇论文 📄');
    }

    async function setPaperStatus(paper, status) {
      const res = await fetch(`/api/papers/${paper.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...paper, status }),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('更新失败：' + (saved.error || res.status), 'warn');
      const idx = state.papers.findIndex((p) => p.id === saved.id);
      if (idx !== -1) state.papers.splice(idx, 1, saved);
      toast(status === 'read' ? `已移入 已读/${saved.category} ✅` : `已移回 待读/${saved.category} 📖`);
    }

    /* ---- 阅读记录（logs） ---- */
    const logPaper = computed(() => state.papers.find((p) => p.id === state.logPaperId) || null);

    // mode: 'list' 看记录列表（没有记录时直接进表单） / 'new' 直接新建
    // pendingRead: 这次是"读完引导"，三行速记写满并保存后才真正归档
    function openPaperLog(paper, mode = 'list', pendingRead = false) {
      state.logPaperId = paper.id;
      state.logPendingRead = pendingRead;
      const draft = mode === 'new' ? readDraft(LOG_DRAFT_PREFIX, paper.id) : null; // 没写完的草稿自动带回
      state.logRestored = !!draft;
      state.logDraftSnapshot = draft;
      state.logEditing = draft
        ? { ...blankPaperLog(), ...draft, parts: [...(draft.parts || [])] }
        : ((mode === 'new' || !(paper.logs || []).length) ? blankPaperLog() : null);
      state.logOpen = true;
    }

    // 点「✅ 读完了」：先写笔记，保存那一刻才归档，论文此刻状态与文件都不动
    function startPaperRead(paper) { openPaperLog(paper, 'new', true); }

    function newPaperLog() {
      state.logPendingRead = false;
      state.logRestored = false;
      state.logDraftSnapshot = null;
      state.logEditing = blankPaperLog();
    }
    function editPaperLog(log) { state.logEditing = { ...log, parts: [...(log.parts || [])] }; }
    function backToLogList() {
      if (state.logPendingRead) return closePaperLog(); // 还没归档，回列表没意义
      state.logEditing = null;
    }

    // 草稿：内存留最新快照，写盘防抖 400ms；关闭时立刻补写，兜住"打完字就关"
    let draftTimer = null;
    function saveLogDraft(form) {
      if (!state.logPendingRead || !state.logPaperId) return;
      state.logDraftSnapshot = form;
      clearTimeout(draftTimer);
      const paperId = state.logPaperId;
      draftTimer = setTimeout(() => writeDraft(LOG_DRAFT_PREFIX, paperId, form, noteIsEmpty), 400);
    }
    function discardLogDraft() {
      clearTimeout(draftTimer);
      clearDraft(LOG_DRAFT_PREFIX, state.logPaperId);
      state.logRestored = false;
      state.logDraftSnapshot = null;
      toast('草稿已丢弃 🧹');
    }

    function closePaperLog() {
      clearTimeout(draftTimer);
      const wasPendingRead = state.logPendingRead;
      const paperId = state.logPaperId;
      if (wasPendingRead && paperId && state.logDraftSnapshot) writeDraft(LOG_DRAFT_PREFIX, paperId, state.logDraftSnapshot, noteIsEmpty);
      state.logPendingRead = false;
      state.logRestored = false;
      state.logDraftSnapshot = null;
      state.logOpen = false;
      state.logPaperId = null;
      state.logEditing = null;
      if (wasPendingRead && paperId) {
        toast(readDraft(LOG_DRAFT_PREFIX, paperId) ? '没写满，这篇还留在「待读」，内容已存草稿' : '没记笔记，这篇还留在「待读」');
      }
    }

    async function savePaperLog(form) {
      const paper = logPaper.value;
      if (!paper) return;

      // 读完引导：三行速记写满才允许归档；已读补记只要非空即可
      if (state.logPendingRead) {
        const missing = noteBasicMissing(form);
        if (missing.length) {
          return toast(`还差「${missing.map((f) => NOTE_FIELD_LABEL[f]).join('、')}」，这篇先留在「待读」`, 'warn');
        }
      } else if (noteIsEmpty(form)) {
        return toast('这条记录还是空的，写点内容再保存', 'warn');
      }

      const logs = [...(paper.logs || [])];
      const idx = logs.findIndex((l) => l.id === form.id);
      if (idx === -1) logs.push(form); else logs.splice(idx, 1, form);
      const patch = { ...paper, logs };
      const wasPendingRead = state.logPendingRead;
      if (wasPendingRead) patch.status = 'read'; // 笔记与状态同一次 PUT，原子落盘

      const res = await fetch(`/api/papers/${paper.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
      const i = state.papers.findIndex((p) => p.id === saved.id);
      if (i !== -1) state.papers.splice(i, 1, saved);

      clearTimeout(draftTimer);
      clearDraft(LOG_DRAFT_PREFIX, paper.id);
      state.logPendingRead = false;
      state.logRestored = false;
      state.logDraftSnapshot = null;
      state.logEditing = null; // 保存后回到列表
      toast(wasPendingRead
        ? `读完了！已归档到 已读/${saved.category} 🎉`
        : (idx === -1 ? '已记下这条阅读记录 📝' : '记录已更新 ✅'));
    }

    async function removePaperLog(log) {
      const paper = logPaper.value;
      if (!paper) return;
      if (!confirm(`删除 ${log.read_at || '这条'} 的阅读记录吗？`)) return;
      const logs = (paper.logs || []).filter((l) => l.id !== log.id);
      const res = await fetch(`/api/papers/${paper.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...paper, logs }),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('删除失败：' + (saved.error || res.status), 'warn');
      const i = state.papers.findIndex((p) => p.id === saved.id);
      if (i !== -1) state.papers.splice(i, 1, saved);
      toast('已删除这条记录 🗑');
    }

    async function openPaper(paper) {
      toast('正在打开…');
      const res = await fetch(`/api/papers/${paper.id}/open`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return toast(data.error || '打开失败', 'warn');
      // 服务端已记下 last_read_at，用它替换本地这条 → 列表按阅读时间重排，这张卡升到顶部
      if (data.paper) {
        const idx = state.papers.findIndex((p) => p.id === data.paper.id);
        if (idx !== -1) state.papers.splice(idx, 1, data.paper);
        flashCard(data.paper.id);
        toast('📖 已打开，这张卡已置顶');
      } else {
        toast('📖 已打开');
      }
    }

    async function openPaperReveal(paper) {
      const res = await fetch(`/api/papers/${paper.id}/reveal`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast(data.error || '打开失败', 'warn');
    }

    async function removePaper(paper) {
      if (!confirm(`确定删除记录「${paper.title}」吗？（磁盘上的文件不会被删）`)) return;
      const res = await fetch(`/api/papers/${paper.id}`, { method: 'DELETE' });
      if (!res.ok) return toast('删除失败：' + res.status, 'warn');
      state.papers = state.papers.filter((p) => p.id !== paper.id);
      toast('已删除记录 🗑（文件保留）');
    }

    /* ---- 网页板块 ---- */
    async function loadSites() {
      try {
        state.sites = await fetch('/api/sites').then((r) => r.json());
      } catch {
        toast('网页数据加载失败', 'warn');
      }
      state.sitesLoaded = true;
    }

    function openSiteEditor(site) {
      state.editingSite = site ? { ...site } : null;
      state.siteEditorOpen = true;
    }

    async function saveSite(payload) {
      const isEdit = !!state.editingSite;
      const url = isEdit ? `/api/sites/${state.editingSite.id}` : '/api/sites';
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
      if (isEdit) {
        const idx = state.sites.findIndex((s) => s.id === saved.id);
        if (idx !== -1) state.sites.splice(idx, 1, saved);
      } else {
        state.sites.push(saved);
      }
      state.siteEditorOpen = false;
      toast(isEdit ? '已保存 ✅' : '记好了，一个待读网页 🌐');
    }

    async function setSiteStatus(site, status) {
      const res = await fetch(`/api/sites/${site.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...site, status }),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('更新失败：' + (saved.error || res.status), 'warn');
      const idx = state.sites.findIndex((s) => s.id === saved.id);
      if (idx !== -1) state.sites.splice(idx, 1, saved);
      toast(status === 'read' ? '已移入「已读」✅' : '已移回「待读」📖');
    }

    // 打开网页：先同步 window.open（放到 await 之后会被浏览器当弹窗拦掉），再回服务端记阅读时间
    async function openSite(site) {
      const url = normalizeUrl(site.url);
      if (!url) return toast('这条记录的链接不合法，编辑一下试试', 'warn');
      // 别写成 window.open(url, '_blank', 'noopener')：带 noopener 时浏览器按规范一律返回 null
      // （不给句柄），那样会把「打开成功」误判成「被拦截」。这里正常打开后立刻抹掉 opener，效果等价。
      const win = window.open(url, '_blank');
      if (win) {
        try { win.opener = null; } catch (e) {}
        toast('🌐 已打开，这张卡已置顶');
      } else {
        try {
          await navigator.clipboard.writeText(url);
          toast('浏览器拦截了弹窗，链接已复制 📋', 'warn');
        } catch { toast('浏览器拦截了弹窗，请手动打开链接', 'warn'); }
      }
      const res = await fetch(`/api/sites/${site.id}/open`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.site) return; // 时间没记上也不打扰你阅读
      const idx = state.sites.findIndex((s) => s.id === data.site.id);
      if (idx !== -1) state.sites.splice(idx, 1, data.site);
      flashCard(data.site.id);
    }

    async function removeSite(site) {
      if (!confirm(`确定删除「${site.title}」吗？`)) return;
      const res = await fetch(`/api/sites/${site.id}`, { method: 'DELETE' });
      if (!res.ok) return toast('删除失败：' + res.status, 'warn');
      state.sites = state.sites.filter((s) => s.id !== site.id);
      toast('已删除 🗑');
    }

    /* ---- 网页笔记（logs） ---- */
    const siteNoteItem = computed(() => state.sites.find((s) => s.id === state.siteNoteId) || null);

    // mode: 'list' 看笔记列表（没有笔记时直接进表单） / 'new' 直接新建
    // pendingRead: 这次是"读完引导"，写满门槛字段并保存后才真正归档到「已读」
    function openSiteNote(site, mode = 'list', pendingRead = false) {
      state.siteNoteId = site.id;
      state.siteNotePendingRead = pendingRead;
      const draft = mode === 'new' ? readDraft(SITE_DRAFT_PREFIX, site.id) : null; // 没写完的草稿自动带回
      state.siteNoteRestored = !!draft;
      state.siteNoteDraftSnapshot = draft;
      state.siteNoteEditing = draft
        ? { ...blankSiteNote(site.kind), ...draft }
        : ((mode === 'new' || !(site.logs || []).length) ? blankSiteNote(site.kind) : null);
      state.siteNoteOpen = true;
    }

    // 点「✅ 读完了」：先写笔记，保存那一刻才归档，网页状态此刻不动
    function startSiteRead(site) { openSiteNote(site, 'new', true); }

    function newSiteNote() {
      state.siteNotePendingRead = false;
      state.siteNoteRestored = false;
      state.siteNoteDraftSnapshot = null;
      const site = siteNoteItem.value;
      state.siteNoteEditing = blankSiteNote(site ? site.kind : 'tech');
    }
    function editSiteNote(log) { state.siteNoteEditing = { ...log }; }
    function backToSiteNoteList() {
      if (state.siteNotePendingRead) return closeSiteNote(); // 还没归档，回列表没意义
      state.siteNoteEditing = null;
    }

    // 草稿：内存留最新快照，写盘防抖 400ms；关闭时立刻补写，兜住"打完字就关"
    let siteDraftTimer = null;
    function saveSiteNoteDraft(form) {
      if (!state.siteNotePendingRead || !state.siteNoteId) return;
      state.siteNoteDraftSnapshot = form;
      clearTimeout(siteDraftTimer);
      const id = state.siteNoteId;
      siteDraftTimer = setTimeout(() => writeDraft(SITE_DRAFT_PREFIX, id, form, siteNoteIsEmpty), 400);
    }
    function discardSiteNoteDraft() {
      clearTimeout(siteDraftTimer);
      clearDraft(SITE_DRAFT_PREFIX, state.siteNoteId);
      state.siteNoteRestored = false;
      state.siteNoteDraftSnapshot = null;
      toast('草稿已丢弃 🧹');
    }

    function closeSiteNote() {
      clearTimeout(siteDraftTimer);
      const wasPendingRead = state.siteNotePendingRead;
      const siteId = state.siteNoteId;
      if (wasPendingRead && siteId && state.siteNoteDraftSnapshot) {
        writeDraft(SITE_DRAFT_PREFIX, siteId, state.siteNoteDraftSnapshot, siteNoteIsEmpty);
      }
      state.siteNotePendingRead = false;
      state.siteNoteRestored = false;
      state.siteNoteDraftSnapshot = null;
      state.siteNoteOpen = false;
      state.siteNoteId = null;
      state.siteNoteEditing = null;
      if (wasPendingRead && siteId) {
        toast(readDraft(SITE_DRAFT_PREFIX, siteId)
          ? '没写满，这个网页还留在「待读」，内容已存草稿'
          : '没记笔记，这个网页还留在「待读」');
      }
    }

    async function saveSiteNote(form) {
      const site = siteNoteItem.value;
      if (!site) return;

      // 读完引导：技术网页要写满三栏、杂项网页只要一句话；已读后的补记非空即可
      if (state.siteNotePendingRead) {
        const missing = siteNoteMissing(form);
        if (missing.length) {
          return toast(`还差「${missing.map(siteNoteFieldLabel).join('、')}」，这个网页先留在「待读」`, 'warn');
        }
      } else if (siteNoteIsEmpty(form)) {
        return toast('这条笔记还是空的，写点内容再保存', 'warn');
      }

      const logs = [...(site.logs || [])];
      const idx = logs.findIndex((l) => l.id === form.id);
      if (idx === -1) logs.push(form); else logs.splice(idx, 1, form);
      const patch = { ...site, logs };
      const wasPendingRead = state.siteNotePendingRead;
      if (wasPendingRead) patch.status = 'read'; // 笔记与状态同一次 PUT，原子落盘

      const res = await fetch(`/api/sites/${site.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
      const i = state.sites.findIndex((s) => s.id === saved.id);
      if (i !== -1) state.sites.splice(i, 1, saved);

      clearTimeout(siteDraftTimer);
      clearDraft(SITE_DRAFT_PREFIX, site.id);
      state.siteNotePendingRead = false;
      state.siteNoteRestored = false;
      state.siteNoteDraftSnapshot = null;
      state.siteNoteEditing = null; // 保存后回到列表
      toast(wasPendingRead
        ? '读完了！已移入「已读」🎉'
        : (idx === -1 ? '已记下这条笔记 📝' : '笔记已更新 ✅'));
    }

    async function removeSiteNote(log) {
      const site = siteNoteItem.value;
      if (!site) return;
      if (!confirm(`删除 ${log.read_at || '这条'} 的笔记吗？`)) return;
      const logs = (site.logs || []).filter((l) => l.id !== log.id);
      const res = await fetch(`/api/sites/${site.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...site, logs }),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('删除失败：' + (saved.error || res.status), 'warn');
      const i = state.sites.findIndex((s) => s.id === saved.id);
      if (i !== -1) state.sites.splice(i, 1, saved);
      toast('已删除这条笔记 🗑');
    }

    /* ---- 花销板块 ---- */
    let expensePeriodInit = false; // 只做一次「自动跳到最近有记录的月份」

    async function loadExpenses() {
      try {
        state.expenses = await fetch('/api/expenses').then((r) => r.json());
      } catch {
        toast('花销数据加载失败', 'warn');
      }
      state.expensesLoaded = true;
      // 当前期间一笔都没有、但历史里有记录 → 自动跳到最近有记录的月份，免得一进来看到空板
      if (!expensePeriodInit) {
        expensePeriodInit = true;
        const p = state.expensePeriod;
        const hasCurrent = state.expenses.some((e) => monthOf(e.date) === `${p.year}-${pad2(p.month)}`);
        if (!hasCurrent) {
          const latest = state.expenses.map((e) => monthOf(e.date)).filter(Boolean).sort().pop();
          if (latest) {
            p.year = Number(latest.slice(0, 4));
            p.month = Number(latest.slice(5, 7));
          }
        }
      }
    }

    function openExpenseEditor(expense) {
      state.editingExpense = expense ? { ...expense } : null;
      state.expenseEditorOpen = true;
    }

    async function saveExpense(payload) {
      const isEdit = !!state.editingExpense;
      const url = isEdit ? `/api/expenses/${state.editingExpense.id}` : '/api/expenses';
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
      if (isEdit) {
        const idx = state.expenses.findIndex((e) => e.id === saved.id);
        if (idx !== -1) state.expenses.splice(idx, 1, saved);
      } else {
        state.expenses.push(saved);
      }
      state.expenseEditorOpen = false;
      // 跳到这笔所属的期间，保证刚记的立刻看得见（比如补记上个月的账）
      const m = monthOf(saved.date);
      if (m) {
        state.expensePeriod.year = Number(m.slice(0, 4));
        state.expensePeriod.month = Number(m.slice(5, 7));
      }
      toast(isEdit ? '已保存 ✅' : `记好了：${saved.title} ${formatMoney(saved.amount)} 💰`);
    }

    async function removeExpense(expense) {
      if (!confirm(`确定删除「${expense.title}」这笔 ${formatMoney(expense.amount)} 吗？`)) return;
      const res = await fetch(`/api/expenses/${expense.id}`, { method: 'DELETE' });
      if (!res.ok) return toast('删除失败：' + res.status, 'warn');
      state.expenses = state.expenses.filter((e) => e.id !== expense.id);
      toast('已删除 🗑');
    }

    /* ---- 花销板块：体感评价 ---- */
    async function loadInsights() {
      try {
        state.insights = await fetch('/api/insights').then((r) => r.json());
      } catch {
        toast('评价数据加载失败', 'warn');
      }
      state.insightsLoaded = true;
    }

    function setExpenseView(view) {
      state.expenseView = view === 'insight' ? 'insight' : 'list';
      localStorage.setItem('danji.expenseView', state.expenseView);
    }

    // 保存某个主体的评价：按 subject upsert，卡片上的本地编辑在保存成功后由组件自己同步
    async function saveInsightVerdict(payload) {
      const res = await fetch(`/api/insights/${encodeURIComponent(payload.subject)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: payload.rating, decision: payload.decision, verdict: payload.verdict }),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
      const i = state.insights.findIndex((v) => v.subject === saved.subject);
      if (i === -1) state.insights.push(saved);
      else state.insights.splice(i, 1, saved);
      toast('评价已保存 🧭');
    }

    // 清除评价 = 回到纯记录视角：只删我的结论，花销记录和凝练出来的原话都不动
    async function clearInsightVerdict(row) {
      if (!confirm(`清空「${row.subject.label}」的评价吗？（记录原话还在，随时能重新写）`)) return;
      const res = await fetch(`/api/insights/${encodeURIComponent(row.subject.id)}`, { method: 'DELETE' });
      if (!res.ok) return toast('删除失败：' + res.status, 'warn');
      state.insights = state.insights.filter((v) => v.subject !== row.subject.id);
      toast('已清除 🧹');
    }

    /* ---- 想法板块：一行点题 + 一段灵感。目前桌面直连 REST，P6 起手机端改走同步队列 ---- */
    async function loadIdeas() {
      try {
        state.ideas = await fetch('/api/ideas').then((r) => r.json());
      } catch {
        toast('想法加载失败', 'warn');
      }
      state.ideasLoaded = true;
    }

    // 列表已按 updated_at 倒序从服务端返回，这里只做搜索过滤（题目 + 正文都搜）
    const filteredIdeas = computed(() => {
      const kw = state.ideaSearch.trim().toLowerCase();
      if (!kw) return state.ideas;
      return state.ideas.filter((i) =>
        String(i.title || '').toLowerCase().includes(kw)
        || String(i.content || '').toLowerCase().includes(kw));
    });

    function openIdeaEditor(idea) {
      state.editingIdea = idea ? { ...idea } : null;
      state.ideaEditorOpen = true;
    }

    async function saveIdea(payload) {
      const isEdit = !!state.editingIdea;
      const url = isEdit ? `/api/ideas/${state.editingIdea.id}` : '/api/ideas';
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const saved = await res.json().catch(() => ({}));
      if (res.status === 409) {
        // 乐观锁没过：这条在别处先改了。不静默覆盖，刷新拿最新的让用户自己看
        state.ideaEditorOpen = false;
        toast('这条想法在别处改过，已刷新为最新内容', 'warn');
        loadIdeas();
        return;
      }
      if (!res.ok) return toast('保存失败：' + (saved.error || res.status), 'warn');
      if (isEdit) {
        const idx = state.ideas.findIndex((i) => i.id === saved.id);
        if (idx !== -1) state.ideas.splice(idx, 1, saved);
      } else {
        state.ideas.unshift(saved);
      }
      state.ideaEditorOpen = false;
      toast(isEdit ? '已保存 ✅' : '记下了 💡');
    }

    async function removeIdea(idea) {
      const name = idea.title || (idea.content || '').slice(0, 20) || '这条想法';
      if (!confirm(`确定删除「${name}」吗？`)) return;
      const res = await fetch(`/api/ideas/${idea.id}`, { method: 'DELETE' });
      if (!res.ok) return toast('删除失败：' + res.status, 'warn');
      state.ideas = state.ideas.filter((i) => i.id !== idea.id);
      toast('已删除 🗑');
    }

    function setExpenseMode(mode) {
      state.expensePeriod.mode = mode;
      // 类别下钻只属于「按年」：按月是按条目看的，切过去就把筛选清掉，别把年视图的类别带进月视图
      if (mode !== 'year') state.expenseCategory = '';
      localStorage.setItem('danji.expenseMode', mode);
    }
    // 点类别 = 下钻；再点同一个 = 回到总览
    function pickExpenseCategory(id) {
      state.expenseCategory = state.expenseCategory === id ? '' : id;
    }
    function clearExpenseCategory() { state.expenseCategory = ''; }
    function setExpenseYear(year) { state.expensePeriod.year = year; }
    function setExpenseMonth(month) { state.expensePeriod.month = month; }
    // 期间步进：按月时跨年自动进位/退位
    function stepExpensePeriod(delta) {
      const p = state.expensePeriod;
      if (p.mode === 'year') { p.year += delta; return; }
      let m = p.month + delta;
      let y = p.year;
      while (m > 12) { m -= 12; y += 1; }
      while (m < 1) { m += 12; y -= 1; }
      p.month = m;
      p.year = y;
    }

    /* ---- 派生数据 ---- */
    const platformOptions = computed(() => {
      const set = new Set(state.activities.map((a) => a.platform).filter(Boolean));
      return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
    });

    const counts = computed(() => {
      const c = { all: state.activities.length };
      for (const s of CONFIG.statuses) c[s.id] = 0;
      for (const a of state.activities) c[a.status] = (c[a.status] || 0) + 1;
      return c;
    });

    const statusTabs = computed(() => [
      { id: 'all', label: '全部', count: counts.value.all },
      ...CONFIG.statuses.map((s) => ({ id: s.id, label: `${s.emoji} ${s.label}`, count: counts.value[s.id] || 0 })),
    ]);

    const filteredActivities = computed(() => {
      const kw = state.search.toLowerCase();
      let list = state.activities.filter((a) => {
        if (state.statusFilter !== 'all' && a.status !== state.statusFilter) return false;
        if (state.platformFilter && a.platform !== state.platformFilter) return false;
        if (!kw) return true;
        const hay = [a.title, a.platform, a.value, a.notes, a.claim_steps, ...(a.tags || [])].join(' ').toLowerCase();
        return hay.includes(kw);
      });
      const sortTime = (a) => {
        const urg = computeUrgency(a, state.now);
        return urg.deadline ? urg.deadline.getTime() : Infinity;
      };
      list = list.slice().sort((a, b) => {
        const ta = computeUrgency(a, state.now).tier;
        const tb = computeUrgency(b, state.now).tier;
        if (ta !== tb) return ta - tb;
        const sa = sortTime(a), sb = sortTime(b);
        if (sa !== sb) return sa - sb;
        return (b.updated_at || '').localeCompare(a.updated_at || '');
      });
      return list;
    });

    // 顶栏消息红点：有未读就显示条数
    const unreadCount = computed(() => state.messages.filter((m) => !m.read).length);

    const paperCounts = computed(() => ({
      all: state.papers.length,
      to_read: state.papers.filter((p) => p.status === 'to_read').length,
      read: state.papers.filter((p) => p.status === 'read').length,
      noted: state.papers.filter((p) => (p.logs || []).length).length,
      unnoted: state.papers.filter((p) => !(p.logs || []).length).length,
    }));

    // 笔记全文（含「最有用的部分」标签），供搜索使用
    function logHaystack(logs) {
      return logs.flatMap((l) => [
        l.read_at, ...NOTE_TEXT_FIELDS.map((f) => l[f]), ...notePartsText(l),
      ]).filter(Boolean);
    }

    const filteredPapers = computed(() => {
      const kw = state.paperSearch.toLowerCase();
      return state.papers
        .filter((p) => {
          if (state.paperFilter.status !== 'all' && p.status !== state.paperFilter.status) return false;
          if (state.paperFilter.category && p.category !== state.paperFilter.category) return false;
          const logs = p.logs || [];
          if (state.paperFilter.note === 'has' && !logs.length) return false;
          if (state.paperFilter.note === 'none' && logs.length) return false;
          if (!kw) return true;
          const hay = [p.title, p.category, p.file_name, p.notes, ...logHaystack(logs)].join(' ').toLowerCase();
          return hay.includes(kw);
        })
        // 排序：最近阅读时间倒序（点过「📖 阅读」的置顶，没读过按添加时间）；
        // 键相同时用添加时间、标题兜底，保证顺序稳定不抖动
        .sort((a, b) => readSortKey(b) - readSortKey(a)
          || String(b.created_at || '').localeCompare(String(a.created_at || ''))
          || String(a.title || '').localeCompare(String(b.title || ''), 'zh'));
    });

    /* ---- 网页板块：派生数据 ---- */
    const siteCounts = computed(() => ({
      all: state.sites.length,
      to_read: state.sites.filter((s) => s.status === 'to_read').length,
      read: state.sites.filter((s) => s.status === 'read').length,
      noted: state.sites.filter((s) => (s.logs || []).length).length,
      unnoted: state.sites.filter((s) => !(s.logs || []).length).length,
    }));

    const siteKindOptions = computed(() => CONFIG.siteNote.kinds);
    const siteUsageOptions = computed(() => CONFIG.siteNote.usage);
    // 已记录过的链接（新建时用来提示重复）
    const siteUrls = computed(() => state.sites.map((s) => normalizeUrl(s.url)).filter(Boolean));

    // 网页全文（标题 / 域名 / 链接 / 标签 / 备注 + 所有笔记字段），供搜索使用
    function siteHaystack(site) {
      return [
        site.title, site.domain, site.url, site.notes, ...(site.tags || []),
        ...(site.logs || []).flatMap((l) => [l.read_at, l.usage, ...siteNoteKeys().map((k) => l[k])]),
      ].filter(Boolean);
    }

    const filteredSites = computed(() => {
      const kw = state.siteSearch.toLowerCase();
      return state.sites
        .filter((s) => {
          if (state.siteFilter.status !== 'all' && s.status !== state.siteFilter.status) return false;
          if (state.siteFilter.kind && s.kind !== state.siteFilter.kind) return false;
          const logs = s.logs || [];
          if (state.siteFilter.usage === 'none') {
            if (logs.length) return false;
          } else if (state.siteFilter.usage && !logs.some((l) => l.usage === state.siteFilter.usage)) {
            return false;
          }
          if (!kw) return true;
          return siteHaystack(s).join(' ').toLowerCase().includes(kw);
        })
        // 排序规则与文献一致：最近阅读时间倒序（点过「🌐 打开」的置顶），没读过按添加时间
        .sort((a, b) => readSortKey(b) - readSortKey(a)
          || String(b.created_at || '').localeCompare(String(a.created_at || ''))
          || String(a.title || '').localeCompare(String(b.title || ''), 'zh'));
    });

    /* ---- 花销板块：派生数据 ---- */
    // 当前期间（年 / 月）内的记录，再按搜索词过滤；日期倒序，同一天按录入时间倒序
    const expensePeriodItems = computed(() => {
      const kw = state.expenseSearch.toLowerCase();
      const { mode, year, month } = state.expensePeriod;
      const ym = `${year}-${pad2(month)}`;
      return state.expenses
        .filter((e) => {
          const m = monthOf(e.date);
          if (mode === 'year' ? !m.startsWith(String(year)) : m !== ym) return false;
          if (!kw) return true;
          return [e.title, e.notes, e.date].join(' ').toLowerCase().includes(kw);
        })
        .sort((a, b) => String(b.date).localeCompare(String(a.date))
          || String(b.created_at || '').localeCompare(String(a.created_at || '')));
    });

    // 列表与合计再叠加类别筛选（年视图下钻后，列表只留这一类）
    const expenseVisibleItems = computed(() => (state.expenseCategory
      ? expensePeriodItems.value.filter((e) => e.category === state.expenseCategory)
      : expensePeriodItems.value));

    const expenseTotal = computed(() => expenseVisibleItems.value.reduce((sum, e) => sum + (Number(e.amount) || 0), 0));

    // 饼图两级：
    //   年视图未下钻 → 类别层（📦 套餐 / 🔌 API 两个扇区）
    //   年视图已下钻 → 按名字合并的逐笔层（这一年在这个名目上花了多少）
    //   月视图 → 条目层（每笔一个扇区，超过 maxSlices 时合并「其余 N 笔」）
    const expenseChart = computed(() => {
      if (state.expensePeriod.mode === 'year' && !state.expenseCategory) {
        const cat = buildCategorySlices(expensePeriodItems.value);
        return { level: 'category', slices: cat.slices, total: cat.total };
      }
      const rows = state.expensePeriod.mode === 'year'
        ? groupExpenseByTitle(expenseVisibleItems.value)
        : expenseVisibleItems.value;
      const item = buildPieSlices(rows, CONFIG.expenses.maxSlices);
      return { level: 'item', slices: item.slices, total: item.total };
    });

    const expenseCategories = computed(() => CONFIG.expenses.categories);
    const expensePeriodLabel = computed(() => periodLabel(state.expensePeriod));
    // 年份下拉：有记录的年份 + 今年 + 当前所选年份
    const expenseYearOptions = computed(() => {
      const years = new Set(state.expenses.map((e) => Number(String(e.date).slice(0, 4))).filter(Boolean));
      years.add(new Date().getFullYear());
      years.add(state.expensePeriod.year);
      return [...years].sort((a, b) => b - a);
    });

    /* ---- 花销板块：体感评价（全量历史视角，不随月 / 年期间切换） ---- */
    const expenseInsights = computed(() => {
      const verdictOf = new Map(state.insights.map((v) => [v.subject, v]));
      const rows = [];
      for (const subject of CONFIG.expenses.subjects) {
        const insight = buildSubjectInsight(subject, state.expenses);
        const verdict = verdictOf.get(subject.id) || null;
        // 有匹配花销、或用户写过评价的主体才上板；只写了评价没花过钱的排后面
        if (insight.count || verdict) rows.push({ subject, insight, verdict });
      }
      rows.sort((a, b) => b.insight.total - a.insight.total);
      // 没认领到任何主体的花销：提示用户去 config.js 加关键词，免得体感悄悄漏掉
      const unmatched = state.expenses.filter((e) => !matchSubjects(e).length);
      return { rows, unmatched };
    });
    // 未识别提示条的文字：列前 5 个标题，多了用「等 N 笔」收尾
    const expenseUnmatchedText = computed(() => {
      const list = expenseInsights.value.unmatched;
      const titles = list.slice(0, 5).map((e) => String(e.title || '未命名'));
      return titles.join('、') + (list.length > 5 ? ` 等 ${list.length} 笔` : '');
    });

    // 横幅：待领取且领取截止 ≤7 天（含已超时） + 已领取且使用截止 ≤48 小时 + 截止待确认的蛋
    const urgentItems = computed(() => {
      const items = [];
      for (const a of state.activities) {
        const urg = computeUrgency(a, state.now);
        const isClaimUrgent = a.status === 'pending' && urg.remainingMs !== null && urg.remainingMs <= CONFIG.urgent.yellow * HOUR;
        const isValidUrgent = a.status === 'claimed' && urg.remainingMs !== null && urg.remainingMs <= 48 * HOUR;
        const isUnknown = urg.level === 'unknown';
        if (!isClaimUrgent && !isValidUrgent && !isUnknown) continue;
        const meta = statusMeta(a.status);
        items.push({
          key: a.id + (a.claim_deadline || '') + (a.valid_until || ''),
          id: a.id, platform: a.platform, title: a.title,
          shortTitle: a.title.length > 12 ? a.title.slice(0, 12) + '…' : a.title,
          status: a.status, statusEmoji: meta.emoji, statusLabel: meta.label,
          level: urg.level, label: urg.label,
          remainingText: isUnknown ? '待确认 ❓' : formatRemaining(urg.remainingMs),
        });
      }
      return items.sort((x, y) => {
        const order = ['over', 'red', 'orange', 'yellow', 'unknown'];
        return order.indexOf(x.level) - order.indexOf(y.level);
      });
    });

    /* ---- 其他交互 ---- */
    function openEditor(activity) {
      state.editing = activity ? { ...activity } : null;
      state.editorOpen = true;
    }

    /* ---- 定位：横幅条目 / 系统通知 / 消息卡片都走这里 ---- */

    // 切到这颗蛋自己的状态分类，并清掉平台与搜索筛选，保证它一定出现在列表里
    function focusActivity(id) {
      const target = state.activities.find((a) => a.id === id);
      if (!target) return null;
      if (state.board !== 'eggs') switchBoard('eggs');
      state.statusFilter = target.status; // 属于哪个分类就跳到哪个分类
      state.platformFilter = '';
      state.search = '';
      return target;
    }

    // 卡片高亮：同一张卡被重复触发时先熄一次，让 CSS 动画能重新播放
    let flashTimer = null;
    function flashCard(id) {
      clearTimeout(flashTimer);
      const start = () => {
        state.flashId = id;
        flashTimer = setTimeout(() => { state.flashId = null; }, FLASH_MS);
      };
      if (state.flashId === id) { state.flashId = null; nextTick(start); } else start();
    }

    function jumpTo(id) {
      const target = focusActivity(id);
      if (!target) return toast('这颗蛋已经不在了，可能已被删除', 'warn');
      const meta = statusMeta(target.status);
      toast(`已跳到「${meta.emoji} ${meta.label}」`);
      nextTick(() => requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = document.getElementById('card-' + id);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        flashCard(id);
      })));
    }

    // 从消息跳回对应的蛋：分类与筛选处理跟横幅、通知完全一致
    function gotoActivity(id) {
      if (!state.activities.some((a) => a.id === id)) return toast('这条消息对应的蛋已经删掉了', 'warn');
      jumpTo(id);
    }

    function setNotify(on) {
      state.notifyOn = on;
      localStorage.setItem('danji.notifyOn', on ? '1' : '0');
    }

    async function toggleNotify() {
      if (typeof Notification === 'undefined') return toast('此浏览器不支持桌面通知', 'warn');
      if (state.notifPermission === 'denied') {
        return toast('通知被浏览器拒绝了，可在地址栏权限里重新允许', 'warn');
      }
      if (state.notifPermission !== 'granted') {
        const perm = await Notification.requestPermission();
        state.notifPermission = perm;
        if (perm !== 'granted') {
          return toast(perm === 'denied' ? '通知被浏览器拒绝了，可在地址栏权限里重新允许' : '没有授权，随时点铃铛再试', 'warn');
        }
        setNotify(true);
        toast(`桌面通知已开启 🔔（${CONFIG.remind.hours} 小时内到期的蛋会提醒你）`);
        checkReminders();
        return;
      }
      // 已授权：铃铛就是真开关
      if (state.notifyOn) {
        setNotify(false);
        toast('已关闭桌面通知 🔕，到期不再弹提醒，点铃铛可重新打开');
      } else {
        setNotify(true);
        toast(`已开启桌面通知 🔔（${CONFIG.remind.hours} 小时内到期的蛋会提醒你）`);
        checkReminders();
      }
    }

    function checkReminders() {
      if (!state.notifyOn) return; // 用户关掉了提醒开关
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const now = Date.now();
      for (const a of state.activities) {
        const urg = computeUrgency(a, now);
        if (!urg.deadline || urg.remainingMs <= 0 || urg.remainingMs > CONFIG.remind.hours * HOUR) continue;
        const key = `${a.id}|${a.claim_deadline}|${a.valid_until}`;
        if (notifiedKeys.has(key)) continue;
        rememberNotified(key);
        const isClaim = a.status === 'pending';
        const n = new Notification(`${isClaim ? '🥚 蛋快不能领了' : '⏳ 领到的蛋快过期了'} · ${a.platform}`, {
          body: `${a.title}\n${urg.label} ${formatDate(a.claim_deadline || a.valid_until)}，${formatRemaining(urg.remainingMs)}`,
          tag: a.id,
        });
        n.onclick = () => { window.focus(); jumpTo(a.id); n.close(); };
      }
    }

    // 到点的蛋自动流转：已领取的过了使用截止 →「已过期」；待领取的过了领取截止 →「已截止」。
    // 只有填了明确截止时间才能自动判；没填 /「待定」/ 看不懂的仍留给用户手动确认。
    // 串行提交：服务端每次写盘都用同一个临时文件
    let settleRunning = false;
    async function settleOverdue() {
      if (settleRunning) return;
      settleRunning = true;
      try {
        const now = Date.now();
        const isEditing = (a) => state.editorOpen && state.editing && state.editing.id === a.id; // 正在编辑的先别动
        const expiredDue = state.activities.filter((a) => {
          if (a.status !== 'claimed' || !a.valid_until || isEditing(a)) return false;
          const d = parseStoredDate(a.valid_until);
          return !isNaN(d.getTime()) && d.getTime() <= now;
        });
        const closedDue = state.activities.filter((a) => {
          if (a.status !== 'pending' || !a.claim_deadline || isEditing(a)) return false;
          const d = parseStoredDate(a.claim_deadline);
          return !isNaN(d.getTime()) && d.getTime() <= now;
        });
        if (!expiredDue.length && !closedDue.length) return;
        const expired = [];
        const closed = [];
        for (const a of expiredDue) {
          if (await patchActivity(a, { status: 'expired' })) expired.push(a);
        }
        for (const a of closedDue) {
          if (await patchActivity(a, { status: 'closed' })) closed.push(a);
        }
        // toast 是单例，多条必须聚合成一条，否则只看到最后一条
        const parts = [];
        if (closed.length) {
          parts.push(closed.length === 1
            ? `⏳ ${closed[0].platform} · ${closed[0].title} 过了领取截止，已自动移入「已截止」`
            : `⏳ ${closed.length} 颗蛋过了领取截止，已自动移入「已截止」`);
        }
        if (expired.length) {
          parts.push(expired.length === 1
            ? `💤 ${expired[0].platform} · ${expired[0].title} 过了使用截止，已自动移入「已过期」`
            : `💤 ${expired.length} 颗蛋过了使用截止，已自动移入「已过期」`);
        }
        if (!parts.length) return;
        toast(parts.join('；'), 'warn');
        for (const a of closed) { notifyClosed(a); pushClosedMessage(a); }
        for (const a of expired) { notifyExpired(a); pushExpiredMessage(a); }
      } finally {
        settleRunning = false;
      }
    }

    function notifyExpired(activity) {
      if (!state.notifyOn) return;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const key = `expired|${activity.id}|${activity.valid_until}`;
      if (notifiedKeys.has(key)) return;
      rememberNotified(key);
      const n = new Notification(`💤 蛋过期了 · ${activity.platform}`, {
        body: `${activity.title}\n使用截止 ${formatDate(activity.valid_until)} 已过，已移入「已过期」`,
        tag: activity.id,
      });
      n.onclick = () => { window.focus(); jumpTo(activity.id); n.close(); };
    }

    function notifyClosed(activity) {
      if (!state.notifyOn) return;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const key = `closed|${activity.id}|${activity.claim_deadline}`;
      if (notifiedKeys.has(key)) return;
      rememberNotified(key);
      const n = new Notification(`⏳ 蛋已截止 · ${activity.platform}`, {
        body: `${activity.title}\n领取截止 ${formatDate(activity.claim_deadline)} 已过，已移入「已截止」`,
        tag: activity.id,
      });
      n.onclick = () => { window.focus(); jumpTo(activity.id); n.close(); };
    }

    /* ---- 示例数据 ---- */
    async function loadSamples() {
      const now = Date.now();
      const iso = (ms) => {
        const d = new Date(ms);
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      };
      const day = (n) => now + n * 24 * HOUR;
      const samples = [
        {
          platform: 'Claude', title: '周末积分返场', type: 'voucher', value: '$5 额度',
          claim_deadline: iso(now + 5 * HOUR), valid_until: '', link: 'https://example.com/claude',
          claim_steps: '登录 → Settings → Billing → 点击 Redeem', tags: ['示例'], notes: '每个账号限领一次',
          status: 'pending',
        },
        {
          platform: 'Kimi', title: '开学季月卡 7 折', type: 'discount', value: '月卡 7 折',
          claim_deadline: iso(day(2)), valid_until: '', link: 'https://example.com/kimi',
          claim_steps: '打开活动页 → 登录 → 点领取后下单生效', tags: ['示例'], notes: '',
          status: 'pending',
        },
        {
          platform: 'Gemini', title: '学生认证送 12 个月 Pro', type: 'trial', value: '12 个月 Pro',
          claim_deadline: iso(day(5)), valid_until: iso(day(370)).slice(0, 10), link: 'https://example.com/gemini',
          claim_steps: '用学生邮箱验证 → 活动页一键开通', tags: ['示例'], notes: '需要 .edu 邮箱',
          status: 'pending',
        },
        {
          platform: 'DeepSeek', title: '新用户注册额度', type: 'free_credits', value: '100 万 tokens',
          claim_deadline: null, valid_until: '', link: '', claim_steps: '注册即送，无需操作', tags: ['示例'], notes: '',
          status: 'pending',
        },
      ];
      for (const s of samples) {
        await fetch('/api/activities', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(s),
        });
      }
      await load();
      toast('已填入 4 条示例数据，可随意编辑或删除 🧪');
    }

    /* ---- 定时器 ---- */
    let tickTimer = null, remindTimer = null;
    function onVisibility() {
      // 浏览器会把后台标签页的定时器拖慢到几分钟一次，切回来的瞬间立刻补查一次
      if (document.visibilityState === 'visible') checkReminders();
    }
    onMounted(async () => {
      applyTheme(); // 内联脚本已经设过，这里兜一次（也覆盖脚本被禁用的情况）
      if (systemDark.addEventListener) systemDark.addEventListener('change', onSystemThemeChange);
      else if (systemDark.addListener) systemDark.addListener(onSystemThemeChange);
      window.addEventListener('storage', onStorageTheme);
      const topbarEl = document.querySelector('.topbar');
      if (topbarEl && typeof ResizeObserver !== 'undefined') {
        topbarObserver = new ResizeObserver(syncTopbarHeight);
        topbarObserver.observe(topbarEl);
      }
      syncTopbarHeight();

      await load();
      try {
        await loadMessages(); // 必须先加载完消息，再扫过期，否则新消息会被加载结果覆盖
      } catch (e) {
        // 服务不可用时不中断初始化：否则重试成功后提醒定时器也不会跑
      }
      settleOverdue();
      loadPapers();
      loadSites();
      loadExpenses();
      loadInsights();
      loadIdeas();
      tickTimer = setInterval(() => { state.now = Date.now(); settleOverdue(); }, 30 * 1000);
      remindTimer = setInterval(checkReminders, CONFIG.remind.checkIntervalSec * 1000);
      document.addEventListener('visibilitychange', onVisibility);
    });
    onUnmounted(() => {
      clearInterval(tickTimer);
      clearInterval(remindTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      if (topbarObserver) topbarObserver.disconnect();
      if (systemDark.removeEventListener) systemDark.removeEventListener('change', onSystemThemeChange);
      else if (systemDark.removeListener) systemDark.removeListener(onSystemThemeChange);
      window.removeEventListener('storage', onStorageTheme);
    });

    return {
      state, statusTabs, filteredActivities, urgentItems, platformOptions, toast,
      openEditor, saveActivity, setStatus, removeActivity, jumpTo,
      loadSamples, toggleNotify, load,
      paperCounts, filteredPapers, switchBoard,
      openPaperEditor, savePaper, setPaperStatus, openPaper, openPaperReveal, removePaper,
      logPaper, startPaperRead, openPaperLog, savePaperLog, removePaperLog, editPaperLog, newPaperLog,
      backToLogList, closePaperLog, saveLogDraft, discardLogDraft,
      siteCounts, filteredSites, siteNoteItem, siteKindOptions, siteUsageOptions, siteUrls,
      openSiteEditor, saveSite, setSiteStatus, openSite, removeSite,
      startSiteRead, openSiteNote, saveSiteNote, removeSiteNote, editSiteNote, newSiteNote,
      backToSiteNoteList, closeSiteNote, saveSiteNoteDraft, discardSiteNoteDraft,
      expensePeriodItems, expenseVisibleItems, expenseTotal, expenseChart, expenseCategories,
      expensePeriodLabel, expenseYearOptions,
      expenseInsights, expenseUnmatchedText,
      openExpenseEditor, saveExpense, removeExpense, setExpenseMode, setExpenseYear, setExpenseMonth,
      stepExpensePeriod, formatMoney, defaultExpenseDate, pickExpenseCategory, clearExpenseCategory,
      setExpenseView, saveInsightVerdict, clearInsightVerdict,
      unreadCount, gotoActivity, markMessageRead, removeMessage, markAllRead, clearReadMessages,
      filteredIdeas, openIdeaEditor, saveIdea, removeIdea,
      cycleTheme, themeIcon, themeTitle,
      notifActive: computed(() => state.notifPermission === 'granted' && state.notifyOn),
      notifTitle: computed(() => {
        const h = CONFIG.remind.hours;
        if (state.notifPermission === 'denied') return '桌面通知被浏览器拒绝，可在浏览器设置里重新允许';
        if (state.notifPermission !== 'granted') return `开启桌面通知：到期前 ${h} 小时提醒`;
        return state.notifyOn
          ? `桌面通知已开启：到期前 ${h} 小时提醒，点击关闭`
          : '桌面通知已关闭，点击重新开启';
      }),
    };
  },
});

app.component('egg-card', EggCard);
app.component('egg-editor', EggEditor);
app.component('paper-card', PaperCard);
app.component('paper-editor', PaperEditor);
app.component('paper-log-drawer', PaperLogDrawer);
app.component('site-card', SiteCard);
app.component('site-editor', SiteEditor);
app.component('site-note-drawer', SiteNoteDrawer);
app.component('expense-stats', ExpenseStats);
app.component('expense-card', ExpenseCard);
app.component('expense-editor', ExpenseEditor);
app.component('insight-card', InsightCard);
app.component('message-card', MessageCard);
app.component('idea-card', IdeaCard);
app.component('idea-editor', IdeaEditor);

// 全局兜底：未被处理的网络/脚本错误给出可见提示，不再静默失败（覆盖删除、状态流转等所有板块的请求）
const describeError = (e) => (e instanceof TypeError)
  ? '网络请求失败：无法连接服务，请确认拾穗集服务已启动'
  : ('操作失败：' + ((e && e.message) ? e.message : e));
app.config.errorHandler = (err) => {
  console.error('[shisuiji] 前端错误:', err);
  if (toastBridge) toastBridge(describeError(err), 'warn');
};
window.addEventListener('unhandledrejection', (e) => {
  console.error('[shisuiji] 未处理的请求错误:', e.reason);
  if (toastBridge) toastBridge(describeError(e.reason), 'warn');
});

app.mount('#app');
