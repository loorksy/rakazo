# Attributed simulation management

Any eligible owner-authorized Agent uses the existing `trade_prepare`/`trade_execute` flow for MODIFY_PROTECTION,
CLOSE_POSITION, MODIFY_ORDER and CANCEL_ORDER. There is no separate engine, scheduler,
administration page or generic mutation route. LIVE remains unavailable.

The account lock orders every capacity change. A current captured Run fence, owner-approved
ACTIVE mandate or narrowly pre-authorized terminal finishing behavior, allowed operation/instrument, fresh provider facts and exact virtual-book
revision are required. `financialTarget` checks the target's mandate/account/symbol,
confirmed origin effect, immutable simulator acceptance receipt and COMMITTED reservation.
An arbitrary broker position ID or another mandate's exposure cannot be substituted.

Preview, atomic admission and simulated provider acceptance use the same shared risk
assessment. Broker tick values/contract size and decimal arithmetic determine risk; model
numeric claims are never accepted. The calculation also accounts for remaining original
entry-to-stop loss plus cost reserve. Stop widening and pending-volume increases need
explicit scope. A protective stop in profit does not make fees/gaps/slippage impossible.

At acceptance the book, provider receipt, original exposure reservation and immutable
journal commit together. MANAGEMENT reservations temporarily hold extra capacity without
incrementing position/order counts. Once accepted, that delta is incorporated in the
original reservation and RELEASED. Only confirmed close/cancel releases that exposure.
A partial close validates lot step/minimum/remainder, records attributed realized P&L,
retains the cost reserve and rounds remaining margin conservatively.

The original OPEN effect/receipt stays immutable as later management changes its position.
Process interruption after acceptance leaves an exact local receipt: reconciliation records
the outcome without another close or cancellation. Missing local acceptance is proof only
for this atomic simulator, never for a remote broker. Concurrent stale book facts are rejected.

Simulation order modification asks the broker read-only preflight for margin on a synthetic
entry description; it never sends a virtual order ID to a broker mutation API. The existing
provider queue/session remains authoritative for market/specification evidence. Full pending
margin may be reserved conservatively during modification, so some otherwise feasible
changes can be rejected rather than understating capacity.

Pre-authorized finishing uses the unchanged owner envelope and backend state at every
preview/review/reservation/provider step. EXPIRED (including a delayed expiry wake),
RISK_STOPPED and TARGET_REACHED allow only their configured CANCEL_PENDING or
CLOSE_ATTRIBUTED_EXPOSURE behavior. Cancellation must name the exact attributed order;
closing must be a full attributed close. Allowed instrument/action scope still applies.
FREEZE, PAUSED, CANCELLED, attention/reconciliation states and account freeze do not grant
finishing authority. Finishing never reactivates or expands the mandate. The short-lived
effect deadline is independent of the expired ordinary trading window; the original
mandate deadline/fingerprint stay unchanged. Independent review and fresh deterministic
risk admission remain mandatory, with the same immutable receipt/reconciliation path.
Existing durable mission wakes instruct the authorized Agent to perform only that
current backend-approved finishing behavior. Delivery does not itself grant authority.

Only simulator-attributed exposures can be managed; real manual-position supervision is
not implemented by this adapter. Pending fills/expiry and automatic stop/target exits use
the trusted Worker observer. These tools never place real trades.
