// ─────────────────────────────────────────────────────────────────────────────
// Structural tests — deterministic, no LLM, no network. They verify the
// access-control guarantees, the two-phase action protocol, the calculator,
// retrieval scoping, and the radar detectors by importing modules directly.
// ─────────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { rmSync } from "node:fs";
import { buildKnowledgeBase } from "../src/ingest/boot.js";
import { DocSearch } from "../src/tools/search.js";
import { makeDataTools } from "../src/tools/data.js";
import { ActionStore } from "../src/store/actionstore.js";
import { calculateExpression } from "../src/tools/calc.js";
import { classifySeverity } from "../src/radar/severity.js";
import { generateSignals } from "../src/radar/detectors.js";

const kb = buildKnowledgeBase();
const search = new DocSearch(kb.chunks);
const data = makeDataTools(kb.store);

const customerSession = (accountId) => ({
  role: "customer", accountId, userName: "Test Customer", token: "t",
});
const staffSession = { role: "internal_support", accountId: null, userName: "Test Staff", token: "t" };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── access control ───────────────────────────────────────────────────────────
test("cross-account order lookup THROWS not_found (no existence leak)", () => {
  const lum = customerSession("ACCT-002");
  assert.throws(() => data.get_order(lum, { order_id: "ORD-1001" }), (e) => e.code === "not_found");
});

test("own-account order lookup succeeds with derived timing", () => {
  const r = data.get_order(customerSession("ACCT-001"), { order_id: "ORD-1001" });
  assert.equal(r.order_id, "ORD-1001");
  assert.equal(r.derived.minutes_from_booking_to_cancellation_request, 120);
  assert.equal(r.derived.ten_percent_of_fee_inr, 420);
});

test("customer account view redacts internal notes; staff sees them", () => {
  const cust = data.get_account(customerSession("ACCT-001"), {});
  const staff = data.get_account(staffSession, { account_id: "ACCT-001" });
  assert.ok(!("notes" in cust) || cust.notes === undefined, "customer must not see notes");
  assert.ok(staff.notes && staff.notes.length > 0, "staff should see notes");
});

test("customer ticket search excludes assigned_to and warns on historical advice", () => {
  const r = data.search_tickets(customerSession("ACCT-001"), { query: "cancellation" });
  assert.ok(r.tickets.length >= 1);
  const closed = r.tickets.find((t) => t.historical_resolution);
  assert.ok(closed, "TKT-450 should be returned");
  assert.ok(closed.historical_resolution_warning.includes("UNVERIFIED"));
  assert.ok(!("assigned_to" in closed) || closed.assigned_to === undefined);
});

// ── retrieval scoping ────────────────────────────────────────────────────────
test("customer doc search never returns another account's contract", () => {
  const r = search.search("cancellation fee waiver terms", customerSession("ACCT-002"));
  assert.ok(r.results.length > 0);
  assert.ok(r.results.every((x) => x.id.startsWith("DOC-06") || !x.id.startsWith("DOC-05")), "must not surface Northstar's contract to LumenWorks");
  assert.ok(r.results.some((x) => x.id === "DOC-06#2"), "their own agreement should surface");
});

test("deprecated policy never appears in results but is reported as ignored", () => {
  const r = search.search("response targets P1 P2 P3 plan", staffSession);
  assert.ok(r.results.every((x) => !x.id.startsWith("DOC-02")), "deprecated doc must not be returned");
  assert.ok(r.deprecatedMatches.some((d) => d.id.startsWith("DOC-02")), "deprecated match should be flagged");
});

test("contract+policy co-occurrence produces an override hint", () => {
  const r = search.search("cancellation fee", customerSession("ACCT-001"));
  assert.ok(r.note && r.note.includes("OVERRIDES"), "conflict hint expected");
});

// ── two-phase actions ────────────────────────────────────────────────────────
test("prepare does not execute; confirm requires same account context; double-confirm fails", () => {
  const store = new ActionStore("data-test-tmp");
  const cust = customerSession("ACCT-002");
  const prep = store.prepare(cust, { action_type: "create_escalation", payload: { reason: "test", account_id: "ACCT-002" } });
  assert.ok(prep.action_id && prep.note.includes("Awaiting"));
  assert.equal(store.summary().executed, 0, "nothing executed yet");
  // a different account's session must not confirm
  assert.throws(() => store.confirm(prep.action_id, customerSession("ACCT-003")), (e) => e.code === "forbidden");
  const done = store.confirm(prep.action_id, cust);
  assert.ok(done.result.escalation_id);
  assert.throws(() => store.confirm(prep.action_id, cust), (e) => e.code === "not_found", "double confirm rejected");
});

test("customer cannot prepare an action on another account", () => {
  const store = new ActionStore("data-test-tmp2");
  assert.throws(
    () => store.prepare(customerSession("ACCT-002"), { action_type: "create_followup_task", payload: { title: "x", account_id: "ACCT-001" } }),
    (e) => e.code === "not_found"
  );
});

// ── calculator ───────────────────────────────────────────────────────────────
test("calculator: credit math and guards", () => {
  assert.equal(calculateExpression("min(500, 4200 * 0.10)"), 420);
  assert.equal(calculateExpression("min(500, 1800 * 0.10)"), 180);
  assert.throws(() => calculateExpression("process.exit(1)"));
  assert.throws(() => calculateExpression("2 +"));
});

// ── severity + radar ─────────────────────────────────────────────────────────
test("severity classifier matches Policy v3 §2 on all dataset tickets", () => {
  const expect = {
    "TKT-501": "P1", "TKT-502": "P2", "TKT-503": "P3", "TKT-504": "P3", "TKT-505": "P1",
  };
  for (const [id, sev] of Object.entries(expect)) {
    const t = kb.store.getTicket(id);
    assert.equal(classifySeverity(t).severity, sev, `${id} should be ${sev}`);
  }
});

test("radar: both P1 breaches detected with correct target provenance", () => {
  const r = generateSignals(kb);
  const s501 = r.signals.find((s) => s.id === "sla-TKT-501");
  const s505 = r.signals.find((s) => s.id === "sla-TKT-505");
  assert.ok(s501 && s501.severity === "critical" && s501.evidence.includes("agreement (tier 1)"), "TKT-501: 15-min target must cite the contract");
  assert.ok(s505 && s505.severity === "critical" && s505.evidence.includes("Policy v3 §3"), "TKT-505: 30-min target must cite the policy default");
  // weekend nuance: LumenWorks' business-hours tickets must NOT be flagged breached on a Sunday
  assert.ok(!r.signals.some((s) => /TKT-502.*BREACHED/i.test(s.title)), "TKT-502 must be paused (weekend), not breached");
});

test("radar: KI-208 cluster and ORD-2002 anomaly present", () => {
  const r = generateSignals(kb);
  assert.ok(r.signals.some((s) => s.id === "ki-KI-208" && /TKT-502/.test(s.evidence) && /TKT-451/.test(s.evidence)));
  assert.ok(r.signals.some((s) => s.id === "anom-failedpickup-ORD-2002"));
});

export async function runStructural() {
  let pass = 0, fail = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      fail++;
      failures.push({ name: t.name, error: e.message });
      console.log(`  ✗ ${t.name}\n      ${e.message.split("\n")[0]}`);
    }
  }
  for (const dir of ["data-test-tmp", "data-test-tmp2"]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
  return { pass, fail, failures };
}
