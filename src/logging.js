/**
 * 日志脱敏：普通日志只允许出现可追踪的技术标识（记录号、位置、类别），
 * 供应商敏感字段（名称、联系方式、地址、信用代码等）一律替换为 ***。
 */

export const DEFAULT_SENSITIVE_FIELDS = Object.freeze([
  'supplier_name',
  'contact_phone',
  'contact_email',
  'supplier_address',
  'credit_code',
]);

export const REDACTED = '***';

/** 深拷贝并替换敏感字段，原对象不被修改。 */
export function redactSensitive(value, sensitiveFields = DEFAULT_SENSITIVE_FIELDS) {
  const sensitive = new Set(sensitiveFields);
  const walk = (node) => {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (typeof node === 'object' && node !== null) {
      const out = {};
      for (const [key, val] of Object.entries(node)) {
        out[key] = sensitive.has(key) ? REDACTED : walk(val);
      }
      return out;
    }
    return node;
  };
  return walk(value);
}

/**
 * 生成一个逐行输出 JSON 的日志器，所有 data 先脱敏再落盘。
 * sink 缺省为 console.log；测试可注入数组收集器。
 */
export function createRedactingLogger({ sink, sensitiveFields } = {}) {
  const emit = typeof sink === 'function' ? sink : console.log;
  const write = (level, event, data) => {
    const safe = redactSensitive(data ?? {}, sensitiveFields);
    emit(JSON.stringify({ level, event, ...safe }));
  };
  return {
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
  };
}

/** 不输出任何内容的日志器，供调用方缺省使用。 */
export function createNullLogger() {
  return createRedactingLogger({ sink: () => {} });
}
