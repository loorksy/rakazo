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
