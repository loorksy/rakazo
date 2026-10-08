# Upstream-sensitive trading deltas

Baseline: `794a76da6eb0a73532a89cf57d2f202ef9b6b6c8`.
This manifest describes implemented deltas only. It is not a list of proposed features.

| Upstream module | Reason | Security effect | Extension opportunity | Conflict risk |
| --- | --- | --- | --- | --- |
| `packages/contracts/src/index.ts` | Export versioned trading contracts | Strict financial payload validation; no credentials | Domain contract export | LOW |
| `packages/core/src/index.ts` | Export single-owner admission contract | Fail-closed ownership/recovery decisions | Product authorization extension | LOW |
| `packages/core/package.json` | Node-only fingerprint/bootstrap export | Keep cryptographic authority helpers out of browser imports | Explicit platform export | LOW |
| `packages/auth/src/index.ts` | Product-only owner checks on user/session hooks | Proof-gated registration, owner recovery stays closed | Trusted `ownerOnly` composition option | HIGH |
| `packages/db/prisma/schema.prisma` | Persistent owner bootstrap state | Database trigger serializes human insertion | Additive deployment fields and migration | HIGH |
| `packages/db/src/index.ts` | Export trusted owner provisioning/access helpers | One owner and private environment | Domain helper export | LOW |
| `apps/api/src/app.ts` | Activate owner boundary on actual application paths | RPC/events/files/Computer share owner resolver | Composition root | HIGH |
| `apps/api/src/env.ts` | Read operator bootstrap proof | Backend-only setup authority | Protected deployment configuration | MEDIUM |
| `apps/api/src/router.ts` | Deny Space creation and signup reopening in product | UI cannot create extra owner environments | Product state checks before generic mutations | MEDIUM |
| `packages/adapter-kit/src/index.ts` | Export provider-neutral broker ports | No raw SDK/credential surface | Domain interface export | LOW |
| `packages/adapters/src/index.ts` | Export native read provider | Normalize and redact before tools | Provider composition | LOW |
| `packages/adapters/package.json`, `pnpm-lock.yaml` | Pin native MetaApi SDK | Read-only adapter and explicit vendor license | Provider dependency | MEDIUM |
| `apps/web/src/features/auth/Auth.tsx`, `apps/mobile/app/sign-in.tsx` | Proof-gated owner onboarding | Setup proof stays outside user payload/storage | Auth form extension | MEDIUM |
| `apps/web/src/features/shell/Onboarding.tsx`, shell/client navigation | Server Main Agent/private environment | Browser cannot bootstrap a competing Main identity | Product onboarding | MEDIUM |

Owner-only routing and server Trading Agent provisioning are active. Financial
execution is not yet implemented. Run orchestration and the existing approval
executor are unchanged at this stage.
