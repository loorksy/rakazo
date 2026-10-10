# Professional multi-Agent trading product report

This is a tested implementation checkpoint, **not full product completion**.
The product correction, simulator recovery, owner account settings, journal and
pre-authorized terminal reductions are shipped. Controlled LIVE execution, real
manual-position supervision/drift and verified arbitrary-code bypass containment
remain unfinished. No private broker credentials are required to implement those
remaining items; deterministic fixtures must continue to be used.

## Required product semantics

| Requirement | Current answer |
|---|---|
| PRODUCT MODEL | Professional multi-Agent trading system |
| HUMAN USERS | One owner, enforced by backend admission |
| MANDATORY MAIN TRADING AGENT | NO |
| PREDEFINED AGENT ROLES | NO |
| OWNER-CREATED AGENTS TRADING-NATIVE | YES |
| OWNER CAN CREATE MULTIPLE AGENTS | YES |
| AGENTS ARE PEERS | YES |
| AGENT CREATION RETAINED | YES |
| AGENT ROLES OWNER-DEFINED | YES |
| CLOUD CHART AVAILABLE PER RELEVANT AGENT | YES |
| COMPUTER RETAINED PER AGENT | YES |
| WEB/BROWSER/FILES RETAINED | YES |
| FINANCIAL AUTHORITY BOUND PER AGENT/MANDATE | YES |
| MULTIPLE AUTHORIZED AGENTS SUPPORTED SAFELY | YES for implemented SIMULATION paths; LIVE remains disabled |
| PEER MESSAGE TRANSFERS MANDATE | NO |
| COMPUTER CAN BYPASS RISK/POLICY | Required NO remains UNVERIFIED for hostile arbitrary code/network behavior. Model inspection is implemented but is not deterministic containment. |
| KILI MODIFIED | NO |
| KILI EMBEDDED | NO |
| UPSTREAM RAKAZO MODIFIED | NO |
| OUR FORK | https://github.com/loorksy/rakazo |
| PRODUCT BRANCH | trading |

## Implemented changes

- `7d0a5b3e`: Every persistent Agent Run in the trading deployment receives the
  central professional trading foundation before its own identity/instructions.
  Owner provisioning creates the private environment without a privileged Bot.
  Owner-defined creation remains available on Web/Electron and mobile. Chart,
  mission, proposal, approval, effect, simulation, watch and wake paths use exact
  Agent/account ownership instead of a singleton spawn-key privilege.
- `4560a8b0`: Owner Resume keeps the original approved envelope, fingerprint and
  expiry. It checks current revisions, exact Agent/account ownership, account
  freeze/limits, unsettled effects and current exposure valuation. It schedules
  durable reevaluation through the existing Worker without placing a trade.
  Account unfreeze remains a separate owner action.
- `41702ea3`: Agent settings expose exact owner-granted account-read scopes with
  revision checks. An active mandate's own read access appears separately. Grants
  expose no raw credentials and confer no execution capability. Owner journal
  queries paginate stably by timestamp and ID with account/mode/mandate/effect
  filters and owner-scoped cursors. Audit remains readable after account/chat
  deletion. Web/Electron and native controls use the same backend contracts.
- `df4b5da2`: The unchanged owner envelope may authorize exact attributed simulator
  cancellations or full closes after expiry, risk stop or target stop. The shared
  authority predicate runs in previews, independent review, owner effect approval,
  account-locked admission and simulator acceptance. FREEZE, paused/cancelled
  mandates, attention/reconciliation states and account freeze do not grant
  finishing authority. Finishing never reactivates or expands a mandate. Existing
  wakes instruct the authorized Agent; delivery itself grants no authority.

Ordinary Computer, Browser, Terminal, Web, Files, Memory, Routines, integrations and
peer collaboration are retained. Mutation-capable support calls require independent
`trading_support` review before generic approval rules and replay, even when generic
Auto Review is disabled. Missing review, timeout, error, escalation or denial blocks
dispatch. Arguments are redacted. This restores useful support work, while the
hostile-code containment limitation above remains material.

## Verification

Prisma generation succeeds with TLS/checksum verification unchanged; all 117
forward migrations apply to the isolated fixture database. The former Prisma
external blocker is resolved.

- Full PostgreSQL mission/account/proposal/effect/simulation/recovery gate: 92 passed.
- Atomic shared-account risk gate: 8 passed, with distinct Agents and mandates.
- Chart PostgreSQL gate: 28 passed. Owner admission PostgreSQL gate: 6 passed.
- Final focused identity, tool-policy, support-review, financial-review, terminal
  authority and deterministic risk gate: 121 passed.
- Earlier focused executor/onboarding/chart suites: 195 passed. Affected settings,
  connection and mandate-card tests: 28 passed. These gates overlap; counts are
  not presented as a unique aggregate.
- Chromium: all 3 owner creation, exact Resume and account-access/journal scenarios
  pass together, with synthetic RPC fixtures and screenshots.
- Web, mobile, core, adapters, database, API and Worker type checks pass. Web
  production build passes with existing bundle-size warnings.

Gold and Recommendations acceptance fixtures verify runtime instruction composition;
they are not a live-model behavioral evaluation. Mobile type checks and shared
backend tests do not constitute a native-device visual acceptance test. Electron
hosts the tested web surface; no desktop window suite was run on a maintainer machine.

No automated real-money mutation, live SDK mutation or private broker credential
was used. Kili's working tree remains unchanged. Stable commits were pushed only to
origin/trading, with no upstream push or origin/main merge.

## Remaining implementation

The MetaApi integration currently owns read sessions, market data, account context
and preflight; it exposes no controlled LIVE mutation port. Remote acceptance,
reconciliation and formal readiness remain unfinished and LIVE remains disabled.

Current management and finishing act only on confirmed simulator-attributed exposure.
Real manually opened owner positions need supervision baselines, attribution and
drift handling; the full real-position Night Manager acceptance scenario is not met.

Verified containment against hostile Computer/Shell/MCP financial bypass remains
unfinished. A model reviewer alone cannot prove that guarantee. Remaining provider
edge cases, readiness evidence, observability and retention hardening still need
implementation and verification. These are implementation/security gaps, not a
remaining Prisma environment blocker. The entire authorized build is not complete.
