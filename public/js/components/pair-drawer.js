/* 拾穗集 —— 手机 App 配对 / 设置抽屉
 * 三通道：手输地址口令 / 粘贴配对 JSON / 扫码；另可导出未同步 outbox。
 */

import { ref, computed, watch } from '../vue-globals.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { getServerBase, getToken } from '../api.js';
import {
  normalizePairBase,
  applyPair,
  clearPair,
  testPair,
  isPaired,
  parsePairPayload,
} from '../pair.js';
import { notifyPaired, closePair, openPair, syncNow } from '../sync/engine.js';
import { listOutbox } from '../sync/outbox.js';

function loadHtml5Qrcode() {
  if (typeof window !== 'undefined' && window.Html5Qrcode) {
    return Promise.resolve(window.Html5Qrcode);
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/html5-qrcode.min.js';
    s.onload = () => resolve(window.Html5Qrcode);
    s.onerror = () => reject(new Error('扫码组件加载失败'));
    document.head.appendChild(s);
  });
}

const PairDrawer = {
  name: 'PairDrawer',
  setup() {
    const mode = ref('manual'); // manual | paste | scan
    const baseInput = ref('');
    const tokenInput = ref('');
    const pasteInput = ref('');
    const busy = ref(false);
    const error = ref('');
    const scanning = ref(false);
    const scanMsg = ref('');

    const open = computed(() => !!(state.sync && state.sync.pairOpen));
    const hasPair = ref(isPaired());

    let scanner = null;
    const SCAN_DOM_ID = 'pair-qr-region';

    async function stopScan() {
      scanning.value = false;
      if (!scanner) return;
      try {
        if (scanner.isScanning && scanner.isScanning()) await scanner.stop();
        scanner.clear();
      } catch { /* ignore */ }
      scanner = null;
    }

    watch(open, (v) => {
      if (!v) {
        stopScan();
        return;
      }
      baseInput.value = getServerBase();
      tokenInput.value = getToken();
      error.value = '';
      scanMsg.value = '';
      hasPair.value = isPaired();
    });

    watch(mode, (m) => {
      if (m !== 'scan') stopScan();
    });

    async function connectWith({ base, token }) {
      busy.value = true;
      error.value = '';
      try {
        const result = await testPair(base, token);
        if (!result.ok) {
          error.value = (result.data && result.data.error) || `连不上（HTTP ${result.status || 0}）`;
          return false;
        }
        const applied = applyPair({ base, token });
        if (!applied.ok) {
          error.value = applied.error || '保存失败';
          return false;
        }
        baseInput.value = applied.base;
        tokenInput.value = token || '';
        hasPair.value = true;
        toast('配对成功，开始同步', 'ok');
        notifyPaired();
        try {
          window.dispatchEvent(new CustomEvent('danji:paired'));
        } catch { /* ignore */ }
        return true;
      } finally {
        busy.value = false;
      }
    }

    async function onSubmit() {
      if (busy.value) return;
      const base = normalizePairBase(baseInput.value);
      if (!base) {
        error.value = '地址不合法，应如 http://192.168.1.5:8642';
        return;
      }
      await connectWith({ base, token: tokenInput.value.trim() });
    }

    async function onPasteSubmit() {
      if (busy.value) return;
      const parsed = parsePairPayload(pasteInput.value);
      if (!parsed.ok) {
        error.value = parsed.error || '解析失败';
        return;
      }
      const ok = await connectWith({ base: parsed.base, token: parsed.token });
      if (ok) pasteInput.value = '';
    }

    async function onStartScan() {
      if (busy.value || scanning.value) return;
      error.value = '';
      scanMsg.value = '正在启动相机…';
      try {
        const Html5Qrcode = await loadHtml5Qrcode();
        scanner = new Html5Qrcode(SCAN_DOM_ID);
        scanning.value = true;
        await scanner.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            qrbox: { width: 220, height: 220 },
          },
          async (text) => {
            if (busy.value) return;
            await stopScan();
            const parsed = parsePairPayload(text);
            if (!parsed.ok) {
              error.value = parsed.error || '扫码内容无效';
              scanMsg.value = '';
              return;
            }
            scanMsg.value = '已识别，正在连接…';
            await connectWith({ base: parsed.base, token: parsed.token });
            scanMsg.value = '';
          },
          () => { /* 每帧忽略 */ },
        );
        scanMsg.value = '对准电脑控制台上的配对码';
      } catch (e) {
        scanning.value = false;
        const msg = (e && e.message) || '无法启动相机';
        error.value = msg + '，请改用「粘贴码」';
        scanMsg.value = '';
        try { if (scanner) { scanner.clear(); scanner = null; } } catch { /* ignore */ }
      }
    }

    async function onExportOutbox() {
      try {
        const ops = await listOutbox();
        if (!ops || !ops.length) {
          toast('没有待同步的记录', 'warn');
          return;
        }
        const blob = new Blob(
          [JSON.stringify({ v: 1, kind: 'danji-outbox', exported_at: new Date().toISOString(), ops }, null, 2)],
          { type: 'application/json' },
        );
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `danji-outbox-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        toast(`已导出 ${ops.length} 条待同步`, 'ok');
      } catch (e) {
        toast('导出失败：' + ((e && e.message) || e), 'warn');
      }
    }

    function onLater() {
      closePair();
    }

    function onClear() {
      clearPair();
      baseInput.value = '';
      tokenInput.value = '';
      pasteInput.value = '';
      hasPair.value = false;
      state.sync.needPair = true;
      toast('已清除配对', 'warn');
    }

    async function onSyncNow() {
      await syncNow({ reason: 'manual' });
    }

    return {
      open,
      state,
      mode,
      baseInput,
      tokenInput,
      pasteInput,
      busy,
      error,
      hasPair,
      scanning,
      scanMsg,
      SCAN_DOM_ID,
      onSubmit,
      onPasteSubmit,
      onStartScan,
      stopScan,
      onExportOutbox,
      onLater,
      onClear,
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
        <p class="sync-hint">同一 Wi-Fi：扫控制台「配对码」，或粘贴配对 JSON / 手填地址。跳过也可离线记想法。<br>出于安全，HTTP 明文只接受局域网私网地址；电脑若开了自签 HTTPS，请改用 HTTP 模式出码配对。</p>
        <div class="tabs" style="margin-bottom:10px">
          <button type="button" class="tab" :class="{ active: mode === 'manual' }" @click="mode = 'manual'">手输</button>
          <button type="button" class="tab" :class="{ active: mode === 'paste' }" @click="mode = 'paste'">粘贴码</button>
          <button type="button" class="tab" :class="{ active: mode === 'scan' }" @click="mode = 'scan'">扫码</button>
        </div>

        <template v-if="mode === 'manual'">
          <label>电脑地址
            <input v-model="baseInput" type="url" inputmode="url" autocomplete="url"
                   placeholder="http://192.168.1.5:8642" @keyup.enter="onSubmit">
          </label>
          <label>访问口令
            <input v-model="tokenInput" type="password" autocomplete="off"
                   placeholder="local.env.ps1 里的 DANJI_TOKEN（没配可留空）" @keyup.enter="onSubmit">
          </label>
        </template>

        <template v-else-if="mode === 'paste'">
          <label>配对 JSON
            <textarea v-model="pasteInput" rows="5"
                      placeholder='{"v":1,"base":"http://192.168.1.5:8642","token":"..."}'></textarea>
          </label>
          <button type="button" class="btn primary" :disabled="busy" @click="onPasteSubmit">
            {{ busy ? '连接中…' : '解析并连接' }}
          </button>
        </template>

        <template v-else>
          <div :id="SCAN_DOM_ID" style="width:100%;min-height:180px;background:#111;border-radius:10px;overflow:hidden"></div>
          <p class="sync-hint" v-if="scanMsg">{{ scanMsg }}</p>
          <button type="button" class="btn primary" :disabled="busy || scanning" @click="onStartScan">开始扫码</button>
          <button type="button" class="btn ghost" v-if="scanning" @click="stopScan">停止</button>
        </template>

        <p class="pair-error" v-if="error" style="color:#ff8e8e;margin-top:8px">{{ error }}</p>
        <footer class="drawer-foot">
          <button type="button" class="btn primary" :disabled="busy" v-if="mode === 'manual'" @click="onSubmit">
            {{ busy ? '测试中…' : '测试并保存' }}
          </button>
          <button type="button" class="btn ghost" :disabled="busy" @click="onSyncNow" v-if="hasPair">立即同步</button>
          <button type="button" class="btn ghost" :disabled="busy" @click="onExportOutbox">导出未同步</button>
          <button type="button" class="btn ghost" :disabled="busy" @click="onLater">稍后离线使用</button>
          <button type="button" class="btn ghost small" v-if="hasPair" :disabled="busy" @click="onClear">清除配对</button>
        </footer>
      </div>
    </aside>
  </div>
  `,
};

export { PairDrawer, openPair };
