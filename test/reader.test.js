import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUPPORTED_SCHEMA_VERSION,
  extractEntries,
  hashRaw,
} from '../src/reader.js';

test('NDJSON：按原始顺序保留每条记录的 index 与 1 基行号，空行允许', () => {
  const raw = [
    JSON.stringify({ record_id: 'B1', record_type: 'batch_master', payload: { batch_no: 'L1' } }),
    '',
    JSON.stringify({ record_id: 'D1', record_type: 'batch_detail', payload: { batch_no: 'L1' } }),
  ].join('\n');

  const { entries, envelope } = extractEntries(raw);
  assert.equal(envelope, null);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => [e.index, e.line, e.record.record_id]),
    [[0, 1, 'B1'], [1, 3, 'D1']],
  );
});

test('NDJSON：非法行以错误条目保留在同一序列中，位置可追踪', () => {
  const raw = ['{broken', JSON.stringify({ record_id: 'B1', record_type: 'batch_master', payload: { batch_no: 'L1' } })].join('\n');
  const { entries } = extractEntries(raw);
  assert.equal(entries[0].ok, false);
  assert.equal(entries[0].index, 0);
  assert.equal(entries[0].line, 1);
  assert.match(entries[0].reason, /JSON/);
  assert.equal(entries[1].ok, true);
  assert.deepEqual([entries[1].index, entries[1].line], [1, 2]);
});

test('批式信封：records 数组逐条保留 index；版本超限抛 unsupported_version 并带原文', () => {
  const raw = JSON.stringify({
    schema_version: 1,
    file_id: 'F1',
    records: [
      { record_id: 'B1', record_type: 'batch_master', payload: { batch_no: 'L1' } },
      { record_id: 'D1', record_type: 'batch_detail', payload: { batch_no: 'L1' } },
    ],
  });
  const { entries, envelope } = extractEntries(raw);
  assert.equal(envelope.file_id, 'F1');
  assert.deepEqual(entries.map((e) => e.index), [0, 1]);
  assert.equal(entries[0].line, null);

  const future = JSON.stringify({ schema_version: 99, file_id: 'F2', records: [] });
  assert.throws(
    () => extractEntries(future),
    (error) =>
      error.kind === 'unsupported_version' &&
      error.declared === 99 &&
      error.supported === SUPPORTED_SCHEMA_VERSION &&
      error.raw === future,
  );
});

test('信封内畸形记录保留为错误条目而非整文件失败', () => {
  const raw = JSON.stringify({
    schema_version: 1,
    records: [{ record_type: 'batch_master', payload: {} }],
  });
  const { entries } = extractEntries(raw);
  assert.equal(entries[0].ok, false);
  assert.equal(entries[0].index, 0);
});

test('NDJSON 中记录声明更高版本时整文件闸门触发，原文随异常返回', () => {
  const raw = [
    JSON.stringify({
      schema_version: 2,
      record_id: 'X',
      record_type: 'batch_master',
      payload: { batch_no: 'L1' },
    }),
  ].join('\n');
  assert.throws(
    () => extractEntries(raw),
    (error) => error.kind === 'unsupported_version' && error.raw === raw,
  );
});

test('内容指纹随原文变化而变化，重放同一字节得到相同指纹', () => {
  const a = '{"a":1}\n';
  const b = '{"a":2}\n';
  assert.equal(hashRaw(a), hashRaw(a));
  assert.notEqual(hashRaw(a), hashRaw(b));
});
