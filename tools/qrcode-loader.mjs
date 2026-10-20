/**
 * 拾穗集 —— qrcode 依赖加载（两条配对码路径共用）
 * 优先仓库根 node_modules（README 的「在仓库根目录执行 npm install」），
 * 回落到 app/node_modules（Capacitor 壳自己的依赖）。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const QRCODE_MISSING_ERROR = '找不到 qrcode，请先在仓库根目录执行：npm install';

/** 纯函数：在 baseDir 下解析 qrcode 包路径（根优先、app 回落），找不到返回 null */
export function resolveQrcodePath(baseDir) {
  const candidates = [
    path.join(baseDir, 'node_modules', 'qrcode'),
    path.join(baseDir, 'app', 'node_modules', 'qrcode'),
  ];
  for (const candidate of candidates) {
    try {
      require(candidate);
      return candidate;
    } catch { /* 试下一个 */ }
  }
  return null;
}

/** 加载仓库里的 qrcode；都没有时抛出与 README 一致的提示 */
export function loadQrcode() {
  const baseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const found = resolveQrcodePath(baseDir);
  if (!found) throw new Error(QRCODE_MISSING_ERROR);
  return require(found);
}
