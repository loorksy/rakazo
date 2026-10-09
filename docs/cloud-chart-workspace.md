# Persistent broker chart workspace

Cloud Chart is a backend resource, not a Computer/browser session or a client-only
chart. The existing Worker owns broker sessions; the authenticated trading RPC
supplies normalized account-scoped history and shared quote subscriptions. The
library's default Polygon datafeed is never instantiated.

`CloudChart` format 1 stores an exact account/instrument, broker symbol, timeframe,
semantic viewport, preferences, drawings and indicator-instance slots. Records have
no cascading relation to conversations, Bots or Runs. Closing the client or deleting
a conversation does not delete chart state. Credentials never appear in the record.

The owner may use every chart. The Main Trading Agent may use MAIN/SHARED charts;
other owner Bots may use SHARED or their own WORKER chart. Bots must belong to the
private owner environment. Every Bot mutation locks and verifies its current Run
lease/fence before changing a chart. A stale execution cannot regain write authority
by reading a newer chart revision.

Chart navigation and drawing creation use chart revisions. Existing drawings use
object revisions, so changing one object need not overwrite another. Bots can edit
only their own unlocked drawings; user-created objects require owner control. A
symbol switch retains drawings under their original instrument identity.

The `chart_workspace` tool discovers deployed drawing capabilities and performs
bounded structured create/get/list, instrument/timeframe/range, zoom/pan/jump/reset,
and drawing create/update/delete operations. No executable overlay JavaScript is
accepted. Fourteen safe semantic overlay types are checked against the installed
library in conformance tests.

## Client adapter

The web/Electron client uses Apache-2.0 KLineChart Pro **0.1.1** with KLineChart
**9.8.12**. SolidJS stays inside the vendor instance; React owns its container.
`patches/@klinecharts__pro@0.1.1.patch` adds only a native chart accessor and a
Solid render-disposer/destroy method to the ESM distribution. Local TypeScript
augmentation describes those two patched methods; vendor declarations remain intact.
The upstream source is the published 0.1.1 package pinned with its lockfile integrity.
No upstream source is duplicated and no installed `node_modules` file is edited.
UMD consumers are not supported by this patch; the product uses the ESM adapter.

The contextual chart panel opens from the existing chat header. A fresh chat defaults
to Chart; an explicit user choice of Computer or a closed panel is preserved.
Bot activity never selects a different panel. Computer remains independently usable.
No top-level Charts navigation is added.

History is paged in bounded requests and account/instrument checked before rendering.
Only the currently loaded forming candle accepts tick projection. Historical views
remain unchanged by live quotes; rollover requests fresh broker candles, coalesced
at most once per five seconds per subscription. Quotes do not fabricate completed
candles. Decimal-to-Number conversion is confined to visual coordinates.

A connected client receives small chart-operation notifications over the existing
realtime transport and fetches the newer snapshot. Semantic Bot anchors animate a
separate virtual cursor. Events older than five seconds are ignored; reconnect sends
current revision only, never a persisted cursor replay. Durable changes do not depend
on animation or an open client. Client shutdown disposes the chart and aborts history
and quote subscriptions.

User drawings are converted into bounded semantic anchors and saved through the
same revision-checked backend. A conflict reloads authoritative state; raw provider
exceptions are not displayed.

## Safe indicator registry

`chart_indicators` discovers versioned definitions, validates/tests a structured IR,
imports an owner-scoped JSON attachment, and returns exact computed analytical series.
It never evaluates JavaScript, Python, Pine or uploaded programs. Definitions are
immutable PostgreSQL records; an UPDATE trigger also prevents accidental in-place
rewrites by trusted backend code. A changed definition creates a new version. Charts
remain pinned until explicitly updated, and instance edits use object revisions and
creator permissions just like drawings.

The IR uses at most 64 ordered acyclic nodes, 16 bounded numeric parameters, eight
outputs, 512-bar lookbacks and 2,000 input candles. Its work budget is two million
primitive window operations. It supports OHLCV, arithmetic, rolling mean/min/max/sum/
standard deviation, shifts, comparisons/crossings, conditional series and confirmed
swing extrema. Swing outputs retain both confirmation time and the original anchor.
Missing inputs, warmup and division by zero produce unavailable values, never NaN.
Analytical calculations use bounded finite numbers; they do not authorize financial
execution prices, quantities or risk, which retain the independent decimal boundary.

Activation tests empty/short/missing-volume/history/timeframe cases, reproducibility
and maximum parameter/resource bounds. Tests measure safety/correctness, not profit.
Imports accept only safe JSON artifacts up to 64 KiB owned by the current principal
in the private environment; a Bot cannot import another Bot's private artifact.
Definition hashes deduplicate identical imports and retain filename/creator provenance.

The deployed registry includes optional SMA, rolling standard deviation and broker
volume definitions. No indicator is automatically applied and other vendor-native
indicator names are not advertised as backend-supported calculations. A trusted
KLine adapter projects validated results into line/bar/marker panes; uploaded source
never runs in the client. One shared broker evidence request supplies every visible
indicator. Five-second chart-only refresh is active only while a client is observing
visible live indicators; it does not call an LLM and stops on unmount. Ordinary quotes
remain streamed and do not reinitialize the chart or steal the user's viewport.

## Chart-only visual inspection and image delivery

`chart_inspect` provides exact loaded candles, shared chart evidence and optional PNG
rendering. Rendering consumes the same backend candles, saved viewport, visible
instrument-scoped drawings and immutable indicator versions/parameters. Semantic
anchors are projected on candle indices, including gaps. This deterministic SVG/Sharp
renderer has fixed width and bounded pane count/pixels; it has no navigation, Computer,
external images, uploaded SVG, model code or browser session. Text is XML-escaped and
uses DejaVu Sans with Arabic glyph support. Colors come from shared semantic tokens.
The renderer is identified as `chart-svg-v1`: mathematical scene correspondence,
not pixel-identical KLineChart Pro chrome. It implements all exposed drawing types,
including the vendor's mirrored third price-channel line and Fibonacci levels.

The existing Pi/provider-neutral `agent_tool_result` image interface forwards PNG
content only when the selected runtime accepts images. Non-vision runtimes receive
exact candle values, indicator calculations and metadata. No automatic vision call
occurs after drawing, cursor movement or quote receipt. `attach:true` stores a real PNG
in the existing ArtifactStore and publishes an image block in the current thread; the
agent does not need a generic filesystem or Computer path to send it. Saved image
metadata contains chart/revision identity; it does not persist private reasoning or
image base64 in the effects journal.

Late render publication locks the current Run generation and chart row before artifact
version allocation and again before chat publication. Stale ownership or changed chart
revision rejects publication. An orphaned stored blob is removed when guarded artifact
metadata creation fails. Financial authority is never conferred by an image request.

## Native mobile surface

The existing thread action menu opens a contextual Chart screen, without top-level
navigation. Saved charts restore; the owner can select any account's broker symbols,
open/reuse a chart, change timeframe and zoom through the same revision-checked commands.
Native mobile currently displays the chart-only backend PNG with explicit refresh.
This is a native fallback, not a second rendering/data engine or a general WebView.
The full KLineChart Pro interaction and virtual cursor remain available in responsive
web/Electron; native mobile freehand drawing/cursor animation are not yet implemented.

## Current scope

Chart storage, web/Electron workstation, safe indicator factory/import versions and
chart-only vision/image delivery are implemented. Native mobile has the contextual
structured-control/image fallback above. The remaining financial migration and live-readiness gate are separate implementation work; chart/indicator
features do not grant trading authority.
