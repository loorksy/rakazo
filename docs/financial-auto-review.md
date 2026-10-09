# Independent financial review

Financial review reuses the existing `AutoReviewProvider` boundary and tool-free
reviewer runtime. The action and mandate fingerprints, acting owner/Bot, mode and
freshness are validated before review. A deterministic risk denial is final and
does not invoke a model. The reviewer receives the complete bounded authorization
envelope and exact action, risk result, plan version, concise rationale and evidence
references as structured data. It receives no broker credential or approval token.

`pass`, `ask` and `deny` remain distinct. Reviewer failure, unavailable configuration,
or a bounded timeout escalates to owner review. An uncooperative provider cannot keep
admission alive indefinitely. Cancellation yields no usable reviewer decision.
Sentinel secrets are redacted from input, reason and model label. Financial context
that exceeds the prompt bound is rejected rather than truncating hard limits.

The general existing execution boundary now also preserves explicit independent
denial, including cached denial on replay. Connector read-only hints do not override
it. An already ambiguous external effect remains uncertain rather than being relabeled
as an action that never happened. No reviewer result can grant a larger mandate.

The financial helper does not itself execute, approve or reserve funds. The execution
domain must persist its result under a current fence and recheck risk/authority before
starting an effect. That integration and the simulator/live executor remain subsequent
work at this checkpoint. Tests exercise the real tool boundary as well as deterministic
financial context binding, timeout, cancellation and secret redaction.
