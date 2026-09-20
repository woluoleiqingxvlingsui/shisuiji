/* ---------------- 组件：论文新增 / 编辑抽屉 ---------------- */
import { reactive, ref, computed, onMounted, onUnmounted, nextTick, watch } from '../vue-globals.js';

const PaperEditor = {
  name: 'PaperEditor',
  props: { initial: { type: Object, default: null } },
  emits: ['save', 'close'],
  setup(props, { emit }) {
    const titleInput = ref(null);

    const form = reactive({
      title: props.initial?.title || '',
      file_name: props.initial?.file_name || '',
      category: props.initial?.category || '',
      reader: props.initial?.reader || '',
      status: props.initial?.status || 'to_read',
      notes: props.initial?.notes || '',
    });
    // 新建时带上上次用的阅读软件，省得重复填
    if (!props.initial) {
      const lastReader = localStorage.getItem('danji.lastReader');
      if (lastReader) form.reader = lastReader;
    }

    const inbox = ref([]);       // 论文文件夹里的待归档文件
    const categories = ref([]);  // 已有类别（待读/已读下的子目录）
    const matches = ref(null);   // 标题联想结果 { candidates, auto }
    const manualPicked = ref(!!props.initial); // 用户手动选过文件后就不再自动改

    // 阅读软件下拉：自动检测本机已装的阅读软件
    const readers = ref([]);
    const readersLoading = ref(true);
    const readerChoice = ref(form.reader || ''); // ''=系统默认；'__custom__'=手动填路径
    const customOption = computed(() => {
      const r = form.reader;
      if (!r || readers.value.some((x) => x.exe === r)) return null;
      const base = r.split(/[\\/]/).pop().replace(/\.exe$/i, '');
      return { exe: r, name: `${base}（自定义）` };
    });
    watch(readerChoice, (v) => {
      if (v !== '__custom__') form.reader = v;
    });

    async function loadMeta() {
      try {
        const [inb, cats, rs] = await Promise.all([
          fetch('/api/papers/inbox').then((r) => r.json()),
          fetch('/api/papers/categories').then((r) => r.json()),
          fetch('/api/papers/readers').then((r) => r.json()).catch(() => ({ readers: [] })),
        ]);
        inbox.value = inb;
        categories.value = cats;
        readers.value = rs.readers || [];
      } catch { /* 拉不到就先空着，保存时服务端还会兜底 */ }
      readersLoading.value = false;
    }

    // 标题输入 → 防抖匹配论文文件夹；高置信自动选中
    let matchTimer = null;
    watch(() => form.title, (val) => {
      clearTimeout(matchTimer);
      if (!val.trim()) { matches.value = null; return; }
      matchTimer = setTimeout(async () => {
        try {
          matches.value = await fetch('/api/papers/match?name=' + encodeURIComponent(val.trim())).then((r) => r.json());
          if (matches.value.auto && !manualPicked.value) {
            form.file_name = matches.value.candidates[0].name;
          }
        } catch { matches.value = null; }
      }, 300);
    });

    // 文件下拉选项：有匹配按匹配度排，否则按收件箱时间；当前已关联的文件始终在列
    const fileOptions = computed(() => {
      const list = (matches.value && matches.value.candidates.length)
        ? matches.value.candidates.map((f) => ({ ...f }))
        : inbox.value.map((f) => ({ ...f, score: 0 }));
      if (form.file_name && !list.some((f) => f.name === form.file_name)) {
        list.unshift({ name: form.file_name, score: 0, current: true });
      }
      return list;
    });

    function save() {
      if (!form.title.trim()) return alert('请填写论文标题');
      localStorage.setItem('danji.lastReader', form.reader.trim());
      emit('save', {
        title: form.title.trim(),
        file_name: form.file_name,
        category: form.category.trim(),
        status: form.status,
        reader: form.reader.trim(),
        notes: form.notes.trim(),
        link: '',
      });
    }

    const onKey = (e) => { if (e.key === 'Escape') emit('close'); };
    onMounted(async () => {
      window.addEventListener('keydown', onKey);
      loadMeta();
      await nextTick();
      titleInput.value && titleInput.value.focus();
    });
    onUnmounted(() => window.removeEventListener('keydown', onKey));

    // 只有按下和松开都发生在遮罩空白处才关闭（防止圈选文字误关）
    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      form, save, titleInput, categories, matches, fileOptions,
      readers, readersLoading, readerChoice, customOption,
      onFilePick: () => { manualPicked.value = true; },
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>{{ initial ? '✏️ 编辑论文' : '📄 记一篇论文' }}</h2>
        <button class="btn ghost small" @click="close">✕</button>
      </header>
      <form class="drawer-form" @submit.prevent="save">
        <label>标题 *
          <input ref="titleInput" v-model="form.title" placeholder="输入部分标题即可，会自动匹配论文文件夹里的文件">
        </label>
        <label>📄 论文文件
          <select v-model="form.file_name" @change="onFilePick">
            <option value="">不关联文件（仅记录）</option>
            <option v-for="f in fileOptions" :key="f.name" :value="f.name">
              {{ f.name }}{{ f.current ? '（当前）' : (f.score ? '（匹配 ' + f.score + '%）' : '') }}
            </option>
          </select>
          <span class="date-hint ok" v-if="matches && matches.auto && form.file_name">已自动匹配到论文文件夹里的文件，可在上面改选</span>
          <span class="date-hint" v-else-if="matches && !matches.candidates.length && form.title">论文文件夹里没找到相似文件，可先把 PDF 丢进论文文件夹</span>
        </label>
        <label>📚 类别
          <input v-model="form.category" list="paper-category-suggestions" placeholder="输入或选择，如：深度学习；新类别保存时自动建文件夹">
          <datalist id="paper-category-suggestions">
            <option v-for="c in categories" :key="c" :value="c"></option>
          </datalist>
        </label>
        <label>🖥️ 阅读软件
          <select v-model="readerChoice">
            <option value="">系统默认打开方式</option>
            <option v-if="customOption" :value="customOption.exe">{{ customOption.name }}</option>
            <option v-for="r in readers" :key="r.exe" :value="r.exe">{{ r.name }}</option>
            <option value="__custom__">其他（手动填路径）…</option>
          </select>
          <input v-if="readerChoice === '__custom__'" v-model="form.reader"
                 placeholder="粘贴阅读软件的 exe 完整路径，如 D:\\Soft\\SumatraPDF.exe">
          <span class="date-hint" v-if="readersLoading">正在扫描本机已装的阅读软件…</span>
          <span class="date-hint" v-else-if="!readers.length">没扫到常见阅读软件，可用系统默认或手动填路径</span>
        </label>
        <div class="row">
          <label>状态
            <select v-model="form.status">
              <option value="to_read">📖 待读</option>
              <option value="read">✅ 已读</option>
            </select>
          </label>
        </div>
        <label>📝 备注
          <textarea v-model="form.notes" rows="2" placeholder="来源、DOI、为什么读…"></textarea>
        </label>
        <footer class="drawer-foot">
          <button type="button" class="btn ghost" @click="close">取消</button>
          <button type="submit" class="btn primary">💾 保存</button>
        </footer>
      </form>
    </aside>
  </div>
  `,
};

export { PaperEditor };
