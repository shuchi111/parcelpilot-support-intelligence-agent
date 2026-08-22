// ─────────────────────────────────────────────────────────────────────────────
// ParcelPilot Support Intelligence Agent — API server
//
// Routes
//   GET  /api/health            status + knowledge-base stats + LLM mode
//   GET  /api/identities        mock login identities
//   POST /api/session           { identity } → session token
//   POST /api/chat              { message } → SSE event stream (tool activity,
//                               deltas, action cards, final answer)
//   POST /api/action/:id/confirm   user-originated confirmation (NOT an LLM tool)
//   POST /api/action/:id/cancel    user decline
// ─────────────────────────────────────────────────────────────────────────────
import express from "express";
import { readEnv } from "./config.js";
import { buildKnowledgeBase } from "./ingest/boot.js";
import { DocSearch } from "./tools/search.js";
import { makeDataTools } from "./tools/data.js";
import { ActionStore } from "./store/actionstore.js";
import { SessionManager, IDENTITIES } from "./store/sessions.js";
import { runTurn } from "./agent/loop.js";
import { llmMode } from "./agent/llm.js";
import { isInternal } from "./tools/guard.js";

const env = readEnv();

// ── boot: build the knowledge base from the ORIGINAL pack (runtime loading) ──
const kb = buildKnowledgeBase();
const docSearch = new DocSearch(kb.chunks);
const actionStore = new ActionStore();
const sessions = new SessionManager();
const dataTools = makeDataTools(kb.store);
const deps = { kb, docSearch, actionStore, dataTools, radar: () => generateSignals(kb) };

console.log(
  `[parcelpilot] knowledge base: ${kb.docs.length} docs · ${kb.chunks.length} chunks · ` +
  `${kb.store.accounts.length} accounts · ${kb.store.orders.length} orders · ${kb.store.tickets.length} tickets` +
  (kb.warnings.length ? ` · ⚠ ${kb.warnings.length} warning(s)` : "")
);
console.log(`[parcelpilot] LLM mode: ${llmMode()}`);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// ── helpers ──────────────────────────────────────────────────────────────────
const auth = (req) => sessions.get((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));

function requireSession(req, res) {
  const s = auth(req);
  if (!s) {
    res.status(401).json({ error: "unauthorized", message: "Create a session first (POST /api/session)." });
    return null;
  }
  return s;
}

const CONFIRM_RE = /^(yes|y|confirm|confirmed|approve|approved|go ahead|do it|proceed|okay|ok|please confirm|lgtm)\b/i;
const DECLINE_RE = /^(no|n|cancel|don'?t|do not|never ?mind|reject|stop|not now)\b/i;

function outcomeText(confirmed, result) {
  if (!confirmed) return `The action was cancelled — nothing was executed.`;
  if (result.type === "create_escalation")
    return `✅ Escalation **${result.result.escalation_id}** created and routed to the human support team (priority: ${result.result.priority}).`;
  if (result.type === "update_ticket")
    return `✅ Ticket **${result.result.ticket_id}** updated (${Object.keys(result.result.updated_fields).join(", ") || "no fields"}).`;
  if (result.type === "create_followup_task")
    return `✅ Follow-up task **${result.result.task_id}** created: “${result.result.title}”.`;
  return `✅ Action ${result.action_id} executed.`;
}

// ── routes ───────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "parcelpilot-support-intelligence-agent",
    llm: llmMode(),
    knowledgeBase: {
      docs: kb.docs.length,
      chunks: kb.chunks.length,
      accounts: kb.store.accounts.length,
      orders: kb.store.orders.length,
      tickets: kb.store.tickets.length,
      snapshot: kb.store.snapshot?.toISOString() ?? null,
      warnings: kb.warnings,
    },
    actions: actionStore.summary(),
    uptimeSec: Math.round(process.uptime()),
  });
});

app.get("/api/identities", (_req, res) => {
  res.json({ identities: IDENTITIES.map(({ id, label, role }) => ({ id, label, role })) });
});

app.post("/api/session", (req, res) => {
  const session = sessions.create(req.body?.identity);
  if (!session) return res.status(400).json({ error: "bad_request", message: "Unknown identity id (GET /api/identities)." });
  const { token, role, accountId, userName, identityId } = session;
  res.json({ token, identity: { id: identityId, userName, role, accountId } });
});

app.post("/api/chat", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "bad_request", message: "message required" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const sse = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);

  try {
    // ── user-originated confirmation shortcut (deterministic, never via LLM) ──
    const pending = actionStore.latestPendingFor(session);
    if (pending) {
      if (CONFIRM_RE.test(message)) {
        const result = actionStore.confirm(pending.action_id, session);
        const text = outcomeText(true, result);
        session.history.push({ role: "user", content: message }, { role: "assistant", content: text });
        sse({ type: "action_result", confirmed: true, action: result });
        sse({ type: "final", text, citations: [] });
        sse({ type: "done" });
        return res.end();
      }
      if (DECLINE_RE.test(message)) {
        actionStore.cancel(pending.action_id, session);
        const text = outcomeText(false);
        session.history.push({ role: "user", content: message }, { role: "assistant", content: text });
        sse({ type: "action_result", confirmed: false, action: { action_id: pending.action_id, status: "cancelled" } });
        sse({ type: "final", text, citations: [] });
        sse({ type: "done" });
        return res.end();
      }
    }

    // ── normal agent turn ──
    sse({ type: "start", role: session.role, account: session.accountId });
    const onDelta = (t) => sse({ type: "delta", text: t });
    for await (const evt of runTurn(session, message, deps, onDelta)) sse(evt);
    sse({ type: "done" });
    res.end();
  } catch (e) {
    console.error("[chat]", e);
    try { sse({ type: "error", message: e.message }); sse({ type: "done" }); res.end(); } catch { /* client gone */ }
  }
});

app.post("/api/action/:id/confirm", (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const result = actionStore.confirm(req.params.id, session);
    const text = outcomeText(true, result);
    session.history.push({ role: "assistant", content: `[SYSTEM] ${text}` });
    res.json({ ok: true, result, message: text });
  } catch (e) {
    res.status(400).json({ error: "action_failed", message: e.message });
  }
});

app.post("/api/action/:id/cancel", (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    actionStore.cancel(req.params.id, session);
    res.json({ ok: true, status: "cancelled" });
  } catch (e) {
    res.status(400).json({ error: "action_failed", message: e.message });
  }
});

// Ops Radar — proactive issue detection (staff only, enforced above)
import { generateSignals } from "./radar/detectors.js";

app.get("/api/radar", (req, res) => {
  const session = auth(req);
  if (!session || !isInternal(session)) {
    return res.status(session ? 403 : 401).json({ error: "forbidden", message: "Ops Radar is for authorised ParcelPilot staff." });
  }
  const radar = generateSignals(kb);
  res.json({
    available: true,
    generatedAt: radar.generatedAt,
    snapshot: radar.snapshot,
    facts: {
      contractOverrides: Object.keys(radar.facts.contractTargets),
      weekendExclusions: radar.facts.weekendExclusions,
      warnings: radar.facts.warnings,
    },
    summary: {
      total: radar.signals.length,
      critical: radar.signals.filter((s) => s.severity === "critical").length,
      high: radar.signals.filter((s) => s.severity === "high").length,
      medium: radar.signals.filter((s) => s.severity === "medium").length,
    },
    signals: radar.signals,
  });
});

const { PORT } = env;
app.listen(PORT, () => {
  console.log(`[parcelpilot] server up on http://localhost:${PORT} (health: /api/health)`);
});
