# CLAUDE.md: handoff notes

## What this is

A tool for a Croatian healthcare practice (orthodontist) that reconciles invoices with HZZO (the Croatian Health Insurance Fund). The user exports `InvoicesLiqudatedReport-<date>.xlsx` from the HZZO system. They need to find **which invoices add up to an amount as close as possible to a given limit without exceeding it**, and get the list of those invoice numbers.

The original request is in `docs/original-request.png` (a chat in Croatian/Kajkavian). In English:
> "Invoice number (ZU) and total amount. Now, for example, I need to find the sum of those invoices closest to 1000 EUR. These are small amounts because I don't have an example with bigger ones, which is what I'll mostly use it for. Let's say the sum must not be greater than 190. In that example, when you add up all invoices of 26,60 you get 186. And then it should write those invoices in the result."

**Goal for the next phase: make this reliably usable online.** The owner considers this very important.

## Current state (v2)

- A static site with no build step, deployed to GitHub Pages by `.github/workflows/deploy.yml` after the unit and e2e tests pass.
- `js/solver.js` has `findOptions(amounts, target, {mode, count, prefer, required})` with:
  - modes `under`, `closest` and `over`;
  - several options with distinct totals;
  - tie-breaks `order` (oldest first), `fewest` and `most`;
  - forced invoices via `required`.
  The strategy is picked automatically: DP, complement DP, meet-in-the-middle for 40 or fewer invoices, or a flagged approximation. `splitBatches()` does repeated batches. `solve()` keeps the v1 API.
- `js/parse.js` handles amounts in every common locale (with a per-column decimal-separator hint), dates (Croatian, ISO, Excel serial), header-row detection, column guessing from header names *and* cell contents, dropping a trailing total row, and duplicate detection.
- `js/app.js` covers a **Počni ispočetka** reset button (clears files, results and settings and stops any running calculation; it also runs when the browser restores the page from the back/forward cache), several files, a sheet picker, Datum column, Može/Uvijek/Nikad per invoice, an options list, batches, a cancel button for long runs, and an `.xlsx` export with all original columns.
- **Password gate** (`js/auth.js`). The tool stays hidden until the password is entered. `js/auth-hash.js` holds only a PBKDF2-SHA256 hash (600k iterations, random salt), and the password is **never** committed. To change it, run `node scripts/hash-password.mjs 'new' > js/auth-hash.js`. It asks again on every page load. Because GitHub Pages is static, this keeps out people who only have the link; it is not server-side access control, and the repo is public. For real protection, put the site behind a server-side check (for example a Cloudflare Worker with Basic Auth or Cloudflare Access). e2e tests swap in the hash of a test-only password with `page.route`. The page has `noindex`.
- SheetJS 0.20.3 is vendored in `js/vendor/` (sha256 `cc015130…3a6f41`). There are no external requests, and the CSP is `default-src 'self'`.
- `npm test` runs 38 unit tests, including brute-force cross-checks of every mode, tie-break and strategy. `npm run test:e2e` runs 11 Playwright scenarios on desktop and a 390 px phone (22 runs).

Real report columns: `Tip računa, Vrsta obveze, Datum primitka, Šifra ustanove, Naziv ustanove, Medicinska djelatnost, Status, Broj računa HZZO:, Broj računa - ZU:, Broj eRačuna OZO, Broj eRačuna DZO, Ukupan iznos, Urudžbeni broj, Status prebacivanja:`. In the export, amounts are **text** such as `"26.60"`.

## Conventions

- UI text is in Croatian. Code, comments and docs are in English.
- Money is always integer cents internally. Never sum floats.
- Keep `solver.js` and `parse.js` pure, with no DOM, so they stay testable in Node.
- Files must never leave the user's browser unless the owner explicitly decides otherwise. The data is medical billing.
- Nothing is persisted. No localStorage, sessionStorage, IndexedDB or service worker: everything lives in memory for one page view. The owner asked for this. (An old `invoice-picker:settings` localStorage key is deleted on load.)

## Done from the v1 roadmap

Items 1–4 are done: vendored SheetJS, no Google Fonts, CSP, Playwright e2e in CI. Several item-5 features were built with sensible defaults; the owner can still change them:
tie-break (default: older invoices first), batches, the Datum column in the result and every column in the export, several files and sheets, and the "closest" / "at least" modes.

## Open questions for the owner

- Is "older invoices first" the right default tie-break?
- Should batches honour *Uvijek* (put forced invoices into batch 1)? Right now they are ignored for batches.
- Custom domain. Is the client-side password gate enough, or should access be enforced server-side (needs a different host or a proxy)?
- Optional PWA for offline use. This conflicts with the no-caching request, so ask the owner first.

## Commands

```bash
npm test          # unit tests (node:test, no deps)
npm run test:e2e  # Playwright; CHROMIUM_PATH=/usr/local/bin/chromium to reuse a local browser
npm start         # serve on http://localhost:8080
```
