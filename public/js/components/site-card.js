/* ---------------- 组件：网页卡片 ---------------- */

import { formatDate } from '../util/date.js';
import { kindMeta, siteNoteSummary, usageMeta } from '../util/site-note.js';
import { normalizeUrl, platformStyle } from '../util/text.js';

const SiteCard = {
  name: 'SiteCard',
  props: { site: { type: Object, required: true }, flash: Boolean },
  emits: ['open', 'status', 'edit', 'remove', 'note', 'read'],
  setup(props, { emit }) {
    const { computed } = Vue;
    const isRead = computed(() => props.site.status === 'read');
    const kind = computed(() => kindMeta(props.site.kind));
    const url = computed(() => normalizeUrl(props.site.url));
    const catStyle = computed(() => platformStyle(props.site.domain || props.site.title));
    // 最近一次点「🌐 打开」的时间（列表就是按它排的）
    const lastReadText = computed(() => (props.site.last_read_at ? formatDate(props.site.last_read_at) : ''));

    // 笔记：按读完日期倒序，卡片上只露最新一条的摘要
    const logs = computed(() => [...(props.site.logs || [])]
      .sort((a, b) => String(b.read_at || '').localeCompare(String(a.read_at || ''))));
    const logCount = computed(() => logs.value.length);
    const latestLog = computed(() => logs.value[0] || null);
    const logSummary = computed(() => siteNoteSummary(latestLog.value));
    const usage = computed(() => (latestLog.value ? usageMeta(latestLog.value.usage) : null));

    return {
      isRead, kind, url, catStyle, lastReadText, logs, logCount, latestLog, logSummary, usage,
      emitOpen: () => emit('open'),
      emitStatus: (s) => emit('status', s),
      emitEdit: () => emit('edit'),
      emitRemove: () => emit('remove'),
      emitNote: () => emit('note', logCount.value ? 'list' : 'new'),
      emitRead: () => emit('read'),
    };
  },
  template: `
  <article class="card paper-card" :class="{ 'is-read': isRead, flash }">
    <div class="card-head">
      <span class="platform" :style="catStyle">{{ site.domain || '未填域名' }}</span>
      <h3 class="title">{{ site.title }}</h3>
      <span class="kind-badge" :class="'k-' + site.kind">{{ kind.emoji }} {{ kind.label }}</span>
      <span class="status-badge" :class="isRead ? 'st-read' : 'st-to_read'">{{ isRead ? '✅ 已读' : '📖 待读' }}</span>
    </div>
    <div class="site-url" v-if="site.url">🔗 <a :href="url" target="_blank" rel="noopener" @click.stop>{{ site.url }}</a></div>
    <div class="read-stamp" v-if="lastReadText" title="最近一次点「打开」的时间，列表按它排序">🕘 最近阅读 {{ lastReadText }}</div>
    <div class="meta" v-if="(site.tags || []).length">
      <span class="chip tag" v-for="tag in site.tags" :key="tag">#{{ tag }}</span>
    </div>
    <p class="paper-notes" v-if="site.notes" :title="site.notes">📝 {{ site.notes }}</p>

    <!-- 笔记：读完才有，卡片上只露最新一条的摘要 -->
    <div class="paper-log" v-if="isRead && logCount" @click.stop="emitNote" title="点开看全部笔记">
      <span class="usage-badge" :class="'usage-' + latestLog.usage" v-if="usage">{{ usage.emoji }} {{ usage.label }}</span>
      <span class="paper-log-line" v-if="logSummary">{{ logSummary }}</span>
      <span class="paper-log-line muted" v-else>（最新一条还没写内容）</span>
      <span class="log-count" v-if="logCount > 1">共 {{ logCount }} 条</span>
    </div>
    <div class="paper-log log-hint" v-else-if="isRead" @click.stop="emitNote" title="点这里补一条笔记">
      📝 还没记笔记，点这里补一条
    </div>

    <div class="card-actions" @click.stop>
      <button class="btn small primary" v-if="site.url" @click="emitOpen">🌐 打开</button>
      <button class="btn small ghost" v-if="!isRead" @click="emitRead">✅ 读完了</button>
      <button class="btn small ghost" v-else @click="emitStatus('to_read')">↩️ 移回待读</button>
      <button class="btn small ghost" v-if="isRead" @click="emitNote">{{ logCount ? '📝 笔记 ' + logCount : '📝 记一条' }}</button>
      <span class="spacer"></span>
      <button class="btn small ghost" @click="emitEdit">✏️ 编辑</button>
      <button class="btn small danger" @click="emitRemove">🗑</button>
    </div>
  </article>
  `,
};

export { SiteCard };
