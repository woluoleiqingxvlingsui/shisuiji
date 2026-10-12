package app.shisuiji.danji;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** 单写入者的快照存储。只有完整写入并替换成功才返回，失败保留上一份快照。 */
final class SnapshotStore {
    static void save(File destination, String body) throws IOException {
        File temporary = new File(destination.getPath() + ".tmp");
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(body.getBytes(StandardCharsets.UTF_8));
                output.getFD().sync();
            }
            if (!temporary.renameTo(destination)) {
                throw new IOException("snapshot rename failed; previous snapshot preserved");
            }
        } finally {
            // 只清理本轮临时文件，不删除或截断旧快照。
            if (temporary.exists()) temporary.delete();
        }
    }
}
