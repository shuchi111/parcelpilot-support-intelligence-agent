// ─────────────────────────────────────────────────────────────────────────────
// ActionStore — two-phase state changes with explicit user confirmation.
//
//   prepare()  → validates payload + scope, stores a PENDING action,
//                returns a card for the UI. NOTHING is executed.
//   confirm()  → only reachable from a user-originated event (UI button or a
//                server-verified "yes" in chat), same session, within TTL.
//                The LLM has NO confirm tool — a prompt can't approve itself.
//   cancel()   → user declines / TTL expiry.
//
// All outcomes land in an append-only audit log (data/actions.json) so the
// demo can show exactly who did what, when.
// ─────────────────────────────────────────────────────────────────────────────
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ToolError, isInternal } from "../tools/guard.js";

const TTL_MS = 10 * 60_000; // pending actions expire after 10 minutes

let escSeq = 2000;
let taskSeq = 3000;

export const ACTION_TYPES = {
  create_escalation: {
    requires: ["reason"],
    optional: ["ticket_id", "order_id", "account_id", "priority"],
    describe: "Escalate an issue to the human support team",
  },
  update_ticket: {
    requires: ["ticket_id"],
    optional: ["status", "priority", "note"],
    describe: "Update a ticket's status/priority or add a note",
  },
  create_followup_task: {
    requires: ["title"],
    optional: ["account_id", "ticket_id", "due_hint"],
    describe: "Create a follow-up task for the support team",
  },
};

export class ActionStore {
  constructor(dataDir = "data") {
    this.dir = resolve(process.cwd(), dataDir);
    this.pending = new Map(); // action_id → pending action
    this.executed = [];
    this.audit = [];
    try {
      if (existsSync(resolve(this.dir, "actions.json"))) {
        const saved = JSON.parse(readFileSync(resolve(this.dir, "actions.json"), "utf8"));
        this.executed = saved.executed || [];
        this.audit = saved.audit || [];
      }
    } catch { /* fresh start if unparsable */ }
  }

  #persist() {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(
      resolve(this.dir, "actions.json"),
      JSON.stringify({ executed: this.executed, audit: this.audit }, null, 2)
    );
  }

  #log(actor, event, details) {
    this.audit.push({ ts: new Date().toISOString(), actor, event, ...details });
    this.#persist();
  }

  /** Phase 1: validate + stage. No side effects. */
  prepare(session, { action_type, payload }) {
    const def = ACTION_TYPES[action_type];
    if (!def) throw new ToolError("bad_request", `Unknown action type '${action_type}'`);
    payload = payload && typeof payload === "object" ? payload : {};
    for (const f of def.requires) {
      if (payload[f] === undefined || payload[f] === null || payload[f] === "") {
        throw new ToolError("bad_request", `prepare_action(${action_type}): missing required field '${f}'`);
      }
    }
    // scope: customers may only act on their own account's entities
    if (session.role === "customer") {
      const acct = payload.account_id || null;
      if (acct && acct !== session.accountId) {
        throw new ToolError("not_found", "Related record not found."); // no existence leak
      }
      payload.account_id = session.accountId;
    } else if (isInternal(session) && !payload.account_id) {
      // staff may act account-agnostically; resolve when a ticket/order is given
      payload.account_id = payload.account_id || null;
    }

    const action_id = `ACT-${randomUUID().slice(0, 8).toUpperCase()}`;
    const action = {
      action_id,
      type: action_type,
      payload,
      prepared_by: { role: session.role, name: session.userName, account: session.accountId ?? null },
      prepared_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + TTL_MS).toISOString(),
      status: "pending",
    };
    this.pending.set(action_id, action);
    this.#log(session.userName, "action_prepared", { action_id, type: action_type });
    return {
      action_id,
      type: action_type,
      payload,
      note: "Prepared. Awaiting explicit user confirmation — nothing has been executed.",
      expires_at: action.expires_at,
    };
  }

  /** Phase 2: execute. Caller MUST be the user's session (not the LLM). */
  confirm(action_id, session) {
    const a = this.pending.get(action_id);
    if (!a) throw new ToolError("not_found", `No pending action ${action_id}.`);
    if (a.expires_at < new Date().toISOString()) {
      this.pending.delete(action_id);
      this.#log(session.userName, "action_expired", { action_id });
      throw new ToolError("bad_request", "Confirmation window (10 min) expired — please prepare the action again.");
    }
    // the confirming session must match the preparing account context
    if (a.prepared_by.account && session.accountId && a.prepared_by.account !== session.accountId) {
      throw new ToolError("forbidden", "This action belongs to a different account context.");
    }

    // mock execution → stable-looking reference ids
    let result;
    if (a.type === "create_escalation") {
      result = { escalation_id: `ESC-${++escSeq}`, routed_to: "human support queue", priority: a.payload.priority || "normal" };
    } else if (a.type === "update_ticket") {
      result = { ticket_id: a.payload.ticket_id, updated_fields: Object.fromEntries(Object.entries(a.payload).filter(([k]) => k !== "ticket_id" && k !== "account_id")) };
    } else if (a.type === "create_followup_task") {
      result = { task_id: `TASK-${++taskSeq}`, title: a.payload.title, assignee: "support team" };
    } else {
      result = { done: true };
    }

    a.status = "executed";
    a.executed_at = new Date().toISOString();
    a.result = result;
    this.pending.delete(action_id);
    this.executed.push(a);
    this.#log(session.userName, "action_confirmed", { action_id, type: a.type, result });
    return { action_id, type: a.type, status: "executed", result, executed_at: a.executed_at };
  }

  cancel(action_id, session) {
    const a = this.pending.get(action_id);
    if (!a) throw new ToolError("not_found", `No pending action ${action_id}.`);
    this.pending.delete(action_id);
    this.#log(session.userName, "action_cancelled", { action_id, type: a.type });
    return { action_id, status: "cancelled" };
  }

  getPending(action_id) {
    return this.pending.get(action_id) || null;
  }
  latestPendingFor(session) {
    // newest pending action prepared in this session's context
    for (const a of [...this.pending.values()].reverse()) {
      if (a.prepared_by.account === (session.accountId ?? null) || (!a.prepared_by.account && isInternal(session))) return a;
    }
    return null;
  }
  summary() {
    return { executed: this.executed.length, auditEntries: this.audit.length, pending: this.pending.size };
  }
}
