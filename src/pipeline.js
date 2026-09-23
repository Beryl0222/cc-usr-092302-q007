/**
 * 申报记录的分类、乱序关联与隔离修正。
 *
 * 设计要点：
 *  - 每条记录在整份文件内的原始序号 index（0 基）和行号 line（1 基，
 *    NDJSON 模式）从读取阶段一直保留到待提交集合、隔离项和所有报告；
 *  - 明细与批次主记录的关联推迟到整份文件读取结束后统一进行，因此
 *    “先明细、后主记录”是正常情况，关联结果带有可解释的先后顺序；
 *  - 四类问题分开报告：错误字段形状 / 未知申报类型 / 重复标识 /
 *    文件结束时确实缺失的批次关系；
 *  - 部分记录不合规不影响其余合法申报进入待提交集合；隔离项可以携带
 *    原位置修正后重新并入。
 *
 * 本模块是纯函数，不做任何 IO，便于在测试中复现场景。
 */

export const RECORD_TYPE_BATCH_MASTER = 'batch_master';
export const RECORD_TYPE_BATCH_DETAIL = 'batch_detail';

/** 当前认识的申报类型；不在表内的记录进入“未知申报类型”。 */
export const KNOWN_RECORD_TYPES = Object.freeze(
  new Set([RECORD_TYPE_BATCH_MASTER, RECORD_TYPE_BATCH_DETAIL]),
);

/** 隔离项类别，与需求中的四类报告一一对应。 */
export const ISSUE_MALFORMED_SHAPE = 'malformed_shape';
export const ISSUE_UNKNOWN_TYPE = 'unknown_type';
export const ISSUE_DUPLICATE_ID = 'duplicate_identifier';
export const ISSUE_MISSING_RELATION = 'missing_relation';

function freeze(value) {
  return value === undefined ? value : Object.freeze(value);
}

/**
 * 处理读取器产出的条目序列。
 *
 * @param {ReadonlyArray<object>} entries reader.extractEntries 的 entries，
 *        元素形如 {ok:true,index,line,record} 或
 *        {ok:false,index,line,reason,raw}
 * @returns 冻结的批次结果：
 *   pending      可提交申报（保持原始顺序），明细带 association
 *   quarantine   隔离项（qid 稳定为 `q<index>`，携带原位置与原因）
 *   reports      四类问题各自的明细列表
 *   associations 批次关联说明（含乱序方向）
 */
export function processEntries(entries) {
  const seenIds = new Map(); // record_id -> 首次出现位置
  const duplicateRepeatedPositions = new Set(); // 被判重的后续位置 key
  const duplicateReports = [];
  const unknownReports = [];
  const shapeReports = [];
  const candidates = []; // 通过前三道检查的主记录/明细，等待文件末关联
  const quarantine = [];

  const quarantineIt = (item) => {
    quarantine.push(freeze({ qid: `q${item.index}`, ...item }));
  };

  for (const entry of entries) {
    if (!entry.ok) {
      const item = {
        index: entry.index,
        line: entry.line,
        category: ISSUE_MALFORMED_SHAPE,
        reason: entry.reason,
        record: null,
        raw: entry.raw,
      };
      shapeReports.push(freeze({ ...item }));
      quarantineIt(item);
      continue;
    }

    const { record, index, line } = entry;

    // 1) 重复标识：同一 record_id 在文件内再次出现。首次出现保留，
    //    后续出现隔离并同时记录两个可追踪位置。
    if (seenIds.has(record.record_id)) {
      const first = seenIds.get(record.record_id);
      duplicateReports.push(
        freeze({
          record_id: record.record_id,
          first: { index: first.index, line: first.line },
          repeated: { index, line },
        }),
      );
      duplicateRepeatedPositions.add(index);
      quarantineIt({
        index,
        line,
        category: ISSUE_DUPLICATE_ID,
        reason: `记录号 '${record.record_id}' 在文件内重复出现`,
        record,
        raw: null,
      });
      continue;
    }
    seenIds.set(record.record_id, { index, line });

    // 2) 未知申报类型。
    if (!KNOWN_RECORD_TYPES.has(record.record_type)) {
      unknownReports.push(
        freeze({
          index,
          line,
          record_id: record.record_id,
          record_type: record.record_type,
        }),
      );
      quarantineIt({
        index,
        line,
        category: ISSUE_UNKNOWN_TYPE,
        reason: `未知申报类型 '${record.record_type}'`,
        record,
        raw: null,
      });
      continue;
    }

    // 3) 类型相关的字段形状检查。
    const shapeError = validateKnownShape(record);
    if (shapeError) {
      const item = {
        index,
        line,
        category: ISSUE_MALFORMED_SHAPE,
        reason: shapeError,
        record,
        raw: null,
      };
      shapeReports.push(freeze({ ...item }));
      quarantineIt(item);
      continue;
    }

    candidates.push({ index, line, record });
  }

  // ---- 整份文件结束：统一建立批次关系（允许乱序） ----
  const mastersByBatch = new Map(); // batch_no -> 首个主记录候选
  const masterBatchConflicts = [];
  for (const item of candidates) {
    if (item.record.record_type !== RECORD_TYPE_BATCH_MASTER) continue;
    const batchNo = item.record.payload.batch_no;
    if (!mastersByBatch.has(batchNo)) {
      mastersByBatch.set(batchNo, item);
    } else {
      // 同一批次号出现多个主记录：按字段形状冲突隔离后者。
      const first = mastersByBatch.get(batchNo);
      const reason = `批次号 '${batchNo}' 的主记录重复（首次出现于 index ${first.index}）`;
      masterBatchConflicts.push(
        freeze({
          index: item.index,
          line: item.line,
          record_id: item.record.record_id,
          batch_no: batchNo,
          first: { index: first.index, line: first.line },
        }),
      );
      shapeReports.push(
        freeze({
          index: item.index,
          line: item.line,
          category: ISSUE_MALFORMED_SHAPE,
          reason,
          record: item.record,
          raw: null,
        }),
      );
      quarantineIt({
        index: item.index,
        line: item.line,
        category: ISSUE_MALFORMED_SHAPE,
        reason,
        record: item.record,
        raw: null,
      });
    }
  }

  const pending = [];
  const missingReports = [];
  const associationsByBatch = new Map();

  for (const item of candidates) {
    if (masterBatchConflicts.some((c) => c.index === item.index)) continue;
    const { record, index, line } = item;

    if (record.record_type === RECORD_TYPE_BATCH_MASTER) {
      pending.push(freeze({ index, line, record, association: null }));
      continue;
    }

    const master = mastersByBatch.get(record.payload.batch_no);
    // 冲突落败的主记录不参与关联。
    const masterValid = master && !masterBatchConflicts.some(
      (c) => c.index === master.index,
    );
    if (!masterValid) {
      const reason = `明细引用的批次主记录缺失：batch_no '${record.payload.batch_no}'`;
      missingReports.push(
        freeze({
          index,
          line,
          record_id: record.record_id,
          batch_no: record.payload.batch_no,
        }),
      );
      quarantineIt({
        index,
        line,
        category: ISSUE_MISSING_RELATION,
        reason,
        record,
        raw: null,
      });
      continue;
    }

    const association = freeze({
      batch_no: record.payload.batch_no,
      master: { index: master.index, line: master.line },
      detail: { index, line },
      // 可解释的乱序方向：明细先出现即历史事故中被误判为孤儿的情况。
      order: index < master.index ? 'detail_first' : 'master_first',
    });
    pending.push(freeze({ index, line, record, association }));

    if (!associationsByBatch.has(record.payload.batch_no)) {
      associationsByBatch.set(record.payload.batch_no, {
        batch_no: record.payload.batch_no,
        master: { index: master.index, line: master.line },
        details: [],
      });
    }
    associationsByBatch
      .get(record.payload.batch_no)
      .details.push(
        freeze({ index, line, order: association.order }),
      );
  }

  pending.sort((a, b) => a.index - b.index);
  quarantine.sort((a, b) => a.index - b.index);

  return freeze({
    pending: freeze(pending),
    quarantine: freeze(quarantine),
    reports: freeze({
      malformedShapes: freeze(shapeReports),
      unknownTypes: freeze(unknownReports),
      duplicates: freeze(duplicateReports),
      missingRelations: freeze(missingReports),
    }),
    associations: freeze(
      [...associationsByBatch.values()]
        .sort((a, b) => a.master.index - b.master.index)
        .map(freeze),
    ),
  });
}

function validateKnownShape(record) {
  const payload = record.payload;
  if (typeof payload.batch_no !== 'string' || payload.batch_no.length === 0) {
    return "字段 'payload.batch_no' 必须是非空字符串";
  }
  return null;
}

/**
 * 以修正后的记录回并隔离项。
 *
 * corrections 以隔离项 qid 为键，值为修正后的完整记录信封。
 * 修正项携带其原位置重新参与全量分类：
 *  - 修正本身不合规的，仍留在隔离区（携带新原因）；
 *  - 未被修正的隔离项保持原状参与校验；因此修正缺失的批次主记录后，
 *    原先因“缺失批次关系”被隔离的明细会自动恢复关联。
 *
 * @returns 与 processEntries 同形状的全新冻结结果
 */
export function reintegrate(batch, corrections) {
  const correctionByQid = new Map(Object.entries(corrections ?? {}));
  const rebuilt = [];

  for (const item of batch.pending) {
    rebuilt.push({ ok: true, index: item.index, line: item.line, record: item.record });
  }
  for (const item of batch.quarantine) {
    const corrected = correctionByQid.get(item.qid);
    if (corrected !== undefined) {
      rebuilt.push({ ok: true, index: item.index, line: item.line, record: corrected });
    } else if (item.category === ISSUE_MALFORMED_SHAPE && item.record === null) {
      rebuilt.push({
        ok: false,
        index: item.index,
        line: item.line,
        reason: item.reason,
        raw: item.raw,
      });
    } else {
      rebuilt.push({ ok: true, index: item.index, line: item.line, record: item.record });
    }
  }

  return processEntries(rebuilt);
}
