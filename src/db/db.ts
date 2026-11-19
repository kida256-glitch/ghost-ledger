import pg from "pg";

/**
 * The only database surface the repositories use (design §8). Two adapters:
 * `fromPgPool` for runtime, `fromPglite` (src/db/testing) for tests.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
  /**
   * Runs `fn` in one transaction at READ COMMITTED (set explicitly on every
   * transaction, design §5). Commits if `fn` resolves, rolls back if it throws.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

export const BEGIN_READ_COMMITTED = "begin isolation level read committed";

/**
 * Runtime adapter over node-postgres. Safe behind Supabase's transaction
 * pooler (design §5.1): plain parameterized queries only (no named prepared
 * statements), no session state; the advisory lock is transaction-scoped.
 */
export function fromPgPool(pool: pg.Pool): Db {
  return {
    async query<T>(sql: string, params: readonly unknown[] = []) {
      const r = await pool.query({ text: sql, values: [...params] });
      return { rows: r.rows as T[] };
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query(BEGIN_READ_COMMITTED);
        const tx: Db = {
          async query<U>(sql: string, params: readonly unknown[] = []) {
            const r = await client.query({ text: sql, values: [...params] });
            return { rows: r.rows as U[] };
          },
          transaction: () => Promise.reject(new Error("nested transactions are not supported")),
        };
        const result = await fn(tx);
        await client.query("commit");
        return result;
      } catch (e) {
        await client.query("rollback").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

/** One connection per serverless instance: the pooler does the pooling (design §5.1). */
export function createRuntimePool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 1 });
}
