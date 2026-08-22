// ─────────────────────────────────────────────────────────────────────────────
// PolicyFacts — machine-readable response targets DERIVED FROM THE DOCUMENTS
// at boot (not hard-coded): contract overrides (tier 1) and the plan-default
// table (tier 2) are regex-parsed out of the ingested chunk text. If the text
// format ever changes, parsing fails loudly and a documented fallback kicks in
// (flagged in output) — the classic ingestion trade-off, made explicit.
//
// Duration model:
//   { minutes, business }  — business=true counts only Mon–Fri 09:00–18:00 IST
//   { weekendCoverage }    — contract-level: does the clock run on weekends?
// Assumptions (documented in ARCHITECTURE.md): business hours are Mon–Fri
// 09:00–18:00 IST; "1 business day" = 9 business hours.
// ─────────────────────────────────────────────────────────────────────────────

const DURATION_RE = /(\d+)\s+(business\s+)?(minutes?|hours?|days?)/i;
const IST_MIN = 330; // +05:30
const BUSINESS_DAY_MIN = 9 * 60;

function parseDuration(text) {
  const m = (text || "").match(DURATION_RE);
  if (!m) return null;
  const n = +m[1];
  const business = Boolean(m[2]);
  const unit = m[3].toLowerCase();
  let minutes = n;
  if (unit.startsWith("hour")) minutes = n * 60;
  else if (unit.startsWith("day")) minutes = n * BUSINESS_DAY_MIN;
  else if (unit.startsWith("minute")) minutes = n;
  return { minutes, business };
}

// parse "P1: 15 minutes, 24x7" / "P2: 1 hour" sequences from a contract section
function parseContractSupportTerms(text) {
  const targets = {};
  const re = /P([123])\s*[:\-–]\s*([^●\n]+?)(?=\s*●|\s*$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const d = parseDuration(m[2]);
    if (d) targets[`P${m[1]}`] = { ...d, weekendCoverage: /24x7/i.test(m[2]) };
  }
  return targets;
}

// parse the plan-default table line: "Enterprise 30 minutes, 24x7 2 hours 1
// business day Growth 2 business hours 4 business hours 2 business days …"
function parsePlanTable(text) {
  const plans = {};
  const split = text.split(/\b(Enterprise|Growth|Standard)\b/);
  for (let i = 1; i < split.length; i += 2) {
    const plan = split[i];
    const cell = split[i + 1] || "";
    const durations = [...cell.matchAll(/(\d+\s+(?:business\s+)?(?:minutes?|hours?|days?))/gi)].map((x) => x[1]);
    if (durations.length >= 3) {
      const p1raw = cell.slice(0, durations[0].length + durations[0].length);
      plans[plan] = {
        P1: { ...parseDuration(durations[0]), weekendCoverage: /24x7/i.test(cell.split(durations[1])[0]) },
        P2: parseDuration(durations[1]),
        P3: parseDuration(durations[2]),
      };
    }
  }
  return plans;
}

/** Build facts from the knowledge-base chunks. */
export function buildPolicyFacts(chunks) {
  const contractTargets = {}; // accountId → {P1,P2,P3}
  let planTargets = {};
  let weekendExclusions = []; // accountIds with "no weekend coverage"
  const warnings = [];

  for (const c of chunks) {
    if (c.status === "DEPRECATED") continue;
    if (c.tier === 1 && c.scope?.type === "account" && /^(1\.)?\s*(Support terms|Response)/i.test(c.heading + "\n" + c.text.slice(0, 40))) {
      const t = parseContractSupportTerms(c.text);
      if (Object.keys(t).length) contractTargets[c.scope.accountId] = t;
      if (/no weekend or after-hours/i.test(c.text)) weekendExclusions.push(c.scope.accountId);
    }
    if (c.tier === 2 && /Default first-response targets/.test(c.heading)) {
      const tableLine = (c.text.split("\n").find((l) => /Enterprise|Growth|Standard/.test(l)) || "");
      planTargets = parsePlanTable(tableLine);
      if (!Object.keys(planTargets).length) warnings.push("plan table parse failed — using fallback defaults");
    }
  }

  // documented fallback (matches Policy v3 §3) — only used if parsing broke
  if (!Object.keys(planTargets).length) {
    planTargets = {
      Enterprise: { P1: { minutes: 30, weekendCoverage: true }, P2: { minutes: 120 }, P3: { minutes: 540, business: true } },
      Growth: { P1: { minutes: 120, business: true }, P2: { minutes: 240, business: true }, P3: { minutes: 1080, business: true } },
      Standard: { P1: { minutes: 240, business: true }, P2: { minutes: 540, business: true }, P3: { minutes: 1080, business: true } },
    };
    warnings.push("plan targets are FALLBACK values (policy table could not be parsed)");
  }

  return { contractTargets, planTargets, weekendExclusions, warnings };
}

/** Resolve the response target for an account+severity, with provenance. */
export function resolveTarget(facts, account, severity) {
  const override = facts.contractTargets[account.account_id]?.[severity];
  if (override) {
    return {
      ...override,
      // a contract stating 24x7 on P1 implies the clock always runs for that
      // severity; accounts with an explicit no-weekend clause never run it
      weekendCoverage: /P1/.test(severity) && override.weekendCoverage && !facts.weekendExclusions.includes(account.account_id)
        ? true
        : override.weekendCoverage === true && !facts.weekendExclusions.includes(account.account_id),
      source: "customer agreement (tier 1)",
    };
  }
  const plan = facts.planTargets[account.plan]?.[severity];
  if (!plan) return null;
  return { ...plan, weekendCoverage: plan.weekendCoverage === true, source: `Support Policy v3 §3 (${account.plan} default)` };
}

// ── time math (IST-aware) ────────────────────────────────────────────────────
const shiftIST = (ms) => ms + IST_MIN * 60_000;

export function isWeekendIST(dateMs) {
  const d = new Date(shiftIST(dateMs));
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/** Elapsed minutes between start and end, counting only business hours. */
export function businessMinutesBetween(startMs, endMs) {
  if (endMs <= startMs) return 0;
  let total = 0;
  let day = new Date(shiftIST(startMs));
  day.setUTCHours(0, 0, 0, 0);
  for (let guard = 0; guard < 30; guard++) {
    const dayStart = day.getTime() + 9 * 3600_000; // 09:00 IST
    const dayEnd = day.getTime() + 18 * 3600_000; // 18:00 IST
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const from = Math.max(shiftIST(startMs), dayStart);
      const to = Math.min(shiftIST(endMs), dayEnd);
      if (to > from) total += (to - from) / 60_000;
    }
    day = new Date(day.getTime() + 24 * 3600_000);
    if (day.getTime() > shiftIST(endMs)) break;
  }
  return Math.round(total);
}

/**
 * How much of the response window has been consumed?
 * Returns { elapsedMin, targetMin, pct, paused, note }
 */
export function slaPosition(facts, account, severity, createdAt, nowMs) {
  const target = resolveTarget(facts, account, severity);
  if (!target) return null;
  const weekendNow = isWeekendIST(nowMs);
  const excluded = facts.weekendExclusions.includes(account.account_id);
  const runsNow = target.business ? !weekendNow : !(weekendNow && excluded && target.business === false ? false : weekendNow && excluded);

  let elapsedMin;
  let paused = false;
  let note = null;
  if (target.business) {
    elapsedMin = businessMinutesBetween(createdAt.getTime(), nowMs);
    if (weekendNow && elapsedMin === 0) {
      paused = true;
      note = "business-hours coverage only — clock paused (weekend)";
    }
  } else {
    elapsedMin = Math.round((nowMs - createdAt.getTime()) / 60_000);
    if (weekendNow && excluded) {
      paused = true;
      note = "contract excludes weekend coverage — clock paused";
      elapsedMin = 0;
    }
  }
  const pct = target.minutes ? Math.round((elapsedMin / target.minutes) * 100) : 0;
  return { targetMin: target.minutes, elapsedMin, pct, paused, note, target, coverage: target.weekendCoverage ? "24x7" : target.business ? "business hours" : "clock" };
}
