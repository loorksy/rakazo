# Broker provider boundary

`MetaApiBrokerProvider` uses the native Node entry of the pinned
`metaapi.cloud-sdk@29.3.3`. The default package entry targets the browser and is
not used. The SDK license permits applications using MetaApi.cloud; it is a
vendor-specific license, not Apache-2.0. No vendor source is copied or patched.

The installed ESM declarations contain extensionless module references that do
not resolve under NodeNext. `metaapi-sdk.d.ts` describes the audited narrow Node
port explicitly rather than accepting implicit `any` exports.

The current port provides authenticated read sessions only: account, positions,
orders, exact broker symbols/specifications, pricing, historical candles and
stream subscriptions. Credentials are resolved by a trusted callback and never
returned. The adapter does not deploy or modify provider accounts. It refuses
disconnected accounts, region mismatch, malformed provider data and unbounded
history requests. Read capability does not imply execution authority.

Financial values are normalized to bounded decimal strings. Negative P&L is
preserved. Quote times and candle opening times are explicit UTC timestamps;
collection time is separate. History is deduplicated and ordered, and current
candles remain incomplete. Unknown account margin modes remain `UNKNOWN`;
broker `DEMO`/`REAL` is independent of product `SIMULATION`/`LIVE`.

Multiple listeners share reference-counted subscriptions; subscription mutations
are serialized. Closing removes listeners and closes streaming, RPC and SDK
resources. Stream errors never expose provider payloads. Application-visible
exceptions contain only normalized codes. Packet logging is disabled and the
SDK console logger is switched to its optional Log4js facade (no logging backend
is installed). Do not enable raw vendor diagnostic logging in production.

Deterministic SDK fixtures test reads, account identity, history, completeness,
subscription concurrency/rollback, precision rejection and sentinel-secret error
redaction. These tests never create a live SDK session or send broker mutations.

## Protected connections and Worker lifecycle

The owner saves multiple named accounts through the existing account settings
(Web/Electron) or native integrations settings. Stored connection records contain
only encrypted SecretStore references; tokens never become AgentSecret/BotSecret,
Computer environment variables, tool arguments or returned configuration. Rotation
increments a credential generation; revocation retains account identity and removes
the credential reference. Account IDs and regions accept bounded identifiers.

`BrokerConnectionSupervisor` runs inside the existing Worker. PostgreSQL row locks
(connection before lease) serialize claims. Leases expire after 30 seconds and are
renewed every five seconds. Every authoritative session write requires the claimed
holder, execution generation, credential generation and an unexpired lease. A late
worker cannot regain authority merely by rereading current state. Shutdown aborts
in-flight connects and closes subscriptions, RPC and streaming sockets.

API and agent tools enqueue only strict normalized read requests; the lease owner
fulfills them. Interrupted reads may restart after takeover; no mutation endpoint is
exposed. Reconnect attempts use bounded exponential backoff, and rate-limit responses
hold subsequent reads briefly. `trading_accounts` discovers safe account metadata;
`broker_read` discovers exact account-scoped instruments and retrieves evidence.

Quotes use the existing authenticated RPC/PostgreSQL fan-out transport. UI subscription
leases drive shared provider demand. Per-symbol queues coalesce bursts and reject
older/duplicate events; quote delivery does not wait for slow historical reads.
Packets carry the provider-session generation and remain below NOTIFY limits.
There is no LLM call on an account/quote observation. Quote queues are ephemeral;
expired subscription rows are swept each minute and read request/result caches are
removed after one day. These caches are not financial audit records.

The current historical API supports bounded pages, not persisted gap backfill or
completed-candle watchers yet. Application charts and financial execution remain
unfinished. No production credentials are required by the deterministic tests.

The PostgreSQL fixture suite verifies concurrent claims, stale writes, rotation,
revocation, foreign-principal refusal, actual worker process death, read recovery,
shared provider sessions, exact broker symbols, quote deduplication, reconnect health
and authenticated stream cleanup. Only a dedicated database ending `_test` is accepted.
