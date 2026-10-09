# Trading implementation checkpoint

The product branch starts from upstream commit
`794a76da6eb0a73532a89cf57d2f202ef9b6b6c8`. Kili is a read-only reference;
no Kili source, runtime, dependencies or data are included.

## Implemented and verified

- Strict, versioned provider-neutral financial action, authorization-envelope,
  capability, quote and candle contracts in `packages/contracts/src/trading.ts`.
- Decimal strings retain financial precision. Validation rejects numeric coercion,
  inverted spreads and inconsistent candle bounds using bounded integer arithmetic.
- Canonical action and authority fingerprints in the Node-only
  `@rakazo/core/node/financial-action` export. Material account, mode, symbol,
  protection, quantity, expiry, owner, Bot and risk-scope changes invalidate hashes.
- Fail-closed single-owner admission, proof-gated bootstrap, database race protection
  and server-provisioned Main Trading Agent in the actual auth/application paths.
- Owner-only private environment resolution across RPC/events/files/Computer;
  ordinary clients no longer offer Space creation or create the initial Bot.
- Native MetaApi read-only SDK adapter with normalized account, symbol, quote,
  candle and stream interfaces; no execution method is exposed by this port.
- Fork synchronization instructions and an upstream-sensitive delta manifest.

The existing runtime/Worker and approval executor remain the execution foundation.
This checkpoint does not yet enable trading. Single-owner access is enforced.

## Verification

- Core/contracts suite: 1,008 passed, one platform-prerequisite skip across 83 files.
  The skipped terminal identity test requires `libnss_wrapper` in the test image.
- New trading/owner/fingerprint coverage: 43 passed.
- Contracts and core TypeScript checks, scoped Biome and Git whitespace checks pass.
- Core/contracts tests ran in a network-disabled container with an isolated process
  namespace. The existing Chromium quiescence test times out in a process namespace
  with thousands of unreaped zombies; it passes unchanged in the clean namespace.

## Prisma setup and owner enforcement

The former Prisma download blocker is resolved. Verified generation succeeds;
all 98 migrations, including single-owner/private-environment enforcement, apply
to fixture PostgreSQL.
No checksum or TLS bypass was used.

Owner enforcement now runs in actual auth/application paths. Six PostgreSQL auth
tests pass, and the original auth/db/API unit suite passes (858 tests, with separate
service-gated suites skipped). Auth/db/API TypeScript checks pass. See
`single-owner-trading.md`. The complete product transformation remains unfinished;
the foundational checkpoint above describes the earlier commit, not completion.

Owner client tests, mobile TypeScript checking and web production build pass.
MetaApi/financial-contract focused suites: 49 passed. Adapter TypeScript and
scoped Biome checks pass. See `metaapi-provider.md` for the SDK/license boundary.

## Broker session and chart checkpoint

Protected multi-account connection settings, owner SSO bootstrap, Worker-owned
fenced SDK sessions, bounded authenticated quote fan-out and broker history reads
are implemented. Thirteen PostgreSQL broker lifecycle tests include actual process
death, takeover, rotation and stale-writer rejection. All 101 migrations now apply
to a fresh fixture database with integrity checks enabled.

Persistent semantic Cloud Chart storage/controller and the isolated KLineChart Pro
web/Electron bridge are implemented; see `cloud-chart-workspace.md` for exact scope
and pinned vendor patch. The focused chart gate passes 67 tests, including seven
real PostgreSQL persistence/ownership/concurrency tests. Contract identity hardening
adds traversal/query rejection. All 765 web/related executor regression tests pass. Type checks and production web
build pass; existing bundle-size warnings remain. These are checkpoints, not full product completion.

Safe indicator IR, activation testing, immutable registry/versioning, owner-scoped JSON
imports, per-object authority/revisions and native plot projection are implemented.
The combined chart/indicator gate passes 85 tests, including 17 PostgreSQL cases.
KLine lifecycle patch correction is verified against the installed package and production
build; the final patch uses contextual ESM hunks and local type augmentation.

## Price-condition and image-delivery checkpoint

Chart-only deterministic PNG rendering, real owner-scoped image attachments, mobile
contextual chart fallback, bounded indicator/evidence calculations and provider decimal
precision hardening are implemented. Protected expiring price-condition watches now
share the existing Worker account sessions and Task/Run delivery; stream crossings are
captured before coalescing. There is no per-quote model call or second scheduler.

The focused PostgreSQL/observer/render gate passes 68 tests across four files, including
actual process death, stale provider/Run ownership, duplicate wakes, session deletion,
completion receipts and a real simulated SDK stream's brief crossing. Seven application
package type checks pass. Migrations 007/008 apply to fixture PostgreSQL; chart and broker
fixture databases have 104 migrations. Financial policy/risk/simulation/mandates/live
execution and readiness are still unfinished. This checkpoint is not product completion.

## Hard financial boundary and audit checkpoint

The trading deployment now denies opaque automated Computer/browser/process,
generic filesystem/credential and arbitrary connector/MCP actions before approval
rules or model review. Human takeover remains available; structured chart/broker
reads and credential-free public research remain available. This conservative
boundary deliberately limits automated Computer/connector research (see
`financial-execution-boundary.md`). It is not a claim that all generic tools can
safely express financial authorization.

Financial ExternalEffects and immutable journal snapshots survive Run/Bot/Space
deletion. Three PostgreSQL retention/immutability tests pass; 126 combined policy,
executor, broker and chart tests pass. All 105 migrations apply to two fresh fixture
databases without reset or verification bypass. Seven package type checks pass.
Risk engine, simulation, financial missions and live execution remain in progress.

## Deterministic risk and account-capacity checkpoint

Versioned full mandate envelopes, exact decimal risk arithmetic, account guardrail
and reservation storage, and the protected account-row-locked ledger are implemented.
The risk calculation covers bounded entry/protection, pending risk, supervision
reductions, volume/price constraints, attribution, margin and loss/exposure limits.
The ledger currently reserves new OPEN exposure only; management settlement, real
simulation execution and mission command/UI lifecycle remain pending.

Thirty-six focused risk/hash/PostgreSQL tests pass, including two concurrent missions
competing for the same account capacity, duplicate requests, stale Run ownership,
LIVE refusal, mode separation, immutable plans/mandates and exact broker mappings.
Seven package type checks, scoped Biome and whitespace checks pass. All 106 migrations
apply to a fresh fixture database. LIVE remains unavailable until the execution and
readiness work is completed. See `financial-risk-accounting.md` for precise semantics.

## Broker preflight checkpoint

Trusted MetaApi read preflight now obtains broker margin and exact symbol/quote,
account and exposure evidence through the existing fenced Worker session. Unsafe SDK
numeric conversion is rejected. Research peers cannot read financial account state.
Read preflight does not place a trade or authorize exposure.

MetaApi/risk tests pass (53), central scope/executor tests pass (83), and the existing
broker PostgreSQL lifecycle/process-death suite passes (15). Five changed-package type
checks, scoped Biome and whitespace checks pass. Mission command/UI lifecycle,
simulation execution and controlled LIVE execution remain unfinished.

## Goals, plans and owner-bound mandate checkpoint

Protected goals and immutable operational plan versions now have a real Main-only
`trading_mission` tool. Mandate proposals use exact owner/Bot/account/mode hashes;
human resolution, account guardrail administration and stop controls are separate
authenticated RPCs. Database constraints preserve goal, plan and mandate identity.
The risk ledger independently checks the goal time window. Owner emergency stop
freezes account capacity atomically and journals the event. Chat deletion preserves
the mission. LIVE activation is still unavailable.

Ten mission PostgreSQL tests pass on a fresh database with all 108 migrations.
The existing seven ledger PostgreSQL tests also pass with full goal definitions.
Focused central-policy/executor tests pass (94 at their earlier nine-mission checkpoint).
Five web mandate-card tests pass; the combined card/chart/approval suite passes (38).
Shared history/quote tests pass (64). Adapters/API/web and native-mobile TypeScript,
scoped Biome, whitespace checks and production web build pass. The native chart
remains the documented structured/image fallback. Simulation execution, durable
mission scheduling and controlled LIVE execution/reconciliation are still unfinished.
See `trading-missions.md` for current scope.

## Mandatory financial tool dispatch checkpoint

Main now has real `trade_execute` and `trade_reconcile` handlers in the existing
executor. SIMULATION uses the isolated virtual book and immutable acceptance receipts;
LIVE remains disabled. Independent financial review runs regardless of generic
Auto Review settings and always-allow rules. Escalation uses the existing owner-only
chat approval transaction, with fresh previews after an approval wait.

The mission PostgreSQL suite passes 49 tests, including process death, atomic
admission, exact owner approval and one-fill simulation execution. The focused
executor/reviewer/policy regression suite passes 145 tests. Adapters, core, database,
API and Worker TypeScript checks pass. See `financial-execution-tools.md`,
`financial-effects.md` and `trading-simulation.md` for the implemented boundaries.
Management dispatch, automatic simulator fills/exits, recovery from deleted Runs,
controlled LIVE provider execution and formal readiness remain unfinished.

## Cross-Run financial recovery checkpoint

Financial effect ownership now has an independent monotonic generation and a separate
captured Run fence. A new Main Run can reconcile an uncertain simulator effect after its
old Run was deleted or lost ownership, without another fill and without decreasing its
financial generation. Terminal/started inspection remains available after authorization
expiry, but grants no new authority. A valid old lease blocks cross-Run recovery.

The mission PostgreSQL suite passes 52 tests; the eight account-ledger PostgreSQL tests
also pass against all 114 forward migrations. Database/adapters/API/Worker type checks
pass. Simulation/live mode separation, stale-worker rejection and immutable receipts remain
enforced. Management and LIVE readiness are still incomplete.
