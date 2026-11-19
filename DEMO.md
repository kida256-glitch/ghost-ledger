# Ghost Ledger demo commands (local, Windows PowerShell)

Every command below runs from the repository root in Windows PowerShell 5.1 or PowerShell 7. Each section starts from a fresh shell, so it sets every variable it needs. Variables set with `$env:` last only for that PowerShell window. Nothing is written to a file.

Prerequisites: Node 24, `npm install` done, Docker Desktop running.

This project's local Supabase uses ports 56320–56329 (`supabase/config.toml`), so the database is at `127.0.0.1:56322` and the API at `127.0.0.1:56321`.

## 1. Start local Supabase and apply the migrations

```powershell
npx supabase start
npx supabase db reset
```

`db reset` drops the local database, reapplies `supabase/migrations/`, and deletes local Auth users. Run it before seeding again, and before each integration-test run, because ledger entries can't be deleted.

## 2. Seed the demo group

```powershell
# Table owner, direct connection. All group, member and ledger rows go in through this.
$env:ADMIN_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:56322/postgres"

# Supabase Auth admin API, used only to create the two demo leader logins.
# The local service-role key comes from `supabase status`, into this shell only.
$sb = @{}
npx supabase status -o env | ForEach-Object { if ($_ -match '^([A-Z_]+)="?(.*?)"?$') { $sb[$Matches[1]] = $Matches[2] } }
$env:SUPABASE_URL = $sb.API_URL
$env:SUPABASE_SERVICE_ROLE_KEY = $sb.SERVICE_ROLE_KEY

# Password for both demo logins (tubeera.chair@example.com, tubeera.treasurer@example.com). 12+ characters.
$env:DEMO_LEADER_PASSWORD = "tubeera-demo-2026"

npm run db:seed -- --anchor 2026-11-20

# Drop the key from this shell as soon as the seed is done.
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
```

Expected output ends with `seeded TUBEERA: 12 members, 489 entries, anchor 2026-11-20`. Without `--anchor`, the seed uses today's date in Africa/Kampala. A second run prints `group TUBEERA already exists; nothing changed`; run `npx supabase db reset` first to seed again.

The seed refuses to run if `SUPABASE_SERVICE_ROLE_KEY` is assigned in any `.env*` file in the repository root. Keep it in the shell.

## 3. Tamper with a past entry, then restore it

```powershell
$env:ADMIN_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:56322/postgres"
$env:ALLOW_TAMPER_DEMO = "true"

# Raises the amount of one past deposit confirmation directly in the database
# (default: the first one at seq 10 or later). Chain verification now fails at that entry.
npm run demo:tamper
# Or choose a specific deposit confirmation (other entry types are refused):
# npm run demo:tamper -- --seq 11

# Finds the broken entry and puts the original amount back (it checks the hash first).
# Chain verification passes again.
npm run demo:restore

Remove-Item Env:ALLOW_TAMPER_DEMO
```

Expected: `tampered entry seq 11 (DEPOSIT_CONFIRMATION): amount UGX 13,000 -> UGX 63,000`, then `restored entry seq 11 …`. Refusals go to stderr, which Windows PowerShell 5.1 shows as a red `NativeCommandError` block; the message inside it is the refusal reason.

Both scripts connect as the table owner, briefly disable the append-only trigger inside one transaction, and refuse unless `ALLOW_TAMPER_DEMO` is exactly `true`. Only use them on a demo database.

## 4. Integration tests (concurrency and privileges)

```powershell
npx supabase db reset
# Optional: this is already the default.
$env:INTEGRATION_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:56322/postgres"
npm run test:integration
```

Expected: `Tests  7 passed (7)`. The run refuses any host other than `127.0.0.1` or `localhost`.

## 5. Stop local Supabase

```powershell
npx supabase stop
```
