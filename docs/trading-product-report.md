# Trading product

One owner. Several professional trading Agents, created by that owner, with no mandatory
Main Agent and no predefined roles. Agents are peers. Financial authority is an exact
Agent + account + Mandate. A peer message never transfers it. LIVE stays disabled until
the owner enables the product and every backend admission check passes on its own.
No automated real-money mutation is authorized.

Kili is a read-only reference. It is not modified, embedded, or pushed.

## Implemented

- Shared trading foundation on every persistent Agent Run, including Computer, Browser,
  Terminal, Files, Web, Memory, Routines, Cloud Chart and peer collaboration.
- Provider-neutral financial actions, mandates, deterministic risk, account guardrails
  and an isolated simulator with fills, expiry, protective exits and cross-run recovery.
- MetaApi read sessions (account, instruments, specifications, quotes, candles, positions,
  orders) plus a controlled LIVE mutation port. Credentials stay in SecretStore, per
  account, write-only. There is no global `METAAPI_TOKEN`.
- Durable LIVE dispatch: one send claim, no resend after a crash, positive provider
  reconciliation, exact hedging attribution. Netting ambiguity blocks new risk.
- Owner LIVE controls, manual-drift detection, drift reconciliation that cancels prior
  authority, and supervision of an exact owner-opened position.
- Broker deal history read in bounded batches. A long account history is not dropped at
  100 positions. Verified history is stored per position and reused for realized PnL.
- Broker-side stop, target, pending fill and pending expiry settle when the deal evidence
  matches. A manual close or cancel remains drift. The owner can retire a permanently
  uncertain effect without Rakazo inventing the outcome.
- LIVE admission compares the database with the migrations shipped in the running build
  and requires the Worker health attestation to carry that same fingerprint.
- Research egress for trading deployments allows anonymous public GET/HEAD and refuses
  broker execution hosts, credential parameters, private and metadata addresses, request
  bodies and opaque tunnels. Containment mode cannot be lowered from the settings UI.
  `SANDBOX_COMPUTER_EGRESS=financial` remains a required condition while LIVE is admitted.
- Owner settings for an allowlisted runtime set (computer size, idle, tool-call fuse,
  worker concurrency, log level, Axiom dataset, calendar provider). Axiom and calendar
  credentials are write-only SecretStore values. Bootstrap secrets
  (`DATABASE_URL`, `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`,
  `SANDBOX_SUPERVISOR_TOKEN`, `SCREEN_PROXY_SECRET`) show Configured, Missing or
  Placeholder only.
- A versioned trading playbook shared by every Agent. Retrieval is by instrument,
  timeframe, task and news phase. Gold-only rules are not returned for other instruments.
  Fixed gold-point distances are not reused. Heuristics do not create a mandate and do
  not override a risk denial or a news freeze. WAIT stays valid.

## Verified locally

- LIVE PostgreSQL fixture suite, including process death, shared-account contention,
  history past 100 positions, protective exits, pending fill and expiry, schema mismatch
  and owner abandonment of an uncertain effect.
- Mission PostgreSQL suite.
- Real Docker hostile-process containment: research allowed, broker mutation and direct
  network blocked, no credential in the Computer, fake broker received no requests.
- Research gateway and egress-policy unit tests.
- Playbook retrieval, normalization, news precedence and session clocks.
- Owner deployment-settings PostgreSQL tests, including revision conflicts and the
  absence of stored credentials in the owner view.
- Web, mobile, API, Worker, core, contracts and adapter type checks.

These fixture results are not a production broker certification.

## Not production-verified

- No automated order has been sent to a REAL account.
- A DEMO provider mutation is performed only when an account is positively identified
  as DEMO and the deployment notes say so. Otherwise it was not performed.
- Private MetaApi acceptance of the LIVE mutation path is outstanding until that
  DEMO check is recorded.
- Electron is the web UI in a desktop shell. The desktop window suite is not part of
  routine verification.
- Mobile type checks and the shared contract do not replace a device visual pass.

## Owner configuration

| Setting | Where | Secret | Restart |
| --- | --- | --- | --- |
| MetaApi account, token, region | Settings → Trading | token write-only, per account | no; the Worker reconnects |
| Computer memory, CPUs, pid limit | Settings → Deployment | no | new computers |
| Idle timeout, tool-call limit, calendar provider | Settings → Deployment | no | live |
| Worker concurrency, log level | Settings → Deployment | no | worker, and the API for log level |
| Axiom dataset | Settings → Observability | no | API and worker |
| Axiom token, calendar API key | Settings → Observability / secret slot | write-only | API and worker for the Axiom token |
| Bootstrap identity secrets | Observability shows presence only | never returned | not editable here |
| Playbook heuristic groups | Settings → Trading | no | live |
| `SANDBOX_COMPUTER_EGRESS` | process environment | no | supervisor; the UI cannot set it to `open` |

`ECONOMIC_CALENDAR_PROVIDER` (`fmp` or `finnhub`) and `ECONOMIC_CALENDAR_API_KEY` are
optional. The Worker polls a bounded window into a cache. Agents see those events
for the instrument's currencies, and the pre-release and release minute freeze new
entries. An unset or failed feed adds no events.
