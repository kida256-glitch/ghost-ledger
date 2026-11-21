// The privilege matrix (design §6.2) as data, and a checker that runs it
// against any database: PGlite in `npm test`, local Supabase in
// `npm run test:integration`. Every table in `public` must be listed; a new
// table without an entry fails, so later specs have to declare their grants.

export const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;
export type Privilege = (typeof TABLE_PRIVILEGES)[number];

export interface Expected {
  readonly table: readonly Privilege[];
  /** Column-level grants; when absent, the table-level grant covers every column. */
  readonly insertColumns?: readonly string[];
  readonly updateColumns?: readonly string[];
}

const NONE: Expected = { table: [] };

/** The Supabase API roles get nothing on any table (R13.9). */
const API_ROLES = { anon: NONE, authenticated: NONE, service_role: NONE };

export const MATRIX: Record<string, Record<string, Expected>> = {
  groups: { ghost_app: { table: ["SELECT"] }, ghost_readonly: { table: ["SELECT"] }, ...API_ROLES },
  members: { ghost_app: { table: ["SELECT", "INSERT"] }, ghost_readonly: { table: ["SELECT"] }, ...API_ROLES },
  member_credentials: {
    ghost_app: { table: ["SELECT"], insertColumns: ["member_id"], updateColumns: ["pin_hash", "failed_attempts", "locked_until", "ussd_language"] },
    ghost_readonly: NONE,
    ...API_ROLES,
  },
  // ai-agent-mcp design §6: the agent's daily counter, like the USSD rate limits.
  agent_usage: {
    ghost_app: { table: ["SELECT", "INSERT"], updateColumns: ["messages"] },
    ghost_readonly: NONE,
    ...API_ROLES,
  },
  // ussd-engine design §6: updated in place, never read by the read-only role.
  ussd_rate_limits: {
    ghost_app: { table: ["SELECT", "INSERT"], updateColumns: ["window_start", "hits"] },
    ghost_readonly: NONE,
    ...API_ROLES,
  },
  ledger_entries: { ghost_app: { table: ["SELECT", "INSERT"] }, ghost_readonly: { table: ["SELECT"] }, ...API_ROLES },
};

export const ROLES = ["ghost_app", "ghost_readonly", "anon", "authenticated", "service_role"] as const;

export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Compares the database with the matrix. Returns a list of mismatches
 * (empty means the database matches exactly).
 */
export async function checkPrivileges(db: Queryable): Promise<string[]> {
  const problems: string[] = [];
  const tables = await db.query<{ relname: string; relrowsecurity: boolean }>(
    `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' order by 1`,
  );
  const declared = Object.keys(MATRIX).sort();
  const actual = tables.rows.map((r) => r.relname).sort();
  if (JSON.stringify(declared) !== JSON.stringify(actual)) problems.push(`tables: declared ${declared.join(",")}, found ${actual.join(",")}`);
  for (const row of tables.rows) if (!row.relrowsecurity) problems.push(`${row.relname}: RLS is off`);

  for (const table of Object.keys(MATRIX)) {
    const cols = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1",
      [table],
    );
    for (const role of ROLES) {
      const expected = MATRIX[table]?.[role];
      if (!expected) {
        problems.push(`${table} × ${role}: not in the matrix`);
        continue;
      }
      for (const priv of TABLE_PRIVILEGES) {
        const r = await db.query<{ has: boolean }>("select has_table_privilege($1, $2, $3) as has", [role, `public.${table}`, priv]);
        const want = expected.table.includes(priv);
        if (r.rows[0]?.has !== want) problems.push(`${table} × ${role}: ${priv} is ${r.rows[0]?.has}, expected ${want}`);
      }
      for (const { column_name } of cols.rows) {
        for (const priv of ["INSERT", "UPDATE"] as const) {
          const granted = (priv === "INSERT" ? expected.insertColumns : expected.updateColumns) ?? (expected.table.includes(priv) ? [column_name] : []);
          const r = await db.query<{ has: boolean }>("select has_column_privilege($1, $2, $3, $4) as has", [role, `public.${table}`, column_name, priv]);
          const want = granted.includes(column_name);
          if (r.rows[0]?.has !== want) problems.push(`${table}.${column_name} × ${role}: ${priv} is ${r.rows[0]?.has}, expected ${want}`);
        }
      }
    }
  }
  return problems;
}
