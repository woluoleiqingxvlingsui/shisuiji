/* 拾穗集 —— 知识卡「手动保护」判定（纯函数，零依赖，可被 Node 直接单测）
 *
 * 背景：源笔记更新会自动同步进知识库。但知识卡可能被用户手工加工过，
 * 这时自动同步不能静默覆盖——必须先问用户（合并层）。
 *
 * 三段状态（与 server.js 的 kbManualProtected 同一套口径）：
 *   1) manual_protected === true  → 受保护（用户明确保留手动版 / 自己合并过）；
 *   2) 有 auto 基线（上次自动生成时的 title/content）且当前正文与基线不同 → 受保护；
 *      **这一条优先于 manual_protected === false**：一个过期的 false 不能绕过基线比对，
 *      否则用户改完正文又被自动覆盖（那正是要修的数据丢失）。
 *   3) 有基线且正文与基线一致 → 未受保护，允许自动同步直接覆盖；
 *   4) manual_protected === false 且无基线 → 未受保护；
 *   5) 旧卡（既无基线也无标记）→ 保守：有过 manual_at 就当受保护（不覆盖手工卡）。
 *
 * 关键：**不只靠时间戳**。旧实现只比 manual_at 与 auto.at，谁新算谁受保护；
 * 「保留手动版」那次写入会刷新 auto.at，于是手工内容被当成没改过 → 下一次
 * 源笔记更新直接覆盖用户的字（数据丢失）。现在以「基线 + 显式标记」为准。
 */

/**
 * 这张卡是否被手动加工过（受保护）。
 * @param {object} card 知识卡（含 manual_protected / auto.baseline / manual_at）
 * @returns {boolean}
 */
function kbManualProtected(card) {
  if (!card || typeof card !== 'object') return false;
  if (card.manual_protected === true) return true;
  const auto = card.auto && typeof card.auto === 'object' ? card.auto : null;
  if (auto && auto.baseline && typeof auto.baseline === 'object') {
    return String(card.title || '') !== String(auto.baseline.title || '')
      || String(card.content || '') !== String(auto.baseline.content || '');
  }
  if (card.manual_protected === false) return false;
  return !!card.manual_at;
}

/** 用户已经就哪个源笔记版本做过决定（保留手动版 / 自己合并 / 用笔记版都会记下来） */
function kbConfirmedRef(card) {
  const auto = card && card.auto && typeof card.auto === 'object' ? card.auto : null;
  return String((auto && auto.confirmed_ref) || '');
}

/**
 * 源笔记来更新时，这条知识卡该怎么处理。
 * @param {object} card 知识卡
 * @param {string} incomingRef 本次源笔记版本（笔记的 updated_at）
 * @returns {'auto'|'ask'|'skip'}
 *   auto  = 未被手动改动 → 静默自动更新；
 *   ask   = 被手动改动过 → 弹合并层让用户定稿；
 *   skip  = 受保护且这个源笔记版本用户已经定过稿 → 不再问、也不覆盖。
 */
function kbMergeDecision(card, incomingRef) {
  if (!kbManualProtected(card)) return 'auto';
  const confirmed = kbConfirmedRef(card);
  const incoming = String(incomingRef || '');
  if (confirmed && incoming && confirmed === incoming) return 'skip';
  return 'ask';
}

export { kbManualProtected, kbConfirmedRef, kbMergeDecision };
