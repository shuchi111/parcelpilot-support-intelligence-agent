// ─────────────────────────────────────────────────────────────────────────────
// Ops Radar detectors — deterministic, explainable signals over the snapshot.
// Every signal carries: what happened, the evidence (with record ids), why it
// matters, and a suggested next action that hands off into the agent chat.
// ─────────────────────────────────────────────────────────────────────────────
import { classifySeverity } from "./severity.js";
import { buildPolicyFacts, slaPosition } from "./policyfacts.js";

const MIN = 60_000;
const fmtIST = (d) =>
  d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " IST";

/** Known-issue entries scraped from product-doc chunks (KI-xxx chunks). */
function knownIssues(chunks) {
  return chunks
    .filter((c) => /^KI-\d+/.test(String(c.sectionNo)))
    .map((c) => ({
      id: c.sectionNo,
      title: c.heading.split(" - ")[1] || c.heading,
      status: /Status:\s*(\w+)/i.exec(c.text)?.[1] || "unknown",
      text: c.text,
      chunkId: c.id,
    }));
}

export function generateSignals(kb) {
  const { store, chunks } = kb;
  const facts = buildPolicyFacts(chunks);
  const snap = store.snapshot;
  const signals = [];
  const kis = knownIssues(chunks);

  // ── 1. SLA risk & breach per open ticket ────────────────────────────────
  for (const t of store.tickets.filter((x) => x.status === "open")) {
    const acct = store.getAccount(t.account_id);
    const cls = classifySeverity(t);
    const pos = slaPosition(facts, acct, cls.severity, t.created_at, snap.getTime());
    if (!pos) continue;
    const breached = !pos.paused && pos.elapsedMin > pos.targetMin;
    const atRisk = !breached && !pos.paused && pos.pct >= 50;
    if (!breached && !atRisk) continue; // healthy/paused tickets only appear in the summary

    signals.push({
      id: `sla-${t.ticket_id}`,
      signalType: "SLA " + (breached ? "breach" : "at-risk"),
      severity: breached ? (cls.severity === "P1" ? "critical" : "high") : "medium",
      title: `${t.ticket_id} (${acct.account_name}): ${cls.severity} first-response target ${breached ? "BREACHED" : "at risk"} — “${t.subject}”`,
      evidence:
        `Classified ${cls.severity} (${cls.why}; matched “${cls.matchedOn}” per Policy v3 §2 [DOC-01#2]). ` +
        `Target ${pos.targetMin} min (${pos.coverage}) from ${pos.target.source}; ${pos.elapsedMin} min elapsed since ${fmtIST(t.created_at)} ` +
        `(${pos.pct}% consumed)${pos.note ? ` — ${pos.note}` : ""}. Assigned: ${t.assigned_to}.`,
      entities: { tickets: [t.ticket_id], accounts: [t.account_id] },
      suggestedAction: breached ? "Escalate now + notify CSM" : "Prioritise first response",
      suggestedActionQuery: `Review ${t.ticket_id} for ${acct.account_name}: ${cls.severity}, SLA ${breached ? "breached" : "at risk"}. Prepare an escalation with the evidence.`,
    });
  }

  // ── 2. Known-issue correlation (tickets ↔ KI-xxx) ───────────────────────
  const kiMatch = (ki, text) => {
    const kws = {
      "KI-208": /(bulk upload|csv).{0,80}(fail|error|\d{3},?\d{3})|(fail|error).{0,40}(bulk upload|csv)/i,
      "KI-211": /(webhook|still shows booked|shows bookED|pickup confirmation).{0,60}(late|delay|booked)/i || /still shows BOOKED|webhook.{0,40}late/i,
    };
    const generic = {
      "KI-208": /(bulk|csv).{0,60}(fail|row)/i,
      "KI-211": /(shows BOOKED|webhook|pickup confirmation).{0,50}(late|delay|BOOKED)/i,
    };
    const re = kws[ki.id] || generic[ki.id];
    return re ? re.test(text) : false;
  };
  for (const ki of kis) {
    if (/resolved/i.test(ki.status)) continue;
    const matches = store.tickets.filter((t) => kiMatch(ki, `${t.subject} ${t.description}`));
    if (!matches.length) continue;
    const accts = [...new Set(matches.map((t) => t.account_id))];
    signals.push({
      id: `ki-${ki.id}`,
      signalType: "Known-issue cluster",
      severity: accts.length > 1 ? "high" : "medium",
      title: `${matches.length} ticket(s) match known issue ${ki.id} — ${ki.title}`,
      evidence:
        `Tickets: ${matches.map((t) => `${t.ticket_id} (${t.account_id})`).join(", ")}. ` +
        `${ki.id} status: ${ki.status} [${ki.chunkId}]. Workaround available in the known-issues doc — agent answers should cite it ` +
        `rather than historical ticket advice (TKT-451 previously mis-stated the row limit).`,
      entities: { tickets: matches.map((t) => t.ticket_id), accounts: accts, knownIssues: [ki.id] },
      suggestedAction: "Reply with workaround + link tickets",
      suggestedActionQuery: `Summarise known issue ${ki.id} (${ki.title}) and the recommended workaround for tickets ${matches.map((t) => t.ticket_id).join(", ")}.`,
    });
  }

  // ── 3. Recurring theme across tickets (same complaint, multiple reports) ─
  const themes = [
    {
      id: "theme-bulk-upload",
      re: /(bulk upload|csv).{0,80}(fail|error)/i,
      title: "Recurring complaint: bulk-upload failures",
      note: "Multiple reports over time — correlate with KI-208 and check whether resolutions given were consistent.",
    },
    {
      id: "theme-pickup-status",
      re: /(still shows BOOKED|pickup.{0,30}(status|confirm)).{0,50}(booked|late|delay)/i,
      title: "Recurring complaint: pickup status not reflecting reality",
      note: "Correlate with KI-211 (SwiftShip webhook delay) before telling customers a pickup did not occur.",
    },
  ];
  for (const th of themes) {
    const matches = store.tickets.filter((t) => th.re.test(`${t.subject} ${t.description}`));
    if (matches.length < 2) continue;
    const accts = [...new Set(matches.map((t) => t.account_id))];
    signals.push({
      id: th.id,
      signalType: "Recurring theme",
      severity: "medium",
      title: `${th.title} — ${matches.length} tickets, ${accts.length} account(s)`,
      evidence: `${matches.map((t) => `${t.ticket_id} (${fmtIST(t.created_at)}, ${t.account_id})`).join("; ")}. ${th.note}`,
      entities: { tickets: matches.map((t) => t.ticket_id), accounts: accts },
      suggestedAction: "Cluster-review with the team",
      suggestedActionQuery: `Investigate the recurring "${th.title}" pattern across ${matches.map((t) => t.ticket_id).join(", ")} — what should we tell these customers and is a known issue involved?`,
    });
  }

  // ── 4. Order anomalies ───────────────────────────────────────────────────
  // 4a. Failed pickups: window long past, never picked up
  for (const o of store.orders) {
    if (o.status !== "BOOKED" || !o.pickup_window_end) continue;
    const minsPast = Math.round((snap - o.pickup_window_end) / MIN);
    if (minsPast <= 60) continue;
    const acct = store.getAccount(o.account_id);
    const fault = o.carrier_fault === true ? "carrier has ACCEPTED fault" : o.carrier_fault === false ? "no carrier fault recorded" : "carrier fault UNKNOWN";
    signals.push({
      id: `anom-failedpickup-${o.order_id}`,
      signalType: "Order anomaly — failed pickup",
      severity: o.carrier_fault ? "high" : "medium",
      title: `${o.order_id} (${acct.account_name}): pickup window ended ${Math.floor(minsPast / 60)}h ${minsPast % 60}m ago — still BOOKED`,
      evidence:
        `Window ${fmtIST(o.pickup_window_start)}→${fmtIST(o.pickup_window_end)}, no pickup_actual_at at snapshot ${fmtIST(snap)}; ${fault}. ` +
        `Check credit eligibility under the applicable terms (agreement may override the SOP default).`,
      entities: { orders: [o.order_id], accounts: [o.account_id] },
      suggestedAction: "Assess service credit + carrier follow-up",
      suggestedActionQuery: `Assess ${o.order_id} for ${acct.account_name}: pickup failed ${Math.floor(minsPast / 60)}h past the window (${fault}). Is a service credit due, and for how much? Show the applicable rule.`,
    });
  }

  // 4b. Cancellation requests left pending on BOOKED orders
  const staleCancels = store.orders.filter(
    (o) => o.status === "BOOKED" && o.cancellation_requested_at && snap - o.cancellation_requested_at > 30 * MIN
  );
  if (staleCancels.length) {
    signals.push({
      id: "anom-stale-cancels",
      signalType: "Order anomaly — pending cancellations",
      severity: staleCancels.length > 1 ? "medium" : "low",
      title: `${staleCancels.length} cancellation request(s) still unprocessed on BOOKED orders`,
      evidence:
        staleCancels
          .map((o) => {
            const mins = Math.round((snap - o.cancellation_requested_at) / MIN);
            return `${o.order_id} (${o.account_id}) — requested ${fmtIST(o.cancellation_requested_at)}, ${mins} min ago`;
          })
          .join("; ") +
        ". Fee rules are time-sensitive (30-min window / agreement waivers) — act before windows shift. " +
        "SwiftShip orders also risk KI-211 status lag: verify carrier state before cancelling.",
      entities: { orders: staleCancels.map((o) => o.order_id), accounts: [...new Set(staleCancels.map((o) => o.account_id))] },
      suggestedAction: "Process cancellations with fee check",
      suggestedActionQuery: `Review pending cancellations ${staleCancels.map((o) => o.order_id).join(", ")}: for each, state whether a fee applies under the customer's terms and any risk before cancelling.`,
    });
  }

  // 4c. Status-mismatch risk: BOOKED on SwiftShip + window passed + report of physical pickup
  for (const t of store.tickets.filter((x) => x.status === "open")) {
    if (!/still shows BOOKED|collected|picked up/i.test(`${t.subject} ${t.description}`)) continue;
    const linked = store.orders.filter(
      (o) => o.account_id === t.account_id && o.carrier === "SwiftShip" && o.status === "BOOKED"
    );
    if (!linked.length) continue;
    const acct = store.getAccount(t.account_id);
    signals.push({
      id: `anom-statusmismatch-${t.ticket_id}`,
      signalType: "Data conflict — status vs reality",
      severity: "high",
      title: `Possible status mismatch: ${t.ticket_id} reports physical pickup, ${linked.map((o) => o.order_id).join("/")} still BOOKED`,
      evidence:
        `${t.ticket_id} (${acct.account_name}): “${t.description}” — while ${linked.map((o) => o.order_id).join(", ")} (SwiftShip) show(s) BOOKED. ` +
        `KI-211: SwiftShip pickup webhooks can lag ~20 min [DOC-04#KI-211]. Do NOT process cancellations on these orders until carrier state is verified.`,
      entities: { tickets: [t.ticket_id], orders: linked.map((o) => o.order_id), accounts: [t.account_id] },
      suggestedAction: "Verify with carrier before any cancellation",
      suggestedActionQuery: `Check the status-mismatch risk between ${t.ticket_id} and orders ${linked.map((o) => o.order_id).join(", ")} (KI-211). What should we verify before cancelling?`,
    });
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  signals.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  return { generatedAt: new Date().toISOString(), snapshot: snap.toISOString(), facts, signals };
}
