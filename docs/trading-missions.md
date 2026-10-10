# Trading goals, plans and mandate proposals

Any owner-created professional Agent uses `trading_mission` to create an owner/account-scoped goal,
append an immutable plan version and propose a final authorization envelope. Peer messaging and handoff never transfer financial authority. Every model command
requires the current Run holder/generation, including reads.

Goals, plans and mandates live in protected PostgreSQL state independently of chat,
Bot delivery and Computer files. Goal request identities are deduplicated; changing
the payload under the same request identity is rejected. Goal identity, plan versions
and mandate material fields cannot be rewritten, including through accidental backend
updates. A revised plan does not change an already approved mandate.

Profit targets are aspirational. Allocated capital is an accounting/exposure budget,
not segregated broker funds. The model must inspect account/market evidence before
proposing limits. Final scope is injected from the trusted goal/Agent identity, not
selected by the model. Account-specific instruments, currency, supervision identity,
expiry and requested market scope are validated.

`trading.resolveMandate` is an authenticated owner RPC. It binds the exact current
fingerprint and revision; the model has no approve/activate/administer command.
Approval requires separately configured owner account guardrails. Account-row locking
serializes activation counts and emergency freeze against risk reservation. Reused,
changed, expired or wrong-owner approvals fail. Rejection cannot be reversed by
repeating the proposal. There is currently no resume command.

Only SIMULATION activation is available at this checkpoint. LIVE activation and
LIVE guardrail configuration fail closed until the execution/reconciliation/readiness
gate is implemented. Simulation approval itself performs no broker mutation. The
remaining simulator and financial execution path are not implemented by this module.

Pause/cancel immediately invalidate new active authority. Emergency stop additionally
freezes the account/mode guardrail atomically. They do not silently close positions.
The journal records mandate proposal, resolution, account guardrail changes and stop
events, separately from conversation memory. Stop behavior requires subsequent
pre-authorized finishing effects; approval cannot pretend those effects have occurred.

Deterministic PostgreSQL tests exercise persistence, exact approval, idempotency,
immutability, current execution fencing, account freeze revision consistency and chat
deletion. Enable only against a dedicated `_test` database using
`MISSION_TEST_DATABASE_URL`; no test contacts a broker.

Web/Electron and native mobile render a compact `trading_mandate` message card in the
existing conversation. The block carries references only; the card fetches current
backend scope/revision/hash. It exposes final limits, human-only simulation account
guardrail entry, approve/deny, pause/cancel and emergency freeze. There is no new
navigation page. Unconfigured guardrails and LIVE mode disable approval in the client
as well as the authoritative backend. Frontend conflicts leave current authority
unchanged. The mobile details view currently uses the exact structured envelope;
further presentation work is independent of authorization.

Future approved goals wait in `APPROVED_WAITING` without early authority. Durable
START, selected plan REEVALUATE and EXPIRE metadata use the existing Graphile job
host with exact requested deadlines. The periodic reconciler repairs enqueue gaps;
it does not invoke a model when nothing is due. The risk ledger independently checks
the goal's time window. Scheduled activation rechecks owner, account and guardrails.

Each logical deadline has an immutable wake identity and terminal receipt. Duplicate
delivery creates at most one ordinary Task/Run. If chat delivery disappears, the wake
remains `DELIVERY_NEEDED` and relinks only to the same authorized Bot. Run completion
is recorded independently of chat deletion. Failed analysis blocks new risk until
attention is resolved. Plan replacement cancels future analysis deadlines without
changing approved authority or extending expiry.

After downtime, obsolete analysis deadlines coalesce into a current reevaluation;
independent user reports and account/effect events are not discarded by this policy.
An overdue expiry prevents new risk before its notification Run is submitted. This
checkpoint marks expiry and notifies; it does not claim broker finishing effects
have run. An actual SIGKILL test covers commit-before-enqueue and recovery through
the existing Run reconciler.


## Owner-only resume

The owner may resume a PAUSED or NEEDS_ATTENTION simulation mandate through the
protected control RPC. Resume preserves the original envelope, fingerprint,
Agent/account identity and expiry. The account lock serializes it with other
Agent admissions. Frozen/disabled guardrails, excess active mandate capacity,
uncertain account effects, expiry, breached risk/target state and stale exposure
valuation prevent resume. Current book revision must match the trusted observation
when attributed exposure remains. RISK_STOPPED, TARGET_REACHED, CANCELLED and
EXPIRED outcomes cannot be reset by this operation. LIVE resume remains disabled.

A successful resume journals one immutable event and creates one durable wake
bound to the new mandate revision. Future goals retain their exact START deadline;
current goals get a reevaluation, with no broker action or simulator fill replay.
The existing job reconciler repairs a commit-before-enqueue interruption.
Web/Electron and native mobile expose Resume and a separate Unfreeze account action;
resume never silently unfreezes an account or widens financial authority.

## Owner account scopes and journal

Agent settings expose exact owner-granted account-read access with revision-checked
updates. Active mandates supply their own bounded read scope separately; switching
off an explicit grant does not revoke a mandate. Market/chart knowledge remains
available without account access. These settings expose no credential reference,
provider account identifier or financial approval capability.

The owner can inspect the immutable journal from broker settings or a mission.
Queries filter account, mode, mandate or effect and paginate by timestamp plus ID.
Cursor lookup is owner- and filter-scoped, so another owner's cursor fails closed.
Account/chat deletion does not erase journal snapshots. Web/Electron use progressive
details; mobile uses native controls and selectable event details.
