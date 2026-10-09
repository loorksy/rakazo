# Trading goals, plans and mandate proposals

The Main Trading Agent uses `trading_mission` to create an owner/account-scoped goal,
append an immutable plan version and propose a final authorization envelope. Research
peers cannot acquire this capability by messaging or handoff. Every model command
requires the current Run holder/generation, including reads.

Goals, plans and mandates live in protected PostgreSQL state independently of chat,
Bot delivery and Computer files. Goal request identities are deduplicated; changing
the payload under the same request identity is rejected. Goal identity, plan versions
and mandate material fields cannot be rewritten, including through accidental backend
updates. A revised plan does not change an already approved mandate.

Profit targets are aspirational. Allocated capital is an accounting/exposure budget,
not segregated broker funds. The model must inspect account/market evidence before
proposing limits. Final scope is injected from the trusted goal/Main identity, not
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
remaining simulator, mission event scheduling and financial execution path are not
implemented by this module.

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

Future goals currently fail activation before their start rather than acquiring
early authority; the risk ledger independently validates the goal's time window.
Scheduled activation will use durable wakes in the existing job host.
