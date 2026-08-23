# ParcelPilot Support Intelligence Agent

An AI support system for **ParcelPilot** (B2B logistics platform) built for the CalQuity AI Engineer assessment — a customer-facing support chatbot **and** an internal support/operations agent from one core, plus **Ops Radar**, a proactive issue-detection view.

```
Customer chatbot  →  answers scoped to the customer's own account, with citations
Internal agent    →  cross-account investigation, SLA triage, radar signals
Ops Radar         →  deterministic, explainable "what deserves attention" board
```

**Design spine — trust:** tiered source authority (signed agreement → policy → product docs → *unverified* history), deprecated documents detected & excluded, deterministic math, two-phase confirmed actions, and access control enforced in the data/tool layer (never only in prompts).

---

## Quick start (3 commands)

```bash
cp .env.example .env    # then set LLM_API_KEY (any OpenAI- or Anthropic-compatible provider)
npm install
npm start               # → http://localhost:3000
```

Keyless demo mode: set `MOCK_LLM=true` in `.env` for a scripted stand-in (full UI, tools, and confirmation flow — just scripted answers).

### LLM configuration (provider-agnostic)

| Provider | `LLM_BASE_URL` | `LLM_MODEL` | Style |
|---|---|---|---|
| **z.ai GLM** (current) | `https://api.z.ai/api/anthropic` | `glm-5.2` | anthropic (auto-detected) |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | openai |
| Groq (free tier) | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | openai |
| Gemini (compat) | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash` | openai |

`LLM_API_STYLE` is auto-detected from the URL (`anthropic` in the host path → Anthropic Messages format). Tested end-to-end with **GLM 5.2 via z.ai**.

### Demo identities (mock auth — the assessment permits it)

| Identity | Role | Scope |
|---|---|---|
| Nadia Rao — Northstar Logistics | customer | ACCT-001 only (Enterprise, custom agreement) |
| Sam Iyer — LumenWorks | customer | ACCT-002 only (Growth, custom agreement) |
| Ritka Shah — Beacon Retail | customer | ACCT-003 only (Standard, no agreement) |
| Dev Malhotra — Axis Labs | customer | ACCT-004 only (Enterprise, no agreement) |
| Maya K — Support Agent | staff | all accounts |
| Priya Mehta — Ops Lead | staff | all accounts + Ops Radar |

### Things to try

- As **Nadia**: *"Can I cancel ORD-1001 without a cancellation fee?"* → contract override + SwiftShip/KI-211 verification caveat
- As **Sam**: *"Our pickup for ORD-2002 was missed — are we owed a credit?"* → fixed ₹300 via their agreement (not the SOP default)
- As **Sam**: ask about **ORD-1001** → *"not found"* (cross-account access is blocked at the data layer)
- As **Maya/Priya**: *"What deserves attention right now?"* → radar-driven triage; then open the **Ops Radar** tab and click any signal's action button
- Ask anyone to **escalate something** → confirmation card; nothing executes until you confirm

## Tests

```bash
npm test -- --quick   # structural suite: access control, actions, calculator, radar (no key needed, seconds)
npm test              # + 15 live "grader-simulation" scenarios against the real LLM (~6 min)
```

The live suite encodes the assessment's traps as behavioural contracts: contract-over-policy overrides, deprecated v2 exclusion, poisoned historical-ticket advice, cross-account leak probes, SLA breach math, confirmation-before-action, and more.

## How it works (short version)

```
boot:  original pack (6 PDFs + XLSX) parsed at runtime → chunk registry with authority
       tiers → typed stores (accounts/orders/tickets, snapshot clock 2026-08-16 11:00 IST)
chat:  SSE stream → custom agent loop (≤8 tool steps) → 9 access-guarded tools →
       cited answers / staged actions → user-only confirmation path
radar: deterministic detectors (SLA w/ business-hours + contract overrides, known-issue
       clusters, recurring themes, order anomalies) → staff-gated /api/radar + agent tool
```

Details: [`ARCHITECTURE.md`](./ARCHITECTURE.md) (includes the **data-flow diagram**) · product decisions: [`PRODUCT.md`](./PRODUCT.md) · AI usage: [`AI_USAGE.md`](./AI_USAGE.md)

## Repository layout

```
src/
  server.js            Express app: /api/chat (SSE), /api/radar, actions, sessions
  config.js            env loading (+ IPv4-first DNS fix for Windows fetch)
  agent/               loop.js (function-calling), llm.js (OpenAI+Anthropic adapters, streaming), prompts.js
  tools/               guard.js (access enforcement), search.js (BM25, tier-aware), data.js, calc.js
  ingest/              pdf.js + xlsx.js (zero-dep parsers), chunker.js, registry.js, boot.js
  radar/               policyfacts.js (targets parsed from docs), severity.js, detectors.js
  store/               datastore.js, actionstore.js (two-phase + audit), sessions.js
public/                SPA (index.html, app.js, styles.css) — no build step
tests/                 runner.js, structural.js, scenarios.js (15 live contracts)
data/                  runtime artifacts (gitignored, regenerated each boot)
```

## Notes & assumptions

- The candidate data pack ships in this repo (`AI Agent Assessment - Candidate Pack/`) so `npm install && npm start` works anywhere; ingestion always reads the **original files** at boot (nothing pre-baked).
- Business hours assumed **Mon–Fri 09:00–18:00 IST** (docs don't define them; assumption stated in answers where it matters, e.g. LumenWorks' weekend-excluded SLA clock).
- All time math uses the workbook's snapshot (**2026-08-16 11:00 IST**), per the assessment instructions.
- Actions (escalations, ticket updates, follow-up tasks) are mocked locally with a persisted audit log (`data/actions.json`).
