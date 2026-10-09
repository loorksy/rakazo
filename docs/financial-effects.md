# Financial effect ownership and recovery

`FinancialEffects` extends the existing protected `ExternalEffect` records. It does not
own broker sessions, start a scheduler, or place a trade. The existing Worker reconciler
calls `recoverInterrupted` before repairing mission wake jobs.

An immutable proposal and fresh trusted preview create one stable effect identity. The
v2 financial context binds owner, Main Trading Agent, account, mode, goal, mandate, plan
version, proposal and canonical action fingerprint. The provider client reference is
`rz_<10 hexadecimal characters>_<10 hexadecimal characters>`; it is independent of
natural-language explanations and remains stable across attempts.

Independent review records ALLOW, DENY or escalation. A recorded DENY cannot be replaced;
escalation cannot be retried to obtain a different review. PostgreSQL preserves review,
expiry, approval, STARTED and terminal receipts. Receipt protection permits deletion of
ordinary conversation/Run links without deleting the financial evidence.

Starting an effect locks the account, checks current Run ownership, current exact mandate,
owner guardrails, expiry and fresh trusted facts, then recomputes and reserves risk and
records STARTED **in the same transaction**. Emergency freeze takes the same account lock.
A freeze committed first prevents admission. Once STARTED, the outcome must be reconciled;
an emergency stop cannot make an already-sent request disappear.

Every execution-produced write requires its claimed Run generation and holder. A later
execution can adopt an unstarted effect after a monotonic Run takeover. A stale execution
cannot review, start or settle it even after rereading the latest record. Started effects
are never adopted for another outbound call.

Confirmed success commits the reservation; confirmed failure releases it. An uncertain
outcome retains its reservation and moves the mandate to NEEDS_RECONCILIATION. Interrupted
STARTED effects with no valid owning Run lease become UNCERTAIN exactly once. Recovery
never resends the request. Process-death tests terminate a child after the STARTED commit,
then verify retained risk, one STARTED journal receipt and refusal to retry.

This checkpoint provides lifecycle/admission safety, not a mutation adapter. LIVE remains
disabled pending the readiness gate. Simulation execution, owner escalation resolution,
provider reconciliation and broker mutation dispatch are separate integration work; this
module does not imply that any of those paths is enabled.
