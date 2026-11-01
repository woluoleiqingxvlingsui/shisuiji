/* 拾穗集 —— 瀑布流分列（M20 任务 E）
 *
 * 为什么要自己分列而不用 CSS columns：
 *   1. columns 是列优先阅读（先读满整列再读下一列），把「时间倒序」的时间流直觉打乱；
 *   2. 内容高度一变（随记卡展开/收起、图片加载完）整页重新平衡，卡片跨列乱跳；
 *   3. 与 transition-group 的 list-leave-active{position:absolute} 直接冲突。
 * 所以这里在 JS 侧把 items 贪心分到 N 列，列内照常纵向排布。
 *
 * 唯一的不变量（也是选它的全部理由）：
 *   **分列结果只在 items 数组变化时重算**。卡片自己展开/收起、图片加载完、
 *   卡片内容变化 —— 一律不重新分列，因此不会出现跨列跳动。
 */

/** 单卡高度的启发式预估：只用于「两列谁先谁后」的平衡，不追求像素级准确。
 *  依据是卡片实际渲染出来由什么决定：文字块数 × 行数、贴图、标签、操作栏。 */
const CHAR_WIDTH = 15;   // 卡片正文一行大约放得下的中文字符数（与 style.css 的字号/宽度对齐）
const LINE_HEIGHT = 25;  // 一行正文的高度
const BASE_HEIGHT = 96;  // 卡片内边距 + 标题行 + 底部操作栏的固定开销
/** 桌面端正文折叠后的行数：style.css 的 .clamped 是 -webkit-line-clamp: 3 */
const CLAMP_ROWS = 3;
/** 贴图一行放几张（.idea-imgs 是 flex-wrap，84px 缩略图 + 8px gap，双列时列宽有限） */
const IMAGES_PER_ROW = 4;
/** 贴图一行的高度：84px 缩略图 + 8px 行间距 */
const IMAGE_ROW_HEIGHT = 92;

/** 文本按字符数折行数 */
function lines(text, perLine = CHAR_WIDTH) {
  const n = String(text || '').length;
  return n <= 0 ? 0 : Math.ceil(n / perLine);
}

/** 数组型字段（标签 / 链接 / 图片）按每行 3 个折行 */
function rowsOf(list, perRow = 3) {
  const n = Array.isArray(list) ? list.length : 0;
  return n <= 0 ? 0 : Math.ceil(n / perRow);
}

/**
 * 通用预估：把一张卡上「一定会渲染出来的文字与图」加起来。
 *
 * @param {any} item 卡片数据
 * @param {{clampRows?: boolean}} options
 *   clampRows = 当前是不是折叠态。桌面端正文被 .clamped 折成 3 行（style.css），
 *   预估却按全文字符数算行数的话，一条 359 字的随记会估出 24 行 / 600px，
 *   实际只渲染 3 行 / 约 80px —— 高估 2.5 倍，贪心就把它单独塞进一列，
 *   后面所有卡片全被挤到另一列，左半边于是持续空着。
 *   折叠与否由调用方按 MASONRY_BREAKPOINT 决定（双列 = 桌面 = 折叠）。
 */
export function estimateCardHeight(item, options = {}) {
  if (!item || typeof item !== 'object') return BASE_HEIGHT;
  const clampRows = !!options.clampRows;
  let h = BASE_HEIGHT;

  // 标题：一行放不下就折行
  h += lines(item.title || item.name || item.platform, 16) * 28;
  // 正文类：随记 content、花销备注、成果 content、知识库 content、蛋的备注
  const bodyRows = lines(item.content || item.body || item.remark || item.note, CHAR_WIDTH);
  h += (clampRows ? Math.min(bodyRows, CLAMP_ROWS) : bodyRows) * LINE_HEIGHT;
  // 网址 / 文件路径这类长串
  h += lines(item.url || item.file || item.path, 26) * 20;
  // 标签、链接、贴图
  h += rowsOf(item.tags) * 24;
  h += rowsOf(item.links) * 24;
  // 贴图按行算：一行约 4 张、每行约 92px（原来按每张 120px 算，高估了一倍多）
  h += rowsOf(item.images, IMAGES_PER_ROW) * IMAGE_ROW_HEIGHT;
  // 文献 / 网页的笔记条数：每条笔记露出摘要行
  h += (Array.isArray(item.logs) ? item.logs.length : 0) * 26;

  return h;
}

/**
 * 把 items 贪心分到 count 列。
 * 策略：依次取「当前累计高度最短」的那一列 —— 时间序的卡片整体上仍按原顺序
 * 往下沉（第一张永远在左列顶），只在两列之间做平衡，不会出现 CSS columns
 * 那种「第一列塞满 10 张、第二列才开始第 11 张」的阅读断裂。
 * @param {any[]} items 已按业务顺序排好的卡片
 * @param {number} count 列数（1 = 单列，直接原样返回）
 * @param {(item:any, options?:object)=>number} estimate 单卡高度预估
 * @param {object} options 透传给 estimate 的上下文（如 clampRows）
 * @returns {any[][]} 每列一个数组，列内保持原顺序
 */
export function distributeIntoColumns(items, count, estimate = estimateCardHeight, options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!Number.isInteger(count) || count <= 1) return [list];

  const columns = Array.from({ length: count }, () => []);
  const heights = new Array(count).fill(0);

  for (const item of list) {
    let target = 0;
    for (let i = 1; i < count; i++) {
      if (heights[i] < heights[target]) target = i;
    }
    columns[target].push(item);
    heights[target] += estimate(item, options);
  }
  return columns;
}

/** 断点跟随既有布局：≤1000px 单列（与 style.css .layout-grid .egg-list 的断点一致） */
export const MASONRY_BREAKPOINT = 1000;

export function masonryColumnCount(width) {
  const w = Number(width) || 0;
  return w > MASONRY_BREAKPOINT ? 2 : 1;
}