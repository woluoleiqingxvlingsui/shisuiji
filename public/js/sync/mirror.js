/* 拾穗集 —— 服务端镜像（pull 落盘）
 * 手机端显示始终 = 镜像 ∪ outbox，禁止只拿 pull 结果直接盖界面。
 */

import { STORE_MIRROR, idbGet, idbPut } from './idb.js';

const MIRROR_KEYS = [
  'activities',
  'papers',
  'sites',
  'expenses',
  'insights',
  'messages',
  'ideas',
];

function emptyCollection() {
  return { items: [], pulled_at: '' };
}

/** 读单个集合镜像 */
async function readCollection(name) {
  const rec = await idbGet(STORE_MIRROR, name);
  if (!rec || !Array.isArray(rec.items)) return emptyCollection();
  return rec;
}

/** 读全部镜像（按 MIRROR_KEYS） */
async function readMirror() {
  const out = {};
  for (const key of MIRROR_KEYS) out[key] = await readCollection(key);
  return out;
}

/** pull 响应写入镜像；只覆盖 server 返回的集合，不动 outbox */
async function writeMirror(pull) {
  if (!pull || typeof pull !== 'object') return readMirror();
  const pulledAt = pull.server_time || new Date().toISOString();
  const written = {};
  for (const key of MIRROR_KEYS) {
    const items = pull[key];
    if (!Array.isArray(items)) continue;
    const rec = { key, items, pulled_at: pulledAt };
    await idbPut(STORE_MIRROR, rec);
    written[key] = rec;
  }
  return written;
}

/** 在镜像集合中替换或插入一条（push ok 回写用） */
async function upsertMirrorItem(name, item) {
  if (!item || item.id == null) return null;
  const rec = await readCollection(name);
  const items = rec.items.slice();
  const idx = items.findIndex((x) => x.id === item.id);
  if (idx === -1) items.unshift(item);
  else items[idx] = item;
  const next = { key: name, items, pulled_at: rec.pulled_at || new Date().toISOString() };
  await idbPut(STORE_MIRROR, next);
  return next;
}

/** 从镜像集合删除一条（missing / 确认删除） */
async function removeMirrorItem(name, id) {
  const rec = await readCollection(name);
  const items = rec.items.filter((x) => x.id !== id);
  const next = { key: name, items, pulled_at: rec.pulled_at || new Date().toISOString() };
  await idbPut(STORE_MIRROR, next);
  return next;
}

export {
  MIRROR_KEYS,
  emptyCollection,
  readCollection,
  readMirror,
  writeMirror,
  upsertMirrorItem,
  removeMirrorItem,
};
