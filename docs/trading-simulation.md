# Isolated simulation provider

`SimulationBroker` is a local provider adapter built on the existing financial effect,
mandate, risk and Run-fencing infrastructure. It imports no broker mutation API, credential
resolver, Computer, shell or arbitrary HTTP tool. LIVE payloads are rejected. Its records
are protected PostgreSQL runtime state, not agent workspace files.

The virtual account starts once from a fresh trusted account equity observation. This is
synthetic funding; existing real positions and subsequent real deposits are not copied.
Currency and initial equity are immutable. New execution receipts and the corresponding
virtual account change commit atomically. Receipts and accounting survive conversation
deletion and backend restart. A duplicate effect returns its original receipt.

Integrated simulation admission supports market/pending entries, order cancellation and
modification, protective updates and partial/full closes through mandatory review, atomic
risk reservation and STARTED. Management resolves the exact exposure from the protected
virtual book and its confirmed original effect/acceptance receipt. A model-provided ID
does not confer ownership. Pending fills, expiry and protective automatic exits are not
yet observed by this checkpoint.

Management reserves its incremental risk as MANAGEMENT, rather than counting it as a new
position/order. Acceptance updates the original exposure's reservation, releases the
temporary management reservation and commits virtual state/receipt/journal atomically.
Cancellation/full close release the original reservation; partial close retains conservative
remaining margin and the cost reserve. Process death after partial-close acceptance can be
reconciled without closing another portion. Book revisions reject stale concurrent edits.

Both forward quote-to-stop risk and original-entry loss accounting are enforced. The shared
deterministic risk engine calculates remaining original-entry loss plus the approved cost
reserve, and admits the larger incremental risk/exposure estimate. Profit-protecting stops
retain the cost reserve. Pending margin-increasing changes use a conservative full margin
reservation during admission. Stop widening and pending-volume increases require explicit
permissions and still obey mission/account ceilings.

Preflight projects virtual positions/orders, equity, margin and free margin into the same
trusted risk contract, without altering broker-native symbol/specification/quote facts.
It updates mission-attributed realized/unrealized P&L outside long-term memory. Quotes for
every open instrument must be fresh; one instrument's price is never borrowed for another.
A pinned book revision prevents admission from spending stale virtual account capacity.

The calculator uses exact fixed-point arithmetic. Market buys fill at ask and sells at
bid; closes use the opposite side. Fractional losses round conservatively. Partial closes
validate volume/remaining volume and scale margin upward at the fixed-point boundary.
The simulation currently assumes no commissions, swaps, slippage or broker latency and
uses entry margin until changed. Its performance is **not** a live-return forecast.

Daily mission loss semantics are UTC-day realized P&L plus current unrealized P&L. Total
mission P&L is lifetime mission-realized P&L plus current unrealized P&L; other missions and
manual broker positions are not attributed to it. Structured accounting is version 1.

After process death the existing reconciler marks STARTED effects UNCERTAIN and retains
risk. A current fenced Main execution can reconcile the immutable local
acceptance receipt without another fill. An absent receipt proves no local mutation only
because the virtual account write and receipt are atomic and the old execution is fenced
out; **this inference never applies to remote MetaApi requests**. Success commits risk,
proven nonacceptance releases it, and the mission remains PAUSED for safe recovery.
Recovery from a new Run is supported after the old lease ends or its Run is deleted;
financial ownership advances independently of per-Run fences. Automatic mission resumption
is not implemented here. Cancellation is preserved during reconciliation.

Database tests cover atomic rollback, duplicate prevention, exact accounting, stale book
facts, stale workers, immutable receipts, process death after provider acceptance, successful
reconciliation and proven local nonacceptance. All provider mutations are simulated.
