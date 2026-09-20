/* ---------------- 组件：网页笔记抽屉（一个网页可记多条） ---------------- */
import { reactive, computed, watch, onMounted, onUnmounted } from '../vue-globals.js';

import { CONFIG } from '../../config.js';
import { blankSiteNote, kindMeta, siteNoteFields, siteNoteIsEmpty, siteNoteRows, usageMeta } from '../util/site-note.js';

const SiteNoteDrawer = {
  name: 'SiteNoteDrawer',
  props: {
    site: { type: Object, required: true },
    editing: { type: Object, default: null }, // null = 列表模式
    pendingRead: Boolean,                     // 这是"读完引导"：写满门槛字段才会归档
    restored: Boolean,                        // 表单内容来自上次没写完的草稿
  },
  emits: ['save', 'remove', 'edit', 'new', 'back', 'empty', 'draft', 'discard-draft', 'close'],
  setup(props, { emit }) {

    const kindOptions = CONFIG.siteNote.kinds;
    const usageOptions = CONFIG.siteNote.usage;

    function blank() { return blankSiteNote(props.site.kind); }

    const form = reactive(blank());
    watch(() => props.editing, (v) => {
      const base = blank();
      if (v) {
        for (const key of Object.keys(base)) base[key] = v[key] || '';
      }
      Object.assign(form, base);
    }, { immediate: true });

    // 当前要渲染的字段：共用 + 所选类型专属（切类型时另一套已填的内容保留在 form 里，只是不显示）
    const fields = computed(() => siteNoteFields(form.kind));

    const logs = computed(() => [...(props.site.logs || [])]
      .sort((a, b) => String(b.read_at || '').localeCompare(String(a.read_at || ''))));

    const logRows = (log) => siteNoteRows(log);
    const logKind = (log) => kindMeta(log.kind);
    const logUsage = (log) => usageMeta(log.usage);

    function save() {
      if (siteNoteIsEmpty(form)) return emit('empty');
      emit('save', { ...form });
    }
    function cancel() { emit(logs.value.length ? 'back' : 'close'); }

    // 表单每次变化都把快照交给根应用（根应用负责防抖写 localStorage），
    // 这样"打完字立刻关抽屉"也不会丢内容
    const snapshot = () => ({ ...form });
    watch(form, () => emit('draft', snapshot()), { deep: true });

    function discardDraft() {
      Object.assign(form, blank());
      emit('discard-draft');
    }

    const onKey = (e) => { if (e.key === 'Escape') emit('close'); };
    onMounted(() => window.addEventListener('keydown', onKey));
    onUnmounted(() => window.removeEventListener('keydown', onKey));

    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      kindOptions, usageOptions, form, fields, logs, logRows, logKind, logUsage,
      save, cancel, discardDraft,
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
        <h2>{{ editing ? (editing.id ? '✏️ 编辑笔记' : '📝 记一条笔记') : '📝 笔记' }}</h2>
        <button class="btn ghost small" @click="close">✕</button>
      </header>

      <!-- 列表模式：按读完日期倒序，一条一张小卡片 -->
      <div class="drawer-body" v-if="!editing">
        <p class="log-paper">🌐 {{ site.title }}</p>
        <button class="btn primary small" @click="emitNew">＋ 再记一条</button>
        <p class="log-empty" v-if="!logs.length">
          还没有笔记。读完记一条，下次想复用的时候能直接搜回来。
        </p>
        <article class="log-item" v-for="log in logs" :key="log.id">
          <div class="log-item-head">
            <span class="log-date">🗓 {{ log.read_at || '未填日期' }}</span>
            <span class="kind-badge" :class="'k-' + log.kind">{{ logKind(log).emoji }} {{ logKind(log).label }}</span>
            <span class="usage-badge" :class="'usage-' + log.usage" v-if="logUsage(log)">{{ logUsage(log).emoji }} {{ logUsage(log).label }}</span>
            <span class="spacer"></span>
            <button class="btn small ghost" @click="emitEdit(log)" title="编辑这条笔记">✏️</button>
            <button class="btn small danger" @click="emitRemove(log)" title="删除这条笔记">🗑</button>
          </div>
          <div class="log-row" v-for="row in logRows(log)" :key="row.key">
            <b>{{ row.label }}</b><span class="pre-wrap">{{ log[row.key] }}</span>
          </div>
          <p class="log-blank" v-if="!logRows(log).length">（这条笔记还没写内容）</p>
        </article>
      </div>

      <!-- 表单模式 -->
      <form class="drawer-form" v-else @submit.prevent="save">
        <p class="log-paper">🌐 {{ site.title }}</p>
        <p class="log-tip">{{ pendingRead
          ? (form.kind === 'tech'
              ? '技术网页：写满「一句话 + 关键做法 + 结论」才会归档到「已读」；直接关掉就还算「待读」，内容会存成草稿。'
              : '杂项网页：写一句「它讲了什么」就能归档到「已读」；直接关掉就还算「待读」，内容会存成草稿。')
          : '重读补记：写你有感觉的那几栏就行。' }}</p>
        <p class="log-restored" v-if="restored">
          ↩️ 已恢复上次没写完的草稿
          <button type="button" class="mini-link" @click="discardDraft">🗑 丢弃草稿</button>
        </p>

        <p class="drawer-section">这是哪类网页？</p>
        <div class="chip-picks">
          <button type="button" class="chip-pick" v-for="k in kindOptions" :key="k.id"
                  :class="{ on: form.kind === k.id }" @click="form.kind = k.id">
            {{ k.emoji }} {{ k.label }}
          </button>
        </div>

        <label>🗓 读完日期
          <input v-model="form.read_at" placeholder="2026-09-10">
        </label>

        <p class="drawer-section">用得上吗</p>
        <div class="chip-picks">
          <button type="button" class="chip-pick" v-for="u in usageOptions" :key="u.id"
                  :class="{ on: form.usage === u.id }" @click="form.usage = form.usage === u.id ? '' : u.id">
            {{ u.emoji }} {{ u.label }}
          </button>
        </div>

        <label v-for="f in fields" :key="f.key">{{ f.label }}
          <textarea v-model="form[f.key]" :rows="f.rows || 2" :placeholder="f.placeholder || ''"></textarea>
        </label>

        <footer class="drawer-foot">
          <button type="button" class="btn ghost" @click="cancel">取消</button>
          <button type="submit" class="btn primary">💾 保存笔记</button>
        </footer>
      </form>
    </aside>
  </div>
  `,
};

export { SiteNoteDrawer };
