/* ---------------- 组件：花销卡片 ---------------- */
import { computed } from '../vue-globals.js';

import { canWrite } from '../perm.js';
import { formatDate } from '../util/date.js';
import { expenseCategoryMeta } from '../util/expense.js';
import { formatMoney } from '../util/money.js';

const ExpenseCard = {
  name: 'ExpenseCard',
  props: { expense: { type: Object, required: true } },
  emits: ['edit', 'remove'],
  setup(props, { emit }) {
    const amountText = computed(() => formatMoney(props.expense.amount));
    const category = computed(() => expenseCategoryMeta(props.expense.category));
    const writable = computed(() => canWrite('expenses'));
    return {
      amountText, category, writable, formatDate,
      emitEdit: () => emit('edit'),
      emitRemove: () => emit('remove'),
    };
  },
  template: `
  <article class="card expense-card">
    <div class="card-head">
      <span class="expense-date">🗓 {{ formatDate(expense.date) }}</span>
      <span class="cat-chip" :style="{ '--h': category.hue }">{{ category.emoji }} {{ category.label }}</span>
      <h3 class="title">{{ expense.title }}</h3>
      <span class="expense-amount">{{ amountText }}</span>
    </div>
    <p class="expense-notes" v-if="expense.notes">{{ expense.notes }}</p>
    <div class="card-actions" @click.stop v-if="writable">
      <span class="spacer"></span>
      <button class="btn small ghost" @click="emitEdit">✏️ 编辑</button>
      <button class="btn small danger" @click="emitRemove">🗑</button>
    </div>
  </article>
  `,
};

export { ExpenseCard };
