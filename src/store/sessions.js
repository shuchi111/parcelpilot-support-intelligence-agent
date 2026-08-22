// ─────────────────────────────────────────────────────────────────────────────
// Mock authentication + session manager (mocking auth is explicitly allowed
// by the assessment). The identity picker doubles as the demo script: four
// customers (one per account) and two staff roles.
// ─────────────────────────────────────────────────────────────────────────────
import { randomUUID } from "node:crypto";

export const IDENTITIES = [
  { id: "cust-northstar", label: "Nadia Rao — Northstar Logistics (Customer)", role: "customer", accountId: "ACCT-001", userName: "Nadia Rao" },
  { id: "cust-lumenworks", label: "Sam Iyer — LumenWorks (Customer)", role: "customer", accountId: "ACCT-002", userName: "Sam Iyer" },
  { id: "cust-beacon", label: "Ritka Shah — Beacon Retail (Customer)", role: "customer", accountId: "ACCT-003", userName: "Ritka Shah" },
  { id: "cust-axis", label: "Dev Malhotra — Axis Labs (Customer)", role: "customer", accountId: "ACCT-004", userName: "Dev Malhotra" },
  { id: "staff-support", label: "Maya K — ParcelPilot Support Agent", role: "internal_support", accountId: null, userName: "Maya K" },
  { id: "staff-ops", label: "Priya Mehta — ParcelPilot Ops Lead", role: "internal_ops", accountId: null, userName: "Priya Mehta" },
];

export class SessionManager {
  constructor() {
    this.sessions = new Map(); // token → session
  }

  create(identityId) {
    const ident = IDENTITIES.find((i) => i.id === identityId);
    if (!ident) return null;
    const token = randomUUID();
    const session = {
      token,
      role: ident.role,
      accountId: ident.accountId,
      userName: ident.userName,
      identityId: ident.id,
      label: ident.label,
      createdAt: new Date().toISOString(),
      history: [], // agent conversation (LLM messages)
    };
    this.sessions.set(token, session);
    return session;
  }

  get(token) {
    return token ? this.sessions.get(token) || null : null;
  }
}
