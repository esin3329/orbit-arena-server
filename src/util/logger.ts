type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
/** 구조화(JSON Lines) 로거 — 로그 수집기(Loki, CloudWatch 등)에 그대로 적재 가능 */
function log(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < (ORDER[process.env.LOG_LEVEL ?? 'info'] ?? 20)) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const logger = {
  debug: (msg: string, f?: Record<string, unknown>) => log('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => log('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => log('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => log('error', msg, f),
};

export function errorFields(err: unknown) {
  return err instanceof Error ? { err: err.message, stack: err.stack } : { err: String(err) };
}
