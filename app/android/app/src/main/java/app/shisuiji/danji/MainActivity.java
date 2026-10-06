package app.shisuiji.danji;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前：registerPlugin 只是往 bridgeBuilder 里登记，
        // 实例化发生在 super.onCreate 末尾的 load() 里
        registerPlugin(BackgroundSyncPlugin.class);
        super.onCreate(savedInstanceState);

        // M16:让 WebView 渲染进程在退到后台后仍保持「前台级」优先级,不被
        // Cached App Freezer 冻结。2026-10-06 17:43 实测:15 分钟精确闹钟已经会响
        // (原生侧正常),但 evaluateJavascript 踢不到冻结的渲染进程,后台的
        // JS(SSE 处理 / 3 分钟兜底轮询 / 闹钟踢同步)全部停摆。
        // 默认策略是「不可见即降级」(waivedWhenNotVisible=true),第二个参数传 false
        // 就是「不可见也不降级」。渲染进程活着,后台同步整条链路才真正可用。
        // setRendererPriorityPolicy 是 API 29+;setContentView 失败的兜底布局下
        // bridge 为 null,也要防住。
        if (Build.VERSION.SDK_INT >= 29 && bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().setRendererPriorityPolicy(
                WebSettings.RendererPriority.RENDERER_PRIORITY_IMPORTANCE, false);
        }
    }
}
