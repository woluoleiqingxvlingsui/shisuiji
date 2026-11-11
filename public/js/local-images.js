/* 拾穗集 —— 手机端本地图片仓（M21-C：离线也能给随记加图）
 *
 * 为什么要有这一层：手机断网时上传不走，但用户仍想先把图加到随记里。
 * 图片先存本机 IndexedDB（store images，id 形如 'local:<uuid>'），随记照常
 * 进 outbox；联网同步时由 engine.pushOnce() 在组装 /api/sync/push 之前调
 * resolveOutboxImages() 把 local id 逐张上传成服务端 UUID，并写回 outbox。
 *
 * 红线：服务端 sanitizeImages 只认标准 UUID，'local:' 前缀的 id 绝不能出现在
 * 发给服务端的请求体里；这里只负责本机存取与上传，替换/持久化由 engine 做。
 */

import { STORE_IMAGES, idbAvailable, idbGet, idbPut, idbDelete } from './sync/idb.js';
import { uploadImage } from './api.js';

const LOCAL_PREFIX = 'local:';
const MAX_NAME_LEN = 200;

// 与服务端 IMAGE_TYPES 对齐：上传时按文件名后缀判类型，没名字就用 blob 的 MIME 推
const TYPE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

// ---- 选图前校验（与服务端 handleUpload 同一套口径，不自动压缩）----
// 后缀白名单 + 可校验 MIME + 64MB 上限 + 魔数（服务端还会再校验一次）
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;   // 与服务端 MAX_UPLOAD_BYTES 一致
const ALLOWED_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/gif', 'image/webp'];
// MIME 缺失或只是二进制流：靠魔数判别，不误拒合法图片
const UNKNOWN_MIME = ['', 'application/octet-stream', 'binary/octet-stream'];

/** 魔数校验：与服务端 imageMagicOk 逐条对齐 */
function imageMagicOk(bytes) {
  if (!bytes || bytes.length < 12) return false;
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  const head6 = String.fromCharCode(...Array.from(b.slice(0, 6)));
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return true;
  const head4 = String.fromCharCode(...Array.from(b.slice(0, 4)));
  const head12 = String.fromCharCode(...Array.from(b.slice(8, 12)));
  return head4 === 'RIFF' && head12 === 'WEBP';
}

/**
 * 选图前校验：后缀白名单 + 可校验 MIME + 64MB 上限。
 * 在「存本机」和「直传」之前都跑一遍——提前拦住服务端一定拒收的文件，
 * 免得离线存了本机、联网后才发现传不上去。
 * @returns {Promise<{ok:boolean, reason?:string, ext?:string, mime?:string}>}
 */
async function inspectImageFile(file) {
  if (!file || typeof file.size !== 'number') {
    return { ok: false, reason: '没有可保存的图片数据' };
  }
  const name = String(file.name || '图片');
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_EXT[ext]) {
    return { ok: false, reason: `「${name}」格式不支持：只收 png / jpg / jpeg / gif / webp` };
  }
  const type = String(file.type || '').toLowerCase();
  if (type && !UNKNOWN_MIME.includes(type) && !ALLOWED_MIME.includes(type)) {
    return { ok: false, reason: `「${name}」的类型（${type}）不是可校验的图片类型` };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `「${name}」超过 64MB 上限（不自动压缩，请换一张）` };
  }
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (!imageMagicOk(head)) {
      return { ok: false, reason: `「${name}」的内容不是可校验的图片（服务端会拒收）` };
    }
  } catch {
    // 读不到文件头就只按后缀 + MIME 判定，不误杀
  }
  return { ok: true, ext, mime: ALLOWED_MIME.includes(type) ? type : ALLOWED_EXT[ext] };
}

function isLocalImageId(id) {
  return typeof id === 'string' && id.startsWith(LOCAL_PREFIX);
}

function newUuid() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* 老 WebView 回落 */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function normalizeName(name, type) {
  const n = String(name || '').trim().slice(0, MAX_NAME_LEN);
  if (n) return n;
  const ext = TYPE_EXT[String(type || '').toLowerCase()] || 'png';
  return 'image.' + ext;
}

/** 把 File/Blob 存进本地仓，返回 { id, name }（id 带 local: 前缀） */
async function saveLocalImage(fileOrBlob, name) {
  if (!idbAvailable()) throw new Error('当前环境不支持 IndexedDB，图片没法先存本机');
  if (!fileOrBlob || typeof fileOrBlob.size !== 'number') {
    throw new Error('没有可保存的图片数据');
  }
  const type = fileOrBlob.type || 'application/octet-stream';
  const rec = {
    id: LOCAL_PREFIX + newUuid(),
    name: normalizeName(name || fileOrBlob.name, type),
    type,
    size: Number(fileOrBlob.size) || 0,
    saved_at: new Date().toISOString(),
    // 直接存 File/Blob：IndexedDB 结构化克隆支持 Blob，取回来还是完整字节
    blob: fileOrBlob,
  };
  await idbPut(STORE_IMAGES, rec);
  return { id: rec.id, name: rec.name };
}

/** 取本地图片记录（不存在/不是 local id 时返回 null） */
async function getLocalImage(id) {
  if (!isLocalImageId(id) || !idbAvailable()) return null;
  try {
    return await idbGet(STORE_IMAGES, id);
  } catch {
    return null;
  }
}

/** 删单张本地图（尽力而为；传非 local id 直接忽略） */
async function deleteLocalImage(id) {
  if (!isLocalImageId(id) || !idbAvailable()) return false;
  try {
    await idbDelete(STORE_IMAGES, id);
    return true;
  } catch (e) {
    console.warn('[danji-local-image] 删除本地图片失败：' + id, e && e.message);
    return false;
  }
}

/** 批量删：逐张尽力而为，一张失败不影响其他（清理场景用） */
async function deleteLocalImages(ids) {
  for (const id of ids || []) {
    await deleteLocalImage(id);
  }
}

/** 直接从本地 IDB 生成 objectURL（不走网络），供 <img> 预览用；调用方负责缓存/释放 */
async function localImageObjectUrl(id) {
  const rec = await getLocalImage(id);
  if (!rec || !rec.blob) throw new Error('本地图片不存在');
  return URL.createObjectURL(rec.blob);
}

/** 把存下来的 blob 包成 api.uploadImage 能直传的 File（失败返回 null） */
function toUploadFile(blob, name, type) {
  const mime = type || blob.type || 'application/octet-stream';
  const filename = normalizeName(name, mime);
  try {
    return new File([blob], filename, { type: mime });
  } catch { /* 老 WebView 没有 File 构造器，试下面的兜底 */ }
  try {
    const b = blob instanceof Blob ? blob : new Blob([blob], { type: mime });
    // api.uploadImage 只读 file.name / file.type，Blob 上补个 name 即可直传
    Object.defineProperty(b, 'name', { value: filename, configurable: true });
    return b;
  } catch {
    return null;
  }
}

/** 上传一张本地图，成功返回服务端 { id, name }，**不删本地记录**（resolveOutboxImages 落盘后再删） */
async function pushLocalImageToServer(id) {
  const rec = await getLocalImage(id);
  if (!rec || !rec.blob) {
    const err = new Error('本地图片不存在或已损坏');
    err.permanent = true;
    throw err;
  }
  const file = toUploadFile(rec.blob, rec.name, rec.type);
  if (!file) {
    const err = new Error('当前环境无法构造上传文件');
    err.permanent = true;
    throw err;
  }
  let r;
  try {
    r = await uploadImage(file);
  } catch (e) {
    // 网络层异常（断网 / 超时 / 原生桥失败）：保留本地记录，等下一轮同步重试
    throw new Error('图片上传失败：' + ((e && e.message) || '网络异常'));
  }
  if (!r.ok || !r.data || !r.data.id) {
    const err = new Error('图片上传失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)));
    err.status = r.status;
    // 400/413/415 这类是文件本身不被接受（格式/大小），重试多少次都一样；
    // 401/403/408/429 与 5xx 仍按可重试处理（口令/网络恢复后还能成）
    err.permanent = r.status === 400 || r.status === 413 || r.status === 415 || r.status === 422;
    throw err;
  }
  return { id: r.data.id, name: rec.name || file.name };
}

/**
 * 上传单张本地图并删掉本地记录（设计约定的对外 API）。
 * 失败时保留本地记录并抛错，调用方（pushOnce）按可重试处理。
 */
async function uploadLocalImage(id) {
  if (!isLocalImageId(id)) throw new Error('不是本地图片 id：' + id);
  const up = await pushLocalImageToServer(id);
  await deleteLocalImage(id);
  return up;
}

/**
 * push 前把 images 数组里的 local id 逐张上传替换成服务端 UUID。
 * @param {Array<{id:string,name?:string}>} images
 * @param {{ onProgress?: (nextImages: Array<{id:string,name?:string}>) => Promise<boolean|void>,
 *           onPermanent?: (fail: {id:string,name:string,reason:string}) => Promise<void>|void }} [opts]
 *   onProgress 在每张图上传成功后立刻回调，参数是「已替换 + 未处理」的完整数组；
 *   调用方据此把中间态写回 outbox——否则第二张失败重试时，第一张的本地记录已删、
 *   旧 payload 还指向 local id，会丢图。回调返回 false 表示外层已有更新的本地编辑
 *   没被覆盖，此时不删本地记录（留待下一轮按新 payload 处理）。
 *   onPermanent 在某张图被服务端**永久拒收**时回调（格式/大小这类重试也没用的）。
 *   永久拒收**不删本地 blob、也不从 payload 剔除**：图还在本机，
 *   这条随记改由上层标记为「需要处理」，等用户在编辑器里换图/移除后再同步。
 * @returns {Promise<Array<{id:string,name?:string}>>} 全部替换后的 images
 */
async function resolveOutboxImages(images, opts = {}) {
  // 丢掉没有 id 的脏项（服务端 sanitizeImages 也会丢，别浪费一次上传）
  const list = (Array.isArray(images) ? images : []).filter((im) => {
    if (im && im.id) return true;
    console.warn('[danji-local-image] 随记 payload 里有缺少 id 的图片项，已跳过');
    return false;
  });
  const resolved = [];
  for (let i = 0; i < list.length; i++) {
    const im = list[i];
    const rest = list.slice(i + 1);
    if (!isLocalImageId(im.id)) {
      resolved.push({ id: im.id, name: im.name || '' });
      continue;
    }
    let up;
    try {
      up = await pushLocalImageToServer(im.id);
    } catch (err) {
      if (err && err.permanent) {
        // 永久拒收：**不删本地 blob、不从 payload 剔除任何一张图**。
        // 这一张图保留原样（仍是 local:<uuid>），后面的图也原样保留，
        // 整条随记交由上层标记为「需要处理」，等用户在编辑器里换图或移除。
        const fail = {
          id: im.id,
          name: im.name || '',
          reason: (err && err.message) || '图片被服务端拒收',
        };
        console.warn('[danji-local-image] 图片被服务端永久拒收，已保留本机原图待处理：'
          + im.id + '（' + fail.reason + '）');
        resolved.push({ id: im.id, name: im.name || '' });
        for (const tail of rest) resolved.push({ id: tail.id, name: tail.name || '' });
        if (typeof opts.onProgress === 'function') {
          await opts.onProgress(resolved.slice());
        }
        if (typeof opts.onPermanent === 'function') {
          await opts.onPermanent(fail);
        }
        return resolved;
      }
      throw err;
    }
    resolved.push({ id: up.id, name: im.name || up.name || '' });
    let keepLocal = false;
    if (typeof opts.onProgress === 'function') {
      const ok = await opts.onProgress([...resolved, ...rest]);
      keepLocal = ok === false;
    }
    // 先落盘再删本地记录：即便进程此刻被杀，最坏是重试时再传一次，不会丢图
    if (!keepLocal) await deleteLocalImage(im.id);
  }
  return resolved;
}

/** 从 images 里挑出 local id 列表（清理用） */
function localImageIds(images) {
  return (Array.isArray(images) ? images : [])
    .map((im) => im && im.id)
    .filter(isLocalImageId);
}

/** images 里是否含本地图（pushOnce 快速跳过用） */
function hasLocalImages(images) {
  return (Array.isArray(images) ? images : []).some((im) => isLocalImageId(im && im.id));
}

export {
  LOCAL_PREFIX,
  MAX_IMAGE_BYTES,
  ALLOWED_EXT,
  ALLOWED_MIME,
  isLocalImageId,
  saveLocalImage,
  getLocalImage,
  deleteLocalImage,
  deleteLocalImages,
  localImageObjectUrl,
  uploadLocalImage,
  resolveOutboxImages,
  localImageIds,
  hasLocalImages,
  inspectImageFile,
  imageMagicOk,
};
