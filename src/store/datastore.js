// ─────────────────────────────────────────────────────────────────────────────
// Datastore — typed, in-memory view over the workbook rows.
// Deliberately dumb: no access logic here. Scoping/redaction lives in the
// tool layer (Phase 2) so every consumer gets identical, enforced rules.
//
// All datetimes in the pack are Asia/Kolkata (IST = UTC+05:30) wall-clock
// strings without a zone suffix; parseIST() makes them exact Dates.
// ─────────────────────────────────────────────────────────────────────────────

export const IST_OFFSET_MIN = 330; // +05:30

export function parseIST(s) {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T]?(\d{2})?:?(\d{2})?/);
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00"] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi) - IST_OFFSET_MIN * 60_000;
  return new Date(ms);
}

const toBool = (v) => (v === true || v === false ? v : v === "true" ? true : v === "false" ? false : null);
const toNum = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const toStr = (v) => (v === null || v === undefined || v === "" ? null : String(v));

function sheetObjects(rows) {
  const [header, ...dataRows] = rows;
  const cols = header.map((h) => String(h));
  return dataRows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? null])));
}

export class DataStore {
  /** @param {{sheets: Record<string, any[][]>}} workbook */
  constructor(workbook) {
    const s = workbook.sheets;

    // README → key/value pairs (NOT a headered table: row 1 is a title line,
    // so read cells positionally instead of via sheetObjects)
    this.readme = (s.README || [])
      .filter((r) => r && r[0] != null)
      .map((r) => ({ key: String(r[0]), value: r[1] == null ? null : String(r[1]) }));
    const snapRow = this.readme.find((r) => /snapshot/i.test(String(r.key)));
    const snapRaw = snapRow ? String(snapRow.value) : null;
    this.snapshotRaw = snapRaw; // e.g. "2026-08-16 11:00 Asia/Kolkata"
    this.snapshot = snapRaw ? parseIST(snapRaw) : null;

    // accounts
    this.accounts = sheetObjects(s.accounts || []).map((a) => ({
      account_id: toStr(a.account_id),
      account_name: toStr(a.account_name),
      plan: toStr(a.plan),
      status: toStr(a.status),
      csm: toStr(a.csm),
      contract_file: toStr(a.contract_file),
      premium_support: toBool(a.premium_support),
      notes: toStr(a.notes), // internal-only field — redacted for customers in tool layer
    }));

    // orders
    this.orders = sheetObjects(s.orders || []).map((o) => ({
      order_id: toStr(o.order_id),
      account_id: toStr(o.account_id),
      carrier: toStr(o.carrier),
      status: toStr(o.status),
      booked_at: parseIST(o.booked_at),
      pickup_window_start: parseIST(o.pickup_window_start),
      pickup_window_end: parseIST(o.pickup_window_end),
      pickup_actual_at: parseIST(o.pickup_actual_at),
      shipment_fee_inr: toNum(o.shipment_fee_inr),
      carrier_fault: toBool(o.carrier_fault),
      customer_fault: toBool(o.customer_fault),
      cancellation_requested_at: parseIST(o.cancellation_requested_at),
      notes: toStr(o.notes),
    }));

    // tickets
    this.tickets = sheetObjects(s.tickets || []).map((t) => ({
      ticket_id: toStr(t.ticket_id),
      account_id: toStr(t.account_id),
      created_at: parseIST(t.created_at),
      status: toStr(t.status),
      subject: toStr(t.subject),
      description: toStr(t.description),
      channel: toStr(t.channel),
      assigned_to: toStr(t.assigned_to),
      last_customer_message_at: parseIST(t.last_customer_message_at),
      // tier-4 context: may be incorrect past guidance — never policy authority
      historical_resolution: toStr(t.historical_resolution),
    }));
  }

  getAccount(id) {
    return this.accounts.find((a) => a.account_id === id) || null;
  }
  getOrder(id) {
    return this.orders.find((o) => o.order_id === id) || null;
  }
  getTicket(id) {
    return this.tickets.find((t) => t.ticket_id === id) || null;
  }
  ordersForAccount(accountId) {
    return this.orders.filter((o) => o.account_id === accountId);
  }
  ticketsForAccount(accountId) {
    return this.tickets.filter((t) => t.account_id === accountId);
  }
}
