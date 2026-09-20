/* 拾穗集 —— IndexedDB 最小封装（手机端同步层专用）
 * store:
 *   mirror — 键 = 集合名（ideas/activities/...），值 = { items, pulled_at }
 *   outbox — 键 = 想法 id，值 = 待发操作（已按 id 折叠，每 id 只有一条）
 */

const DB_NAME = 'danji-sync';
const DB_VERSION = 1;
const STORE_MIRROR = 'mirror';
const STORE_OUTBOX = 'outbox';
const STORES = [STORE_MIRROR, STORE_OUTBOX];

let dbPromise = null;

function idbAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB != null;
}

function openDb() {
  if (!idbAvailable()) return Promise.reject(new Error('IndexedDB 不可用'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_MIRROR)) db.createObjectStore(STORE_MIRROR, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) db.createObjectStore(STORE_OUTBOX, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error('打开 IndexedDB 失败'));
    };
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'));
  });
}

async function idbGet(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, value) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await txDone(tx);
  return value;
}

async function idbDelete(store, key) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

async function idbClear(store) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await txDone(tx);
}

/** 测试/调试用：关闭缓存的连接，便于删库 */
function closeDb() {
  if (!dbPromise) return;
  dbPromise.then((db) => { try { db.close(); } catch { /* ignore */ } }).catch(() => {});
  dbPromise = null;
}

export {
  DB_NAME,
  DB_VERSION,
  STORE_MIRROR,
  STORE_OUTBOX,
  STORES,
  idbAvailable,
  openDb,
  idbGet,
  idbGetAll,
  idbPut,
  idbDelete,
  idbClear,
  closeDb,
};
