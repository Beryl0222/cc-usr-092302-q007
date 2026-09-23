import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECKPOINT_STATES,
  createMemoryCheckpointStore,
  createRecoveryService,
} from '../src/recovery.js';
import { ISSUE_CATEGORIES } from '../src/declaration.js';

function makeBatch(id, extra = {}) {
  return {
    record_id: id,
    declaration_type: 'batch',
    drug_code: 'D-100',
    quantity: 500,
    occurred_at: '2026-09-20T09:00:00+08:00',
    supplier: { supplier_id: 'SUP-1', supplier_name: '某制药有限公司', contact_phone: '13800000000' },
    ...extra,
  };
}

function makeDetail(id, batchId, extra = {}) {
  return {
    record_id: id,
    declaration_type: 'detail',
    batch_record_id: batchId,
    drug_code: 'D-100',
    quantity: 50,
    occurred_at: '2026-09-20T09:30:00+08:00',
    ...extra,
  };
}

function makeFileText(records, { version = 1, fileId = 'file-1' } = {}) {
  return JSON.stringify({ schema_version: version, file_id: fileId, records });
}

/** 记录每次调用的持久化/通知桩，failOnCall 用于模拟停机。 */
function createSink({ failOnCall } = {}) {
  const calls = [];
  let count = 0;
  const fn = async (arg) => {
    count += 1;
    if (count === failOnCall) {
      throw new Error('模拟停机');
    }
    calls.push(arg);
  };
  return { fn, calls };
}

test('相同文件重试只返回既有结果，不重复持久化也不重复通知', async () => {
  const store = createMemoryCheckpointStore();
  const persist = createSink();
  const notify = createSink();
  const service = createRecoveryService({ store, persist: persist.fn, notify: notify.fn });
  const text = makeFileText([makeDetail('D-1', 'B-1'), makeBatch('B-1')]);

  const first = await service.recoverFile({ name: 'decl-1.json', text });
  assert.equal(first.status, 'completed');
  assert.equal(persist.calls.length, 2);
  assert.equal(notify.calls.length, 1, '每个批次只发一条入库通知');

  const second = await service.recoverFile({ name: 'decl-1.json', text });
  assert.deepEqual(second, first);
  assert.equal(persist.calls.length, 2, '重试不再持久化');
  assert.equal(notify.calls.length, 1, '重试不再发送入库通知');

  const checkpoint = await store.load('decl-1.json');
  assert.equal(checkpoint.state, CHECKPOINT_STATES.COMPLETED);
  assert.deepEqual(checkpoint.persistedRecordIds.sort(), ['B-1', 'D-1']);
  assert.deepEqual(checkpoint.notifications.map((n) => n.notificationId), ['inbound:file-1:B-1']);
});

test('持久化之前停机：重放时从未完成的记录继续，不重复已持久化部分', async () => {
  const store = createMemoryCheckpointStore();
  const text = makeFileText([makeBatch('B-1'), makeBatch('B-2'), makeDetail('D-1', 'B-2')]);

  // 第一次运行：第二条记录持久化时停机
  const crashPersist = createSink({ failOnCall: 2 });
  const firstService = createRecoveryService({ store, persist: crashPersist.fn, notify: createSink().fn });
  await assert.rejects(firstService.recoverFile({ name: 'decl-2.json', text }), /模拟停机/);

  const midway = await store.load('decl-2.json');
  assert.equal(midway.state, CHECKPOINT_STATES.PROCESSING);
  assert.deepEqual(midway.persistedRecordIds, ['B-1'], '停机前已持久化的记录被检查点记住');

  // 第二个服务实例用同一检查点仓库恢复
  const persist = createSink();
  const notify = createSink();
  const resumed = createRecoveryService({ store, persist: persist.fn, notify: notify.fn });
  const result = await resumed.recoverFile({ name: 'decl-2.json', text });

  assert.equal(result.status, 'completed');
  assert.deepEqual(
    persist.calls.map((record) => record.record_id),
    ['B-2', 'D-1'],
    '只补持久化停机时未完成的记录',
  );
  assert.deepEqual(result.persistedRecordIds.sort(), ['B-1', 'B-2', 'D-1']);
  assert.equal(notify.calls.length, 2);
});

test('持久化之后、通知发出前停机：重放只补发通知，不重复持久化', async () => {
  const store = createMemoryCheckpointStore();
  const text = makeFileText([makeBatch('B-1'), makeBatch('B-2')]);

  // 第一次运行：持久化全部完成，第一条通知发出前停机
  const crashNotify = createSink({ failOnCall: 1 });
  const firstPersist = createSink();
  const firstService = createRecoveryService({ store, persist: firstPersist.fn, notify: crashNotify.fn });
  await assert.rejects(firstService.recoverFile({ name: 'decl-3.json', text }), /模拟停机/);

  const midway = await store.load('decl-3.json');
  assert.deepEqual(midway.persistedRecordIds.sort(), ['B-1', 'B-2']);
  assert.equal(midway.notifications.length, 0);

  const persist = createSink();
  const notify = createSink();
  const resumed = createRecoveryService({ store, persist: persist.fn, notify: notify.fn });
  const result = await resumed.recoverFile({ name: 'decl-3.json', text });

  assert.equal(result.status, 'completed');
  assert.equal(persist.calls.length, 0, '已持久化的记录不再重复持久化');
  assert.deepEqual(
    notify.calls.map((n) => n.notificationId),
    ['inbound:file-1:B-1', 'inbound:file-1:B-2'],
    '每条入库通知只发一次',
  );
});

test('通知发到一半停机：重放只补发未发出的通知', async () => {
  const store = createMemoryCheckpointStore();
  const text = makeFileText([makeBatch('B-1'), makeBatch('B-2'), makeBatch('B-3')]);

  const crashNotify = createSink({ failOnCall: 2 });
  const firstService = createRecoveryService({ store, persist: createSink().fn, notify: crashNotify.fn });
  await assert.rejects(firstService.recoverFile({ name: 'decl-4.json', text }), /模拟停机/);

  const midway = await store.load('decl-4.json');
  assert.deepEqual(midway.notifications.map((n) => n.recordId), ['B-1']);

  const notify = createSink();
  const resumed = createRecoveryService({ store, persist: createSink().fn, notify: notify.fn });
  const result = await resumed.recoverFile({ name: 'decl-4.json', text });

  assert.deepEqual(
    notify.calls.map((n) => n.recordId),
    ['B-2', 'B-3'],
    '已发出的通知不重复，只补发剩余部分',
  );
  assert.deepEqual(result.notifications.map((n) => n.recordId), ['B-1', 'B-2', 'B-3']);
});

test('同名文件内容变化时暂停并交由人工比较', async () => {
  const store = createMemoryCheckpointStore();
  const persist = createSink();
  const notify = createSink();
  const service = createRecoveryService({ store, persist: persist.fn, notify: notify.fn });

  const original = makeFileText([makeBatch('B-1')]);
  const first = await service.recoverFile({ name: 'decl-5.json', text: original });
  assert.equal(first.status, 'completed');

  const changed = makeFileText([makeBatch('B-1'), makeBatch('B-2')]);
  const conflict = await service.recoverFile({ name: 'decl-5.json', text: changed });
  assert.equal(conflict.status, 'conflict');
  assert.notEqual(conflict.expectedHash, conflict.receivedHash);
  assert.deepEqual(conflict.persistedRecordIds, ['B-1'], '人工比较时能看到既有持久化结果');
  assert.equal(persist.calls.length, 1, '冲突文件不产生新副作用');
  assert.equal(notify.calls.length, 1);

  const checkpoint = await store.load('decl-5.json');
  assert.equal(checkpoint.state, CHECKPOINT_STATES.PAUSED_CONFLICT);
  assert.equal(checkpoint.conflict.receivedText, changed, '新原文留档供人工比较');

  // 暂停期间重放新旧内容都只会得到冲突状态
  const again = await service.recoverFile({ name: 'decl-5.json', text: original });
  assert.equal(again.status, 'conflict');

  // 人工比较后决定保留原结果
  const resolved = await service.resolveConflict('decl-5.json', { action: 'keep_original' });
  assert.equal(resolved.status, 'completed');
  assert.deepEqual(resolved.persistedRecordIds, ['B-1']);
});

test('人工比较后可选择以新原文重新处理', async () => {
  const store = createMemoryCheckpointStore();
  const persist = createSink();
  const notify = createSink();
  const service = createRecoveryService({ store, persist: persist.fn, notify: notify.fn });

  await service.recoverFile({ name: 'decl-6.json', text: makeFileText([makeBatch('B-1')]) });
  const changed = makeFileText([makeBatch('B-9')], { fileId: 'file-2' });
  const conflict = await service.recoverFile({ name: 'decl-6.json', text: changed });
  assert.equal(conflict.status, 'conflict');

  const reprocessed = await service.resolveConflict('decl-6.json', { action: 'reprocess', text: changed });
  assert.equal(reprocessed.status, 'completed');
  assert.deepEqual(reprocessed.persistedRecordIds, ['B-9']);
  assert.deepEqual(reprocessed.notifications.map((n) => n.notificationId), ['inbound:file-2:B-9']);
});

test('隔离项修正后携带原位置重新并入，并照常持久化与通知', async () => {
  const store = createMemoryCheckpointStore();
  const persist = createSink();
  const notify = createSink();
  const service = createRecoveryService({ store, persist: persist.fn, notify: notify.fn });

  const text = makeFileText([
    makeBatch('B-1', { quantity: '很多' }), // 0 形状错误
    makeDetail('D-1', 'B-1'),               // 1 批次被隔离
    makeBatch('B-2'),                       // 2 合法
  ]);
  const first = await service.recoverFile({ name: 'decl-7.json', text });
  assert.equal(first.status, 'completed');
  assert.deepEqual(first.pending.map((item) => item.recordId), ['B-2']);
  assert.equal(first.quarantine.length, 2);
  assert.equal(
    first.quarantine.find((item) => item.index === 0).category,
    ISSUE_CATEGORIES.INVALID_FIELD_SHAPE,
  );

  const corrected = await service.applyCorrections('decl-7.json', [
    { index: 0, record: makeBatch('B-1') },
    { index: 1, record: makeDetail('D-1', 'B-1') },
  ]);
  assert.equal(corrected.quarantine.length, 0);
  assert.deepEqual(
    corrected.pending.map((item) => [item.index, item.recordId]),
    [[0, 'B-1'], [1, 'D-1'], [2, 'B-2']],
    '修正项携带原始位置并入，待提交集合按原顺序排列',
  );
  assert.deepEqual(corrected.associations, [
    { detailIndex: 1, detailRecordId: 'D-1', batchIndex: 0, batchRecordId: 'B-1' },
  ]);
  assert.deepEqual(
    persist.calls.map((record) => record.record_id),
    ['B-2', 'B-1', 'D-1'],
    '修正并入的记录照常持久化，已持久化的不重复',
  );
  assert.deepEqual(
    notify.calls.map((n) => n.recordId),
    ['B-2', 'B-1'],
    '修正并入的批次补发入库通知',
  );
});

test('版本超出支持范围的文件保留原文且不产生副作用', async () => {
  const store = createMemoryCheckpointStore();
  const persist = createSink();
  const notify = createSink();
  const service = createRecoveryService({ store, persist: persist.fn, notify: notify.fn });

  const text = makeFileText([makeBatch('B-1')], { version: 99 });
  const result = await service.recoverFile({ name: 'decl-8.json', text });

  assert.equal(result.status, 'unsupported_version');
  assert.equal(result.schemaVersion, 99);
  assert.equal(result.rawText, text, '原文完整保留');
  assert.equal(persist.calls.length, 0);
  assert.equal(notify.calls.length, 0);

  // 同一文件重试也只返回既有结果
  const again = await service.recoverFile({ name: 'decl-8.json', text });
  assert.deepEqual(again, result);
});
