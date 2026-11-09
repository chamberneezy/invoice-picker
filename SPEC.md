# SPEC: Odabir računa do limita (Invoice picker)

This spec is self-contained, so the tool can be built from it even without the existing code.

## 1. Problem

A Croatian healthcare practice exports an invoice report from the HZZO system (`InvoicesLiqudatedReport-<date>.xlsx`). The user needs:

> Given a **limit** (e.g. 1000 €), find the **set of invoices whose total is as close as possible to the limit without exceeding it**, and list those invoice numbers.

Example from the user: with the limit **190 €**, the answer is all seven invoices of 26,60 €, which total **186,20 €**.

This is the **0/1 subset-sum** problem. The answer must be **exact** (the best possible total), not a greedy approximation.

## 2. Input file

- Formats: `.xlsx` (main), `.xls`, `.csv`. Use the first sheet.
- Real header (row 1):
  `Tip računa | Vrsta obveze | Datum primitka | Šifra ustanove | Naziv ustanove | Medicinska djelatnost | Status | Broj računa HZZO: | Broj računa - ZU: | Broj eRačuna OZO | Broj eRačuna DZO | Ukupan iznos | Urudžbeni broj | Status prebacivanja:`
- **Invoice number column:** `Broj računa - ZU:` (e.g. `699/955395534/2026`)
- **Amount column:** `Ukupan iznos`. In the real export this is **text** with a dot decimal (`"26.60"`, `"742.20"`).
- Detect the header row automatically (the first of the first 15 rows that mentions `iznos` or `broj računa`). Let the user change both columns from dropdowns.

### Sample data (the attached file, 11 invoices)

| Row | Broj računa - ZU | Ukupan iznos |
|---|---|---|
| 2 | 699/955395534/2026 | 26.60 |
| 3 | 698/955395534/2026 | 26.60 |
| 4 | 695/955395534/2026 | 26.60 |
| 5 | 696/955395534/2026 | 26.60 |
| 6 | 697/955395534/2026 | 26.60 |
| 7 | 705/955395534/2026 | 742.20 |
| 8 | 700/955395534/2026 | 26.60 |
| 9 | 701/955395534/2026 | 26.60 |
| 10 | 702/955395534/2026 | 679.86 |
| 11 | 703/955395534/2026 | 551.16 |
| 12 | 704/955395534/2026 | 742.20 |

## 3. Amount parsing (into integer cents)

| Input | Cents |
|---|---|
| `26.6` (number) | 2660 |
| `"26.60"`, `"26,60"` | 2660 |
| `"1.234,56"`, `"1,234.56"`, `"1 234,56 €"` | 123456 |
| `"1.234.567"`, `"1,234,567"` | 123456700 |
| `""`, `"abc"`, `" - "` | null (skip the row) |

Rules: when both `,` and `.` are present, the one that comes last is the decimal separator. Several of the same separator means thousands separators. Skip rows with an empty, zero or negative amount, and tell the user which Excel row numbers were skipped.

**Always calculate in integer cents. Never sum floats.**

## 4. Algorithm

```
solve(amounts[] (cents, >0 ints), limit (cents)) -> { indexes[], total }

if sum(amounts) <= limit: return all
g = gcd(all amounts); L = floor(limit / g); w[i] = amounts[i] / g
by = Int32Array(L+1); by[0] = -1        // 0 = unreachable, i+1 = invoice that first reached this sum
hi = 0
for i in 0..n-1:
    if w[i] > L: continue
    top = min(L, hi + w[i])
    for s = top down to w[i]:
        if by[s] == 0 and by[s - w[i]] != 0: by[s] = i + 1
    hi = max(hi, top)
    if by[L] != 0: break                // exact hit
s = largest s <= L with by[s] != 0
while s > 0: i = by[s] - 1; pick i; s -= w[i]
```

Scanning `s` from high to low means each invoice is used at most once. The cost is O(n·L) time and O(L) memory. Refuse inputs where L > 60,000,000 and show a clear message. Run the solver in a **Web Worker** so the UI doesn't freeze.

## 5. UI (Croatian)

- Title: **Odabir računa do limita**
- File upload by picker and drag-and-drop, plus an **"Učitaj primjer"** link that loads `sample/*.xlsx`.
- Limit input in EUR (accepts `190`, `1000,00`, `1.000,00`). The button is **Izračunaj**, and Enter also runs it.
- Summary: **Zbroj odabranih**, **Do limita ostaje**, **Odabrano računa**, **Ukupno u datoteci**.
- **Rezultat** table: #, Broj računa, Iznos (EUR), and a total row. Buttons:
  - **Kopiraj brojeve**: copies the invoice numbers, one per line.
  - **Kopiraj za Excel**: copies a TSV table that includes a total row.
  - **Preuzmi .xlsx**: downloads a sheet "Odabrani računi" with the columns Broj računa / Iznos / Red u izvornoj datoteci, followed by Ukupno, Limit and Do limita ostaje.
- **Svi računi** table: a checkbox to exclude an invoice, the Excel row number, the invoice number and the amount. Selected invoices are highlighted.
- Show amounts in Croatian format (`1.234,56`) using a monospace, tabular font.
- Responsive down to 390 px with no horizontal scroll. Light and dark theme.
- **Privacy: the file is processed only in the browser and is never uploaded.** Say this on the page.

## 6. Acceptance tests

| Limit | Expected total | Expected invoices |
|---|---|---|
| 190 | **186,20** | the 7 invoices of 26,60 |
| 1000 | **928,40** | 742,20 + 7 × 26,60 |
| 1500 | **1.484,40** | 742,20 + 742,20 |
| 3000 | **2.901,62** | all 11 |
| 1 | 0,00 | none ("Svaki račun je veći od limita.") |

Also required:
- A randomized test (200 cases, up to 14 invoices) where the solver's total equals a brute-force check every time.
- A performance check: 300 invoices with a 10.000 € limit finishes in under 1 s.

## 7. Hosting

A static site on GitHub Pages, deployed by GitHub Actions on push to `main` after the tests pass. No backend.

## 8. v2 additions

- **Modes**: `under` (total ≤ amount, max), `closest` (min |total − amount|; a tie goes to the total under), `over` (total ≥ amount, min).
- **Options**: up to N (1/3/5/10) best combinations with *distinct* totals, ranked by the mode.
- **Tie-break** for equal totals: older invoices first (sort by the date column), fewest invoices, or most invoices.
- **Per-invoice state**: auto / always / never. If the "always" invoices alone exceed the amount in `under` mode, show an explanation instead of a result.
- **Batches**: repeatedly take the best `under` subset of what is left. Invoices bigger than the amount are listed as leftovers.
- **Scale**: exact for any amount with up to 40 invoices, and for up to about 600.000 € (or totals within about 600.000 € of the grand total) with any number of invoices. Beyond that the result is approximate and labelled as such.
- **Input**: several files merged (columns matched by header name), sheet picker, duplicates (same number and amount) excluded, negative/zero/empty amounts reported, trailing total row dropped.

Additional acceptance tests (sample file):

| Amount | Mode | Expected |
|---|---|---|
| 1000 | over | **1.231,02** (679,86 + 551,16) |
| 1200 | closest | **1.231,02** (+31,02) |
| 190 | under, 5 options | 186,20 · 159,60 · 133,00 · 106,40 · 79,80 |
| 1000 | under, 679,86 always | **866,06** |
| 1000 | batches | 928,40 · 742,20 · 679,86 · 551,16 |
