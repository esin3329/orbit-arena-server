import type { Config } from '../config.ts';
import type { Repository } from './types.ts';
import { SqliteRepository } from './sqlite.ts';

export async function createRepository(cfg: Pick<Config, 'dbDriver' | 'sqlitePath' | 'supabaseUrl' | 'supabaseKey'>): Promise<Repository> {
  if (cfg.dbDriver === 'supabase') {
    if (!cfg.supabaseUrl || !cfg.supabaseKey) {
      throw new Error('DB_DRIVER=supabase 는 SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다');
    }
    const { createSupabaseRepository } = await import('./supabase.ts');
    return createSupabaseRepository(cfg.supabaseUrl, cfg.supabaseKey);
  }
  return new SqliteRepository(cfg.sqlitePath);
}

export type { Repository } from './types.ts';
