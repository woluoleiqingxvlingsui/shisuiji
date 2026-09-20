/* 拾穗集 —— 未写完的笔记草稿（存 localStorage）
 * 从 app.js 原样搬过来的纯函数，逻辑一字未改。
 */

const LOG_DRAFT_PREFIX = 'danji.logDraft.';       // 文献笔记（键名保持不变，老草稿还在）
const SITE_DRAFT_PREFIX = 'danji.siteNoteDraft.'; // 网页笔记
function readDraft(prefix, id) {
  try {
    const raw = localStorage.getItem(prefix + id);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function writeDraft(prefix, id, form, isEmpty) {
  try {
    if (!id || !form) return;
    if (isEmpty(form)) localStorage.removeItem(prefix + id); // 全空就别留空壳
    else localStorage.setItem(prefix + id, JSON.stringify({
      ...form, parts: [...(form.parts || [])], saved_at: new Date().toISOString(),
    }));
  } catch (e) {}
}
function clearDraft(prefix, id) {
  try { localStorage.removeItem(prefix + id); } catch (e) {}
}

export { LOG_DRAFT_PREFIX, SITE_DRAFT_PREFIX, readDraft, writeDraft, clearDraft };
