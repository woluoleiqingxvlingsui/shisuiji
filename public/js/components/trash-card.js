/* ---------------- 组件：回收站卡片（M20 任务 D）----------------
 * 一条被删掉的记录：来源板块徽标 + 标题 + 删除时间 + 还剩几天。
 * 只有两个动作：恢复、彻底删除（不可反悔，调用方必须先二次确认）。
 */

import { computed } from '../vue-globals.js';
import { formatDate } from '../util/date.js';
import { TRASH_SOURCE_META, trashDaysLeft, trashTitle, trashSummary } from '../util/trash.js';

const TrashCard = {
  name: 'TrashCard',
  props: { entry: { type: Object, required: true }, now: { type: Number, default: () => Date.now() } },
  emits: ['restore', 'purge'],
  setup(props, { emit }) {
    const sourceMeta = computed(() => TRASH_SOURCE_META[props.entry.source] || { label: props.entry.source || '未知', emoji: '🗑' });
    const daysLeft = computed(() => trashDaysLeft(props.entry, props.now));
    return {
      sourceMeta, daysLeft, formatDate,
      title: computed(() => trashTitle(props.entry)),
      summary: computed(() => trashSummary(props.entry)),
      emitRestore: () => emit('restore'),
      emitPurge: () => emit('purge'),
    };
  },
  template: `
  <article class="card trash-card">
    <div class="card-head">
      <span class="platform">{{ sourceMeta.emoji }} {{ sourceMeta.label }}</span>
      <h3 class="title">{{ title }}</h3>
    </div>
    <div class="meta">
      <span class="chip" v-if="summary">{{ summary }}</span>
      <span class="chip">🗑 {{ formatDate(entry.deleted_at) }} 删除</span>
      <span class="chip" :class="{ warn: daysLeft <= 7 }">
        {{ daysLeft > 0 ? '剩 ' + daysLeft + ' 天' : '今天到期' }}
      </span>
    </div>
    <div class="card-actions">
      <button class="btn small" @click="emitRestore">↩︎ 恢复</button>
      <span class="spacer"></span>
      <button class="btn small danger" @click="emitPurge" title="彻底删除，无法恢复" aria-label="彻底删除">
        <app-icon name="trash"></app-icon>
      </button>
    </div>
  </article>
  `,
};

export { TrashCard };