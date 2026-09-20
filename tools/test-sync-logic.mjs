/**
 * 拾穗集 —— 手机同步层纯逻辑单测（Node，无需浏览器/IDB）
 * 用法：node tools/test-sync-logic.mjs
 */
import assert from 'node:assert/strict';
import {
  collapseOutboxOp,
  collapseOutboxList,
  mergeDisplayItems,
  toPushPayload,
} from '../public/js/sync/outbox.js';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const t = (extra) => new Date(Date.parse('2026-02-26T10:00:00Z') + (extra || 0)).toISOString();

ok('create + update 折叠为最新 create payload', () => {
  const a = collapseOutboxOp(null, {
    id: 'i1', op: 'create',
    payload: { title: 'A', content: '1' },
    base_updated_at: '', updated_at: t(0),
  });
  const b = collapseOutboxOp(a, {
    id: 'i1', op: 'update',
    payload: { title: 'A2', content: '2' },
    base_updated_at: '', updated_at: t(1000),
  });
  assert.equal(b.op, 'create');
  assert.equal(b.payload.title, 'A2');
});

ok('create + delete 整条丢掉', () => {
  const a = collapseOutboxOp(null, {
    id: 'i2', op: 'create',
    payload: { title: 'B', content: '' },
    updated_at: t(0),
  });
  const b = collapseOutboxOp(a, { id: 'i2', op: 'delete', payload: null, updated_at: t(1) });
  assert.equal(b, null);
});

ok('已确认 update + delete 保留 delete', () => {
  const a = collapseOutboxOp(null, {
    id: 'i3', op: 'update', confirmed: true,
    payload: { title: 'C', content: 'x' },
    base_updated_at: '2026-02-26T09:00:00.000Z',
    updated_at: t(0),
  });
  const b = collapseOutboxOp(a, { id: 'i3', op: 'delete', payload: null, updated_at: t(2) });
  assert.equal(b.op, 'delete');
  assert.equal(b.id, 'i3');
});

ok('delete + create 同 id 复活为 create', () => {
  const a = collapseOutboxOp(null, { id: 'i4', op: 'delete', payload: null, confirmed: true, updated_at: t(0) });
  const b = collapseOutboxOp(a, {
    id: 'i4', op: 'create',
    payload: { title: 'D2', content: 'new' },
    updated_at: t(3),
  });
  assert.equal(b.op, 'create');
  assert.equal(b.payload.title, 'D2');
});

ok('列表折叠：同 id 连续改只留最新', () => {
  const ops = collapseOutboxList([
    { id: 'x', op: 'create', payload: { title: '1' }, updated_at: t(0) },
    { id: 'x', op: 'update', payload: { title: '2' }, updated_at: t(1) },
    { id: 'y', op: 'create', payload: { title: 'y1' }, updated_at: t(2) },
    { id: 'y', op: 'delete', payload: null, updated_at: t(3) },
  ]);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].id, 'x');
  assert.equal(ops[0].payload.title, '2');
});

ok('显示 = 镜像 ∪ 队列：本地 create 叠加，delete 隐藏，update 替换', () => {
  const mirror = [
    { id: 'm1', title: '镜像1', content: '', updated_at: t(0) },
    { id: 'm2', title: '镜像2', content: '', updated_at: t(1) },
  ];
  const outbox = collapseOutboxList([
    { id: 'm2', op: 'update', payload: { id: 'm2', title: '改过的2', content: '本地', updated_at: t(10) }, updated_at: t(10) },
    { id: 'local', op: 'create', payload: { id: 'local', title: '本地新', content: '仅队列', updated_at: t(20) }, updated_at: t(20) },
  ]);
  // 再叠一条 delete m1
  const outbox2 = collapseOutboxList([
    ...outbox,
    { id: 'm1', op: 'update', payload: { id: 'm1', title: 'x', content: '', updated_at: t(0) }, confirmed: true, updated_at: t(1) },
    { id: 'm1', op: 'delete', payload: null, confirmed: true, updated_at: t(2) },
  ]);
  const list = mergeDisplayItems(mirror, outbox2);
  const ids = list.map((i) => i.id);
  assert.ok(!ids.includes('m1'), 'm1 应被 delete 隐藏');
  assert.ok(ids.includes('m2'), 'm2 仍在');
  assert.ok(ids.includes('local'), '本地 create 应出现');
  const m2 = list.find((i) => i.id === 'm2');
  assert.equal(m2.title, '改过的2');
  // local 应排在最前（updated_at 最大）
  assert.equal(list[0].id, 'local');
});

ok('pull 后本地未同步想法不会消失', () => {
  const pullIdeas = [{ id: 'server1', title: '服务端', content: '', updated_at: t(0) }];
  const outbox = [{
    id: 'offline1',
    op: 'create',
    payload: { id: 'offline1', title: '离线想法', content: '还没同步', updated_at: t(30) },
    confirmed: false,
  }];
  const list = mergeDisplayItems(pullIdeas, outbox);
  assert.equal(list.length, 2);
  assert.ok(list.some((i) => i.id === 'offline1'));
  assert.ok(list.some((i) => i.id === 'server1'));
});

ok('toPushPayload 形状正确', () => {
  const p = toPushPayload({
    id: 'p1',
    op: 'update',
    payload: { title: 'T', content: 'C' },
    base_updated_at: '2026-02-26T08:00:00.000Z',
    origin: 'mobile',
  });
  assert.equal(p.id, 'p1');
  assert.equal(p.op, 'update');
  assert.equal(p.title, 'T');
  assert.equal(p.content, 'C');
  assert.equal(p.base_updated_at, '2026-02-26T08:00:00.000Z');
});

console.log(passed ? `\n✓ ${passed} 项同步逻辑断言通过` : '\n✗ 没有通过的断言');
if (process.exitCode) {
  console.error('✗ 同步逻辑测试失败');
} else {
  process.exit(0);
}
