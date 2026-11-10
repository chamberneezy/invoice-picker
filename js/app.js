// UI wiring: files -> parse -> solve (in a Web Worker) -> options -> render / copy / download.
import {
  parseAmount, findHeaderRow, guessColumns, buildItems, findDuplicates, formatCents, formatDay,
} from "./parse.js";

const SAMPLE_URL = "sample/InvoicesLiqudatedReport-sample.xlsx";
const SAMPLE_NAME = "InvoicesLiqudatedReport-primjer.xlsx";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const racuna = (n) => `${n} ${plural(n, "račun", "računa", "računa")}`;

const state = {
  files: [],          // { name, sheetNames, sheets: {name: rows[][]} }
  sheet: "",          // selected sheet name (applies to every file that has it)
  header: [],         // header of the first file, drives the column selects
  items: [],          // { row, id, cents, day, cells, source, fileIdx, use: "auto"|"always"|"never", dup }
  skipped: [],
  result: null,       // { kind: "options"|"batches", ... }
  active: 0,          // selected option / batch
  search: "",
};

// ---------- nothing is stored ----------
// Medical billing data: files, results and settings live only in memory for this page view.
// Earlier versions kept settings in localStorage; remove that key if it is still there.
const LEGACY_SETTINGS_KEY = "invoice-picker:settings";
try { localStorage.removeItem(LEGACY_SETTINGS_KEY); } catch { /* storage blocked: nothing to remove */ }
const DEFAULTS = { limit: "1000", mode: "under", prefer: "order", count: "5" };
const mode = () => document.querySelector("input[name=mode]:checked").value;

// ---------- worker ----------
let worker = null, jobId = 0;
function solveAsync(kind, amounts, target, opts) {
  if (!worker) worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => { if (e.data.id === id) (e.data.ok ? resolve(e.data.result) : reject(e.data)); };
    worker.onerror = (e) => reject({ code: "ERROR", message: e.message });
    cancelJob = () => { worker.terminate(); worker = null; reject({ code: "CANCELLED" }); };
    worker.postMessage({ id, kind, amounts, target, opts });
  });
}
let cancelJob = () => {};
let resetGen = 0; // bumped by a reset so a run that was in flight drops its result

// ---------- messages ----------
function say(html, warn = false) {
  const m = $("msg");
  m.className = "note" + (warn ? " warn" : "");
  m.innerHTML = html;
}

// ---------- loading ----------
function readWorkbook(buffer, name) {
  if (!window.XLSX) { say("Biblioteka za čitanje Excela nije učitana. Osvježite stranicu.", true); return null; }
  try {
    // raw: CSV/TXT cells stay text, so "26,60" is not misread as 2660
    const wb = XLSX.read(new Uint8Array(buffer), { type: "array", cellDates: true, dense: true, raw: true });
    const sheets = {};
    for (const n of wb.SheetNames) sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" });
    const sheetNames = wb.SheetNames.filter((n) => sheets[n].some((r) => r.some((c) => c !== "")));
    if (!sheetNames.length) { say(`Datoteka <b>${esc(name)}</b> je prazna.`, true); return null; }
    return { name, sheetNames, sheets };
  } catch {
    say(`Datoteku <b>${esc(name)}</b> nije moguće pročitati. Provjerite je li to Excel (.xlsx, .xls) ili CSV izvještaj.`, true);
    return null;
  }
}

async function addFiles(fileList, replace) {
  const loaded = [];
  for (const f of fileList) {
    try {
      const wb = readWorkbook(await f.arrayBuffer(), f.name);
      if (wb) loaded.push(wb);
    } catch { say(`Datoteku <b>${esc(f.name)}</b> nije moguće otvoriti.`, true); }
  }
  if (!loaded.length) return;
  if (replace) state.files = [];
  // the same file dropped twice replaces the earlier copy
  for (const wb of loaded) {
    const i = state.files.findIndex((x) => x.name === wb.name);
    if (i > -1) state.files[i] = wb; else state.files.push(wb);
  }
  state.sheet = pickSheet(state.files[0]);
  setupColumns();
}

async function loadSample() {
  try {
    const res = await fetch(SAMPLE_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    const wb = readWorkbook(await res.arrayBuffer(), SAMPLE_NAME);
    if (!wb) return;
    state.files = [wb];
    state.sheet = pickSheet(wb);
    setupColumns();
  } catch {
    say("Primjer nije dostupan.", true);
  }
}

/** The sheet that looks most like an invoice list: has an amount column header, else the first. */
function pickSheet(wb) {
  return wb.sheetNames.find((n) => {
    const rows = wb.sheets[n];
    return (rows[findHeaderRow(rows)] || []).some((c) => /iznos|amount|total/i.test(String(c)));
  }) || wb.sheetNames[0];
}

const rowsOf = (wb) => wb.sheets[wb.sheetNames.includes(state.sheet) ? state.sheet : wb.sheetNames[0]];

function setupColumns() {
  const first = state.files[0];
  const rows = rowsOf(first);
  const hr = findHeaderRow(rows);
  state.header = rows[hr] || [];
  const g = guessColumns(state.header, rows.slice(hr + 1, hr + 51));
  const width = Math.max(state.header.length, ...rows.slice(hr, hr + 50).map((r) => r.length));
  const opts = Array.from({ length: width }, (_, i) => `<option value="${i}">${esc(String(state.header[i] || `Stupac ${colLetter(i)}`))}</option>`).join("");
  $("colId").innerHTML = opts; $("colId").value = g.id;
  $("colAmt").innerHTML = opts; $("colAmt").value = g.amount;
  $("colDate").innerHTML = `<option value="-1">— bez datuma —</option>` + opts; $("colDate").value = g.date;

  const allSheets = [...new Set(state.files.flatMap((f) => f.sheetNames))];
  $("sheet").innerHTML = allSheets.map((n) => `<option>${esc(n)}</option>`).join("");
  $("sheet").value = state.sheet;
  $("sheetField").hidden = allSheets.length < 2;
  $("cols").hidden = false;
  renderFiles();
  rebuildItems();
}

function colLetter(i) {
  let s = ""; i++;
  while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

/** Map the chosen columns of the first file onto another file by header name. */
function columnsFor(header) {
  const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const pick = (sel) => {
    const i = +$(sel).value;
    if (i < 0) return -1;
    const name = norm(state.header[i]);
    const j = name ? header.findIndex((h) => norm(h) === name) : -1;
    return j > -1 ? j : i;
  };
  return { id: pick("colId"), amount: pick("colAmt"), date: pick("colDate") };
}

function rebuildItems() {
  const items = [], skipped = [];
  state.files.forEach((wb, fileIdx) => {
    const rows = rowsOf(wb);
    const hr = findHeaderRow(rows);
    const r = buildItems(rows.slice(hr + 1), hr, columnsFor(rows[hr] || []), { source: wb.name });
    for (const x of r.items) items.push({ ...x, fileIdx, use: "auto", dup: false });
    skipped.push(...r.skipped);
  });
  for (const d of findDuplicates(items)) { d.use = "never"; d.dup = true; }
  state.items = items;
  state.skipped = skipped;
  state.result = null;

  const dups = items.filter((x) => x.dup).length;
  const neg = skipped.filter((s) => s.reason === "negative");
  const bad = skipped.filter((s) => s.reason === "no amount" || s.reason === "zero");
  const where = (list) => list.slice(0, 5).map((s) => (state.files.length > 1 ? `${esc(s.source)} r. ${s.row}` : s.row)).join(", ") + (list.length > 5 ? "…" : "");
  const parts = [`Učitano <b>${racuna(items.length)}</b>${state.files.length > 1 ? ` iz ${state.files.length} datoteke` : ""}.`];
  if (dups) parts.push(`${dups} ${plural(dups, "dupli račun je isključen", "dupla računa su isključena", "duplih računa je isključeno")} (isti broj i iznos).`);
  if (neg.length) parts.push(`Preskočeno ${neg.length} s negativnim iznosom (storno/odobrenje): red ${where(neg)}.`);
  if (bad.length) parts.push(`Preskočeno ${bad.length} ${plural(bad.length, "redak", "retka", "redaka")} bez iznosa: red ${where(bad)}.`);
  if (!items.length) parts.push("Provjerite jesu li odabrani pravi stupci.");
  say(parts.join(" "), !items.length || neg.length > 0 || bad.length > 0 || dups > 0);

  for (const k of ["run", "batches", "resetAll", "search"]) $(k).disabled = !items.length;
  clearResult();
  renderAll();
  if (items.length) run();
}

function renderFiles() {
  const ul = $("files");
  ul.hidden = !state.files.length;
  ul.innerHTML = state.files.map((f, i) =>
    `<li><span>${esc(f.name)}</span><button type="button" class="x" data-rm="${i}" aria-label="Ukloni ${esc(f.name)}">×</button></li>`).join("");
}

// ---------- solving ----------
function pool() {
  // oldest first (no date last), then file and row order; "order" tie-break relies on this
  return state.items
    .filter((x) => x.use !== "never")
    .sort((a, b) => (a.day ?? Infinity) - (b.day ?? Infinity) || a.fileIdx - b.fileIdx || a.row - b.row);
}

function readTarget() {
  const t = parseAmount($("limit").value, ",");
  if (t == null || t <= 0) { say("Upišite iznos kao pozitivan broj, npr. 190 ili 1.000,00.", true); $("limit").focus(); return null; }
  return t;
}

async function run(kind = "options") {
  const target = readTarget();
  if (target == null) return;
  const p = pool();
  if (!p.length) { say("Nijedan račun nije uključen.", true); return; }
  const m = mode();
  const prefer = $("prefer").value;
  const opts = kind === "batches"
    ? { prefer }
    : { mode: m, prefer, count: +$("count").value, required: p.flatMap((x, i) => (x.use === "always" ? [i] : [])) };

  setBusy(true);
  const gen = resetGen;
  const t0 = performance.now();
  try {
    const r = await solveAsync(kind, p.map((x) => x.cents), target, opts);
    if (gen !== resetGen) return;
    const ms = performance.now() - t0;
    state.active = 0;
    if (kind === "batches") {
      state.result = {
        kind, target, prefer, exact: r.exact, ms,
        batches: r.batches.map((b) => ({ items: b.indexes.map((i) => p[i]), total: b.total })),
        leftover: r.leftover.map((i) => p[i]),
      };
    } else {
      state.result = {
        kind, target, mode: m, prefer, ms, method: r.method, exact: r.exact, tieBreakExact: r.tieBreakExact,
        requiredTotal: r.requiredTotal, required: opts.required.length, poolTotal: p.reduce((s, x) => s + x.cents, 0),
        options: r.options.map((o) => ({ items: o.indexes.map((i) => p[i]), total: o.total, diff: o.diff })),
      };
    }
    showResult();
  } catch (err) {
    if (gen !== resetGen) return;
    if (err.code === "CANCELLED") say("Izračun je prekinut.", true);
    else say("Izračun nije uspio. Osvježite stranicu i pokušajte ponovno.", true);
  } finally {
    if (gen === resetGen) setBusy(false);
  }
}

let busyTimer = 0;
function setBusy(on) {
  for (const k of ["run", "batches"]) $(k).disabled = on || !state.items.length;
  clearTimeout(busyTimer);
  if (on) {
    // only show the busy line and cancel button for runs that take a moment
    busyTimer = setTimeout(() => { $("busy").hidden = false; $("cancel").hidden = false; }, 250);
  } else {
    $("busy").hidden = true; $("cancel").hidden = true;
  }
}

// ---------- rendering ----------
function currentSelection() {
  const r = state.result;
  if (!r) return null;
  if (r.kind === "options") {
    const o = r.options[state.active];
    return o ? { items: sortForDisplay(o.items), total: o.total, diff: o.diff } : null;
  }
  if (state.active === r.batches.length) {
    const items = sortForDisplay(r.leftover);
    return { items, total: items.reduce((s, x) => s + x.cents, 0), leftover: true };
  }
  const b = r.batches[state.active];
  return b ? { items: sortForDisplay(b.items), total: b.total, diff: b.total - r.target } : null;
}
const sortForDisplay = (items) => [...items].sort((a, b) => (a.day ?? Infinity) - (b.day ?? Infinity) || a.fileIdx - b.fileIdx || a.row - b.row);

function pickedMap() {
  const map = new Map();
  const r = state.result;
  if (!r) return map;
  if (r.kind === "batches") r.batches.forEach((b, k) => b.items.forEach((x) => map.set(x, `serija ${k + 1}`)));
  return map;
}

function renderAll() {
  const picked = pickedMap();
  const activeSet = new Set(currentSelection()?.items || []);
  const q = state.search.trim().toLowerCase();
  const multi = state.files.length > 1;
  const rows = state.items.map((x, i) => ({ x, i })).filter(({ x }) =>
    !q || x.id.toLowerCase().includes(q) || formatCents(x.cents).includes(q) || formatDay(x.day).includes(q));
  $("allBody").innerHTML = state.items.length
    ? rows.map(({ x, i }) => `
      <tr class="${activeSet.has(x) ? "picked" : ""} ${x.use === "never" ? "off" : ""}">
        <td><select class="use use-${x.use}" data-i="${i}" aria-label="Uzeti račun ${esc(x.id)}">
          <option value="auto"${x.use === "auto" ? " selected" : ""}>Može</option>
          <option value="always"${x.use === "always" ? " selected" : ""}>Uvijek</option>
          <option value="never"${x.use === "never" ? " selected" : ""}>Nikad</option>
        </select></td>
        <td class="num c-row" title="${multi ? esc(x.source) : ""}">${multi ? `<span class="src">${x.fileIdx + 1}:</span>` : ""}${x.row}</td>
        <td class="num">${esc(x.id)}${x.dup ? ' <span class="chip warn">dupli</span>' : ""}${picked.has(x) ? ` <span class="chip">${picked.get(x)}</span>` : ""}</td>
        <td class="num c-date">${formatDay(x.day)}</td>
        <td class="r num">${formatCents(x.cents)}</td>
      </tr>`).join("") || `<tr><td colspan="5" class="empty">Nema računa koji odgovaraju pretrazi.</td></tr>`
    : `<tr><td colspan="5" class="empty">Još nema učitanih računa.</td></tr>`;
  const inc = state.items.filter((x) => x.use !== "never");
  $("sAll").textContent = state.items.length ? `${formatCents(inc.reduce((s, x) => s + x.cents, 0))}` : "–";
  $("sAll").title = state.items.length ? `${racuna(inc.length)} od ${state.items.length}` : "";
}

function clearResult() {
  state.result = null;
  $("resBody").innerHTML = `<tr><td colspan="4" class="empty">Kliknite Izračunaj.</td></tr>`;
  $("resFoot").innerHTML = "";
  for (const k of ["sSum", "sDiff", "sCount"]) $(k).textContent = "–";
  for (const k of ["copyList", "copyTable", "download"]) $(k).disabled = true;
  $("copyFallback").hidden = true;
  $("optPanel").hidden = true;
  $("resTitle").textContent = "Rezultat";
}

const signed = (c) => (c > 0 ? "+" : c < 0 ? "−" : "") + formatCents(Math.abs(c));

function diffLabel(r) {
  if (r.kind === "batches" || r.mode === "under") return "Do limita ostaje";
  if (r.mode === "over") return "Iznad cilja";
  return "Razlika do cilja";
}

function showResult() {
  const r = state.result;
  renderOptions();
  const sel = currentSelection();
  const items = sel?.items || [];
  $("sSum").textContent = sel ? formatCents(sel.total) : "–";
  $("sDiffLabel").textContent = diffLabel(r);
  $("sDiff").textContent = !sel || sel.leftover ? "–"
    : r.kind === "batches" || r.mode === "under" ? formatCents(-sel.diff)
    : r.mode === "over" ? formatCents(sel.diff) : signed(sel.diff);
  $("sCount").textContent = sel ? items.length : "–";
  $("resTitle").textContent = r.kind === "batches"
    ? (sel?.leftover ? "Neraspoređeni računi" : `Serija ${state.active + 1}`)
    : r.options.length > 1 ? `Prijedlog ${state.active + 1}` : "Rezultat";

  $("resBody").innerHTML = items.length
    ? items.map((x, i) => `<tr><td class="num">${i + 1}</td><td class="num">${esc(x.id)}</td><td class="num c-date">${formatDay(x.day)}</td><td class="r num">${formatCents(x.cents)}</td></tr>`).join("")
    : `<tr><td colspan="4" class="empty">${esc(emptyReason(r))}</td></tr>`;
  $("resFoot").innerHTML = items.length ? `<tr><td></td><td>Ukupno</td><td class="c-date"></td><td class="r num">${formatCents(sel.total)}</td></tr>` : "";
  for (const k of ["copyList", "copyTable"]) $(k).disabled = !items.length;
  $("download").disabled = r.kind === "options" ? !items.length : !r.batches.length;
  $("copyFallback").hidden = true;
  renderAll();
}

function emptyReason(r) {
  if (r.kind === "batches") return r.batches.length ? "Nema neraspoređenih računa." : "Svaki račun je veći od iznosa.";
  if (r.options.length) return r.mode === "under" && !r.required ? "Svaki račun je veći od limita." : "Nijedan račun nije potreban.";
  if (r.mode === "under" && r.required) return `Računi označeni s „Uvijek“ već zajedno iznose ${formatCents(r.requiredTotal)} € i prelaze limit.`;
  if (r.mode === "over") return `Ni svi uključeni računi zajedno (${formatCents(r.poolTotal)} €) ne dosežu cilj.`;
  return "Svaki račun je veći od limita.";
}

function renderOptions() {
  const r = state.result;
  const panel = $("optPanel");
  const notes = [];
  let cards = [];
  if (r.kind === "options") {
    $("optTitle").textContent = "Prijedlozi";
    cards = r.options.map((o, k) => ({
      k, title: `${k + 1}. ${formatCents(o.total)} €`,
      sub: `${diffText(r, o.diff)} · ${racuna(o.items.length)}`,
    }));
    if (r.options.length && r.options.length < +$("count").value && r.method !== "approx") {
      notes.push(r.options.length === 1 ? "Postoji samo jedan mogući zbroj." : `Postoji samo ${r.options.length} mogućih zbrojeva.`);
    }
    if (!r.exact) notes.push("Izvještaj je prevelik za potpunu provjeru svih kombinacija, pa je ovo vrlo dobro približno rješenje, ali možda ne i najbolje moguće.");
    else if (!r.tieBreakExact && r.prefer !== "order") notes.push("Zbroj je najbolji mogući; pravilo za jednake zbrojeve primijenjeno je približno.");
    if (r.required) notes.push(`Uključeno ${racuna(r.required)} označenih s „Uvijek“ (${formatCents(r.requiredTotal)} €).`);
    panel.hidden = r.options.length <= 1 && !notes.length;
  } else {
    $("optTitle").textContent = `Serije do ${formatCents(r.target)} €`;
    cards = r.batches.map((b, k) => ({
      k, title: `Serija ${k + 1}: ${formatCents(b.total)} €`,
      sub: `ostaje ${formatCents(r.target - b.total)} · ${racuna(b.items.length)}`,
    }));
    if (r.leftover.length) {
      const sum = r.leftover.reduce((s, x) => s + x.cents, 0);
      cards.push({ k: r.batches.length, title: `Ostalo: ${formatCents(sum)} €`, sub: `${racuna(r.leftover.length)} veći od iznosa`, muted: true });
    }
    notes.push("Svaka serija je najbolji mogući zbroj od računa koji su preostali nakon prethodnih serija. Oznaka „Uvijek“ se kod serija ne primjenjuje.");
    if (!r.exact) notes.push("Neke serije su približno rješenje jer je izvještaj vrlo velik.");
    panel.hidden = false;
  }
  $("opts").innerHTML = cards.map((c) =>
    `<button type="button" role="option" class="opt${c.k === state.active ? " on" : ""}${c.muted ? " muted" : ""}" aria-selected="${c.k === state.active}" data-k="${c.k}">
      <b class="num">${esc(c.title)}</b><span>${esc(c.sub)}</span></button>`).join("");
  $("optNote").hidden = !notes.length;
  $("optNote").textContent = notes.join(" ");
}

function diffText(r, diff) {
  if (diff === 0) return "točno";
  if (r.mode === "under") return `ostaje ${formatCents(-diff)}`;
  if (r.mode === "over") return `iznad ${formatCents(diff)}`;
  return diff < 0 ? `ispod ${formatCents(-diff)}` : `iznad ${formatCents(diff)}`;
}

// ---------- output ----------
async function copy(text, btn) {
  const orig = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Kopirano";
  } catch {
    const t = $("copyFallback");
    t.hidden = false; t.value = text; t.select();
    btn.textContent = "Označeno ispod";
  }
  setTimeout(() => (btn.textContent = orig), 1800);
}

function resultTsv() {
  const s = currentSelection();
  return ["Broj računa\tDatum\tIznos", ...s.items.map((x) => `${x.id}\t${formatDay(x.day)}\t${formatCents(x.cents)}`), `Ukupno\t\t${formatCents(s.total)}`].join("\n");
}

const modeText = { under: "do iznosa (ne prelazi)", closest: "najbliži iznosu", over: "barem iznos" };

function itemRow(x) {
  return [x.id, x.day == null ? "" : formatDay(x.day), x.cents / 100, x.row, x.source];
}
const ITEM_HEAD = ["Broj računa", "Datum", "Iznos (EUR)", "Red u izvornoj datoteci", "Datoteka"];

function sheetFrom(aoa, widths, moneyCols) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = widths.map((wch) => ({ wch }));
  const range = XLSX.utils.decode_range(ws["!ref"]);
  for (let r = 0; r <= range.e.r; r++) {
    for (const c of moneyCols) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === "number") cell.z = "#,##0.00";
    }
  }
  return ws;
}

/** Original columns of the given items, with the header of their file. */
function originalSheet(items) {
  const header = [...state.header.map((h, i) => String(h || `Stupac ${colLetter(i)}`)), "Datoteka", "Red"];
  const aoa = [header, ...items.map((x) => [...state.header.map((_, i) => x.cells[i] ?? ""), x.source, x.row])];
  return XLSX.utils.aoa_to_sheet(aoa);
}

function downloadXlsx() {
  const r = state.result;
  const wb = XLSX.utils.book_new();
  if (r.kind === "options") {
    const s = currentSelection();
    const aoa = [
      ITEM_HEAD,
      ...s.items.map(itemRow),
      [],
      ["Ukupno", "", s.total / 100],
      ["Cilj", "", r.target / 100],
      [r.mode === "over" ? "Iznad cilja" : r.mode === "under" ? "Do limita ostaje" : "Razlika (zbroj − cilj)", "", (r.mode === "under" ? -s.diff : s.diff) / 100],
      ["Uvjet", modeText[r.mode]],
    ];
    XLSX.utils.book_append_sheet(wb, sheetFrom(aoa, [24, 12, 14, 22, 34], [2]), "Odabrani računi");
    XLSX.utils.book_append_sheet(wb, originalSheet(s.items), "Svi stupci");
  } else {
    const summary = [
      ["Serija", "Broj računa", "Zbroj (EUR)", "Do limita ostaje"],
      ...r.batches.map((b, k) => [k + 1, b.items.length, b.total / 100, (r.target - b.total) / 100]),
    ];
    if (r.leftover.length) summary.push(["Ostalo (veće od iznosa)", r.leftover.length, r.leftover.reduce((s, x) => s + x.cents, 0) / 100, ""]);
    summary.push([], ["Iznos po seriji", "", r.target / 100]);
    XLSX.utils.book_append_sheet(wb, sheetFrom(summary, [24, 12, 14, 18], [2, 3]), "Serije");
    const flat = [["Serija", ...ITEM_HEAD]];
    r.batches.forEach((b, k) => sortForDisplay(b.items).forEach((x) => flat.push([k + 1, ...itemRow(x)])));
    sortForDisplay(r.leftover).forEach((x) => flat.push(["ostalo", ...itemRow(x)]));
    XLSX.utils.book_append_sheet(wb, sheetFrom(flat, [8, 24, 12, 14, 22, 34], [3]), "Računi po serijama");
  }
  const base = (state.files[0]?.name || "racuni").replace(/\.[^.]+$/, "");
  const tag = r.kind === "batches" ? "serije" : "odabrano";
  XLSX.writeFile(wb, `${base}-${tag}-${(r.target / 100).toFixed(2)}.xlsx`, { compression: true });
}

// ---------- events ----------
$("file").addEventListener("change", (e) => { if (e.target.files.length) addFiles([...e.target.files], false); e.target.value = ""; });
const drop = $("drop");
for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files], false); });

$("files").addEventListener("click", (e) => {
  const i = e.target.dataset?.rm;
  if (i == null) return;
  state.files.splice(+i, 1);
  if (!state.files.length) { resetEverything(false); return; }
  setupColumns();
});
$("msg").addEventListener("click", (e) => { if (e.target.id === "loadSample") loadSample(); });
$("sheet").addEventListener("change", () => { state.sheet = $("sheet").value; setupColumns(); });
for (const k of ["colId", "colAmt", "colDate"]) $(k).addEventListener("change", rebuildItems);

$("run").addEventListener("click", () => run("options"));
$("batches").addEventListener("click", () => run("batches"));
$("cancel").addEventListener("click", () => cancelJob());
$("limit").addEventListener("keydown", (e) => { if (e.key === "Enter" && !$("run").disabled) run("options"); });
for (const r of document.querySelectorAll("input[name=mode]")) r.addEventListener("change", () => { if (state.items.length) run("options"); });
for (const k of ["prefer", "count"]) $(k).addEventListener("change", () => { if (state.result) run(state.result.kind); });

$("opts").addEventListener("click", (e) => {
  const b = e.target.closest("[data-k]");
  if (!b) return;
  state.active = +b.dataset.k;
  showResult();
});

$("allBody").addEventListener("change", (e) => {
  const i = e.target.dataset.i;
  if (i == null) return;
  state.items[+i].use = e.target.value;
  clearResult(); renderAll();
});
$("resetAll").addEventListener("click", () => {
  state.items.forEach((x) => (x.use = x.dup ? "never" : "auto"));
  clearResult(); renderAll();
});
$("search").addEventListener("input", (e) => { state.search = e.target.value; renderAll(); });

$("copyList").addEventListener("click", (e) => copy(currentSelection().items.map((x) => x.id).join("\n"), e.currentTarget));
$("copyTable").addEventListener("click", (e) => copy(resultTsv(), e.currentTarget));
$("download").addEventListener("click", downloadXlsx);


// ---------- reset ----------
/** Drop every loaded file, result and setting, as if the page had just been opened. */
function resetEverything(settingsToo = true) {
  resetGen++;
  cancelJob();
  if (worker) { worker.terminate(); worker = null; }
  cancelJob = () => {};
  Object.assign(state, { files: [], sheet: "", header: [], items: [], skipped: [], result: null, active: 0, search: "" });
  $("file").value = "";
  $("search").value = "";
  $("copyFallback").value = "";
  for (const k of ["colId", "colAmt", "colDate", "sheet"]) $(k).innerHTML = "";
  $("cols").hidden = true;
  $("sheetField").hidden = true;
  if (settingsToo) {
    $("limit").value = DEFAULTS.limit;
    document.querySelector(`input[name=mode][value="${DEFAULTS.mode}"]`).checked = true;
    $("prefer").value = DEFAULTS.prefer;
    $("count").value = DEFAULTS.count;
    document.querySelector("details.more").open = false;
  }
  renderFiles();
  clearResult();
  $("resBody").innerHTML = `<tr><td colspan="4" class="empty">Učitajte datoteku i kliknite Izračunaj.</td></tr>`;
  renderAll();
  setBusy(false);
  for (const k of ["run", "batches", "resetAll", "search"]) $(k).disabled = true;
  say(`Nemate datoteku pri ruci? <button type="button" class="link" id="loadSample">Učitaj primjer</button>`);
}
$("reset").addEventListener("click", () => { resetEverything(); $("file").focus(); });
// Back/forward cache can restore the page with the old invoices still in memory: start clean instead.
window.addEventListener("pageshow", (e) => { if (e.persisted) resetEverything(); });
resetEverything();
