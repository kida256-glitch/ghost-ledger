# Design: dashboard-simulator

## 1. Overview

```
browser ──cookies──▶ middleware.ts (refresh session, getClaims)
   │
   ├─ /login            server action signIn → Supabase Auth (publishable key, server only)
   ├─ /dashboard/**     server components: requireLeader() → reader (ghost_readonly) → domain views + offers
   │                    server actions:    leaderAction() → LedgerWriter (ghost_app) → domain commands
   └─ /simulator        client component → fetch POST /api/ussd (form-encoded)
```

- No Supabase client runs in the browser. Sign-in, sign-out and session checks are all server-side, using `@supabase/ssr` (a new dependency) with Next.js cookies.
- Reads use the `ghost_readonly` pool (`READONLY_DATABASE_URL`). Writes use the `ghost_app` pool (`DATABASE_URL`). Both have max 1 connection per instance.

## 2. Code layout

| Path | Contents |
|------|----------|
| `src/lib/auth/supabase-server.ts` | `createServerClient` with the Next.js `cookies()` adapter; `getAuthUserId()` from `getClaims()` (`sub`) |
| `middleware.ts` (repo root, Next 15 name) | Session refresh, per the Supabase SSR guide, for `/dashboard/:path*` and `/login`. Copies refreshed cookies and cache headers onto the response |
| `src/app/dashboard/_lib/session.ts` | `requireLeader(deps)` → `{ leader, group }`, or `redirect`/`NotALeader`. `Session` interface for tests |
| `src/app/dashboard/_lib/offers.ts` | **Pure.** `buildOffers(state, leader, now)` → per-item offers, or a reason they aren't offered |
| `src/app/dashboard/_lib/views.ts` | **Pure.** View models for each page: overview totals, member rows, ledger page, alerts |
| `src/app/dashboard/_lib/actions-core.ts` | **Pure of Next.js.** `runAction(kind, rawInput, deps)` with zod inputs, auth, then the writer. Returns `ActionResult` |
| `src/app/dashboard/_lib/messages.ts` | `Record<WriteError["code"] \| "NOT_SIGNED_IN" \| "NOT_A_LEADER" \| "BAD_INPUT", string>` |
| `src/app/dashboard/actions.ts` | `"use server"` exports: one thin wrapper per action around `runAction`, plus `revalidatePath` |
| `src/app/dashboard/**/page.tsx`, `loading.tsx`, `error.tsx` | Pages, skeletons and error boundaries |
| `src/components/ui/*` | Design-system components (§7) |
| `src/app/simulator/page.tsx` + `Phone.tsx` (client) | Simulator |

## 3. Auth and sessions (D1)

- **Env.** `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` go into `appEnv()`, required for the dashboard only. They are server-only names, not `NEXT_PUBLIC_*`. The publishable key gives the `anon` role, which has no grants on any table (ledger-core R13.9), so it exposes no data. **This changes the earlier rule "no Supabase key of any kind on Vercel"** to "no service-role key on Vercel". The `appEnv()` refusal of `SUPABASE_SERVICE_ROLE_KEY` stays.
- **Sign-in.** A server action calls `supabase.auth.signInWithPassword` and redirects to `/dashboard`. On failure it always shows "Email or password is wrong", whatever the cause. It is rate-limited by Supabase Auth's own limits.
- **Each request.** `getClaims()` verifies the JWT. With asymmetric signing keys, the default for new projects, it verifies locally against cached JWKS, with no network call. Then `reader.getMemberByAuthUserId(sub)`, then `isLeaderOf(member, member.groupId)`.
- **Vercel.** The cookies are `sb-<ref>-auth-token`. Middleware refreshes them, and every dashboard route is `dynamic = "force-dynamic"` with `Cache-Control: private, no-store`, so a refreshed `Set-Cookie` is never cached.
- **Demo sign-in hint (approved).** The login page shows the two demo emails, and the password when the server env `DEMO_LEADER_PASSWORD_HINT` is set. On Vercel it is set to the same value used by the seed.
- **Sign-ups off.** `supabase/config.toml` sets `[auth] enable_signup = false`. The hosted checklist turns off "Allow new users to sign up" in *Authentication → Sign In / Providers*. `auth.admin.createUser` still works.
- **Demo notice.** The dashboard layout shows a slim banner: "Demo group: fictional people. Every action is permanent: the ledger is append-only."

## 4. Offers (D5–D8, D14.1)

`buildOffers` dry-runs exactly the command that each action would send, as the signed-in leader, on channel `dashboard`. Dry runs never go behind the head time.

| Item | Offered when the dry run succeeds | Otherwise shown |
|------|----------------------|-----------------|
| Pending deposit | `confirmDeposit(requestEntryId)` | message for the error (e.g. `SELF_APPROVAL` → "Another leader must confirm your own deposit") |
| Requested loan | `executeAll([approveLoan, disburseLoan])` | reason, e.g. `INSUFFICIENT_GROUP_CASH`. Reject is offered whenever `rejectLoan` with a placeholder reason dry-runs OK |
| Cash-in members | repayment: members with `activeLoan`, excluding the leader, with `outstanding`. Social fund: active members except the leader | n/a. The amount is decided by the domain on submit |
| Ledger entry (visible page only) | `reverseEntry(entryId, "x")` | no button |

The server never trusts an offer. Each action re-runs the real command through the writer, inside its lock, so a stale page can only produce a domain error message, never a wrong write.

## 5. Server actions (D13, D14.2, D14.3)

```ts
type ActionKind = "registerMember" | "confirmDeposit" | "approveLoan" | "rejectLoan" | "recordRepayment" | "recordSocialFund" | "reverseEntry";
type ActionResult = { ok: true; message: string } | { ok: false; code: ActionErrorCode; message: string; field?: string };
runAction(kind, raw: unknown, deps: { session: Session; reader; writer; now }): Promise<ActionResult>
```

1. zod-parse `raw` for the kind: uuids, amounts as digit strings up to 9 digits, reason 1–120 characters, name and phone as strings, and `idempotencyKey` matching `^dash:[0-9a-f]{32}$`. Bad input gives `BAD_INPUT`.
2. Session: `requireLeader`. No session gives `NOT_SIGNED_IN`; not an active leader gives `NOT_A_LEADER`. Nothing is written in either case.
3. Build the commands from the parsed input. `groupId` and actor always come from the session. The member id for cash-in comes from the input, and the domain rejects ids outside the group (`MEMBER_NOT_FOUND`).
4. `writer.execute(group.id, commands, { channel: "dashboard", actorMemberId: leader.id, idempotencyKey })`, or `writer.registerMember(group.id, leader.id, { displayName, phone })`.
5. Map the result to a message. Any exception gives `{ ok: false, code: "UNAVAILABLE" }` with a generic message, and a log line with only the action kind and error class.

Parse comes before auth, so garbage never reaches the database, and auth comes before any read of the input's ids. `actions.ts` contains only one-line wrappers, and a source test checks that every export in it calls `runAction`. The form uses React 19 `useActionState`, so results and field errors render inline without client-side data access.

**Idempotency.** Each form renders `dash:` + 32 random hex characters into a hidden input. A double submit, or the browser resending the POST, returns the first result.

## 6. Pages (D3–D12)

| Route | Shows | Data |
|-------|-------|------|
| `/` | Landing: what Ghost Ledger is; buttons for Simulator and Leader dashboard | none |
| `/login` | Email, password, demo hint | none |
| `/dashboard` | Overview cards, chain status, alert count, agent placeholder | `groupSummary`, `listOverdueLoans`, `verifyChain`, `detectAnomalies` |
| `/dashboard/members` | List, plus a "Register member" sheet | `memberSummary` per member |
| `/dashboard/deposits` | Pending requests with Confirm | `groupSummary.pendingDeposits` + offers |
| `/dashboard/loans` | Requests with Approve/Reject; active loans | `pendingLoans`, `loanView`, offers |
| `/dashboard/cash` | Record repayment / social fund (segmented control) | offers |
| `/dashboard/ledger?page=N` | Status banner, entries, Reverse sheet | `listEntries`, `verifyChain` |
| `/dashboard/alerts` | Alerts | `detectAnomalies` |
| `/simulator` | Phone and demo panel | `DEMO_PINS` + seed member names and phones (static) |

- Each dashboard request loads the state once (`reader.listEntries` then `replay`, about 500 entries) and passes it to the views.
- The layout shows the group name, the leader's name and role, the chain banner when the chain fails (D9.3), and the bottom tab bar: Home, Members, Deposits, Loans, More. More holds Cash-in, Ledger, Alerts and Sign out.
- On desktop the tab bar becomes a left rail.

## 7. Visual identity (D2)

- **Tokens** in `globals.css` as Tailwind v4 `@theme`:
  - background `#0b0d12` and surface `#141821`;
  - text `#e6e8ef` and muted `#8b93a7`;
  - accent "ectoplasm" green `#7cf5c4`;
  - danger `#ff6b6b`, warning `#f5c26b`, info `#7aa7ff`;
  - radius 14 px, 8 px spacing scale;
  - system font stack, with tabular numerals for money.
- **Ghost motif:** an inline SVG ghost logo, a small floating ghost in empty states, and an "ectoplasm" glow on the verified chain badge. A broken-chain badge turns red with a cracked-link icon. No external image or font requests.
- **Components** (`src/components/ui`): `Card`, `Stat`, `Button` (primary, secondary, danger; pending state), `Sheet` (bottom sheet on mobile, dialog on desktop), `Field`, `Badge`, `ChainStatus`, `EmptyState`, `ErrorState`, `Skeleton`, `TabBar`, `Money`, `Time`.
- **States:** every route segment has a `loading.tsx` with skeletons shaped like the content and an `error.tsx` showing "Something went wrong" with a retry button (`reset`). Empty lists use `EmptyState` with a sentence about what would appear there.
- **Accessibility:** 44 px touch targets, visible focus rings, contrast at least 4.5:1, `aria-live` for action results.

## 8. Simulator (D12)

- `Phone` is a client component: a bezel, a 20-character-wide monospace screen, a reply area that scrolls, a keypad (0–9, `*`, `#`, Send, Clear, End) and a text input for keyboards.
- **State in memory only:** `sessionId` (`crypto.randomUUID()` per session), `steps: string[]` and `phone`. It POSTs `URLSearchParams({ sessionId, serviceCode: "*384*123#", phoneNumber, text: steps.join("*") })` to `/api/ussd` and renders the reply without its `CON `/`END ` prefix. `END` closes the session.
- **PIN masking (D12.4):** a typed-history line masks the first step after the first dial (the PIN, or the two PIN-setup steps) as `****`. The phone screen itself shows only server replies, which never echo PINs.
- **Demo panel:** server-rendered from `DEMO_PINS` and `buildSeed("2026-11-20").members` (names and phones don't depend on the anchor). It has tap-to-dial rows, a "fictional group" note, and the Waiswa Henry note. It also says that if a demo PIN is locked, the operator runs `npm run demo:unlock`.
- **Rate limit:** judges sharing one demo phone share its limit (30 requests per 5 minutes). The panel suggests choosing different members.

## 8a. Demo operations (D15)

- **Rate limit.** `env.ts` parses `USSD_RATE_LIMIT_MAX` (default 30). `UssdDeps.rateLimitMax` replaces the `RATE_LIMIT_MAX` constant in the engine. The route passes it from `appEnv()`.
- **Friendly rate-limit message.** The simulator page (a server component) renders the `RATE_LIMITED` screen in every registered language and passes the strings to the client, which compares each reply (`isRateLimited` in `src/app/simulator/sim.ts`). The client never imports the USSD engine, which depends on the domain and `node:crypto`.
- **Seed additions (R14.12).** At the last meeting, after the regular round: deposit requests from the chair and from Birungi Joan (seed channel, actor = member), and a loan request from Okello David (80,000 for 2 months). They don't change the anomaly or overdue counts.
- **`demo:reset`** (`scripts/demo-reset.ts`, logic in `scripts/demo-reset-core.ts`). It follows the tamper script's pattern: the `ALLOW_DEMO_RESET` flag and an owner check. In one transaction:
  1. Read the TUBEERA member rows, keeping each member's `auth_user_id` (the chair and treasurer logins). Refuse if the group or either login is missing.
  2. `alter table … disable trigger` for `ledger_entries_append_only`, `groups_append_only`, `members_no_delete` and `member_credentials_no_delete`.
  3. Delete the group's entries, then its credentials, then its rate-limit rows (by phone hash), then its members, then the group.
  4. Enable the triggers again.
  5. Insert `buildSeed(today)` through the same `insertSeed` used by `db:seed`, with the kept logins and the demo PIN hashes.

  `ALTER TABLE` is transactional, so a failure rolls everything back, triggers included. It prints counts only. No service-role key is needed, because the logins are reused.

## 9. Testing

| Property | Requirement | How |
|----------|-------------|-----|
| DP1 | D14.1, D5.2, D6.2, D8.2 | Ledgers from `scenarioArb` (real domain commands). Any active leader as viewer, with "now" after the head. For every offer, sending the offered command through `executeAll` on the state succeeds. For every pending deposit and requested loan, the dry-run verdict equals "offered", so nothing acceptable is hidden. Cash-in lists exclude the leader, and every repayment row has an active loan. |
| DP2 | D14.2, D1.4, D1.5 | Any session kind (none, unknown `sub`, ordinary member, suspended leader, leader of another group) × any kind × arbitrary raw input (valid shapes and garbage). `runAction` returns `NOT_SIGNED_IN`, `NOT_A_LEADER` or `BAD_INPUT`, and a recording fake writer saw no call. |
| DP3 | D14.3, D13.1, D13.2 | Signed-in leader × any kind × arbitrary raw input against a fake writer that runs the real domain (the ussd `FakeWorld` pattern). It never throws, every result has a non-empty message, and every write issued uses channel `dashboard`, the leader as actor and the leader's group. |

Example tests:

- `messages.ts` covers every code (type-level, plus one runtime check per code).
- `requireLeader` cases.
- Each action end to end on PGlite through the real writer as `ghost_app`, including Approve writing two entries and a double submit writing once.
- Views: overview totals equal the domain summaries, the ledger page order and pagination, and the chain banner after a tamper.
- A source test that `actions.ts` exports only `runAction` wrappers, and that no file under `src/app` imports `pg`, `../db/rows` SQL or `@supabase/supabase-js`. Only `src/lib/auth` imports `@supabase/ssr`.
- The middleware matcher and cookie copy, with a fake request.
- The simulator's request builder, END handling and PIN masking (a pure helper).

Integration and E2E:

- The integration test gains a check that the seeded leader can sign in with the publishable key against local Supabase, that `getClaims` returns their id, and that `anon` still reads nothing.
- `hosted:check` gains two checks: `/dashboard` without a session redirects to `/login`, and `/simulator` returns 200.
- Playwright (optional, last) automates the DEMO.md walkthrough (D16). Until then, D16 is checked by hand in task 9, against local Supabase.

## 10. Decisions

1. **The publishable key on Vercel** (§3). Needed for Supabase Auth. Safe because `anon` has no table grants and RLS has no anon policies. The README and the DEMO.md checklist are updated.
2. **The demo password hint** on the login page (§3). Needs your approval.
3. **Server actions, not API routes,** for writes: forms work with progressive enhancement and React 19 `useActionState`, and Next.js checks that the request's Origin matches the host. Every action authorizes itself (D1.4). Page-level checks are not relied on.
4. **Reads use `ghost_readonly`, writes use `ghost_app`.** This is least privilege for page rendering. It costs one more max-1 pool per instance.
5. **No new chart library.** The overview uses stat cards. Any charts can be added later.
