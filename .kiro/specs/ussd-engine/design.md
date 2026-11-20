# Design: ussd-engine

## 1. Overview

```
POST /api/ussd ──zod──▶ handleUssd(request, deps) ──▶ "CON …" | "END …"
                              │
          ┌───────────────────┼─────────────────────────┐
     rate limiter      credentials repo          LedgerWriter (ghost_app)
   (ussd_rate_limits)  (member_credentials)   reads state, dry-runs, appends
```

- `src/ussd/engine.ts`: `handleUssd(req, deps): Promise<string>`. All logic. Dependencies are injected, so tests use in-memory fakes.
- `src/ussd/replay.ts`: pure. Turns the post-PIN tokens into a screen state, or a pending action.
- `src/ussd/screens.ts`: pure. Renders a screen id plus parameters through i18n, then runs `finalize()` (GSM-7 replacement, length guard).
- `src/ussd/pin.ts`: PIN rules, and the `PinHasher` interface with an argon2id implementation.
- `src/ussd/i18n/{en,lg,index}.ts`: message catalogues.
- `src/db/ussd-repo.ts`: rate limiter and credential repo over `Db` (ghost_app).
- `src/app/api/ussd/route.ts`: parses the form, builds the real dependencies once per instance, and returns `text/plain`.

The engine calls the domain (`execute` for dry runs, `memberSummary`, `groupSummary`, `loanLimit`, `computeInterest`, `formatUgx`, `normalizePhone`) and never re-implements its rules (tech.md rule 1).

## 2. Request pipeline

Each step returns a screen and stops, or falls through to the next.

1. **Too long.** More than 20 tokens: `END TOO_LONG`.
2. **Phone.** `normalizePhone` fails: `END NOT_REGISTERED`. No database access.
3. **Rate limit.** `hit(sha256(phone), now)` returns the window count. Over 30: `END RATE_LIMITED`.
4. **Member.** `getMemberByPhone`. None: `NOT_REGISTERED`. Suspended: `SUSPENDED`.
5. **Credentials.** Load `{ pinHash, failedAttempts, lockedUntil, language }`. The language is used from here on.
6. **No PIN yet.** Run PIN setup on the tokens (§4).
7. **Locked.** `lockedUntil > now`: `END LOCKED(time)`.
8. **PIN.** `text` is empty: `CON PIN_ENTER`. Otherwise verify `tokens[0]`. Wrong: count the failure (§4) and return `END PIN_WRONG(left)` or `LOCKED`. Right: reset the count if it is non-zero.
9. **Menu.** `replay(tokens.slice(1), ctx)` (§3). `ctx` loads the replayed `LedgerState` once, lazily, only for screens that need it.
10. **Action.** If replay ends on a confirmed action, run it (§5).

Any exception anywhere becomes `END ERROR`, and the log gets `outcome: "internal_error"`.

## 3. Menu replay

State machine over tokens. Each state has a screen and a transition function `(token, ctx) → state | error`.

| State | Screen | Input |
|-------|--------|-------|
| `main` | `MAIN` | `1`–`6` |
| `save.amount` | `SAVE_AMOUNT(min)` | digits → dry run `requestDeposit`. OK → `save.confirm`. `INVALID_AMOUNT`/`BELOW_MIN_DEPOSIT` → same state with error |
| `save.confirm` | `SAVE_CONFIRM(amount)` | `1` → action, `2` → `main` |
| `loan.amount` | `LOAN_AMOUNT(limit)` | digits → dry run with term 1. `INVALID_AMOUNT`/`EXCEEDS_LOAN_LIMIT` → error |
| `loan.term` | `LOAN_TERM(max)` | digits → dry run `requestLoan(amount, term)`. `INVALID_TERM` → error |
| `loan.confirm` | `LOAN_CONFIRM(p, m, interest, total)` | `1` → action, `2` → `main` |
| `lang` | `LANG` | `1`/`2` → action |

- `0` pops one state from a stack and `00` resets the stack to `[main]`. Both work in every state. `0` at `main` stays at `main`.
- **Entry gating (U9.2).** Choosing `1` dry-runs `requestDeposit(minDeposit)`. `PENDING_DEPOSIT_LIMIT` gives `END SAVE_LIMIT`. Choosing `2` dry-runs `requestLoan(1, 1)`. `OPEN_LOAN_EXISTS` gives `END LOAN_OPEN(status…)`, and `EXCEEDS_LOAN_LIMIT` with limit 0 gives `END LOAN_NO_LIMIT`. Any other dry-run error gives `END` with that error's reason. `3`, `4` and `5` go straight to their `END` info screens.
- **Confirm position (U3.4).** A confirming token that isn't the last token gives `END DIAL_AGAIN`, with no write.
- **Amounts** must match `^[1-9][0-9]{0,8}$`. Anything else is a "digits only" error, without a dry run.
- Interest on the confirm screen comes from `computeInterest` with the group rules, the same function that disbursement uses.
- Dry runs use `execute(state, command, { actorMemberId: member.id, channel: "ussd", now, newId })` and discard the result.

## 4. PINs

- **Rules (U6.2)** are in `checkNewPin(pin, phone)` and return a reason id: `PIN_FORMAT`, `PIN_SAME_DIGITS`, `PIN_SEQUENCE`, `PIN_PHONE`.
- **Setup tokens.** `[]` gives `PIN_CREATE`. `[a]` gives a rule error or `PIN_CONFIRM`. `[a, b]` with `a ≠ b` gives `PIN_MISMATCH`, which restarts setup at the next token. The replay handles `[a, b, c, …]` the same way. When a pair matches, the engine hashes the PIN and runs `setPinIfUnset(memberId, hash)` (`update … where pin_hash is null`), then returns `END PIN_SET`.
  - **Retry (U6.4).** If the PIN is already set when the request arrives, and the tokens are exactly a matching pair that verifies against the stored hash, the engine returns `PIN_SET` again. Any other text is treated as normal PIN entry.
- **Hashing.** argon2id via `@node-rs/argon2` (prebuilt binaries, no node-gyp, works on Vercel), with OWASP minimum parameters: m = 19456 KiB, t = 2, p = 1. Because the engine is stateless, it verifies the PIN on every request of a session (about 6 per session). The property tests use a fake `PinHasher`, and one example test uses the real one.
- **Failures (U7).** One atomic statement:
  ```sql
  update member_credentials
     set failed_attempts = failed_attempts + 1,
         locked_until = case when failed_attempts + 1 >= 5 then $2 + interval '30 minutes' else locked_until end
   where member_id = $1
  returning failed_attempts, locked_until
  ```
  A success with a non-zero count sets `failed_attempts = 0, locked_until = null`. A wrong PIN always ends the session, so later requests never replay a wrong PIN token. A gateway retry of a wrong-PIN request counts twice. That makes lockout come sooner, never later, and is accepted.
- The `LOCKED` and `PIN_WRONG` screens never repeat the PIN.

## 5. Actions and idempotency

- **Save:** `writer.execute(group.id, [{ kind: "requestDeposit", memberId, amount }], { channel: "ussd", actorMemberId: memberId, idempotencyKey })`.
- **Loan:** the same, with `{ kind: "requestLoan", memberId, principal, termMonths }`.
- **Language:** `setLanguage(memberId, lang)`, then `END LANG_DONE` in the new language.
- `idempotencyKey = "ussd:" + sha256hex(sessionId + "\u0000" + tokens.slice(1).join("*"))`, 69 characters. The PIN token is left out on purpose. Keys are readable by `ghost_readonly`, and a 4-digit PIN hashed with a known session id could be brute-forced in 10⁴ tries.
- **Results.** OK gives `SAVE_DONE` or `LOAN_DONE`. `CHAIN_CONFLICT` gives `BUSY`. A domain error gives `END` with that error's reason (U14.2).

## 6. Database (migration `<ts>_ussd_engine.sql`)

```sql
alter table member_credentials
  add column ussd_language text not null default 'en' check (ussd_language in ('en', 'lg'));
grant update (ussd_language) on member_credentials to ghost_app;

create table ussd_rate_limits (
  phone_hash   text primary key check (phone_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  hits         integer not null check (hits >= 1)
);
alter table ussd_rate_limits enable row level security;
revoke all on ussd_rate_limits from public, anon, authenticated, service_role;
grant select, insert on ussd_rate_limits to ghost_app;
grant update (window_start, hits) on ussd_rate_limits to ghost_app;
create policy ussd_rate_limits_app on ussd_rate_limits for all to ghost_app using (true) with check (true);
```

The rate-limit hit is one statement:

```sql
insert into ussd_rate_limits (phone_hash, window_start, hits) values ($1, $2, 1)
on conflict (phone_hash) do update set
  window_start = case when ussd_rate_limits.window_start <= $2 - interval '5 minutes' then $2 else ussd_rate_limits.window_start end,
  hits         = case when ussd_rate_limits.window_start <= $2 - interval '5 minutes' then 1 else ussd_rate_limits.hits + 1 end
returning hits
```

`ghost_readonly` gets nothing on `ussd_rate_limits`. The shared privilege `MATRIX` gains the new table and the new column grant, so PGlite, local Supabase and `hosted:check` all check it. The table is not part of the ledger, and updating it is expected. All of this is pooler-safe: single statements, no session state.

## 7. Screens and i18n

- `Messages` is a typed map from screen id to `(params) => string`. `en.ts` implements every id. `lg.ts` is `Partial<Messages>`, and each entry has a `// DRAFT: not reviewed by a native speaker` comment. `index.ts` registers languages and falls back to English for each missing key.
- Luganda covers `NOT_REGISTERED`, `PIN_CREATE`, `PIN_CONFIRM`, `PIN_ENTER`, `PIN_WRONG`, `MAIN`, `BALANCE`, `SAVE_CONFIRM`, `SAVE_DONE`, `LOAN_CONFIRM`, `LOAN_DONE` and `LANG_DONE`.
- `finalize(screen)` replaces non-GSM-7 characters with `?`. If the screen is still 182 characters or more, it cuts the body and ends it with `..`. This is a guard; the length test makes sure the catalogues never rely on it.
- **Worst-case parameters for the length test:**
  - member amounts `UGX 999,999,999`, and group totals `UGX 999,999,999,999`;
  - a group name clipped to 30 characters on screen (stored names can be 60);
  - a 30-character member name;
  - interest `29.99%`;
  - the date `30/12/2026`;
  - counts up to 99.
- **English drafts** (the length test is what counts):
  - `MAIN`: `CON 1 Save\n2 Request loan\n3 Repay\n4 Balance\n5 Group info\n6 Language`;
  - `BALANCE`: `END Savings UGX {s}\nPending UGX {p} ({n})\nSocial fund UGX {f}\nLoan owed UGX {o}, due {d}\nLoan limit UGX {l}`;
  - `REPAY`: `END You owe UGX {o}, due {d}. Pay a leader at the meeting; they record it.`;
  - `NOT_REGISTERED`: `END This number is not registered. Please ask your group leader to register you.`
- Interest rate text comes from integer basis points (`1000` → `10%`, `250` → `2.5%`), with no floating point.

## 8. Logging

```ts
type UssdLog = { event: "ussd"; screen: ScreenId; outcome: Outcome; code?: DomainErrorCode | "CHAIN_CONFLICT" };
```

`ScreenId`, `Outcome` (`shown`, `wrote`, `idempotent`, `rejected`, `rate_limited`, `locked`, `internal_error`) and the codes are closed lists with no digits in them. The logger takes only `UssdLog`, and a zod schema in the test checks every record. Nothing else in `src/ussd` or the route calls `console`; a source test checks this.

## 9. Route

`POST /api/ussd` reads `await request.text()`, parses it as `URLSearchParams`, and checks it with zod (U1.2 limits). It builds the dependencies once per instance: `appEnv()`, `createRuntimePool`, `createLedgerWriter`, the repos and the argon2 hasher. The response is always HTTP 200 `text/plain`. `runtime = "nodejs"`, `dynamic = "force-dynamic"`.

## 10. Testing

| Property | Requirement | How |
|----------|-------------|-----|
| UP1 | U15.1, U2.1, U2.2 | Arbitrary phone (valid, unknown, garbage), credential state (no PIN, PIN, locked, several failures), and `text` (grammar-biased valid paths mixed with garbage tokens: `**`, letters, 0/00, 1000-character strings). Fakes may throw at random. Check the regex `^(CON|END) `, length < 182, all GSM-7, no throw. |
| UP2 | U15.2, U8 | Same generators, with the PIN chosen per run. Every log record parses with the `UssdLog` schema. The serialized logs contain neither the PIN nor `text` (whenever `text` contains a digit or `*`, which the closed lists can't). |
| UP3 | U15.3, U9 | Ledgers built from the shared arbitraries (real domain commands), any member (active, suspended, leader), and random sessions. A fake writer applies the domain `execute` to its in-memory state. Check that every write is accepted, that every confirm screen matches a command the dry run accepts, that only `requestDeposit`/`requestLoan` for the caller on `ussd` are issued, and that suspended members never see `MAIN`. |

Example tests:

- Each screen and flow: first dial, PIN setup with each rule, mismatch, retry, wrong PIN, 5th failure lock, lock expiry, reset on success.
- Back and main navigation.
- A confirm token followed by more tokens.
- Idempotent retry, checked on PGlite through the real writer.
- Each dry-run error message.
- The `CHAIN_CONFLICT` screen.
- Language switch persisting to the next session.
- Every catalogue string under 182 characters with the worst-case parameters.
- The real argon2 round trip.

Database tests on PGlite:

- The migration and grants (the extended matrix).
- Rate-limit window rollover.
- `setPinIfUnset` sets the PIN only once.
- The failure statement.
- `ghost_readonly` sees nothing in `ussd_rate_limits`.

Route test: form parsing, the U1.2 limits, and the 200 `text/plain` response.

There is no mutation check for this spec.

## 11. Demo support, keep-alive and performance (U16–U18)

- **Demo PINs.** `src/seed/demo-pins.ts` exports `DEMO_PINS`, a map from seed member id to PIN. It covers every seeded member except one ordinary member, who is left for the first-dial demo. `buildSeed` stays unchanged; the seed script hashes each PIN with the same `PinHasher` as the engine and stores it in `member_credentials`. A test checks every demo PIN against `checkNewPin` and the member's phone.
- **`npm run demo:unlock`** (`scripts/demo-unlock.ts`, `ADMIN_DATABASE_URL`, optional `--group CODE`, default `TUBEERA`) runs two statements:
  - `update member_credentials set failed_attempts = 0, locked_until = null` for the group's members;
  - `delete from ussd_rate_limits where phone_hash = any($1)`, with the SHA-256 hashes of the group's phone numbers.

  It refuses if the group doesn't exist, and prints only the two row counts. It needs no `ALLOW_*` flag because it changes no ledger data.
- **Keep-alive.** `vercel.json` gets `"crons": [{ "path": "/api/health", "schedule": "0 6 * * *" }]`, which runs daily at 06:00 UTC (09:00 Kampala). The Hobby plan allows one run per day, and Supabase pauses free projects after 7 days of inactivity, so a daily read through the pooler is enough. A Vercel cron was chosen over a GitHub Actions schedule because it needs no stored URL or secret, and GitHub disables schedules on repositories with no commits for 60 days. The route stays unauthenticated and read-only, so the cron needs no secret.
- **argon2 cost.** The cost is calibrated on this machine, starting from the OWASP minimum (m = 19456 KiB, t = 2, p = 1), and kept only if one verify takes under about 100 ms. The measured value is recorded in §11.1 when task 4 runs. Vercel functions are usually slower per core than a desktop, so the target here is about half of that.
- **Linux build check.** Inside a `node:24` container: `npm ci`, `npm run build`, then a script that imports `@node-rs/argon2` and hashes and verifies a PIN. `@node-rs/argon2` is in Next.js's default `serverExternalPackages`, so the native `.node` file is loaded at runtime, not bundled.
- **Timed USSD request in `hosted:check`.** It POSTs `/api/ussd` twice, cold then warm, as the first demo member with text `<PIN>*4` (Balance). It expects `END ` followed by the English Balance screen. PASS needs a warm time under 2000 ms; the cold time is reported only. The check uses a correct PIN, so it never counts a failure, and each run adds 2 requests to that phone's rate-limit window.

### 11.1 Measured

_Filled in by task 4._

## 12. Decisions

1. **Pending-deposit cap (3) is a domain rule.** It is ledger-core R9.10 with error `PENDING_DEPOSIT_LIMIT`, so the dashboard obeys it too and the engine only dry-runs it (tech.md rule 1). testing.md requires a fast-check property for every domain rule, so ledger-core gets one property, `R9.10`. It does not count toward this spec's three.
2. **The PIN is checked on every request**, because the engine is stateless and the endpoint is public (anyone can POST any phone number through the simulator).
3. **The session ends after PIN setup**, so one session's `text` never mixes setup tokens with login tokens.
4. **New dependency `@node-rs/argon2`.** The alternative, `bcrypt`, is allowed by tech.md but is weaker against GPU attacks.
