import { test, expect } from "@playwright/test";
import fs from "node:fs";

const errors = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("/");
});
test.afterEach(async ({ page }) => {
  expect(errors, "no console errors / CSP violations").toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(0);
});

async function setLimit(page, v) {
  await page.fill("#limit", v);
  await page.click("#run");
}

test("sample: SPEC acceptance table", async ({ page }) => {
  await page.click("#loadSample");
  await expect(page.locator("#msg")).toContainText("Učitano 11 računa");
  const cases = [["190", "186,20", "7"], ["1000", "928,40", "8"], ["1500", "1.484,40", "2"], ["3000", "2.901,62", "11"]];
  for (const [limit, sum, n] of cases) {
    await setLimit(page, limit);
    await expect(page.locator("#sSum")).toHaveText(sum);
    await expect(page.locator("#sCount")).toHaveText(n);
  }
  await setLimit(page, "1");
  await expect(page.locator("#sSum")).toHaveText("0,00");
  await expect(page.locator("#resBody")).toContainText("Svaki račun je veći od limita.");
});

test("several ranked options; clicking one switches the result", async ({ page }) => {
  await page.click("#loadSample");
  await setLimit(page, "190");
  const opts = page.locator("#opts .opt");
  await expect(opts).toHaveCount(5);
  await expect(opts.nth(0)).toContainText("186,20");
  await expect(opts.nth(1)).toContainText("159,60");
  await opts.nth(1).click();
  await expect(page.locator("#sSum")).toHaveText("159,60");
  await expect(page.locator("#sCount")).toHaveText("6");
  await expect(page.locator("#resTitle")).toHaveText("Prijedlog 2");
});

test("modes: closest and at least", async ({ page }) => {
  await page.click("#loadSample");
  await page.fill("#limit", "1200");
  await page.click("text=najbliži iznosu");
  await expect(page.locator("#sSum")).toHaveText("1.231,02");
  await expect(page.locator("#sDiff")).toHaveText("+31,02");
  await page.click("text=barem iznos");
  await page.fill("#limit", "1000");
  await page.click("#run");
  await expect(page.locator("#sSum")).toHaveText("1.231,02");
  await expect(page.locator("#sDiffLabel")).toHaveText("Iznad cilja");
});

test("Uvijek / Nikad per invoice", async ({ page }) => {
  await page.click("#loadSample");
  // force 679,86 (row 10) in
  await page.locator("#allBody tr", { hasText: "702/955395534/2026" }).locator("select").selectOption("always");
  await setLimit(page, "1000");
  await expect(page.locator("#sSum")).toHaveText("866,06");
  await expect(page.locator("#resBody")).toContainText("702/955395534/2026");
  // exclude both 742,20
  for (const id of ["705/955395534/2026", "704/955395534/2026"]) {
    await page.locator("#allBody tr", { hasText: id }).locator("select").selectOption("never");
  }
  await page.locator("#allBody tr", { hasText: "702/955395534/2026" }).locator("select").selectOption("auto");
  await setLimit(page, "1500");
  await expect(page.locator("#sSum")).toHaveText("1.417,22"); // 679,86 + 551,16 + 7 × 26,60
});

test("export .xlsx contains the selected invoices", async ({ page }) => {
  await page.click("#loadSample");
  await setLimit(page, "190");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
  expect(dl.suggestedFilename()).toMatch(/odabrano-190\.00\.xlsx$/);
  const buf = fs.readFileSync(await dl.path());
  const rows = await page.evaluate((b64) => {
    const wb = XLSX.read(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { type: "array" });
    return { names: wb.SheetNames, rows: XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }) };
  }, buf.toString("base64"));
  expect(rows.names).toEqual(["Odabrani računi", "Svi stupci"]);
  const data = rows.rows.slice(1, 8);
  expect(data.every((r) => r[2] === 26.6)).toBe(true);
  expect(rows.rows.find((r) => r[0] === "Ukupno")[2]).toBeCloseTo(186.2, 2);
});

test("batches: every invoice used once, each batch within the limit", async ({ page }) => {
  await page.click("#loadSample");
  await page.fill("#limit", "1000");
  await page.click("#batches");
  const opts = page.locator("#opts .opt");
  await expect(opts.first()).toContainText("Serija 1: 928,40");
  await expect(page.locator("#optTitle")).toHaveText("Serije do 1.000,00 €");
  const n = await opts.count();
  let total = 0;
  for (let k = 0; k < n; k++) {
    await opts.nth(k).click();
    total += +(await page.locator("#sCount").textContent());
  }
  expect(total).toBe(11);
});

test("CSV with title rows, semicolons, comma decimals and a total line", async ({ page }) => {
  const csv = [
    "Izvještaj o računima;;;",
    ";;;",
    "Datum;Dokument;Partner;Vrijednost",
    "03.10.2026;R-3;A;1.200,00",
    "01.10.2026;R-1;B;300,50",
    "02.10.2026;R-2;C;450,25",
    "04.10.2026;R-4;D;-50,00",
    "02.10.2026;R-2;C;450,25",
    ";Ukupno;;2.350,75",
  ].join("\n");
  await page.setInputFiles("#file", { name: "drugi.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
  await expect(page.locator("#msg")).toContainText("Učitano 4 računa");
  await expect(page.locator("#msg")).toContainText("dupli");
  await expect(page.locator("#msg")).toContainText("negativnim");
  await expect(page.locator("#colAmt")).toHaveValue("3");
  await expect(page.locator("#colId")).toHaveValue("1");
  await expect(page.locator("#colDate")).toHaveValue("0");
  await setLimit(page, "800");
  await expect(page.locator("#sSum")).toHaveText("750,75");
});

test("several files at once are merged", async ({ page }) => {
  const a = "Broj računa;Iznos\nA-1;10,00\nA-2;20,00\n";
  const b = "Broj računa;Iznos\nB-1;30,00\nA-2;20,00\n";
  await page.setInputFiles("#file", [
    { name: "a.csv", mimeType: "text/csv", buffer: Buffer.from(a) },
    { name: "b.csv", mimeType: "text/csv", buffer: Buffer.from(b) },
  ]);
  await expect(page.locator("#files li")).toHaveCount(2);
  await expect(page.locator("#msg")).toContainText("Učitano 4 računa iz 2 datoteke");
  await setLimit(page, "100");
  await expect(page.locator("#sSum")).toHaveText("60,00"); // duplicate A-2 excluded
});

test("large report stays responsive", async ({ page }) => {
  const lines = ["Broj računa;Iznos"];
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 2000; i++) lines.push(`R-${i};${(10 + rnd() * 900).toFixed(2).replace(".", ",")}`);
  await page.setInputFiles("#file", { name: "veliki.csv", mimeType: "text/csv", buffer: Buffer.from(lines.join("\n")) });
  await expect(page.locator("#msg")).toContainText("Učitano 2000 računa");
  await setLimit(page, "25.000,00");
  await expect(page.locator("#sSum")).toHaveText("25.000,00", { timeout: 20_000 });
});

test("reset clears files, results and settings; nothing is stored", async ({ page }) => {
  await page.setInputFiles("#file", "sample/InvoicesLiqudatedReport-sample.xlsx");
  await expect(page.locator("#msg")).toContainText("Učitano 11 računa");
  await page.click("label:has(input[value=closest])");
  await setLimit(page, "190");
  await expect(page.locator("#sSum")).not.toHaveText("–");

  await page.click("#reset");
  await expect(page.locator("#files")).toBeHidden();
  await expect(page.locator("#cols")).toBeHidden();
  await expect(page.locator("#sSum")).toHaveText("–");
  await expect(page.locator("#allBody")).toContainText("Još nema učitanih računa.");
  await expect(page.locator("#run")).toBeDisabled();
  await expect(page.locator("#limit")).toHaveValue("1000");
  await expect(page.locator("input[value=under]")).toBeChecked();
  await expect(page.locator("#loadSample")).toBeVisible();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);

  // the same file can be loaded again straight after a reset
  await page.setInputFiles("#file", "sample/InvoicesLiqudatedReport-sample.xlsx");
  await expect(page.locator("#msg")).toContainText("Učitano 11 računa");
  await setLimit(page, "190");
  await expect(page.locator("#sSum")).toHaveText("186,20");

  // a reload starts empty too
  await page.reload();
  await expect(page.locator("#limit")).toHaveValue("1000");
  await expect(page.locator("#files")).toBeHidden();
});
