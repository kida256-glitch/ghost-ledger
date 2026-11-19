# Design: ledger-core

## 1. Overview

```
src/domain   pure rules: commands -> entries, replay -> state, verifyChain, detectAnomalies
src/db       Db adapter (pg / PGlite), LedgerReader, LedgerWriter (transactions, lock, retries)
src/seed     pure, deterministic seed builder (uses domain commands)
scripts/     seed.ts, demo-tamper.ts, demo-restore.ts (thin CLIs over src/db and src/seed)
supabase/migrations   schema, triggers, roles, RLS
```

Write path: the caller builds `Command[]`. `LedgerWriter.execute` then opens a transaction, takes the group lock, replays the stored entries into a `LedgerState`, runs the domain commands, and inserts the resulting sealed entries one by one. The insert trigger re-checks each link.

Read path: `LedgerReader` loads entries, and callers use domain functions (`replay`, `verifyChain`, `detectAnomalies`, `listOverdueLoans`). No business rule lives outside `src/domain`.

## 2. Hash format

### 2.1 Field order and representation

`canonicalize(entry)` returns `JSON.stringify` of this array, in this exact order:

| # | Field | Representation |
|---|-------|----------------|
| 0 | format tag | the string `"ghost-ledger/entry/v2"` |
| 1 | `id` | lowercase UUID string |
| 2 | `groupId` | lowercase UUID string |
| 3 | `seq` | decimal string, e.g. `"42"` |
| 4 | `type` | e.g. `"DEPOSIT_CONFIRMATION"` |
| 5 | `subjectMemberId` | lowercase UUID string |
| 6 | `actorMemberId` | lowercase UUID string or `null` |
| 7 | `occurredAt` | `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC, exactly 3 fraction digits) |
| 8 | `channel` | `"ussd"`, `"dashboard"`, `"seed"` or `"system"` |
| 9 | `idempotencyKey` | string or `null` |
| 10 | `amount` | decimal string or `null` |
| 11 | `loanId` | lowercase UUID string or `null` |
| 12 | `termMonths` | decimal string or `null` |
| 13 | `interestAmount` | decimal string or `null` |
| 14 | `dueDate` | `YYYY-MM-DD` (Kampala calendar date) or `null` |
| 15 | `reversesEntryId` | lowercase UUID string or `null` |
| 16 | `confirmsEntryId` | lowercase UUID string or `null` (the `DEPOSIT_REQUEST` a `DEPOSIT_CONFIRMATION` confirms) |
| 17 | `reason` | string or `null` |
| 18 | `prevHash` | 64 lowercase hex chars |

`hash = lowercase hex SHA-256 of the UTF-8 bytes of the canonical string`.

The representation rules make every hash input deterministic:

- **Integers** (`seq`, `amount`, `termMonths`, `interestAmount`) are decimal strings with no sign, no leading zeros and no separators. This matches how Postgres returns `bigint` as text, and it avoids any dependence on JSON number formatting.
- **Absent fields** are always `null`. They are never omitted and never `""`.
- **UUIDs** must be lowercase. Postgres prints `uuid` values in lowercase, so an uppercase id would hash differently after a round trip. The domain's zod schema rejects uppercase ids.
- **Strings** are hashed exactly as stored, with no Unicode normalization. `reason` is 1 to 120 characters, and `idempotencyKey` is 1 to 128 characters.
- **Version tag.** Field 0 is the constant `"ghost-ledger/entry/v2"`. It is not a stored column: it exists only inside the canonical string, so it is baked into every hash. Any change to the canonical format needs a new tag and a migration plan for existing chains (for example, verifying old entries with the old rules up to a recorded seq). Without both, every stored chain would stop verifying.
- **v1 → v2 (task 15 review).** v2 adds field 16, `confirmsEntryId`, for deposit confirmation (R9), and the entry types `DEPOSIT_REQUEST` and `DEPOSIT_CONFIRMATION` replace `DEPOSIT`. No v1 entry was ever stored (the database tasks come later), so no migration plan is needed and `verifyChain` accepts v2 only. The golden vectors were recomputed with the standalone script.
- **Golden vector.** A unit test pins one fixed entry to one fixed hash, so any accidental format change fails CI.

### 2.2 Genesis hash

`GENESIS_HASH = "0".repeat(64)` (Requirement 5.3). Every group's chain starts from it.

**Why one shared genesis value is safe.** Every entry's hash covers its `groupId` (field 2). An entry copied into another group's chain would need a different `groupId`, which changes its hash and breaks the link to the next entry. Two groups' first entries therefore never share a hash, and chains can't be spliced across groups. A genesis derived per group would add nothing that the hashed `groupId` doesn't already give.

### 2.3 Timestamps

- `LedgerWriter` reads the clock once per append, **after** taking the group lock (so the head it compares with is final): `occurredAt = max(clock().toISOString(), head.occurredAt)`. Clamping to the head time stops small clock skew between server instances from causing `OUT_OF_ORDER` errors.
- That exact string goes into the entry, the hash and the `INSERT` (as a text parameter cast to `timestamptz`).
- `ledger_entries.occurred_at` has **no default**. A `CHECK (occurred_at = date_trunc('milliseconds', occurred_at))` rejects any value with sub-millisecond precision rather than rounding it silently. No trigger modifies it.
- Reads never use driver date parsing:
  - `to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` for timestamps;
  - `to_char(due_date, 'YYYY-MM-DD')` for dates;
  - `::text` for bigints, parsed by zod into safe integers.
- A PGlite property test inserts random millisecond timestamps and checks that each one reads back byte-identical and that `verifyChain` passes.
- `ledger_entries` has no DB-assigned timestamp columns at all.

## 3. Database schema

One migration per concern: `<ts>_ledger_core_schema.sql`, `<ts>_ledger_core_triggers.sql` and `<ts>_ledger_core_security.sql` (R17 checkpoints were dropped; no checkpoints migration).

```sql
create table groups (
  id uuid primary key,
  code text not null unique check (code ~ '^[A-Z0-9]{4,8}$'),
  name text not null check (length(name) between 1 and 60),
  interest_rate_bps integer not null,
  loan_multiplier integer not null,
  max_term_months integer not null,
  min_deposit bigint not null check (min_deposit > 0),
  cycle_start date not null,
  cycle_end date not null,
  created_at timestamptz not null
);

create table members (
  id uuid primary key,
  group_id uuid not null references groups(id),
  display_name text not null,
  phone text not null unique check (phone ~ '^\+256[0-9]{9}$'),
  role text not null check (role in ('member','chair','treasurer','secretary')),
  status text not null check (status in ('active','suspended')),
  registered_by uuid references members(id),
  registered_at timestamptz not null,
  auth_user_id uuid unique references auth.users(id)
);

create table ledger_entries (
  id uuid primary key,
  group_id uuid not null references groups(id),
  seq bigint not null check (seq >= 1),
  type text not null check (type in ('DEPOSIT_REQUEST','DEPOSIT_CONFIRMATION','SOCIAL_FUND_CONTRIBUTION',
        'LOAN_REQUEST','LOAN_APPROVAL','LOAN_REJECTION','LOAN_DISBURSEMENT','LOAN_REPAYMENT','REVERSAL')),
  subject_member_id uuid not null references members(id),
  actor_member_id uuid references members(id),
  occurred_at timestamptz not null check (occurred_at = date_trunc('milliseconds', occurred_at)),
  channel text not null check (channel in ('ussd','dashboard','seed','system')),
  idempotency_key text,
  amount bigint check (amount > 0),
  loan_id uuid,
  term_months integer,
  interest_amount bigint check (interest_amount >= 0),
  due_date date,
  reverses_entry_id uuid references ledger_entries(id),
  confirms_entry_id uuid references ledger_entries(id),
  reason text,
  prev_hash char(64) not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash char(64) not null check (hash ~ '^[0-9a-f]{64}$'),
  unique (group_id, seq),
  constraint ledger_entries_shape check ( /* per-type presence of optional columns, R4.3-4.4 */ )
);
-- PIN credentials live apart from members so grants stay column-precise.
-- ledger-core creates the table and its grants; ussd-engine owns the PIN and lockout logic.
create table member_credentials (
  member_id uuid primary key references members(id),
  pin_hash text,                                   -- null until the first dial sets a PIN
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz
);

create unique index ledger_entries_idem on ledger_entries (group_id, idempotency_key)
  where idempotency_key is not null;
create index ledger_entries_loan on ledger_entries (group_id, loan_id) where loan_id is not null;
```

- **DB checks are shape-only.** They cover types, enums, positivity and which columns each type uses. Business rules such as limits, states and balances stay in the domain (R13.7). There are no balance or status columns (R7.8).
- **Credentials apart from members.** `members` has no PIN columns. `registerMember` (and the seed) inserts a `member_credentials` row with `pin_hash = null` in the same transaction as the member (R3.8). `ghost_readonly` never gets access to `member_credentials`.
- **`auth.users` in PGlite.** That table exists in Supabase. The PGlite test bootstrap creates a stub `auth.users (id uuid primary key)` plus the `anon`, `authenticated` and `service_role` roles before it applies the migrations.

## 4. Triggers

```sql
create function gl_reject_mutation() returns trigger language plpgsql as $$
begin
  raise exception using errcode = 'GL000',
    message = format('%s is append-only: %s rejected', tg_table_name, tg_op);
end $$;

create trigger ledger_entries_append_only before update or delete on ledger_entries
  for each row execute function gl_reject_mutation();
create trigger ledger_entries_no_truncate before truncate on ledger_entries
  for each statement execute function gl_reject_mutation();
-- same two triggers on groups (rules are fixed, R2.3).
-- members and member_credentials: a DELETE/TRUNCATE-only trigger. Updates are controlled by grants (section 6).

create function gl_check_chain_link() returns trigger language plpgsql as $$
declare last record;
begin
  perform pg_advisory_xact_lock(7001, hashtext(new.group_id::text));
  select seq, hash, occurred_at into last from ledger_entries
    where group_id = new.group_id order by seq desc limit 1;
  if not found then
    if new.seq <> 1 or new.prev_hash <> repeat('0', 64) then
      raise exception using errcode = 'GL001', message = 'chain link: bad genesis entry';
    end if;
  elsif new.seq <> last.seq + 1 or new.prev_hash <> last.hash then
    raise exception using errcode = 'GL001', message = format('chain link: expected seq %s', last.seq + 1);
  elsif new.occurred_at < last.occurred_at then
    raise exception using errcode = 'GL002', message = 'chain link: occurred_at before head';
  end if;
  return new;
end $$;

create trigger ledger_entries_chain_link before insert on ledger_entries
  for each row execute function gl_check_chain_link();
```

The database checks linkage (`seq`, `prev_hash`, time order) but does not recompute hashes. Doing that would mean a second copy of the canonical format in SQL. Wrong hashes are caught by `verifyChain`. Correctly hashed but rule-breaking entries written directly by an insider are caught by `detectAnomalies`.

## 5. Concurrent appends

`LedgerWriter.execute(groupId, commands, opts)`:

1. `BEGIN` at **READ COMMITTED** (the default; see the note below).
2. `SELECT pg_advisory_xact_lock(7001, hashtext($groupId))`. This is the same key the trigger uses. Advisory locks are re-entrant within a session, so the trigger's second call returns at once. The lock is released at commit or rollback.
3. If `idempotencyKey` is set, look up entries with key `<key>:0`, `<key>:1`, and so on. If they exist, return them and stop (R13.6).
4. Load the group, its members and its entries, then `replay` them into a `LedgerState`.
5. `executeAll(state, commands, ctx)` with `ctx.now` from section 2.3. A domain error rolls back and returns the error (R8.2).
6. Insert each sealed entry with **its own `INSERT` statement**, in `seq` order. Each one then fires the chain-link trigger against the row inserted just before it. Entry *i* of a batch gets idempotency key `<key>:<i>`.
7. `COMMIT`.

How this keeps the chain from forking:

- **Normal path.** Two writers for the same group queue on the lock in step 2. The second one replays after the first has committed, so its `seq` and `prev_hash` are correct.
- **Clients that skip the lock**, such as `psql` or an insider: the trigger takes the same lock before reading the head, and rejects a stale `seq` or `prev_hash` with `GL001`. `unique (group_id, seq)` is the last backstop (`23505`).
- **Retry.** `GL001`, `GL002` and `23505` (on `(group_id, seq)` or the idempotency key) count as conflicts. `GL002` can only happen when a client skipped the lock, because the writer clamps to the head time after locking. The writer retries the whole transaction up to 3 times. After that it returns `{ code: 'CHAIN_CONFLICT', retryable: true }` (R13.5).
- **Why READ COMMITTED matters.** At this level each statement takes a fresh snapshot, so reads issued after the lock is granted see the other writer's commit. Under REPEATABLE READ the snapshot would be taken by the lock statement itself, *before* the wait, and the replay would be stale. The writer sets the isolation level explicitly.

Lock keys come from `hashtext(uuid)`, so two groups can collide. A collision only makes those two groups wait for each other; it never breaks correctness.

### 5.1 Supabase transaction pooler

On Vercel, the app and the MCP server connect through Supabase's transaction pooler (Supavisor, port 6543). Each transaction may run on a different server connection, so nothing may rely on session state:

- **Locks.** Advisory locks must be transaction-scoped: use `pg_advisory_xact_lock`, never `pg_advisory_lock`. A session lock could outlive the transaction on a pooled connection that another client then uses, or never be released. Lint can't catch this, so a unit test greps `src/` and `supabase/` for `pg_advisory_lock(` and fails if it finds one.
- **No session settings.** Set the isolation level with `BEGIN ISOLATION LEVEL READ COMMITTED` on every write transaction. Use `SET LOCAL` only inside a transaction, never plain `SET`. No `LISTEN`/`NOTIFY` and no temporary tables.
- **Prepared statements off.** Transaction-mode poolers don't reliably support named prepared statements. With node-postgres (`pg`), never pass a `name` in a query config. Plain parameterized queries use the unnamed statement and are safe. If the driver ever changes (e.g. to postgres.js), it must be set to `prepare: false`.
- **Small pools.** Use `max: 1` per serverless instance on Vercel, because the pooler does the pooling.
- **SSL.** Every non-local connection uses TLS with full verification (CA and hostname) against the Supabase CA in `DATABASE_CA_CERT`. See §14.
- **Admin connections.** Migrations, seed and the demo scripts use the direct (session) connection string, `ADMIN_DATABASE_URL`, not the pooler. `ALTER TABLE` and multi-statement admin work should not go through the transaction pooler.

## 6. Roles, grants and RLS

### 6.1 Roles and connection strings

| Role | Used by | Connection string | Owns tables? |
|------|---------|-------------------|--------------|
| `postgres` (table owner) | migrations, seed, `db:roles-login`, tamper/restore scripts | `ADMIN_DATABASE_URL` (direct, not pooled) | yes |
| `ghost_app` | Next.js app at runtime (USSD, dashboard writes) | `DATABASE_URL` (transaction pooler) | no |
| `ghost_readonly` | MCP server and agent | `READONLY_DATABASE_URL` (transaction pooler) | no |

Neither runtime role owns any table. Only the owner can run `ALTER TABLE … DISABLE TRIGGER`, so a compromised app server cannot switch off the append-only trigger. The tamper and restore scripts refuse to run unless `current_user` owns `ledger_entries`.

### 6.2 Privilege matrix

| Table | `ghost_app` | `ghost_readonly` | `anon`, `authenticated` |
|-------|-------------|------------------|-------------------------|
| `groups` | SELECT | SELECT | none |
| `members` | SELECT, INSERT | SELECT | none |
| `member_credentials` | SELECT, INSERT (`member_id`), UPDATE (`pin_hash`, `failed_attempts`, `locked_until`) | none | none |
| `ledger_entries` | SELECT, INSERT | SELECT | none |

No role except the owner gets `UPDATE` on `ledger_entries`, or `DELETE`, `TRUNCATE`, `REFERENCES` or `TRIGGER` on anything. A blocked update fails twice over: first the missing privilege, then the trigger for the owner. `ghost_app` can't touch `member_credentials.member_id` after insert, so a PIN can't be moved to another member.

### 6.3 Migration `<ts>_ledger_core_security.sql`

```sql
do $$ begin   -- roles are cluster-wide; the guard keeps `supabase db reset` re-runnable
  if not exists (select from pg_roles where rolname = 'ghost_app') then create role ghost_app nologin; end if;
  if not exists (select from pg_roles where rolname = 'ghost_readonly') then create role ghost_readonly nologin; end if;
end $$;

grant usage on schema public to ghost_app, ghost_readonly;
grant select on groups, members, member_credentials, ledger_entries to ghost_app;
grant insert on members, ledger_entries to ghost_app;
grant insert (member_id) on member_credentials to ghost_app;
grant update (pin_hash, failed_attempts, locked_until) on member_credentials to ghost_app;
grant select on groups, members, ledger_entries to ghost_readonly;   -- explicit tables, no default privileges

-- every table:
alter table <t> enable row level security;
revoke all on <t> from anon, authenticated, service_role;
alter default privileges in schema public revoke all on tables from anon, authenticated, service_role;   -- future tables too
create policy app_select on <t> for select to ghost_app using (true);          -- tables ghost_app may read
create policy app_insert on <t> for insert to ghost_app with check (true);     -- members, member_credentials
create policy app_insert on ledger_entries for insert to ghost_app
  with check (channel <> 'seed');                                              -- R4.13: only the owner seeds
create policy app_update on member_credentials for update to ghost_app using (true) with check (true);
create policy readonly_select on <t> for select to ghost_readonly using (true); -- not member_credentials
```

- **RLS applies to both runtime roles**, because they are not owners. They need the `using (true)` policies above, or they see zero rows and every insert fails. Real protection comes from the grants. RLS is there so that the Supabase API roles (`anon`, `authenticated`) get nothing.
- **`revoke all` from `anon`, `authenticated` and `service_role`**, plus the same revoke in default privileges for future tables, is belt and braces. `service_role` bypasses RLS, so only the missing grants keep it out. Supabase grants broad privileges to those roles by default, and `TRUNCATE` is not subject to RLS.
- **Logins.** Migrations must not contain passwords. `npm run db:roles-login` runs as the owner and sets `LOGIN PASSWORD` on `ghost_app` and `ghost_readonly` from `APP_DB_PASSWORD` and `READONLY_DB_PASSWORD`, using `pg`'s `escapeLiteral`. Through Supavisor, the username takes the form `ghost_app.<project-ref>`.
- **Functions.** The chain-link trigger runs with the inserting role's privileges. `ghost_app` has `SELECT` on `ledger_entries`, and `pg_advisory_xact_lock` and `hashtext` are executable by `PUBLIC`, so no `SECURITY DEFINER` is needed.

### 6.4 Tests

These PGlite tests run in `npm test`. The probe already confirmed that `SET ROLE`, column grants and RLS behave correctly in PGlite.

- **Matrix test.** It walks every table in `public` and every role in §6.2. It compares `has_table_privilege` and `has_column_privilege` against the matrix, which lives in the test file as data. A table that is missing from the matrix fails the test, so later specs must declare their grants. It also asserts RLS is enabled on every table.
- **Behaviour as `ghost_app`** (`SET ROLE ghost_app`):
  - it can insert a valid entry;
  - `UPDATE`/`DELETE` on `ledger_entries` fail with `permission denied`;
  - `ALTER TABLE ledger_entries DISABLE TRIGGER …` fails with `must be owner`;
  - `INSERT` into `groups` is denied;
  - updating `pin_hash`, `failed_attempts` and `locked_until` succeeds;
  - updating `member_credentials.member_id` and any `members` column is denied.
- **Behaviour as `ghost_readonly`:**
  - it can select from `groups`, `members` and `ledger_entries`;
  - `member_credentials` is denied;
  - every `INSERT` is denied.
- **Behaviour as `anon`:** all tables return zero rows or permission errors.
- **Writer as `ghost_app`.** The `LedgerWriter` and `registerMember` test suites run with `SET ROLE ghost_app`, which proves the grants are enough for real use.
- **Tamper as owner.** The tamper and restore tests run as the owner. A further test checks that they refuse to run as `ghost_app`.

## 7. Domain module layout (`src/domain`)

| File | Contents |
|------|----------|
| `result.ts` | `Result<T, E>`, `ok`, `err` |
| `errors.ts` | `DomainError` discriminated union of every error code in the requirements |
| `money.ts` | `Ugx` brand, `MAX_ENTRY_AMOUNT`, `parseUgx`, `computeInterest`, `formatUgx` (`"UGX 5,000"`) |
| `time.ts` | ISO validation, `kampalaDate`, `kampalaHour`, `addCalendarMonths` (clamped), `kampalaDaysBetween` |
| `group.ts` | `GroupRules`, `createGroup` |
| `member.ts` | `normalizePhone`, `validateDisplayName` (GSM-7), `registerMember` |
| `entry.ts` | `LedgerEntry` (union by `type`), `EntryDraft`, zod `ledgerEntrySchema` |
| `canonical.ts` | `canonicalize`, `hashEntry`, `GENESIS_HASH` |
| `chain.ts` | `seal(draft, head)`, `verifyChain(entries, opts?)` |
| `replay.ts` | `LedgerState`, `replay`, `applyEntry` |
| `commands.ts` | `Command` union, `execute`, `executeAll`; invariant check (R8) |
| `loans.ts` | `loanLimit`, loan views, `listOverdueLoans` |
| `anomalies.ts` | `detectAnomalies`, rules, `DEFAULT_THRESHOLDS` |
| `index.ts` | public API (everything below). Other layers import only from here. |
| `testing/arbitraries.ts` | fast-check generators (test-only) |

### 7.1 Public domain API

```ts
type IsoTimestamp = string;        // YYYY-MM-DDTHH:mm:ss.sssZ
type Uuid = string;                // lowercase

interface CommandContext {
  now: IsoTimestamp; newId: () => Uuid;
  channel: Channel; actorMemberId: Uuid | null; idempotencyKey?: string;
}
type Command =
  | { kind: 'requestDeposit'; memberId: Uuid; amount: number }       // DEPOSIT_REQUEST, no balance change
  | { kind: 'confirmDeposit'; requestEntryId: Uuid }                 // DEPOSIT_CONFIRMATION by another leader
  | { kind: 'contributeSocialFund'; memberId: Uuid; amount: number }
  | { kind: 'requestLoan'; memberId: Uuid; principal: number; termMonths: number }
  | { kind: 'approveLoan'; loanId: Uuid }
  | { kind: 'rejectLoan'; loanId: Uuid; reason: string }
  | { kind: 'disburseLoan'; loanId: Uuid }
  | { kind: 'repayLoan'; memberId: Uuid; amount: number }
  | { kind: 'reverseEntry'; entryId: Uuid; reason: string };

execute(state: LedgerState, cmd: Command, ctx: CommandContext):
  Result<{ entry: LedgerEntry; state: LedgerState }, DomainError>;
executeAll(state, cmds: Command[], ctx): Result<{ entries: LedgerEntry[]; state: LedgerState }, DomainError>;

replay(group: Group, members: Member[], entries: LedgerEntry[]): LedgerState;
memberSummary(state, memberId): MemberSummary | null;  // savings, socialFund, loans[], loanLimit
groupSummary(state): GroupSummary;                      // totals, cash, pending loans
listOverdueLoans(state, asOf: IsoTimestamp): OverdueLoan[];

verifyChain(entries: unknown[]): VerifyResult;
// VerifyResult = { ok: true; count; headSeq; headHash }
//              | { ok: false; seq: number | null; reason: 'HASH_MISMATCH' | 'PREV_HASH_MISMATCH'
//                  | 'SEQUENCE_GAP' | 'MALFORMED_ENTRY' }

detectAnomalies(input: { group; members; entries; asOf; thresholds?: Partial<Thresholds> }): Anomaly[];
// Anomaly = { id: `${rule}:${firstEntryId}`, rule, severity, memberId, entryIds, explanation }

createGroup(input): Result<Group, DomainError>;
registerMember(registrar: Member, input: { displayName; phone }, ctx): Result<Member, DomainError>;
normalizePhone(raw: string): Result<Phone, DomainError>;
formatUgx(amount: number): string;
```

Key behaviours:

- **`execute`.** It validates the command against `state`, builds a draft, seals it (`seq = head + 1`, `prevHash = head.hash` or genesis, `hash`), then applies it. It returns an error if any balance in R8.1 would go negative. On error the input state is returned untouched.
- **`replay` / `applyEntry` are total.** They never throw, even on forged entries (for example a disbursement with no approval). Invariants hold for every ledger produced by commands. Forged ledgers are reported, not "fixed".
- **Reversals.** Leaders only (R4.12). A reversal undoes its target using the target's amount. Reversing a disbursement returns the loan to `approved`. Reversing a repayment returns the loan to `disbursed` if it had reached `repaid`. Reversing a deposit confirmation removes the savings; the request stays `confirmed` (consumed), so a correction is a new request.
- **Money-in rule (R9.9).** `confirmDeposit`, `repayLoan` and `contributeSocialFund` require an active leader of the group who is not the credited member (`NOT_A_LEADER`, then `SELF_APPROVAL`), checked right after the member lookup. Deposit and loan *requests* stay member actions.
- **Deposits (R9).** `requestDeposit` checks the member, amount and minimum; on the dashboard the actor must be a leader. It records a `DEPOSIT_REQUEST` with status `pending` and changes no balance. `confirmDeposit` checks, in order: the request exists and is `pending` (`INVALID_DEPOSIT_STATE`), the actor is a leader (`NOT_A_LEADER`), the actor isn't the depositor (`SELF_APPROVAL`). It then records a `DEPOSIT_CONFIRMATION` with the request's member and amount and `confirmsEntryId` = the request id. Savings, and so loan limits, come from confirmations only.
- **Seed channel.** The domain accepts `channel: 'seed'` (the seed builder uses the real commands). Runtime can't use it: `LedgerWriter.execute` types its channel as `'ussd' | 'dashboard'`, and the `ghost_app` insert policy rejects `seed` rows (§6.3).
- **Interest.** `computeInterest = ceil(p × bps × m / 10000)`, computed as `Math.floor((p*bps*m + 9999) / 10000)`. The product is at most 5e7 × 3000 × 12 = 1.8e12, well under 2^53. A property test compares it with a BigInt version (R1.4).
- **Due date.** Take the Kampala date of the disbursement and add the term in months, clamping the day to the month length. A loan is overdue when `kampalaDate(asOf) > dueDate`. Days overdue are counted in Kampala calendar days.
- **Anomaly windows.** Each anomaly rule collects the windows that meet its threshold, anchored at each entry. Windows that share entries are merged transitively, giving one anomaly per merged cluster (R12.8). Entries after `asOf` are ignored. Output is sorted by first `seq`, then rule.

## 8. Interfaces for other specs (`src/db`)

```ts
interface Db { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
               transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>; }
fromPgPool(pool: pg.Pool): Db;               // runtime
fromPglite(db: PGlite): Db;                  // src/db/testing only

interface LedgerReader {
  getGroup(id): Promise<Group | null>;
  getGroupByCode(code): Promise<Group | null>;
  listMembers(groupId): Promise<Member[]>;
  getMemberByPhone(phone): Promise<Member | null>;          // ussd-engine
  getMemberByAuthUserId(authUserId): Promise<Member | null>; // dashboard sign-in
  listEntries(groupId): Promise<LedgerEntry[]>;
  loadState(groupId): Promise<LedgerState | null>;
}
interface LedgerWriter extends LedgerReader {
  execute(groupId, commands: Command[], opts: { channel; actorMemberId; idempotencyKey? }):
    Promise<Result<LedgerEntry[], DomainError | { code: 'CHAIN_CONFLICT'; retryable: true }>>;
  registerMember(groupId, registrarId, input): Promise<Result<Member, DomainError>>;
}
createLedgerReader(db: Db): LedgerReader;            // MCP and agent: READONLY_DATABASE_URL (ghost_readonly)
createLedgerWriter(db: Db, deps: { clock: () => Date; newId: () => Uuid }): LedgerWriter;  // app: DATABASE_URL (ghost_app)
```

- **MCP and agent code receive only a `LedgerReader`** built on the `ghost_readonly` connection. Read-only is enforced both by the TypeScript types and by database privileges.
- **Dashboard "Approve"** is `execute(groupId, [approveLoan, disburseLoan], ...)`. This is one transaction producing two entries (R10.17).
- **`registerMember`** inserts the member and its empty `member_credentials` row in one transaction. It maps a `23505` error on `members.phone` to `PHONE_ALREADY_REGISTERED`.
- **Credentials.** Reading and updating `member_credentials` (PIN hash, attempts, lockout) is designed in ussd-engine. ledger-core only provides the table and the grants.

## 9. Seed and demo scripts

**`src/seed/build-seed.ts`** is pure: `buildSeed(anchorDate) → { group, members, entries }`. It uses domain commands with a deterministic id generator (UUID-shaped values derived from a counter), so the same anchor date always gives the same data (R14.7).

- **Group.** "Tubeera Together Savings Group", code `TUBEERA`. Rules: 1,000 bps (10% per month), multiplier 3, max term 3 months, minimum deposit UGX 2,000. The cycle starts at anchor − 91 days.
- **Members.** 12 fictional names. One each of chair, treasurer and secretary; the other 9 are members.
- **History.** 13 weekly meetings on Saturday at 10:00 Kampala time, channel `seed`. Savings deposits are UGX 5,000 to 20,000 per member, each a `DEPOSIT_REQUEST` confirmed by the treasurer (or by the chair for the treasurer's own deposits). Social fund is UGX 1,000 per member.
- **Loans.** About 5 loans, each going through request, approval by a different leader, then disbursement. All are repaid or not yet due, except **one overdue**: disbursed about 70 days before the anchor for 1 month, and partly repaid.
- **Planted loan.** A `LOAN_DISBURSEMENT` at 02:13 Kampala time, about 10 days before the anchor:
  - actor: the secretary;
  - channel: `dashboard`;
  - borrower: an ordinary member with no other loan;
  - principal: above 3× that member's savings but below group cash;
  - no request and no approval.
  It is sealed with `seal()` but skips `execute()` validation (R14.4, R14.8). Being a single entry, it doesn't trigger `OUT_OF_HOURS_BURST`.
- **Demo accounts.** The chair and treasurer get the two demo accounts (R14.11), so neither demo login is the insider.

**`scripts/seed.ts`** (`npm run db:seed [-- --anchor YYYY-MM-DD]`):

1. Check that `ADMIN_DATABASE_URL` is set and `NODE_ENV` is not production (R14.10). Seeding inserts groups, which `ghost_app` can't do, so the seed runs as the owner. Check that group `TUBEERA` doesn't exist yet (R14.9).
2. Create the 2 Auth users with the Supabase Admin API (`auth.admin.createUser`, `email_confirm: true`):
   - emails `tubeera.chair@example.com` and `tubeera.treasurer@example.com` (the domain is reserved and never receives mail);
   - password from `DEMO_LEADER_PASSWORD`;
   - needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. **The service-role key must never be in the app's environment** (Vercel or `.env.local` for `next dev`): it bypasses RLS and every grant. Only this script, run from a developer machine, reads it.
3. Insert the group, members (with `auth_user_id`), empty credential rows and entries in one transaction.

The Auth step sits behind an `AuthAdmin` interface, so tests use a fake.

**`scripts/demo-tamper.ts`** and **`scripts/demo-restore.ts`** (R15):

- Both refuse to run unless `ALLOW_TAMPER_DEMO=true`.
- Both connect only with `ADMIN_DATABASE_URL`, the separate privileged connection, and never with `DATABASE_URL` (`ghost_app`). Before changing anything, they check that `current_user` owns `ledger_entries` and exit if it doesn't.
- **Tamper** targets the first `DEPOSIT_CONFIRMATION` with `seq >= 10` (or `--seq N`). In one transaction it runs `ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only; UPDATE … SET amount = amount + 50000; ENABLE TRIGGER …`, then prints the seq and the before and after values.
- **Restore** is stateless. It runs `verifyChain`, takes the first `HASH_MISMATCH` entry, and checks that `amount − 50000` reproduces the stored hash. Only then does it write that value back, the same way. Otherwise it refuses.
- Both work on PGlite: the probe confirmed `DISABLE TRIGGER` inside a transaction. They are tested there.

## 10. Environment variables (this spec)

| Variable | Used by | Notes |
|----------|---------|-------|
| `DATABASE_URL` | app runtime | `ghost_app` through the transaction pooler |
| `READONLY_DATABASE_URL` | MCP server, agent | `ghost_readonly` through the transaction pooler |
| `ADMIN_DATABASE_URL` | migrations, seed, `db:roles-login`, demo scripts | table owner, direct connection; never used by the app |
| `APP_DB_PASSWORD`, `READONLY_DB_PASSWORD` | `db:roles-login` | set the runtime roles' login passwords |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | seed only | creates demo Auth users |
| `DEMO_LEADER_PASSWORD` | seed only | password for both demo leaders |
| `ALLOW_TAMPER_DEMO` | demo scripts | must be `true` |
| `INTEGRATION_DATABASE_URL` | `test:integration` | defaults to local Supabase; only localhost allowed |
| `DATABASE_CA_CERT` | every non-local connection (app, scripts) | PEM text of the Supabase CA (`prod-ca-2021.crt`); public, not a secret |
| `ALLOW_HOSTED_CHECK` | `hosted:check` | must be `true` |

## 11. Testing

PGlite runs in Vitest's `node` environment. Each DB test file gets a fresh in-memory database: bootstrap stub, then all migrations in filename order. Integration tests are named `*.integration.test.ts`. They are excluded from `npm test` and run by `vitest.integration.config.ts`.

The integration global setup:

1. refuses any non-localhost `INTEGRATION_DATABASE_URL`;
2. connects as the local `postgres` owner;
3. gives `ghost_app` a random per-run password (`ALTER ROLE ghost_app LOGIN PASSWORD …`);
4. runs the concurrency test over a pool of `ghost_app` connections.

So the README command needs no extra password setup.

### 11.1 Properties (fast-check)

Ledgers are generated as random `Command` sequences run through `executeAll`, keeping only accepted commands. "Forged" ledgers add sealed entries that skip validation.

| Id | Property | Requirements |
|----|----------|--------------|
| P1 | `parseUgx` accepts exactly the safe integers in 1..MAX | 1.1, 1.2 |
| P2 | `computeInterest` equals the BigInt ceil reference | 1.3, 1.4 |
| P3 | `createGroup` accepts exactly the in-range rules | 2.2 |
| P4 | every accepted phone format of the same digits normalizes to the same `+256…`; other strings give `INVALID_PHONE` | 3.5, 3.6 |
| P5 | display-name validation matches the length and GSM-7 oracle | 3.4 |
| P6 | command ledgers have contiguous `seq` and correct links | 4.5, 5.3, 5.4 |
| P7 | rebuilding an entry with shuffled keys gives the same hash; changing any one field gives a different canonical string | 5.1, 5.2 |
| P8 | changing any field of any entry (rehashed or not, non-head) fails `verifyChain`; changing the head without a rehash fails | 6.2–6.4, 6.6, 6.7 |
| P9 | `verifyChain` and `detectAnomalies` never throw on `fc.anything()` and are deterministic | 6.5, 6.8, 12.1 |
| P10 | group totals equal the sums of member balances | 7.4 |
| P11 | `replay` is deterministic; replaying a prefix then the rest gives the same state | 7.1, 7.5 |
| P12 | appending a reversal of e changes balances by exactly −effect(e) | 4.6, 7.6 |
| P13 | request, approval and rejection entries leave all balances unchanged | 7.7 |
| P14 | no balance is ever negative in command ledgers | 8.1 |
| P15 | a rejected command leaves the state and head unchanged | 8.2 |
| P16 | deposit requests change no balance; a confirmation or contribution raises the balance by exactly its amount; below-minimum requests are rejected | 9.1–9.3, 9.5 |
| P17 | loan request, approval and disbursement are accepted iff a reference model says so (limit, open loan, term, cash) | 10.1–10.8, 10.13–10.15 |
| P18 | no command ledger has a disbursement without an earlier approval | 10.16 |
| P19 | approve, reject and disburse by a non-leader or by the borrower are always rejected | 10.11, 10.12, 3.3 |
| P20 | due date matches a `Date.UTC` reference, including clamping | 10.9, 10.10 |
| P21 | a repayment is accepted iff amount ≤ outstanding; total repaid ≤ amount owed | 11.1–11.5 |
| P22 | `listOverdueLoans` matches a brute-force filter | 11.6 |
| P23 | command ledgers produce no `DISBURSEMENT_WITHOUT_APPROVAL` and no `LOAN_ABOVE_SAVINGS`; forging either one gets it flagged | 12.3, 12.4, 12.9 |
| P24 | reversal and burst rules match a brute-force oracle on small inputs; each entry appears at most once per rule | 12.5–12.8 |
| P25 | for any anchor date, the seed verifies, has 1 overdue loan and exactly the 2 planted anomalies, and is deterministic | 14.2–14.7 |
| P26 | random millisecond timestamps round-trip through PGlite byte-identical (PGlite; `numRuns` lowered) | 13.7, §2.3 |
| P27 | (dropped with R17) | – |
| P28 | deposit request and confirmation are accepted iff a reference model says so (leader, not self, pending, minimum); every confirmation in a command ledger confirms an earlier pending request by a different leader; loan limits use confirmed savings only | 9.1, 9.2, 9.4–9.8 |
| P29 | reversals by a non-leader are always rejected with `NOT_A_LEADER` | 4.12 |
| P30 | command ledgers produce no `DEPOSIT_WITHOUT_REQUEST`; a forged confirmation (no request, wrong member or amount, double confirmation, self-confirmed) gets it flagged | 12.10 |

### 11.2 Requirement coverage

| Req | Unit (examples) | fast-check | PGlite | Integration |
|-----|-----------------|------------|--------|-------------|
| R1 Money | 0, 1, MAX, MAX+1, 1.5, NaN, `"5000"` | P1, P2 | – | – |
| R2 Groups | one case per out-of-range rule | P3 | groups append-only trigger | – |
| R3 Members | each phone format; `NOT_A_LEADER`; suspended member | P4, P5, P19 | phone unique → `PHONE_ALREADY_REGISTERED`; no PIN column (3.8) | – |
| R4 Entries | each `INVALID_REVERSAL` case; `OUT_OF_ORDER`; non-leader reversal | P6, P12, P29 | shape check rejects wrong columns per type; `ghost_app` can't insert `seed` rows (4.13) | – |
| R5 Hash | golden vector | P6, P7 | – | – |
| R6 Verify | one example per failure reason; 10,000 entries under 2 s | P8, P9 | verify after read-back | – |
| R7 Balances | hand-computed small ledger | P10–P13 | – | – |
| R8 Invariants | `NEGATIVE_BALANCE` names the balance | P14, P15 | – | – |
| R9 Deposits | `BELOW_MIN_DEPOSIT`; `INVALID_DEPOSIT_STATE`; self-confirmation | P16, P28 | – | – |
| R10 Loans | each error code; approve+disburse batch | P17–P20 | 10.17 two-entry atomic append; rollback on second failure | – |
| R11 Repayments | repaid status; `EXCEEDS_OUTSTANDING` includes the amount | P21, P22 | – | – |
| R12 Anomalies | one example per rule; explanation text | P9, P23, P24, P30 | – | – |
| R13 Persistence | writer maps errors and retries (fake `Db`); no `pg_advisory_lock(` in source (§5.1) | P26 | 13.2, 13.3, 13.4, 13.6, 13.7, 13.8, 13.9, 13.12: privilege matrix and role behaviour (§6.4); writer runs as `ghost_app` | 13.5: 20 parallel appends over 10 connections as `ghost_app` → contiguous seq, verified chain |
| R14 Seed | env guards (14.10); Auth step with fake `AuthAdmin` (14.11) | P25 | seed into PGlite; second run refused (14.9) | – |
| R15 Tamper | `ALLOW_TAMPER_DEMO` guard; uses `ADMIN_DATABASE_URL` only | – | tamper → `HASH_MISMATCH` at seq; restore → verified; output text; refuses as `ghost_app` (15.6) | – |
| R16 Property tests | – | test titles name their requirement ids (testing.md) | – | – |
| R17 Checkpoints | dropped | – | – | – |

## 12. Implementation order (for tasks.md)

1. Project scaffolding: Next.js 15, TS strict, ESLint (domain import rules, no focused or skipped tests), Vitest, fast-check, `engines.node: "24.x"`, npm scripts. Then the Kiro hooks and a stub `.kiro/settings/mcp.json`.
2. `result`, `errors`, `money`, `time`.
3. `entry`, `canonical`, `chain` (`seal`, `verifyChain`) with the golden vector.
4. `group`, `member`, `replay`, `commands` (deposits, reversals, invariants).
5. Loan workflow and `loans` (limit, interest, due date, overdue).
6. `anomalies`.
7. Migrations, PGlite harness, and trigger, role and RLS tests.
8. `Db` adapters, `LedgerReader` and `LedgerWriter` (lock, idempotency, retry).
9. Seed builder and seed script (with demo Auth accounts).
10. Tamper and restore scripts.
11. Concurrency integration test, `test:integration`, and README check.
12. ~~R17 checkpoints~~ (dropped at the task 18 review).

## 13. Decisions

1. **Genesis hash.** It stays at 64 zeros (§2.2 explains why that is safe).
2. **App database role.** `ghost_app` is added (§6). It has `SELECT` and `INSERT` on the ledger table, and column-level `UPDATE` only on the credential columns, which live in their own `member_credentials` table.

## 14. Deployment skeleton (task 30)

Goal: one hosted Supabase project and one Vercel deployment that prove the chain works end to end before any UI exists.

### 14.1 Region

Supabase has no African region. The project uses the specific region **Central EU (Frankfurt), `eu-central-1`**, not the "Europe" general region, because a general region may place the project in London or Zurich and the function region could then not be matched. Vercel functions run in **`fra1`** (Frankfurt), set in `vercel.json`. Each USSD request makes several database round trips, so function-to-database latency matters more than Kampala-to-function latency, and same-city placement keeps it in single-digit milliseconds. London (`eu-west-2` / `lhr1`) is an equally valid pair. We have not measured latency from Kampala to either.

### 14.2 Connections

| Who | Variable | Endpoint | Pool |
|-----|----------|----------|------|
| App (Vercel) | `DATABASE_URL` | `ghost_app.<ref>` @ Supavisor transaction mode, port 6543 | `max: 1` |
| `/api/health`, later MCP and agent | `READONLY_DATABASE_URL` | `ghost_readonly.<ref>` @ port 6543 | `max: 1` |
| Migrations, `db:roles-login`, seed, `hosted:check` (owner side) | `ADMIN_DATABASE_URL` | `postgres` direct (`db.<ref>.supabase.co:5432`), or Supavisor **session** mode (port 5432) on IPv4-only networks | `max: 1` |

`createPool(url, { caCert })` in `src/db/db.ts` builds every pool:

- Hosts `localhost`, `127.0.0.1` and `::1` connect without TLS (local Supabase).
- Any other host requires `DATABASE_CA_CERT` and connects with `ssl: { ca, rejectUnauthorized: true }`. Node checks the hostname by default, so this is `verify-full`. Without the CA, it refuses rather than fall back to an unverified connection.
- `sslmode`, `sslrootcert`, `sslcert`, `sslkey` and `uselibpqcompat` are removed from the URL, because `pg` lets URL parameters override the `ssl` object.
- No named prepared statements (§5.1, unchanged).

No Supabase key of any kind is set on Vercel. `appEnv()` and `readonlyEnv()` both refuse to start if `SUPABASE_SERVICE_ROLE_KEY` is present.

### 14.3 `GET /api/health`

Connects as `ghost_readonly` through `READONLY_DATABASE_URL`, loads the seeded group (`TUBEERA`) and its entries, and runs `verifyChain`. Response (JSON, `Cache-Control: no-store`):

| Case | HTTP | Body |
|------|------|------|
| chain verifies | 200 | `{ status: "verified", group, entries, headSeq, headHash, dbRole, region }` |
| chain fails | 200 | `{ status: "failed", group, entries, failedAtSeq, reason, dbRole, region }` |
| group not seeded | 404 | `{ status: "not_seeded", group }` |
| env or database error | 503 | `{ status: "error" }`, nothing else; the server logs only the error class and code |

`dbRole` is `current_user`, so the URL itself shows which role the deployment uses. `region` is `VERCEL_REGION` (null locally).

### 14.4 Scripts

- `npm run db:deploy` (`scripts/deploy-db.ts`): checks every variable it needs before starting, then runs `supabase db push --db-url $ADMIN_DATABASE_URL`, `db:roles-login` and `db:seed` in order, stopping at the first failure. Refuses local hosts (local uses `supabase db reset`). The service-role key stays in the shell (README).
- `npm run hosted:check -- --url <deployment URL>` (`scripts/hosted-check.ts`), gated by `ALLOW_HOSTED_CHECK=true`:
  1. `GET <url>/api/health` returns `verified`, `dbRole` `ghost_readonly` and `region` `fra1`.
  2. The privilege matrix (`checkPrivileges`, §6.4) has no mismatches on the hosted database.
  3. `DATABASE_URL` is the transaction pooler (port 6543) and `current_user` there is `ghost_app`.
  4. Concurrent appends through the pooler: the owner creates a separate check group (code `CHK` + 5 random characters, never `TUBEERA`) with 10 members; 10 independent `max: 1` pools, as 10 serverless instances would have, each append one deposit request at the same time. Seq is contiguous 1..10 and `verifyChain` passes. These rows are permanent (append-only), so they live in their own group.
  5. `GET /api/health` still returns `verified`.
  It prints one PASS or FAIL line per check and exits non-zero on any FAIL.
