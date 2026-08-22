// ─────────────────────────────────────────────────────────────────────────────
// PDF text extractor — zero dependencies.
//
// Handles the PDFs in the candidate pack (and similar generated PDFs):
//   • FlateDecode stream decompression (node:zlib)
//   • Type0/CID fonts with Identity-H encoding via ToUnicode CMaps
//   • Generator layout where every word/glyph is positioned individually:
//     the FIRST Td inside a BT…ET block positions a text run (its dy
//     identifies the visual line); subsequent per-glyph Td moves (dy=0)
//     are plain advances. Explicit space glyphs exist, so no gap guessing.
// ─────────────────────────────────────────────────────────────────────────────
import zlib from "node:zlib";

function unescapePdfString(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      const n = s[++i];
      if (n === "n") out += "\n";
      else if (n === "r") out += "\r";
      else if (n === "t") out += "\t";
      else if (n === "(") out += "(";
      else if (n === ")") out += ")";
      else if (n === "\\") out += "\\";
      else if (n >= "0" && n <= "7") {
        let oct = n;
        while (oct.length < 3 && s[i + 1] >= "0" && s[i + 1] <= "7") oct += s[++i];
        out += String.fromCharCode(parseInt(oct, 8));
      } else out += n;
    } else out += c;
  }
  return out;
}

// Inflate the stream belonging to object `num` (returns latin1 string or null)
function getObjStream(buf, num) {
  const l = buf.toString("latin1");
  let idx = l.indexOf(`\n${num} 0 obj`);
  if (idx === -1) idx = l.indexOf(`${num} 0 obj`);
  if (idx === -1) return null;
  const sIdx = l.indexOf("stream", idx);
  if (sIdx === -1) return null;
  let dataStart = sIdx + "stream".length;
  if (l[dataStart] === "\r") dataStart++;
  if (l[dataStart] === "\n") dataStart++;
  const end = l.indexOf("endstream", dataStart);
  if (end === -1) return null;
  const chunk = buf.subarray(dataStart, end);
  try {
    return zlib.inflateSync(chunk).toString("latin1");
  } catch {
    try {
      return zlib.inflateRawSync(chunk).toString("latin1");
    } catch {
      return null;
    }
  }
}

// Parse a ToUnicode CMap into a Map<cid, string>
function parseCMap(text) {
  const map = new Map();
  let cm;
  const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((cm = charRe.exec(text)) !== null) {
    let pm;
    const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    while ((pm = pairRe.exec(cm[1])) !== null) {
      let uni = "";
      for (let k = 0; k < pm[2].length; k += 4) {
        uni += String.fromCharCode(parseInt(pm[2].substr(k, 4), 16));
      }
      map.set(parseInt(pm[1], 16), uni);
    }
  }
  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((cm = rangeRe.exec(text)) !== null) {
    let pm;
    const lineRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    while ((pm = lineRe.exec(cm[1])) !== null) {
      const lo = parseInt(pm[1], 16), hi = parseInt(pm[2], 16), base = parseInt(pm[3], 16);
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(base + (c - lo)));
    }
  }
  return map;
}

// Decode a PDF string (paren literal or <hex>) as 2-byte CIDs via cmap
function decodeCidString(rawText, isHex, cmap) {
  let s = "";
  if (isHex) {
    const hex = rawText.replace(/\s+/g, "");
    for (let k = 0; k + 4 <= hex.length; k += 4) {
      const cid = parseInt(hex.substr(k, 4), 16);
      s += cmap && cmap.has(cid) ? cmap.get(cid)
        : cid >= 32 && cid < 256 ? String.fromCharCode(cid) : "";
    }
  } else {
    const raw = unescapePdfString(rawText);
    for (let k = 0; k + 2 <= raw.length; k += 2) {
      const cid = raw.charCodeAt(k) * 256 + raw.charCodeAt(k + 1);
      s += cmap && cmap.has(cid) ? cmap.get(cid) : "";
    }
  }
  return s;
}

// Content-stream interpreter tuned for per-glyph-positioning generators.
function runContent(content, fontNameToObj, fontCMaps) {
  let out = "", line = "", curCMap = null, numBuf = [], pending = [];
  let lastY = null, firstTdInRun = true;

  const flush = () => {
    const t = line.replace(/\s+$/, "");
    if (t.trim()) out += t + "\n";
    line = "";
  };
  const show = () => {
    for (const p of pending) line += decodeCidString(p.text, p.hex, curCMap);
    pending = [];
  };

  const tokens = content.match(
    /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\/F\w+|[-+]?\d*\.?\d+|TJ|Tj|Td|TD|T\*|Tf|ET|BT|Tm|'|"/g
  ) || [];

  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (/^[-+]?\d*\.?\d+$/.test(tok)) { numBuf.push(parseFloat(tok)); continue; }

    if (tok.startsWith("/F") && tokens[t + 2] === "Tf") {
      const on = fontNameToObj[tok.slice(1)];
      curCMap = on ? fontCMaps.get(on) || null : null;
      numBuf = []; firstTdInRun = true;
      continue;
    }
    if (tok.startsWith("(")) { pending.push({ hex: false, text: tok.slice(1, -1) }); continue; }
    if (tok.startsWith("<") && tok.length > 2) { pending.push({ hex: true, text: tok.slice(1, -1) }); continue; }

    switch (tok) {
      case "TJ":
      case "Tj": show(); numBuf = []; break;
      case "'": flush(); show(); numBuf = []; firstTdInRun = true; break;
      case '"': numBuf = []; flush(); show(); firstTdInRun = true; break;
      case "BT":
      case "ET": numBuf = []; firstTdInRun = true; break;
      case "Td":
      case "TD": {
        const dy = numBuf.length >= 2 ? numBuf[numBuf.length - 1] : null;
        numBuf = [];
        if (dy !== null && firstTdInRun) {
          if (lastY !== null && Math.abs(dy - lastY) > 0.01) flush();
          lastY = dy;
          firstTdInRun = false;
        }
        break;
      }
      case "Tm": numBuf = []; firstTdInRun = true; break;
      case "T*": flush(); numBuf = []; firstTdInRun = true; break;
      default: numBuf = [];
    }
  }
  show();
  flush();
  return out;
}

/**
 * Extract reading-order text from a PDF buffer.
 * @returns {string} newline-separated text (empty string on failure)
 */
export function extractPdfText(buf) {
  const l = buf.toString("latin1");

  // font obj → CMap
  const fontCMaps = new Map();
  for (const m of l.matchAll(/(\d+)\s+0\s+obj\s*<<([\s\S]*?)>>\s*(stream|endobj)/g)) {
    if (/\/Type\s*\/Font/.test(m[2])) {
      const tou = m[2].match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
      if (tou) {
        const cmText = getObjStream(buf, +tou[1]);
        if (cmText) {
          const cm = parseCMap(cmText);
          if (cm.size) fontCMaps.set(+m[1], cm);
        }
      }
    }
  }

  // resource font name (F4…) → font object number
  const fontNameToObj = {};
  for (const m of l.matchAll(/\/Font\s*<<([^>]*)>>/g)) {
    for (const fm of m[1].matchAll(/\/(F\w+)\s+(\d+)\s+0\s+R/g)) fontNameToObj[fm[1]] = +fm[2];
  }

  // page order via the /Kids array → each page's /Contents
  const order = [];
  const kidsM = l.match(/\/Kids\s*\[([^\]]*)\]/);
  if (kidsM) {
    for (const kn of [...kidsM[1].matchAll(/(\d+)\s+0\s+R/g)].map((x) => +x[1])) {
      const kidx = l.indexOf(`\n${kn} 0 obj`);
      if (kidx === -1) continue;
      const kbody = l.slice(kidx, l.indexOf("endobj", kidx));
      order.push(...[...kbody.matchAll(/\/Contents\s+(\d+)\s+0\s+R/g)].map((x) => +x[1]));
    }
  }

  let full = "";
  if (order.length) {
    for (const cn of order) {
      const c = getObjStream(buf, cn);
      if (c) full += runContent(c, fontNameToObj, fontCMaps) + "\n";
    }
  } else {
    // fallback: treat any content-looking stream as content
    for (const m of l.matchAll(/(\d+)\s+0\s+obj[\s\S]{0,300}?stream\r?\n/g)) {
      const dataStart = m.index + m[0].length;
      const end = l.indexOf("endstream", dataStart);
      try {
        const txt = zlib.inflateSync(buf.subarray(dataStart, end)).toString("latin1");
        if (/\bT[Jj]\b/.test(txt)) full += runContent(txt, fontNameToObj, fontCMaps) + "\n";
      } catch { /* not a content stream — skip */ }
    }
  }
  return full;
}
