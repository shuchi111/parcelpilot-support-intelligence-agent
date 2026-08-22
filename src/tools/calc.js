// ─────────────────────────────────────────────────────────────────────────────
// calculate — safe arithmetic evaluator (no eval, no Function constructor).
// Supports + - * / ( ), unary minus, and min/max/round/floor/ceil, e.g.
//   "min(500, 4200 * 0.10)"  →  420
// Keeping math OUT of the LLM and IN a tool is a core trust decision:
// numbers shown to users must come from deterministic code.
// ─────────────────────────────────────────────────────────────────────────────

export function calculateExpression(input) {
  const src = String(input ?? "").trim();
  if (!src) throw new Error("empty expression");
  if (src.length > 200) throw new Error("expression too long");

  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const peek = () => { ws(); return src[i]; };

  function parseExpr() {
    let v = parseTerm();
    for (;;) {
      const op = peek();
      if (op === "+") { i++; v += parseTerm(); }
      else if (op === "-") { i++; v -= parseTerm(); }
      else return v;
    }
  }
  function parseTerm() {
    let v = parseUnary();
    for (;;) {
      const op = peek();
      if (op === "*") { i++; v *= parseUnary(); }
      else if (op === "/") { i++; const d = parseUnary(); if (d === 0) throw new Error("division by zero"); v /= d; }
      else return v;
    }
  }
  function parseUnary() {
    if (peek() === "-") { i++; return -parseUnary(); }
    if (peek() === "+") { i++; return parseUnary(); }
    return parseAtom();
  }
  function parseAtom() {
    ws();
    const c = src[i];
    if (c === "(") {
      i++;
      const v = parseExpr();
      if (peek() !== ")") throw new Error("expected )");
      i++;
      return v;
    }
    // function call: name(expr, expr, ...)
    const fn = src.slice(i).match(/^(min|max|round|floor|ceil)\s*\(/i);
    if (fn) {
      const name = fn[1].toLowerCase();
      i += fn[0].length;
      const args = [parseExpr()];
      while (peek() === ",") { i++; args.push(parseExpr()); }
      if (peek() !== ")") throw new Error("expected )");
      i++;
      switch (name) {
        case "min": return Math.min(...args);
        case "max": return Math.max(...args);
        case "round": return Math.round(args[0]);
        case "floor": return Math.floor(args[0]);
        case "ceil": return Math.ceil(args[0]);
      }
    }
    const num = src.slice(i).match(/^\d+(\.\d+)?/);
    if (num) {
      i += num[0].length;
      return parseFloat(num[0]);
    }
    throw new Error(`unexpected token at ${i}: '${src[i] ?? "end"}'`);
  }

  const value = parseExpr();
  ws();
  if (i < src.length) throw new Error(`unexpected trailing input: '${src.slice(i)}'`);
  if (!Number.isFinite(value)) throw new Error("non-finite result");
  return Math.round(value * 1e6) / 1e6;
}
