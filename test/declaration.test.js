import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeDeclarations,
  CorrectionRejectedError,
  ISSUE_CATEGORIES,
  parseDeclarationFile,
  reintegrateDeclaration,
} from '../src/declaration.js';

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

function scan(records, options) {
  const parsed = parseDeclarationFile(makeFileText(records, options));
  assert.equal(parsed.kind, 'parsed');
  return analyzeDeclarations(parsed.entries);
}

test('先明细后批次的乱序申报在整份文件结束时完成关联', () => {
  const records = [makeDetail('D-1', 'B-1'), makeDetail('D-2', 'B-1'), makeBatch('B-1')];
  const result = scan(records);

  assert.equal(result.quarantine.length, 0);
  assert.equal(result.pending.length, 3);
  assert.deepEqual(
    result.pending.map((item) => item.index),
    [0, 1, 2],
    '待提交集合保留原始顺序索引',
  );
  assert.deepEqual(result.associations, [
    { detailIndex: 0, detailRecordId: 'D-1', batchIndex: 2, batchRecordId: 'B-1' },
    { detailIndex: 1, detailRecordId: 'D-2', batchIndex: 2, batchRecordId: 'B-1' },
  ]);
});

test('重复标识、未知类型、缺失批次、错误形状分开报告且互不影响合法申报', () => {
  const records = [
    makeBatch('B-1'),                                     // 0 合法
    makeDetail('D-1', 'B-1'),                             // 1 合法
    makeBatch('B-2'),                                     // 2 重复标识
    makeDetail('D-2', 'B-2'),                             // 3 引用了被隔离的批次
    { ...makeBatch('B-2'), quantity: 600 },               // 4 重复标识
    makeBatch('B-3', { declaration_type: 'transfer' }),   // 5 未知申报类型
    makeDetail('D-3', 'B-404'),                           // 6 确实缺失批次
    makeBatch('B-4', { quantity: '很多' }),               // 7 错误字段形状
  ];
  const result = scan(records);

  const byCategory = (category) => result.issues.filter((issue) => issue.category === category);
  assert.equal(byCategory(ISSUE_CATEGORIES.DUPLICATE_IDENTIFIER).length, 1);
  assert.equal(byCategory(ISSUE_CATEGORIES.UNKNOWN_DECLARATION_TYPE).length, 1);
  assert.equal(byCategory(ISSUE_CATEGORIES.MISSING_BATCH_RELATION).length, 2);
  assert.equal(byCategory(ISSUE_CATEGORIES.INVALID_FIELD_SHAPE).length, 1);

  // 部分记录不合规时，合法申报仍进入待提交集合
  assert.deepEqual(
    result.pending.map((item) => item.recordId),
    ['B-1', 'D-1'],
  );
  // 隔离项按原始位置排序，类别可区分
  assert.deepEqual(
    result.quarantine.map((item) => [item.index, item.category]),
    [
      [2, ISSUE_CATEGORIES.DUPLICATE_IDENTIFIER],
      [3, ISSUE_CATEGORIES.MISSING_BATCH_RELATION],
      [4, ISSUE_CATEGORIES.DUPLICATE_IDENTIFIER],
      [5, ISSUE_CATEGORIES.UNKNOWN_DECLARATION_TYPE],
      [6, ISSUE_CATEGORIES.MISSING_BATCH_RELATION],
      [7, ISSUE_CATEGORIES.INVALID_FIELD_SHAPE],
    ],
  );
  // 引用被隔离批次的明细，原因可解释
  const orphan = result.quarantine.find((item) => item.index === 3);
  assert.match(orphan.message, /已因重复标识被隔离/);
});

test('同一记录号出现两次时报告全部可追踪位置', () => {
  const records = [makeBatch('B-1'), makeDetail('D-1', 'B-1'), makeBatch('B-1', { quantity: 700 })];
  const result = scan(records);

  const duplicate = result.issues.find((issue) => issue.category === ISSUE_CATEGORIES.DUPLICATE_IDENTIFIER);
  assert.equal(duplicate.recordId, 'B-1');
  assert.deepEqual(duplicate.indexes, [0, 2]);
  assert.match(duplicate.message, /位置: 0, 2/);
  // 两次出现都被隔离，等待人工确认哪一条有效
  assert.deepEqual(
    result.quarantine.filter((item) => item.recordId === 'B-1').map((item) => item.index),
    [0, 2],
  );
  // 引用被隔离批次的明细也无法关联
  assert.equal(result.pending.length, 0);
});

test('版本超出支持范围的文件保留原文，不做猜测解析', () => {
  const text = makeFileText([makeBatch('B-1')], { version: 99 });
  const parsed = parseDeclarationFile(text);

  assert.equal(parsed.kind, 'unsupported_version');
  assert.equal(parsed.schemaVersion, 99);
  assert.equal(parsed.rawText, text, '原文必须完整保留');
});

test('缺少版本号的文件同样保留原文', () => {
  const text = JSON.stringify({ records: [makeBatch('B-1')] });
  const parsed = parseDeclarationFile(text);
  assert.equal(parsed.kind, 'unsupported_version');
  assert.equal(parsed.schemaVersion, null);
  assert.equal(parsed.rawText, text);
});

test('修正后的隔离项携带原位置重新并入待提交集合', () => {
  const records = [
    makeBatch('B-1', { quantity: '很多' }), // 0 形状错误，修正后并入
    makeDetail('D-1', 'B-1'),               // 1 批次被隔离而缺失关联
    makeBatch('B-9'),                       // 2 合法批次
  ];
  const first = scan(records);
  assert.equal(first.pending.length, 1);
  assert.equal(first.quarantine.length, 2);

  const fixedBatch = makeBatch('B-1');
  const afterBatch = reintegrateDeclaration(first, { index: 0, record: fixedBatch });
  assert.deepEqual(
    afterBatch.pending.map((item) => [item.index, item.recordId]),
    [[0, 'B-1'], [2, 'B-9']],
    '修正后的批次携带原位置 0 重新并入',
  );
  assert.equal(afterBatch.quarantine.length, 1);

  // 批次就位后，原样重报明细即可并入并补齐关联
  const afterDetail = reintegrateDeclaration(afterBatch, { index: 1, record: makeDetail('D-1', 'B-1') });
  assert.equal(afterDetail.quarantine.length, 0);
  assert.deepEqual(
    afterDetail.pending.map((item) => item.index),
    [0, 1, 2],
  );
  assert.deepEqual(afterDetail.associations, [
    { detailIndex: 1, detailRecordId: 'D-1', batchIndex: 0, batchRecordId: 'B-1' },
  ]);
});

test('不合规的修正被拒绝并指明问题类别', () => {
  const first = scan([makeBatch('B-1', { quantity: '很多' }), makeBatch('B-2')]);

  assert.throws(
    () => reintegrateDeclaration(first, { index: 0, record: makeBatch('B-1', { quantity: -1 }) }),
    (error) => error instanceof CorrectionRejectedError && error.category === ISSUE_CATEGORIES.INVALID_FIELD_SHAPE,
  );
  assert.throws(
    () => reintegrateDeclaration(first, { index: 0, record: makeBatch('B-2') }),
    (error) => error.category === ISSUE_CATEGORIES.DUPLICATE_IDENTIFIER,
  );
  assert.throws(
    () => reintegrateDeclaration(first, { index: 0, record: makeDetail('D-9', 'B-404') }),
    (error) => error.category === ISSUE_CATEGORIES.MISSING_BATCH_RELATION,
  );
  assert.throws(
    () => reintegrateDeclaration(first, { index: 7, record: makeBatch('B-7') }),
    /没有可并入的隔离项/,
  );
});
