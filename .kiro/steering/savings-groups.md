---
inclusion: always
---

# How savings groups work

Domain background for anyone writing specs or code. Where this doc and a spec disagree, the spec wins for what we build.

## VSLA (Village Savings and Loan Association)

- **Members.** Usually 15 to 30 self-selected people from the same community. They write a constitution that sets the group's rules.
- **Leadership.** Elected chairperson, secretary (record keeper), treasurer (box keeper) and money counters. Cash sits in a lockbox with three key holders so no single person can open it.
- **Meetings.** Typically weekly. Every transaction happens in front of everyone, which is the group's main fraud control. Ghost Ledger's hash chain and anomaly flags are a digital version of that public visibility.
- **Cycle.** Usually 9 to 12 months. At the end, the group does a share-out and usually starts a new cycle.
- **Savings as shares.** Members buy 1 to 5 shares per meeting at a share value fixed for the cycle. Savings are not withdrawn mid-cycle.
- **Social fund.** A small fixed contribution each meeting into a separate pot. It pays emergency grants (funerals, illness). It is not part of the share-out.
- **Loans.** Lent from the loan fund (accumulated savings plus interest and fines). The group sets:
  - the service charge (interest), often a flat percentage per month on the principal, e.g. 5% to 10%;
  - the loan limit, commonly up to 3 times the member's savings;
  - the maximum term, often 1 to 3 months.
  Many groups allow only one active loan per member.
- **Fines.** For lateness, missed meetings or late repayment. Fines go to the loan fund.
- **Share-out.** At cycle end, all loans should be repaid. Total cash in the loan fund (savings plus interest plus fines) is divided among members in proportion to the shares they bought. This is how interest becomes member profit.

## SACCO (Savings and Credit Cooperative)

- A formally registered cooperative, larger than a VSLA, often with paid staff and an office.
- Ongoing membership, no cycle and no share-out. Members hold share capital (equity) and savings accounts that can usually be withdrawn. Profits are paid as annual dividends.
- In Uganda, SACCOs fall under the Tier 4 Microfinance Institutions and Money Lenders Act, 2016, supervised by the Uganda Microfinance Regulatory Authority (UMRA).

## Common risks Ghost Ledger addresses

- A record keeper alters past entries to hide a missing deposit or loan. The hash chain detects this.
- An insider records a loan far above what the borrower's savings allow, often for a friend or themselves.
- Repeated "corrections" (reversals) that move money around.
- Bursts of activity at unusual hours, outside normal meeting times.

## Uganda context

- Currency is the Uganda shilling (UGX). There are no minor units in practical use, so integer UGX is exact.
- Mobile money (MTN MoMo, Airtel Money) is widespread and USSD-based, so members already know USSD menus.
- Time zone is Africa/Kampala, UTC+3, no daylight saving.
- Phone numbers are `+256` followed by 9 digits.
- Luganda is the most widely spoken language in the Central region. English is an official language.

## What Ghost Ledger models

The ledger-core spec defines exactly which of these concepts are in scope. Concepts not listed there (for example fines or share-out) are out of scope until a spec adds them.
