/* 拾穗集 —— 知识库「关联本地文件」的前端辅助
 *
 * 只做一件事：把「本地文件的路径」在知识卡与电脑之间来回搬。
 * 不上传、不复制、不解析文件内容 —— 服务端也只存路径字符串。
 *
 * 关联 / 打开 / 修改都是电脑端的事（手机端只读，见 boards/kb.js 的兜底）。
 */
import { state } from '../state.js';
import { api } from '../api.js';
import { isDesktop } from '../perm.js';
import { toast } from '../toast.js';

// 前端超时必须大于服务端超时（120s），否则先超时的是前端，白等一场
const PICK_TIMEOUT_MS = 150000;
const STATUS_TIMEOUT_MS = 20000;
const OPEN_TIMEOUT_MS = 20000;

// 同一时刻只允许一次状态查询（切板块 / 获得焦点 / 定时复检可能撞在一起）
let statusPromise = null;

/** 取路径最后一段（文件名）；同时认 / 与 \ */
function kbFileName(filePath) {
  const s = String(filePath || '');
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return cut >= 0 ? s.slice(cut + 1) : s;
}

/** 卡片上显示用的状态：available / missing / unavailable / checking / '' */
function kbFileStatusOf(id) {
  if (!id) return '';
  return (state.kbFileStatus && state.kbFileStatus[id]) || '';
}

/** 状态文案（卡片上只显示人话，不显示内部状态码） */
function kbFileStatusText(status) {
  if (status === 'missing') return '文件不在原来的位置，可能被移动或删除了';
  if (status === 'unavailable') return '暂时访问不到这个文件（磁盘没接上或没有权限）';
  if (status === 'checking') return '正在检查文件…';
  return '';
}

/**
 * 后台刷新所有已保存路径的状态（不阻塞卡片显示）。
 * fresh = true 时跳过服务端缓存重新查（刚打开文件失败 / 刚切回页面时用）。
 * 失败就静默：状态只是提示，不该打扰用户。
 */
async function refreshKbFileStatus(fresh = false) {
  if (!isDesktop()) return;
  if (statusPromise) return statusPromise;   // 不并发重复
  const current = (async () => {
    try {
      const res = await api('/api/kb/files/status' + (fresh ? '?fresh=1' : ''), { timeoutMs: STATUS_TIMEOUT_MS });
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const statuses = (data && data.statuses) || {};
      state.kbFileStatus = { ...statuses };
      state.kbFileStatusAt = Date.now();
    } catch {
      /* 静默：状态检查失败不影响知识卡本身 */
    }
  })();
  statusPromise = current;
  try {
    await current;
  } finally {
    // 只清自己发起的那一次：期间若又发起了新的，交给新的一方清
    if (statusPromise === current) statusPromise = null;
  }
  return current;
}

/**
 * 弹系统文件选择窗口（仅电脑端 Windows）。
 * 返回选中的路径；用户取消 / 失败 → 返回空串（绝不回填错误数据）。
 */
async function pickLocalFile() {
  if (!isDesktop()) {
    toast('选择文件只在电脑端可用', 'warn');
    return '';
  }
  try {
    const res = await api('/api/kb/files/pick', { method: 'POST', timeoutMs: PICK_TIMEOUT_MS });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error || '没能打开文件选择窗口', 'warn');
      return '';
    }
    return String(data.path || '');
  } catch (err) {
    toast('选择文件失败：' + (err && err.message ? err.message : '网络不通'), 'warn');
    return '';
  }
}

/**
 * 打开已关联的文件（只按记录 id，服务端自己去查已保存的路径）。
 */
async function openLocalKbFile(entry) {
  if (!isDesktop()) {
    toast('打开文件只在电脑端可用', 'warn');
    return false;
  }
  if (!entry || !entry.id) return false;
  try {
    const res = await api(`/api/kb/${entry.id}/open-file`, { method: 'POST', timeoutMs: OPEN_TIMEOUT_MS });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error || '打不开这个文件', 'warn');
      refreshKbFileStatus(true);   // 立刻重新确认一次状态
      return false;
    }
    toast('已打开文件 📄');
    refreshKbFileStatus();
    return true;
  } catch (err) {
    toast('打开失败：' + (err && err.message ? err.message : '网络不通'), 'warn');
    return false;
  }
}

export {
  kbFileName,
  kbFileStatusOf,
  kbFileStatusText,
  refreshKbFileStatus,
  pickLocalFile,
  openLocalKbFile,
};
