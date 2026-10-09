# Financial execution in the existing tool runtime

Main uses `trade_prepare` to create an exact account/symbol proposal and fresh trusted
preview, then `trade_execute` with only proposal/preview IDs. `trade_reconcile` accepts
only an effect ID. Neither tool accepts risk numbers, approval flags or broker credentials
from the model. Peers are rejected before financial dispatch.

These tools currently execute **SIMULATION only**. They do not mutate MetaApi accounts;
LIVE remains disabled pending complete provider/risk/reconciliation/readiness integration.
An approved mandate and healthy broker read connection do not implicitly enable LIVE.

The existing executor applies hard financial product policy, then delegates to the
financial domain's existing effect/risk/approval lifecycle. It deliberately does not wrap
financial actions in a second generic tool effect. This is not a read-only classification:
financial review and admission remain mandatory. The generic always-allow rule, Auto Review
toggle, connector hints and generic approval replay queue cannot bypass that domain.

The reviewer uses the existing independent Auto Review provider/model runtime. Missing
credentials/provider, errors and timeouts escalate safely. DENY remains final. Successful
automatic review has a 15-second freshness bound; final admission rechecks current account
facts, mandate, emergency freeze, virtual account revision and aggregate risk.

Escalation uses the existing conversation ask card and authenticated answer transaction,
offering Approve once/Deny. A paused Run resumes under a new fence. Its continuation asks
the model to read the proposal, refresh the preview and execute the same material action.
An old approval never grants changed account, symbol, volume, price, protection or expiry.

Broker/account reads and proposal/mission get/list operations return fresh data rather than
replaying generic cached tool output. Internal create/preview/mandate writes still retain
their normal idempotency/revision checks. No external connector is made read-only by a name.

Simulation preflight keeps broker-native market facts but replaces actual positions/orders,
equity and margin with the isolated virtual book. It fetches fresh quotes for all virtual
open instruments through the existing broker read queue (at most four simultaneous reads),
updates attributed mission accounting and pins the book revision. No LLM is called by this
accounting step. Too-old or missing data blocks execution.

After STARTED, any uncertain error remains UNCERTAIN with risk retained. Reconciliation
reads immutable simulator acceptance receipts and never sends another mutation. Attributed
simulation management uses the same path. Automatic pending fills/protective exits and LIVE dispatch remain
separate unfinished integration work; the current tools do not claim those capabilities.
