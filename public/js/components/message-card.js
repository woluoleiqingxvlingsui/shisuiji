/* ---------------- 组件：消息卡片 ---------------- */

import { computed } from '../vue-globals.js';
import { canMarkMessages } from '../perm.js';
import { formatDate } from '../util/date.js';
import { platformStyle } from '../util/text.js';

const MessageCard = {
  name: 'MessageCard',
  props: { message: { type: Object, required: true } },
  emits: ['read', 'remove', 'goto'],
  setup(props, { emit }) {
    // 本地消息（断连告警等）只存本机，手机端也能已读 / 删除，不受「消息只读」限制
    const markable = computed(() => canMarkMessages() || !!props.message.local);
    return {
      markable, platformStyle, formatDate,
      emitRead: () => { if (markable.value) emit('read'); },
      emitRemove: () => emit('remove'),
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
      <span class="chip" v-if="message.local">📱 本机</span>
      <span class="chip">{{ formatDate(message.created_at) }}</span>
    </div>
    <div class="card-actions" @click.stop v-if="markable">
      <button class="btn small ghost" v-if="message.activity_id" @click="emitGoto">→ 查看原蛋</button>
      <span class="spacer" v-if="message.activity_id"></span>
      <button class="btn small danger" @click="emitRemove">🗑</button>
    </div>
  </article>
  `,
};

export { MessageCard };
