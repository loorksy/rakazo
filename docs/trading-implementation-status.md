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
- Fail-closed single-owner admission decisions, bootstrap-proof digest verification
  and Main Trading Agent operating guidance. These are tested primitives, not yet
  wired into auth routes or provisioning.
- Fork synchronization instructions and an upstream-sensitive delta manifest.

The existing runtime, Computer, Worker, authentication, database, approval executor
and clients remain unchanged. This checkpoint does not enable trading or enforce
single-owner access across the application.

## Verification

- Core/contracts suite: 1,008 passed, one platform-prerequisite skip across 83 files.
  The skipped terminal identity test requires `libnss_wrapper` in the test image.
- New trading/owner/fingerprint coverage: 43 passed.
- Contracts and core TypeScript checks, scoped Biome and Git whitespace checks pass.
- Core/contracts tests ran in a network-disabled container with an isolated process
  namespace. The existing Chromium quiescence test times out in a process namespace
  with thousands of unreaped zombies; it passes unchanged in the clean namespace.

## External setup blocker

Prisma generation requires verified schema-engine artifacts from
`binaries.prisma.sh`. The environment's active outbound policy denies that domain
with HTTP 403. Even `prisma generate --no-engine` needs the schema engine.
No checksum or TLS bypass was used.

A reusable environment configuration draft adds that domain and the pinned pnpm
installation/generation commands. It must be published before the active policy
changes. Until generation succeeds, auth/database/API/Worker integration, their
full type checks and application builds are unverified. The complete product
transformation remains unfinished.
