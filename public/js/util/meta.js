/* 拾穗集 —— 状态与优惠类型的词表查询
 * 从 app.js 原样搬过来的纯函数，逻辑一字未改。
 */

import { CONFIG } from '../../config.js';

function statusMeta(id) {
  return CONFIG.statuses.find((s) => s.id === id) || CONFIG.statuses[0];
}
function typeMeta(id) {
  return CONFIG.types.find((t) => t.id === id) || CONFIG.types[CONFIG.types.length - 1];
}

export { statusMeta, typeMeta };
