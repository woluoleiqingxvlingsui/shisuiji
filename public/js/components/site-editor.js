/* ---------------- 组件：网页新增 / 编辑抽屉 ---------------- */
import { reactive, ref, computed, onMounted, onUnmounted, nextTick } from '../vue-globals.js';

import { CONFIG } from '../../config.js';
import { api } from '../api.js';
import { normalizeUrl } from '../util/text.js';
import { isBuiltinKind, kindMeta, sanitizeKind, kindInputText, resolveKindInput, KIND_MAX_LEN } from '../util/site-note.js';

const SiteEditor = {
  name: 'SiteEditor',
  props: {
    initial: { type: Object, default: null },
    knownUrls: { type: Array, default: () => [] }, // 已记录过的链接，用来提示重复
    knownKinds: { type: Array, default: () => [] }, // 已用过的自定义类型（M20 任务 C）
  },
  emits: ['save', 'close'],
  setup(props, { emit }) {
    const urlInput = ref(null);

    const form = reactive({
      url: props.initial?.url || '',
      title: props.initial?.title || '',
      kind: props.initial?.kind || localStorage.getItem('danji.lastSiteKind') || 'tech',
      status: props.initial?.status || 'to_read',
      tagsText: (props.initial?.tags || []).join(', '),
      notes: props.initial?.notes || '',
    });

    // 抽屉标题 / 面包屑 / 卡片标签共用这个回显；自定义类型如实显示自己的名字
    const kind = computed(() => kindMeta(form.kind));

    // 输入框里显示的展示文本（M21 任务 B）：内置类型显示「技术 / 杂项」，
    // 自定义类型显示原名；form.kind 始终是存盘用的 id，两者分开，避免把中文 label 存进数据。
    const kindText = ref(kindInputText(form.kind));

    const fetching = ref(false);
    const titleHint = ref('');
    const duplicate = computed(() => {
      if (props.initial) return false; // 编辑自己不算重复
      const url = normalizeUrl(form.url);
      return !!url && props.knownUrls.includes(url);
    });

    /* ---- 类型下拉（combobox，可输自建类型）----
     * 与蛋编辑器的「平台」下拉同一套交互（焦点展开 / ↑↓ 选 / Enter 选中 / Esc 收起 /
     * 点外部收起），这里选项少、且允许自由输入，不做输入过滤，只做「非空提示」。 */
    const comboOpen = ref(false);
    const comboIndex = ref(-1);
    const comboRoot = ref(null);
    const kindInput = ref(null);
    let suppressFocusOpen = false;

    // 选项 = 内置类型 + 已用过的自定义类型。输入框里已填的若是自定义类型，
    // 也补进列表，避免「编辑一条老记录时列表里找不到它自己」。
    const kindOptions = computed(() => {
      const out = CONFIG.siteNote.kinds.map((k) => ({ id: k.id, label: k.label, emoji: k.emoji }));
      const seen = new Set(out.map((k) => k.id));
      const push = (label) => {
        const v = sanitizeKind(label);
        if (!v || seen.has(v)) return;
        seen.add(v);
        out.push({ id: v, label: v, emoji: kindMeta(v).emoji });
      };
      props.knownKinds.forEach(push);
      if (!isBuiltinKind(form.kind)) push(form.kind);
      return out;
    });

    function openCombo() { comboOpen.value = true; comboIndex.value = -1; }
    function closeCombo() { comboOpen.value = false; comboIndex.value = -1; }
    function toggleCombo() { comboOpen.value ? closeCombo() : openCombo(); }
    function pickKind(id) {
      form.kind = id;
      kindText.value = kindInputText(id);
      closeCombo();
      suppressFocusOpen = true;
      kindInput.value && kindInput.value.focus();
    }
    function highlightNext() {
      if (!comboOpen.value) { openCombo(); return; }
      const n = kindOptions.value.length;
      if (!n) return;
      comboIndex.value = comboIndex.value < n - 1 ? comboIndex.value + 1 : 0;
    }
    function highlightPrev() {
      if (!comboOpen.value) { openCombo(); return; }
      const n = kindOptions.value.length;
      if (!n) return;
      comboIndex.value = comboIndex.value > 0 ? comboIndex.value - 1 : n - 1;
    }
    function onComboEnter(e) {
      if (comboOpen.value && comboIndex.value >= 0) {
        const hit = kindOptions.value[comboIndex.value];
        if (hit) { e.preventDefault(); pickKind(hit.id); }
      }
    }
    function onComboFocus() {
      if (suppressFocusOpen) { suppressFocusOpen = false; return; }
      openCombo();
    }
    function onComboInput() { openCombo(); }
    function onComboEsc(e) {
      if (!comboOpen.value) return;
      e.preventDefault();
      e.stopPropagation();
      closeCombo();
    }
    function onDocMousedown(e) {
      if (!comboOpen.value) return;
      if (comboRoot.value && comboRoot.value.contains(e.target)) return;
      closeCombo();
    }
    // 输入超长时即时截断，别让用户敲到第 30 个字才发现存不进去。
    // 输入框里保留用户正在敲的原文（打「技术」不会中途被换成 tech），存盘值由 resolveKindInput 归一。
    function onKindInput(e) {
      const raw = String(e.target.value || '').slice(0, KIND_MAX_LEN);
      kindText.value = raw;
      form.kind = resolveKindInput(raw);
      e.target.value = raw;
      openCombo();
    }

    // 抓标题：只在标题还空着的时候自动填，不覆盖手写的内容；force=true 是点「自动取标题」
    async function fetchTitle(force = false) {
      const url = normalizeUrl(form.url);
      if (!url) return;
      if (!force && form.title.trim()) return;
      fetching.value = true;
      titleHint.value = '';
      try {
        const r = await api('/api/sites/title?url=' + encodeURIComponent(url)).then((x) => x.json());
        if (r.title) {
          form.title = r.title;
          titleHint.value = '已自动取到网页标题，可以自己改';
        } else {
          titleHint.value = '没取到标题（页面可能要 JS 渲染），手填一个就行';
        }
      } catch {
        titleHint.value = '没取到标题，手填一个就行';
      }
      fetching.value = false;
    }

    // 离开链接输入框时自动取一次标题（防抖 150ms，避免边打字边请求）
    let blurTimer = null;
    function onUrlBlur() {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(() => fetchTitle(false), 150);
    }

    function save() {
      const url = normalizeUrl(form.url);
      if (!url) return alert('请填写合法的链接（http / https，裸域名会自动补 https://）');
      if (!form.title.trim()) return alert('请填写标题，或点「自动取标题」');
      // 类型：内置 label（技术 / 杂项）与内置 id 都归一成内置 id 存；自定义存去空白、限长后的短词；
      // 清空则退回默认（不静默存空串）
      const finalKind = resolveKindInput(kindText.value) || 'tech';
      // 内置类型的默认选择不需要写 localStorage —— 只有自定义类型才值得记住
      if (!isBuiltinKind(finalKind)) localStorage.setItem('danji.lastSiteKind', finalKind);
      else localStorage.removeItem('danji.lastSiteKind');
      emit('save', {
        url,
        title: form.title.trim(),
        kind: finalKind,
        status: form.status,
        tags: form.tagsText.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
        notes: form.notes.trim(),
      });
    }

    const onKey = (e) => { if (e.key === 'Escape') emit('close'); };
    onMounted(async () => {
      window.addEventListener('keydown', onKey);
      document.addEventListener('mousedown', onDocMousedown);
      await nextTick();
      urlInput.value && urlInput.value.focus();
    });
    onUnmounted(() => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDocMousedown);
    });

    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      form, urlInput, fetching, titleHint, duplicate, onUrlBlur, fetchTitle, save,
      kind, kindText, kindOptions, comboOpen, comboIndex, comboRoot, kindInput,
      openCombo, closeCombo, toggleCombo, pickKind, highlightNext, highlightPrev,
      onComboEnter, onComboFocus, onComboEsc, onDocMousedown, onKindInput,
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside v-dialog class="drawer">
      <header class="drawer-head">
        <h2>{{ initial ? '✏️ 编辑网页' : '🌐 记一个待读网页' }}</h2>
        <button class="btn ghost small" @click="close" aria-label="关闭编辑窗口">✕</button>
      </header>
      <form class="drawer-form" @submit.prevent="save">
        <label>🔗 链接 *
          <input ref="urlInput" v-model="form.url" @blur="onUrlBlur"
                 placeholder="粘贴网址，或直接写 example.com">
          <span class="date-hint" v-if="duplicate">⚠️ 这个链接已经记过了，保存会出现两条</span>
        </label>
        <label>标题 *
          <input v-model="form.title" placeholder="标题；留空点下面的按钮自动取">
          <button type="button" class="mini-link" :disabled="fetching" @click="fetchTitle(true)">
            {{ fetching ? '取标题中…' : '🔄 自动取标题' }}
          </button>
          <span class="date-hint" v-if="titleHint">{{ titleHint }}</span>
        </label>

        <label class="combo-label">类型
          <div class="combo" ref="comboRoot">
            <div class="combo-control">
              <input ref="kindInput" :value="kindText"
                     placeholder="内置：技术 / 杂项；也可自己起一个"
                     autocomplete="off" maxlength="12"
                     role="combobox" :aria-expanded="comboOpen ? 'true' : 'false'"
                     @focus="onComboFocus" @input="onKindInput"
                     @keydown.down.prevent="highlightNext"
                     @keydown.up.prevent="highlightPrev"
                     @keydown.enter="onComboEnter"
                     @keydown.esc="onComboEsc">
              <button type="button" class="combo-arrow" tabindex="-1"
                      :aria-expanded="comboOpen ? 'true' : 'false'"
                      aria-label="打开类型列表"
                      @click.stop="toggleCombo">▼</button>
            </div>
            <ul class="combo-menu" v-if="comboOpen && kindOptions.length" role="listbox">
              <li v-for="(k, i) in kindOptions" :key="k.id"
                  role="option" :class="{ on: i === comboIndex }"
                  @mouseenter="comboIndex = i"
                  @mousedown.prevent="pickKind(k.id)">{{ k.emoji }} {{ k.label }}</li>
            </ul>
          </div>
          <span class="date-hint">想不出来就留「技术」。自建类型会出现在筛选栏里，读完时按「杂项」那套宽松字段引导。</span>
        </label>

        <div class="row">
          <label>状态
            <select v-model="form.status">
              <option value="to_read">📖 待读</option>
              <option value="read">✅ 已读</option>
            </select>
          </label>
        </div>
        <label>🏷️ 标签
          <input v-model="form.tagsText" placeholder="逗号分隔，如：RAG, 工具, 长文">
        </label>
        <label>📝 备注（为什么收藏它）
          <textarea v-model="form.notes" rows="2" placeholder="例：群里推荐的，说是把 KV cache 讲得最清楚的一篇"></textarea>
        </label>
        <footer class="drawer-foot">
          <button type="button" class="btn ghost" @click="close">取消</button>
          <button type="submit" class="btn primary"><app-icon name="save"></app-icon> 保存</button>
        </footer>
      </form>
    </aside>
  </div>
  `,
};

export { SiteEditor };
