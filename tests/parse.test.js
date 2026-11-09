import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAmount, detectDecimal, parseDate, formatDay, findHeaderRow, guessColumns, buildItems, findDuplicates, formatCents,
} from "../js/parse.js";

test("parseAmount handles the formats seen in HZZO/Excel exports", () => {
  const cases = [
    [26.6, 2660], ["26.60", 2660], ["26,60", 2660], ["742.20", 74220],
    ["1.234,56", 123456], ["1,234.56", 123456], ["1 234,56 €", 123456], ["1234", 123400],
    ["1.234.567", 123456700], ["1,234,567", 123456700], ["0,1", 10], ["EUR 15,00", 1500],
    [0.1 + 0.2, 30], ["1'234.56", 123456], ["1 234,56", 123456], ["€1,234.56", 123456],
    ["-5,00", -500], ["−5,00", -500], ["(5,00)", -500], ["5,00-", -500], [".5", 50],
  ];
  for (const [input, expected] of cases) assert.equal(parseAmount(input), expected, String(input));
});

test("parseAmount returns null for empty or text", () => {
  for (const v of [null, undefined, "", " ", "abc", "12a", " - ", "Ukupno", true, new Date()]) {
    assert.equal(parseAmount(v), null, String(v));
  }
});

test("parseAmount resolves 1.234 with a column decimal hint", () => {
  assert.equal(parseAmount("1.234"), 123);            // default: decimal (HZZO style)
  assert.equal(parseAmount("1.234", ","), 123400);    // column uses comma decimals -> thousands
  assert.equal(parseAmount("1,234", "."), 123400);
  assert.equal(parseAmount("1,234", ","), 123);
  assert.equal(parseAmount("26.60", ","), 2660);      // unambiguous stays as is
});

test("detectDecimal reads the column's convention", () => {
  assert.equal(detectDecimal(["26.60", "742.20", "1.234"]), ".");
  assert.equal(detectDecimal(["26,60", "1.234", "1.234,50"]), ",");
  assert.equal(detectDecimal([26.6, 100]), undefined);
  assert.equal(detectDecimal(["1.234"]), undefined);
});

test("parseDate handles Croatian, ISO, Excel serial and Date values", () => {
  const nov6 = Date.UTC(2026, 10, 6) / 86_400_000;
  for (const v of ["06.11.2026", "06.11.2026.", "6.11.2026 10:22", "2026-11-06", "06/11/2026", 46332, new Date(2026, 10, 6)]) {
    assert.equal(parseDate(v), nov6, String(v));
  }
  for (const v of ["", "31.02.2026", "abc", 12, "26.60"]) assert.equal(parseDate(v), null, String(v));
  assert.equal(formatDay(nov6), "06.11.2026.");
});

const HEADER = ["Tip računa", "Vrsta obveze", "Datum primitka", "Šifra ustanove", "Naziv ustanove", "Medicinska djelatnost",
  "Status", "Broj računa HZZO:", "Broj računa - ZU:", "Broj eRačuna OZO", "Broj eRačuna DZO", "Ukupan iznos", "Urudžbeni broj", "Status prebacivanja:"];

test("guessColumns picks ZU number, 'Ukupan iznos' and 'Datum primitka' from the real report header", () => {
  assert.deepEqual(guessColumns(HEADER), { id: 8, amount: 11, date: 2 });
});

test("guessColumns falls back on header names", () => {
  assert.deepEqual(guessColumns(["Invoice", "Amount"]), { id: 0, amount: 1, date: -1 });
  assert.deepEqual(guessColumns(["a", "b", "c"]), { id: 0, amount: 2, date: -1 });
});

test("guessColumns uses cell contents when headers are unknown", () => {
  const header = ["A", "B", "C", "D"];
  const sample = [
    ["x", "R-1", "01.10.2026", "26.60"],
    ["x", "R-2", "02.10.2026", "742.20"],
    ["x", "R-3", "03.10.2026", "12.00"],
  ];
  assert.deepEqual(guessColumns(header, sample), { id: 1, amount: 3, date: 2 });
});

test("findHeaderRow skips title rows above the header", () => {
  const rows = [["Izvještaj"], [""], HEADER, ["x"]];
  assert.equal(findHeaderRow(rows), 2);
  assert.equal(findHeaderRow([["a", "b"]]), 0);
  // no known keywords: first texty row followed by an amount
  assert.equal(findHeaderRow([["Report 2026"], ["Doc", "Value"], ["R-1", "12,50"]]), 1);
});

test("buildItems keeps Excel row numbers, dates and skips bad rows with reasons", () => {
  const data = [
    ["A-1", "26.60", "06.11.2026"],
    ["", "", ""],
    ["A-2", "", ""],
    ["A-3", "-5,00", ""],
    ["A-4", 742.2, ""],
    ["A-5", "0,00", ""],
  ];
  const { items, skipped } = buildItems(data, 0, { id: 0, amount: 1, date: 2 }, { source: "f.xlsx" });
  assert.deepEqual(items.map((x) => [x.row, x.id, x.cents, x.source]), [[2, "A-1", 2660, "f.xlsx"], [6, "A-4", 74220, "f.xlsx"]]);
  assert.equal(items[0].day, parseDate("06.11.2026"));
  assert.equal(items[1].day, null);
  assert.deepEqual(skipped.map((s) => [s.row, s.reason]), [[4, "no amount"], [5, "negative"], [7, "zero"]]);
});

test("buildItems keeps the v1 signature working", () => {
  const { items } = buildItems([["A-1", "26.60"]], 0, 0, 1);
  assert.equal(items[0].cents, 2660);
});

test("buildItems drops a trailing totals row", () => {
  const data = [["A", "10,00"], ["B", "20,00"], ["C", "5,00"], ["Ukupno", "35,00"]];
  const { items, skipped } = buildItems(data, 0, { id: 0, amount: 1 });
  assert.equal(items.length, 3);
  assert.equal(skipped[0].reason, "total row");
  // labelled total that does not match (credit notes were in the column)
  const r2 = buildItems([["A", "", "10,00"], ["B", "", "-5,00"], ["", "Ukupno:", "5,00"]], 0, { id: 0, amount: 2 });
  assert.deepEqual(r2.items.map((x) => x.id), ["A"]);
  // unlabelled row equal to the sum and without a number
  const r3 = buildItems([["A", "10,00"], ["B", "20,00"], ["", "30,00"]], 0, { id: 0, amount: 1 });
  assert.equal(r3.items.length, 2);
  // a real invoice that happens to equal the sum above stays
  const r4 = buildItems([["A", "10,00"], ["B", "20,00"], ["C", "30,00"]], 0, { id: 0, amount: 1 });
  assert.equal(r4.items.length, 3);
});

test("buildItems reads 1.234 as thousands when the column uses comma decimals", () => {
  const { items } = buildItems([["A", "1.234"], ["B", "26,60"], ["C", "5,50"]], 0, { id: 0, amount: 1 });
  assert.deepEqual(items.map((x) => x.cents), [123400, 2660, 550]);
});

test("findDuplicates flags repeated id+amount pairs", () => {
  const items = [{ id: "A", cents: 1 }, { id: "B", cents: 1 }, { id: "A", cents: 1 }, { id: "A", cents: 2 }, { id: "", cents: 1 }, { id: "", cents: 1 }];
  assert.deepEqual(findDuplicates(items), [items[2]]);
});

test("formatCents uses Croatian formatting", () => {
  assert.equal(formatCents(18620), "186,20");
  assert.equal(formatCents(123456789), "1.234.567,89");
  assert.equal(formatCents(5), "0,05");
  assert.equal(formatCents(-380), "-3,80");
});
