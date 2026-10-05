package app.shisuiji.danji;

import android.Manifest;
import android.content.Intent;
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
 * 暴露给 JS 的后台同步开关（window.Capacitor.Plugins.BackgroundSync）。
 *
 * Capacitor 的 JSExport 会为每个注册到 Bridge 的插件自动生成 JS 代理，
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
     * 启动前台服务。只应由前台 App 调用（用户拨开关 / 打开 App 自动恢复），
     * 以规避 Android 12+ 对后台启动前台服务的限制。
     * @param intervalMs 可选，调试时用来把 15 分钟压短；夹到 1~60 分钟
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
        try {
            ContextCompat.startForegroundService(getContext(), i);
        } catch (Exception e) {
            Log.w(SyncForegroundService.TAG, "start rejected", e);
            call.reject("后台同步服务启动失败：" + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /**
     * 停止服务。用 stopService 而不是发一个 ACTION_STOP 过去：
     * 后者走 startForegroundService 会先 startForeground 再停，闪一下通知还平白背上 5 秒契约。
     */
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
     * JS 每次踢完回报 {ok:boolean}，服务端只作日志观察（间隔已固定，不再退避）。
     * skipped（running / offline / need_token）由 JS 侧算作中性，与真失败区分开。
     */
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

    /**
     * POST_NOTIFICATIONS 只影响那条常驻通知可不可见，不影响服务能否运行——
     * 未授权时 startForeground 照样成功。所以这里 fire-and-forget，不阻塞、不关心结果。
     */
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
        // Activity 重建时新插件实例可能已经写入新的 bridge，别把它擦掉
        WeakReference<com.getcapacitor.Bridge> ref = SyncForegroundService.bridgeRef;
        if (ref != null && ref.get() == this.bridge) {
            SyncForegroundService.bridgeRef = null;
        }
        super.handleOnDestroy();
    }
}
