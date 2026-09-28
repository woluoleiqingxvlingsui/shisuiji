/* ---------------- 组件：成果卡片（时间线单项） ---------------- */
// 类别徽章 + 状态 + 时间 + 内容/亮点/标签/链接。桌面端可编辑删除，手机端只读。
import { computed } from '../vue-globals.js';

import { CONFIG } from '../../config.js';
import { canWrite } from '../perm.js';
import { normalizeUrl } from '../util/text.js';

function categoryMeta(id) {
  return CONFIG.achievements.categories.find((c) => c.id === id)
    || { id: 'other', label: '其他', emoji: '✨', hue: 320 };
}

function statusMeta(id) {
  return CONFIG.achievements.statuses.find((s) => s.id === id)
    || { id: 'done', label: '已完成', emoji: '✅' };
}

// 时间是用户自由写的：严格形态（2026 / 2026-06 / 2026-06-15）人性化一下，
// 其余（"2026-08 开始，9 月下旬开源"）原样展示
function humanDate(d) {
  const s = String(d || '').trim();
  const parts = s.split('-').map(Number);
  if (parts.length >= 1 && parts.every((n) => Number.isFinite(n)) && /^\d{4}(-\d{1,2}(-\d{1,2})?)?$/.test(s)) {
    if (parts.length === 1) return `${parts[0]} 年`;
    if (parts.length === 2) return `${parts[0]} 年 ${parts[1]} 月`;
    return `${parts[0]} 年 ${parts[1]} 月 ${parts[2]} 日`;
  }
  return s;
}

const AchievementCard = {
  name: 'AchievementCard',
  props: { achievement: { type: Object, required: true } },
  emits: ['edit', 'remove'],
  setup(props, { emit }) {
    const cat = computed(() => categoryMeta(props.achievement.category));
    const st = computed(() => statusMeta(props.achievement.status));
    const catStyle = computed(() => ({ '--h': cat.value.hue }));
    const dateText = computed(() => humanDate(props.achievement.date));
    const safeLinks = computed(() => (props.achievement.links || [])
      .map((l) => ({ raw: l, url: normalizeUrl(l) }))
      .filter((l) => l.url));
    const writable = computed(() => canWrite('achievements'));
    return {
      cat, st, catStyle, dateText, safeLinks, writable,
      emitEdit: () => emit('edit'),
      emitRemove: () => emit('remove'),
    };
  },
  template: `
  <article class="card achievement-card">
    <div class="card-head">
      <span class="cat-chip" :style="catStyle">{{ cat.emoji }} {{ cat.label }}</span>
      <h3 class="title">{{ achievement.title || '（没写标题）' }}</h3>
      <span class="ach-status" :class="'st-' + st.id">{{ st.emoji }} {{ st.label }}</span>
      <span class="ach-date" v-if="dateText">🗓 {{ dateText }}</span>
    </div>
    <p class="ach-content" v-if="achievement.content">{{ achievement.content }}</p>
    <p class="ach-highlight" v-if="achievement.highlight" title="亮点摘要：可直接抄进简历">
      <span class="ach-highlight-mark">📌 简历</span>{{ achievement.highlight }}
    </p>
    <div class="ach-meta" v-if="(achievement.tags && achievement.tags.length) || safeLinks.length">
      <span class="ach-tag" v-for="t in achievement.tags" :key="t">#{{ t }}</span>
      <a class="ach-link" v-for="l in safeLinks" :key="l.raw" :href="l.url"
         target="_blank" rel="noopener noreferrer">🔗 {{ l.raw }}</a>
    </div>
    <div class="card-actions" @click.stop v-if="writable">
      <span class="spacer"></span>
      <button class="btn small ghost" @click="emitEdit">✏️ 编辑</button>
      <button class="btn small danger" @click="emitRemove">🗑</button>
    </div>
  </article>
  `,
};

export { AchievementCard };
