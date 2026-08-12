import type { Pool } from 'pg';

export async function cleanDatabase(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM audit_logs');
  await pool.query('DELETE FROM usage_events');
  await pool.query('DELETE FROM daily_usage');
  await pool.query('DELETE FROM api_keys');
  await pool.query('DELETE FROM projects');
}
