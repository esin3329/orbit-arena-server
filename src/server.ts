import { createApp } from './app.ts';
import { config, DEV_TOKEN_SECRET } from './config.ts';
import { errorFields, logger } from './util/logger.ts';

if (config.tokenSecret === DEV_TOKEN_SECRET) {
  logger.warn('TOKEN_SECRET 이 설정되지 않아 개발용 시크릿을 사용합니다. 운영 환경에서는 반드시 설정하세요.');
}

const app = await createApp();
const port = await app.listen();
logger.info('server listening', { url: `http://localhost:${port}`, db: app.repo.driver });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('graceful shutdown', { signal });
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    logger.error('shutdown failed', errorFields(err));
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error('unhandledRejection', errorFields(err)));
