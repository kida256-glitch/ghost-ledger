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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/** URL parameters that `pg` would let override the `ssl` object. */
const SSL_URL_PARAMS = ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"];

export class PoolConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolConfigError";
  }
}

/**
 * Pool settings for every connection in the project (design §14.2).
 * Local hosts: no TLS. Anything else: TLS verified against `caCert` (CA and
 * hostname, i.e. verify-full), and refused without it. Messages never
 * include the URL, which carries a password.
 */
export function poolConfig(connectionString: string, opts: { caCert?: string | undefined; max?: number } = {}): pg.PoolConfig {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new PoolConfigError("database URL is not a valid URL");
  }
  for (const p of SSL_URL_PARAMS) url.searchParams.delete(p);
  const max = opts.max ?? 1;
  if (LOCAL_HOSTS.has(url.hostname)) return { connectionString: url.toString(), max, ssl: false };
  if (!opts.caCert?.includes("BEGIN CERTIFICATE")) {
    throw new PoolConfigError(`DATABASE_CA_CERT (the Supabase CA certificate, PEM) is required to connect to ${url.hostname}`);
  }
  return { connectionString: url.toString(), max, ssl: { ca: opts.caCert, rejectUnauthorized: true } };
}

/** A pool built from `poolConfig`. Default `max: 1`: one connection per serverless instance, the pooler does the pooling (§5.1). */
export function createPool(connectionString: string, opts: { caCert?: string | undefined; max?: number } = {}): pg.Pool {
  return new pg.Pool(poolConfig(connectionString, opts));
}

/** The runtime pool (app, health, later MCP and agent). */
export function createRuntimePool(connectionString: string, caCert?: string): pg.Pool {
  return createPool(connectionString, { caCert, max: 1 });
}
