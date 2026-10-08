# Single-owner product boundary

The API composition root always initializes single-owner enforcement and passes
`ownerOnly: true` to authentication. Generic library primitives remain reusable;
they are not alternative public product routes.

For an empty deployment, the operator supplies `OWNER_BOOTSTRAP_PROOF` (32–256
characters) through protected deployment configuration. The owner submits it as
`x-rakazo-owner-bootstrap` during initial registration. Only its versioned digest
is stored. Registration consumes the proof, closes signup and claims the owner
in the same PostgreSQL transaction as inserting the human user. The singleton
deployment row is locked by the insertion trigger, so concurrent API processes
cannot admit two owners. Service-to-human email conversion is also blocked.

At upgrade, a sole existing human account is preserved as owner. More than one
human requires explicit operator reconciliation; the server does not choose one.
A missing/deleted previously claimed owner remains recovery state. Signup never
reopens, even if all user rows disappear or a new bootstrap proof is configured.
Normal owner deletion is disabled. Recovery requires trusted operator access.

Admitted sessions provision the private environment, a Trading Agent with reserved
spawn identity `trading:main:v1`, and its thread. Unique constraints make concurrent
provisioning idempotent. Startup also provisions an existing owner's agent.
The application session resolver requires this exact owner and private environment
for RPC, events, files and Computer access. Existing stream authorization checks
reuse that resolver. Unknown messaging senders do not auto-provision product access.
Public Space creation and reopening signup are denied by the backend.

The PostgreSQL auth regression suite uses an explicitly selected fixture database
whose name ends in `_test`. It verifies real concurrent signup, hidden user inserts,
service identity conversion, lost-owner recovery, foreign principals/environments,
and idempotent server provisioning. It never calls a broker.

This boundary does not itself authorize financial actions. Trading policies,
mandates, risk limits and effects remain separate requirements.
