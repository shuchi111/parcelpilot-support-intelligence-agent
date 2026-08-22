# Product Note

## Which additional client problem did we choose, and how was it addressed?

**Both — with different depths, on purpose.**

**Problem 1 (Proactive Issue Detection) → shipped as a feature: Ops Radar.**
An internal, role-gated view that answers "what deserves attention right now?" with deterministic, explainable signals:

- **SLA risk/breach** per open ticket — severity classified from Policy v3 §2 definitions; response targets resolved from the *customer's signed agreement first*, then plan defaults; business-hours/weekend-aware clock (LumenWorks' Sunday tickets correctly show *paused*, not breached).
- **Known-issue correlation** — tickets matched against `KI-xxx` entries from the ops guide, with warnings when historical ticket advice contradicts them (TKT-451 told a customer the wrong row limit).
- **Recurring themes** — the same complaint surfacing across tickets/time (bulk-upload failures on Aug 11 and Aug 16).
- **Order anomalies** — failed pickups (ORD-2002), stale pending cancellations (fee windows are time-sensitive), and status-vs-reality conflicts (ORD-1001 BOOKED while TKT-504 reports physical pickup → freeze cancellations until verified per KI-211).

Every card carries *what / why (with citations) / suggested action*, and one-click hands off into the agent chat with a prefilled investigation query. The same signals power the `ops_signals` tool so staff can ask in plain language.

**Problem 2 (Trust & Reliability) → shipped as the architecture spine.**
Not a feature but the system's default posture: tiered source authority with account-scoped contracts, deprecated-document detection & exclusion, poisoned-history warnings, deterministic math via a calculator tool, citations on every answer, an explicit uncertainty protocol (never promise a credit when fault is unknown; state breaches plainly), and two-phase user-only confirmation for actions. The 13-test structural suite + 15 live behavioural scenarios pin these properties so they can't regress quietly.

## What we'd build next for ParcelPilot (prioritised)

1. **Feedback + eval loop** — thumbs up/down on answers and escalation outcomes feed a regression suite; every policy/doc change re-runs the scenario suite before deploy. *Why first: adoption lives or dies on answer quality, and quality needs a measurement loop.*
2. **Real integrations** — actual ticketing/carrier APIs behind the existing tool interfaces; the mocked ActionStore already has the audit trail for it.
3. **Doc-diff alerting** — when a new policy version lands, diff it against the old, flag answers that would change, and update citations. Turns "policies change" from a risk into a workflow.
4. **Radar push channels** — Slack/email digests and thresholds learned from baselines instead of only on-demand. The detectors are already deterministic; distribution is the missing half.
5. **Hybrid retrieval (embeddings + rerank)** — the corpus is 21 chunks today; BM25 is the right tool. At a few hundred documents, add embeddings + a reranker behind the same `doc_search` interface.
6. **Multilingual customer channel** — IN regional languages for the customer-facing bot.

## What we intentionally left out (and why)

- **Real authentication/SSO and a database** — the assessment permits mocking; we spent the effort on the *enforcement* layer instead (which is real and tested). Sessions and state are in-memory/JSON.
- **Vector database / embedding pipeline** — zero benefit at this corpus size; adds a service and non-determinism. Documented upgrade path instead.
- **Autonomous execution of actions** (auto-cancelling orders, auto-issuing credits) — deliberate: money-adjacent actions should stay confirmation-gated even though it would be easy to remove.
- **Fine-tuning / model training** — retrieval + deterministic tools address the failure modes more cheaply and auditably.
- **Realtime carrier status verification** — KI-211 conflicts are surfaced to humans; a carrier API integration is future work.

## One metric to judge usefulness

**Containment-with-correctness: the % of support requests the agent resolves without human intervention *and* without a later correction/escalation on the same thread.**

Why this one: raw containment can be gamed by confidently wrong answers (exactly what ParcelPilot fears); raw accuracy ignores cost savings. The compound metric forces both. Practical proxy today: the live scenario suite's pass rate (behavioural contracts written from the client's own trap cases); in production it becomes measurable from outcome labels ops staff already apply (escalated? reopened? corrected?).
