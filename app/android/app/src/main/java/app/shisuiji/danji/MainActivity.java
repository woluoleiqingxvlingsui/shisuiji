package app.shisuiji.danji;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前：registerPlugin 只是往 bridgeBuilder 里登记，
        // 实例化发生在 super.onCreate 末尾的 load() 里
        registerPlugin(BackgroundSyncPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
