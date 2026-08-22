// ─────────────────────────────────────────────────────────────────────────────
// Source registry — the authority model at the heart of Problem 2 (trust).
//
// Precedence (stated in Support Policy v3 §1, enforced everywhere):
//   tier 1  signed customer agreement (account-scoped)   — overrides everything
//   tier 2  current policies & SOPs                      — global defaults
//   tier 3  current product documentation                — supporting facts
//   tier 4  historical tickets / internal notes          — CONTEXT ONLY, may be wrong
//   excluded: DEPRECATED documents                       — never used for answers
// ─────────────────────────────────────────────────────────────────────────────

export const TIERS = {
  CONTRACT: 1,
  POLICY: 2,
  PRODUCT: 3,
  HISTORICAL: 4,
};

export const TIER_NAMES = {
  1: "contract",
  2: "policy",
  3: "product-docs",
  4: "historical-context",
};

// Every supplied document, with the metadata the reliability layer depends on.
// status / effective / supersededBy are cross-checked against the extracted
// text at boot time (ingest/boot.js) so registry and reality can't drift.
export const DOC_REGISTRY = [
  {
    id: "DOC-01",
    file: "01_Support_Policy_v3_CURRENT.pdf",
    title: "ParcelPilot Support Policy v3",
    kind: "policy",
    tier: TIERS.POLICY,
    status: "CURRENT",
    effective: "2026-05-01",
    scope: { type: "global" },
  },
  {
    id: "DOC-02",
    file: "02_Support_Policy_v2_DEPRECATED.pdf",
    title: "ParcelPilot Support Policy v2",
    kind: "policy",
    tier: TIERS.POLICY,
    status: "DEPRECATED", // excluded from answers; surfaced only as "detected & ignored"
    effective: "2025-01-01",
    supersededBy: "DOC-01",
    scope: { type: "global" },
  },
  {
    id: "DOC-03",
    file: "03_Cancellation_and_Service_Credit_SOP_v4.pdf",
    title: "ParcelPilot Cancellation & Service Credit SOP v4",
    kind: "sop",
    tier: TIERS.POLICY,
    status: "CURRENT",
    effective: "2026-06-15",
    scope: { type: "global" },
  },
  {
    id: "DOC-04",
    file: "04_Product_Operations_Guide_and_Known_Issues.pdf",
    title: "ParcelPilot Product Operations Guide",
    kind: "product-docs",
    tier: TIERS.PRODUCT,
    status: "CURRENT",
    effective: "2026-08-14", // "Updated:" date in the doc
    scope: { type: "global" },
  },
  {
    id: "DOC-05",
    file: "05_Northstar_Logistics_Enterprise_Agreement.pdf",
    title: "ParcelPilot - Northstar Logistics Enterprise Agreement",
    kind: "contract",
    tier: TIERS.CONTRACT,
    status: "ACTIVE",
    effective: "2026-01-01",
    termEnd: "2026-12-31",
    scope: { type: "account", accountId: "ACCT-001", accountName: "Northstar Logistics" },
  },
  {
    id: "DOC-06",
    file: "06_LumenWorks_Service_Agreement.pdf",
    title: "ParcelPilot - LumenWorks Service Agreement",
    kind: "contract",
    tier: TIERS.CONTRACT,
    status: "ACTIVE",
    effective: "2026-03-01",
    termEnd: "2027-02-28",
    scope: { type: "account", accountId: "ACCT-002", accountName: "LumenWorks" },
  },
];

export function registryById(id) {
  return DOC_REGISTRY.find((d) => d.id === id);
}

// Docs eligible to ground answers (deprecated excluded by design)
export function answerableDocs() {
  return DOC_REGISTRY.filter((d) => d.status !== "DEPRECATED");
}
