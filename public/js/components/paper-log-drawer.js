/* ---------------- 组件：阅读记录抽屉（一篇论文可记多条） ---------------- */
import { reactive, computed, watch, onMounted, onUnmounted } from '../vue-globals.js';

import { CONFIG } from '../../config.js';
import { blankPaperLog, noteIsEmpty, notePartsText, noteRelMeta } from '../util/paper-note.js';

const PaperLogDrawer = {
  name: 'PaperLogDrawer',
  props: {
    paper: { type: Object, required: true },
    editing: { type: Object, default: null }, // null = 列表模式
    pendingRead: Boolean,                     // 这是"读完引导"：三行速记写满才会归档
    restored: Boolean,                        // 表单内容来自上次没写完的草稿
  },
  emits: ['save', 'remove', 'edit', 'new', 'back', 'empty', 'draft', 'discard-draft', 'close'],
  setup(props, { emit }) {

    const relevance = CONFIG.paperNote.relevance;
    const parts = CONFIG.paperNote.parts;
    // 列表模式里逐条展示的字段（有内容才显示）
    const ROWS = [
      { key: 'problem', label: '🎯 核心问题' },
      { key: 'method', label: '🔧 核心做法' },
      { key: 'finding', label: '📈 核心发现' },
      { key: 'usable', label: '💡 我能借鉴' },
      { key: 'quotable', label: '📝 可引用观点' },
      { key: 'next', label: '🚀 下一步' },
      { key: 'limits', label: '⚠️ 存疑或局限' },
      { key: 'impression', label: '💭 一句话感受' },
      { key: 'excerpt', label: '📖 表达与摘抄' },
    ];

    function blank() { return blankPaperLog(); }

    const form = reactive(blank());
    watch(() => props.editing, (v) => {
      const base = blank();
      if (v) {
        for (const key of Object.keys(base)) {
          base[key] = key === 'parts' ? [...(v.parts || [])] : (v[key] || '');
        }
      }
      Object.assign(form, base);
    }, { immediate: true });

    const logs = computed(() => [...(props.paper.logs || [])]
      .sort((a, b) => String(b.read_at || '').localeCompare(String(a.read_at || ''))));

    const logRows = (log) => ROWS.filter((r) => String(log[r.key] || '').trim());
    const relMeta = (log) => noteRelMeta(log.rel);
    const partLabels = (log) => notePartsText(log);

    function togglePart(id) {
      const i = form.parts.indexOf(id);
      if (i === -1) form.parts.push(id); else form.parts.splice(i, 1);
    }
    function save() {
      if (noteIsEmpty(form)) return emit('empty');
      emit('save', { ...form, parts: [...form.parts] });
    }
    function cancel() { emit(logs.value.length ? 'back' : 'close'); }

    // 表单每次变化都把快照交给根应用（根应用负责防抖写 localStorage），
    // 这样"打完字立刻关抽屉"也不会丢内容
    const snapshot = () => ({ ...form, parts: [...form.parts] });
    watch(form, () => emit('draft', snapshot()), { deep: true });

    function discardDraft() {
      Object.assign(form, blankPaperLog());
      emit('discard-draft');
    }

    const onKey = (e) => { if (e.key === 'Escape') emit('close'); };
    onMounted(() => window.addEventListener('keydown', onKey));
    onUnmounted(() => window.removeEventListener('keydown', onKey));

    // 只有按下和松开都发生在遮罩空白处才关闭（防止圈选文字误关）
    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      relevance, parts, form, logs, logRows, relMeta, partLabels, togglePart, save, cancel, discardDraft,
      emitNew: () => emit('new'),
      emitEdit: (log) => emit('edit', log),
      emitRemove: (log) => emit('remove', log),
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>{{ editing ? (editing.id ? '✏️ 编辑阅读记录' : '📝 记一条阅读记录') : '📝 阅读记录' }}</h2>
        <button class="btn ghost small" @click="close">✕</button>
      </header>

      <!-- 列表模式：按读完日期倒序，一条一张小卡片 -->
      <div class="drawer-body" v-if="!editing">
        <p class="log-paper">📄 {{ paper.title }}</p>
        <button class="btn primary small" @click="emitNew">＋ 再记一条</button>
        <p class="log-empty" v-if="!logs.length">
          还没有阅读记录。读完记一条，日后写 related work、找 gap、做对比实验都能翻回来用。
        </p>
        <article class="log-item" v-for="log in logs" :key="log.id">
          <div class="log-item-head">
            <span class="log-date">🗓 {{ log.read_at || '未填日期' }}</span>
            <span class="rel-badge" :class="'rel-' + log.rel" v-if="relMeta(log)">{{ relMeta(log).emoji }} {{ relMeta(log).label }}</span>
            <span class="spacer"></span>
            <button class="btn small ghost" @click="emitEdit(log)" title="编辑这条记录">✏️</button>
            <button class="btn small danger" @click="emitRemove(log)" title="删除这条记录">🗑</button>
          </div>
          <div class="log-row" v-for="row in logRows(log)" :key="row.key">
            <b>{{ row.label }}</b><span class="pre-wrap">{{ log[row.key] }}</span>
          </div>
          <div class="log-row" v-if="partLabels(log).length">
            <b>🧩 最有用的部分</b><span>{{ partLabels(log).join(' · ') }}</span>
          </div>
          <p class="log-blank" v-if="!logRows(log).length && !partLabels(log).length">（这条记录还没写内容）</p>
        </article>
      </div>

      <!-- 表单模式：什么都不强制，但全空会被拦下 -->
      <form class="drawer-form" v-else @submit.prevent="save">
        <p class="log-paper">📄 {{ paper.title }}</p>
        <p class="log-tip">{{ pendingRead
          ? '写满下面三行速记并保存，才会归档到「已读」；直接关掉就还算「待读」，内容会存成草稿。'
          : '趁热记下能复用的东西。不用全填，写你有感觉的那几栏就行。' }}</p>
        <p class="log-restored" v-if="restored">
          ↩️ 已恢复上次没写完的草稿
          <button type="button" class="mini-link" @click="discardDraft">🗑 丢弃草稿</button>
        </p>

        <label>🗓 读完日期
          <input v-model="form.read_at" placeholder="2026-09-08">
        </label>

        <p class="drawer-section">一句话速记</p>
        <label>🎯 核心问题（它指出的 gap）
          <textarea v-model="form.problem" rows="2" placeholder="例：现有 UDA 方法依赖目标域无标注数据，目标域完全不可见时不适用"></textarea>
        </label>
        <label>🔧 核心做法（关键机制）
          <textarea v-model="form.method" rows="2" placeholder="例：用风格随机化构造虚拟域，配不变性正则学习域不变表征"></textarea>
        </label>
        <label>📈 核心发现（结论 / 关键数字）
          <textarea v-model="form.finding" rows="2" placeholder="例：DomainBed 上平均 +2.3%，且对域的数量不敏感"></textarea>
        </label>

        <p class="drawer-section">课题对接</p>
        <label>🔗 和我的课题什么关系</label>
        <div class="chip-picks">
          <button type="button" class="chip-pick" v-for="r in relevance" :key="r.id"
                  :class="{ on: form.rel === r.id }" @click="form.rel = form.rel === r.id ? '' : r.id">
            {{ r.emoji }} {{ r.label }}
          </button>
        </div>
        <label>💡 我能借鉴什么
          <textarea v-model="form.usable" rows="2" placeholder="例：域随机化模块可替换我的特征对齐项，验证在 DG 下是否仍有效"></textarea>
        </label>
        <label>📝 可引用的观点（结论 + 页码/小节）
          <textarea v-model="form.quotable" rows="2" placeholder="例：p.5 “domain-invariant features alone are insufficient for unseen domains”（可放在 motivation）"></textarea>
        </label>
        <label>🚀 下一步能做什么
          <textarea v-model="form.next" rows="2" placeholder="例：它没处理域标签不可得的情形，可以往这个方向做"></textarea>
        </label>

        <p class="drawer-section">判断与摘抄</p>
        <label>🧩 最有用的部分</label>
        <div class="chip-picks">
          <button type="button" class="chip-pick" v-for="p in parts" :key="p.id"
                  :class="{ on: form.parts.includes(p.id) }" @click="togglePart(p.id)">{{ p.label }}</button>
        </div>
        <label>💭 一句话感受
          <input v-model="form.impression" placeholder="例：方法巧但实验偏弱，思路值得借">
        </label>
        <label>⚠️ 存疑或局限
          <textarea v-model="form.limits" rows="2" placeholder="例：只验证了 3 个域，域标签假设过强"></textarea>
        </label>
        <label>📖 表达与摘抄（金句 / 句式 / 词组搭配 / 逻辑连接词，一行一条）
          <textarea v-model="form.excerpt" rows="4" placeholder="例：&#10;表示对比：in contrast to / by contrast&#10;句式：X is not merely A but B&#10;金句：generalization requires invariance, not invariance alone."></textarea>
        </label>

        <footer class="drawer-foot">
          <button type="button" class="btn ghost" @click="cancel">取消</button>
          <button type="submit" class="btn primary">💾 保存记录</button>
        </footer>
      </form>
    </aside>
  </div>
  `,
};

export { PaperLogDrawer };
