-- ledger-core: tables (design §3).
--
-- Checks are shape-only and mirror the TypeScript entry schema
-- (src/domain/entry.ts) exactly; business rules stay in the domain (R13.7).
-- There are no balance or loan-status columns (R7.8): state is derived by
-- replaying ledger_entries.

create table groups (
  id uuid primary key,
  code text not null unique check (code ~ '^[A-Z0-9]{4,8}$'),
  name text not null check (char_length(name) between 1 and 60 and btrim(name) <> ''),
  interest_rate_bps integer not null check (interest_rate_bps between 0 and 3000),
  loan_multiplier integer not null check (loan_multiplier between 1 and 5),
  max_term_months integer not null check (max_term_months between 1 and 12),
  min_deposit bigint not null check (min_deposit between 1 and 50000000),
  cycle_start date not null,
  cycle_end date not null,
  created_at timestamptz not null,
  constraint groups_cycle check (cycle_end > cycle_start)
);

create table members (
  id uuid primary key,
  group_id uuid not null references groups(id),
  -- Trimmed, 1 to 30 characters from the GSM 03.38 basic set (R3.4), like validateDisplayName.
  display_name text not null check (
    char_length(display_name) between 1 and 30
    and display_name = btrim(display_name, ' ')
    and display_name ~ '^[@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&''()*+,./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà-]+$'
  ),
  -- Normalized Uganda mobile number (R3.5), like normalizePhone.
  phone text not null unique check (phone ~ '^\+2567[0-9]{8}$'),
  role text not null check (role in ('member', 'chair', 'treasurer', 'secretary')),
  status text not null check (status in ('active', 'suspended')),
  registered_by uuid references members(id),
  registered_at timestamptz not null,
  auth_user_id uuid unique references auth.users(id)
);

create table ledger_entries (
  id uuid primary key,
  group_id uuid not null references groups(id),
  seq bigint not null check (seq >= 1),
  type text not null check (type in (
    'DEPOSIT_REQUEST', 'DEPOSIT_CONFIRMATION', 'SOCIAL_FUND_CONTRIBUTION',
    'LOAN_REQUEST', 'LOAN_APPROVAL', 'LOAN_REJECTION', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'REVERSAL'
  )),
  subject_member_id uuid not null references members(id),
  actor_member_id uuid references members(id),
  -- Millisecond precision, stored exactly as hashed (design §2.3); years 1970 to 9998 like isIsoTimestamp.
  occurred_at timestamptz not null check (
    occurred_at = date_trunc('milliseconds', occurred_at)
    and occurred_at >= '1970-01-01T00:00:00Z' and occurred_at < '9999-01-01T00:00:00Z'
  ),
  channel text not null check (channel in ('ussd', 'dashboard', 'seed', 'system')),
  idempotency_key text check (char_length(idempotency_key) between 1 and 128),
  amount bigint check (amount between 1 and 50000000),
  loan_id uuid,
  term_months integer check (term_months between 1 and 12),
  interest_amount bigint check (interest_amount >= 0),
  due_date date check (due_date between '1970-01-01' and '9998-12-31'),
  reverses_entry_id uuid references ledger_entries(id),
  confirms_entry_id uuid references ledger_entries(id),
  reason text check (char_length(reason) between 1 and 120),
  prev_hash char(64) not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash char(64) not null check (hash ~ '^[0-9a-f]{64}$'),
  unique (group_id, seq),

  -- R4.3, R4.4: which optional columns each type records. Every other column is null.
  constraint ledger_entries_shape check (
    (amount is not null) = (type in ('DEPOSIT_REQUEST', 'DEPOSIT_CONFIRMATION', 'SOCIAL_FUND_CONTRIBUTION',
                                     'LOAN_REQUEST', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'REVERSAL'))
    and (loan_id is not null) = (type in ('LOAN_REQUEST', 'LOAN_APPROVAL', 'LOAN_REJECTION', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT'))
    and (term_months is not null) = (type in ('LOAN_REQUEST', 'LOAN_DISBURSEMENT'))
    and (interest_amount is not null) = (type = 'LOAN_DISBURSEMENT')
    and (due_date is not null) = (type = 'LOAN_DISBURSEMENT')
    and (reverses_entry_id is not null) = (type = 'REVERSAL')
    and (confirms_entry_id is not null) = (type = 'DEPOSIT_CONFIRMATION')
    and (reason is not null) = (type in ('LOAN_REJECTION', 'REVERSAL'))
  ),

  -- R4.10: ussd = the subject themselves; dashboard = someone; seed = optional; system = no one.
  -- `is not distinct from` because a NULL comparison would make the check pass.
  constraint ledger_entries_actor_channel check (
    (channel = 'ussd' and actor_member_id is not distinct from subject_member_id)
    or (channel = 'dashboard' and actor_member_id is not null)
    or channel = 'seed'
    or (channel = 'system' and actor_member_id is null)
  )
);

create unique index ledger_entries_idem on ledger_entries (group_id, idempotency_key)
  where idempotency_key is not null;
create index ledger_entries_loan on ledger_entries (group_id, loan_id) where loan_id is not null;

-- PIN credentials live apart from members so grants stay column-precise (R3.8).
-- ledger-core creates the table and its grants; ussd-engine owns the PIN and lockout logic.
create table member_credentials (
  member_id uuid primary key references members(id),
  pin_hash text,                                   -- null until the first dial sets a PIN
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz
);
