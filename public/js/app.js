/* 拾穗集 —— 前端应用（Vue 3 运行时编译，无构建步骤）
   板块：🥚 赛博鸡蛋（原蛋记） / 📄 文献（论文待读已读管理） */
import { createApp, reactive, computed, ref, onMounted, onUnmounted, nextTick, provide } from './vue-globals.js';
import { state } from './state.js';
import { toast } from './toast.js';
import { applyTheme, cycleTheme, themeIcon, themeTitle, systemDark, onSystemThemeChange, onStorageTheme } from './theme.js';
import { switchBoard, syncTopbarHeight, observeTopbar, stopObserveTopbar } from './ui.js';
import { loadMessages, pushExpiredMessage, pushClosedMessage, markMessageRead, removeMessage, markAllRead, clearReadMessages, unreadCount } from './boards/messages.js';
import { NOTIFIED_KEY, rememberNotified, load, saveActivity, patchActivity, setStatus, removeActivity, platformOptions, counts, statusTabs, filteredActivities, urgentItems, openEditor, focusActivity, jumpTo, gotoActivity, setNotify, toggleNotify, checkReminders, settleRunning, settleOverdue, notifyExpired, notifyClosed, loadSamples } from './boards/eggs.js';
import { loadPapers, openPaperEditor, savePaper, setPaperStatus, logPaper, openPaperLog, startPaperRead, newPaperLog, editPaperLog, backToLogList, draftTimer, saveLogDraft, discardLogDraft, closePaperLog, savePaperLog, removePaperLog, openPaper, openPaperReveal, removePaper, paperCounts, logHaystack, filteredPapers } from './boards/papers.js';
import { loadSites, openSiteEditor, saveSite, setSiteStatus, openSite, removeSite, siteNoteItem, openSiteNote, startSiteRead, newSiteNote, editSiteNote, backToSiteNoteList, siteDraftTimer, saveSiteNoteDraft, discardSiteNoteDraft, closeSiteNote, saveSiteNote, removeSiteNote, siteCounts, siteKindOptions, siteUsageOptions, siteUrls, siteHaystack, filteredSites } from './boards/sites.js';
import { expensePeriodInit, loadExpenses, openExpenseEditor, saveExpense, removeExpense, setExpenseMode, pickExpenseCategory, clearExpenseCategory, setExpenseYear, setExpenseMonth, stepExpensePeriod, expensePeriodItems, expenseVisibleItems, expenseTotal, expenseChart, expenseCategories, expensePeriodLabel, expenseYearOptions } from './boards/expenses.js';
import { loadInsights, setExpenseView, saveInsightVerdict, clearInsightVerdict, expenseInsights, expenseUnmatchedText } from './boards/insights.js';
import { loadIdeas, filteredIdeas, openIdeaEditor, saveIdea, removeIdea } from './boards/ideas.js';
import { SyncStatus } from './components/sync-status.js';
import { installSync, disposeSync } from './sync/engine.js';

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

    let savedNotified = [];
    try { savedNotified = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '[]'); } catch (e) {}
    const notifiedKeys = new Set(Array.isArray(savedNotified) ? savedNotified : []);
    provide('toast', toast); // 子组件（卡片等）通过 inject 使用
    toastBridge = toast;     // 回填给全局兜底，服务异常时也能给出可见提示

    /* ---- 主题：跟随系统 → 浅色 → 深色（首屏由 index.html 的内联脚本先定好，避免闪白） ---- */

    // 顶栏换行后高度会变，实时同步 --topbar-h，保证紧急横幅吸顶位置正确



    // 改一条记录的若干个字段，成功后就地替换本地数据，失败返回 null





    // 蛋过期时写一条消息；服务端按「蛋 + 使用截止 + 领取截止」去重，重复调用不会攒出多条

    // 蛋过了领取截止时写一条消息，claim_deadline 参与服务端去重









    // mode: 'list' 看记录列表（没有记录时直接进表单） / 'new' 直接新建
    // pendingRead: 这次是"读完引导"，三行速记写满并保存后才真正归档

    // 点「✅ 读完了」：先写笔记，保存那一刻才归档，论文此刻状态与文件都不动


    // 草稿：内存留最新快照，写盘防抖 400ms；关闭时立刻补写，兜住"打完字就关"











    // 打开网页：先同步 window.open（放到 await 之后会被浏览器当弹窗拦掉），再回服务端记阅读时间



    // mode: 'list' 看笔记列表（没有笔记时直接进表单） / 'new' 直接新建
    // pendingRead: 这次是"读完引导"，写满门槛字段并保存后才真正归档到「已读」

    // 点「✅ 读完了」：先写笔记，保存那一刻才归档，网页状态此刻不动


    // 草稿：内存留最新快照，写盘防抖 400ms；关闭时立刻补写，兜住"打完字就关"











    // 保存某个主体的评价：按 subject upsert，卡片上的本地编辑在保存成功后由组件自己同步

    // 清除评价 = 回到纯记录视角：只删我的结论，花销记录和凝练出来的原话都不动


    // 列表已按 updated_at 倒序从服务端返回，这里只做搜索过滤（题目 + 正文都搜）




    // 点类别 = 下钻；再点同一个 = 回到总览
    // 期间步进：按月时跨年自动进位/退位





    // 顶栏消息红点：有未读就显示条数


    // 笔记全文（含「最有用的部分」标签），供搜索使用



    // 已记录过的链接（新建时用来提示重复）

    // 网页全文（标题 / 域名 / 链接 / 标签 / 备注 + 所有笔记字段），供搜索使用


    // 当前期间（年 / 月）内的记录，再按搜索词过滤；日期倒序，同一天按录入时间倒序

    // 列表与合计再叠加类别筛选（年视图下钻后，列表只留这一类）


    // 饼图两级：
    //   年视图未下钻 → 类别层（📦 套餐 / 🔌 API 两个扇区）
    //   年视图已下钻 → 按名字合并的逐笔层（这一年在这个名目上花了多少）
    //   月视图 → 条目层（每笔一个扇区，超过 maxSlices 时合并「其余 N 笔」）

    // 年份下拉：有记录的年份 + 今年 + 当前所选年份

    // 未识别提示条的文字：列前 5 个标题，多了用「等 N 笔」收尾

    // 横幅：待领取且领取截止 ≤7 天（含已超时） + 已领取且使用截止 ≤48 小时 + 截止待确认的蛋



    // 切到这颗蛋自己的状态分类，并清掉平台与搜索筛选，保证它一定出现在列表里

    // 卡片高亮：同一张卡被重复触发时先熄一次，让 CSS 动画能重新播放


    // 从消息跳回对应的蛋：分类与筛选处理跟横幅、通知完全一致




    // 到点的蛋自动流转：已领取的过了使用截止 →「已过期」；待领取的过了领取截止 →「已截止」。
    // 只有填了明确截止时间才能自动判；没填 /「待定」/ 看不懂的仍留给用户手动确认。
    // 串行提交：服务端每次写盘都用同一个临时文件




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
      observeTopbar();
      syncTopbarHeight();

      // P6：先探测角色。手机端启用同步层（镜像∪outbox），电脑端完全不走这层
      await installSync();

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
      stopObserveTopbar();
      if (systemDark.removeEventListener) systemDark.removeEventListener('change', onSystemThemeChange);
      else if (systemDark.removeListener) systemDark.removeListener(onSystemThemeChange);
      window.removeEventListener('storage', onStorageTheme);
      disposeSync();
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
app.component('sync-status', SyncStatus);

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
