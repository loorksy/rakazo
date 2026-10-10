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

The historical API supports bounded pages and a 16-page per-account cache (two-second
live pages, thirty-second historical pages); charts and indicators share evidence reads.
Completed-candle watchers and persisted reconnect gap backfill remain unimplemented.
Protected price-condition watches operate without an open client. Financial execution
remains separate unfinished work. No production credentials are used in tests.

The PostgreSQL fixture suite verifies concurrent claims, stale writes, rotation,
revocation, foreign-principal refusal, actual worker process death, read recovery,
shared provider sessions, exact broker symbols, quote deduplication, reconnect health
and authenticated stream cleanup. Only a dedicated database ending `_test` is accepted.

## Durable price-condition wakes

`market_watch` creates bounded, expiring BID/ASK threshold or crossing conditions.
The Worker uses its existing account socket and in-memory deterministic observer;
it never invokes the model for ordinary quotes. Useful crossings are captured before
visual quote coalescing so an intrabatch excursion is not lost. At most twenty
captured conditions are committed per fenced batch. Unmet high-frequency observations
remain ephemeral; they do not append quote history or update rows on every tick.

On a trigger, a watch row and one ordinary existing Task/Run are updated atomically.
A stable watch-ID/wake-generation nonce prevents repeated events creating more turns.
Existing job reconciliation recovers an enqueue interrupted after transaction commit.
Missing conversation delivery is retained, recreating the same Bot's conversation when
possible; no fallback Bot acquires authority. Run completion is receipted atomically by
a database trigger. Deleting unfinished delivery returns the logical wake to delivery
needed; deleting completed delivery never replays it. Failed/cancelled delivery becomes
needs-attention rather than a model retry loop. Watch edits require current Run fencing.

Streams are not an audit log. A process outage can miss a transient crossing before its
transaction commits; reconnect begins with fresh observations and never invents a
historical threshold event. Durable gap reconstruction and completed-candle conditions
remain separate work. Watch observation grants no trading permission.

## Trusted risk preflight

`broker_read` supports a strict `preflight` read for a final normalized action.
The existing account session obtains current account state, positions/orders, exact
symbol specification, quote/loss-tick value, contract size and SDK `calculateMargin`.
No mutation is sent. Worker persistence checks account/instrument/symbol identity and
fences the verification write. There is no preflight cache or model-supplied risk
calculation. Missing provider margin/conversion evidence remains unknown and the
Risk Engine refuses an increase. SDK numeric inputs must preserve decimal text on
serialization round trip; larger unsafe integers are rejected.

Main alone may read account/position/order/preflight state in the trading deployment.
Every Agent retains broker quote/history/specification discovery without financial
account authority. The existing owner-only human RPC can inspect the account.
