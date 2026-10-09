/* 拾穗集 —— 原生离线快照的应用判定(纯函数,零依赖,可 Node 单测)
 *
 * M18:原生后台同步(SyncForegroundService.syncCycle)把 /api/sync/pull 的响应体
 * 落进 App 私有目录(bg_snapshot.json);App 启动/回前台时 JS 经 bridge 读出来,
 * 用这里的判定决定「要不要灌进 IndexedDB 镜像」。
 * 判定必须纯:跨端行为钉死在 tools/test-sync-logic.mjs,不许掺运行时状态。
 */

/**
 * 快照要不要应用(写进镜像)?
 * - 快照缺版本号 → 不应用;
 * - 本地从没同步过(没有可比的本地版本):快照好过空镜像 → 应用;
 * - 同一服务进程(boot_id 相同)且快照版本更新 → 应用;
 * - 同 boot 但版本没更进(重复/旧快照) → 不应用;
 * - boot_id 不同(服务端重启过,版本号跨进程不可比) → 不应用。
 *   2026-10-09 复盘:服务端重启后版本归 1,而旧快照的版本号是个大数,
 *   盲目按数值比较会把新镜像倒灌回旧数据——宁可放弃快照也不冒这个险。
 * @param {{ storedVersion?: number, storedBootId?: string, snapVersion?: number, snapBootId?: string }} o
 * @returns {boolean}
 */
export function shouldApplySnapshot({ storedVersion = 0, storedBootId = '', snapVersion = 0, snapBootId = '' } = {}) {
  const sv = Number(storedVersion) || 0;
  const nv = Number(snapVersion) || 0;
  if (nv <= 0) return false;
  if (sv <= 0) return true;
  const sb = String(storedBootId || '');
  const nb = String(snapBootId || '');
  if (!sb || !nb || sb !== nb) return false;
  return nv > sv;
}