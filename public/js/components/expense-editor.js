/* ---------------- 组件：花销新增 / 编辑抽屉 ---------------- */
import { reactive, ref, computed, watch, onMounted, onUnmounted, nextTick } from '../vue-globals.js';

import { CONFIG } from '../../config.js';
import { formatDate, todayStr } from '../util/date.js';
import { guessExpenseCategory } from '../util/expense.js';
import { formatMoney, parseAmountInput } from '../util/money.js';

const ExpenseEditor = {
  name: 'ExpenseEditor',
  props: {
    initial: { type: Object, default: null },
    defaultDate: { type: String, default: '' }, // 按当前所选期间算出来的默认日期
  },
  emits: ['save', 'close'],
  setup(props, { emit }) {
    const titleInput = ref(null);

    const form = reactive({
      title: props.initial?.title || '',
      amountText: props.initial ? String(props.initial.amount) : '',
      date: props.initial?.date || props.defaultDate || todayStr(),
      notes: props.initial?.notes || '',
      category: props.initial?.category || guessExpenseCategory(props.initial?.title || ''),
    });
    // 用户手动点过类别之后就不再被标题自动改（编辑已有记录同理）
    const categoryTouched = ref(!!props.initial);
    watch(() => form.title, (t) => {
      if (categoryTouched.value) return;
      form.category = guessExpenseCategory(t);
    });
    function pickCategory(id) {
      categoryTouched.value = true;
      form.category = id;
    }

    // 新记一笔且默认日期不是今天时，说明是按所选期间填的，提示一句免得以为写错了
    const dateHint = computed(() => {
      if (props.initial || !form.date || form.date === todayStr()) return '';
      return `默认按你当前选的期间填了 ${formatDate(form.date)}，记不清具体哪天就留着`;
    });

    // 边输边预览金额解析结果，省得保存后才发现写错
    const amountPreview = computed(() => {
      const raw = form.amountText.trim();
      if (!raw) return null;
      const n = parseAmountInput(raw);
      return n === null
        ? { bad: true, text: '金额得是正数，可以写 1280、1280.5、¥1,280' }
        : { bad: false, text: `→ ${formatMoney(n)}` };
    });

    function save() {
      if (!form.title.trim()) return alert('请填写花销内容');
      const amount = parseAmountInput(form.amountText);
      if (amount === null) return alert('金额得是正数，可以写 1280、1280.5、¥1,280');
      const date = form.date.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return alert('日期写成 2026-09-10 这样');
      emit('save', { title: form.title.trim(), amount, date, notes: form.notes.trim(), category: form.category });
    }

    const onKey = (e) => { if (e.key === 'Escape') emit('close'); };
    onMounted(async () => {
      window.addEventListener('keydown', onKey);
      await nextTick();
      titleInput.value && titleInput.value.focus();
    });
    onUnmounted(() => window.removeEventListener('keydown', onKey));

    let pressOnOverlay = false;
    const onOverlayMousedown = (e) => { pressOnOverlay = e.target === e.currentTarget; };
    const onOverlayMouseup = (e) => {
      if (pressOnOverlay && e.target === e.currentTarget) emit('close');
      pressOnOverlay = false;
    };

    return {
      form, titleInput, amountPreview, dateHint, save, pickCategory,
      categories: CONFIG.expenses.categories,
      close: () => emit('close'),
      onOverlayMousedown, onOverlayMouseup,
    };
  },
  template: `
  <div class="overlay" @mousedown="onOverlayMousedown" @mouseup="onOverlayMouseup">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>{{ initial ? '✏️ 编辑花销' : '💰 记一笔花销' }}</h2>
        <button class="btn ghost small" @click="close">✕</button>
      </header>
      <form class="drawer-form" @submit.prevent="save">
        <label>花销内容 *
          <input ref="titleInput" v-model="form.title" placeholder="例：Coursera 年费 / 打印机墨盒 / 文献数据库会员">
        </label>
        <label>金额 *
          <input v-model="form.amountText" inputmode="decimal" placeholder="1280 或 1280.5 或 ¥1,280">
          <span class="date-hint" v-if="amountPreview" :class="amountPreview.bad ? 'bad' : 'ok'">{{ amountPreview.text }}</span>
        </label>

        <p class="drawer-section">类别（年视图按它归纳）</p>
        <div class="chip-picks">
          <button type="button" class="chip-pick" v-for="c in categories" :key="c.id"
                  :class="{ on: form.category === c.id }" @click="pickCategory(c.id)">
            {{ c.emoji }} {{ c.label }}
          </button>
        </div>

        <div class="row">
          <label>日期
            <input type="date" v-model="form.date">
            <span class="date-hint" v-if="dateHint">{{ dateHint }}</span>
          </label>
        </div>
        <label>📝 备注（一句简记）
          <textarea v-model="form.notes" rows="5" class="tall" placeholder="例：报了吴恩达的课，能开发票；续费前记得看看有没有学生优惠"></textarea>
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

export { ExpenseEditor };
