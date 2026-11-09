/**
 * Turning spreadsheet rows into invoice items.
 * Pure functions, no DOM and no SheetJS, so they can be unit tested in Node.
 */

const DECIMAL_HINT_ROWS = 500;

/**
 * Parse an amount into integer cents.
 *
 * Accepts numbers and strings like "26.60", "26,60", "1.234,56", "1,234.56",
 * "1 234,56 €", "EUR 15,00", "1'234.56", "-5,00", "−5,00", "(5,00)".
 *
 * `decimal` (optional, "," or ".") resolves the one ambiguous shape, a single
 * separator followed by exactly three digits: "1.234" is 1234 when the column
 * uses "," as decimal separator and 1,234 when it uses ".". Without a hint it
 * is read as a decimal (26.600 -> 26,60), matching the HZZO export.
 *
 * Returns null when the value is empty or not a number.
 */
export function parseAmount(v, decimal) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) : null;
  if (typeof v === "boolean" || v instanceof Date) return null;

  let s = String(v).trim();
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); } // accounting negative
  s = s.replace(/[\s  '’€$£]|EUR|HRK|KN/gi, "").replace(/[−–]/g, "-");
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1); }
  if (s.endsWith("-")) { neg = !neg; s = s.slice(0, -1); } // "5,00-" (SAP style)
  if (!s) return null;

  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // whichever separator comes last is the decimal separator
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma > -1 || lastDot > -1) {
    const sep = lastComma > -1 ? "," : ".";
    const parts = s.split(sep);
    if (parts.length > 2) {
      s = parts.join(""); // "1.234.567" -> thousands
    } else {
      const thousands = parts[1].length === 3 && decimal && decimal !== sep;
      s = thousands ? parts.join("") : parts.join(".");
    }
  }

  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return neg ? -cents : cents;
}

/**
 * Guess the decimal separator a column uses from its text values.
 * Unambiguous evidence: both separators present, or one separator followed
 * by 1-2 (or 4+) digits. Returns "," or "." or undefined.
 */
export function detectDecimal(values) {
  let comma = 0, dot = 0;
  for (const v of values) {
    if (typeof v !== "string") continue;
    const s = v.replace(/[^\d.,]/g, "");
    const lc = s.lastIndexOf(","), ld = s.lastIndexOf(".");
    if (lc > -1 && ld > -1) { lc > ld ? comma++ : dot++; continue; }
    const m = s.match(/^\d*([.,])(\d+)$/);
    if (m && m[2].length !== 3) m[1] === "," ? comma++ : dot++;
  }
  if (comma === dot) return undefined;
  return comma > dot ? "," : ".";
}

/**
 * Parse a date cell into a sortable day number (days since 1970-01-01, UTC).
 * Accepts JS Dates, Excel serial numbers, "06.11.2026", "06.11.2026.",
 * "6.11.2026 10:22", "2026-11-06", "06/11/2026" (day first, Croatian order).
 * Returns null when not a date.
 */
export function parseDate(v) {
  if (v == null || v === "") return null;
  const day = (y, m, d) => {
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
    const t = Date.UTC(y, m - 1, d);
    const back = new Date(t);
    if (back.getUTCDate() !== d) return null; // 31.02.
    return Math.round(t / 86_400_000);
  };
  if (v instanceof Date) return Number.isNaN(+v) ? null : day(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === "number") {
    // Excel serial date (1900 system): 25569 = 1970-01-01
    if (v < 20000 || v > 120000) return null;
    return Math.floor(v) - 25569;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})\.?(?:[ T].*)?$/);
  if (m) return day(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/);
  if (m) return day(+m[1], +m[2], +m[3]);
  return null;
}

/** Format a day number as 06.11.2026. */
export function formatDay(d) {
  if (d == null) return "";
  const t = new Date(d * 86_400_000);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(t.getUTCDate())}.${p(t.getUTCMonth() + 1)}.${t.getUTCFullYear()}.`;
}

const TOTAL_LABEL = /^\s*(sve)?ukupno\b|^\s*(grand\s+)?total\b|^\s*zbroj\b|^\s*suma?\b|^\s*sveukupno/i;
const ID_HEADER = /broj ra[čc]una|ra[čc]un|invoice|faktur|dokument|broj|number|^br\.?|^id$/i;
const AMOUNT_HEADER = /iznos|amount|total|ukupno|svota|suma|vrijednost|cijena|price|eur/i;

/**
 * Index of the header row within the first 30 rows.
 * 1. first row that mentions an amount or invoice-number keyword;
 * 2. otherwise the first row that is mostly text and is followed by a row
 *    containing at least one amount;
 * 3. otherwise 0.
 */
export function findHeaderRow(rows) {
  const limit = Math.min(rows.length, 30);
  for (let i = 0; i < limit; i++) {
    const cells = (rows[i] || []).map((c) => String(c ?? ""));
    if (cells.some((c) => /iznos/i.test(c) || /broj ra[čc]una/i.test(c))) return i;
  }
  for (let i = 0; i < limit; i++) {
    const cells = (rows[i] || []).filter((c) => c !== "" && c != null);
    if (cells.length < 2) continue;
    const texty = cells.filter((c) => typeof c === "string" && parseAmount(c) == null && parseDate(c) == null).length;
    const next = rows[i + 1] || [];
    if (texty / cells.length >= 0.6 && next.some((c) => (parseAmount(c) ?? 0) > 0)) return i;
  }
  return 0;
}

/**
 * Best guess for the invoice-number, amount and date columns.
 * Uses header names first, then the cell contents of `sample` rows:
 * amount = column with the most positive amounts that look like money
 * (decimals or text), id = column with the most distinct non-empty values.
 * date is -1 when no date column is found.
 */
export function guessColumns(header, sample = []) {
  const h = header.map((c) => String(c ?? "").toLowerCase().trim());
  const width = Math.max(h.length, ...sample.map((r) => (r ? r.length : 0)));
  const col = (j) => sample.map((r) => (r ? r[j] : undefined)).filter((c) => c !== "" && c != null);

  const find = (...patterns) => {
    for (const p of patterns) {
      const i = h.findIndex((c) => p.test(c));
      if (i > -1) return i;
    }
    return -1;
  };

  let amount = find(/ukupan iznos/, /ukupno/, /^iznos/, /iznos/, /amount/, /total/, /svota/);
  let id = find(/broj ra[čc]una\s*-\s*zu/, /broj ra[čc]una/, /ra[čc]un/, /invoice/, /faktur/);
  let date = find(/datum primitka/, /datum/, /date/);

  const stats = [];
  for (let j = 0; j < width; j++) {
    const vals = col(j);
    const amounts = vals.map((v) => parseAmount(v)).filter((c) => c != null && c > 0);
    const moneyish = vals.filter((v) => (typeof v === "number" && !Number.isInteger(v)) || (typeof v === "string" && /\d[.,]\d{2}\b/.test(v)));
    const dates = vals.filter((v) => typeof v === "string" && parseDate(v) != null);
    stats.push({ j, n: vals.length, amounts: amounts.length, money: moneyish.length, dates: dates.length, distinct: new Set(vals.map(String)).size });
  }

  if (amount < 0 && sample.length) {
    const c = stats
      .filter((s) => s.n && s.amounts / s.n >= 0.8 && s.dates === 0)
      .sort((a, b) => b.money - a.money || b.amounts - a.amounts || b.j - a.j)[0];
    if (c) amount = c.j;
  }
  if (id < 0 && sample.length) {
    const c = stats
      .filter((s) => s.j !== amount && s.n && s.dates / s.n < 0.5)
      .sort((a, b) => b.distinct - a.distinct || a.j - b.j)[0];
    if (c) id = c.j;
  }
  if (date < 0 && sample.length) {
    const c = stats.find((s) => s.n && s.dates / s.n >= 0.8);
    if (c) date = c.j;
  }
  if (id < 0) id = 0;
  if (amount < 0) amount = Math.max(0, width - 1);
  return { id, amount, date };
}

/**
 * Build invoice items from data rows (rows after the header).
 *
 * @param {any[][]} dataRows
 * @param {number} headerRowIndex  0-based index of the header row
 * @param {{id:number, amount:number, date?:number}} cols  column indexes (date -1 = none)
 * @param {{source?: string}} [opts]
 * @returns {{
 *   items: {row:number, id:string, cents:number, day:number|null, cells:any[], source:string}[],
 *   skipped: {row:number, reason:"no amount"|"zero"|"negative", source:string, value:any}[]
 * }}
 *   row is the 1-based Excel row number, so users can find the line in their file.
 */
export function buildItems(dataRows, headerRowIndex, cols, opts = {}) {
  // v1 signature: buildItems(rows, headerRow, idCol, amountCol)
  if (typeof cols === "number") cols = { id: cols, amount: opts };
  if (typeof opts !== "object") opts = {};
  const source = opts.source ?? "";
  const decimal = detectDecimal(dataRows.slice(0, DECIMAL_HINT_ROWS).map((r) => r && r[cols.amount]));
  const items = [], skipped = [];
  dataRows.forEach((r, k) => {
    const row = headerRowIndex + k + 2;
    if (!r || r.every((c) => c === "" || c == null)) return; // blank line
    const value = r[cols.amount];
    const cents = parseAmount(value, decimal);
    if (cents == null) {
      // a trailing "Ukupno" / total line is not an invoice
      skipped.push({ row, reason: "no amount", source, value });
      return;
    }
    if (cents === 0) { skipped.push({ row, reason: "zero", source, value }); return; }
    if (cents < 0) { skipped.push({ row, reason: "negative", source, value }); return; }
    const day = cols.date != null && cols.date >= 0 ? parseDate(r[cols.date]) : null;
    items.push({ row, id: String(r[cols.id] ?? "").trim(), cents, day, cells: r, source });
  });

  // Drop a trailing totals row: a cell labelled "Ukupno"/"Total"/..., or no
  // invoice number and an amount equal to the sum above it.
  const last = items[items.length - 1];
  if (last && items.length > 1) {
    const above = items.slice(0, -1).reduce((s, x) => s + x.cents, 0);
    const labelled = last.cells.some((c) => typeof c === "string" && TOTAL_LABEL.test(c));
    if (labelled || (!last.id && last.cents === above)) {
      items.pop();
      skipped.push({ row: last.row, reason: "total row", source, value: last.cells[cols.amount] });
    }
  }
  return { items, skipped };
}

/**
 * Find duplicate invoices (same id and amount), e.g. from overlapping exports.
 * Returns the items to drop (every occurrence after the first).
 */
export function findDuplicates(items) {
  const seen = new Set(), dups = [];
  for (const x of items) {
    if (!x.id) continue;
    const key = `${x.id}\u0000${x.cents}`;
    if (seen.has(key)) dups.push(x); else seen.add(key);
  }
  return dups;
}

/** Format cents the Croatian way: 1.234,56 */
export function formatCents(c) {
  const neg = c < 0; c = Math.abs(c);
  const euros = Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (neg ? "-" : "") + euros + "," + String(c % 100).padStart(2, "0");
}
