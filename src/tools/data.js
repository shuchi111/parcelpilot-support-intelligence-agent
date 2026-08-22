// ─────────────────────────────────────────────────────────────────────────────
// Structured-data tools — orders / accounts / tickets lookups, always routed
// through guard.js for scope enforcement and redaction.
//
// Each lookup adds a small `derived` block of neutral arithmetic (elapsed
// minutes vs snapshot) so the LLM reasons from correct numbers, but NO policy
// conclusions — those come from documents + the model, keeping data and rules
// cleanly separated.
// ─────────────────────────────────────────────────────────────────────────────
import { ToolError, requireWithinScope, redactAccount, redactTicket } from "./guard.js";

const MIN = 60_000;
const fmt = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) + "Z" : null);
const minutes = (a, b) => (a && b ? Math.round((a - b) / MIN) : null);

export function makeDataTools(store) {
  const snap = store.snapshot;

  function derivedForOrder(o) {
    return {
      reference_time: fmt(snap),
      minutes_since_booking_at_snapshot: minutes(snap, o.booked_at),
      minutes_from_booking_to_cancellation_request: minutes(o.cancellation_requested_at, o.booked_at),
      minutes_past_pickup_window_end_at_snapshot: minutes(snap, o.pickup_window_end),
      ten_percent_of_fee_inr: o.shipment_fee_inr != null ? Math.round(o.shipment_fee_inr * 0.1 * 100) / 100 : null,
    };
  }

  const compactOrder = (o) => ({
    order_id: o.order_id,
    account_id: o.account_id,
    carrier: o.carrier,
    status: o.status,
    booked_at: fmt(o.booked_at),
    pickup_window: o.pickup_window_start && o.pickup_window_end
      ? `${fmt(o.pickup_window_start).slice(0, 16)} → ${fmt(o.pickup_window_end).slice(11, 16)}`
      : null,
    pickup_actual_at: fmt(o.pickup_actual_at),
    shipment_fee_inr: o.shipment_fee_inr,
    carrier_fault: o.carrier_fault,
    customer_fault: o.customer_fault,
    cancellation_requested_at: fmt(o.cancellation_requested_at),
    notes: o.notes,
    derived: derivedForOrder(o),
  });

  return {
    /** get_order — one order, strictly scope-checked */
    get_order(session, { order_id }) {
      if (!order_id) throw new ToolError("bad_request", "order_id required");
      const o = store.getOrder(String(order_id).trim().toUpperCase());
      // NOTE: scope check happens even before existence is acknowledged
      if (!o) throw new ToolError("not_found", `Order ${order_id} not found.`);
      requireWithinScope(session, o.account_id);
      return compactOrder(o);
    },

    /** list_orders — customer: own only; staff: optional filters */
    list_orders(session, { status, account_id } = {}) {
      const scope = requireWithinScope(session, account_id ?? null);
      let rows = store.orders;
      if (scope) rows = rows.filter((o) => o.account_id === scope);
      if (status) rows = rows.filter((o) => o.status.toLowerCase() === String(status).toLowerCase());
      return { count: rows.length, orders: rows.map(compactOrder) };
    },

    /** get_account — customer sees own (redacted); staff see any (full) */
    get_account(session, { account_id } = {}) {
      const scope = requireWithinScope(session, account_id ?? null);
      const id = scope || account_id;
      const a = store.getAccount(id);
      if (!a) throw new ToolError("not_found", `Account ${id} not found.`);
      return redactAccount(a, session);
    },

    /** search_tickets — keyword + status filters, scope-enforced */
    search_tickets(session, { query, status, account_id } = {}) {
      const scope = requireWithinScope(session, account_id ?? null);
      let rows = store.tickets;
      if (scope) rows = rows.filter((t) => t.account_id === scope);
      if (status) rows = rows.filter((t) => t.status.toLowerCase() === String(status).toLowerCase());
      if (query) {
        const q = String(query).toLowerCase();
        rows = rows.filter((t) =>
          [t.subject, t.description, t.ticket_id, t.historical_resolution]
            .some((f) => f && String(f).toLowerCase().includes(q)));
      }
      return {
        count: rows.length,
        tickets: rows.map((t) => ({
          ...redactTicket(t, session),
          created_at: fmt(t.created_at),
          last_customer_message_at: fmt(t.last_customer_message_at),
          // tier-4 guard rail: historical advice is context, never authority
          ...(t.historical_resolution
            ? { historical_resolution_warning: "UNVERIFIED historical guidance — may be incorrect; verify against current sources before repeating." }
            : {}),
          derived: {
            age_minutes_at_snapshot: minutes(snap, t.created_at),
            minutes_since_last_customer_message: minutes(snap, t.last_customer_message_at),
          },
        })),
      };
    },
  };
}
