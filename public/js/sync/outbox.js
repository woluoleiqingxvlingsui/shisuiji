/* 拾穗集 —— 待发队列（outbox）
 * 折叠规则：同 id 只留最新状态；create 后又 delete → 整条丢掉。
 * 纯函数（collapseOutboxOp / mergeDisplayItems）可被 Node 直接单测。
 */

import { STORE_OUTBOX, idbGet, idbGetAll, idbPut, idbDelete, idbMutate } from './idb.js';

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
    // 后续本地编辑不能用旧界面携带的基线撤销已确认的因果关系。
    base_updated_at: prev ? (prev.base_updated_at || '') : (next.base_updated_at || ''),
    // 服务端是否已见过这条：见过则后续改/删是 update/delete，而不是 create
    confirmed: next.confirmed != null ? next.confirmed : (prev ? !!prev.confirmed : false),
    updated_at: next.updated_at || new Date().toISOString(),
    origin: next.origin || (prev && prev.origin) || 'mobile',
    // 操作身份：同一条已发送操作的网络重试保持同一个 id，新的用户编辑换新的 id。
    // 服务端靠它认出「这是同一次请求的重试」，不会把旧请求当成新编辑再写一遍。
    operation_id: next.operation_id || (prev && prev.operation_id) || '',
    // 是否已经发出过：区分「本地新建后取消」与「已发出、删除需要补偿」
    sent: next.sent != null ? !!next.sent : (prev ? !!prev.sent : false),
    sent_at: next.sent_at || (prev && prev.sent_at) || '',
    sent_operation_id: (prev && prev.sent_operation_id) || '',
  };

  if (!prev) {
    // 从未上过服务端的本地删除：整条不存在，直接丢。
    // 已同步/镜像里有的删除必须入队，否则 push 永远发不出去。
    if (op === 'delete' && !base.confirmed) return null;
    return base;
  }

  // create（未确认）后又 delete → 看 create 有没有发出过
  if (prev.op === 'create' && !prev.confirmed && op === 'delete') {
    // 从未发出：用户的意图是「这条别存在」，整条取消。
    if (!prev.sent) return null;
    // 已经发出（服务端可能已创建）：删除意图必须保留到安全收尾——
    // 折叠成 delete，等 create 的响应回来后由服务端真正删除并进回收站。
    // 这里的 sent 要保留：这条 delete 依赖「服务端那边已经建了」。
    return { ...base, op: 'delete', confirmed: true, sent: true };
  }

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

  // update / create 的连续改：保留最新 payload；未确认 create 仍是 create
  if (op === 'create' || op === 'update') {
    return {
      ...base,
      op: prev.confirmed ? 'update' : (prev.op === 'create' ? 'create' : op),
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
      // 叠加本地版本时保留乐观锁基线：base_updated_at 必须仍是最后一次
      // 服务端时间，不能被本地编辑时的 updated_at 覆盖
      out.push({
        ...item,
        ...op.payload,
        id,
        base_updated_at: op.base_updated_at || item.base_updated_at || item.updated_at || '',
      });
    } else {
      out.push(item);
    }
    seen.add(id);
  }

  // 镜像里没有、但队列里是 create/update 且带 payload 的，插到前面
  // （本地新想法；或服务端镜像暂时缺失但本地仍有待发版本）
  for (const op of outboxOps || []) {
    if (seen.has(op.id)) continue;
    if (op.op === 'delete' || !op.payload) continue;
    if (op.op !== 'create' && op.op !== 'update') continue;
    out.unshift({
      ...op.payload,
      id: op.id,
      base_updated_at: op.base_updated_at || '',
    });
    seen.add(op.id);
  }

  // 与桌面列表一致：置顶组优先；组内按"最近动作"（置顶/编辑取较新）倒序，其余按更新时间倒序
  const pinKey = (i) => {
    const p = String(i.pinned_at || '');
    const u = String(i.updated_at || '');
    return p > u ? p : u;
  };
  out.sort((a, b) =>
    ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
    || pinKey(b).localeCompare(pinKey(a))
    || String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
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
  const result = await mutateOutbox(op.id, prev => collapseOutboxOp(prev, op));
  return result.after;
}

/** 用户编辑、发送认领、图片替换和 ack 共用真实 IDB 事务，跨标签页也不会读后覆盖。 */
function mutateOutbox(id, reducer) {
  return idbMutate(STORE_OUTBOX, id, reducer);
}

function sameOutboxOperation(a, b) {
  if (!a || !b || a.id !== b.id) return false;
  if (a.operation_id || b.operation_id) return !!a.operation_id && a.operation_id === b.operation_id;
  // 旧队列尚未认领时使用完整请求快照，不能仅比较毫秒时间。
  return JSON.stringify(toPushPayload(a)) === JSON.stringify(toPushPayload(b));
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
    images: Array.isArray(payload.images) ? payload.images : [],
    origin: entry.origin || payload.origin || 'mobile',
    created_at: payload.created_at || entry.created_at || '',
    // 手机端的编辑时间：服务端落库时保留它，同步不改写内容时间
    updated_at: payload.updated_at || entry.updated_at || '',
    base_updated_at: entry.base_updated_at || '',
    // 操作身份：重试时保持不变，服务端据此认出「同一次请求」
    operation_id: entry.operation_id || '',
    // 置顶状态：显式设置过才随 push 上行（避免旧队列项把服务端 pinned 冲掉）
    ...(payload.pinned !== undefined ? { pinned: !!payload.pinned } : {}),
  };
}

export {
  collapseOutboxOp,
  collapseOutboxList,
  mergeDisplayItems,
  listOutbox,
  getOutbox,
  mutateOutbox,
  sameOutboxOperation,
  enqueueOutbox,
  dequeueOutbox,
  putOutbox,
  outboxCount,
  toPushPayload,
};
