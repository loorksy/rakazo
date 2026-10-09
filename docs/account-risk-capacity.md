# Account reservation capacity

Preview and atomic STARTED admission share `accountRiskCapacity`. All arithmetic uses
bounded decimal text and fixed-point integers. PostgreSQL account row locks serialize
reservations across Main-agent missions; the core function itself grants no authority.

Allocated capital is a hard **aggregate mission margin budget**, including its positions
and pending/reserved/uncertain actions. It does not segregate broker funds. Loss, notional,
open-risk and global account limits apply independently and can be stricter.

Confirmed pending orders continue to reserve their projected margin: brokers may report
zero used margin for an unfilled order. Used account margin plus uncommitted and pending
reserved margin plus the proposed margin must fit fresh free margin and the stricter
account/mandate percentage. Used margin for a confirmed position is already in the trusted
account snapshot and is not added twice. Ambiguous effects retain capacity until resolved.

Reserved risk, exposure and pending exposure include all consuming reservations in the
same account and mode; simulation and LIVE never share a ledger. A proposed pending order
is included in the pending ceiling before admission. Existing preview/reservation records
do not entitle an action to old capacity: admission recalculates the current totals.

Validated reductions are not blocked merely because existing reservations exceed a
ceiling. Target attribution, permissions and fresh broker state are checked independently
by financial policy/risk. The currently integrated reservation path still requires OPEN;
management admission requires its provider-owned attribution integration.
