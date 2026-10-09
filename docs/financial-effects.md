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
An automatic ALLOW review must remain fresh (15 seconds) when execution begins. Refreshing
broker facts cannot reuse an old model decision. Owner escalation has its own bounded
effect expiry and still requires fresh deterministic admission checks.

Starting an effect locks the account, checks current Run ownership, current exact mandate,
owner guardrails, expiry and fresh trusted facts, then recomputes and reserves risk and
records STARTED **in the same transaction**. Emergency freeze takes the same account lock.
A freeze committed first prevents admission. Once STARTED, the outcome must be reconciled;
an emergency stop cannot make an already-sent request disappear.

Every execution-produced write requires the captured Run ID, Run fence and holder.
`financialRunFence` is scoped to that Run; `financialGeneration` is a separate monotonic
effect ownership generation. A Run takeover advances effect ownership; reservation
ownership uses that effect generation. A new Run whose fence starts at one therefore
cannot rewind financial ownership. A stale execution cannot review, start or settle even
after rereading the latest record. Started effects are never adopted for another call.

Confirmed success commits the reservation; confirmed failure releases it. An uncertain
outcome retains its reservation and moves the mandate to NEEDS_RECONCILIATION. Interrupted
STARTED effects with no valid owning Run lease become UNCERTAIN exactly once. Recovery
never resends the request. Process-death tests terminate a child after the STARTED commit,
then verify retained risk, one STARTED journal receipt and refusal to retry.

Simulation execution and owner escalation are implemented in the existing tool executor.
LIVE remains disabled pending the provider/reconciliation/readiness gate.

## Recovery across conversation executions

A current owner/Main Run can inspect a started or terminal effect even when its previous
preview or mandate expired. Inspection grants no execution authority. Simulator
reconciliation can run from a new Run after the previous Run's lease is no longer valid
or its record was deleted. It takes the account and effect locks, checks current Main
ownership, advances the effect generation and records the previous/recovery Run IDs in
the immutable journal. Same-Run takeover remains supported. A valid prior Run lease
blocks cross-Run recovery; stale recovery Runs fail their captured execution fence.

Simulation acceptance and its immutable receipt commit atomically. That receipt proves
success; its absence proves local nonacceptance only after the old execution is fenced.
Neither rule infers remote broker failure from missing local data. Recovery updates risk
and the final receipt once without invoking a provider mutation. A cancelled mandate stays
cancelled; otherwise resolved NEEDS_RECONCILIATION becomes PAUSED, never auto-resumed.

## Owner escalation

The existing chat `ask`/`answerRunInput` transaction resolves a financial escalation by
effect ID. Financial validation checks the private owner/Main principal, originating
conversation, exact immutable proposal/action/mandate fingerprints and unexpired effect.
Only Approve once and Deny are supported; even an old card offering Always allow cannot
create a financial tool rule. Approval stores the owner and timestamp and an immutable
journal entry in the same transaction that queues the original Run. The model has no
approval operation. A new execution generation must adopt the unstarted effect and recheck
fresh facts/risk before STARTED; a human answer does not bypass emergency freeze or limits.

`buildFinancialApprovalAskBlock` uses the final validated action to display all material
parameters and explicit simulation/live mode without embedding credentials. The backend
validates authorization independently of rendered card text. Database tests exercise
owner approval, denial, wrong principal/conversation, blanket approval, expiry and reuse.
