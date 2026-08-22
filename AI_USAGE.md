# AI Tool Usage

Honest disclosure of how AI tools were used building this submission, per the assessment's requirement.

## Tools used

- **ZCode (Claude-code-style agent, powered by GLM)** — the primary collaborator across the build.

## How they were used

| Area | What the AI did | What the human did |
|---|---|---|
| Understanding the pack | Wrote zero-dependency PDF/XLSX parsers to extract every source (the pack's PDFs use CID-subset fonts that defeat naive extraction); produced the source/authority analysis and the trap map | Reviewed the extracted analysis against the documents |
| Planning | Drafted `doc/plan.md` (architecture, tool inventory, milestones, 15-scenario test matrix) | Chose scope (both user contexts, both extra problems), approved phases |
| Code | Implemented the entire codebase: ingestion, agent loop, LLM adapters, tools + access guard, action store, radar detectors, SPA, tests | Directed phase-by-phase, tested in the browser, supplied the z.ai API key and provider choice |
| Debugging | Diagnosed real issues found along the way — a column-shift bug in XLSX empty-cell handling, an ESM `require.main` error, a regex word-boundary bug, Windows `EAI_AGAIN` DNS failure for Node fetch (fixed with IPv4-first), a stale-process port conflict | Verified fixes against live behaviour |
| Docs | Drafted README / ARCHITECTURE / PRODUCT / AI_USAGE and this file | Reviewed and finalized |

## What was verified by actual execution (not just generated)

- All 13 structural tests pass (access control, redaction, two-phase actions, calculator, severity, radar).
- The 15 live behavioural scenarios run against the real LLM (GLM 5.2 via z.ai) — see `npm test`.
- The UI flows (login, chat with tool stream, confirmation cards, Ops Radar + chat handoff) were exercised in a real browser.

## Position on AI usage

The assessment evaluates product judgment and engineering ownership; AI assistance was treated as a force-multiplier under continuous human direction — every design decision (both personas, deterministic radar, user-only confirmations, tiered retrieval) came from the plan the human approved, and the correctness properties are pinned by tests rather than trust in generated code.
