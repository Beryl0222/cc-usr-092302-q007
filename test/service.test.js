import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureLogs } from './log_capture.js';

import {
  ContentConflictError,
  FsCheckpointStore,
  STATUS_PAUSED_CONFLICT,
  STATUS_READY,
  STATUS_UNSUPPORTED,
  UnsupportedVersionError,
} from '../src/checkpoint.js';
import { SupplyCollaborationService } from '../src/service.js';

const master = (recordId, batchNo) => ({
  record_id: recordId,
  record_type: 'batch_master',
  payload: { batch_no: batchNo, supplier_name: '华北某供应商机密', phone: '13800000000' },
});
const detail = (recordId, batchNo) => ({
  record_id: recordId,
  record_type: 'batch_detail',
  payload: { batch_no: batchNo, quantity_shipped: 100 },
});

/** 乱序文件：明细先出现、主记录后出现；另含一条缺失批次与一个坏行。 */
function mixedFile() {
  return [
    JSON.stringify(detail('D1', 'LOT-1')), // index 0：先明细
    JSON.stringify(master('B1', 'LOT-1')), // index 1：后主记录
    JSON.stringify(detail('D2', 'LOT-GONE')), // index 2：确实缺失关系
    '{not json', // index 3：错误字段形状
  ].join('\n');
}

async function makeHarness() {
  const dir = await mkdtemp(join(tmpdir(), 'supply-cp-'));
  const preserveDir = join(dir, 'preserved');
  const store = new FsCheckpointStore(join(dir, 'checkpoints'));
  return { dir, preserveDir, store };
}

function makeService(store, preserveDir, hooks = {}, sink = []) {
  const persisted = hooks.persisted ?? [];
  const notified = hooks.notified ?? [];
  const persistRecord = hooks.persistRecord ?? (async (entry) => persisted.push(entry.record.record_id));
  const sendNotification = hooks.sendNotification ?? (async (entry) => notified.push(entry.record.record_id));
  const service = new SupplyCollaborationService({
    store,
    preserveDir,
    persistRecord,
    sendNotification,
    onEntryPersisted: hooks.onEntryPersisted,
    onEntryCommitted: hooks.onEntryCommitted,
    now: () => '2026-09-23T10:00:00.000Z',
    logger: captureLogs(sink),
  });
  return { service, persisted, notified };
}

test('端到端：乱序明细正常关联，部分不合规时合法申报进入待提交集合', async () => {
  const { store, preserveDir } = await makeHarness();
  const { service, persisted, notified } = makeService(store, preserveDir);

  const result = await service.processFile({ fileId: 'F1.ndjson', rawText: mixedFile() });

  assert.equal(result.status, STATUS_READY);
  assert.deepEqual(persisted, ['D1', 'B1']);
  assert.deepEqual(notified, ['D1', 'B1']); // 通知恰好一次
  assert.deepEqual(result.persisted, [0, 1]);
  assert.equal(result.quarantine.length, 2);
  assert.deepEqual(
    result.reports.missingRelations.map((r) => r.record_id),
    ['D2'],
  );
  assert.equal(result.reports.malformedShapes.length, 1);
});

test('相同文件重试：只返回既有结果，不重复持久化也不重复发送通知', async () => {
  const { store, preserveDir } = await makeHarness();
  const { service, persisted, notified } = makeService(store, preserveDir);
  const raw = mixedFile();

  const first = await service.processFile({ fileId: 'F1.ndjson', rawText: raw });
  // 用全新的副作用收集器重试：不应观察到任何新的持久化或通知调用。
  const replay = makeService(store, preserveDir);
  const again = await replay.service.processFile({ fileId: 'F1.ndjson', rawText: raw });

  assert.deepEqual(again, first);
  assert.equal(replay.persisted.length, 0, '重试不得再次持久化');
  assert.equal(replay.notified.length, 0, '重试不得再次发送通知');
  assert.deepEqual(persisted, ['D1', 'B1']);
  assert.deepEqual(notified, ['D1', 'B1']);
});

test('停机恢复 A：持久化之前崩溃，重放后全部成功且通知不重复', async () => {
  const { store, preserveDir } = await makeHarness();
  const persisted = [];
  const notified = [];

  const crashBeforePersist = async () => {
    throw new Error('SIMULATED CRASH before persist');
  };
  const crashed = makeService(store, preserveDir, {
    persisted,
    notified,
    persistRecord: crashBeforePersist,
  }).service;
  await assert.rejects(
    crashed.processFile({ fileId: 'F1.ndjson', rawText: mixedFile() }),
    /SIMULATED CRASH/,
  );

  const { service } = makeService(store, preserveDir, { persisted, notified });
  const result = await service.processFile({ fileId: 'F1.ndjson', rawText: mixedFile() });
  assert.equal(result.status, STATUS_READY);
  assert.deepEqual(persisted, ['D1', 'B1']);
  assert.deepEqual(notified, ['D1', 'B1']);
  // 再重放一次仍无副作用
  const replay = makeService(store, preserveDir);
  await replay.service.processFile({ fileId: 'F1.ndjson', rawText: mixedFile() });
  assert.equal(replay.persisted.length, 0);
  assert.equal(replay.notified.length, 0);
});

test('停机恢复 B：崩溃在持久化登记后、通知前，恢复只补通知不重复持久化', async () => {
  const { store, preserveDir } = await makeHarness();
  const persisted = [];
  const notified = [];

  // D1 已持久化并登记检查点，通知尚未发生时停机。
  const crashed = makeService(store, preserveDir, {
    persisted,
    notified,
    onEntryPersisted: async (entry) => {
      if (entry.record.record_id === 'D1') {
        throw new Error('SIMULATED CRASH after D1 persist, before notify');
      }
    },
  }).service;
  await assert.rejects(
    crashed.processFile({ fileId: 'F1.ndjson', rawText: mixedFile() }),
    /SIMULATED CRASH/,
  );
  assert.deepEqual(persisted, ['D1']);
  assert.deepEqual(notified, []);

  const recovery = makeService(store, preserveDir, { persisted, notified });
  const result = await recovery.service.processFile({ fileId: 'F1.ndjson', rawText: mixedFile() });
  assert.equal(result.status, STATUS_READY);
  assert.equal(result.resumed, true);
  // D1 不重复持久化；通知对两条各发一次，顺序不重复。
  assert.deepEqual(persisted, ['D1', 'B1']);
  assert.deepEqual(notified, ['D1', 'B1']);
});

test('停机恢复 C：崩溃在通知登记后，恢复时持久化与通知都不重复', async () => {
  const { store, preserveDir } = await makeHarness();
  const persisted = [];
  const notified = [];

  // D1 的持久化与通知均已完成并登记，随后停机。
  const crashed = makeService(store, preserveDir, {
    persisted,
    notified,
    onEntryCommitted: async (entry) => {
      if (entry.record.record_id === 'D1') {
        throw new Error('SIMULATED CRASH after D1 notify');
      }
    },
  }).service;
  await assert.rejects(
    crashed.processFile({ fileId: 'F1.ndjson', rawText: mixedFile() }),
    /SIMULATED CRASH/,
  );
  assert.deepEqual(persisted, ['D1']);
  assert.deepEqual(notified, ['D1']);

  const recovery = makeService(store, preserveDir, { persisted, notified });
  const result = await recovery.service.processFile({ fileId: 'F1.ndjson', rawText: mixedFile() });
  assert.equal(result.status, STATUS_READY);
  // D1 两者都不重复，只补齐 B1。
  assert.deepEqual(persisted, ['D1', 'B1']);
  assert.deepEqual(notified, ['D1', 'B1']);
  assert.deepEqual(result.persisted, [0, 1]);
  assert.deepEqual(result.notifications, ['D1', 'B1']);
});

test('内容冲突：同名文件内容变化时暂停并保留原文，不产生任何副作用', async () => {
  const { store, preserveDir } = await makeHarness();
  const { service, persisted, notified } = makeService(store, preserveDir);
  const raw1 = mixedFile();
  await service.processFile({ fileId: 'F1.ndjson', rawText: raw1 });

  const changed = raw1.replace('LOT-GONE', 'LOT-CHANGED');
  await assert.rejects(
    service.processFile({ fileId: 'F1.ndjson', rawText: changed }),
    (error) => error instanceof ContentConflictError && error.previousHash !== error.currentHash,
  );

  const cp = JSON.parse(await readFile(store.pathFor('F1.ndjson'), 'utf8'));
  assert.equal(cp.status, STATUS_PAUSED_CONFLICT);
  assert.ok(cp.conflict.preserved_incoming_raw);
  const files = await readdir(preserveDir);
  assert.equal(files.length, 1);
  const preserved = await readFile(join(preserveDir, files[0]), 'utf8');
  assert.equal(preserved, changed, '来文必须逐字保留供人工比较');
  assert.deepEqual(persisted, ['D1', 'B1']); // 冲突文件未触发新副作用
  assert.deepEqual(notified, ['D1', 'B1']);
});

test('版本超出支持范围：保留原文、落检查点、不猜测解析', async () => {
  const { store, preserveDir } = await makeHarness();
  const { service, persisted, notified } = makeService(store, preserveDir);
  const future = JSON.stringify({
    schema_version: 2,
    file_id: 'F2',
    records: [master('B1', 'LOT-1')],
  });

  await assert.rejects(
    service.processFile({ fileId: 'future.ndjson', rawText: future }),
    (error) => error instanceof UnsupportedVersionError && error.declared === 2,
  );
  const cp = JSON.parse(await readFile(store.pathFor('future.ndjson'), 'utf8'));
  assert.equal(cp.status, STATUS_UNSUPPORTED);
  const files = await readdir(preserveDir);
  assert.equal((await readFile(join(preserveDir, files[0]), 'utf8')), future);
  assert.deepEqual(persisted, []);
  assert.deepEqual(notified, []);
});

test('隔离修正携带原位置重新并入（端到端修正缺失批次关系）', async () => {
  const { store, preserveDir } = await makeHarness();

  // 主记录因字段形状错误被隔离，先出现的明细被判缺失关系。
  const raw = [
    JSON.stringify(detail('D1', 'LOT-9')), // index 0
    JSON.stringify({ record_id: 'B9', record_type: 'batch_master', payload: {} }), // index 1
  ].join('\n');

  const { service: firstRun, persisted, notified } = makeService(store, preserveDir);
  const first = await firstRun.processFile({ fileId: 'F3.ndjson', rawText: raw });
  assert.equal(first.persisted.length, 0);
  assert.equal(first.quarantine.length, 2);

  const { service: fixedRun } = makeService(store, preserveDir, { persisted, notified });
  const fixed = await fixedRun.processFile({
    fileId: 'F3.ndjson',
    rawText: raw,
    corrections: { q1: master('B9', 'LOT-9') },
  });
  assert.equal(fixed.status, STATUS_READY);
  assert.deepEqual(persisted.map((r) => r), ['D1', 'B9']);
  assert.equal(fixed.quarantine.length, 0);
  assert.equal(fixed.associations[0].details[0].order, 'detail_first');
});

test('普通日志不出现供应商敏感字段与业务原文', async () => {
  const { store, preserveDir } = await makeHarness();
  const sink = [];
  const { service } = makeService(store, preserveDir, {}, sink);
  await service.processFile({ fileId: 'F4.ndjson', rawText: mixedFile() });

  const blob = JSON.stringify(sink);
  assert.ok(!blob.includes('华北某供应商机密'), '供应商名称不得出现在日志');
  assert.ok(!blob.includes('13800000000'), '电话不得出现在日志');
  assert.ok(!blob.includes('{not json'), '业务原文不得出现在普通日志');
  assert.ok(blob.includes('record_id'), '非敏感追踪字段应保留');
});
