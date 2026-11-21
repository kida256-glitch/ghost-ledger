# npm run test:e2e  (Windows PowerShell)
#
# Runs the DEMO.md walkthrough with Playwright against `next start` and this
# project's local Supabase. It resets the local database first, so it only
# ever touches the local demo data. Needs Docker running and `npx supabase start`.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$sb = @{}
npx supabase status -o env | ForEach-Object { if ($_ -match '^([A-Z_]+)="?(.*?)"?$') { $sb[$Matches[1]] = $Matches[2] } }
if ($sb.API_URL -notmatch '^http://127\.0\.0\.1:') { throw "local Supabase is not running (npx supabase start)" }

npx supabase db reset
$env:ADMIN_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:56322/postgres"
$env:APP_DB_PASSWORD = "local-app-password-0001"
$env:READONLY_DB_PASSWORD = "local-ro-password-00001"
npm run db:roles-login
$env:SUPABASE_URL = $sb.API_URL
$env:SUPABASE_SERVICE_ROLE_KEY = $sb.SERVICE_ROLE_KEY
$env:DEMO_LEADER_PASSWORD = "tubeera-demo-2026"
npm run db:seed
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY

$env:SUPABASE_PUBLISHABLE_KEY = $sb.PUBLISHABLE_KEY
$env:DEMO_LEADER_PASSWORD_HINT = "tubeera-demo-2026"
$env:DATABASE_URL = "postgresql://ghost_app:local-app-password-0001@127.0.0.1:56322/postgres"
$env:READONLY_DATABASE_URL = "postgresql://ghost_readonly:local-ro-password-00001@127.0.0.1:56322/postgres"
$env:ALLOW_TAMPER_DEMO = "true"

npm run build
npx playwright test @args
$code = $LASTEXITCODE
Remove-Item Env:ALLOW_TAMPER_DEMO
exit $code
