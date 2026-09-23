import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedactingLogger, redactSensitive } from '../src/logging.js';
import { createMemoryCheckpointStore, createRecoveryService } from '../src/recovery.js';

test('redactSensitive 深拷贝并替换敏感字段，原对象不变', () => {
  const record = {
    record_id: 'B-1',
    supplier: {
      supplier_id: 'SUP-1',
      supplier_name: '某制药有限公司',
      contact_phone: '13800000000',
    },
    lines: [{ contact_email: 'sales@example.com' }],
  };
  const safe = redactSensitive(record);

  assert.equal(safe.record_id, 'B-1');
  assert.equal(safe.supplier.supplier_id, 'SUP-1');
  assert.equal(safe.supplier.supplier_name, '***');
  assert.equal(safe.supplier.contact_phone, '***');
  assert.equal(safe.lines[0].contact_email, '***');
  assert.equal(record.supplier.supplier_name, '某制药有限公司', '原对象不被修改');
});

test('恢复链普通日志不出现供应商敏感字段', async () => {
  const lines = [];
  const logger = createRedactingLogger({ sink: (line) => lines.push(line) });
  const store = createMemoryCheckpointStore();
  const service = createRecoveryService({ store, logger });

  const text = JSON.stringify({
    schema_version: 1,
    file_id: 'file-log',
    records: [
      {
        record_id: 'B-1',
        declaration_type: 'batch',
        drug_code: 'D-100',
        quantity: '很多', // 触发隔离日志，隔离日志会携带整条记录
        occurred_at: '2026-09-20T09:00:00+08:00',
        supplier: {
          supplier_id: 'SUP-1',
          supplier_name: '某制药有限公司',
          contact_phone: '13800000000',
          supplier_address: '某市某区某路 1 号',
        },
      },
    ],
  });
  const result = await service.recoverFile({ name: 'decl-log.json', text });
  assert.equal(result.quarantine.length, 1);

  const output = lines.join('\n');
  assert.ok(lines.length > 0, '恢复过程应当产生日志');
  for (const sensitive of ['某制药有限公司', '13800000000', '某市某区某路 1 号', 'sales@example.com']) {
    assert.ok(!output.includes(sensitive), `日志不得出现敏感内容: ${sensitive}`);
  }
  // 可追踪的技术标识仍然保留
  assert.match(output, /B-1/);
  assert.match(output, /invalid_field_shape/);
  const quarantined = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === 'record_quarantined');
  assert.equal(quarantined.record.supplier.supplier_name, '***');
});
