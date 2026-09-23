/**
 * 测试用日志收集器：满足 createSafeLogger 所需的 console 形状，
 * 把每条日志以 {level, event, fields} 保存下来供断言。
 */
export function captureLogs(sink) {
  const push = (level) => (event, fields) => sink.push({ level, event, fields });
  return {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    log: push('info'),
  };
}
