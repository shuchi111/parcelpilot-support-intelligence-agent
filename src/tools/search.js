// ─────────────────────────────────────────────────────────────────────────────
// BM25 document search over the chunked knowledge base.
//
// Corpus is tiny (≈21 section chunks), so lexical BM25 is deterministic,
// dependency-free, and fully debuggable — no embedding service needed
// (upgrade path documented in ARCHITECTURE.md). Authority handling:
//   • DEPRECATED chunks are never returned as results, but if one would have
//     matched, it's reported in `deprecatedMatches` so the agent can say
//     "an outdated policy version matched and was ignored".
//   • Customer sessions see global docs + THEIR OWN agreement chunks only.
//   • A conflict hint is emitted when tier-1 (contract) and tier-2+ results
//     co-occur, reminding the reasoner which source wins.
// ─────────────────────────────────────────────────────────────────────────────
import { TIERS } from "../ingest/registry.js";

const tokenize = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) || []);

export class DocSearch {
  /** @param {object[]} chunks from buildKnowledgeBase() */
  constructor(chunks) {
    this.chunks = chunks;
    this.docs = chunks.map((c) => tokenize(`${c.heading} ${c.text}`));
    this.N = chunks.length;
    this.avgLen = this.docs.reduce((a, d) => a + d.length, 0) / (this.N || 1);
    this.df = new Map();
    for (const doc of this.docs) {
      for (const t of new Set(doc)) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
  }

  #idf(term) {
    const df = this.df.get(term) || 0;
    return Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
  }

  #score(queryTerms, docIdx) {
    const doc = this.docs[docIdx];
    const tf = new Map();
    for (const t of doc) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    const k1 = 1.2, b = 0.75;
    for (const q of queryTerms) {
      const f = tf.get(q) || 0;
      if (!f) continue;
      score += this.#idf(q) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (doc.length / this.avgLen)));
    }
    return score;
  }

  /**
   * @param {string} query  natural-language query
   * @param {object} session caller session (scope filtering)
   * @param {number} k max results (default 5)
   */
  search(query, session, k = 5) {
    const qTerms = tokenize(query);
    if (!qTerms.length) return { results: [], deprecatedMatches: [], note: null };

    const internal = session?.role === "internal_support" || session?.role === "internal_ops";
    const myAccount = session?.role === "customer" ? session.accountId : null;

    const scored = [];
    const deprecatedMatches = [];
    for (let i = 0; i < this.N; i++) {
      const c = this.chunks[i];
      const s = this.#score(qTerms, i);
      if (s <= 0) continue;
      if (c.status === "DEPRECATED") {
        deprecatedMatches.push({ id: c.id, title: c.docTitle, reason: "superseded" });
        continue;
      }
      // scope: account-scoped contract chunks visible only to that account (or staff)
      if (c.scope?.type === "account" && c.scope.accountId !== myAccount && !internal) continue;
      scored.push({ chunk: c, score: s });
    }

    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, k).map(({ chunk, score }) => ({
      id: chunk.id,
      document: chunk.docTitle,
      section: chunk.heading,
      tier: chunk.tier,
      sourceClass: chunk.tierName,
      status: chunk.status,
      scope: chunk.scope.type === "account" ? chunk.scope.accountId : "global",
      score: Math.round(score * 100) / 100,
      text: chunk.text.trim(),
    }));

    let note = null;
    const topTiers = new Set(results.map((r) => r.tier));
    if (topTiers.has(TIERS.CONTRACT) && (topTiers.has(TIERS.POLICY) || topTiers.has(TIERS.PRODUCT))) {
      note =
        "Results include an account-specific agreement (tier 1) AND general policy/product sources (tier 2/3). " +
        "Per Support Policy v3 §1, the signed agreement OVERRIDES general policy for that account — apply it and say so explicitly.";
    }
    return { results, deprecatedMatches, note };
  }
}
