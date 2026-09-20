/* ---------------- 组件：新增 / 编辑抽屉 ---------------- */

import { CONFIG } from '../../config.js';
import { parseFlexibleDate } from '../util/date.js';

const EggEditor = {
  name: 'EggEditor',
  props: {
    initial: { type: Object, default: null },
    // 已在数据里出现过的平台，和 config 常用列表合并做建议
    knownPlatforms: { type: Array, default: () => [] },
    // 保存请求进行中（父组件 saveActivity 在 fetch 期间置 true）
    saving: Boolean,
  },
  emits: ['save', 'close'],
  setup(props, { emit }) {
    const { reactive, computed, onMounted, onUnmounted, nextTick, ref } = Vue;
    const titleInput = ref(null);
    const lastPlatform = localStorage.getItem('danji.lastPlatform') || CONFIG.platforms[0];

    // 记录类型：claim 待领取 / use 待使用。新建沿用上次选择，编辑按当前状态定位
    const mode = ref(props.initial
      ? (props.initial.status === 'pending' ? 'claim' : 'use')
      : (localStorage.getItem('danji.lastEggKind') === 'use' ? 'use' : 'claim'));

    const form = reactive({
      platform: props.initial?.platform || lastPlatform,
      title: props.initial?.title || '',
      type: props.initial?.type || 'free_credits',
      value: props.initial?.value || '',
      claim_deadline: props.initial?.claim_deadline || '',
      valid_until: props.initial?.valid_until || '',
      claim_steps: props.initial?.claim_steps || '',
      link: props.initial?.link || '',
      // 新建时状态与顶部模式对齐（use→已领取），避免上次选了「待使用」直接保存却落成待领取
      status: props.initial?.status || (mode.value === 'use' ? 'claimed' : 'pending'),
      tagsText: (props.initial?.tags || []).join(', '),
      notes: props.initial?.notes || '',
    });

    // ---- 平台自定义下拉（替代不可靠的原生 datalist）----
    const comboOpen = ref(false);
    const comboIndex = ref(-1);
    const comboRoot = ref(null);
    const platformInput = ref(null);
    // 点箭头强制看全量；一旦继续输入就恢复过滤
    const comboShowAll = ref(false);

    // 建议列表：config 常用在前，已用平台补充在后，去重
    const platformSuggestions = computed(() => {
      const seen = new Set();
      const out = [];
      for (const p of [...CONFIG.platforms, ...props.knownPlatforms]) {
        const v = String(p || '').trim();
        if (!v) continue;
        const key = v.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
      }
      return out;
    });

    const filteredPlatforms = computed(() => {
      if (comboShowAll.value) return platformSuggestions.value;
      const q = String(form.platform || '').trim().toLowerCase();
      if (!q) return platformSuggestions.value;
      return platformSuggestions.value.filter((p) => p.toLowerCase().includes(q));
    });

    function openCombo(opts) {
      comboOpen.value = true;
      comboIndex.value = -1;
      comboShowAll.value = !!(opts && opts.showAll);
    }
    function toggleCombo() {
      if (comboOpen.value) closeCombo();
      else openCombo({ showAll: true });
    }
    function closeCombo() {
      comboOpen.value = false;
      comboIndex.value = -1;
      comboShowAll.value = false;
    }
    function pickPlatform(p) {
      form.platform = p;
      closeCombo();
      // 聚焦输入框方便继续改，但别触发 focus → 再次 openCombo
      suppressFocusOpen = true;
      platformInput.value && platformInput.value.focus();
    }
    function highlightNext() {
      if (!comboOpen.value) { openCombo(); return; }
      const n = filteredPlatforms.value.length;
      if (!n) return;
      comboIndex.value = comboIndex.value < n - 1 ? comboIndex.value + 1 : 0;
      scrollComboItemIntoView();
    }
    function highlightPrev() {
      if (!comboOpen.value) { openCombo(); return; }
      const n = filteredPlatforms.value.length;
      if (!n) return;
      comboIndex.value = comboIndex.value > 0 ? comboIndex.value - 1 : n - 1;
      scrollComboItemIntoView();
    }
    // 键盘换高亮时保证项在可视区内（列表长了以后不至于划出 max-height）
    async function scrollComboItemIntoView() {
      await nextTick();
      const menu = comboRoot.value && comboRoot.value.querySelector('.combo-menu');
      if (!menu) return;
      const item = menu.children[comboIndex.value];
      if (item && item.scrollIntoView) item.scrollIntoView({ block: 'nearest' });
    }
    function onComboEnter(e) {
      // 只有真的要选中高亮项时才拦 Enter；否则留给表单提交
      if (comboOpen.value && comboIndex.value >= 0) {
        const p = filteredPlatforms.value[comboIndex.value];
        if (p) {
          e.preventDefault();
          pickPlatform(p);
        }
      }
    }
    // 选中后主动 focus 时不要立刻把列表再拉开
    let suppressFocusOpen = false;
    function onComboFocus() {
      if (suppressFocusOpen) {
        suppressFocusOpen = false;
        return;
      }
      openCombo();
    }
    function onComboInput() { openCombo(); }
    // Esc：仅在列表打开时拦截；关着时放行给抽屉关闭逻辑
    function onComboEsc(e) {
      if (!comboOpen.value) return;
      e.preventDefault();
      e.stopPropagation();
      closeCombo();
    }
    // 点组件外部收起（mousedown 先于 blur，避免列表闪一下再关）
    function onDocMousedown(e) {
      if (!comboOpen.value) return;
      if (comboRoot.value && comboRoot.value.contains(e.target)) return;
      closeCombo();
    }

    // 切换记蛋类型：待领取 ↔ 待使用；被隐藏字段的已有值保留不丢。
    // 新建：模式决定初始状态。编辑：只切字段显隐，状态交给状态下拉，
    // 避免手滑点到「待领取」把已领取/已用完等静默改回待领取。
    function switchMode(next) {
      mode.value = next;
      if (!props.initial) {
        form.status = next === 'claim' ? 'pending' : 'claimed';
      }
    }
    // 编辑时的状态下拉与切换器联动
    function onStatusChange() {
      mode.value = form.status === 'pending' ? 'claim' : 'use';
    }

    // 截止时间实时解析预览，返回 null 时不显示提示
    const dateError = ref('');
    function preview(raw) {
      const v = String(raw || '').trim();
      if (!v) return null;
      if (v === '待定') return { state: 'ok', text: '→ 截止时间待确认，卡片会显示「待确认 ❓」并进横幅提醒' };
      const parsed = parseFlexibleDate(raw);
      return parsed
        ? { state: 'ok', text: `→ ${parsed.replace('T', ' ')}` }
        : { state: 'bad', text: '看不懂这个日期，试试 9-8、9/8 18:00、明天 14点' };
    }
    const claimPreview = computed(() => preview(form.claim_deadline));
    const validPreview = computed(() => preview(form.valid_until));
    // 一键标记/取消「截止时间待定」
    function markUnknown(field) {
      form[field] = form[field] === '待定' ? '' : '待定';
    }

    function save() {
      if (!form.platform.trim()) return alert('请填写平台名称');
      if (!form.title.trim()) return alert('请填写活动名称');
      for (const field of ['claim_deadline', 'valid_until']) {
        if (String(form[field] || '').trim() && !parseFlexibleDate(form[field])) {
          dateError.value = field; // 识别不了就拦截，让用户改写或清空
          return;
        }
      }
      dateError.value = '';
      localStorage.setItem('danji.lastPlatform', form.platform.trim());
      if (!props.initial) localStorage.setItem('danji.lastEggKind', mode.value);
      emit('save', {
        platform: form.platform.trim(),
        title: form.title.trim(),
        type: form.type,
        value: form.value.trim(),
        claim_deadline: form.claim_deadline.trim() ? parseFlexibleDate(form.claim_deadline) : null,
        valid_until: form.valid_until.trim() ? parseFlexibleDate(form.valid_until) : null,
        claim_steps: form.claim_steps.trim(),
        link: form.link.trim(),
        status: form.status,
        tags: form.tagsText.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
        notes: form.notes.trim(),
      });
    }
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // 下拉开着时 Esc 只收列表，不关整个抽屉
      if (comboOpen.value) { closeCombo(); return; }
      emit('close');
    };
    onMounted(async () => {
      window.addEventListener('keydown', onKey);
      document.addEventListener('mousedown', onDocMousedown);
      await nextTick();
      titleInput.value && titleInput.value.focus();
    });
    onUnmounted(() => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDocMousedown);
    });

    // 只有按下和松开都发生在遮罩空白处才关闭——
    // 从面板里圈选文字拖到面板外松手，click 会落在遮罩上，但不能算关闭意图
    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      form, save, titleInput, CONFIG, mode, switchMode, onStatusChange,
      claimPreview, validPreview, dateError, markUnknown,
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
      comboOpen, comboIndex, comboRoot, platformInput, filteredPlatforms,
      toggleCombo, pickPlatform, highlightNext, highlightPrev, onComboEnter,
      onComboFocus, onComboInput, onComboEsc, closeCombo,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>{{ initial ? '✏️ 编辑蛋' : (mode === 'claim' ? '🥚 记待领取的蛋' : '🧺 记待使用的蛋') }}</h2>
        <button class="btn ghost small" @click="close">✕</button>
      </header>
      <form class="drawer-form" @submit.prevent="save">
        <div class="seg">
          <button type="button" :class="{ active: mode === 'claim' }" @click="switchMode('claim')">🥚 待领取</button>
          <button type="button" :class="{ active: mode === 'use' }" @click="switchMode('use')">🧺 待使用</button>
        </div>
        <label>平台 *
          <div class="combo" ref="comboRoot">
            <div class="combo-control">
              <input ref="platformInput" v-model="form.platform"
                     placeholder="如 Kimi / Gemini / 即梦…"
                     autocomplete="off"
                     role="combobox" :aria-expanded="comboOpen ? 'true' : 'false'"
                     @focus="onComboFocus" @input="onComboInput"
                     @keydown.down.prevent="highlightNext"
                     @keydown.up.prevent="highlightPrev"
                     @keydown.enter="onComboEnter"
                     @keydown.esc="onComboEsc">
              <button type="button" class="combo-arrow" tabindex="-1"
                      :aria-expanded="comboOpen ? 'true' : 'false'"
                      aria-label="打开平台列表"
                      @click.stop="toggleCombo">▼</button>
            </div>
            <ul class="combo-menu" v-if="comboOpen && filteredPlatforms.length" role="listbox">
              <li v-for="(p, i) in filteredPlatforms" :key="p"
                  role="option" :class="{ on: i === comboIndex }"
                  @mouseenter="comboIndex = i"
                  @mousedown.prevent="pickPlatform(p)">{{ p }}</li>
            </ul>
          </div>
        </label>
        <label>活动名称 *
          <input ref="titleInput" v-model="form.title" placeholder="如：开学季 Pro 月卡 5 折"></label>
        <div class="row">
          <label>优惠形式
            <select v-model="form.type">
              <option v-for="t in CONFIG.types" :key="t.id" :value="t.id">{{ t.icon }} {{ t.label }}</option>
            </select>
          </label>
          <label>优惠力度
            <input v-model="form.value" placeholder="如：50 元额度 / 7 折"></label>
        </div>
        <label v-if="mode === 'claim'">⏰ 领取截止
          <div class="field-line">
            <input type="text" v-model="form.claim_deadline" :class="{ invalid: dateError === 'claim_deadline' }"
                   placeholder="如：9-8、9/8 18:00、明天 14点（可不填年份）" @input="dateError = ''">
            <button type="button" class="mini-link" @click="markUnknown('claim_deadline')" title="不清楚截止时间就先标记待定，之后卡片会提醒你确认">❓ 待定</button>
          </div>
          <span class="date-hint" v-if="claimPreview" :class="claimPreview.state">{{ claimPreview.text }}</span>
        </label>
        <label v-else>⏳ 使用截止
          <div class="field-line">
            <input type="text" v-model="form.valid_until" :class="{ invalid: dateError === 'valid_until' }"
                   placeholder="如：10-1、12月31日 23:59（可不填年份）" @input="dateError = ''">
            <button type="button" class="mini-link" @click="markUnknown('valid_until')" title="不清楚截止时间就先标记待定，之后卡片会提醒你确认">❓ 待定</button>
          </div>
          <span class="date-hint" v-if="validPreview" :class="validPreview.state">{{ validPreview.text }}</span>
        </label>
        <label v-if="mode === 'claim'">🧭 领取方法
          <textarea v-model="form.claim_steps" rows="3" placeholder="一步步写清楚，如：登录 → 个人中心 → 活动页点击领取"></textarea></label>
        <label>🔗 活动链接
          <input v-model="form.link" placeholder="https://…"></label>
        <label v-if="initial">状态
          <select v-model="form.status" @change="onStatusChange">
            <option v-for="s in CONFIG.statuses" :key="s.id" :value="s.id">{{ s.emoji }} {{ s.label }}</option>
          </select>
        </label>
        <label>🏷️ 标签
          <input v-model="form.tagsText" placeholder="逗号分隔，如：新用户, 限时"></label>
        <label>📝 备注
          <textarea v-model="form.notes" rows="2" placeholder="额度多少、注意事项…"></textarea></label>
        <footer class="drawer-foot">
          <button type="button" class="btn ghost" @click="close">取消</button>
          <button type="submit" class="btn primary" :disabled="saving">{{ saving ? '⏳ 保存中…' : '💾 保存' }}</button>
        </footer>
      </form>
    </aside>
  </div>
  `,
};

export { EggEditor };
