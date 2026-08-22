// ─────────────────────────────────────────────────────────────────────────────
// Access-control guard — the enforcement point required by the assessment:
// "Access controls should be enforced in the data/tool layer rather than
// relying only on model instructions."
//
// Every data tool funnels through these helpers. A customer asking for another
// account's record gets NOT FOUND (no existence leak). Redaction happens here
// too, so no prompt can ever talk the system into leaking the `notes` field.
// ─────────────────────────────────────────────────────────────────────────────

export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "not_found" | "forbidden" | "bad_request"
  }
}

/** Is this session a ParcelPilot staff session? */
export function isInternal(session) {
  return session?.role === "internal_support" || session?.role === "internal_ops";
}

/** The one account a customer session may see; null for internal (they see all). */
export function scopedAccount(session) {
  if (!session) throw new ToolError("forbidden", "No session");
  if (session.role === "customer") {
    if (!session.accountId) throw new ToolError("forbidden", "Customer session without account");
    return session.accountId;
  }
  if (isInternal(session)) return null; // unrestricted across accounts
  throw new ToolError("forbidden", `Unknown role ${session.role}`);
}

/**
 * Resolve the account a record must belong to, enforcing scope.
 * @returns {string} the accountId the record must match
 */
export function requireWithinScope(session, recordAccountId) {
  const scope = scopedAccount(session);
  if (scope && recordAccountId && recordAccountId !== scope) {
    // Deliberately "not found": acknowledging existence would already leak data.
    throw new ToolError("not_found", "Record not found.");
  }
  return recordAccountId ?? scope;
}

/** Strip internal-only fields before a record crosses to a customer. */
export function redactAccount(account, session) {
  if (!account) return null;
  const base = { ...account };
  if (!isInternal(session)) {
    delete base.notes; // internal CRM commentary must never reach customers
  }
  return base;
}

export function redactTicket(ticket, session) {
  if (!ticket) return null;
  const base = { ...ticket };
  if (!isInternal(session)) {
    // assigned_to is internal workload info — keep it internal
    delete base.assigned_to;
  }
  return base;
}
