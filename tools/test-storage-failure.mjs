// Persistence regressions: injected failures stay in memory or isolated copies.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createJsonTransactions } from '../lib/json-transactions.js';

let passed = 0;
async function check(name, action) {
  await action();
  passed++;
  console.log('  ✓ ' + name);
}

function fixture() {
  let memory = { value: 'old' };
  let effects = 0;
  const disk = new Map([['a', 'old-a'], ['b', 'old-b']]);
  const fail = new Set();
  const store = createJsonTransactions({
    read: async file => disk.get(file),
    write: async (file, text) => {
      if (fail.has(file + ':' + text)) throw new Error('injected write failure');
      disk.set(file, text);
    },
    remove: async file => disk.delete(file),
    capture: () => JSON.stringify(memory),
    restore: snapshot => { memory = JSON.parse(snapshot); },
    warn: () => {},
  });
  return { store, disk, fail, get memory() { return memory; },
    get effects() { return effects; }, effect: () => { effects++; } };
}

await check('写盘失败拒绝成功、恢复内存、不触发通知或清图', async () => {
  const f = fixture(); f.fail.add('a:new-a');
  await assert.rejects(f.store.run(async () => {
    f.memory.value = 'unsaved';
    await f.store.save('a', 'new-a');
    await f.store.afterCommit(f.effect);
  }), { code: 'storage_write_failed' });
  assert.equal(f.memory.value, 'old');
  assert.equal(f.disk.get('a'), 'old-a');
  assert.equal(f.effects, 0);
  f.fail.clear();
  await f.store.run(async () => { await f.store.save('a', 'retry'); await f.store.afterCommit(f.effect); });
  assert.equal(f.disk.get('a'), 'retry'); assert.equal(f.effects, 1);
});
await check('第二个文件失败时恢复已写入的第一个文件', async () => {
  const f = fixture(); f.fail.add('b:new-b');
  await assert.rejects(f.store.run(async () => {
    f.memory.value = 'new'; await f.store.save('a', 'new-a'); await f.store.save('b', 'new-b');
  }));
  assert.deepEqual([...f.disk], [['a', 'old-a'], ['b', 'old-b']]);
  assert.equal(f.memory.value, 'old');
});
await check('恢复文件也失败时阻止继续展示或改写不确定的数据', async () => {
  const f = fixture(); f.fail.add('b:new-b'); f.fail.add('a:old-a');
  await assert.rejects(f.store.run(async () => {
    await f.store.save('a', 'new-a'); await f.store.save('b', 'new-b');
  }), { code: 'storage_recovery_failed' });
  await assert.rejects(f.store.run(() => assert.fail('must not run')), { code: 'storage_recovery_failed' });
});
await check('路由本身报错时丢弃暂存写入并恢复内存', async () => {
  const f = fixture();
  await assert.rejects(f.store.run(async () => {
    f.memory.value = 'new'; await f.store.save('a', 'new'); throw new Error('handler failed');
  }), /handler failed/);
  assert.equal(f.memory.value, 'old'); assert.equal(f.disk.get('a'), 'old-a');
});
await check('并发读取排在提交之后，队列失败后仍可重试', async () => {
  const f = fixture(); let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const first = f.store.run(async () => { f.memory.value = 'new'; await barrier; await f.store.save('a', 'new'); });
  const next = f.store.run(() => { assert.equal(f.disk.get('a'), 'new'); return f.memory.value; });
  release(); await first; assert.equal(await next, 'new');
});

// The actual server always runs from a separate temporary copy with its own data.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'danji-storage-test-'));
let child;
let logs = '';
try {
  for (const item of ['server.js', 'public', 'lib']) await fs.cp(path.join(root, item), path.join(temp, item), { recursive: true });
  const papers = path.join(temp, 'test-papers');
  await fs.mkdir(papers);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const preload = path.join(temp, 'fault.cjs');
  await fs.writeFile(preload, `
const fs = require('fs'); const path = require('path');
const original = fs.promises.rename;
fs.promises.rename = async function(from, to) {
  const flag = path.join(__dirname, 'fail-rename');
  if (fs.existsSync(flag) && path.basename(to) === fs.readFileSync(flag, 'utf8')) {
    fs.unlinkSync(flag); throw Object.assign(new Error('injected rename failure'), {code:'EACCES'});
  }
  return original.call(this, from, to);
};`);
  const base = 'http://127.0.0.1:' + port;
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) });
    return { status: response.status, data: await response.json() };
  };
  const start = async () => {
    child = spawn(process.execPath, ['--require', preload, path.join(temp, 'server.js')], {
      cwd: temp, windowsHide: true,
      env: { ...process.env, PORT: String(port), DANJI_HOST: '0.0.0.0', DANJI_TOKEN: 'isolated-pair-token',
        DANJI_PAPERS_DIR: papers, DANJI_TLS_CERT: '', DANJI_TLS_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', data => { logs += data; });
    child.stderr.on('data', data => { logs += data; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('Isolated startup failed: ' + logs);
      try { if ((await request('/api/health')).status === 200) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Isolated startup timeout: ' + logs);
  };
  const stop = async () => {
    if (!child) return;
    const running = child;
    child = null;
    if (running.exitCode !== null || running.signalCode !== null) return;
    const exited = new Promise(resolve => running.once('close', resolve)); running.kill(); await exited;
  };
  const failNext = name => fs.writeFile(path.join(temp, 'fail-rename'), name);
  await start();
  let idea;
  await check('真实 API：创建失败返回 503，不暴露未落盘记录，也不推进版本', async () => {
    const version = (await request('/api/sync/pull')).data.data_version;
    await failNext('ideas.json');
    const failed = await request('/api/ideas', 'POST', { title: 'draft', content: 'keep input' });
    assert.equal(failed.status, 503); assert.equal(failed.data.code, 'storage_write_failed');
    assert.deepEqual((await request('/api/ideas')).data, []);
    assert.equal((await request('/api/sync/pull')).data.data_version, version);
    const saved = await request('/api/ideas', 'POST', { title: 'saved', content: 'retained' });
    assert.equal(saved.status, 201); idea = saved.data;
  });
  await check('真实 API：编辑失败后原内容、原版本仍在，重试可保存', async () => {
    await failNext('ideas.json');
    assert.equal((await request('/api/ideas/' + idea.id, 'PUT', { content: 'unsaved' })).status, 503);
    assert.equal((await request('/api/ideas')).data[0].content, 'retained');
    assert.equal((await request('/api/ideas')).data[0].updated_at, idea.updated_at);
  });
  await check('真实 API：删除第二次写盘失败，回收站和原记录一起恢复', async () => {
    const version = (await request('/api/sync/pull')).data.data_version;
    await failNext('ideas.json');
    assert.equal((await request('/api/ideas/' + idea.id, 'DELETE')).status, 503);
    assert.equal((await request('/api/ideas')).data[0].id, idea.id);
    assert.equal((await request('/api/trash')).data.items.length, 0);
    assert.equal((await request('/api/sync/pull')).data.data_version, version);
    await stop(); await start();
    assert.equal((await request('/api/ideas')).data[0].content, 'retained');
    assert.equal((await request('/api/trash')).data.items.length, 0);
  });
  await check('真实 API：独立消息队列的写盘失败同样恢复内存', async () => {
    await failNext('messages.json');
    assert.equal((await request('/api/messages', 'POST', { title: 'unsaved message' })).status, 503);
    assert.deepEqual((await request('/api/messages')).data, []);
  });
  await check('真实 API：文献记录保存失败时，模拟 PDF 也回到原位置', async () => {
    const source = path.join(papers, 'sample.pdf');
    await fs.writeFile(source, '%PDF-isolated-example');
    await failNext('papers.json');
    const failed = await request('/api/papers', 'POST', {
      title: 'example paper', file_name: 'sample.pdf', category: 'test', status: 'to_read',
    });
    assert.equal(failed.status, 503);
    assert.equal(await fs.readFile(source, 'utf8'), '%PDF-isolated-example');
    assert.deepEqual((await request('/api/papers')).data, []);
  });
  await check('真实 API：手机批量推送失败不留下成功回执，可用同一操作重试', async () => {
    const op = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', op: 'create', operation_id: 'retry-one',
      title: 'mobile', content: 'outbox', updated_at: new Date().toISOString() };
    await failNext('ideas.json');
    assert.equal((await request('/api/sync/push', 'POST', { ideas: [op] })).status, 503);
    const retry = await request('/api/sync/push', 'POST', { ideas: [op] });
    assert.equal(retry.data.results[0].applied, true);
    assert.equal((await request('/api/sync/push', 'POST', { ideas: [op] })).data.results[0].already, true);
  });
  const lan = Object.values(os.networkInterfaces()).flat().find(ni => ni.family === 'IPv4' && !ni.internal)?.address;
  if (lan) await check('真实 API：健康检查免口令，配对检查拒绝空口令和错误口令', async () => {
    const url = 'http://' + lan + ':' + port;
    assert.equal((await fetch(url + '/api/health')).status, 200);
    assert.equal((await fetch(url + '/api/pair/check')).status, 401);
    assert.equal((await fetch(url + '/api/pair/check', { headers: { 'X-Danji-Token': 'wrong' } })).status, 401);
    const response = await fetch(url + '/api/pair/check', { headers: { 'X-Danji-Token': 'isolated-pair-token' } });
    assert.equal(response.status, 200); assert.equal((await response.json()).app, 'shisuiji');
  });
  else console.log('  SKIP 配对服务鉴权：本机无非回环 IPv4');
  await stop();
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('close', resolve)); child.kill(); await exited;
  }
  if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('danji-storage-test-')) throw new Error('Unsafe test cleanup target');
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}
console.log(`✓ ${passed} 项存储及服务鉴权回归通过`);
