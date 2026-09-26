/* 拾穗集 —— 手机 App 配对 / 设置抽屉
 * 单通道：扫控制台配对码（配对后同 Wi-Fi 自动同步，无需重扫）。
 * 原生壳走 ML Kit 插件（全屏原生预览+解码，WebView 零负载）；
 * 浏览器兜底 html5-qrcode（仅调试用）。
 */

import { ref, computed, watch } from '../vue-globals.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { getServerBase } from '../api.js';
import {
  applyPair,
  clearPair,
  testPair,
  isPaired,
  parsePairPayload,
} from '../pair.js';
import { notifyPaired, closePair, openPair, syncNow } from '../sync/engine.js';

/** 原生 ML Kit 扫码插件（@capacitor-mlkit/barcode-scanning）；浏览器/未安装时返回 null */
function getNativeBarcodeScanner() {
  try {
    if (window.Capacitor
      && typeof window.Capacitor.isNativePlatform === 'function'
      && window.Capacitor.isNativePlatform()
      && window.Capacitor.Plugins
      && window.Capacitor.Plugins.BarcodeScanner) {
      return window.Capacitor.Plugins.BarcodeScanner;
    }
  } catch { /* ignore */ }
  return null;
}

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
    const busy = ref(false);
    const error = ref('');
    const scanning = ref(false);
    const scanMsg = ref('');
    const pairedBase = ref('');

    const open = computed(() => !!(state.sync && state.sync.pairOpen));
    const hasPair = ref(isPaired());

    let scanner = null;
    // 一次性闸门：二维码在镜头前会被连续解码多帧，回调必须同步上闸，
    // 否则每帧都跑一遍 connectWith/notifyPaired → 同步风暴 + 界面卡顿
    let scanHandled = false;
    let nativeScanning = false;
    let nativeListener = null;
    const SCAN_DOM_ID = 'pair-qr-region';

    async function stopNativeScan() {
      try { document.body.classList.remove('danji-scan-active'); } catch { /* ignore */ }
      if (nativeListener) {
        try { await nativeListener.remove(); } catch { /* ignore */ }
        nativeListener = null;
      }
      const plugin = getNativeBarcodeScanner();
      if (plugin) {
        try { await plugin.stopScan(); } catch { /* ignore */ }
      }
      nativeScanning = false;
    }

    async function stopScan() {
      scanning.value = false;
      if (nativeScanning) {
        await stopNativeScan();
        return;
      }
      // 先摘引用再释放：即使 stop() 抛错/挂起，后面的 clear 和轨道兜底也必须执行，
      // 否则旧相机流泄漏在后台，多次扫码后越用越卡
      const s = scanner;
      scanner = null;
      if (!s) return;
      try {
        if (s.isScanning && s.isScanning()) await s.stop();
      } catch { /* ignore */ }
      try { s.clear(); } catch { /* ignore */ }
      try {
        const v = document.querySelector('#' + SCAN_DOM_ID + ' video');
        if (v && v.srcObject && v.srcObject.getTracks) {
          v.srcObject.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
          v.srcObject = null;
        }
      } catch { /* ignore */ }
    }

    // 退后台立刻停相机：避免不可见时相机流+解码循环空耗，回来重按「开始扫码」即可
    function onDocVisibility() {
      if (document.visibilityState === 'hidden') stopScan();
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', onDocVisibility);
    }

    watch(open, (v) => {
      if (!v) {
        stopScan();
        return;
      }
      error.value = '';
      scanMsg.value = '';
      hasPair.value = isPaired();
      pairedBase.value = getServerBase();
    });

    async function connectWith({ base, token }) {
      if (busy.value) return false; // 防重入：多帧扫码回调 / 连点按钮只执行一次
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
        pairedBase.value = applied.base;
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

    async function onStartScan() {
      if (busy.value || scanning.value) return;
      error.value = '';
      scanHandled = false;
      const nativeScanner = getNativeBarcodeScanner();
      if (nativeScanner) {
        await startNativeScan(nativeScanner);
        return;
      }
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
            // 低分辨率流：解码帧小，WebView 主线程压力大幅下降
            videoConstraints: {
              facingMode: 'environment',
              width: { ideal: 640 },
              height: { ideal: 480 },
            },
            // 配对码不含镜像内容，关掉水平翻转扫描省一半解码量
            disableFlip: true,
            experimentalFeatures: [
              // WebView 支持原生 BarcodeDetector 时走系统解码（快），不支持自动回落 JS
              { useBarCodeDetectorIfSupported: true },
            ],
          },
          async (text) => {
            if (scanHandled || busy.value) return;
            scanHandled = true; // 同步上闸：后续帧回调全部丢弃
            await stopScan();
            const parsed = parsePairPayload(text);
            if (!parsed.ok) {
              error.value = parsed.error || '扫码内容无效';
              scanMsg.value = '';
              scanHandled = false; // 内容无效时放开，允许重新扫码
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
        error.value = ((e && e.message) || '无法启动相机') + '，请检查相机权限后重试';
        scanMsg.value = '';
        stopScan();
      }
    }

    /**
     * 原生 ML Kit 连续扫码（startScan 路径）：CameraX 预览画在 WebView 背后、
     * 解码在原生层，不依赖 Google 服务（scan() 那条 GMS 路径在国内机器上不可用）。
     * 页面加 danji-scan-active 让 WebView 透出相机画面，只留底部操作条。
     */
    async function startNativeScan(plugin) {
      scanning.value = true;
      nativeScanning = true;
      scanMsg.value = '正在请求相机权限…';
      try {
        let perm = await plugin.checkPermissions();
        if (perm.camera !== 'granted') perm = await plugin.requestPermissions();
        if (perm.camera !== 'granted') {
          error.value = '相机权限被拒绝，请在系统设置里允许后重试';
          scanMsg.value = '';
          nativeScanning = false;
          scanning.value = false;
          return;
        }
        document.body.classList.add('danji-scan-active');
        nativeListener = await plugin.addListener('barcodesScanned', async (event) => {
          if (scanHandled || busy.value) return;
          const raw = event && event.barcodes && event.barcodes[0] && event.barcodes[0].rawValue;
          if (!raw) return;
          scanHandled = true; // 同步上闸：后续帧事件全部丢弃
          await stopScan();
          const parsed = parsePairPayload(raw);
          if (!parsed.ok) {
            error.value = parsed.error || '扫码内容无效';
            scanMsg.value = '';
            scanHandled = false; // 内容无效时放开，允许重新扫码
            return;
          }
          scanMsg.value = '已识别，正在连接…';
          await connectWith({ base: parsed.base, token: parsed.token });
          scanMsg.value = '';
        });
        scanMsg.value = '对准电脑控制台上的配对码';
        await plugin.startScan({ formats: ['QR_CODE'], lensFacing: 'back' });
      } catch (e) {
        const msg = ((e && e.message) || '无法启动扫码').toString();
        scanMsg.value = '';
        if (!/cancel/i.test(msg)) error.value = msg + '，请重试';
        await stopScan();
      }
    }

    function onLater() {
      closePair();
    }

    function onClear() {
      clearPair();
      pairedBase.value = '';
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
      busy,
      error,
      hasPair,
      pairedBase,
      scanning,
      scanMsg,
      hasNativeScanner: !!getNativeBarcodeScanner(),
      SCAN_DOM_ID,
      onStartScan,
      stopScan,
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
        <p class="sync-hint" v-if="hasPair">已配对：{{ pairedBase }}。同一 Wi-Fi 下自动同步，无需重扫；电脑 IP 变了先「清除配对」再重扫。</p>
        <p class="sync-hint" v-else>同一 Wi-Fi：扫电脑控制台「🔗 配对码」窗口里的二维码。跳过也可离线记想法。<br>电脑若开了自签 HTTPS，请改用 HTTP 模式出码。</p>

        <div v-if="!hasNativeScanner" :id="SCAN_DOM_ID" style="width:100%;min-height:180px;background:#111;border-radius:10px;overflow:hidden"></div>
        <div class="scan-ui">
          <p class="sync-hint" v-if="scanMsg">{{ scanMsg }}</p>
          <button type="button" class="btn primary" :disabled="busy || scanning" @click="onStartScan">
            {{ scanning ? '扫码中…' : (hasPair ? '重新扫码配对' : '开始扫码') }}
          </button>
          <button type="button" class="btn ghost" v-if="scanning" @click="stopScan">停止扫码</button>
          <p class="pair-error" v-if="error" style="color:#ff8e8e;margin-top:8px">{{ error }}</p>
        </div>
        <footer class="drawer-foot">
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
