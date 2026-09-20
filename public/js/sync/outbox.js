/* 拾穗集 —— 待发队列（outbox）
 * 折叠规则：同 id 只留最新状态；create 后又 delete → 整条丢掉。
 * 纯函数（collapseOutboxOp / mergeDisplayItems）可被 Node 直接单测。
 */

import { STORE_OUTBOX, idbGet, idbGetAll, idbPut, idbDelete } from './idb.js';

/**
 * 把一条新操作并入该 id 的已有队列项。
 * @param {object|null} prev 已折叠的队列项
 * @param {object} next 新操作 { id, op, payload, base_updated_at, ... }
 * @returns {object|null} 折叠后的队列项；null 表示整条取消（create→delete）
 */
function collapseOutboxOp(prev, next) {
  if (!next || !next.id) return null;
  const op = next.op === 'create' || next.op === 'update' || next.op === 'delete'
    ? next.op
    : 'update';
  const base = {
    id: next.id,
    op,
    payload: next.payload != null ? next.payload : (prev && prev.payload) || null,
    base_updated_at: next.base_updated_at != null
      ? next.base_updated_at
      : (prev && prev.base_updated_at) || '',
    // 服务端是否已见过这条：见过则后续改/删是 update/delete，而不是 create
    confirmed: next.confirmed != null ? next.confirmed : (prev ? !!prev.confirmed : false),
    updated_at: next.updated_at || new Date().toISOString(),
    origin: next.origin || (prev && prev.origin) || 'mobile',
  };

  if (!prev) {
    if (op === 'delete') {
      // 从未上过服务端的删除：本地本来就不存在，直接丢
      return null;
    }
    return base;
  }

  // create（未确认）后又 delete → 整条丢掉
  if (prev.op === 'create' && !prev.confirmed && op === 'delete') return null;

  // 已是 delete 又来 create（同 id 复活）→ 变回 create，带最新 payload
  if (prev.op === 'delete' && op === 'create') {
    return { ...base, op: 'create', confirmed: false };
  }

  // delete 后来 update：没有可更新对象，保持 delete
  if (prev.op === 'delete' && op === 'update') {
    return { ...prev, updated_at: base.updated_at };
  }

  // create 后 update：仍是 create（服务端还没见过），payload 用最新
  if (prev.op === 'create' && !prev.confirmed && op === 'update') {
    return { ...base, op: 'create', confirmed: false };
  }

  // update 后 update / create 后 create：保留最新 payload
  // 未确认 create 保持 create，已确认则走 update
  if (op === 'create' || op === 'update') {
    return {
      ...base,
      op: prev.confirmed ? (op === 'create' ? 'update' : 'update') : (prev.op === 'create' ? 'create' : base.op),
    };
  }

  // 其余情况（update→delete 等）：保留新操作
  return base;
}

/** 批量折叠：输入按时间序的操作列表，输出按 id 折叠后的数组（保持最后出现的顺序） */
function collapseOutboxList(ops) {
  const map = new Map();
  for (const op of ops || []) {
    const next = collapseOutboxOp(map.get(op.id) || null, op);
    if (next) map.set(op.id, next);
    else map.delete(op.id);
  }
  return [...map.values()];
}

/**
 * 显示列表 = 镜像 ∪ 队列叠加。
 * @param {Array} mirrorItems 镜像里的集合
 * @param {Array} outboxOps 折叠后的 outbox（仅作用于本集合的 id）
 */
function mergeDisplayItems(mirrorItems, outboxOps) {
  const ops = new Map((outboxOps || []).map((o) => [o.id, o]));
  const out = [];
  const seen = new Set();

  for (const item of mirrorItems || []) {
    const id = item && item.id;
    if (id == null) continue;
    const op = ops.get(id);
    if (op && op.op === 'delete') continue; // 本地已删
    if (op && (op.op === 'create' || op.op === 'update') && op.payload) {
      out.push({ ...item, ...op.payload, id });
    } else {
      out.push(item);
    }
    seen.add(id);
  }

  // 镜像里没有、但队列里是 create 的，插到前面（本地新想法优先看见）
  for (const op of outboxOps || []) {
    if (seen.has(op.id)) continue;
    if (op.op !== 'create' || !op.payload) continue;
    out.unshift({ ...op.payload, id: op.id });
    seen.add(op.id);
  }

  // 与桌面列表一致：updated_at 降序
  out.sort((a, b) =>
    String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
    || String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return out;
}

/** 从 IDB 读全部 outbox（已折叠存储，通常每 id 一条） */
async function listOutbox() {
  return idbGetAll(STORE_OUTBOX);
}

/** 取单条 */
async function getOutbox(id) {
  return idbGet(STORE_OUTBOX, id);
}

/** 写入/折叠一条操作；返回折叠后的项（null=整条已取消） */
async function enqueueOutbox(op) {
  const prev = await getOutbox(op.id);
  const next = collapseOutboxOp(prev, op);
  if (!next) {
    if (prev) await idbDelete(STORE_OUTBOX, prev.id);
    return null;
  }
  await idbPut(STORE_OUTBOX, next);
  return next;
}

/** 出队 */
async function dequeueOutbox(id) {
  await idbDelete(STORE_OUTBOX, id);
}

/** 覆盖写（冲突解决选电脑端等场景） */
async function putOutbox(entry) {
  if (!entry) return null;
  await idbPut(STORE_OUTBOX, entry);
  return entry;
}

/** 待发条数（折叠后） */
async function outboxCount() {
  return (await listOutbox()).length;
}

/** 把 outbox 项变成 /api/sync/push 的 op 形状 */
function toPushPayload(entry) {
  if (!entry) return null;
  const payload = entry.payload || {};
  return {
    id: entry.id,
    op: entry.op,
    title: payload.title || '',
    content: payload.content || '',
    origin: entry.origin || payload.origin || 'mobile',
    created_at: payload.created_at || entry.created_at || '',
    base_updated_at: entry.base_updated_at || '',
  };
}

export {
  collapseOutboxOp,
  collapseOutboxList,
  mergeDisplayItems,
  listOutbox,
  getOutbox,
  enqueueOutbox,
  dequeueOutbox,
  putOutbox,
  outboxCount,
  toPushPayload,
};
