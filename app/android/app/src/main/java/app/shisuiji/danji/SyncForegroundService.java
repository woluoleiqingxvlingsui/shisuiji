package app.shisuiji.danji;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Log;
import android.webkit.WebView;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import com.getcapacitor.Bridge;

import java.lang.ref.WeakReference;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 后台同步保活服务:只负责「保活 + 兜底踢一脚」,同步逻辑一行都不在原生实现。
 *
 * 主通道是 JS 层的 SSE 推送(/api/events):电脑端一改数据,服务端在「最后一次改动
 * 完成后 5 分钟」推一条 sync,手机端随即同步——同步周期由改动决定,不由本服务决定。
 * 本服务的价值:App 退后台后进程进 cached 状态会被 Android 12+ 的 Cached App Freezer
 * 挂起所有线程,SSE 流和 WebView 里的定时器随之死掉。持有活跃前台服务能让进程不进
 * cached,SSE 监听得以存活;本服务的固定 15 分钟闹钟再兜一层底(Doze 断流后至少
 * 还能周期性补同步),间隔固定不退避——节奏可预期,通知文案不会突然变 30/60 分钟。
 *
 * 成败判定与重试全在 JS(push.js 状态机):失败等 5 分钟重试、连续两次失败才用
 * 「消息 + 通知」告知用户。本服务只把 reportResult 打进日志。
 *
 * 定时用 AlarmManager 链式一次性闹钟而非 Handler.postDelayed:后者基于 uptimeMillis,
 * CPU 深度睡眠期间不走表,熄屏半小时可能只"过了"两分钟。
 *
 * 类型选 specialUse 而非 dataSync:targetSdk 35 下 Android 15 给 dataSync 设了 6 小时/24 小时
 * 硬超时,到点必须 stopSelf 否则崩,与"常驻保活"语义冲突。specialUse 无此限制,代价只有
 * 上架 Google Play 需填用途声明——本 App 自签名侧载,永不上架。
 *
 * M14 新增:常驻通知的折叠行(subText)是**闹钟链路诊断窗口**——
 *  - 每次闹钟触发 → 折叠行刷成「上次踢同步 HH:MM」
 *  - JS 踢完回报(reportResult)→ 刷成「上次踢同步 HH:MM,已执行 HH:MM ✅/❌」
 * 用户在通知栏看一眼即可分辨:时间不推进=闹钟没响;只踢没执行=JS 被冻结;
 * 出现「已执行 ✅」= 闹钟→JS→同步整条链路通。
 */
public class SyncForegroundService extends Service {

    public static final String TAG = "DanjiSync";
    public static final String ACTION_START = "app.shisuiji.danji.sync.START";
    public static final String ACTION_TICK = "app.shisuiji.danji.sync.TICK";
    public static final String EXTRA_INTERVAL_MS = "intervalMs";

    public static final long DEFAULT_INTERVAL_MS = 15 * 60 * 1000L;
    public static final long MIN_INTERVAL_MS = 60 * 1000L;
    /** 兜底保活周期的上限;同步成败不再影响它(重试在 JS 状态机里) */
    public static final long MAX_INTERVAL_MS = 60 * 60 * 1000L;

    private static final String CHANNEL_ID = "danji-sync";
    private static final int NOTIF_ID = 0x5151;
    private static final int TICK_REQUEST_CODE = 1;

    /** 供插件 isRunning() 读 */
    static volatile boolean running = false;
    /** 由 BackgroundSyncPlugin.load() 注入;进程被杀后闹钟重建服务时为 null */
    static WeakReference<Bridge> bridgeRef = null;
    /** 同进程直连,让插件的 reportResult 不必绕 Intent */
    static WeakReference<SyncForegroundService> selfRef = null;

    private long intervalMs = DEFAULT_INTERVAL_MS;
    /** 最近一次闹钟踢同步的时刻(HH:mm)。reportResult 刷「已执行」时要带上它,
     *  两个时刻一对比就能看出 JS 是准时执行的还是被冻结后补执行的 */
    private String lastTickHm = "";

    @Override
    public void onCreate() {
        super.onCreate();
        selfRef = new WeakReference<>(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;

        // 先解析间隔:通知文案要用它,调试时压短周期才不至于显示成 15 分钟
        if (intent != null && intent.hasExtra(EXTRA_INTERVAL_MS)) {
            intervalMs = clampInterval(intent.getLongExtra(EXTRA_INTERVAL_MS, DEFAULT_INTERVAL_MS));
        }

        // 无论哪个 action,先满足 startForegroundService 的 5 秒契约
        if (!startAsForeground()) {
            return START_NOT_STICKY;
        }

        if (ACTION_TICK.equals(action)) {
            WebView wv = currentWebView();
            if (wv == null) {
                // 进程被杀后闹钟把光杆服务拉起来了:没有 WebView 就无从同步。
                // 不复活僵尸、不弹 Activity,安静退场;下次用户打开 App 由 JS 自动重启。
                Log.i(TAG, "tick without webview, shutting down");
                shutDown();
                return START_NOT_STICKY;
            }
            lastTickHm = hhmm();
            refreshNotification(getString(R.string.bg_sync_notif_tick, lastTickHm));
            Log.d(TAG, "tick, kicking js");
            kickJs("bg-tick", wv);
        } else {
            Log.d(TAG, "start, intervalMs=" + intervalMs);
            WebView wv = currentWebView();
            if (wv != null) {
                kickJs("bg-start", wv);
            }
        }

        scheduleNext(intervalMs);
        // 不做系统级重建:服务的生命周期 == App 进程的生命周期,重建统一走「打开 App → JS auto-start」
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
     * JS 每次踢完回报本轮结论。除日志外,把「已执行」刷上通知栏:
     * 用户看到「上次踢同步 14:05」迟迟不变成「已执行」,就是「闹钟响了但 JS 没跑到」
     * (渲染进程被冻结)的直接证据——这正是缺陷 A 排查要分辨的中间情况。
     */
    void reportResult(boolean ok) {
        Log.d(TAG, "reportResult ok=" + ok + " keepAliveMs=" + intervalMs);
        if (!running) return;
        String tick = lastTickHm.isEmpty() ? "--:--" : lastTickHm;
        String verdict = ok ? "✅" : "❌";
        refreshNotification(getString(R.string.bg_sync_notif_tick_done, tick, hhmm(), verdict));
    }

    private static long clampInterval(long v) {
        return Math.max(MIN_INTERVAL_MS, Math.min(v, MAX_INTERVAL_MS));
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
        // 文案里不报「每 N 分钟」:同步已改为电脑端一有改动就推(服务端安静 5 分钟后发
        // sync 事件),这里的 15 分钟只是保活 + 断流兜底。报个分钟数会让人误以为同步
        // 周期由它决定,当年「拿起手机一看变成『现在』」的误解就是这么来的。
        Notification notif = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.bg_sync_notif_title))
            .setContentText(getString(R.string.bg_sync_notif_text))
            .setSubText(getString(R.string.bg_sync_notif_subtext, minutes))
            .setSmallIcon(R.drawable.ic_stat_sync)
            .setContentIntent(contentIntent())
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();

        try {
            // ServiceCompat 内部完成 23→35 的版本分支(<29 不带 foregroundServiceType)
            ServiceCompat.startForeground(
                this,
                NOTIF_ID,
                notif,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            );
            running = true;
            return true;
        } catch (Exception e) {
            // Android 12+ 拒绝后台拉起前台服务会抛 ForegroundServiceStartNotAllowedException,
            // 捕获后退场,不让闹钟把服务打成崩溃循环
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
        am.setAndAllowWhileIdle(
            AlarmManager.ELAPSED_REALTIME_WAKEUP,
            SystemClock.elapsedRealtime() + delayMs,
            tickPendingIntent()
        );
    }

    private PendingIntent tickPendingIntent() {
        Intent i = new Intent(this, SyncForegroundService.class).setAction(ACTION_TICK);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        // getForegroundService 是 API 26 才有的;23-25 只能退回 getService
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
