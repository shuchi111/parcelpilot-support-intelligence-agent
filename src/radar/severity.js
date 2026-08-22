// ─────────────────────────────────────────────────────────────────────────────
// Severity classifier — deterministic keyword rules TRANSLATED from the
// severity definitions in Support Policy v3 §2 (not a black box; every
// classification carries the matched evidence). Rules are ordered: P1 first.
// ─────────────────────────────────────────────────────────────────────────────

const P1_RULES = [
  { re: /(every|all)\s+(user|shipment|order).{0,60}(fail|error|down|500)/i, why: "complete outage for the customer" },
  { re: /complete (production )?outage/i, why: "complete production outage" },
  { re: /(can't|cannot|unable to) create (any|all) shipments?/i, why: "all shipment creation failing" },
  { re: /(security incident|credential|api key).{0,40}(expos|leak|post|public|compromis)/i, why: "suspected credential exposure / security incident" },
  { re: /data breach/i, why: "security incident" },
];

const P2_RULES = [
  { re: /bulk upload.{0,60}(fail|error|failing)/i, why: "major feature failing (workaround exists: one-by-one creation)" },
  { re: /major feature|materially degraded|unavailable/i, why: "major feature unavailable/degraded" },
  { re: /(fail|fails|failing) for [\d,]+[- ]row/i, why: "major feature failing at scale" },
];

const P3_DEFAULT = { why: "minor defect / how-to / limited operational impact (default)" };

/**
 * @param {object} ticket
 * @returns {{severity:"P1"|"P2"|"P3", why:string, matchedOn:string}}
 */
export function classifySeverity(ticket) {
  const text = `${ticket.subject} ${ticket.description}`;
  for (const rule of P1_RULES) {
    const m = text.match(rule.re);
    if (m) return { severity: "P1", why: rule.why, matchedOn: m[0].slice(0, 80) };
  }
  for (const rule of P2_RULES) {
    const m = text.match(rule.re);
    if (m) return { severity: "P2", why: rule.why, matchedOn: m[0].slice(0, 80) };
  }
  // explicit how-to signals for the P3 explanation
  const howTo = text.match(/how (do|can) we|billing contact|configuration|change|update/i);
  return {
    severity: "P3",
    why: howTo ? `how-to/configuration request (${howTo[0]})` : P3_DEFAULT.why,
    matchedOn: howTo ? howTo[0] : ticket.subject.slice(0, 80),
  };
}
