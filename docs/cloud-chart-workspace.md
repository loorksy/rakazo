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

## Current scope

Indicator instances are reserved in the format but indicator calculation/registry
and chart-only vision rendering are subsequent implementation work. Mobile native
interactive chart integration is not yet implemented; this checkpoint verifies the
web/Electron adapter. No financial execution authority is granted by chart tools.
