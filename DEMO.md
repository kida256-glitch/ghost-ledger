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

## 5. Health endpoint, locally

```powershell
# After sections 1 and 2. The runtime roles need login passwords first:
$env:ADMIN_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:56322/postgres"
$env:APP_DB_PASSWORD = "local-app-password-0001"
$env:READONLY_DB_PASSWORD = "local-ro-password-00001"
npm run db:roles-login

$env:READONLY_DATABASE_URL = "postgresql://ghost_readonly:local-ro-password-00001@127.0.0.1:56322/postgres"
npm run build
npx next start -p 3000
# In a browser: http://localhost:3000/api/health  ->  "status":"verified", "dbRole":"ghost_readonly"
```

## 6. USSD endpoint, locally

After sections 1, 2 and 5 (roles with login passwords), with the app running as `ghost_app`:

```powershell
$env:DATABASE_URL = "postgresql://ghost_app:local-app-password-0001@127.0.0.1:56322/postgres"
$env:READONLY_DATABASE_URL = "postgresql://ghost_readonly:local-ro-password-00001@127.0.0.1:56322/postgres"
npm run build
npx next start -p 3000
```

In a second PowerShell window, this function sends one gateway request the way Africa's Talking does (form-encoded). `curl.exe` is the real curl that ships with Windows, not the PowerShell alias:

```powershell
function Dial([string]$text, [string]$session = "demo1", [string]$phone = "+256701200012") {
  curl.exe -s http://localhost:3000/api/ussd --data-urlencode "sessionId=$session" --data-urlencode "serviceCode=*384*123#" --data-urlencode "phoneNumber=$phone" --data-urlencode "text=$text"
}

Dial ""                       # CON Welcome Waiswa Henry. Create a 4-digit PIN:
Dial "7391"                   # CON Enter the same PIN again:
Dial "7391*7391"              # END PIN saved. Please dial again ...
Dial "7391" "demo2"           # CON 1 Save / 2 Request loan / ...
Dial "7391*1*5000*1" "demo2"  # END Request sent: UGX 5,000. A leader will confirm it.
Dial "7391*1*5000*1" "demo2"  # the same again: a gateway retry, nothing new is recorded
Dial "7391*4" "demo3"         # END Savings ... Waiting UGX 5,000 (1) ...
Dial "" "demo4" "+256700999999"  # END This number is not registered ...
```

Each `text` is every choice so far joined by `*`, with the PIN first. A new `session` value starts a new session. The server log prints one line per request with the screen and outcome only, never the text, the PIN or the phone number.

## 7. Stop local Supabase

```powershell
npx supabase stop
```

## Hosted deployment (Supabase + Vercel)

Region: Supabase **Central EU (Frankfurt), `eu-central-1`**, chosen as a *specific* region, not the "Europe" general region. Vercel functions run in **`fra1`** (Frankfurt), set in `vercel.json`. Supabase has no African region, and each USSD request makes several database round trips, so the function and the database sit in the same city. See design §14.1.

### What you click (once)

1. **Supabase: create the project.** [supabase.com/dashboard](https://supabase.com/dashboard) → New project → name `ghost-ledger`, region **Central EU (Frankfurt)** (open the region list and pick the specific region). Save the database password it generates.
2. **Supabase: copy three things.**
   - *Connect* → *Session pooler* URI (port 5432), for `ADMIN_DATABASE_URL`. The direct connection (`db.<ref>.supabase.co`) also works if your network has IPv6.
   - *Connect* → *Transaction pooler* URI (port 6543). You'll swap its user name for `ghost_app.<ref>` and `ghost_readonly.<ref>`.
   - *Project Settings* → *Database* → *SSL Configuration* → *Download certificate* (`prod-ca-2021.crt`). Save it in the repo root; `.gitignore` ignores `*.crt`.
   - *Project Settings* → *API Keys*: the project URL and the `service_role` / secret key, for the seed only.
3. **Run the database setup** from your machine (next section).
4. **Vercel: import the repo.** [vercel.com/new](https://vercel.com/new) → import the GitHub repo. Framework: Next.js (auto-detected). Before the first deploy, open *Environment Variables* and add exactly these three, for Production (and Preview if you want previews to work):
   - `DATABASE_URL` = the transaction-pooler URI with user `ghost_app.<ref>` and the `APP_DB_PASSWORD` you chose;
   - `READONLY_DATABASE_URL` = the same URI with user `ghost_readonly.<ref>` and the `READONLY_DB_PASSWORD`;
   - `DATABASE_CA_CERT` = the full text of `prod-ca-2021.crt`, including the `BEGIN`/`END` lines.
   No Supabase key of any kind, and no `ADMIN_DATABASE_URL`. The app refuses to start if `SUPABASE_SERVICE_ROLE_KEY` is set.
5. **Vercel: Node version.** *Settings* → *Build and Deployment* → *Node.js Version* → **24.x**. Then deploy (or redeploy).
6. **Check it.** Open `https://<your-deployment>.vercel.app/api/health`: you should see `"status":"verified"`, `"dbRole":"ghost_readonly"`, `"region":"fra1"`. Then run the hosted check below.

### Database setup (step 3), PowerShell

```powershell
# Owner connection (session pooler or direct). Replace <ref>, <db-password>, <host>.
$env:ADMIN_DATABASE_URL = "postgresql://postgres.<ref>:<db-password>@<host>.pooler.supabase.com:5432/postgres"
$env:DATABASE_CA_CERT = Get-Content -Raw .\prod-ca-2021.crt

# Login passwords for the runtime roles (16+ characters each). You'll paste these into Vercel's URLs.
$env:APP_DB_PASSWORD = "<choose one>"
$env:READONLY_DB_PASSWORD = "<choose another>"

# Seed only: the demo leader logins. The service-role key lives in this shell, nowhere else.
$env:SUPABASE_URL = "https://<ref>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<service_role / secret key>"
$env:DEMO_LEADER_PASSWORD = "<12+ characters>"

# 1. supabase db push (answer Y)  2. db:roles-login  3. db:seed. Stops at the first failure.
npm run db:deploy

Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
```

`db:deploy` checks every variable before it starts and refuses a local database. Passwords that contain `@`, `:`, `/` or `#` must be percent-encoded in the URLs.

### Hosted check, PowerShell

```powershell
$env:ADMIN_DATABASE_URL = "postgresql://postgres.<ref>:<db-password>@<host>.pooler.supabase.com:5432/postgres"
$env:DATABASE_URL = "postgresql://ghost_app.<ref>:<APP_DB_PASSWORD>@<host>.pooler.supabase.com:6543/postgres"
$env:DATABASE_CA_CERT = Get-Content -Raw .\prod-ca-2021.crt
$env:ALLOW_HOSTED_CHECK = "true"
npm run hosted:check -- --url https://<your-deployment>.vercel.app
```

Expected: five `PASS` lines (health before, privilege matrix, pooler as `ghost_app`, 10 concurrent appends, health after). The concurrent-append check writes 10 deposit requests into a new group named `CHK…`. Those rows are permanent, because the ledger is append-only; they never touch `TUBEERA`.
