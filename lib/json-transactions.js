// A request publishes its JSON changes only after every staged file is saved.
// This protects failed requests, not power loss between multiple file renames.
function createJsonTransactions({ read, write, remove, capture, restore, warn = console.error }) {
  let tail = Promise.resolve();
  let active = null;
  let unavailable = false;

  function storageError(recoveryFailed = false) {
    return Object.assign(new Error(recoveryFailed
      ? '保存失败且未能完整恢复文件，请停止服务并检查备份后再启动'
      : '保存失败，内容未保存，请检查磁盘空间和目录权限后重试'), {
      code: recoveryFailed ? 'storage_recovery_failed' : 'storage_write_failed',
      statusCode: 503,
    });
  }

  async function save(file, text) {
    if (active) { active.files.set(file, text); return; }
    await write(file, text); // startup: failure must prevent server.listen
  }

  async function afterCommit(action) {
    if (active) { active.effects.push(action); return; }
    await action();
  }

  function onRollback(action) {
    if (active) active.rollback.push(action);
  }

  async function undoEffects(tx) {
    for (const action of tx.rollback.reverse()) {
      try { await action(); }
      catch (err) {
        unavailable = true;
        warn('[shisuiji] 文件操作恢复失败:', err.message);
      }
    }
  }

  function run(action) {
    const result = tail.then(async () => {
      if (unavailable) throw storageError(true);
      const before = capture();
      const tx = { files: new Map(), effects: [], rollback: [] };
      active = tx;
      let value;
      try {
        value = await action();
      } catch (err) {
        await undoEffects(tx);
        restore(before);
        if (unavailable) throw storageError(true);
        throw err;
      } finally {
        active = null;
      }

      const originals = new Map();
      const written = [];
      try {
        // Read all originals before changing any file. Keep their exact bytes.
        for (const file of tx.files.keys()) {
          try { originals.set(file, await read(file)); }
          catch (err) {
            if (err.code !== 'ENOENT') throw err;
            originals.set(file, null);
          }
        }
        for (const [file, text] of tx.files) {
          await write(file, text);
          written.push(file);
        }
      } catch (err) {
        warn('[shisuiji] JSON 保存失败:', err.message);
        for (const file of written.reverse()) {
          try {
            const original = originals.get(file);
            if (original === null) await remove(file);
            else await write(file, original);
          } catch (rollbackError) {
            unavailable = true;
            warn('[shisuiji] JSON 恢复失败:', rollbackError.message);
          }
        }
        await undoEffects(tx);
        restore(before);
        throw storageError(unavailable);
      }

      // Never notify clients or delete images before the disk commit succeeds.
      for (const effect of tx.effects) {
        try { await effect(); }
        catch (err) { warn('[shisuiji] 保存后处理失败:', err.message); }
      }
      return value;
    });
    tail = result.catch(() => {});
    return result;
  }

  return { save, afterCommit, onRollback, run };
}

module.exports = { createJsonTransactions };
