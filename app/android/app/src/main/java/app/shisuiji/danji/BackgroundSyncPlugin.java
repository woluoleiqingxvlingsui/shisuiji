package app.shisuiji.danji;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.lang.ref.WeakReference;

/**
 * 暴露给 JS 的后台同步开关(window.Capacitor.Plugins.BackgroundSync)。
 *
 * M17 新增:
 *  - start() 接收 { token, baseUrl }:JS 把配对凭据交给原生,服务存进 SharedPreferences,
 *    之后原生 SSE/同步轮就不再依赖 WebView 是否活着;
 *  - noteSynced({ version, bootId }):JS 每轮同步成功后上报「我拉到哪个版本了」,
 *    原生据此不把手机自己的推送误报成「电脑端更新」;
 *  - getSyncedVersion():JS 每轮同步开始前向原生对账,防止「后台原生刚报过、
 *    打开 App 又报一次前台」双响。
 *
 * Capacitor 的 JSExport 会为每个注册到 Bridge 的插件自动生成 JS 代理,
 * 所以纯 JS 前端不需要 npm 包、不需要 registerPlugin、不需要类型声明。
 */
@CapacitorPlugin(name = "BackgroundSync")
public class BackgroundSyncPlugin extends Plugin {

    private static final int NOTIF_PERMISSION_REQUEST_CODE = 0x5152;

    @Override
    public void load() {
        SyncForegroundService.bridgeRef = new WeakReference<>(this.bridge);
    }

    /**
     * 启动前台服务。只应由前台 App 调用(用户拨开关 / 打开 App 自动恢复),
     * 以规避 Android 12+ 对后台启动前台服务的限制。
     * @param intervalMs 可选,调试时用来把 5 分钟压短;夹到 1~60 分钟
     * @param token 可选,电脑端访问口令(配对后 JS 每次都带)
     * @param baseUrl 可选,电脑端服务地址,如 http://192.168.1.10:8642
     */
    @PluginMethod
    public void start(PluginCall call) {
        ensureNotificationPermission();

        Intent i = new Intent(getContext(), SyncForegroundService.class)
            .setAction(SyncForegroundService.ACTION_START);
        Long intervalMs = call.getLong("intervalMs");
        if (intervalMs != null) {
            i.putExtra(SyncForegroundService.EXTRA_INTERVAL_MS, intervalMs.longValue());
        }
        String token = call.getString("token");
        if (token != null) {
            i.putExtra(SyncForegroundService.EXTRA_TOKEN, token);
        }
        String baseUrl = call.getString("baseUrl");
        if (baseUrl != null) {
            i.putExtra(SyncForegroundService.EXTRA_BASE_URL, baseUrl);
        }
        try {
            ContextCompat.startForegroundService(getContext(), i);
        } catch (Exception e) {
            Log.w(SyncForegroundService.TAG, "start rejected", e);
            call.reject("后台同步服务启动失败:" + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /** 停止服务。用 stopService 而不是发一个 ACTION_STOP 过去:见 M15 注释 */
    @PluginMethod
    public void stop(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), SyncForegroundService.class));
        } catch (Exception e) {
            Log.w(SyncForegroundService.TAG, "stop failed", e);
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("running", false);
        call.resolve(ret);
    }

    @PluginMethod
    public void isRunning(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", SyncForegroundService.running);
        call.resolve(ret);
    }

    /**
     * M17:JS 同步成功后上报「我拉到 data_version=X(boot=Y)了」。
     * 只前进不后退;boot 变了(服务端重启)直接整组对齐。
     * fire-and-forget 语义,JS 侧不等结果。
     */
    @PluginMethod
    public void noteSynced(PluginCall call) {
        long v = longArg(call, "version");
        String boot = call.getString("bootId");
        if (v > 0) {
            SharedPreferences sp = getContext()
                .getSharedPreferences(SyncForegroundService.PREFS, Context.MODE_PRIVATE);
            long lastV = sp.getLong("lastVersion", 0);
            String lastBoot = sp.getString("lastBoot", "");
            SharedPreferences.Editor e = sp.edit();
            if (boot != null && !boot.isEmpty() && !boot.equals(lastBoot)) {
                e.putLong("lastVersion", v).putString("lastBoot", boot).apply();
            } else if (v > lastV) {
                e.putLong("lastVersion", v).apply();
            }
        }
        call.resolve();
    }

    /** M17:JS 同步开始前向原生对账,拿原生的版本账本 */
    @PluginMethod
    public void getSyncedVersion(PluginCall call) {
        SharedPreferences sp = getContext()
            .getSharedPreferences(SyncForegroundService.PREFS, Context.MODE_PRIVATE);
        JSObject ret = new JSObject();
        ret.put("version", sp.getLong("lastVersion", 0));
        ret.put("bootId", sp.getString("lastBoot", ""));
        call.resolve(ret);
    }

    /** JS 每次踢完回报 {ok:boolean},服务只刷诊断通知(间隔已固定,不再退避) */
    @PluginMethod
    public void reportResult(PluginCall call) {
        boolean ok = Boolean.TRUE.equals(call.getBoolean("ok"));
        SyncForegroundService svc = SyncForegroundService.selfRef != null
            ? SyncForegroundService.selfRef.get()
            : null;
        if (svc != null && SyncForegroundService.running) {
            svc.reportResult(ok);
        }
        call.resolve();
    }

    /** PluginCall 里的数字可能是 Integer/Long/Double,统一走 Number 取 long,别硬转型 */
    private static long longArg(PluginCall call, String name) {
        Object raw = call.getData().get(name);
        return raw instanceof Number ? ((Number) raw).longValue() : 0L;
    }

    /** POST_NOTIFICATIONS 只影响常驻通知可见性;fire-and-forget,不阻塞 */
    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) {
            return;
        }
        AppCompatActivity activity = getActivity();
        if (activity == null) {
            return;
        }
        if (ActivityCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        try {
            ActivityCompat.requestPermissions(
                activity,
                new String[] { Manifest.permission.POST_NOTIFICATIONS },
                NOTIF_PERMISSION_REQUEST_CODE
            );
        } catch (Exception e) {
            Log.w(SyncForegroundService.TAG, "notification permission request failed", e);
        }
    }

    @Override
    protected void handleOnDestroy() {
        // Activity 重建时新插件实例可能已经写入新的 bridge,别把它擦掉
        WeakReference<com.getcapacitor.Bridge> ref = SyncForegroundService.bridgeRef;
        if (ref != null && ref.get() == this.bridge) {
            SyncForegroundService.bridgeRef = null;
        }
        super.handleOnDestroy();
    }
}
