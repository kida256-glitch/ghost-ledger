-- ledger-core: append-only and chain-link triggers (design §4).

-- Rejects any change to an append-only table (R13.2, R2.3, R17.2).
create function gl_reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception using
    errcode = 'GL000',
    message = format('%s is append-only: %s rejected', tg_table_name, tg_op);
end
$$;

create trigger ledger_entries_append_only before update or delete on ledger_entries
  for each row execute function gl_reject_mutation();
create trigger ledger_entries_no_truncate before truncate on ledger_entries
  for each statement execute function gl_reject_mutation();

-- Group rules are fixed once created (R2.3).
create trigger groups_append_only before update or delete on groups
  for each row execute function gl_reject_mutation();
create trigger groups_no_truncate before truncate on groups
  for each statement execute function gl_reject_mutation();

-- Members and credentials are never removed. Their updates are controlled by grants (§6).
create trigger members_no_delete before delete on members
  for each row execute function gl_reject_mutation();
create trigger members_no_truncate before truncate on members
  for each statement execute function gl_reject_mutation();
create trigger member_credentials_no_delete before delete on member_credentials
  for each row execute function gl_reject_mutation();
create trigger member_credentials_no_truncate before truncate on member_credentials
  for each statement execute function gl_reject_mutation();

-- R13.3: each insert must extend the group's chain by exactly one link.
-- Takes the same transaction-scoped advisory lock as LedgerWriter (design §5),
-- so clients that skip the writer still can't fork the chain. Transaction-scoped
-- only: session locks are unsafe behind the transaction pooler (§5.1).
create function gl_check_chain_link() returns trigger
language plpgsql as $$
declare
  last record;
begin
  perform pg_advisory_xact_lock(7001, hashtext(new.group_id::text));
  select seq, hash, occurred_at into last
    from ledger_entries
    where group_id = new.group_id
    order by seq desc
    limit 1;
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
end
$$;

create trigger ledger_entries_chain_link before insert on ledger_entries
  for each row execute function gl_check_chain_link();
