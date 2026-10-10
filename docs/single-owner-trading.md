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

Admitted sessions provision only the private owner environment. They do not create
an Agent. The owner chooses the first Agent's name and focus after model setup,
and can create multiple persistent professional Agents later. Existing Agents and
threads survive upgrade; legacy spawn keys grant no privilege.

The application session resolver requires the exact owner and persisted private
environment for RPC, events, files and Computer access. Unknown messaging senders
do not auto-provision human access. Public Space creation and reopening signup
remain denied. No second human, invitations or financial human RBAC is introduced.

All persistent Agents receive the shared trading product foundation at Run prompt
composition, followed by their own identity/instructions and available capabilities.
No giant domain prompt is copied into new Bot records. Agents remain peers with
native Computer, Web, Files, Memory, Routines and collaboration. Their names and
roles are owner-defined. Optional account reads use per-Agent/account grants;
execution requires a separate exact owner-approved mandate.

The PostgreSQL auth regression suite uses an explicitly selected fixture database
whose name ends in `_test`. It verifies real concurrent signup, hidden user inserts,
service identity conversion, lost-owner recovery, foreign principals/environments,
and idempotent server provisioning. It never calls a broker.

This boundary does not itself authorize financial actions. Trading policies,
mandates, risk limits and effects remain separate requirements.

Owner SSO bootstrap validates the setup key on the initial sign-in request and
binds its digest to Better Auth's authenticated server-only OAuth state. The
callback does not depend on custom redirect headers; client `additionalData`
cannot supply authority. A proof admitted before another owner wins cannot create
a second owner. The same masked setup field is available for password and SSO-only
bootstrap on web/desktop and mobile. The raw proof is never placed in browser
navigation or the session store.

Product account-security capabilities disable ordinary owner deletion, including
email deletion-code requests. Clients hide that unavailable action. Generic upstream
mode retains its deletion workflow. Trusted operator recovery remains necessary
when the sole owner's credential is lost.
