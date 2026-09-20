/* ---------------- 组件：消息卡片 ---------------- */

import { formatDate } from '../util/date.js';
import { platformStyle } from '../util/text.js';

const MessageCard = {
  name: 'MessageCard',
  props: { message: { type: Object, required: true } },
  emits: ['read', 'remove', 'goto'],
  setup(props, { emit }) {
    return {
      platformStyle, formatDate,
      emitRead: () => emit('read'), emitRemove: () => emit('remove'),
      emitGoto: () => emit('goto'),
    };
  },
  template: `
  <article class="card" :class="{ 'is-read': message.read }" @click="emitRead">
    <div class="card-head">
      <span class="platform" :style="platformStyle(message.platform)">{{ message.platform }}</span>
      <h3 class="title">{{ message.title }}</h3>
      <span class="msg-flag unread" v-if="!message.read">未读</span>
      <span class="msg-flag" v-else>✓ 已读</span>
    </div>
    <div class="meta">
      <span class="chip">💬 {{ message.body }}</span>
      <span class="chip">{{ formatDate(message.created_at) }}</span>
    </div>
    <div class="card-actions" @click.stop>
      <button class="btn small ghost" @click="emitGoto">→ 查看原蛋</button>
      <span class="spacer"></span>
      <button class="btn small danger" @click="emitRemove">🗑</button>
    </div>
  </article>
  `,
};

export { MessageCard };
