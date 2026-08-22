// ─────────────────────────────────────────────────────────────────────────────
// Chunker — splits extracted PDF text into retrieval-sized, metadata-rich
// sections. Structure comes FROM the text (numbered sections, KI-entries,
// header lines), so new documents with similar shape chunk themselves.
// ─────────────────────────────────────────────────────────────────────────────

import { TIER_NAMES } from "./registry.js";

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const ISO = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// "1 May 2026" → "2026-05-01" (returns null if unparseable)
export function parseDocDate(s) {
  const m = (s || "").match(/(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[2].slice(0, 1).toUpperCase() + m[2].slice(1, 3).toLowerCase()];
  return mo === undefined ? null : ISO(+m[3], mo, +m[1]);
}

/**
 * @param {string} text     extracted PDF text (newline-separated visual lines)
 * @param {object} docMeta  registry entry for this document
 * @returns {{ header: object, chunks: object[] }}
 */
export function chunkDocument(text, docMeta) {
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);

  // ── header scan: title + "Status: … Effective: … Supersedes…: …" lines ──
  const header = { title: docMeta.title, status: null, effective: null, supersededBy: null, updated: null };
  let bodyStart = 0;
  const scanLimit = Math.min(lines.length, 4);
  for (let i = 0; i < scanLimit; i++) {
    const ln = lines[i];
    if (i === 0) continue; // title line (registry already knows it)
    const st = ln.match(/Status:\s*([A-Za-z][A-Za-z \-]*?)(?=\s+(?:Effective|Updated|Supersedes)|$)/);
    const ef = ln.match(/Effective:\s*([^]+?)(?=\s+Supersedes|$)/);
    const up = ln.match(/Updated:\s*([^]+?)(?=\s+Supersedes|$)/);
    const sb = ln.match(/Supersedes(?:\s+by)?:\s*(.+)$/);
    if (st) header.status = st[1].trim();
    if (ef) header.effective = parseDocDate(ef[1]);
    if (up) header.updated = parseDocDate(up[1]);
    if (sb) header.supersededBy = sb[1].trim();
    if (st || ef || up || sb) bodyStart = i + 1;
  }

  // ── sections: "N. Heading" starts a section; "KI-208 - …" starts a sub-entry ──
  const chunks = [];
  let cur = null;
  const push = () => {
    if (cur && cur.text.trim()) chunks.push(cur);
  };
  const newChunk = (heading, sectionNo, kind) => ({
    id: `${docMeta.id}#${sectionNo ?? chunks.length + 1}`,
    docId: docMeta.id,
    docTitle: docMeta.title,
    kind,
    sectionNo: sectionNo ?? null,
    heading,
    text: heading + "\n",
    tier: docMeta.tier,
    tierName: TIER_NAMES[docMeta.tier] || "unknown",
    status: docMeta.status,
    scope: docMeta.scope,
  });

  for (let i = bodyStart; i < lines.length; i++) {
    const ln = lines[i];
    const sec = ln.match(/^(\d+)\.\s+(.*)$/);
    const sub = ln.match(/^([A-Z]{2,5}-\d{2,5})\s+-\s+(.*)$/); // e.g. "KI-208 - Bulk Upload failures…"
    if (sec) {
      push();
      cur = newChunk(ln, +sec[1], "section");
    } else if (sub) {
      push();
      cur = newChunk(ln, sub[1], "entry"); // sectionNo carries the KI id
    } else if (cur) {
      cur.text += ln + "\n";
    } else {
      // unnumbered heading/body (e.g. deprecated v2 uses plain headings)
      cur = newChunk(ln, null, "section");
    }
  }
  push();

  // docs whose layout yielded nothing (defensive): one full-body chunk
  if (!chunks.length && lines.length) {
    chunks.push(newChunk(lines.slice(bodyStart).join(" "), null, "section"));
  }

  // tag run-on table lines so later phases can parse them structurally
  for (const c of chunks) {
    c.tableLines = c.text.split(/\n/).filter((l) => /^(Plan|P1|P2|P3|Enterprise|Growth|Standard)\b/.test(l));
  }

  return { header, chunks };
}
