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
| `apps/web/src/pages/Auth.tsx`, `apps/mobile/app/sign-in.tsx` | Proof-gated owner onboarding | Setup proof stays outside user payload/storage | Auth form extension | MEDIUM |
| `apps/web/src/pages/Onboarding.tsx`, shell/client navigation | Server Main Agent/private environment | Browser cannot bootstrap a competing Main identity | Product onboarding | MEDIUM |

Owner-only routing and server Trading Agent provisioning are active. Financial
execution is not yet implemented. Run orchestration and the existing approval
executor are unchanged at this stage.

| `packages/db/prisma/schema.prisma`, broker migrations | Protected connections/session leases/read caches | Row-lock fencing; no conversation-owned account identity | Additive trading tables | HIGH |
| `packages/adapters/src/secret-persistence.ts` | Track connection credential references | Cleanup cannot delete an active broker secret | Existing SecretStore lifecycle | MEDIUM |
| `apps/worker/src/index.ts` | Own broker supervisor lifecycle | One fenced SDK session per account; shutdown drains sockets | Existing Worker composition | MEDIUM |
| `packages/contracts/src/rpc.ts`, `apps/api/src/router.ts` | Owner-only broker reads and stream subscription | Exact account/instrument scope; no raw secrets | Existing authenticated RPC/events | MEDIUM |
| `packages/adapters/src/builtin-tools.ts`, executor | Broker evidence discovery/read tools | Central execution path; no financial mutation | Existing tools and approvals | MEDIUM |
| Existing account/integrations settings | Named protected broker connections | Masked entry, no stored secret returned | Contextual settings extension | MEDIUM |

| Cloud Chart contracts/controller and DB migration | Durable account-scoped visual workspace | Run fencing, object revisions, private/shared ownership | Additive resource behind existing tools/RPC | MEDIUM |
| Web Shell contextual panel | Chart primary, Computer secondary | User viewing choice never changed by Bot activity | Existing right-panel architecture | MEDIUM |
| Pinned KLineChart Pro dependency and ESM lifecycle patch | Isolated interactive chart projection | Backend datafeed; no arbitrary chart code or browser authority | Vendor accessor/disposer | MEDIUM |
