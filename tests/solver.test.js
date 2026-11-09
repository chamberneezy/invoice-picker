import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, findOptions, splitBatches, gcd, MODES, PREFER } from "../js/solver.js";

// Amounts from sample/InvoicesLiqudatedReport-sample.xlsx, in cents
const SAMPLE = [2660, 2660, 2660, 2660, 2660, 74220, 2660, 2660, 67986, 55116, 74220];
const sumOf = (amounts, idx) => idx.reduce((s, i) => s + amounts[i], 0);

function rng(seed) {
  return () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

/** Brute force: every subset -> per distinct total keep min/max invoice count. */
function brute(amounts, target, mode, required = []) {
  const n = amounts.length;
  const reqMask = required.reduce((m, i) => m | (1 << i), 0);
  const totals = new Map(); // total -> {min, max}
  for (let mask = 0; mask < 1 << n; mask++) {
    if ((mask & reqMask) !== reqMask) continue;
    let s = 0, c = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { s += amounts[i]; c++; }
    const e = totals.get(s);
    if (!e) totals.set(s, { min: c, max: c });
    else { e.min = Math.min(e.min, c); e.max = Math.max(e.max, c); }
  }
  const rank = (s) =>
    mode === "under" ? (s <= target ? target - s : Infinity)
    : mode === "over" ? (s >= target ? s - target : Infinity)
    : Math.abs(s - target) * 2 + (s > target ? 1 : 0);
  return [...totals.entries()]
    .filter(([s]) => rank(s) !== Infinity)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0] - b[0])
    .map(([total, c]) => ({ total, ...c }));
}

function checkAgainstBrute(amounts, target, opts, label) {
  const res = findOptions(amounts, target, opts);
  const ref = brute(amounts, target, opts.mode, opts.required);
  const count = opts.count ?? 1;
  const req = new Set(opts.required ?? []);

  for (const o of res.options) {
    assert.equal(o.total, sumOf(amounts, o.indexes), `${label}: total matches indexes`);
    assert.equal(new Set(o.indexes).size, o.indexes.length, `${label}: each invoice once`);
    for (const i of req) assert.ok(o.indexes.includes(i), `${label}: required ${i} included`);
    assert.equal(o.diff, o.total - target);
  }
  if (!res.exact) {
    // approximate: must still be valid for the mode
    if (ref.length) assert.ok(res.options.length >= 1, `${label}: approx found something`);
    return res;
  }
  if (res.method === "trivial") {
    if (ref.length) assert.equal(res.options[0]?.total, ref[0].total, `${label}: trivial best`);
    else assert.equal(res.options.length, 0, `${label}: trivial none`);
    return res;
  }
  const want = ref.slice(0, count).map((r) => r.total);
  assert.deepEqual(res.options.map((o) => o.total), want, `${label}: top ${count} totals (${res.method})`);
  if (res.tieBreakExact && opts.prefer === "fewest") {
    res.options.forEach((o, k) => assert.equal(o.indexes.length, ref[k].min, `${label}: fewest count`));
  }
  if (res.tieBreakExact && opts.prefer === "most") {
    res.options.forEach((o, k) => assert.equal(o.indexes.length, ref[k].max, `${label}: most count`));
  }
  return res;
}

// ---------- acceptance table (SPEC §6) ----------

test("acceptance: limit 190 picks all seven 26,60 invoices = 186,20", () => {
  const { indexes, total } = solve(SAMPLE, 19000);
  assert.equal(total, 18620);
  assert.equal(indexes.length, 7);
  assert.ok(indexes.every((i) => SAMPLE[i] === 2660));
});

test("acceptance: 1000 -> 928,40; 1500 -> 1.484,40; 3000 -> all 11; 1 -> none", () => {
  assert.equal(solve(SAMPLE, 100000).total, 92840);
  const r1500 = solve(SAMPLE, 150000);
  assert.equal(r1500.total, 148440);
  assert.deepEqual(r1500.indexes.map((i) => SAMPLE[i]), [74220, 74220]);
  const all = solve(SAMPLE, 300000);
  assert.equal(all.total, 290162);
  assert.equal(all.indexes.length, 11);
  assert.deepEqual(solve(SAMPLE, 100), { indexes: [], total: 0 });
});

// ---------- modes ----------

test("mode over: smallest total that reaches 1000 is 1.231,02", () => {
  const r = findOptions(SAMPLE, 100000, { mode: "over" });
  assert.equal(r.options[0].total, 123102);
  assert.equal(r.options[0].diff, 23102);
});

test("mode over: impossible when everything together is below target", () => {
  assert.deepEqual(findOptions(SAMPLE, 300000, { mode: "over" }).options, []);
});

test("mode closest: picks the nearer side, under wins a tie", () => {
  assert.equal(findOptions(SAMPLE, 100000, { mode: "closest" }).options[0].total, 92840);
  assert.equal(findOptions(SAMPLE, 120000, { mode: "closest" }).options[0].total, 123102);
  // 10 and 20: target 15 is 5 away from both -> under wins
  assert.equal(findOptions([1000, 2000], 1500, { mode: "closest" }).options[0].total, 1000);
});

test("several options with distinct totals, best first", () => {
  const r = findOptions(SAMPLE, 19000, { count: 4 });
  assert.deepEqual(r.options.map((o) => o.total), [18620, 15960, 13300, 10640]);
});

// ---------- tie-breaks ----------

test("prefer fewest / most when totals tie", () => {
  // 30 can be 30, 10+20, or 5+5+20 / 5+5+10+10 ...
  const a = [500, 500, 1000, 1000, 2000, 3000];
  const few = findOptions(a, 3000, { prefer: "fewest" }).options[0];
  assert.equal(few.total, 3000);
  assert.equal(few.indexes.length, 1);
  const most = findOptions(a, 3000, { prefer: "most" }).options[0];
  assert.equal(most.total, 3000);
  assert.equal(most.indexes.length, 4);
});

test("prefer order: earliest invoices win (caller passes oldest first)", () => {
  // three equal invoices, need two -> the first two
  assert.deepEqual(findOptions([2660, 2660, 2660], 5320).options[0].indexes, [0, 1]);
  // 1+2 vs 3: set whose newest invoice is oldest -> [0,1]
  assert.deepEqual(findOptions([100, 200, 300], 300).options[0].indexes, [0, 1]);
});

// ---------- required ----------

test("required invoices are always included", () => {
  const r = findOptions(SAMPLE, 100000, { required: [8] }); // 679,86 forced
  assert.ok(r.options[0].indexes.includes(8));
  assert.equal(r.options[0].total, 67986 + 2660 * 7 + 0); // 866,06
  assert.equal(r.requiredTotal, 67986);
});

test("required invoices already over the limit -> no option in 'under'", () => {
  const r = findOptions(SAMPLE, 100000, { required: [5, 11 - 1] }); // 742,20 + 742,20
  assert.deepEqual(r.options, []);
});

// ---------- randomized cross-check over every path ----------

const PATHS = {
  dp: {},
  "dp, tiny decision-bit budget (tie-break fallback)": { maxBits: 1 },
  "forced mitm": { maxCells: 1 },
  "forced approx": { maxCells: 1, mitmMax: 0 },
};

for (const [name, limits] of Object.entries(PATHS)) {
  test(`randomized vs brute force: ${name}`, () => {
    const rnd = rng(name.length * 7919);
    for (let t = 0; t < 150; t++) {
      const n = 1 + Math.floor(rnd() * 12);
      const small = rnd() < 0.5;
      const amounts = Array.from({ length: n }, () => 1 + Math.floor(rnd() * (small ? 40 : 100000)) * (small ? 50 : 1));
      const total = amounts.reduce((a, b) => a + b, 0);
      const target = Math.floor(rnd() * total * 1.1);
      const mode = MODES[t % 3];
      const prefer = PREFER[Math.floor(t / 3) % 3];
      const count = 1 + (t % 4);
      const required = rnd() < 0.25 ? [Math.floor(rnd() * n)] : [];
      checkAgainstBrute(amounts, target, { mode, prefer, count, required, limits }, `${name} #${t}`);
    }
  });
}

test("complement DP is used when the target is close to the grand total", () => {
  const amounts = Array.from({ length: 60 }, (_, i) => 100_000 + i * 997); // ~ 78.000 EUR total
  const total = amounts.reduce((a, b) => a + b, 0);
  const r = findOptions(amounts, total - 250_000, { count: 3 });
  assert.equal(r.method, "dp-complement");
  assert.ok(r.exact);
  assert.ok(r.options[0].total <= total - 250_000);
  // optimum = leave out the smallest set >= 2.500,00: two invoices with
  // 997*(i+j) >= 50.000, i.e. i+j = 51 -> 200.000 + 51*997 = 250.847
  assert.equal(r.options[0].total, total - 250_847);
});

test("huge target with <= 40 invoices is solved exactly by meet-in-the-middle", () => {
  const rnd = rng(7);
  const amounts = Array.from({ length: 30 }, () => 1 + Math.floor(rnd() * 900_000_000));
  const target = Math.floor(amounts.reduce((a, b) => a + b, 0) / 2);
  const t0 = Date.now();
  const r = findOptions(amounts, target, { count: 3 });
  assert.equal(r.method, "mitm");
  assert.ok(r.exact);
  assert.ok(r.options[0].total <= target);
  assert.ok(target - r.options[0].total < 1000, "near-exact on random big amounts");
  assert.ok(Date.now() - t0 < 5000);
});

test("huge target with many invoices falls back to a flagged approximation", () => {
  const rnd = rng(11);
  const amounts = Array.from({ length: 400 }, () => 1 + Math.floor(rnd() * 10_000_000));
  const total = amounts.reduce((a, b) => a + b, 0);
  const target = Math.floor(total * 0.5) + 1;
  const r = findOptions(amounts, target);
  assert.equal(r.method, "approx");
  assert.equal(r.exact, false);
  const got = r.options[0].total;
  assert.ok(got <= target);
  assert.ok(target - got < 100, `gap ${target - got} cents`);
});

test("performance: 300 invoices with a 10.000 EUR limit < 1 s, also with fewest tie-break", () => {
  const amounts = Array.from({ length: 300 }, (_, i) => 1000 + ((i * 7919) % 90000));
  for (const prefer of ["order", "fewest"]) {
    const t0 = Date.now();
    const r = findOptions(amounts, 1_000_000, { prefer, count: 5 });
    assert.ok(r.options[0].total <= 1_000_000);
    assert.ok(Date.now() - t0 < 1000, `${prefer}: ${Date.now() - t0} ms`);
  }
});

// ---------- batches ----------

test("splitBatches: consecutive batches each <= limit, every invoice used once", () => {
  const { batches, leftover, exact } = splitBatches(SAMPLE, 100000);
  assert.ok(exact);
  assert.equal(batches[0].total, 92840);
  const seen = new Set();
  for (const b of batches) {
    assert.ok(b.total <= 100000 && b.total > 0);
    assert.equal(b.total, sumOf(SAMPLE, b.indexes));
    for (const i of b.indexes) { assert.ok(!seen.has(i)); seen.add(i); }
  }
  for (const i of leftover) { assert.ok(!seen.has(i)); seen.add(i); }
  assert.equal(seen.size, SAMPLE.length);
});

test("splitBatches: invoices larger than the limit stay in leftover", () => {
  const { batches, leftover } = splitBatches([5000, 100, 200], 1000);
  assert.deepEqual(batches.map((b) => b.total), [300]);
  assert.deepEqual(leftover, [0]);
});

// ---------- misc ----------

test("rejects invalid input", () => {
  assert.throws(() => solve([100, -5], 1000), RangeError);
  assert.throws(() => solve([100, 0], 1000), RangeError);
  assert.throws(() => solve([10.5], 1000), RangeError);
  assert.throws(() => solve([100], -1), RangeError);
  assert.throws(() => findOptions([100], 10, { mode: "nope" }), RangeError);
  assert.throws(() => findOptions([100], 10, { required: [3] }), RangeError);
});

test("empty input", () => {
  assert.deepEqual(solve([], 1000), { indexes: [], total: 0 });
});

test("gcd", () => {
  assert.equal(gcd(2660, 74220), 20);
  assert.equal(gcd(0, 5), 5);
});
