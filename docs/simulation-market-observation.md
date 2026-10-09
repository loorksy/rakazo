# Simulation market observations

The existing Worker broker connection supervisor observes SIMULATION exposure using
fresh broker-native MetaApi quotes. It creates no broker mutations, agent runtime or
scheduler. Quote calculations live beside the existing pure simulator in core.

Financial preflight subscribes before returning evidence. A bounded 256-tick buffer
retains sequential financial quotes before visual quote coalescing; the protected
account book determines which ticks fill or close exposure. Simulation positions and
orders keep subscriptions active without an open client. Financial symbols receive
priority within the account's 256-symbol subscription limit.

BUY entries use ask and SELL entries use bid; exits use the opposite spread side.
LIMIT and STOP triggers are direction-specific. Stops and targets execute at the actual
observed quote, including gaps. A gapping fill may hit its stop in the same observation.
Expiry wins over fill and does not require a quote. These calculations do not guarantee
maximum realized loss or profitable outcomes.

The account row lock serializes observation, admission, management and owner stop.
Broker-origin writes additionally require the current connection lease generation,
holder and credential version. Every outcome must have an exact original financial
effect, immutable local acceptance receipt and account/mandate/mode-bound reservation.
Book revision, outcome receipt, risk reservation, performance, journal and logical wake
commit together. Outcome receipts are immutable and unique by account/target/type.
Process death after commit cannot repeat the fill, close or accounting change.

Pending fills convert the original reservation from PENDING to POSITION, retaining
risk. Adverse gaps conservatively increase the reservation using its approved risk
bound and entry-to-stop distance; notional and margin cannot decrease on fill. Actual
gap losses can exceed the intended cap. Closures/expiration release the original
reservation. The original execution receipt remains unchanged.

Rebuildable quote cursors retain one latest quote per active instrument, with durable
source-time watermarks. One latest quote per instrument is written per flush; individual
high-frequency ticks are not stored as history. Duplicate/out-of-order timestamps and
ticks before an object's latest edit are ignored. Equal timestamps use the first accepted
tick. Both provider and receipt times must be within 15 seconds, allowing two seconds
of future clock skew. Unneeded cursors are removed when exposure disappears.

`SimulationBook.nextExpiryAt` projects the earliest exact pending deadline. The existing
Graphile host runs `trading.simulation-expire`, keyed by account/deadline. Replaced or
early deadlines do nothing. Financial acceptance queues it immediately; the existing
reconciler repairs commit/enqueue gaps and downtime. The handler processes due expiry
and queues the next deadline. No new timer service and no expiry-time LLM are involved.

Portfolio valuation requires fresh prices for every open instrument. Mission realized
and unrealized P&L remain distinct from real/manual broker activity. Target attainment,
hard mission/daily loss or potential open-risk breach stop new risk deterministically.
Account reservation/exposure breaches freeze shared account capacity. These transitions
and order/fill/exit events create stable ACCOUNT_EVENT wakes through the existing
mission wake/Task/Run path. Normal quotes never create model turns. Terminal mission
events remain deliverable after expiry, target, risk stop or cancellation.

The ordinary provider loop checks stale portfolio observations. Queue overflow,
connection failure/disconnection, or a replacement provider generation with existing
exposure moves active missions to NEEDS_ATTENTION and journals a single transition.
This does not synthesize unseen historical fills. Exact reconnect gap backfill and owner
mission resume remain subsequent work. Existing protective simulation conditions can
still resolve already-authorized exposure while new risk is paused.

FREEZE is implemented for target/loss/expiry. Pre-authorized CANCEL_PENDING or
CLOSE_ATTRIBUTED_EXPOSURE finishing effects are not yet dispatched at this checkpoint.
LIVE execution remains disabled. Real manual-position supervision, fees/swaps, changing
broker margin requirements and formal LIVE readiness are also unfinished.

Tests use deterministic quotes and PostgreSQL only: all four entry trigger combinations,
spread, gaps, expiry, source ordering, retained pending risk, atomic rollback, immutable
receipts, stale provider rejection, target/loss delivery, transient stream excursions
without a client, and actual process death after an observed close. No automated test
places a real trade.
