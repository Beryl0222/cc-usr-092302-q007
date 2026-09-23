/**
 * 日志脱敏。
 *
 * 普通日志（info/warn/error）一律经过这里的安全日志器：供应商敏感
 * 字段在输出前被替换，业务原文（raw）不允许出现在普通日志中。
 * 排查所需的关联性通过 record_id、文件内位置 index/line 和文件
 * 内容指纹保留，不依赖任何供应商身份信息。
 */

export const SENSITIVE_KEYS = Object.freeze([
  'supplier_name',
  'supplier_id',
  'supplier_tax_no',
  'vendor_name',
  'vendor_id',
  'contact',
  'contact_name',
  'phone',
  'mobile',
  'email',
  'address',
  'bank_account',
  'id_number',
  'price',
  'unit_price',
  'amount',
  'quantity_shipped',
]);

const SENSITIVE_SET = new Set(SENSITIVE_KEYS);
const REDACTED = '***';

function redactValue(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_SET.has(key)) {
        out[key] = REDACTED;
      } else if (key === 'raw' || key === 'payload') {
        // 业务原文/载荷不进入普通日志。
        out[key] = '[redacted:content]';
      } else {
        out[key] = redactValue(child, seen);
      }
    }
    return out;
  }
  return value;
}

/**
 * 包装一个最小日志器（console 形状），所有结构化字段先脱敏再输出。
 * 事件名和位置类字段（file_id/record_id/index/line/batch_no/计数）
 * 保留，足以追踪恢复链。
 */
export function createSafeLogger(logger = console) {
  const write = (level, event, fields) => {
    const safe = redactValue(fields ?? {});
    const fn = logger[level] ?? logger.info ?? logger.log;
    fn.call(logger, `[supply-collab] ${event}`, safe);
  };
  return Object.freeze({
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  });
}
