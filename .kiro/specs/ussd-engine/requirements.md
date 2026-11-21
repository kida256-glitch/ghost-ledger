# Requirements: ussd-engine

## Introduction

The USSD engine lets members use Ghost Ledger from a feature phone. It handles the gateway webhook, builds each screen again from the session's `text` on every request, sets up and checks PINs, and offers Save, Request loan, Repay, Balance, Group info and Language. It writes only through the ledger-core `LedgerWriter`, as `ghost_app`. Constraints come from `.kiro/steering/ussd-constraints.md`. Requirement ids use the prefix `U` so they don't collide with ledger-core ids.

## Glossary

- **Gateway**: the USSD aggregator (Africa's Talking style) or the browser simulator. Both POST to `/api/ussd`.
- **Token**: one element of `text` split on `*`. Empty `text` means the first request of a session.
- **Screen**: one response, starting `CON ` (expects input) or `END ` (session over).
- **Dry run**: calling the domain's `execute` on the current replayed state without writing, to learn whether a command would be accepted.

## Requirements

### U1: Webhook

1. WHEN the gateway POSTs `application/x-www-form-urlencoded` fields `sessionId`, `serviceCode`, `phoneNumber` and `text` to `/api/ussd`, the endpoint SHALL parse them with zod and reply HTTP 200, `Content-Type: text/plain`, with one screen as the body.
2. IF the body is missing a field, has the wrong type or is too long (`sessionId` > 100, `serviceCode` > 30, `phoneNumber` > 20, `text` > 1000 characters), THEN the endpoint SHALL reply HTTP 200 with the generic `END` error screen.
3. The endpoint SHALL connect only as `ghost_app` (`DATABASE_URL`, via `appEnv()`).

### U2: Screen format

1. Every response SHALL start with `CON ` or `END `, be under 182 characters including the prefix, and use only GSM-7 basic characters.
2. The engine SHALL NOT throw for any input. IF anything fails unexpectedly (database down, bug), THEN it SHALL return the generic `END` error screen.
3. Text from the database (group names) SHALL have non-GSM-7 characters replaced with `?` and be shortened to fit.
4. Amounts SHALL show as `UGX 5,000`. Dates SHALL show as `DD/MM/YYYY` in Africa/Kampala.

### U3: Stateless navigation

1. The engine SHALL rebuild the current screen by replaying `text` from the root on every request. It SHALL keep no session state in memory.
2. `0` SHALL go back one screen and `00` SHALL return to the main menu. An invalid choice SHALL show the same screen again with a short error line.
3. IF `text` has more than 20 tokens, THEN the engine SHALL return `END` asking the user to dial again.
4. An action (a write or a language change) SHALL run only when its confirming token is the last token. IF any token follows a confirming token, THEN the engine SHALL return `END` asking the user to dial again, and SHALL NOT write.

### U4: Who is dialling

1. The engine SHALL normalize `phoneNumber` with the domain's `normalizePhone`.
2. IF the phone number is invalid or belongs to no member, THEN the engine SHALL return `END` saying the number is not registered and to ask their group leader.
3. IF the member is suspended, THEN the engine SHALL return `END` saying so and SHALL offer no menu.

### U5: Rate limiting

1. The engine SHALL count every request per normalized phone number in a 5-minute fixed window, stored in the database under a SHA-256 of the number.
2. IF a phone number makes more than 30 requests in one window (configurable with `USSD_RATE_LIMIT_MAX`, dashboard-simulator D15.1), THEN the engine SHALL return `END` asking the user to try again later, without checking any PIN.

### U6: PIN setup (first dial)

1. WHEN a registered member with no PIN dials, the engine SHALL ask them to create a 4-digit PIN, then to enter it again.
2. IF the PIN is not exactly 4 digits, has all digits the same, is a run (`0123`…`6789`, `9876`…`3210`), or equals the last 4 digits of the member's phone, THEN the engine SHALL ask again with a short reason.
3. IF the two entries differ, THEN the engine SHALL start PIN creation again.
4. WHEN both entries match, the engine SHALL store an argon2id hash only if the member still has no PIN, and SHALL return `END` asking them to dial again. A repeat of the same request (gateway retry) SHALL return the same screen.

### U7: PIN check and lockout

1. WHEN a member with a PIN dials, the first token SHALL be their PIN, and it SHALL be checked against the stored hash on every request of the session.
2. IF the PIN is wrong, THEN the engine SHALL add 1 to the failure count and return `END` with the number of tries left.
3. WHEN the failure count reaches 5, the engine SHALL lock the PIN for 30 minutes. Each later failure, before a correct PIN, SHALL lock it for another 30 minutes.
4. WHILE the PIN is locked, the engine SHALL return `END` with the unlock time (Kampala `HH:MM`) and SHALL NOT check the PIN.
5. WHEN a correct PIN is entered with a non-zero failure count, the engine SHALL reset the count.

### U8: Logging

1. The engine SHALL NOT log `text`, any token, any PIN or PIN hash, phone numbers or session ids.
2. Log records SHALL contain only values from fixed lists: event, screen id, outcome and error code.

### U9: Main menu and gating

1. After a correct PIN, the engine SHALL show: `1 Save`, `2 Request loan`, `3 Repay`, `4 Balance`, `5 Group info`, `6 Language`.
2. The engine SHALL decide whether Save and Request loan are available by dry-running the domain command for the dialling member. IF the dry run fails, THEN it SHALL show a screen that explains why and offers no form.
3. The engine SHALL only issue `requestDeposit` and `requestLoan`, for the dialling member, with channel `ussd` and that member as actor. It SHALL offer no leader actions, reversals, repayments or social fund contributions.

### U10: Save

1. Save SHALL ask for an amount, show a confirm screen, and on confirm append a `DEPOSIT_REQUEST` through the writer, then say a leader will confirm it.
2. IF the dry run rejects the amount (`INVALID_AMOUNT`, `BELOW_MIN_DEPOSIT`), THEN the engine SHALL ask again, naming the minimum.
3. IF the member already has 3 pending deposit requests (ledger-core R9.10, `PENDING_DEPOSIT_LIMIT`), THEN Save SHALL say so and end.
4. The write SHALL use idempotency key `ussd:` + SHA-256 of `sessionId` and `text` with the PIN token removed, so a gateway retry records nothing new.

### U11: Request loan

1. IF the member has an open loan, THEN Request loan SHALL show its status and end.
2. IF the member's loan limit is 0, THEN Request loan SHALL say they must save first and end.
3. Otherwise it SHALL ask for an amount (showing the limit), then a term (1 to the group's maximum), show principal, interest and total (from the domain), and on confirm append a `LOAN_REQUEST` with the same idempotency rule as U10.4, then say a leader must approve it.
4. IF the dry run rejects the amount or term (`INVALID_AMOUNT`, `EXCEEDS_LOAN_LIMIT`, `INVALID_TERM`), THEN the engine SHALL ask again with a short reason.

### U12: Repay, Balance, Group info

1. Repay SHALL show only the amount owed and the due date of the active loan, and tell the member to pay a leader. It SHALL record nothing. With no active loan, it SHALL say so.
2. Balance SHALL show confirmed savings, the total and count of pending deposit requests, social fund, loan owed and due date (if any) and loan limit.
3. Group info SHALL show the group name, member count, total savings, monthly interest rate, loan multiplier, maximum term and minimum deposit.
4. All three SHALL end the session (`END`).

### U13: Language

1. Language SHALL offer `1 English` and `2 Luganda`. The choice SHALL be stored for the member and used on every later screen, including the PIN prompt.
2. All strings SHALL live in `src/ussd/i18n/<lang>.ts`. English SHALL be complete and the fallback for any missing key.
3. Luganda SHALL cover the main screens: not registered, PIN prompts, main menu, Balance, Save and loan confirmations and results. Each Luganda string SHALL be marked as a draft until a native speaker reviews it.

### U14: Write errors

1. IF the writer returns `CHAIN_CONFLICT`, THEN the engine SHALL return `END` saying the system is busy.
2. IF the writer returns a domain error (state changed since the confirm screen), THEN the engine SHALL return `END` with the reason for that error.

### U15: Required properties

1. Any phone number and any input sequence, including garbage, SHALL produce a screen that satisfies U2.1, and the engine SHALL never throw.
2. For any session, no log record SHALL contain the PIN or the raw `text`.
3. For any ledger state, member and input sequence, the engine SHALL never show a confirm screen for, or issue, a command the domain rejects, and SHALL never issue a command other than those in U9.3.

### U16: Keep-alive

1. A Vercel cron job SHALL call `GET /api/health` once a day, so the hosted Supabase project is never idle long enough to pause before the judging period ends (29 January 2027).
2. The README SHALL document the job, why it exists, and that it can be removed after the judging period.

### U17: Demo accounts

1. The seed SHALL set fixed, fictional PINs for the demo members, except one member left without a PIN so the first-dial setup can be shown. The PINs SHALL follow U6.2 and live in one module that the simulator can import.
2. `npm run demo:unlock` SHALL connect through `ADMIN_DATABASE_URL` and, for the demo group only, reset PIN failure counts and lockouts and delete the rate-limit rows of its members' phone numbers. It SHALL print counts only.
3. The README SHALL include a threat-model note: `/api/ussd` has no gateway authentication, so anyone can POST any phone number and the PIN is the only protection; production would need a gateway IP allowlist or signed requests.

### U18: Performance

1. The argon2id parameters SHALL be chosen so one PIN check takes under about 100 ms. The measured time on this machine SHALL be recorded in the design.
2. `@node-rs/argon2` SHALL load and hash in a Linux production build (checked in a `node:24` container, as a stand-in for Vercel's build image).
3. `hosted:check` SHALL time a full USSD request (PIN plus Balance) against the deployment, report a cold and a warm time, and fail if the warm request takes 2 seconds or more or does not return the Balance screen.

## Handed to later specs

- **dashboard-simulator:** the simulator page shows the demo members' phone numbers and PINs (the group is fictional), read from the demo PIN module (U17.1), so judges can dial in without setup. It shows the member without a PIN as "first dial: you choose the PIN".

## Out of scope

- Authenticating the gateway (IP allowlist or shared secret). With the simulator, anyone can POST any phone number; the PIN is the only protection. Noted in the README.
- PIN reset or change. A leader-assisted reset can come later.
- Recording repayments or social fund contributions over USSD (members can't self-record cash in, ledger-core R9.9).
- Cancelling deposit or loan requests.
- Session timeouts: the engine holds no session, so there is nothing to expire.
- Mutation checks for this spec.
