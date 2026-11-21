-- ai-agent-mcp: per-leader daily message count for POST /api/agent (design §6).
-- Not part of the ledger: rows are updated in place by design.
create table agent_usage (
  member_id uuid not null references members (id),
  day       date not null,
  messages  integer not null check (messages >= 1),
  primary key (member_id, day)
);

revoke all on agent_usage from public, anon, authenticated, service_role;
grant select, insert on agent_usage to ghost_app;
grant update (messages) on agent_usage to ghost_app;

alter table agent_usage enable row level security;
create policy app_select on agent_usage for select to ghost_app using (true);
create policy app_insert on agent_usage for insert to ghost_app with check (true);
create policy app_update on agent_usage for update to ghost_app using (true) with check (true);
-- ghost_readonly and the Supabase API roles get no grant and no policy.
