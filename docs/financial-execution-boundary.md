# Financial execution boundary

This checkpoint establishes hard tool restrictions and durable audit storage. It
is not an enabled trading executor or finished autonomous mission implementation.

The enforced single-owner trading deployment evaluates `financialToolPolicy` in
the existing Run executor after catalog resolution and before user allow rules,
Auto Review, approval replay, effect recording or provider/tool execution. Every
Bot and peer uses the same check. A mandate cannot bypass it. Non-trading upstream
deployments retain their original behavior.

Opaque browser/Computer interaction, process launch, shell, generic filesystem
access, credential injection, external cloud agents and arbitrary connector/MCP
execution are denied to automated control. Tool descriptions, read-only hints,
innocent names and user always-allow rules cannot prove a financial envelope.
This conservative first boundary intentionally rejects harmless opaque actions as
well as financial ones. It does not claim that domain-name filtering can stop a
broker portal, authenticated terminal or disguised MCP mutation.

Computer remains available to the owner through human takeover; the Bot can
observe it. Automated public research uses the existing credential-free web
search/fetch interfaces. Chart and broker reads, structured chart/indicator work,
market watches and delegation remain available. Narrower verified research-only
Computer/connector capabilities are not implemented at this checkpoint. Ordinary
Computer tools cannot inspect or write browser credential storage through files.

Broker API secrets continue to be protected connection references resolved only
inside Worker adapters. They are not AgentSecret/BotSecret credentials, browser
sessions, shell environment values or peer capabilities. Human browser login
never grants structured broker authority.

## Independent financial evidence

Existing `ExternalEffect` records now keep nullable delivery references with
`ON DELETE SET NULL` for Runs and Spaces. Ordinary conversation/Bot cleanup does
not remove an effect. A financial context records version, owner, authorized Bot,
account, mode, exact action fingerprint, authorization and policy version. It
must be supplied by trusted execution code, not model arguments.

Financial material identity/request/idempotency keys are database-immutable once
set; financial effect deletion is rejected. Dedicated versioned financial journal
snapshots are immutable and have no conversation or Bot cascade. Journal mode is
SIMULATION or LIVE; caches and high-frequency market telemetry are not journal
entries. Financial claim/approval/provider-reference fields are reserved for the
upcoming trusted execution lifecycle. No broker mutation port is exposed yet.

Deterministic policy tests include real executor catalog and direct dispatch,
always-allow and reviewer non-invocation. PostgreSQL tests verify actual deletion,
immutable financial payloads and journal preservation. No live credentials or
broker calls are used.
