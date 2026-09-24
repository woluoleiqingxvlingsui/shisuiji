/* 拾穗集 —— 手机 App 配对抽屉（手输电脑地址 + 口令） */

import { ref, computed, watch } from '../vue-globals.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { getServerBase, getToken } from '../api.js';
import { normalizePairBase, applyPair, clearPair, testPair, isPaired } from '../pair.js';
import { notifyPaired, closePair, openPair, syncNow } from '../sync/engine.js';

const PairDrawer = {
  name: 'PairDrawer',
  setup() {
    const baseInput = ref('');
    const tokenInput = ref('');
    const busy = ref(false);
    const error = ref('');

    const open = computed(() => !!(state.sync && state.sync.pairOpen));
    // localStorage 不是响应式，用 ref 在保存/清除时刷新
    const hasPair = ref(isPaired());

    // 打开时回填已保存的地址/口令，便于重配
    watch(open, (v) => {
      if (!v) return;
      baseInput.value = getServerBase();
      tokenInput.value = getToken();
      error.value = '';
      hasPair.value = isPaired();
    });

    async function onSubmit() {
      if (busy.value) return;
      error.value = '';
      const base = normalizePairBase(baseInput.value);
      if (!base) {
        error.value = '地址不合法，应如 http://192.168.1.5:8642';
        return;
      }
      busy.value = true;
      try {
        const result = await testPair(base, tokenInput.value.trim());
        if (!result.ok) {
          error.value = (result.data && result.data.error) || `连不上（HTTP ${result.status || 0}）`;
          return;
        }
        const applied = applyPair({ base, token: tokenInput.value.trim() });
        if (!applied.ok) {
          error.value = applied.error || '保存失败';
          return;
        }
        hasPair.value = true;
        toast('配对成功，开始同步', 'ok');
        notifyPaired();
        // 通知根应用补拉各板块
        try {
          window.dispatchEvent(new CustomEvent('danji:paired'));
        } catch { /* ignore */ }
      } finally {
        busy.value = false;
      }
    }

    function onLater() {
      closePair();
    }

    function onClear() {
      clearPair();
      baseInput.value = '';
      tokenInput.value = '';
      hasPair.value = false;
      state.sync.needPair = true;
      toast('已清除配对', 'warn');
    }

    function onReopen() {
      openPair();
    }

    async function onSyncNow() {
      await syncNow({ reason: 'manual' });
    }

    return {
      open,
      state,
      baseInput,
      tokenInput,
      busy,
      error,
      hasPair,
      onSubmit,
      onLater,
      onClear,
      onReopen,
      onSyncNow,
    };
  },
  template: `
  <div class="overlay pair-overlay" v-if="open">
    <aside class="drawer pair-drawer">
      <header class="drawer-head">
        <h2>🔗 连接电脑上的拾穗集</h2>
      </header>
      <div class="drawer-form">
        <p class="sync-hint">同一 Wi-Fi 下填写电脑服务地址和口令；以后换 IP 可在同步胶囊里重配。现在跳过也能离线记想法。</p>
        <label>电脑地址
          <input v-model="baseInput" type="url" inputmode="url" autocomplete="url"
                 placeholder="http://192.168.1.5:8642" @keyup.enter="onSubmit">
        </label>
        <label>访问口令
          <input v-model="tokenInput" type="password" autocomplete="off"
                 placeholder="local.env.ps1 里的 DANJI_TOKEN（没配可留空）" @keyup.enter="onSubmit">
        </label>
        <p class="pair-error" v-if="error">{{ error }}</p>
        <footer class="drawer-foot">
          <button type="button" class="btn primary" :disabled="busy" @click="onSubmit">
            {{ busy ? '测试中…' : '测试并保存' }}
          </button>
          <button type="button" class="btn ghost" :disabled="busy" @click="onSyncNow" v-if="hasPair">立即同步</button>
          <button type="button" class="btn ghost" :disabled="busy" @click="onLater">稍后离线使用</button>
          <button type="button" class="btn ghost small" v-if="hasPair" :disabled="busy" @click="onClear">清除配对</button>
        </footer>
      </div>
    </aside>
  </div>
  `,
};

export { PairDrawer, openPair };
