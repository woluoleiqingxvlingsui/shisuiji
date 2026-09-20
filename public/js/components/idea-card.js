/* ---------------- 组件：想法卡片 ---------------- */
// 想法只有两个字段：一行点题 + 一段灵感。origin 标明这条是从哪儿来的，
// 手机记的能改，电脑记的在手机上只能看。

import { formatDate } from '../util/date.js';

const IdeaCard = {
  name: 'IdeaCard',
  props: { idea: { type: Object, required: true } },
  emits: ['edit', 'remove'],
  setup(props, { emit }) {
    const { computed } = Vue;
    const timeText = computed(() => formatDate(props.idea.updated_at || props.idea.created_at));
    return {
      timeText,
      emitEdit: () => emit('edit'),
      emitRemove: () => emit('remove'),
    };
  },
  template: `
  <article class="card idea-card">
    <div class="card-head">
      <h3 class="title">{{ idea.title || '（没写题目）' }}</h3>
      <span class="idea-origin" v-if="idea.origin === 'mobile'" title="这条是在手机上记的">📱</span>
      <span class="idea-time">{{ timeText }}</span>
    </div>
    <p class="idea-content" v-if="idea.content">{{ idea.content }}</p>
    <p class="idea-content empty-content" v-else>还没写内容</p>
    <div class="card-actions" @click.stop>
      <span class="spacer"></span>
      <button class="btn small ghost" @click="emitEdit">✏️ 编辑</button>
      <button class="btn small danger" @click="emitRemove">🗑</button>
    </div>
  </article>
  `,
};

export { IdeaCard };
