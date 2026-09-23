import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ISSUE_DUPLICATE_ID,
  ISSUE_MALFORMED_SHAPE,
  ISSUE_MISSING_RELATION,
  ISSUE_UNKNOWN_TYPE,
  processEntries,
  reintegrate,
} from '../src/pipeline.js';

const master = (recordId, batchNo, extra = {}) => ({
  record_id: recordId,
  record_type: 'batch_master',
  payload: { batch_no: batchNo, supplier_name: '不应出现在普通日志的供应商', ...extra },
});
const detail = (recordId, batchNo) => ({
  record_id: recordId,
  record_type: 'batch_detail',
  payload: { batch_no: batchNo, quantity_shipped: 42 },
});
const ok = (index, record, line = index + 1) => ({ ok: true, index, line, record });

test('乱序关联：明细先于批次主记录出现，文件结束时正常关联且方向可解释', () => {
  const entries = [
    ok(0, detail('D1', 'LOT-1')), // 明细先出现
    ok(1, master('B1', 'LOT-1')), // 主记录后出现
  ];
  const result = processEntries(entries);

  assert.equal(result.quarantine.length, 0);
  assert.equal(result.reports.missingRelations.length, 0);
  assert.equal(result.pending.length, 2);
  const detailEntry = result.pending.find((e) => e.record.record_id === 'D1');
  assert.deepEqual(detailEntry.association.master, { index: 1, line: 2 });
  assert.deepEqual(detailEntry.association.detail, { index: 0, line: 1 });
  assert.equal(detailEntry.association.order, 'detail_first');

  const masterEntry = result.pending.find((e) => e.record.record_id === 'B1');
  assert.equal(masterEntry.association, null);
  // 待提交集合保持原始顺序
  assert.deepEqual(result.pending.map((e) => e.index), [0, 1]);
});

test('正常顺序：主记录先于明细时 order 为 master_first', () => {
  const result = processEntries([
    ok(0, master('B1', 'LOT-1')),
    ok(1, detail('D1', 'LOT-1')),
  ]);
  assert.equal(result.pending[1].association.order, 'master_first');
});

test('确实缺失批次关系：文件结束仍无主记录，明细被隔离且单独报告', () => {
  const result = processEntries([ok(0, detail('D1', 'LOT-X'))]);
  assert.equal(result.pending.length, 0);
  assert.equal(result.reports.missingRelations.length, 1);
  assert.deepEqual(result.reports.missingRelations[0], {
    index: 0,
    line: 1,
    record_id: 'D1',
    batch_no: 'LOT-X',
  });
  assert.equal(result.quarantine[0].category, ISSUE_MISSING_RELATION);
  assert.equal(result.quarantine[0].qid, 'q0');
});

test('重复标识：保留首次出现，重复项隔离，报告给出两个可追踪位置', () => {
  const result = processEntries([
    ok(0, master('B1', 'LOT-1')),
    ok(1, detail('D1', 'LOT-1')),
    ok(2, master('B1', 'LOT-1'), 3), // 同一 record_id 再次出现
  ]);

  assert.equal(result.reports.duplicates.length, 1);
  assert.deepEqual(result.reports.duplicates[0].first, { index: 0, line: 1 });
  assert.deepEqual(result.reports.duplicates[0].repeated, { index: 2, line: 3 });
  assert.equal(result.reports.duplicates[0].record_id, 'B1');

  assert.equal(result.quarantine.length, 1);
  assert.equal(result.quarantine[0].category, ISSUE_DUPLICATE_ID);
  assert.equal(result.quarantine[0].index, 2);
  // 合法记录照常进入待提交集合
  assert.deepEqual(result.pending.map((e) => e.record.record_id), ['B1', 'D1']);
});

test('未知申报类型单独分类，不影响合法申报', () => {
  const result = processEntries([
    ok(0, master('B1', 'LOT-1')),
    ok(1, { record_id: 'X1', record_type: 'stocktake', payload: { batch_no: 'LOT-1' } }),
    ok(2, detail('D1', 'LOT-1')),
  ]);
  assert.equal(result.reports.unknownTypes.length, 1);
  assert.equal(result.reports.unknownTypes[0].record_type, 'stocktake');
  assert.equal(result.quarantine[0].category, ISSUE_UNKNOWN_TYPE);
  assert.deepEqual(result.pending.map((e) => e.record.record_id), ['B1', 'D1']);
});

test('错误字段形状：非法 JSON 与字段缺失归入形状问题并保留原位置', () => {
  const entries = [
    { ok: false, index: 0, line: 1, reason: '记录不是合法 JSON', raw: '{broken' },
    ok(1, master('B1', 'LOT-1')),
    ok(2, { record_id: 'B2', record_type: 'batch_master', payload: {} }),
  ];
  const result = processEntries(entries);
  assert.equal(result.reports.malformedShapes.length, 2);
  assert.deepEqual(result.reports.malformedShapes.map((r) => r.index), [0, 2]);
  assert.equal(result.reports.malformedShapes[0].raw, '{broken');
  assert.deepEqual(result.quarantine.map((q) => q.category), [
    ISSUE_MALFORMED_SHAPE,
    ISSUE_MALFORMED_SHAPE,
  ]);
  assert.deepEqual(result.pending.map((e) => e.record.record_id), ['B1']);
});

test('隔离修正：修正形状错误的批次主记录后，先出现的明细自动重新关联并入', () => {
  // 明细先出现；主记录因缺少 batch_no 被隔离 —— 没有修正时是缺失关系。
  const first = processEntries([
    ok(0, detail('D1', 'LOT-9')),
    ok(1, { record_id: 'B9', record_type: 'batch_master', payload: {} }),
  ]);
  assert.equal(first.pending.length, 0);
  assert.equal(first.quarantine.length, 2); // 缺失关系的明细 + 形状错误的主记录

  const fixed = reintegrate(first, { q1: master('B9', 'LOT-9') });
  assert.equal(fixed.quarantine.length, 0);
  assert.deepEqual(fixed.pending.map((e) => e.record.record_id), ['D1', 'B9']);
  const detailEntry = fixed.pending.find((e) => e.record.record_id === 'D1');
  // 明细仍保留原位置，关联到修正后的主记录，乱序方向可解释
  assert.equal(detailEntry.index, 0);
  assert.deepEqual(detailEntry.association.master, { index: 1, line: 2 });
  assert.equal(detailEntry.association.order, 'detail_first');
});

test('隔离修正：未知类型修正为合法类型后重新并入；修正仍不合规则继续隔离', () => {
  const first = processEntries([
    ok(0, { record_id: 'X1', record_type: 'stocktake', payload: { batch_no: 'LOT-1' } }),
  ]);
  const stillBad = reintegrate(first, { q0: { record_id: 'X1', record_type: 'batch_master', payload: {} } });
  assert.equal(stillBad.pending.length, 0);
  assert.equal(stillBad.quarantine[0].category, ISSUE_MALFORMED_SHAPE);
  assert.equal(stillBad.quarantine[0].qid, 'q0');

  const fixed = reintegrate(first, { q0: master('X1', 'LOT-1') });
  assert.equal(fixed.quarantine.length, 0);
  assert.equal(fixed.pending[0].record.record_id, 'X1');
});

test('结果被冻结，管线行为为纯函数', () => {
  const result = processEntries([ok(0, master('B1', 'LOT-1'))]);
  assert.throws(() => {
    result.pending.push({});
  });
});
