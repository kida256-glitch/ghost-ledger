---
inclusion: always
---

# Product: Ghost Ledger

Ghost Ledger is a savings-group platform for Village Savings and Loan Associations (VSLAs) and SACCOs in Uganda. It is a Kiroween 2026 hackathon entry in the Frankenstein category: it stitches together three technologies that don't normally belong together.

1. **USSD feature-phone interface (1990s tech).** Members with no smartphone or internet dial a short code to save, request a loan, repay, check balances and see group info.
2. **Append-only, hash-chained ledger.** Every transaction is a ledger entry linked to the previous one by SHA-256. This gives blockchain-style tamper evidence without a blockchain.
3. **Read-only AI agent over MCP.** Group leaders ask plain-language questions about the ledger. The agent also flags suspicious activity. It can never move money.

A web dashboard serves group leaders. A browser-based feature-phone simulator calls the same `/api/ussd` endpoint the real gateway would, so judges can try the app without a Ugandan short code.

## Users

- **Members.** Rural and peri-urban Ugandans, usually on basic feature phones over 2G. Many prefer Luganda. Some have limited literacy, so menus must be short and predictable.
- **Group leaders** (chairperson, treasurer, secretary). Use the web dashboard on a phone or laptop to see group health, loans, the ledger and anomaly alerts, and to ask the agent questions.
- **Hackathon judges.** Use the simulator and dashboard. They need the full demo to work in about 3 minutes with no setup.

## Core flows

- Leader registers a member (name and phone) on the dashboard. The member's first dial sets their PIN. Unregistered numbers are told to ask their group leader.
- Member dials in, enters PIN, saves, requests a loan within the group's limit, repays, checks balance.
- Leader opens the dashboard, approves or rejects loan requests (no loan is paid out without a leader's approval), and sees group totals, overdue loans, the ledger with a "chain verified" status, and anomaly alerts.
- Leader asks the agent questions ("Who is overdue?", "Is anything suspicious this month?") and gets answers grounded in ledger data.
- If someone edits a past record directly in the database, chain verification fails and the dashboard and agent show where.

## Principles

- Feature-phone first. If it doesn't work on USSD, it isn't a member feature.
- Evidence over trust. Every number on screen is derivable from the ledger, and the ledger can prove it hasn't been edited.
- The AI explains and flags. It never acts on money.
- Money is integer UGX everywhere.

## Non-goals

- No real blockchain, tokens, wallets or crypto.
- No real mobile-money integration (MTN MoMo, Airtel Money). USSD transactions are recorded in the ledger; no real funds move.
- No real USSD short-code registration. The endpoint follows the common gateway request shape (Africa's Talking style) so it could be connected later.
- No SMS notifications, member smartphone app, KYC, or offline sync.
- No claims of regulatory compliance (e.g. Uganda's Tier 4 Microfinance Institutions and Money Lenders Act, 2016).
- No AI or MCP write access of any kind.
- No features outside the four specs in `.kiro/specs/`.
