/* 拾穗集 —— IndexedDB 最小封装（手机端同步层专用）
 * store:
 *   mirror — 键 = 集合名（ideas/activities/...），值 = { items, pulled_at }
 *   outbox — 键 = 想法 id，值 = 待发操作（已按 id 折叠，每 id 只有一条）
 *   images — 键 = 'local:<uuid>'，值 = 本地图片 { id, name, type, size, blob, saved_at }
 *            （M21-C 离线加图暂存仓，v2 新增；升级时只补建缺失 store，不动旧数据）
 */

const DB_NAME = 'danji-sync';
const DB_VERSION = 2;
const STORE_MIRROR = 'mirror';
const STORE_OUTBOX = 'outbox';
const STORE_IMAGES = 'images';
const STORES = [STORE_MIRROR, STORE_OUTBOX, STORE_IMAGES];

let dbPromise = null;

function idbAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB != null;
}

function openDb() {
  if (!idbAvailable()) return Promise.reject(new Error('IndexedDB 不可用'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // 逐版本升级也走这里：只创建缺失的 store，mirror/outbox 里的旧数据原样保留
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_MIRROR)) db.createObjectStore(STORE_MIRROR, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) db.createObjectStore(STORE_OUTBOX, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_IMAGES)) db.createObjectStore(STORE_IMAGES, { keyPath: 'id' });
    };
    // 别的标签页还开着旧版本连接：升级会被阻塞。这里不 reject（阻塞解除后照样能成功），
    // 只把情况记下来；同时顺手关闭自己的旧连接，别让别的窗口也被卡住。
    req.onblocked = () => {
      console.warn('[danji-idb] 数据库升级被其他标签页占用，等待其关闭旧连接');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        // 新版本要升级：主动让路，否则后续打开会一直 blocked
        try { db.close(); } catch { /* ignore */ }
        dbPromise = null;
      };
      resolve(db);
    };
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

/** 在同一个读写事务内比较并更新一条记录。reducer 必须同步：
 * undefined=不动，null=删除，其余=写回。不能在 get 与 put 之间 await 网络或另一个事务。 */
async function idbMutate(store, key, reducer) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const bucket = tx.objectStore(store);
    let result;
    let failure;
    bucket.get(key).onsuccess = (event) => {
      try {
        const before = event.target.result || null;
        const next = reducer(before);
        if (next && typeof next.then === 'function') throw new Error('IDB reducer must be synchronous');
        if (next === null) bucket.delete(key);
        else if (next !== undefined) bucket.put(next);
        result = { before, after: next === undefined ? before : next, changed: next !== undefined };
      } catch (err) {
        failure = err;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('IndexedDB 事务中止'));
  });
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
  STORE_IMAGES,
  STORES,
  idbAvailable,
  openDb,
  idbGet,
  idbGetAll,
  idbPut,
  idbMutate,
  idbDelete,
  idbClear,
  closeDb,
};
