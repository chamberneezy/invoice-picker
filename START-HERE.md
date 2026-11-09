# START HERE: taking this over in Claude Code

## Files in this handoff

| File | What it is |
|---|---|
| `SPEC.md` | Full requirements, algorithm, sample data and acceptance tests. Enough to build the tool from scratch. |
| `CLAUDE.md` | Project memory for Claude Code: context, conventions and the prioritized roadmap. Claude Code reads it automatically. |
| `README.md` | Public description of the repo, how to run it, test it and deploy it. |
| `START-HERE.md` | This file. |

If you also have the full `invoice-picker` folder, it contains a working, tested v1 (`index.html`, `js/`, `css/`, `tests/`, the GitHub Pages workflow and the sample `.xlsx`).

## Step 1: Create the repo

```bash
# if you have the full folder:
cd invoice-picker
git init -b main            # skip if .git already exists
git add -A && git commit -m "Invoice picker v1"
gh repo create invoice-picker --private --source . --push
# (or create the repo on github.com and: git remote add origin <url> && git push -u origin main)

# if you only have the .md files: create an empty repo, put the 4 .md files in it,
# and add docs/original-request.png plus your Excel file under sample/.
```

## Step 2: Turn on GitHub Pages

On GitHub, open the repo's **Settings → Pages → Source** and choose **GitHub Actions**. After the first push, the site will be at `https://<your-user>.github.io/invoice-picker/`.

> GitHub Pages on a **private** repo needs a paid GitHub plan (Pro, Team or Enterprise). On a free account, make the repo public. That's safe here: the code holds no data, and Excel files are processed only in the visitor's browser. The sample file in `sample/` *is* published, so swap in an anonymized one if needed.

## Step 3: Open Claude Code in the repo and paste a prompt

**If you have the full folder (v1 already built):**

```
Read CLAUDE.md, SPEC.md and README.md. This is a working v1 of an invoice-picker web tool.
Run `npm test` and confirm it passes. Then work through "Recommended next steps" in CLAUDE.md
in order, starting with 1–4 (vendor the latest SheetJS from cdn.sheetjs.com into js/vendor/,
self-host or drop Google Fonts, add a CSP, add Playwright e2e tests to CI using the acceptance
table in SPEC.md §6). Keep money in integer cents and keep solver.js / parse.js pure.
Commit after each step. Before building anything from item 5, ask me.
```

**If you only have the .md files (build from scratch):**

```
Read SPEC.md and CLAUDE.md. Build the invoice-picker exactly as specified: a static site
(index.html, css/, js/solver.js, js/parse.js, js/worker.js, js/app.js), node:test unit tests
in tests/, a GitHub Actions workflow that runs the tests and deploys to GitHub Pages, and
sample/ containing my Excel file. All acceptance tests in SPEC.md §6 must pass. The UI is
in Croatian, the code in English, money in integer cents. Then continue with "Recommended
next steps" in CLAUDE.md and ask me before item 5.
```

## Step 4: Check it online

1. Open the Pages URL and click **Učitaj primjer**.
2. Enter **190** and click **Izračunaj**. It should show **186,20** across 7 invoices.
3. Enter **1000**. It should show **928,40**.
4. Upload a real, larger report and check that the result and the `.xlsx` download look right.

## Questions to settle with the end user (they shape the next features)

- When several combinations reach the same total, which should win: fewer invoices, or the oldest ones (`Datum primitka`) first?
- Do they need repeated batches (pick for 1000 €, remove those invoices, pick the next 1000 €)?
- Which extra columns should appear in the result and export (date, HZZO invoice number, urudžbeni broj)?
- Should the site be public, or restricted to the practice?
