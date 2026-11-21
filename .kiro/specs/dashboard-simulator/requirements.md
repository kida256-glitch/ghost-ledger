# Requirements: dashboard-simulator

## Introduction

This spec covers the leader dashboard and the browser phone simulator. Leaders sign in with Supabase Auth and run the group from a phone-sized web app: overview, members, deposit confirmations, loan decisions, cash-in, reversals, the ledger with its chain status, and anomaly alerts. The simulator lets anyone try the real USSD endpoint without a Ugandan short code. Every write goes through the ledger-core domain commands and `LedgerWriter`. Requirement ids use the prefix `D`.

## Glossary

- **Leader session**: a verified Supabase Auth session whose user maps, through `members.auth_user_id`, to an active member with role chair, treasurer or secretary.
- **Offer**: an action button or form the UI shows for a specific item, for example "Confirm" on one deposit request.
- **Dry run**: running the domain's `execute` on the current replayed state without writing (as in ussd-engine), to learn whether a command would be accepted.

## Requirements

### D1: Sign-in and sessions

1. Leaders SHALL sign in with email and password through Supabase Auth on `/login`. There SHALL be no custom auth.
2. The two seeded leaders (`tubeera.chair@example.com`, `tubeera.treasurer@example.com`) SHALL be able to sign in with the password chosen at seed time.
3. Sessions SHALL be stored in HTTP-only cookies and refreshed by Next.js middleware, so they keep working across Vercel serverless instances.
4. Every dashboard page and every server action SHALL verify the session with `getClaims()` and then load the member by `auth_user_id`. IF there is no valid session, THEN pages SHALL redirect to `/login`. IF the user is not an active leader, THEN the dashboard SHALL show "not a leader" with a sign-out button, and no group data.
5. The group SHALL always come from the signed-in leader's member record, never from request input.
6. Sign-out SHALL clear the session cookies.

### D2: Look and feel

1. The UI SHALL be mobile-first. It SHALL be usable at 360 px wide with one-hand navigation (a bottom tab bar), and it SHALL scale up to laptop widths.
2. It SHALL use one consistent dark visual identity with a ghost motif, defined by shared design tokens and components.
3. Every data view SHALL have a loading state, an empty state and an error state. An error state SHALL NOT show internal details.
4. Amounts SHALL show as `UGX 5,000` and times in Africa/Kampala.

### D3: Overview

1. The overview SHALL show group cash, total savings, total social fund, total outstanding on loans, the number of active members, the number of active loans, the count of overdue loans, and the counts of pending deposit requests and pending loan requests.
2. It SHALL show the chain status (D9.1) and the count of open high-severity alerts, each linking to its page.

### D4: Members

1. The members page SHALL list members with name, phone, role, status, savings, outstanding loan and loan limit.
2. A leader SHALL be able to register a member by name and phone through `LedgerWriter.registerMember`. Domain errors (`INVALID_NAME`, `INVALID_PHONE`, `PHONE_ALREADY_REGISTERED`) SHALL show as messages beside the field.
3. There SHALL be no edit or remove action.

### D5: Deposit requests

1. The deposits page SHALL list pending deposit requests with member, amount and request time, oldest first.
2. "Confirm" SHALL be offered only where a dry run of `confirmDeposit` by the signed-in leader succeeds. On a leader's own request, the UI SHALL show "another leader must confirm" instead.

### D6: Loan requests

1. The loans page SHALL list requested loans with member, principal, term, quoted interest and total, the member's loan limit, and group cash.
2. "Approve" SHALL record `approveLoan` and `disburseLoan` in one `execute` call, so both are written or neither is. It SHALL be offered only where a dry run of both, in order, succeeds. Otherwise the UI SHALL show the reason (for example not enough group cash, or the leader's own loan).
3. "Reject" SHALL require a reason of 1 to 120 characters and record `rejectLoan`.
4. The page SHALL also list active loans with amount owed, due date and overdue status.

### D7: Cash-in

1. A leader SHALL be able to record a loan repayment or a social fund contribution for another member, choosing the member and the amount.
2. The member list SHALL exclude the leader, and for repayments SHALL include only members with an active loan, showing each one's outstanding amount.
3. The domain's rules decide; errors such as `EXCEEDS_OUTSTANDING` and `SELF_APPROVAL` SHALL show as messages.

### D8: Reversals

1. A leader SHALL be able to reverse an entry from the ledger viewer, with a required reason, through `reverseEntry`.
2. "Reverse" SHALL be offered only on entries where a dry run succeeds.

### D9: Ledger viewer

1. The ledger page SHALL show a status banner: "Chain verified" with the entry count and the full head hash, or "Chain failed at seq N" with the failure reason, from `verifyChain` on the stored entries.
2. It SHALL list entries newest first, 50 per page, with seq, Kampala time, type, member, amount, channel, actor and a shortened hash. Each entry SHALL expand to show its full hash and prev_hash.
3. WHILE the chain fails, write actions SHALL stay available, and the banner SHALL be shown on every dashboard page.

### D10: Anomaly alerts

1. The alerts page SHALL list `detectAnomalies` results as of now, high severity first, then newest, each with severity, rule, explanation and links to its entries in the ledger viewer.
2. With no alerts, it SHALL show an empty state that says what is checked.

### D11: Agent chat placeholder

1. The overview SHALL include an agent chat panel with a disabled input and a note that the read-only agent is added by the ai-agent-mcp spec. It SHALL send nothing and call nothing.

### D12: Phone simulator

1. `/simulator` SHALL be public and show a feature-phone screen and keypad (also usable with a keyboard). It SHALL send each step to the real `POST /api/ussd`, with a random `sessionId` per session, `text` built from all choices joined by `*`, and the chosen phone number.
2. A `CON` reply SHALL keep the session open. An `END` reply SHALL end it, and the next input SHALL start a new session.
3. A side panel SHALL list the demo members' names, phone numbers and PINs from `src/seed/demo-pins.ts`, mark the group as fictional, and say that Waiswa Henry has no PIN so the first dial shows PIN setup. Choosing a member SHALL set the phone number.
4. The simulator SHALL show what was typed except PIN positions, which it SHALL mask, and SHALL NOT store `text` anywhere.
5. The page SHALL explain that it writes real deposit and loan requests to the demo ledger, and that leaders confirm or approve them on the dashboard.

### D13: Writes and errors

1. Every dashboard write SHALL go through a server action that calls a domain command via `LedgerWriter.execute` (or `registerMember`) with channel `dashboard` and the signed-in leader as actor. There SHALL be no SQL in actions or pages.
2. Every `WriteError` code SHALL map to a clear English message. The raw code SHALL appear only as small secondary text.
3. Each form SHALL carry an idempotency key generated when it is rendered, so a double submit records once.
4. After a successful write, the affected pages SHALL show fresh data.

### D14: Required properties

1. For any generated ledger and any signed-in leader, every offer the UI builds SHALL be accepted by the domain (for Approve, both steps). Every pending deposit or loan request the leader could act on SHALL be offered.
2. For any caller who is not an active leader of the group (no session, an unknown user, an ordinary member, a suspended leader) and any input, every server action SHALL refuse with `NOT_SIGNED_IN` or `NOT_A_LEADER` and issue no write.
3. For a signed-in leader and any input, including garbage, every server action SHALL return a typed result (success, or an error with a message) and never throw.

## Out of scope

- Editing, suspending or removing members; changing group rules.
- Rejecting deposit requests; cancelling loans.
- Leader account creation in the UI (leaders come from the seed).
- Real-time updates (pages refresh after actions and on navigation).
- Luganda for the dashboard (English only).
- The agent itself (ai-agent-mcp spec).
