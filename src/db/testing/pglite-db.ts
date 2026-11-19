// Test-only `Db` adapter over PGlite (design §8). PGlite is a single
// connection, so transactions here are sequential.
import type { PGlite } from "@electric-sql/pglite";
import { BEGIN_READ_COMMITTED, type Db } from "../db";

const ROLE = /^[a-z_][a-z0-9_]*$/;

/**
 * With `role`, every query and transaction runs `set local role <role>` first,
 * so tests exercise the real grants and RLS policies of ghost_app or
 * ghost_readonly.
 */
export function fromPglite(db: PGlite, opts: { role?: string } = {}): Db {
  const { role } = opts;
  if (role !== undefined && !ROLE.test(role)) throw new Error(`bad role name: ${role}`);
  let inTx = false;
  const run = async <T>(sql: string, params: readonly unknown[] = []) => ({ rows: (await db.query<T>(sql, [...params])).rows });

  const transaction = async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
    if (inTx) throw new Error("nested transactions are not supported");
    inTx = true;
    await db.exec(BEGIN_READ_COMMITTED);
    try {
      if (role) await db.exec(`set local role ${role}`);
      const tx: Db = { query: run, transaction: () => Promise.reject(new Error("nested transactions are not supported")) };
      const result = await fn(tx);
      await db.exec("commit");
      return result;
    } catch (e) {
      await db.exec("rollback").catch(() => undefined);
      throw e;
    } finally {
      inTx = false;
    }
  };

  return {
    // Outside a transaction, a role-bound query runs in its own short transaction.
    query: <T>(sql: string, params: readonly unknown[] = []) =>
      role ? transaction((tx) => tx.query<T>(sql, params)) : run<T>(sql, params),
    transaction,
  };
}
