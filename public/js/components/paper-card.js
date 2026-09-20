/* ---------------- 组件：论文卡片 ---------------- */
import { computed } from '../vue-globals.js';

import { formatDate } from '../util/date.js';
import { noteRelMeta, noteSummary } from '../util/paper-note.js';
import { platformStyle } from '../util/text.js';

const PaperCard = {
  name: 'PaperCard',
  props: { paper: { type: Object, required: true }, flash: Boolean },
  emits: ['open', 'reveal', 'status', 'edit', 'remove', 'log', 'read'],
  setup(props, { emit }) {
    const isRead = computed(() => props.paper.status === 'read');
    const catStyle = computed(() => platformStyle(props.paper.category || '未分类'));
    const fileMissing = computed(() => !!props.paper.file_name && props.paper.file_exists === false);
    // 最近一次点「📖 阅读」的时间（列表就是按它排的，写在卡片上让人看得懂顺序）
    const lastReadText = computed(() => (props.paper.last_read_at ? formatDate(props.paper.last_read_at) : ''));

    // 阅读记录：按读完日期倒序，卡片上只露最新一条的摘要
    const logs = computed(() => [...(props.paper.logs || [])]
      .sort((a, b) => String(b.read_at || '').localeCompare(String(a.read_at || ''))));
    const logCount = computed(() => logs.value.length);
    const latestLog = computed(() => logs.value[0] || null);
    const logSummary = computed(() => noteSummary(latestLog.value));
    const relMeta = computed(() => (latestLog.value ? noteRelMeta(latestLog.value.rel) : null));

    return {
      isRead, catStyle, fileMissing, lastReadText, logs, logCount, latestLog, logSummary, relMeta,
      emitOpen: () => emit('open'),
      emitReveal: () => emit('reveal'),
      emitStatus: (s) => emit('status', s),
      emitEdit: () => emit('edit'),
      emitRemove: () => emit('remove'),
      emitLog: () => emit('log', logCount.value ? 'list' : 'new'),
      emitRead: () => emit('read'),
    };
  },
  template: `
  <article class="card paper-card" :class="{ 'is-read': isRead, flash }">
    <div class="card-head">
      <span class="platform" :style="catStyle">{{ paper.category || '未分类' }}</span>
      <h3 class="title">{{ paper.title }}</h3>
      <span class="status-badge" :class="isRead ? 'st-read' : 'st-to_read'">{{ isRead ? '✅ 已读' : '📖 待读' }}</span>
    </div>
    <div class="paper-file" v-if="paper.file_name" :title="paper.file_name">
      📎 {{ paper.file_name }}<span class="file-missing" v-if="fileMissing">⚠️ 文件不在预期位置</span>
    </div>
    <div class="paper-file" v-else>未关联文件（仅记录）</div>
    <div class="read-stamp" v-if="lastReadText" title="最近一次点「阅读」的时间，列表按它排序">🕘 最近阅读 {{ lastReadText }}</div>
    <p class="paper-notes" v-if="paper.notes" :title="paper.notes">📝 {{ paper.notes }}</p>

    <!-- 阅读记录：读完才有，卡片上只露最新一条的摘要 -->
    <div class="paper-log" v-if="isRead && logCount" @click.stop="emitLog" title="点开看全部阅读记录">
      <span class="rel-badge" :class="'rel-' + latestLog.rel" v-if="relMeta">{{ relMeta.emoji }} {{ relMeta.label }}</span>
      <span class="paper-log-line" v-if="logSummary">{{ logSummary }}</span>
      <span class="paper-log-line muted" v-else>（最新一条还没写内容）</span>
      <span class="log-count" v-if="logCount > 1">共 {{ logCount }} 条</span>
    </div>
    <div class="paper-log log-hint" v-else-if="isRead" @click.stop="emitLog" title="点这里补一条阅读记录">
      📝 还没记阅读记录，点这里补一条
    </div>

    <div class="card-actions" @click.stop>
      <button class="btn small primary" v-if="paper.file_name && !fileMissing" @click="emitOpen">📖 阅读</button>
      <button class="btn small ghost" v-if="paper.file_name && !fileMissing" @click="emitReveal">📁 所在位置</button>
      <button class="btn small ghost" v-if="!isRead" @click="emitRead">✅ 读完了</button>
      <button class="btn small ghost" v-else @click="emitStatus('to_read')">↩️ 移回待读</button>
      <button class="btn small ghost" v-if="isRead" @click="emitLog">{{ logCount ? '📝 记录 ' + logCount : '📝 记一条' }}</button>
      <span class="spacer"></span>
      <button class="btn small ghost" @click="emitEdit">✏️ 编辑</button>
      <button class="btn small danger" @click="emitRemove">🗑</button>
    </div>
  </article>
  `,
};

export { PaperCard };
