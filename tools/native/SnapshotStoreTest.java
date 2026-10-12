package app.shisuiji.danji;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

public final class SnapshotStoreTest {
    public static void main(String[] args) throws Exception {
        File root = new File(args[0]);
        File snapshot = new File(root, "snapshot.json");
        String content = "{\"ideas\":[\"离线随记 🌾\"],\"data_version\":28}";
        SnapshotStore.save(snapshot, content);
        if (!Files.readString(snapshot.toPath(), StandardCharsets.UTF_8).equals(content)) {
            throw new AssertionError("UTF-8 snapshot must be complete");
        }
        // 无法创建临时文件：原快照必须保持完好，调用方不能把失败当成功。
        File blockedTemporary = new File(snapshot.getPath() + ".tmp");
        if (!blockedTemporary.mkdir()) throw new AssertionError("create failure fixture");
        boolean continued = false;
        try {
            SnapshotStore.save(snapshot, "replacement");
            continued = true;
        } catch (IOException expected) { }
        if (continued) throw new AssertionError("failed save cannot reach success/report continuation");
        if (!Files.readString(snapshot.toPath(), StandardCharsets.UTF_8).equals(content)) {
            throw new AssertionError("failed write destroyed previous snapshot");
        }
        // rename 无法替换非空目录，确认失败不会留下一份半成品快照。
        File blockedDestination = new File(root, "blocked.json");
        blockedDestination.mkdir();
        Files.writeString(new File(blockedDestination, "keep").toPath(), "existing");
        try {
            SnapshotStore.save(blockedDestination, "replacement");
            throw new AssertionError("rename failure must propagate");
        } catch (IOException expected) { }
        if (new File(blockedDestination.getPath() + ".tmp").exists()) {
            throw new AssertionError("temporary snapshot leaked");
        }
        System.out.println("✓ native snapshot: UTF-8 persisted; write/rename failures preserve previous data and stop success");
    }
}
