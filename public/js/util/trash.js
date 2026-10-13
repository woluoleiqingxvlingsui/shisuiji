/* 拾穗集 —— 回收站的展示辅助（M20 任务 D）
 * 纯函数，不碰 state 与网络，便于单测与复用。
 */

// 来源板块徽标。activities 是赛博鸡蛋的内部数组名，用户看到的是「赛博鸡蛋」
const TRASH_SOURCE_META = {
  ideas: { label: '随记', emoji: '📝' },
  activities: { label: '赛博鸡蛋', emoji: '🥚' },
  expenses: { label: '花销', emoji: '💰' },
  achievements: { label: '成果', emoji: '🏅' },
  kb: { label: '知识库', emoji: '📚' },
  sites: { label: '网页', emoji: '🌐' },
  papers: { label: '文献', emoji: '📄' },
};

/** 标题：各板块的主标题字段不一样；都没有就退回「未命名」 */
function trashTitle(entry) {
  const p = (entry && entry.payload) || {};
  const t = p.title || p.content || p.name;
  return t ? String(t).trim() : '（无标题）';
}

/** 摘要：帮助认出删掉的是什么。有标题时只补正文/来源线索，不堆无关字段 */
function trashSummary(entry) {
  const p = (entry && entry.payload) || {};
  const title = p.title || p.content || p.name;
  if (title) {
    // 有标题又同时有正文：补一句正文；否则到此为止（再堆字段只会变噪音）
    return p.content && p.content !== p.title ? String(p.content).trim().slice(0, 60) : '';
  }
  // 没有标题的记录（花销、知识库等）才用别的字段顶上
  if (p.platform) return String(p.platform);
  if (p.url) return String(p.url);
  if (p.file_name) return String(p.file_name);
  if (p.amount !== undefined && p.amount !== null && p.amount !== '') return '¥' + p.amount;
  return '';
}

/** 还剩几天（不足一天按 1 天算；已到期返回 0） */
function trashDaysLeft(entry, now = Date.now()) {
  const t = Date.parse((entry && entry.expire_at) || '');
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t - now) / 86400000));
}

export { TRASH_SOURCE_META, trashTitle, trashSummary, trashDaysLeft };