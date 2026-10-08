# Upstream-sensitive trading deltas

Baseline: `794a76da6eb0a73532a89cf57d2f202ef9b6b6c8`.
This manifest describes implemented deltas only. It is not a list of proposed features.

| Upstream module | Reason | Security effect | Extension opportunity | Conflict risk |
| --- | --- | --- | --- | --- |
| `packages/contracts/src/index.ts` | Export versioned trading contracts | Strict financial payload validation; no credentials | Domain contract export | LOW |
| `packages/core/src/index.ts` | Export single-owner admission contract | Fail-closed ownership/recovery decisions | Product authorization extension | LOW |
| `packages/core/package.json` | Node-only fingerprint/bootstrap export | Keep cryptographic authority helpers out of browser imports | Explicit platform export | LOW |

The new contracts do not yet activate owner-only routing or financial execution.
Those integrations require separately verified auth/database changes. Computer,
Run orchestration and the existing approval executor are unchanged at this stage.
