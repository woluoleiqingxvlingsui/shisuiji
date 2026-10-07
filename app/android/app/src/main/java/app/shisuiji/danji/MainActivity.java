package app.shisuiji.danji;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前:registerPlugin 只是往 bridgeBuilder 里登记,
        // 实例化发生在 super.onCreate 末尾的 load() 里
        registerPlugin(BackgroundSyncPlugin.class);
        super.onCreate(savedInstanceState);

        // M16:让 WebView 渲染进程在退到后台后仍保持「前台级」优先级。
        // M17 里它仍然重要:后台踢 JS(推 outbox 里的离线随记)依旧靠渲染进程活着。
        if (Build.VERSION.SDK_INT >= 29 && bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().setRendererPriorityPolicy(
                WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // M17:前台/后台是「回报归属权」的开关——前台归 JS(前台补齐),
        // 后台归原生(后台补齐)。onResume 在 plugin.start 之前就会跑到,顺序天然正确。
        SyncForegroundService.pageVisible = true;
    }

    @Override
    protected void onPause() {
        super.onPause();
        SyncForegroundService.pageVisible = false;
    }
}
