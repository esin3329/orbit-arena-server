type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
/** 구조화(JSON Lines) 로거 — 로그 수집기(Loki, CloudWatch 등)에 그대로 적재 가능 */
function log(level: Level, msg: string, fields?: Record<string, unknown>) {
  const minLevel = typeof process !== 'undefined' && process.env ? (process.env.LOG_LEVEL ?? 'info') : 'info';
  if (ORDER[level] < (ORDER[minLevel] ?? 20)) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  const stream = typeof process !== 'undefined' ? (level === 'error' || level === 'warn' ? process.stderr : process.stdout) : undefined;
  if (stream && typeof stream.write === 'function') stream.write(line + '\n');
  else if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
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
