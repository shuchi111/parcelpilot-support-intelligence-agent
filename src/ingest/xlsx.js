// ─────────────────────────────────────────────────────────────────────────────
// XLSX reader — zero dependencies.
//
// Reads .xlsx by parsing the ZIP central directory (streaming-written ZIPs
// zero out local-header sizes, so the central directory is the only reliable
// index), inflating entries with node:zlib, and interpreting sheet XML.
// Correctly preserves EMPTY cells (self-closing <c/>) as null so columns
// never shift — a bug class that silently corrupts data reads.
// ─────────────────────────────────────────────────────────────────────────────
import zlib from "node:zlib";

function unzip(buffer) {
  const files = {};
  // locate End Of Central Directory from the tail
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer[i] === 0x50 && buffer[i + 1] === 0x4b && buffer[i + 2] === 0x05 && buffer[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("xlsx: end-of-central-directory not found (not a zip?)");

  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const cdCount = buffer.readUInt16LE(eocd + 10);
  let p = cdOffset;
  for (let e = 0; e < cdCount; e++) {
    if (!(buffer[p] === 0x50 && buffer[p + 1] === 0x4b && buffer[p + 2] === 0x01 && buffer[p + 3] === 0x02)) break;
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOff = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLen);
    // local header's own name/extra lengths give the true data offset
    const lNameLen = buffer.readUInt16LE(localOff + 26);
    const lExtraLen = buffer.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compSize);
    files[name] = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function xmlUnescape(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, "&");
}

function parseSheetXml(xml, sharedStrings) {
  const rows = [];
  for (const rowM of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    // both <c …>…</c> and self-closing <c …/>
    for (const cellM of rowM[2].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellM[1];
      const body = cellM[2] || "";
      const refM = attrs.match(/r="([A-Z]+)\d+"/);
      if (!refM) continue;
      const typeM = attrs.match(/t="(\w+)"/);
      let val = null;
      const vM = body.match(/<v>([\s\S]*?)<\/v>/);
      const isM = body.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/);
      if (typeM && typeM[1] === "s" && vM) val = sharedStrings[+vM[1]] ?? null;
      else if (typeM && typeM[1] === "inlineStr" && isM) val = xmlUnescape(isM[1]);
      else if (typeM && typeM[1] === "b" && vM) val = vM[1] === "1";
      else if (vM) val = xmlUnescape(vM[1]);
      let colIdx = 0;
      for (const ch of refM[1]) colIdx = colIdx * 26 + (ch.charCodeAt(0) - 64);
      cells[colIdx - 1] = val; // null still occupies the slot → no column shift
    }
    const maxIdx = cells.reduce((a, _, j) => Math.max(a, j), -1);
    const full = new Array(maxIdx + 1).fill(null);
    for (let j = 0; j <= maxIdx; j++) full[j] = cells[j] !== undefined ? cells[j] : null;
    rows.push(full);
  }
  return rows;
}

/**
 * @param {Buffer} buffer .xlsx file bytes
 * @returns {{ sheets: Record<string, (string|number|boolean|null)[][]> }}
 */
export function readXlsx(buffer) {
  const files = unzip(buffer);
  const sharedStrings = [];
  if (files["xl/sharedStrings.xml"]) {
    const ssXml = files["xl/sharedStrings.xml"].toString("utf8");
    for (const si of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      let text = "";
      for (const t of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += xmlUnescape(t[1]);
      sharedStrings.push(text);
    }
  }
  const wbXml = files["xl/workbook.xml"].toString("utf8");
  const relsXml = (files["xl/_rels/workbook.xml.rels"] || Buffer.alloc(0)).toString("utf8");
  const rels = {};
  for (const r of relsXml.matchAll(/<Relationship[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"/g)) rels[r[1]] = r[2];

  const sheets = {};
  for (const s of wbXml.matchAll(/<sheet[^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"/g)) {
    const name = xmlUnescape(s[1]);
    let target = rels[s[2]] || "";
    if (target.startsWith("/xl/")) target = target.slice(1);
    else if (!target.startsWith("xl/")) target = "xl/" + target.replace(/^\.\//, "");
    const sheetXml = files[target];
    if (sheetXml) sheets[name] = parseSheetXml(sheetXml.toString("utf8"), sharedStrings);
  }
  return { sheets };
}
