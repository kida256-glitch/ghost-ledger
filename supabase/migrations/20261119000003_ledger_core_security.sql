-- ledger-core: roles, grants and Row Level Security (design §6).
--
-- No passwords here: `npm run db:roles-login` sets them from the environment.

-- Roles are cluster-wide; the guard keeps `supabase db reset` re-runnable.
do $$
begin
  if not exists (select from pg_roles where rolname = 'ghost_app') then
    create role ghost_app nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'ghost_readonly') then
    create role ghost_readonly nologin;
  end if;
end
$$;

grant usage on schema public to ghost_app, ghost_readonly;

-- Privilege matrix (design §6.2). Explicit tables, no default privileges.
grant select on groups, members, member_credentials, ledger_entries to ghost_app;
grant insert on members, ledger_entries to ghost_app;
grant insert (member_id) on member_credentials to ghost_app;
grant update (pin_hash, failed_attempts, locked_until) on member_credentials to ghost_app;
grant select on groups, members, ledger_entries to ghost_readonly;

-- Supabase grants broad privileges to its API roles by default; take them all back.
-- (TRUNCATE is not subject to RLS, so the revoke matters, not just the policies.)
revoke all on groups, members, member_credentials, ledger_entries from anon, authenticated;

alter table groups enable row level security;
alter table members enable row level security;
alter table member_credentials enable row level security;
alter table ledger_entries enable row level security;

-- RLS applies to both runtime roles (they own nothing), so each needs explicit
-- policies. The grants above are the real protection; RLS makes sure the
-- Supabase API roles (anon, authenticated) see nothing: they get no policy.
create policy app_select on groups for select to ghost_app using (true);
create policy app_select on members for select to ghost_app using (true);
create policy app_select on member_credentials for select to ghost_app using (true);
create policy app_select on ledger_entries for select to ghost_app using (true);

create policy app_insert on members for insert to ghost_app with check (true);
create policy app_insert on member_credentials for insert to ghost_app with check (true);
-- R4.13: only the table owner (the seed script) may write seed-channel entries.
create policy app_insert on ledger_entries for insert to ghost_app with check (channel <> 'seed');

create policy app_update on member_credentials for update to ghost_app using (true) with check (true);

create policy readonly_select on groups for select to ghost_readonly using (true);
create policy readonly_select on members for select to ghost_readonly using (true);
create policy readonly_select on ledger_entries for select to ghost_readonly using (true);
-- No policy for ghost_readonly on member_credentials: it has no grant either.
