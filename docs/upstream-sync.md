# Updating the trading fork

`origin` is the product fork. `upstream` is the original Rakazo repository and
is read-only. Product development stays on `trading`; `main` stays upstream-friendly.
Never force-push shared history. Never modify, vendor, or depend on Kili.

Before an update, ensure a clean working tree and review both remotes. The upstream
push URL should remain disabled locally.

```sh
git fetch upstream
git fetch origin
git switch main
git merge --ff-only origin/main
git log --oneline main..upstream/main
# Review changes before updating main. If ancestry diverges, inspect instead of resetting.
git merge --ff-only upstream/main
```

Run the original platform checks before pushing `main`. Then integrate on the
product branch using a normal merge:

```sh
git push origin main
git switch trading
git merge main
```

Inspect auth/bootstrap, owner scope, Bot identity, Run fencing, Worker jobs,
Computer/browser/network tools, approvals, Auto Review, ExternalEffect, secrets,
RPC/events, deletion cascades, Prisma migrations, and all client shells. Consult
`upstream-trading-delta.md`. Never resolve these conflicts mechanically.

Use the pinned pnpm version. Generate Prisma, run unit/integration/offline Pi
tests, TypeScript checks, Biome, applicable platform builds and security gates.
Automatic verification must not enable provider canaries or place broker trades.
Only after these checks pass:

```sh
git diff --check
git push origin trading
```

Do not merge product changes into upstream or `origin/main`. Do not rewrite or
discard legitimate local or remote work to make this sequence succeed.
