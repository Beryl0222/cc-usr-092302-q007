/**
 * 申报文件扫描与校验。
 *
 * 设计要点：
 * - 每条记录从原始顺序保留 index（0 起），审核员可凭它追踪文件内位置；
 * - 明细与批次主记录的关联在整份文件扫描完成后统一结算，
 *   因此“先明细、后批次”的正常申报不再被当成孤儿；
 * - 重复标识、未知申报类型、确实缺失的批次关系、错误字段形状
 *   分成四类问题各自报告（见 ISSUE_CATEGORIES）；
 * - 版本超出支持范围的文件保留原文，不做任何猜测性解析。
 */

export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1]);

export const DECLARATION_TYPES = Object.freeze(['batch', 'detail']);

export const ISSUE_CATEGORIES = Object.freeze({
  DUPLICATE_IDENTIFIER: 'duplicate_identifier',
  UNKNOWN_DECLARATION_TYPE: 'unknown_declaration_type',
  MISSING_BATCH_RELATION: 'missing_batch_relation',
  INVALID_FIELD_SHAPE: 'invalid_field_shape',
});

/** 文件本身无法读取（不是版本问题，而是连信封都不合法）。 */
export class DeclarationFileUnreadableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'DeclarationFileUnreadableError';
  }
}

/** 隔离项的修正记录仍不合规时抛出，category 指明属于哪一类问题。 */
export class CorrectionRejectedError extends Error {
  constructor(message, { category } = {}) {
    super(message);
    this.name = 'CorrectionRejectedError';
    this.category = category;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解析申报文件信封，保留每条记录的原始位置。
 * 返回 { kind: 'parsed', fileId, schemaVersion, entries: [{ index, raw }] }
 * 或   { kind: 'unsupported_version', schemaVersion, rawText }（保留原文，不解析记录）。
 */
export function parseDeclarationFile(text) {
  if (typeof text !== 'string') {
    throw new DeclarationFileUnreadableError('申报文件内容必须是文本');
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (cause) {
    throw new DeclarationFileUnreadableError('申报文件不是合法 JSON', { cause });
  }
  if (!isPlainObject(payload)) {
    throw new DeclarationFileUnreadableError('申报文件必须是 JSON 对象');
  }
  const version = payload.schema_version;
  if (!Number.isInteger(version) || !SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    return {
      kind: 'unsupported_version',
      schemaVersion: Number.isInteger(version) ? version : null,
      rawText: text,
    };
  }
  if (!Array.isArray(payload.records)) {
    throw new DeclarationFileUnreadableError('申报文件缺少 records 数组');
  }
  const entries = payload.records.map((raw, index) => ({ index, raw }));
  return {
    kind: 'parsed',
    fileId: typeof payload.file_id === 'string' ? payload.file_id : null,
    schemaVersion: version,
    entries,
  };
}

/** 校验单条记录的字段形状，返回问题描述列表（空数组表示合规）。 */
export function validateRecordShape(raw) {
  if (!isPlainObject(raw)) {
    return ['记录必须是 JSON 对象'];
  }
  const problems = [];
  if (typeof raw.record_id !== 'string' || raw.record_id.length === 0) {
    problems.push('record_id 必须是非空字符串');
  }
  if (typeof raw.declaration_type !== 'string') {
    problems.push('declaration_type 必须是字符串');
  }
  if (typeof raw.drug_code !== 'string' || raw.drug_code.length === 0) {
    problems.push('drug_code 必须是非空字符串');
  }
  if (typeof raw.quantity !== 'number' || !Number.isFinite(raw.quantity) || raw.quantity <= 0) {
    problems.push('quantity 必须是正数');
  }
  if (typeof raw.occurred_at !== 'string' || Number.isNaN(Date.parse(raw.occurred_at))) {
    problems.push('occurred_at 必须是可解析的时间字符串');
  }
  if (raw.declaration_type === 'detail') {
    if (typeof raw.batch_record_id !== 'string' || raw.batch_record_id.length === 0) {
      problems.push('batch_record_id 必须是非空字符串');
    }
  }
  if (raw.supplier !== undefined && !isPlainObject(raw.supplier)) {
    problems.push('supplier 必须是对象');
  }
  return problems;
}

function recordIdOf(raw) {
  return isPlainObject(raw) && typeof raw.record_id === 'string' ? raw.record_id : null;
}

/**
 * 扫描整份文件并统一结算关联关系。
 * 返回 {
 *   pending:      待提交集合（合法申报，按原始位置排序，每项含 index）,
 *   quarantine:   隔离项（含原始位置、类别与原因，可被修正后重新并入）,
 *   associations: 明细→批次的可解释关联（双方原始位置都在）,
 *   issues:       扫描时发现的问题报告（四类分开，重复标识带全部位置）
 * }
 */
export function analyzeDeclarations(entries) {
  const pending = [];
  const quarantine = [];
  const issues = [];

  // 第一遍：字段形状与申报类型。形状不合规的记录连类型都不可信，直接隔离。
  const candidates = [];
  for (const { index, raw } of entries) {
    const recordId = recordIdOf(raw);
    const problems = validateRecordShape(raw);
    if (problems.length > 0) {
      const message = problems.join('；');
      issues.push({ category: ISSUE_CATEGORIES.INVALID_FIELD_SHAPE, recordId, indexes: [index], message });
      quarantine.push({ index, recordId, category: ISSUE_CATEGORIES.INVALID_FIELD_SHAPE, message, record: raw });
      continue;
    }
    if (!DECLARATION_TYPES.includes(raw.declaration_type)) {
      const message = `未知申报类型: ${raw.declaration_type}`;
      issues.push({ category: ISSUE_CATEGORIES.UNKNOWN_DECLARATION_TYPE, recordId, indexes: [index], message });
      quarantine.push({ index, recordId, category: ISSUE_CATEGORIES.UNKNOWN_DECLARATION_TYPE, message, record: raw });
      continue;
    }
    candidates.push({ index, raw });
  }

  // 第二遍：重复标识。同一记录号出现多次时，全部位置都要可追踪，各次出现一并隔离。
  const byId = new Map();
  for (const { index, raw } of candidates) {
    const list = byId.get(raw.record_id) ?? [];
    list.push({ index, raw });
    byId.set(raw.record_id, list);
  }
  const unique = [];
  const quarantinedIds = new Set();
  for (const [recordId, list] of byId) {
    if (list.length === 1) {
      unique.push(list[0]);
      continue;
    }
    const indexes = list.map((entry) => entry.index);
    const message = `记录号 ${recordId} 在文件内出现 ${list.length} 次，位置: ${indexes.join(', ')}`;
    issues.push({ category: ISSUE_CATEGORIES.DUPLICATE_IDENTIFIER, recordId, indexes, message });
    quarantinedIds.add(recordId);
    for (const { index, raw } of list) {
      quarantine.push({ index, recordId, category: ISSUE_CATEGORIES.DUPLICATE_IDENTIFIER, message, record: raw });
    }
  }

  // 第三遍：整份文件已读完，统一结算明细→批次的乱序关联。
  const batches = new Map();
  const details = [];
  for (const { index, raw } of unique) {
    if (raw.declaration_type === 'batch') {
      batches.set(raw.record_id, { index, raw });
    } else {
      details.push({ index, raw });
    }
  }
  const associations = [];
  for (const { index, raw } of details) {
    const batch = batches.get(raw.batch_record_id);
    if (batch) {
      associations.push({
        detailIndex: index,
        detailRecordId: raw.record_id,
        batchIndex: batch.index,
        batchRecordId: batch.raw.record_id,
      });
      pending.push({ index, recordId: raw.record_id, type: 'detail', record: raw });
      continue;
    }
    const message = quarantinedIds.has(raw.batch_record_id)
      ? `明细 ${raw.record_id} 引用的批次 ${raw.batch_record_id} 已因重复标识被隔离，无法关联`
      : `明细 ${raw.record_id} 引用的批次 ${raw.batch_record_id} 在整份文件中不存在`;
    issues.push({ category: ISSUE_CATEGORIES.MISSING_BATCH_RELATION, recordId: raw.record_id, indexes: [index], message });
    quarantine.push({ index, recordId: raw.record_id, category: ISSUE_CATEGORIES.MISSING_BATCH_RELATION, message, record: raw });
  }
  for (const [recordId, { index, raw }] of batches) {
    pending.push({ index, recordId, type: 'batch', record: raw });
  }

  pending.sort((a, b) => a.index - b.index);
  quarantine.sort((a, b) => a.index - b.index);
  return { pending, quarantine, associations, issues };
}

/**
 * 把修正后的隔离项携带原位置重新并入待提交集合。
 * analysis 为 analyzeDeclarations 的返回；correction 为 { index, record }。
 * 返回新的 analysis（不修改入参）；修正仍不合规时抛 CorrectionRejectedError。
 */
export function reintegrateDeclaration(analysis, correction) {
  const { index, record } = correction ?? {};
  if (!Number.isInteger(index)) {
    throw new CorrectionRejectedError('修正必须携带隔离项的原始位置索引', { category: ISSUE_CATEGORIES.INVALID_FIELD_SHAPE });
  }
  const held = analysis.quarantine.find((item) => item.index === index);
  if (!held) {
    throw new CorrectionRejectedError(`位置 ${index} 没有可并入的隔离项`, { category: ISSUE_CATEGORIES.INVALID_FIELD_SHAPE });
  }
  const problems = validateRecordShape(record);
  if (problems.length > 0) {
    throw new CorrectionRejectedError(`修正记录形状不合规: ${problems.join('；')}`, { category: ISSUE_CATEGORIES.INVALID_FIELD_SHAPE });
  }
  if (!DECLARATION_TYPES.includes(record.declaration_type)) {
    throw new CorrectionRejectedError(`未知申报类型: ${record.declaration_type}`, { category: ISSUE_CATEGORIES.UNKNOWN_DECLARATION_TYPE });
  }
  if (analysis.pending.some((item) => item.recordId === record.record_id)) {
    throw new CorrectionRejectedError(`记录号 ${record.record_id} 与待提交集合冲突`, { category: ISSUE_CATEGORIES.DUPLICATE_IDENTIFIER });
  }

  const pending = [...analysis.pending];
  const associations = [...analysis.associations];
  if (record.declaration_type === 'detail') {
    const batch = pending.find((item) => item.type === 'batch' && item.recordId === record.batch_record_id);
    if (!batch) {
      throw new CorrectionRejectedError(
        `明细 ${record.record_id} 引用的批次 ${record.batch_record_id} 不在待提交集合中`,
        { category: ISSUE_CATEGORIES.MISSING_BATCH_RELATION },
      );
    }
    associations.push({
      detailIndex: index,
      detailRecordId: record.record_id,
      batchIndex: batch.index,
      batchRecordId: batch.recordId,
    });
    associations.sort((a, b) => a.detailIndex - b.detailIndex);
  }
  pending.push({ index, recordId: record.record_id, type: record.declaration_type, record });
  pending.sort((a, b) => a.index - b.index);
  const quarantine = analysis.quarantine.filter((item) => item.index !== index);
  return { ...analysis, pending, quarantine, associations };
}
