# Odabir računa do limita (Invoice picker)

Web tool for picking invoices from Excel reports. Upload one or more reports (for example the HZZO `InvoicesLiqudatedReport-*.xlsx` export), enter an amount, and the tool finds the invoice combinations whose total is best relative to that amount. It lists several ranked options, not just one.

Example with `sample/InvoicesLiqudatedReport-sample.xlsx`:

| Amount | Mode | Best result |
|---|---|---|
| 190,00 € | at most | 7 × 26,60 € = **186,20 €** (3,80 € left) |
| 1.000,00 € | at most | 742,20 € + 7 × 26,60 € = **928,40 €** |
| 1.000,00 € | at least | 679,86 € + 551,16 € = **1.231,02 €** |
| 1.200,00 € | closest | **1.231,02 €** (+31,02 €, nearer than 1.160,08 €) |
| 1.000,00 € | batches | 928,40 € · 742,20 € · 679,86 € · 551,16 € |

## Features

- **Three modes**: total *at most* the amount (*do iznosa*), *closest* to it on either side (*najbliži iznosu*), or *at least* the amount (*barem iznos*).
- **Several options**: up to 10 ranked combinations with different totals, each showing the difference from the amount and the number of invoices. Click one to see it.
- **Tie-breaks**: when several combinations reach the same total, prefer older invoices (by date column), as few invoices as possible, or as many as possible.
- **Per-invoice control**: *Može* (the tool decides), *Uvijek* (must be included) or *Nikad* (excluded).
- **Batches** (*Podijeli sve u serije*): split all invoices into consecutive batches, each as close to the amount as possible without going over.
- **Any report shape**: `.xlsx`, `.xls`, `.ods` or `.csv`; several files at once; any sheet; title rows above the header; columns guessed from header names or, failing that, from cell contents. Handles `26.60`, `26,60`, `1.234,56`, `1,234.56`, `1 234,56 €` and `(5,00)`, and works out per column whether `1.234` means thousands. Dates can be Excel dates, `06.11.2026.` or ISO.
- **Data hygiene**: skips and reports negative (credit-note), zero and empty amounts, drops a trailing *Ukupno* row, and excludes duplicate invoices (same number and amount, e.g. from overlapping exports).
- **Exact results**: the solver always finds the best total. For very large inputs it switches strategy automatically (see below) and labels the result as approximate only in the extreme case where nothing exact fits in memory.
- **Output**: copy invoice numbers, copy a table for Excel, or download `.xlsx` with a short sheet plus every original column. Batches export as a summary sheet and an all-invoices sheet with a batch column.
- **Privacy**: files are processed only in the browser and never uploaded. Everything is self-hosted (no CDN, no web fonts) and locked down with a Content-Security-Policy.
- Croatian UI, light and dark theme, works down to 390 px wide.

## Run locally

ES modules don't load from `file://`, so serve the folder:

```bash
npm start            # python3 -m http.server 8080 -> http://localhost:8080
```

## Test

```bash
npm test             # unit tests, Node >= 18, no dependencies
npm ci && npx playwright install chromium
npm run test:e2e     # browser tests (desktop + 390 px phone)
# or reuse a local Chromium: CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e
```

The unit tests cross-check every mode, tie-break and solver strategy against brute force on random inputs. The e2e tests drive the real page: the SPEC acceptance table, options, modes, Uvijek/Nikad, `.xlsx` export, batches, a messy CSV, merging several files, and a 2.000-invoice report. They also fail on any console error, CSP violation or horizontal scroll.

## Deploy (GitHub Pages)

1. Push to a GitHub repository with `main` as the default branch.
2. In the repository, open **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Each push to `main` runs the unit and e2e tests and then publishes the site to `https://<user>.github.io/<repo>/`.

## How the algorithm works

Choosing invoices is the 0/1 subset-sum problem. All money is integer cents, and amounts are first divided by their greatest common divisor to shrink the problem. `js/solver.js` then picks a strategy automatically:

| Strategy | When | Cost |
|---|---|---|
| **DP** over reachable totals 0…B | the table fits (up to 60 M entries, roughly 600.000 € at 1-cent resolution) | time *n × B*, memory *B* |
| **Complement DP**: solve for the invoices left *out* | the amount is close to the grand total, so the complement table is smaller | time *n × (total − amount)* |
| **Meet in the middle** | up to 40 invoices with any amounts | about 2 × 2²⁰ sums |
| **Approximation**: scaled DP, greedy fill, then swap improvement | many invoices *and* a huge amount; flagged `exact: false` and shown as approximate in the UI | bounded |

Only the window of totals that can matter is computed. The best "at least" total is always below *amount + largest invoice*, and the best "closest" total lies within the largest invoice of the amount on either side. To collect several options, the solver walks outward from the amount through the reachable totals. Tie-breaks work as follows: *older first* comes from processing invoices oldest first and keeping the first way each total was reached. *Fewest* and *most* keep a per-total invoice count, plus one decision bit per (invoice, total), so the exact set can be rebuilt.

## Project layout

```
index.html              page markup (CSP in a meta tag)
css/styles.css          styles (light and dark)
js/solver.js            selection algorithms (pure, tested)
js/parse.js             amount, date and column parsing (pure, tested)
js/worker.js            runs the solver in a Web Worker
js/app.js               UI: files, options, batches, copy, download
js/vendor/              SheetJS 0.20.3 from cdn.sheetjs.com
sample/                 example report (also behind "Učitaj primjer")
tests/                  node:test unit tests
e2e/                    Playwright browser tests
docs/                   original request (screenshot of the chat)
```
