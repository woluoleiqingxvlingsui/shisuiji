/* 拾穗集 —— 顶栏同步状态胶囊（仅手机端同步层启用时渲染） */

import { computed, ref, watch } from '../vue-globals.js';
import { state } from '../state.js';
import { syncNow, resolveConflict, submitToken, openPair, saveBlockedAsNewIdea, dropOutboxEntry } from '../sync/engine.js';
import { isNativePlatform } from '../pwa.js';
import { toast } from '../toast.js';
import { switchBoard } from '../ui.js';
import { openIdeaEditor } from '../boards/ideas.js';

const SyncStatus = {
  name: 'SyncStatus',
  setup() {
    const tokenInput = ref('');
    const attentionOpen = ref(false);
    const resolving = ref(null); // 当前冲突 id，null=无弹层

    const visible = computed(() => !!(state.sync && state.sync.enabled));
    const pending = computed(() => state.sync.pendingCount || 0);
    const conflictCount = computed(() => (state.sync.conflicts || []).length);
    // 需要用户处理的条目：图片被服务端拒收 / 服务端拒写。原内容都还在本机。
    const blockedList = computed(() => (state.sync.blocked || []).slice());
    const blockedCount = computed(() => blockedList.value.length);

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
      if (s.needUpgrade) return 'App 需升级';
      if (s.status === 'need_token') return '待填口令';
      if (conflictCount.value > 0) return `${conflictCount.value} 条冲突`;
      if (blockedCount.value > 0) return `${blockedCount.value} 条待处理`;
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
      if (s.needUpgrade) parts.push('App 版本过旧，请在电脑上重装最新 APK');
      if (s.lastSyncAt) parts.push('上次同步 ' + new Date(s.lastSyncAt).toLocaleTimeString());
      if (s.lastError) parts.push(s.lastError);
      if (conflictCount.value) parts.push('有待处理冲突');
      if (blockedCount.value) parts.push('有待处理的改动，点开可以换图、另存或放弃');
      return parts.join('；') || label.value;
    });

    const pillClass = computed(() => {
      const s = state.sync;
      if (s.needPair) return 'sync-pill warn';
      if (s.needUpgrade) return 'sync-pill warn';
      if (s.status === 'need_token') return 'sync-pill warn';
      if (conflictCount.value) return 'sync-pill conflict';
      if (blockedCount.value) return 'sync-pill conflict';
      if (s.status === 'syncing') return 'sync-pill syncing';
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'sync-pill offline';
      if (s.status === 'error') return 'sync-pill warn';
      if (pending.value > 0) return 'sync-pill offline';
      return 'sync-pill synced';
    });

    async function onPillClick() {
      // 冲突最优先：有待处理冲突就直接弹二选一。
      // 否则原生壳上点胶囊永远进配对页，已配对的用户会被反复弹回「连接电脑」
      if (conflictCount.value) {
        resolving.value = state.sync.conflicts[0].id;
        return;
      }
      // 需要处理的改动（图片被拒 / 服务端拒写）：弹处理清单，不重连、不重新推
      if (blockedCount.value) {
        attentionOpen.value = !attentionOpen.value;
        return;
      }
      // 原生壳：点胶囊进配对表单（未配对引导连接 / 已配对可重配、清配对、立即同步）
      if (state.sync.needPair || isNativePlatform()) {
        openPair();
        return;
      }
      if (state.sync.status === 'need_token') return;
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

    /* ---- 需要处理的改动：图片被拒 / 服务端拒写 ---- */
    /** 打开原随记的编辑器：换图、移除问题图片都在那里做，保存后自动恢复同步 */
    function openInEditor(item) {
      const idea = (state.ideas || []).find((i) => i.id === item.id);
      if (!idea) {
        toast('找不到这条随记，可以在下面选「另存为新的随记」', 'warn');
        return;
      }
      attentionOpen.value = false;
      switchBoard('ideas');
      openIdeaEditor(idea);
    }

    /** 复制本机保留的原内容：用户可自己粘到别处 */
    async function copyOriginal(item) {
      const text = `${item.title || ''}\n${item.content || ''}`.trim();
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          toast('已复制原内容', 'ok');
          return;
        }
      } catch { /* 剪贴板不可用：回退到手动复制 */ }
      toast('复制不了，请手动选中下面的内容', 'warn');
    }

    /** 明确另存为新的手机随记（新 UUID；不会自动重建被拒的那条） */
    async function saveAsNew(item) {
      const newId = await saveBlockedAsNewIdea(item.id);
      if (!newId) {
        toast('另存失败，请稍后再试', 'warn');
        return;
      }
      attentionOpen.value = false;
      toast('已另存为新的手机随记 📝', 'ok');
      syncNow({ reason: 'blocked-saved-as-new' });
    }

    /** 明确放弃这条待发修改 */
    async function dropItem(item) {
      if (!confirm('确定放弃这条尚未同步的改动？本机保存的这次编辑将被移除。')) return;
      const ok = await dropOutboxEntry(item.id, { dropLocalImages: true, expectedOperationId: item.operation_id });
      attentionOpen.value = false;
      if (ok) toast('已放弃这条改动');
    }

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
      blockedList,
      blockedCount,
      attentionOpen,
      state,
      onPillClick,
      tokenInput,
      onTokenSubmit,
      resolving,
      conflictItem,
      sideText,
      pick,
      closeConflict: () => { resolving.value = null; },
      openInEditor,
      copyOriginal,
      saveAsNew,
      dropItem,
    };
  },
  template: `
  <template v-if="visible">
    <button type="button" class="sync-pill-btn" :class="pillClass" :title="title" @click="onPillClick" data-testid="sync-status">
      {{ label }}
    </button>

    <div class="overlay sync-token-overlay" v-if="state.sync.status === 'need_token'">
      <aside v-dialog class="drawer sync-token-drawer">
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
      <aside v-dialog class="drawer sync-conflict-drawer">
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
    <div class="overlay sync-conflict-overlay" v-if="attentionOpen && blockedList.length">
      <aside v-dialog class="drawer sync-conflict-drawer">
        <header class="drawer-head">
          <h2>🛠 需要处理的改动</h2>
          <button class="btn ghost small" @click="attentionOpen = false">✕</button>
        </header>
        <div class="drawer-form">
          <p class="sync-hint">这些改动还安全地存在手机里，不会被反复重传，也不会自动丢掉。</p>
          <div class="conflict-sides" v-for="item in blockedList" :key="item.id">
            <div class="conflict-side">
              <h3>{{ item.kind === 'image' ? '🖼 图片传不上去' : '🔒 手机端不能修改这条记录' }}</h3>
              <pre class="conflict-text">{{ item.title }}
{{ item.content }}</pre>
              <p class="sync-hint">{{ item.reason }}</p>
              <button class="btn primary" v-if="item.kind === 'image'" @click="openInEditor(item)">
                去随记里换图或移除
              </button>
              <button class="btn ghost" @click="copyOriginal(item)">复制原内容</button>
              <button class="btn ghost" v-if="item.kind !== 'image'" @click="saveAsNew(item)">另存为新的随记</button>
              <button class="btn ghost" @click="dropItem(item)">放弃这条改动</button>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </template>
  `,
};

export { SyncStatus };
