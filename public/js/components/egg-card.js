/* ---------------- 组件：蛋卡片 ---------------- */
import { computed, ref } from '../vue-globals.js';

import { state } from '../state.js';
import { canWrite } from '../perm.js';
import { computeUrgency, formatDate, formatRemaining } from '../util/date.js';
import { statusMeta, typeMeta } from '../util/meta.js';
import { normalizeUrl, platformStyle } from '../util/text.js';

const EggCard = {
  name: 'EggCard',
  props: { activity: { type: Object, required: true }, now: { type: Number, required: true }, flash: Boolean },
  emits: ['edit', 'remove', 'status'],
  setup(props, { emit }) {
    const expanded = ref(false);
    const writable = computed(() => canWrite('eggs'));

    const urgency = computed(() => computeUrgency(props.activity, props.now));
    const status = computed(() => statusMeta(props.activity.status));
    const type = computed(() => typeMeta(props.activity.type));
    const isOverdue = computed(() => props.activity.status === 'pending' && urgency.value.level === 'over');

    const deadlineText = computed(() => {
      if (!props.activity.claim_deadline) return '';
      if (props.activity.claim_deadline === '待定') return '⏰ 领取截止待确认 ❓';
      const base = `⏰ 领取截止 ${formatDate(props.activity.claim_deadline)}`;
      if (props.activity.status === 'pending' && urgency.value.remainingMs !== null) {
        return `${base} · ${formatRemaining(urgency.value.remainingMs)}`;
      }
      return base;
    });
    const validText = computed(() => {
      if (!props.activity.valid_until) return '';
      if (props.activity.valid_until === '待定') return '⏳ 使用截止待确认 ❓';
      return `⏳ 使用截止 ${formatDate(props.activity.valid_until)}`;
    });

    // 有链接就有直达按钮：待领取去领，已领取去查用量，其余状态只是打开链接
    // 手机只读：仍可打开外链，但不出现会改库的状态按钮
    const linkUrl = computed(() => normalizeUrl(props.activity.link));
    const linkLabel = computed(() => {
      if (!writable.value) return '↗ 打开活动页';
      return ({
        pending: '🚀 去领取',
        claimed: '🔍 查用量',
      }[props.activity.status] || '↗ 打开链接');
    });

    function openLink() {
      if (linkUrl.value) window.open(linkUrl.value, '_blank', 'noopener');
    }

    return {
      expanded, urgency, status, type, isOverdue, deadlineText, validText, writable,
      linkUrl, linkLabel, openLink, platformStyle, formatDate,
      emitEdit: () => emit('edit'), emitRemove: () => emit('remove'),
      emitStatus: (s) => emit('status', s),
    };
  },
  template: `
  <article class="card" :class="['lv-' + (urgency.level || 'none'), 'st-' + activity.status, { flash, expanded }]"
           @click="expanded = !expanded">
    <div class="card-head">
      <span class="platform" :style="platformStyle(activity.platform)">{{ activity.platform }}</span>
      <h3 class="title">{{ activity.title }}</h3>
      <span class="status-badge" :class="'st-' + activity.status">{{ status.emoji }} {{ status.label }}</span>
    </div>

    <div class="meta">
      <span class="chip value-chip" v-if="activity.value">{{ type.icon }} {{ activity.value }}</span>
      <span class="chip">{{ type.label }}</span>
      <span class="chip tag" v-for="tag in activity.tags" :key="tag">#{{ tag }}</span>
    </div>

    <div class="deadline-lines">
      <div class="deadline" :class="'lv-' + (urgency.level || 'none')" v-if="deadlineText">
        {{ deadlineText }}
        <span class="overdue-warn" v-if="isOverdue">⚠️ 可能已截止，点下方按钮确认</span>
      </div>
      <div class="deadline" v-if="validText" :class="{ soon: activity.status === 'claimed' && urgency.level && urgency.level !== 'unknown' }">{{ validText }}</div>
    </div>

    <div class="expand-body" v-if="expanded">
      <p v-if="activity.claim_steps"><b>🧭 领取方法：</b><span class="pre-wrap">{{ activity.claim_steps || '—' }}</span></p>
      <p v-if="activity.notes"><b>📝 备注：</b><span class="pre-wrap">{{ activity.notes }}</span></p>
      <p v-if="linkUrl"><b>🔗 链接：</b><a :href="linkUrl" target="_blank" rel="noopener" @click.stop>{{ activity.link }}</a></p>
      <p v-if="!activity.claim_steps && !activity.notes && !linkUrl" class="muted">没有更多细节</p>
    </div>

    <div class="card-actions" @click.stop>
      <button class="btn small primary" v-if="activity.link" @click="openLink">{{ linkLabel }}</button>
      <template v-if="writable && isOverdue">
        <button class="btn small ghost" @click="emitStatus('claimed')">✅ 其实领到了</button>
        <button class="btn small ghost" @click="emitStatus('closed')">⏳ 已截止</button>
      </template>
      <template v-else-if="writable && activity.status === 'closed'">
        <button class="btn small ghost" @click="emitStatus('claimed')">✅ 其实领到了</button>
      </template>
      <template v-else-if="writable && activity.status === 'expired'">
        <button class="btn small ghost" @click="emitStatus('claimed')">↩️ 还能用</button>
      </template>
      <template v-else-if="writable">
        <button class="btn small" :class="activity.link ? 'ghost' : 'primary'"
                v-if="activity.status === 'pending'" @click="emitStatus('claimed')">🧺 已领取</button>
        <button class="btn small ghost" v-if="activity.status === 'pending'" @click="emitStatus('closed')">⏳ 已截止</button>
        <button class="btn small ghost" v-if="activity.status === 'claimed'" @click="emitStatus('used')">🏁 用完了</button>
        <button class="btn small ghost" v-if="activity.status === 'claimed'" @click="emitStatus('expired')">💤 标为过期</button>
      </template>
      <span class="spacer" v-if="writable"></span>
      <button class="btn small ghost" v-if="writable" @click="emitEdit">✏️ 编辑</button>
      <button class="btn small danger" v-if="writable" @click="emitRemove">🗑</button>
    </div>
  </article>
  `,
};

export { EggCard };
