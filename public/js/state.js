/* 拾穗集 —— 界面状态（一个 reactive 大对象，与原写法一致）
 * 从 app.js 原样搬过来的，逻辑一字未改。
 */

import { reactive } from './vue-globals.js';

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
  // 角色（权限）：desktop/mobile/unknown，来自 /api/health
  // 电脑上把窗口拖窄只会改 isPhone，不会把 role 变成 mobile
  role: 'unknown',
  // 布局视口：matchMedia('(max-width: 640px)')，只影响样式，不决定权限
  isPhone: false,
  // 手机端同步层：电脑端 enabled=false，界面不渲染胶囊
  sync: {
    enabled: false,
    role: 'unknown', // desktop | mobile | unknown（与 state.role 保持一致）
    needToken: false,
    offline: false, // health 不可达时的离线优先模式
    status: 'idle', // idle | offline | syncing | synced | conflicts | need_token | error
    pendingCount: 0,
    conflicts: [], // [{ id, op, entry, server, local }]
    lastSyncAt: null,
    lastError: '',
  },
  now: Date.now(),
  flashId: null,
  toast: { show: false, msg: '', type: 'ok' },
  notifPermission: typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  // 用户级软开关：浏览器权限无法被 JS 撤销，关闭提醒只能靠自己存状态
  notifyOn: localStorage.getItem('danji.notifyOn') !== '0',
});

export { state };
