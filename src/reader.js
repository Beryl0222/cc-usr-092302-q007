import { createHash } from 'node:crypto';

/**
 * 当前支持的申报文件信封版本。
 *
 * 迁移约定（见 README）：
 *  - 同版本内演进只能新增可选字段；
 *  - 出现更高版本时读取器拒绝猜测解析，保留原文并交给人工迁移，
 *    绝不能把高版本文件按低版本形状处理。
 */
export const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * 计算文件原文的内容指纹。检查点用它区分“同一文件重试”与
 * “同名但内容已变化”，因此必须基于解析前的原始字节。
 */
export function hashRaw(rawText) {
  return createHash('sha256').update(rawText, 'utf8').digest('hex');
}

/**
 * 把一行原始文本解析成记录信封。任何形状问题都以结构化异常抛出，
 * 由上层归入“错误字段形状”，而不是让整个文件失败。
 *
 * @returns {{record_id: string, record_type: string, payload: object,
 *            schema_version?: number, revision?: number}}
 */
function parseRecordLine(lineText, position) {
  let value;
  try {
    value = JSON.parse(lineText);
  } catch (cause) {
    throw {
      kind: 'malformed',
      reason: '记录不是合法 JSON',
      raw: lineText,
      position,
      cause,
    };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw {
      kind: 'malformed',
      reason: '记录顶层必须是对象',
      raw: lineText,
      position,
    };
  }
  if (typeof value.record_id !== 'string' || value.record_id.length === 0) {
    throw {
      kind: 'malformed',
      reason: "缺少字符串字段 'record_id'",
      raw: lineText,
      position,
    };
  }
  if (typeof value.record_type !== 'string' || value.record_type.length === 0) {
    throw {
      kind: 'malformed',
      reason: "缺少字符串字段 'record_type'",
      raw: lineText,
      position,
    };
  }
  if (
    value.payload === null ||
    typeof value.payload !== 'object' ||
    Array.isArray(value.payload)
  ) {
    throw {
      kind: 'malformed',
      reason: "字段 'payload' 必须是对象",
      raw: lineText,
      position,
    };
  }
  if (
    value.schema_version !== undefined &&
    !Number.isInteger(value.schema_version)
  ) {
    throw {
      kind: 'malformed',
      reason: "字段 'schema_version' 必须是整数",
      raw: lineText,
      position,
    };
  }
  return value;
}

/**
 * 从原始文本中按出现顺序取出全部记录信封。
 *
 * 兼容性：输入既可以是 NDJSON（每行一条，空行允许），也可以是
 * v1 批式信封 {"schema_version","file_id","records":[...]}；还可以是
 * 单条记录对象（与既有 loadRecord 样例同形状）。
 *
 * 返回的每一条都携带原始位置 {index, line}：index 是该记录在文件内
 * 从 0 开始的序号（用于追踪与隔离项回并），line 是面向审核员的
 * 1 基行号（NDJSON 模式下）。解析失败的行以 error 元素保留在同一
 * 序列中，位置信息不丢失。
 *
 * 版本闸门：信封/单条记录声明的版本高于 SUPPORTED_SCHEMA_VERSION 时，
 * 抛出 {kind:'unsupported_version'}，调用方必须保留原文、不得解析。
 *
 * @returns {{entries: Array<{ok:true, index:number, line:number, record:object}> |
 *                      Array<{ok:false, index:number, line:number,
 *                             reason:string, raw:string}>>,
 *           envelope: object | null}}
 */
export function extractEntries(rawText) {
  const trimmed = rawText.trim();
  // NDJSON：出现换行分隔的多行内容，或首行就不是对象/数组整体。
  const looksMultiline = /\n/.test(trimmed);

  if (!looksMultiline) {
    return extractSingleEnvelopeOrRecord(trimmed);
  }

  // 多行：优先尝试整体 JSON（pretty-printed 信封），失败再按 NDJSON 处理。
  try {
    const parsed = JSON.parse(rawText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return extractSingleEnvelopeOrRecord(rawText);
    }
  } catch {
    // 落到 NDJSON
  }

  const entries = [];
  const lines = rawText.split(/\r?\n/);
  let index = 0;
  for (let lineNo = 1; lineNo <= lines.length; lineNo += 1) {
    const lineText = lines[lineNo - 1];
    if (lineText.trim() === '') continue;
    const position = { index, line: lineNo };
    try {
      const record = parseRecordLine(lineText, position);
      if (
        Number.isInteger(record.schema_version) &&
        record.schema_version > SUPPORTED_SCHEMA_VERSION
      ) {
        throw {
          kind: 'unsupported_version',
          declared: record.schema_version,
          supported: SUPPORTED_SCHEMA_VERSION,
          raw: rawText,
        };
      }
      entries.push({ ok: true, index, line: lineNo, record });
    } catch (error) {
      if (error.kind === 'unsupported_version') throw error;
      entries.push({
        ok: false,
        index,
        line: lineNo,
        reason: error.reason,
        raw: lineText,
      });
    }
    index += 1;
  }
  return { entries, envelope: null };
}

function extractSingleEnvelopeOrRecord(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw {
      kind: 'malformed',
      reason: '文件不是合法 JSON',
      raw: text,
      cause,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw { kind: 'malformed', reason: '文件顶层必须是对象', raw: text };
  }

  if (Array.isArray(parsed.records)) {
    const envelope = parsed;
    const declaredVersion = envelope.schema_version;
    if (declaredVersion === undefined) {
      throw {
        kind: 'malformed',
        reason: '批式信封缺少 schema_version',
        raw: text,
      };
    }
    if (!Number.isInteger(declaredVersion)) {
      throw {
        kind: 'malformed',
        reason: '批式信封 schema_version 必须是整数',
        raw: text,
      };
    }
    if (declaredVersion > SUPPORTED_SCHEMA_VERSION) {
      throw {
        kind: 'unsupported_version',
        declared: declaredVersion,
        supported: SUPPORTED_SCHEMA_VERSION,
        raw: text,
      };
    }
    const entries = envelope.records.map((record, index) => {
      const position = { index, line: null };
      try {
        validateEnvelopeRecord(record, position);
        return { ok: true, index, line: null, record };
      } catch (error) {
        return {
          ok: false,
          index,
          line: null,
          reason: error.reason,
          raw: safeStringify(record),
        };
      }
    });
    return { entries, envelope };
  }

  // 单条记录对象（含既有样例形状：record_id + schema_version 顶层）。
  const version = Number.isInteger(parsed.schema_version)
    ? parsed.schema_version
    : undefined;
  if (version !== undefined && version > SUPPORTED_SCHEMA_VERSION) {
    throw {
      kind: 'unsupported_version',
      declared: version,
      supported: SUPPORTED_SCHEMA_VERSION,
      raw: text,
    };
  }
  // 归一成内部信封形状 record_type/payload；保持顶层字段透传。
  const record =
    typeof parsed.record_type === 'string'
      ? parsed
      : {
          record_id: parsed.record_id,
          record_type: parsed.domain ?? 'supply_report',
          schema_version: parsed.schema_version,
          revision: parsed.revision,
          payload: parsed,
        };
  validateEnvelopeRecord(record, { index: 0, line: null });
  return {
    entries: [{ ok: true, index: 0, line: null, record }],
    envelope: null,
  };
}

function validateEnvelopeRecord(record, position) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw { kind: 'malformed', reason: '记录必须是对象', position };
  }
  if (typeof record.record_id !== 'string' || record.record_id.length === 0) {
    throw { kind: 'malformed', reason: "缺少字符串字段 'record_id'", position };
  }
  if (typeof record.record_type !== 'string' || record.record_type.length === 0) {
    throw {
      kind: 'malformed',
      reason: "缺少字符串字段 'record_type'",
      position,
    };
  }
  if (
    record.payload === null ||
    typeof record.payload !== 'object' ||
    Array.isArray(record.payload)
  ) {
    throw { kind: 'malformed', reason: "字段 'payload' 必须是对象", position };
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
