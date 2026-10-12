package app.shisuiji.danji;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Log;
import android.webkit.WebView;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import com.getcapacitor.Bridge;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 后台同步保活服务(M17 改版):保活 + 【原生 SSE 推送 + 原生补齐回报】+ 兜底踢一脚 JS。
 *
 * M14~M16 的教训:同步逻辑全在 WebView JS 里,而后台 WebView 的定时器与 SSE 全部停摆
 * (2026-10-06 实测:服务端 18:45 广播的 sync 帧手机毫无反应,只有 15 分钟闹钟踢的那一脚
 * 能跑)。M17 把「等推送 + 拉数据 + 回报电脑」搬进本服务的原生线程:
 *  - 原生 SSE(HttpURLConnection 流式读 /api/events)在前台服务里不受 WebView 冻结影响,
 *    电脑端一广播 sync 就能秒级触发同步轮;
 *  - 同步轮(syncCycle):GET /api/sync/pull 全量 → 比对 data_version/boot_id →
 *    需要补齐就 POST /api/messages 回报(caught_up=1, background=1);
 *  - 页面在前台时(MainActivity.onResume/onPause 维护 pageVisible)原生不跑同步轮,
 *    前台归 JS(前台补齐);后台归原生(后台补齐),归属权绝不重叠;
 *  - JS 每轮同步成功会 noteSynced 告知版本,防止把手机自己的推送误报成「补齐」;
 *  - 5 分钟精确闹钟保留为兜底(Doze 断流后至少周期性补同步),每次 tick 同时跑原生
 *    同步轮 + 踢一脚 JS(踢 JS 是为了让 outbox 里的离线随记有机会推出去)。
 *
 * 网络一律在 worker 线程(HandlerThread)执行,onStartCommand(主线程)只负责投递,
 * 否则 NetworkOnMainThreadException。
 *
 * 已知边界(诚实告知,不假装解决):
 *  - 原生拉到的数据不写 WebView 的 IndexedDB 镜像;镜像由用户下次打开 App 时 JS 刷新;
 *  - 深度 Doze(熄屏静置 30 分钟以上)下 SSE 断流、闹钟最密 9 分钟一次,延迟退化到
 *    ~9~15 分钟;正常后台(屏幕刚熄/在充电/手机在动)是秒级;
 *  - 进程被 ROM 杀掉后,闹钟 PendingIntent 会把本服务拉起来(没有 WebView 也能原生同步),
 *    但 ROM 强杀(清理全部+取消闹钟)就无能为力。
 *
 * 常驻通知的折叠行(subText)是**诊断窗口**:
 *  - 「推送已连接 HH:MM」 = 原生 SSE 活着(秒级通道就绪);
 *  - 「上次同步 HH:MM ✅」 = 原生同步轮真的拉取+回报成功过;
 *  - 「上次踢同步 HH:MM,已执行 HH:MM ✅/❌」 = 闹钟踢 JS 的结果(outbox 兜底通道)。
 */
public class SyncForegroundService extends Service {

    public static final String TAG = "DanjiSync";
    public static final String ACTION_START = "app.shisuiji.danji.sync.START";
    public static final String ACTION_TICK = "app.shisuiji.danji.sync.TICK";
    public static final String EXTRA_INTERVAL_MS = "intervalMs";
    public static final String EXTRA_TOKEN = "token";
    public static final String EXTRA_BASE_URL = "baseUrl";

    /** M17:兜底闹钟从 15 分钟压到 5 分钟(主通道是原生 SSE,这里只是 Doze 保险) */
    public static final long DEFAULT_INTERVAL_MS = 5 * 60 * 1000L;
    public static final long MIN_INTERVAL_MS = 60 * 1000L;
    public static final long MAX_INTERVAL_MS = 60 * 60 * 1000L;

    /** JS 侧 start() 传来的口令与服务地址、原生同步的版本账本都存这里;
     *  BackgroundSyncPlugin 直接用同名文件,保持一致 */
    static final String PREFS = "danji_sync";

    private static final String CHANNEL_ID = "danji-sync";
    private static final int NOTIF_ID = 0x5151;
    private static final int TICK_REQUEST_CODE = 1;

    /** M19:SSE 读超时(半开连接加固)。服务端心跳 25 秒一次,连续 3 个心跳没到即判死线:
     *  NAT/代理把长连接悄悄卡成「半开」时不发 FIN/RST,原来 3 分钟的读超时让最长哑火窗口
     *  拖到 3 分钟(期间广播收不到,原生也不会重连);压到 75 秒后同样断法下最多哑火 75 秒。 */
    private static final long SSE_READ_TIMEOUT_MS = 75 * 1000L;
    private static final long[] RECONNECT_DELAYS_MS = {5000, 15000, 30000, 60000};
    private static final long RECONNECT_STEADY_MS = 60 * 1000L;

    /** 供插件 isRunning() 读 */
    static volatile boolean running = false;
    /** 页面是否在前台(MainActivity.onResume/onPause 维护)。true=前台(JS 负责同步与回报) */
    static volatile boolean pageVisible = false;
    /** 由 BackgroundSyncPlugin.load() 注入;进程被杀后闹钟重建服务时为 null */
    static WeakReference<Bridge> bridgeRef = null;
    /** 同进程直连,让插件的 reportResult 不必绕 Intent */
    static WeakReference<SyncForegroundService> selfRef = null;

    private long intervalMs = DEFAULT_INTERVAL_MS;
    /** 精确闹钟是否可用:onStartCommand 里算一次,scheduleNext 与通知文案共用 */
    private boolean exactAlarm = true;
    /** 最近一次闹钟踢同步的时刻(HH:mm)。reportResult 刷「已执行」时要带上它 */
    private String lastTickHm = "";

    private HandlerThread workerThread;
    private Handler worker;
    private final AtomicBoolean sseThreadStarted = new AtomicBoolean(false);
    private volatile boolean sseRunning = false;
    private volatile HttpURLConnection sseConnection = null;
    /** 同步轮节流:2 秒内的重复触发(闹钟+广播同时到)直接跳过 */
    private volatile long lastCycleAt = 0;

    @Override
    public void onCreate() {
        super.onCreate();
        selfRef = new WeakReference<>(this);
        workerThread = new HandlerThread("danji-bg-sync");
        workerThread.start();
        worker = new Handler(workerThread.getLooper());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;
        exactAlarm = exactAlarmAvailable();

        if (intent != null) {
            if (intent.hasExtra(EXTRA_INTERVAL_MS)) {
                intervalMs = clampInterval(intent.getLongExtra(EXTRA_INTERVAL_MS, DEFAULT_INTERVAL_MS));
            }
            // JS 每次 start 都把口令与服务地址带过来,落进 SharedPreferences——
            // 闹钟把进程拉起来时(没有 WebView)也能凭它做原生同步
            String token = intent.getStringExtra(EXTRA_TOKEN);
            String baseUrl = intent.getStringExtra(EXTRA_BASE_URL);
            if (token != null || baseUrl != null) {
                SharedPreferences.Editor e = prefs().edit();
                if (token != null) e.putString("token", token);
                if (baseUrl != null) e.putString("baseUrl", baseUrl);
                e.apply();
            }
        }

        // 无论哪个 action,先满足 startForegroundService 的 5 秒契约
        if (!startAsForeground()) {
            return START_NOT_STICKY;
        }

        startSseThreadIfNeeded();

        if (ACTION_TICK.equals(action)) {
            lastTickHm = hhmm();
            refreshNotification(getString(R.string.bg_sync_notif_tick, lastTickHm));
            Log.d(TAG, "tick, native cycle + kicking js");
            worker.post(this::syncCycle);
            WebView wv = currentWebView();
            if (wv != null) kickJs("bg-tick", wv);
        } else {
            Log.d(TAG, "start, intervalMs=" + intervalMs);
            worker.post(this::syncCycle);
            WebView wv = currentWebView();
            if (wv != null) kickJs("bg-start", wv);
        }

        scheduleNext(intervalMs);
        // 不做系统级重建:重建入口有两个——打开 App(JS auto-start)与闹钟把进程拉回来
        return START_NOT_STICKY;
    }

    /** evaluateJavascript 必须在 UI 线程;直接注入执行不是定时器,不受 Chromium 后台节流影响 */
    private void kickJs(String reason, WebView wv) {
        final String js = "window.__danjiBackgroundSync && window.__danjiBackgroundSync('" + reason + "')";
        wv.post(() -> {
            try {
                wv.evaluateJavascript(js, null);
            } catch (Throwable t) {
                Log.w(TAG, "kick failed", t);
            }
        });
    }

    /**
     * JS 每次踢完回报本轮结论(✅=同步成功,❌=真失败)。刷新「已执行」诊断行。
     */
    void reportResult(boolean ok) {
        Log.d(TAG, "reportResult ok=" + ok + " keepAliveMs=" + intervalMs);
        if (!running) return;
        String tick = lastTickHm.isEmpty() ? "--:--" : lastTickHm;
        String verdict = ok ? "✅" : "❌";
        refreshNotification(getString(R.string.bg_sync_notif_tick_done, tick, hhmm(), verdict));
    }

    // ---------- 原生同步轮(M17 核心) ----------

    /**
     * 拉全量 → 版本比对 → 需要补齐就回报电脑端。只在 worker 线程跑(有网络)。
     * 页面可见时直接返回:前台归 JS(它同步完会 noteSynced 把版本记账过来)。
     * 版本比对语义与 JS 侧 net.js 的 isCaughtUp 完全一致:
     *  - 从没同步过(lastVersion<=0)→ 只记账不回报;
     *  - 服务端换过进程(boot_id 对不上)→ 只重新对齐,不回报;
     *  - 版本号涨了 → 回报「后台补齐」,回报成功才落版本(失败下轮重报)。
     */
    private void syncCycle() {
        long now = SystemClock.elapsedRealtime();
        if (now - lastCycleAt < 2000) return;   // 2 秒内的重复触发直接跳过
        lastCycleAt = now;

        if (pageVisible) {
            Log.d(TAG, "syncCycle skipped: page visible (JS owns foreground sync)");
            return;
        }
        SharedPreferences sp = prefs();
        String base = sp.getString("baseUrl", "");
        String token = sp.getString("token", "");
        if (base == null || base.isEmpty()) {
            Log.d(TAG, "syncCycle skipped: no baseUrl (未配对或 JS 还没传过参数)");
            return;
        }
        String cycleId = UUID.randomUUID().toString();
        String stage = "pull";
        Log.i(TAG, "cycle=" + cycleId + " source=native stage=start");
        try {
            HttpResult pull = http(base + "/api/sync/pull", "GET", token, null);
            if (pull.status != 200) {
                Log.w(TAG, "syncCycle pull HTTP " + pull.status);
                return;
            }
            JSONObject data = new JSONObject(pull.body);
            long v = data.optLong("data_version", -1);
            String boot = data.optString("boot_id", "");
            if (v <= 0 || boot.isEmpty() || data.optJSONArray("ideas") == null) {
                Log.w(TAG, "cycle=" + cycleId + " stage=pull invalid snapshot metadata");
                return;
            }

            // M18:数据到手先落快照(无论后面是否回报)——App 离线打开时灌进镜像全靠它
            stage = "snapshot-save";
            if (!saveSnapshot(pull.body)) {
                Log.w(TAG, "cycle=" + cycleId + " stage=snapshot-save failed; success report withheld");
                return;
            }
            Log.i(TAG, "cycle=" + cycleId + " stage=snapshot-saved boot=" + boot + " version=" + v);

            long lastV = sp.getLong("lastVersion", 0);
            String lastBoot = sp.getString("lastBoot", "");
            boolean bootChanged = !lastBoot.isEmpty() && !boot.isEmpty() && !lastBoot.equals(boot);
            boolean never = lastV <= 0;
            if (never || bootChanged) {
                sp.edit().putLong("lastVersion", v).putString("lastBoot", boot).apply();
                Log.d(TAG, "syncCycle realign: never=" + never + " bootChanged=" + bootChanged + " v=" + v);
                return;
            }
            if (v <= lastV) return;   // 没有新东西

            // 有电脑端的新改动:数据已经拉到本机进程,回报「后台补齐」
            JSONObject report = new JSONObject();
            report.put("kind", "bg-sync");
            report.put("sync_ok", "1");
            report.put("sync_attempts", "0");
            report.put("sync_reason", "");
            report.put("sync_pushed", "0");
            report.put("sync_caught_up", "1");
            report.put("sync_background", pageVisible ? "0" : "1");
            report.put("sync_rid", "catchup:" + boot + ":" + v);
            report.put("sync_source", "native");
            report.put("sync_cycle", cycleId);
            report.put("sync_stage", "snapshot-saved");
            report.put("sync_boot_id", boot);
            report.put("sync_data_version", String.valueOf(v));
            report.put("sync_observed_at", new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(new Date()));
            stage = "report";
            HttpResult ack = http(base + "/api/messages", "POST", token, report.toString());
            if (ack.status >= 200 && ack.status < 300) {
                sp.edit().putLong("lastVersion", v).putString("lastBoot", boot).apply();
                refreshNotification(getString(R.string.bg_sync_notif_synced, hhmm()));
                Log.i(TAG, "cycle=" + cycleId + " stage=reported native catch-up reported v=" + v);
            } else {
                // 回报失败就不落版本:下轮重新拉取+重报,宁可多报一次也不丢通知
                Log.w(TAG, "report POST HTTP " + ack.status + " — 版本不落盘,下轮重报");
            }
        } catch (Exception e) {
            Log.w(TAG, "cycle=" + cycleId + " stage=" + stage + " syncCycle failed", e);
        }
    }

    // ---------- M18:离线快照(原生拉到的全量数据落盘,App 离线启动时由 JS 灌进镜像) ----------

    /** 快照文件名。BackgroundSyncPlugin.readSnapshot 读同一个文件,两处必须一致 */
    static final String SNAPSHOT_FILE = "bg_snapshot.json";

    /**
     * 把 /api/sync/pull 的完整响应体原子落盘(先写 .tmp 再 rename)。
     * 每次 pull 成功都写:快照永远是「原生最后一次拉到的全量数据」。
     * 写失败保留旧快照，阻止成功回报和版本推进。
     */
    private boolean saveSnapshot(String body) {
        try {
            SnapshotStore.save(new File(getFilesDir(), SNAPSHOT_FILE), body);
            Log.i(TAG, "snapshot saved: chars=" + body.length());
            return true;
        } catch (Exception e) {
            Log.w(TAG, "saveSnapshot failed", e);
            return false;
        }
    }

    // ---------- 原生 SSE 推送通道(M17 核心) ----------

    private void startSseThreadIfNeeded() {
        if (!sseThreadStarted.compareAndSet(false, true)) return;
        sseRunning = true;
        Thread t = new Thread(this::sseLoop, "danji-sse");
        t.start();
    }

    /**
     * 原生推送监听:电脑端一广播 sync,这里立刻收到并投递同步轮。
     * 前台服务的进程不受 WebView 冻结影响——这条连接就是后台同步的「秒级」通道。
     * 读超时 3 分钟 = 心跳看门狗:服务端每 25 秒发心跳,正常永远打不到;
     * 打到了就是断流(NAT 掐线/网络切换/深 Doze),直接按退避表重连。
     */
    private void sseLoop() {
        int reconnects = 0;
        while (sseRunning) {
            SharedPreferences sp = prefs();
            String base = sp.getString("baseUrl", "");
            String token = sp.getString("token", "");
            if (base == null || base.isEmpty()) {
                sleepQuiet(30_000);   // 还没拿到配对参数(JS 首次 start 才写入),等一会儿再看
                continue;
            }
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(base + "/api/events").openConnection();
                sseConnection = conn;
                conn.setConnectTimeout(10_000);
                conn.setReadTimeout((int) SSE_READ_TIMEOUT_MS);
                conn.setRequestProperty("Accept", "text/event-stream");
                conn.setRequestProperty("Cache-Control", "no-store");
                if (token != null && !token.isEmpty()) conn.setRequestProperty("X-Danji-Token", token);
                int status = conn.getResponseCode();
                if (status != 200) throw new java.io.IOException("SSE HTTP " + status);
                reconnects = 0;
                refreshNotification(getString(R.string.bg_sync_notif_sse, hhmm()));
                Log.i(TAG, "sse connected");
                worker.post(this::syncCycle);   // 刚连上先对一次账(hello 里可能挂着没广播完的窗口)
                BufferedReader reader = new BufferedReader(
                        new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
                String line;
                String eventName = null;
                while (sseRunning && (line = reader.readLine()) != null) {
                    if (line.isEmpty()) { eventName = null; continue; }   // 帧结束
                    if (line.startsWith(":")) continue;                    // 心跳注释行
                    if (line.startsWith("event:")) {
                        eventName = line.substring("event:".length()).trim();
                    } else if (line.startsWith("data:")) {
                        String data = line.substring("data:".length()).trim();
                        if ("sync".equals(eventName) || "changed".equals(eventName)) {
                            worker.post(this::syncCycle);
                        } else if ("hello".equals(eventName)) {
                            try {
                                JSONObject h = new JSONObject(data);
                                if (h.optLong("pendingSince", 0) > 0) worker.post(this::syncCycle);
                            } catch (Exception ignore) {
                                // hello 解析失败不影响连接
                            }
                        }
                        // report 帧是发给电脑端的,手机不用理;retry: 行忽略
                    }
                }
                throw new java.io.IOException("SSE stream ended");
            } catch (Exception e) {
                if (!sseRunning) break;   // 服务已停,别刷日志
                Log.w(TAG, "sse dropped: " + e);
            } finally {
                sseConnection = null;
                if (conn != null) conn.disconnect();
            }
            long delay = reconnects < RECONNECT_DELAYS_MS.length
                    ? RECONNECT_DELAYS_MS[reconnects] : RECONNECT_STEADY_MS;
            reconnects += 1;
            Log.d(TAG, "sse reconnect in " + delay + "ms");
            sleepQuiet(delay);
        }
        Log.i(TAG, "sse loop exit");
    }

    private static void sleepQuiet(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // ---------- 极简 HTTP(零依赖) ----------

    private static class HttpResult {
        final int status;
        final String body;

        HttpResult(int s, String b) {
            status = s;
            body = b;
        }
    }

    private static HttpResult http(String url, String method, String token, String jsonBody) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setConnectTimeout(10_000);
            conn.setReadTimeout(30_000);
            conn.setRequestMethod(method);
            conn.setRequestProperty("Accept", "application/json");
            if (token != null && !token.isEmpty()) conn.setRequestProperty("X-Danji-Token", token);
            if (jsonBody != null) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] bytes = jsonBody.getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(bytes.length);
                OutputStream os = conn.getOutputStream();
                try {
                    os.write(bytes);
                } finally {
                    os.close();
                }
            }
            int status = conn.getResponseCode();
            InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            return new HttpResult(status, readAll(is));
        } finally {
            conn.disconnect();
        }
    }

    private static String readAll(InputStream is) throws Exception {
        if (is == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
        is.close();
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    // ---------- 保活/通知/闹钟(沿用 M15/M16 的骨架) ----------

    private static long clampInterval(long v) {
        return Math.max(MIN_INTERVAL_MS, Math.min(v, MAX_INTERVAL_MS));
    }

    private boolean exactAlarmAvailable() {
        AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (am == null) return false;
        if (Build.VERSION.SDK_INT < 31) return true;
        return am.canScheduleExactAlarms();
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** @return true 表示成功进入前台;false 表示已被拒绝并正在退场 */
    private boolean startAsForeground() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.bg_sync_channel_name),
                    NotificationManager.IMPORTANCE_LOW // 无声、不弹窗
                );
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        }

        int minutes = (int) Math.max(1L, intervalMs / 60000L);
        String sub = getString(R.string.bg_sync_notif_subtext, minutes);
        if (!exactAlarm) {
            sub = sub + getString(R.string.bg_sync_notif_no_exact_suffix);
        }
        Notification notif = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.bg_sync_notif_title))
            .setContentText(getString(R.string.bg_sync_notif_text))
            .setSubText(sub)
            .setSmallIcon(R.drawable.ic_stat_sync)
            .setContentIntent(contentIntent())
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();

        try {
            ServiceCompat.startForeground(
                this,
                NOTIF_ID,
                notif,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            );
            running = true;
            return true;
        } catch (Exception e) {
            Log.w(TAG, "startForeground rejected", e);
            running = false;
            shutDown();
            return false;
        }
    }

    /** 重发同 ID 通知即可原地更新常驻栏内容;渠道 IMPORTANCE_LOW,无声音不弹窗 */
    private void refreshNotification(String subText) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        Notification notif = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.bg_sync_notif_title))
            .setContentText(getString(R.string.bg_sync_notif_text))
            .setSubText(subText)
            .setSmallIcon(R.drawable.ic_stat_sync)
            .setContentIntent(contentIntent())
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
        try {
            nm.notify(NOTIF_ID, notif);
        } catch (Exception e) {
            Log.w(TAG, "refresh notification failed", e);
        }
    }

    /** 点通知回到 App(与 startAsForeground 里用的是同一个 intent,抽出来共用) */
    private PendingIntent contentIntent() {
        return PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    /** 设备本地时间的 HH:mm(给人看的诊断时间戳,不涉及存储与比对) */
    private static String hhmm() {
        return new SimpleDateFormat("HH:mm", Locale.CHINA).format(new Date());
    }

    private WebView currentWebView() {
        Bridge bridge = bridgeRef != null ? bridgeRef.get() : null;
        if (bridge == null) {
            return null;
        }
        try {
            return bridge.getWebView();
        } catch (Throwable t) {
            return null;
        }
    }

    private void scheduleNext(long delayMs) {
        AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            return;
        }
        long triggerAt = SystemClock.elapsedRealtime() + delayMs;
        if (exactAlarm) {
            // 精确闹钟:Doze 深休眠也保证在设定时刻唤醒(同应用最密 9 分钟一次,5 分钟无压力)
            am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, tickPendingIntent());
        } else {
            // 非精确:系统可无限期推迟。折叠行此时会带「精确闹钟未授权」后缀
            am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, tickPendingIntent());
        }
    }

    private PendingIntent tickPendingIntent() {
        Intent i = new Intent(this, SyncForegroundService.class).setAction(ACTION_TICK);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        if (Build.VERSION.SDK_INT >= 26) {
            return PendingIntent.getForegroundService(this, TICK_REQUEST_CODE, i, flags);
        }
        return PendingIntent.getService(this, TICK_REQUEST_CODE, i, flags);
    }

    private void cancelAlarm() {
        AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (am != null) {
            am.cancel(tickPendingIntent());
        }
    }

    private void shutDown() {
        cancelAlarm();
        stopSelf();
    }

    /** specialUse 理论上不触发系统超时,但国产 ROM 魔改行为不可预测,一行代码买保险 */
    @Override
    public void onTimeout(int startId, int fgsType) {
        Log.w(TAG, "onTimeout fgsType=" + fgsType + ", stopping");
        shutDown();
    }

    @Override
    public void onDestroy() {
        running = false;
        sseRunning = false;
        HttpURLConnection c = sseConnection;
        if (c != null) {
            try { c.disconnect(); } catch (Throwable ignore) { /* 退出不值得抛 */ }
        }
        if (workerThread != null) workerThread.quitSafely();
        cancelAlarm();
        SyncForegroundService self = selfRef != null ? selfRef.get() : null;
        if (self == this) {
            selfRef = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
