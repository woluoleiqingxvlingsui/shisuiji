/* ---------------- 组件：知识库合并层 ----------------
 * 笔记又改了、但知识库条目被手动调整过：不静默覆盖，
 * 把「笔记版 / 当前知识库版」摆出来由用户定稿。
 */
import { computed } from '../vue-globals.js';

import { state } from '../state.js';

const KbMerge = {
  name: 'KbMerge',
  emits: ['resolve'],
  setup(props, { emit }) {
    const merge = computed(() => state.kbMerge);
    const visible = computed(() => !!merge.value);
    const noteText = computed(() => {
      const m = merge.value;
      if (!m) return '';
      return `${m.incoming.title}\n${m.incoming.content}`;
    });
    const kbText = computed(() => {
      const m = merge.value;
      if (!m) return '';
      return `${m.entry.title}\n${m.entry.content}`;
    });
    return {
      visible, merge, noteText, kbText,
      pick: (choice) => emit('resolve', choice),
    };
  },
  template: `
  <div class="overlay sync-conflict-overlay" v-if="visible">
    <aside class="drawer sync-conflict-drawer">
      <header class="drawer-head">
        <h2>📚 知识库合并</h2>
        <button class="btn ghost small" @click="pick('manual')">✕</button>
      </header>
      <div class="drawer-form">
        <p class="sync-hint">这条笔记又更新了，但知识库条目被你手动调整过——以哪边为准？</p>
        <div class="conflict-sides">
          <div class="conflict-side">
            <h3>📄 笔记最新版</h3>
            <pre class="conflict-text">{{ noteText }}</pre>
            <button class="btn primary" @click="pick('note')">用笔记版</button>
          </div>
          <div class="conflict-side">
            <h3>📚 知识库当前版</h3>
            <pre class="conflict-text">{{ kbText }}</pre>
            <button class="btn ghost" @click="pick('manual')">保留手动版</button>
          </div>
        </div>
        <footer class="drawer-foot">
          <button type="button" class="btn ghost" @click="pick('edit')">✍️ 我自己合并</button>
        </footer>
      </div>
    </aside>
  </div>
  `,
};

export { KbMerge };
