# Exact trade proposals and broker previews

`trade_prepare` is a per-Agent capability in the existing tool executor.
It creates an immutable canonical action bound to one account, exact broker symbol,
goal, mandate and immutable plan version. No aliases or model-supplied risk facts are
accepted. Repeated trusted request identities return the existing proposal; changed
material terms require a new proposal. Each Agent prepares only its own mandate-bound actions; peer messages never transfer authority.

The preview reads trusted provider preflight through the existing Worker-owned broker
session. It rechecks the claimed Run after provider IO, checks the expected proposal
revision and appends an immutable preview version. The image/chart is evidence, not
an executable price source. Exact decimal stop-loss arithmetic, account/quote
freshness, mission accounting and current guardrails determine the risk assessment.
The proposed action fingerprint stays bound to the final normalized material terms.

A preview lasts at most fifteen seconds. It is an inspection snapshot, not an
approval, risk reservation or guarantee that capacity will remain available.
Execution must repeat authoritative admission atomically. Provider failures leave
the proposal unchanged. Unknown mission accounting blocks new exposure; this module
does not invent an empty account. Simulation management previews resolve protected book
positions/orders and confirmed origin receipts; unattributed targets fail closed. LIVE
remains disabled at this checkpoint.

Protected PostgreSQL proposal/preview records have no chat, Run or Bot cascade.
Database triggers prevent material rewrites, deletion and rewriting historical
preview versions. The separate financial journal records concise rationale/evidence
references and deterministic results, never private reasoning or provider secrets.

The preparation tests are included in `trading-missions.postgres.test.ts`. They use
dedicated `_test` storage and injected normalized preflight fixtures, with no broker
mutation. They cover request deduplication, exact symbol scope, stale revisions,
stale-worker rejection after IO, unsafe protection, stale accounting, provider
failure, peer denial and persistence after chat deletion.
