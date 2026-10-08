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
