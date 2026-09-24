/* 拾穗集 —— 顶栏同步状态胶囊（仅手机端同步层启用时渲染） */

import { computed, ref, watch } from '../vue-globals.js';
import { state } from '../state.js';
import { syncNow, resolveConflict, submitToken, openPair } from '../sync/engine.js';
import { isNativePlatform } from '../pwa.js';

const SyncStatus = {
  name: 'SyncStatus',
  setup() {
    const tokenInput = ref('');
    const resolving = ref(null); // 当前冲突 id，null=无弹层

    const visible = computed(() => !!(state.sync && state.sync.enabled));
    const pending = computed(() => state.sync.pendingCount || 0);
    const conflictCount = computed(() => (state.sync.conflicts || []).length);

    // push 返回 conflict 时按规格自动弹出二选一，不必等用户点胶囊
    watch(conflictCount, (n, prev) => {
      if (n > 0 && n !== prev && !resolving.value) {
        const first = state.sync.conflicts[0];
        if (first) resolving.value = first.id;
      }
    });

    const label = computed(() => {
      const s = state.sync;
      if (!s.enabled) return '';
      if (s.needPair) return '未配对';
      if (s.status === 'need_token') return '待填口令';
      if (conflictCount.value > 0) return `${conflictCount.value} 条冲突`;
      if (s.status === 'syncing') return '同步中';
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return pending.value > 0 ? `离线 · ${pending.value} 条待同步` : '离线';
      }
      if (s.status === 'offline' || (pending.value > 0 && s.status !== 'synced')) {
        return pending.value > 0 ? `离线 · ${pending.value} 条待同步` : '离线';
      }
      if (s.status === 'error') return '同步异常';
      return '已同步';
    });

    const title = computed(() => {
      const s = state.sync;
      const parts = [];
      if (s.lastSyncAt) parts.push('上次同步 ' + new Date(s.lastSyncAt).toLocaleTimeString());
      if (s.lastError) parts.push(s.lastError);
      if (conflictCount.value) parts.push('有待处理冲突');
      return parts.join('；') || label.value;
    });

    const pillClass = computed(() => {
      const s = state.sync;
      if (s.needPair) return 'sync-pill warn';
      if (s.status === 'need_token') return 'sync-pill warn';
      if (conflictCount.value) return 'sync-pill conflict';
      if (s.status === 'syncing') return 'sync-pill syncing';
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'sync-pill offline';
      if (s.status === 'error') return 'sync-pill warn';
      if (pending.value > 0) return 'sync-pill offline';
      return 'sync-pill synced';
    });

    async function onPillClick() {
      // 原生壳：点胶囊进配对表单（未配对引导连接 / 已配对可重配、清配对、立即同步）
      if (state.sync.needPair || isNativePlatform()) {
        openPair();
        return;
      }
      if (state.sync.status === 'need_token') return;
      if (conflictCount.value) {
        resolving.value = state.sync.conflicts[0].id;
        return;
      }
      await syncNow({ reason: 'manual' });
    }

    function onTokenSubmit() {
      const t = submitToken(tokenInput.value);
      if (t) tokenInput.value = '';
    }

    async function pick(choice) {
      const id = resolving.value;
      if (!id) return;
      resolving.value = null;
      await resolveConflict(id, choice);
      if (state.sync.conflicts.length) resolving.value = state.sync.conflicts[0].id;
    }

    const conflictItem = computed(() =>
      (state.sync.conflicts || []).find((c) => c.id === resolving.value) || null);

    function sideText(side) {
      const c = conflictItem.value;
      if (!c) return '';
      const row = side === 'local' ? c.local : c.server;
      if (!row) return '（空）';
      const title = row.title || '（没写题目）';
      const content = row.content || '（无内容）';
      return `${title}\n${content}`;
    }

    return {
      visible,
      label,
      title,
      pillClass,
      pending,
      conflictCount,
      state,
      onPillClick,
      tokenInput,
      onTokenSubmit,
      resolving,
      conflictItem,
      sideText,
      pick,
      closeConflict: () => { resolving.value = null; },
    };
  },
  template: `
  <template v-if="visible">
    <button type="button" class="sync-pill-btn" :class="pillClass" :title="title" @click="onPillClick" data-testid="sync-status">
      {{ label }}
    </button>

    <div class="overlay sync-token-overlay" v-if="state.sync.status === 'need_token'">
      <aside class="drawer sync-token-drawer">
        <header class="drawer-head">
          <h2>🔑 填写访问口令</h2>
        </header>
        <div class="drawer-form">
          <p class="sync-hint">局域网访问拾穗集需要口令（服务端 config.json 的 sync.token）。</p>
          <label>口令
            <input v-model="tokenInput" type="password" placeholder="X-Danji-Token" @keyup.enter="onTokenSubmit">
          </label>
          <footer class="drawer-foot">
            <button type="button" class="btn primary" @click="onTokenSubmit">保存并同步</button>
          </footer>
        </div>
      </aside>
    </div>

    <div class="overlay sync-conflict-overlay" v-if="resolving && conflictItem">
      <aside class="drawer sync-conflict-drawer">
        <header class="drawer-head">
          <h2>⚠️ 想法冲突</h2>
          <button class="btn ghost small" @click="closeConflict">✕</button>
        </header>
        <div class="drawer-form">
          <p class="sync-hint">这条想法在手机和电脑上都有改动，保留哪一边？</p>
          <div class="conflict-sides">
            <div class="conflict-side">
              <h3>📱 手机端</h3>
              <pre class="conflict-text">{{ sideText('local') }}</pre>
              <button class="btn primary" @click="pick('mobile')">用手机端</button>
            </div>
            <div class="conflict-side">
              <h3>💻 电脑端</h3>
              <pre class="conflict-text">{{ sideText('server') }}</pre>
              <button class="btn ghost" @click="pick('desktop')">用电脑端</button>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </template>
  `,
};

export { SyncStatus };
