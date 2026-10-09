# Deterministic financial risk and account capacity

`assessFinancialAction` is a bounded, pure backend calculation. It does not
call a model, provider, filesystem or clock. The caller supplies trusted provider
facts and server time. Tools must never accept a model's claimed risk snapshot.

The versioned `stop-loss-v1` calculation uses exact decimal strings and BigInt
arithmetic at twelve fractional places. Positive divisions round up. Stop distance
uses broker loss-tick value, or contract size only when profit/account currencies
match. Unknown conversion/notional/margin fails closed. Protective stops describe
theoretical loss, not a guarantee against gaps, slippage or broker failure.

The calculation checks account/symbol/quote identity, freshness, broker volume and
price steps, protection direction/distance, account permissions, hedge/add-exposure
permissions, exact target ownership/manual drift, mission expiry, netting ambiguity,
mission/daily losses, aggregate open risk, margin and notional capacity. Pending
entries reserve risk and require expiry within mandate duration. Stop-limit entry
preflight is not implemented and is rejected. No indicator or trading method is
forced. A target profit never increases any hard limit.

Mission loss means negative net mission P&L from inception, with current open
stop-risk added before accepting new risk. Daily loss follows the same conservative
budget check against trusted daily P&L. Existing open risk is counted alongside a
new action, not just the action's incremental loss. Netting new entries fail closed.
Exact supervision can reduce protection risk and partial/full close within scope;
stop widening or pending-volume increases need explicit permissions and still pass
all hard bounds. Allocation is an accounting/exposure budget, not segregated cash.

## Account reservation transaction

`AccountRiskLedger` is protected backend accounting, not a second trading engine.
It reads final canonical action and exact owner-approved mandate from persistence.
The actor must claim the existing Main Trading Agent Run; a peer cannot inherit it.
The lock order is account connection, Run, guardrail, mandate/effect/reservation.
All capacity writes must use the same account row lock. READ COMMITTED transactions
with that lock serialize capacity reads and reservation creation for an account.
The ordinary unique effect ID also deduplicates retries. No global advisory lock
or SERIALIZABLE retry of an external network mutation is used.

SIMULATION and LIVE have separate account guardrail keys and ledger queries. Reserved,
committed and uncertain capacity all consume risk. Pending orders consume exposure;
unconfirmed margin is reserved before another mission can use it. Account freeze,
autonomous disablement, mandate count, global risk/exposure/pending/margin ceilings,
stale ownership, stale accounting and unresolved effects block new reservations.
The transaction appends an immutable risk journal snapshot atomically.

An existing reservation returned for inspection is not permission to execute. The
executor must revalidate current authority/guardrails before any outbound mutation.
Reservations are not released merely because a request timed out or a worker died.

## Current checkpoint limitations

The reservation path supports new OPEN exposure and attributed simulation management.
Management deltas use MANAGEMENT reservations; confirmed local provider acceptance updates
the original exposure's risk/margin/notional and releases the delta in the same transaction.
The shared `assessAttributedFinancialAction` preserves forward risk checks and adds exact
original-entry loss/cost accounting. State, receipts and journal are protected runtime data.
Cash-flow-aware account drawdown baselines, real-account supervision and controlled LIVE
provider release/reconciliation remain pending. Goals/plans/mandates and simulation
execution use the existing command, chat and effect infrastructure.
Configured account drawdown without a verified baseline is refused. LIVE reservations
are refused even when an operator flag is supplied: readiness has not been established
and no broker mutation port is exposed. The new goal/plan/mandate tables support
independent authority and immutable history; they do not alone activate trading.
