-- ussd-engine: member language preference and per-phone rate limits (design §6).

-- U13.1: the language a member chose on USSD.
alter table member_credentials
  add column ussd_language text not null default 'en' check (ussd_language in ('en', 'lg'));
grant update (ussd_language) on member_credentials to ghost_app;

-- U5: fixed-window request counts per phone number. The key is the SHA-256 of
-- the normalized number, so the table holds no phone numbers. Not part of the
-- ledger: rows are updated in place by design.
create table ussd_rate_limits (
  phone_hash   text primary key check (phone_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  hits         integer not null check (hits >= 1)
);

revoke all on ussd_rate_limits from public, anon, authenticated, service_role;
grant select, insert on ussd_rate_limits to ghost_app;
grant update (window_start, hits) on ussd_rate_limits to ghost_app;

alter table ussd_rate_limits enable row level security;
create policy app_select on ussd_rate_limits for select to ghost_app using (true);
create policy app_insert on ussd_rate_limits for insert to ghost_app with check (true);
create policy app_update on ussd_rate_limits for update to ghost_app using (true) with check (true);
-- ghost_readonly and the Supabase API roles get no grant and no policy.
