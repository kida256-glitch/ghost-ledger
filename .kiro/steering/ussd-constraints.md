---
inclusion: fileMatch
fileMatchPattern: ["src/ussd/**", "src/app/api/ussd/**", "src/app/simulator/**", ".kiro/specs/ussd-engine/**"]
---

# USSD constraints

## Response format

- Every response starts with `CON ` (session continues, expect input) or `END ` (session ends).
- The whole response, prefix included, must be **under 182 characters**.
- Use only GSM-7 basic characters. Non-GSM characters (curly quotes, em-dashes, emoji, `ŋ`) force UCS-2 encoding, which cuts the usable length sharply. In Luganda strings write `ng'` instead of `ŋ`.
- Show money as `UGX 5,000`. Users type amounts as plain digits.

## Statelessness

- The endpoint receives `sessionId`, `serviceCode`, `phoneNumber` and `text`.
- `text` is every choice in the session joined by `*`, e.g. `1*2*5000`. Empty `text` means first dial.
- The engine rebuilds the current menu state from `text` alone by replaying the tokens from the root. It holds no per-session menu state in memory.
- Server-side data the engine reads (member, balances, PIN attempts) comes from the database, not from session memory.

## Robustness

- Any input, including garbage, very long strings, `**`, non-digits and unknown phone numbers, returns a valid `CON`/`END` string and never throws.
- Invalid choices re-show the current menu with a short error line. Never dump a stack trace or internal error.
- Back navigation: `0` goes back one screen, `00` returns to the main menu. Because the gateway keeps these tokens in `text`, the engine must interpret them during replay.
- Expired or unknown sessions end cleanly with an `END` message asking the user to dial again.
- Money-moving actions need an explicit confirm step and the PIN. Repeated identical final requests (gateway retries) must not record a second entry.

## Main menu

```
1 Save
2 Request loan
3 Repay
4 Balance
5 Group info
6 Language
```

Language 6 offers English and Luganda.

## i18n

- All user-facing strings live in `src/ussd/i18n/<lang>.ts`, keyed by message id, with typed parameters.
- English is complete and is the fallback for any missing key.
- Luganda covers the main screens. Luganda strings must be reviewed by a native speaker before they are called final. Mark unreviewed strings in the file.
- Adding a language means adding one file and registering it. No engine changes.
- A test checks every string in every language, with worst-case parameters, stays within the length limit.

## Security

- `text` contains the PIN. Never log raw `text`; redact tokens at PIN positions.
- Never echo a PIN back on screen.
