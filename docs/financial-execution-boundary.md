# Financial execution boundary

This checkpoint establishes hard tool restrictions and durable audit storage. It
is not an enabled trading executor or finished autonomous mission implementation.

The enforced single-owner trading deployment evaluates `financialToolPolicy` in
the existing Run executor after catalog resolution and before user allow rules,
Auto Review, approval replay, effect recording or provider/tool execution. Every
Bot and peer uses the same check. A mandate cannot bypass it. Non-trading upstream
deployments retain their original behavior.

Computer, Browser, Terminal, Files and integrations remain available. File and
research tools retain normal product policy. Opaque mutation-capable Computer,
shell, browser, credential, cloud-agent and connector calls require an independent
`trading_support` review before generic approval rules, replay or execution.
A missing reviewer, timeout, error, ask or denial blocks automated dispatch; only
an independent pass proceeds to normal Rakazo policy. Always-allow rules and
turning off generic Auto Review cannot skip this check. Human takeover remains.

The support reviewer is explicitly instructed to deny financial mutations and
broker credential disclosure through generic routes, including broker portal
buttons, exchange order forms, shell/API code and generic MCP/OpenAPI calls.
Financial actions must use the structured Trading Core path with their own
mandate, deterministic risk, independent financial review and durable effects.
Support tools never acquire a financial authorization envelope.

This restores research workflows without a blanket Computer shutdown. The
support review is a model-based inspection boundary, not deterministic proof of
arbitrary program behavior. A hostile-code/network containment guarantee remains
unverified; passing these fixture tests does not establish LIVE readiness.

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
