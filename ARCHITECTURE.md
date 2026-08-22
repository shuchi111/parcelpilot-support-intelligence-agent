# Architecture Note

> Companion to the code: agent design, tool design, document/structured-data handling, source reliability & conflict handling, and the trade-offs behind them.

## 1. System shape

```
Browser SPA ──SSE/REST──► Express server
                            │
                            ├─ SessionManager (mock identities → role + account scope)
                            ├─ Agent loop (custom, ~150 LOC, native function calling)
                            │    └─ LLM adapter (OpenAI-compatible | Anthropic Messages)
                            ├─ Tool layer (9 tools, every call passes the access guard)
                            │    ├─ DocSearch (BM25 over tiered chunks)
                            │    ├─ DataStore lookups (orders/accounts/tickets + derived math)
                            │    ├─ calculate (sandboxed arithmetic)
                            │    └─ prepare_action → ActionStore (two-phase)
                            └─ Radar detectors (deterministic signals, staff-gated)
Ingestion (boot): original PDFs/XLSX → chunk registry + typed stores + policy facts
```

One process, no external services. Boot ingestion takes <1s (tiny corpus) and re-reads the **original pack files**, which is the strongest possible answer to "load and reason over the supplied data": there is literally no pre-baked knowledge anywhere.

## 2. Agent design

- **Custom loop instead of a framework.** `agent/loop.js` is a transparent while-loop: send messages+tools → execute tool calls (guarded) → feed results back → repeat (≤8 steps) → final answer with extracted citations. Frameworks (LangChain etc.) would have added abstraction over exactly the parts the assessment grades: tool gating, confirmation, and the event stream.
- **Two personas, one runtime.** `prompts.js` varies the system prompt by session role: customers get account-scoped framing; staff get cross-account investigation + radar tooling. The *prompts* describe behaviour; the *tools* enforce it (see §4).
- **Snapshot clock.** The system prompt fixes "now" to the workbook's snapshot (2026-08-16 11:00 IST) for all time reasoning, so answers are reproducible regardless of real-world time.
- **Deterministic math.** Fees/credits/percentages go through the `calculate` tool (recursive-descent parser, no `eval`), so numbers shown to users come from code, not model arithmetic.
- **Events, not just text.** Every turn streams typed events (`tool_call`, `tool_result`, `delta`, `action_card`, `final`) which the UI renders as a live tool stream — the assessment's "interface should show which tool is being used."

## 3. Tool design (9 tools)

| Tool | Notes |
|---|---|
| `doc_search` | BM25 over section chunks; tier/status/scope badges; deprecated docs excluded from results but reported (`deprecatedMatches`) so the agent can say an outdated version was ignored; contract chunks are account-scoped |
| `get_order` | scope-checked; adds a `derived` block (elapsed minutes, 10% of fee) so reasoning uses correct arithmetic without policy conclusions baked in |
| `list_orders` / `search_tickets` / `get_account` | same guard; customers get redacted views (`notes`, `assigned_to` removed); closed tickets carry an `UNVERIFIED` warning on historical resolutions |
| `calculate` | sandboxed expressions (`min(500, 4200*0.10)`) |
| `ops_signals` | staff-only **in the tool layer** (role check in the executor) |
| `prepare_action` | stages a state change; returns a card; executes nothing |
| *(user-only)* `confirm/cancel` | **not LLM tools at all** — exposed only via the API endpoints/chat-confirm intent, bound to the preparing session, 10-min TTL |

The two-phase action design is the confirmation requirement made structural: the model literally has no function that executes state changes, and confirmations are user-originated events (card button or a server-verified "yes"). A jailbroken prompt cannot approve its own action.

## 4. Access control — enforced in the data/tool layer

- Every data tool funnels through `tools/guard.js`: a customer's order/ticket/account lookups are filtered to `session.accountId`; **cross-account lookups throw `not_found`** so the system never confirms another account's record even exists.
- Retrieval scoping: another account's contract chunks can never enter a customer's context (`DocSearch.search` filters by scope).
- Field-level redaction (`notes`, `assigned_to`) happens in the tool result, not the prompt.
- Role gates exist twice — prompt *and* executor (`ops_signals`, `/api/radar` 403) — so the model refusing is a courtesy, not the mechanism.

## 5. Document & structured-data handling

- **PDF extraction without dependencies** (`ingest/pdf.js`): FlateDecode streams, ToUnicode CMaps for CID fonts, and a coordinate-aware content interpreter for generators that position every word individually. The pack's PDFs use subset fonts that would come out as gibberish (or shifted columns) with naive extraction — this was built and validated against the actual files.
- **XLSX without dependencies** (`ingest/xlsx.js`): ZIP central-directory reader (streaming-written ZIPs zero local sizes) + sheet XML parsing that preserves empty cells as `null` — eliminating the silent column-shift bug class.
- **Chunking by document structure**: numbered sections and `KI-###` entries become chunks, each carrying tier/status/scope/effective-date metadata. The header line ("Status: CURRENT Effective: …") is parsed and cross-checked against the registry at boot so they cannot drift.
- **Typed store** with IST-aware dates; the README sheet supplies the snapshot clock.

## 6. Source reliability & conflict handling (Problem 2)

| Mechanism | Behaviour |
|---|---|
| Authority tiers | contract(1) → policy/SOP(2) → product docs(3); precedence stated in Policy v3 §1 is encoded in retrieval badges + prompts, and any tier-1/tier-2+ co-occurrence triggers an explicit override hint |
| Deprecated sources | v2 never grounds an answer; matches are reported as "detected & ignored" |
| Customer-specific overrides | contracts are account-scoped in retrieval, so "which SLA applies" resolves per account (Northstar 15-min vs Axis 30-min P1) |
| Poisoned history | ticket resolutions return with an `UNVERIFIED` warning; the prompt requires explicit correction when they contradict current sources (TKT-450/451 traps) |
| Uncertainty protocol | unknown carrier fault / timing → state what's unknown, never promise a credit (SOP §3); data conflicts surfaced (ORD-1001 "BOOKED but reported collected" → KI-211 verify-before-cancel) |
| SLA breach candour | breaches are stated plainly with the source of the target, escalation recommended (Policy v3 §4) |
| Citations | every factual answer cites chunk ids (`[DOC-05#2]`) rendered as chips |

## 7. Ops Radar (Problem 1) — deterministic on purpose

Signals are computed by code, not vibes: a severity classifier translated from Policy v3 §2 keyword definitions; SLA targets **parsed from the contract/policy text at boot** (with a loud fallback); business-hours/weekend clock (LumenWorks' Sunday tickets correctly show *paused*, not breached); known-issue correlation against `KI-xxx` chunks; recurring-theme clustering; and order anomalies (failed pickups, stale pending cancellations, status-vs-reality conflicts). Every signal card carries evidence, provenance, and a one-click handoff into the agent chat. Determinism makes it explainable, testable (asserted in the structural suite), and cheap — the LLM narrates; it does not detect.

## 8. Major trade-offs

| Decision | Alternative | Why this way |
|---|---|---|
| BM25 lexical search | Embeddings + vector DB | 21 section-chunks; lexical is deterministic, debuggable, zero-dependency, and doesn't add a non-determinism source for zero quality gain. Upgrade path is explicit when the corpus grows. |
| Custom agent loop | LangChain/LlamaIndex | The graded surface is tool-gating + confirmation + event streaming; a 150-LOC loop keeps those first-class and auditable. |
| In-memory + JSON persistence | SQLite/Postgres | Assessment scope; the ActionStore's audit log persists. DB swap is a Phase-2 product item. |
| Mock auth with identity picker | Real SSO | Assessment permits mocking; the *enforcement* (the part that matters) is real and tested. |
| LLM-agnostic adapter layer | Pin one provider | Graders may run it with any key; we verified GLM 5.2 (Anthropic-style) and designed for OpenAI-style too. |
| Policy facts parsed from text at boot | Hard-code the SLA table | Satisfies "load and reason over the supplied data"; if a future doc changes numbers, boot re-derives them (parse failure falls back loudly). |
| `min()` arithmetic in the model *may* skip `calculate` | Force tool for every number | Prompt mandates the tool; observed answers did the math correctly. Acceptable residual risk, noted here for honesty. |

## 9. Known limitations

- Sessions and chat history are in-memory (restart = fresh demo state).
- Business hours are an assumption (stated wherever they change an answer).
- The chunker trusts numbered-section structure; free-form documents would fall back to whole-doc chunks (fine at this size).
- Prompt-injection resistance relies on the guard rails (data-layer scoping, no confirm tool) rather than being separately hardened — the structural tests pin the important properties.
