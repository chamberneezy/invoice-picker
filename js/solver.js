/**
 * Invoice selection solver.
 *
 * Pure module (no DOM), all money in integer cents.
 *
 * The core question is subset sum: which invoices add up to a total that is
 * as good as possible relative to a target. "Good" depends on the mode:
 *
 *   under    total <= target, as large as possible         (v1 behaviour)
 *   closest  |total - target| as small as possible, either side (ties: under wins)
 *   over     total >= target, as small as possible
 *
 * Instead of one answer the solver returns up to `count` options with
 * distinct totals, ranked best first, so the user can choose.
 *
 * When several invoice sets reach the same total, `prefer` decides which one
 * is returned:
 *   order    earliest invoices in input order (callers sort oldest first)
 *   fewest   as few invoices as possible
 *   most     as many invoices as possible
 *
 * Invoices can be forced in (`required`); excluded invoices are simply not
 * passed in by the caller.
 *
 * Strategy, picked automatically so every input gets an answer:
 *   1. dp             exact DP over reachable sums 0..B
 *   2. dp-complement  the same DP over the complement (sum of NOT picked
 *                     invoices) when that table is smaller, e.g. a limit close
 *                     to the grand total
 *   3. mitm           exact meet-in-the-middle for up to 40 invoices, any size
 *   4. approx         scaled DP + greedy fill + swap improvement when nothing
 *                     exact fits in memory; flagged with exact: false
 *
 * All amounts are divided by their GCD first, which shrinks the DP table.
 */

export const LIMITS = {
  maxCells: 60_000_000,   // DP table entries (Int32Array -> ~240 MB worst case)
  maxBits: 480_000_000,   // decision bits for fewest/most tie-break (~60 MB)
  mitmMax: 40,            // meet-in-the-middle up to 2^20 sums per half
};

export const MODES = ["under", "closest", "over"];
export const PREFER = ["order", "fewest", "most"];

export function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

const sumOf = (amounts, idx) => idx.reduce((s, i) => s + amounts[i], 0);

/** Ranking key for a total: lower is better, Infinity = not allowed by mode. */
function scorer(mode, target) {
  if (mode === "under") return (s) => (s <= target ? target - s : Infinity);
  if (mode === "over") return (s) => (s >= target ? s - target : Infinity);
  // closest: distance, and on equal distance the total under the target wins
  return (s) => Math.abs(s - target) * 2 + (s > target ? 1 : 0);
}

function validate(amounts, target) {
  if (!Number.isInteger(target) || target < 0) throw new RangeError("target must be a non-negative integer (cents)");
  for (const a of amounts) {
    if (!Number.isInteger(a) || a <= 0) throw new RangeError("amounts must be positive integers (cents)");
  }
}

/**
 * Find the best invoice combinations.
 *
 * @param {number[]} amounts  positive integers (cents)
 * @param {number} target     non-negative integer (cents)
 * @param {object} [opts]
 * @param {"under"|"closest"|"over"} [opts.mode="under"]
 * @param {number} [opts.count=1]          how many options (distinct totals)
 * @param {"order"|"fewest"|"most"} [opts.prefer="order"]
 * @param {number[]} [opts.required=[]]    indexes that must be in every option
 * @param {object} [opts.limits]           override LIMITS (tests)
 * @returns {{
 *   options: {indexes:number[], total:number, diff:number}[],
 *   method: string, exact: boolean, tieBreakExact: boolean, requiredTotal: number
 * }}
 *   diff = total - target. options is empty when the mode cannot be satisfied
 *   (e.g. "under" with required invoices already over the target, or "over"
 *   when even all invoices together stay below the target).
 */
export function findOptions(amounts, target, opts = {}) {
  validate(amounts, target);
  const mode = opts.mode ?? "under";
  const prefer = opts.prefer ?? "order";
  const count = Math.max(1, Math.floor(opts.count ?? 1));
  const limits = { ...LIMITS, ...opts.limits };
  if (!MODES.includes(mode)) throw new RangeError(`unknown mode ${mode}`);
  if (!PREFER.includes(prefer)) throw new RangeError(`unknown prefer ${prefer}`);

  const requiredSet = new Set(opts.required ?? []);
  for (const i of requiredSet) {
    if (!Number.isInteger(i) || i < 0 || i >= amounts.length) throw new RangeError("required index out of range");
  }
  const required = [...requiredSet].sort((a, b) => a - b);
  const requiredTotal = sumOf(amounts, required);

  // Free invoices: everything that is not forced in. Work on them with a
  // shifted target, then add the forced ones back.
  const freeIdx = amounts.map((_, i) => i).filter((i) => !requiredSet.has(i));
  const free = freeIdx.map((i) => amounts[i]);
  const score = scorer(mode, target);

  const inner = solveFree(free, target - requiredTotal, requiredTotal, { mode, prefer, count, limits, score });

  const options = inner.options
    .map((o) => {
      const indexes = [...required, ...o.map((k) => freeIdx[k])].sort((a, b) => a - b);
      const total = sumOf(amounts, indexes);
      return { indexes, total, diff: total - target };
    })
    .filter((o) => score(o.total) !== Infinity);

  return { options, method: inner.method, exact: inner.exact, tieBreakExact: inner.tieBreakExact, requiredTotal };
}

/** Backwards compatible v1 API: best total <= limit. */
export function solve(amounts, limit) {
  const { options } = findOptions(amounts, limit, { mode: "under", count: 1 });
  return options.length ? { indexes: options[0].indexes, total: options[0].total } : { indexes: [], total: 0 };
}

/**
 * Split invoices into consecutive batches, each as close to `limit` as
 * possible without exceeding it. Batch 1 is the best possible single batch,
 * batch 2 the best of what is left, and so on. Invoices bigger than the limit
 * end up in `leftover`.
 */
export function splitBatches(amounts, limit, opts = {}) {
  validate(amounts, limit);
  if (limit <= 0) return { batches: [], leftover: amounts.map((_, i) => i), exact: true };
  let remaining = amounts.map((_, i) => i);
  const batches = [];
  let exact = true;
  const maxBatches = opts.maxBatches ?? Infinity;
  while (remaining.length && batches.length < maxBatches) {
    const sub = remaining.map((i) => amounts[i]);
    const r = findOptions(sub, limit, { mode: "under", count: 1, prefer: opts.prefer, limits: opts.limits });
    exact &&= r.exact;
    const best = r.options[0];
    if (!best || best.total === 0) break;
    const picked = best.indexes.map((k) => remaining[k]);
    batches.push({ indexes: picked, total: best.total });
    const pickedSet = new Set(picked);
    remaining = remaining.filter((i) => !pickedSet.has(i));
  }
  return { batches, leftover: remaining, exact };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Solve on free invoices only. `t` may be negative (forced invoices already
 * past the target). `base` is the forced total, so scoring uses base + sum.
 * Returns options as arrays of indexes into `free`.
 */
function solveFree(free, t, base, ctx) {
  const { mode, prefer, count, limits, score } = ctx;
  const n = free.length;
  const T = free.reduce((s, a) => s + a, 0);
  const rank = (s) => score(base + s);

  // Trivial cases: nothing to choose from, or the window is just {0} or {T}.
  if (n === 0) return { options: [[]], method: "trivial", exact: true, tieBreakExact: true };
  if (t <= 0) {
    // forced invoices already reach the target: adding more only moves away
    return { options: [[]], method: "trivial", exact: true, tieBreakExact: true };
  }
  if (T <= t && mode !== "over") {
    return { options: [free.map((_, i) => i)], method: "trivial", exact: true, tieBreakExact: true };
  }
  if (T < t && mode === "over") return { options: [], method: "trivial", exact: true, tieBreakExact: true };

  const g = free.reduce((acc, a) => gcd(acc, a), 0) || 1;
  const w = free.map((a) => a / g);
  const Tw = T / g;
  const maxW = Math.max(...w);
  const tLo = Math.floor(t / g), tHi = Math.ceil(t / g);

  // Window [a, b] (scaled units) of totals worth knowing. The best "over"
  // total is always < t + maxW (drop any invoice and you fall below t), and
  // the best "closest" total therefore lies within maxW on either side.
  // A little slack beyond that gives room for extra options.
  const slack = maxW * Math.max(1, count);
  let a, b;
  if (mode === "under") { a = Math.max(0, tLo - slack); b = tLo; }
  else if (mode === "over") { a = tHi; b = Math.min(Tw, tHi + slack); }
  else { a = Math.max(0, tLo - slack); b = Math.min(Tw, tHi + slack); }

  const directCells = b + 1;
  const complCells = Tw - a + 1;
  const needBits = prefer !== "order";
  const fits = (cells) => cells <= limits.maxCells;
  const bitsFit = (cells) => n * cells <= limits.maxBits;

  // Prefer the smaller of direct / complement table.
  const plans = [
    { kind: "dp", cells: directCells },
    { kind: "dp-complement", cells: complCells },
  ].sort((x, y) => x.cells - y.cells);

  for (const plan of plans) {
    if (!fits(plan.cells)) continue;
    const useBits = needBits && bitsFit(plan.cells);
    const res = plan.kind === "dp"
      ? dpDirect(w, b, mode === "over" ? a : 0, { prefer: useBits ? prefer : fallbackOrderFor(prefer), count, rank: (s) => rank(s * g), centre: mode === "over" ? tHi : tLo, stopAt: mode === "under" && count === 1 && !useBits ? tLo : -1, useBits, free })
      : dpComplement(w, Tw, a, b, { prefer: useBits ? prefer : fallbackOrderFor(prefer), count, rank: (s) => rank(s * g), centre: mode === "over" ? tHi : tLo, useBits, free });
    return { options: res, method: plan.kind, exact: true, tieBreakExact: !needBits || useBits };
  }

  if (n <= limits.mitmMax) {
    return { options: mitm(free, rank, count, prefer, Math.min(Math.max(t, 0), T)), method: "mitm", exact: true, tieBreakExact: prefer !== "order" };
  }

  return { options: approx(free, t, mode, rank), method: "approx", exact: false, tieBreakExact: false };
}

/**
 * When decision bits do not fit, approximate fewest/most with the "order"
 * DP over a sorted item order: big invoices first tends to give few invoices,
 * small first tends to give many.
 */
function fallbackOrderFor(prefer) {
  return prefer === "fewest" ? "order-big-first" : prefer === "most" ? "order-small-first" : "order";
}

function itemOrder(w, prefer, free) {
  const idx = w.map((_, i) => i);
  if (prefer === "order-big-first") idx.sort((x, y) => free[y] - free[x] || x - y);
  else if (prefer === "order-small-first") idx.sort((x, y) => free[x] - free[y] || x - y);
  return idx;
}

/**
 * Reachability DP over sums 0..B.
 * prefer "order*": by[s] = 1 + position of the item that first reached s.
 *   Walking back gives the set whose latest item (in processing order) is
 *   as early as possible, i.e. with oldest-first input the oldest invoices.
 * prefer "fewest"/"most": cnt[s] = best invoice count reaching s, with one
 *   decision bit per (item, sum) to rebuild the exact set.
 * Returns { reachable(s), rebuild(s) -> indexes }.
 */
function reach(w, B, prefer, order, stopAt, useBits) {
  const n = order.length;
  if (prefer === "fewest" || prefer === "most") {
    if (!useBits) throw new Error("decision bits required");
    // cnt[s] = invoice count (fewest) or minus the count (most), so both
    // are "smaller is better"; UN marks unreachable sums.
    const UN = 0x3fffffff;
    const step = prefer === "most" ? -1 : 1;
    const cnt = new Int32Array(B + 1).fill(UN);
    cnt[0] = 0;
    const stride = B + 1;
    const bits = new Uint8Array(Math.ceil((n * stride) / 8));
    let hi = 0;
    for (let k = 0; k < n; k++) {
      const wi = w[order[k]];
      if (wi > B) continue;
      const top = Math.min(B, hi + wi);
      const base = k * stride;
      for (let s = top; s >= wi; s--) {
        const c = cnt[s - wi];
        if (c !== UN && c + step < cnt[s]) {
          cnt[s] = c + step;
          const bit = base + s;
          bits[bit >> 3] |= 1 << (bit & 7);
        }
      }
      if (top > hi) hi = top;
    }
    return {
      reachable: (s) => s >= 0 && s <= B && cnt[s] !== UN,
      rebuild: (s) => {
        const out = [];
        for (let k = n - 1; k >= 0 && s > 0; k--) {
          const bit = k * stride + s;
          if (bits[bit >> 3] & (1 << (bit & 7))) { out.push(order[k]); s -= w[order[k]]; }
        }
        return out;
      },
    };
  }

  const by = new Int32Array(B + 1);
  by[0] = -1;
  let hi = 0;
  for (let k = 0; k < n; k++) {
    const wi = w[order[k]];
    if (wi > B) continue;
    const top = Math.min(B, hi + wi);
    for (let s = top; s >= wi; s--) {
      if (by[s] === 0 && by[s - wi] !== 0) by[s] = k + 1;
    }
    if (top > hi) hi = top;
    if (stopAt >= 0 && by[stopAt] !== 0) break; // exact hit, cannot do better
  }
  return {
    reachable: (s) => s >= 0 && s <= B && by[s] !== 0,
    rebuild: (s) => {
      const out = [];
      while (s > 0) { const k = by[s] - 1; out.push(order[k]); s -= w[order[k]]; }
      return out;
    },
  };
}

/**
 * Pick the `count` best reachable totals in [a, b]. rank() only gets worse
 * moving away from `centre`, so walk outward from it on both sides and merge,
 * which touches only the part of the table that matters.
 */
function bestTotals(a, b, reachable, rank, count, centre) {
  const out = [];
  let lo = Math.min(Math.max(centre, a - 1), b), hi = lo + 1;
  while (out.length < count) {
    while (lo >= a && !reachable(lo)) lo--;
    while (hi <= b && !reachable(hi)) hi++;
    const rl = lo >= a ? rank(lo) : Infinity;
    const rh = hi <= b ? rank(hi) : Infinity;
    if (rl === Infinity && rh === Infinity) break;
    if (rl <= rh) out.push(lo--); else out.push(hi++);
  }
  return out;
}

function dpDirect(w, b, a, { prefer, count, rank, centre, stopAt, useBits, free }) {
  const order = itemOrder(w, prefer, free);
  const r = reach(w, b, prefer, order, stopAt, useBits);
  // With an early exit only the exact hit is guaranteed reachable, which is
  // the best possible answer, so scanning still returns it first.
  return bestTotals(a, b, r.reachable, rank, count, centre).map((s) => r.rebuild(s).sort((x, y) => x - y));
}

/**
 * Complement DP: a set with total s leaves out a set with total Tw - s.
 * Build reachability for the left-out set over 0..Tw-a, then map back.
 * Tie-breaks are mirrored: fewest picked = most left out, and "oldest
 * first" for the picked set = latest invoices for the left-out set.
 */
function dpComplement(w, Tw, a, b, { prefer, count, rank, centre, useBits, free }) {
  const B = Tw - a;
  const mirrored = { fewest: "most", most: "fewest", order: "order-rev", "order-big-first": "order-small-first", "order-small-first": "order-big-first" }[prefer];
  let order;
  if (mirrored === "order-rev") order = w.map((_, i) => w.length - 1 - i);
  else order = itemOrder(w, mirrored, free);
  const r = reach(w, B, mirrored === "order-rev" ? "order" : mirrored, order, -1, useBits && (mirrored === "fewest" || mirrored === "most"));
  const totals = bestTotals(a, Math.min(b, Tw), (s) => r.reachable(Tw - s), rank, count, centre);
  return totals.map((s) => {
    const out = new Set(r.rebuild(Tw - s));
    return w.map((_, i) => i).filter((i) => !out.has(i));
  });
}

/**
 * Meet in the middle, exact for any amounts, n <= 40.
 * Enumerates all subset sums of each half, sorts the right half, and for every
 * left sum looks at the right sums around (target - left).
 */
const popcount = (x) => { let c = 0; while (x) { x &= x - 1; c++; } return c; };

function mitm(free, rank, count, prefer, centre) {
  const n = free.length;
  const h = n >> 1;
  const L = free.slice(0, h), R = free.slice(h);
  const enumerate = (arr) => {
    const m = arr.length, size = 1 << m;
    const sums = new Float64Array(size);
    for (let mask = 1; mask < size; mask++) {
      const low = mask & -mask;
      sums[mask] = sums[mask ^ low] + arr[31 - Math.clz32(low)];
    }
    return sums;
  };
  const ls = enumerate(L), rs = enumerate(R);
  // Sort right-half sums and keep one mask per distinct sum (the one the
  // tie-break prefers). With distinct sums, the k-th nearest right sum to a
  // given left sum always yields k-1 better totals, so scanning count+1
  // neighbours per side finds every top-`count` total.
  const rAll = Uint32Array.from(rs.keys()).sort((x, y) => rs[x] - rs[y] || x - y);
  const rOrderList = [], rSortedList = [];
  for (const m of rAll) {
    const last = rSortedList.length - 1;
    if (last >= 0 && rSortedList[last] === rs[m]) {
      const cur = rOrderList[last];
      if ((prefer === "fewest" && popcount(m) < popcount(cur)) || (prefer === "most" && popcount(m) > popcount(cur))) rOrderList[last] = m;
    } else { rOrderList.push(m); rSortedList.push(rs[m]); }
  }
  const rOrder = Uint32Array.from(rOrderList);
  const rSorted = Float64Array.from(rSortedList);

  const best = new Map(); // total -> { lm, rm, k }
  const tieKey = (lm, rm) => {
    const c = popcount(lm) + popcount(rm);
    return prefer === "most" ? -c : prefer === "fewest" ? c : 0;
  };
  let worstKept = Infinity;
  const consider = (lm, rIdx) => {
    const rm = rOrder[rIdx];
    const s = ls[lm] + rs[rm];
    const r = rank(s);
    if (r === Infinity || r > worstKept) return;
    const k = tieKey(lm, rm);
    const prev = best.get(s);
    if (!prev || k < prev.k) best.set(s, { lm, rm, k, r });
    if (best.size > count * 4) {
      const kept = [...best.entries()].sort((x, y) => x[1].r - y[1].r || x[0] - y[0]).slice(0, count);
      best.clear();
      for (const [key, v] of kept) best.set(key, v);
      worstKept = kept[kept.length - 1][1].r;
    }
  };
  const span = count + 1;
  for (let lm = 0; lm < ls.length; lm++) {
    const want = centre - ls[lm];
    // first index with rSorted >= want
    let p = 0, q = rSorted.length;
    while (p < q) { const mid = (p + q) >> 1; if (rSorted[mid] < want) p = mid + 1; else q = mid; }
    for (let j = Math.max(0, p - span); j < Math.min(rSorted.length, p + span); j++) consider(lm, j);
  }
  const sorted = [...best.entries()].sort((x, y) => x[1].r - y[1].r || x[0] - y[0]).slice(0, count);
  return sorted.map(([, { lm, rm }]) => {
    const out = [];
    for (let i = 0; i < L.length; i++) if (lm & (1 << i)) out.push(i);
    for (let i = 0; i < R.length; i++) if (rm & (1 << i)) out.push(h + i);
    return out;
  });
}

/**
 * Approximation for inputs too big for any exact method (many invoices AND a
 * huge target). Solves "under" with a scaled-down DP (rounding amounts up so
 * the scaled answer is always feasible), fills the gap greedily, then
 * improves with 1-for-1 and 1-for-2 swaps. "over" is "under" on the
 * complement; "closest" takes the better of the two.
 */
function approx(free, t, mode, rank) {
  const T = free.reduce((s, a) => s + a, 0);
  const under = (target) => approxUnder(free, target);
  const complementOf = (set) => { const s = new Set(set); return free.map((_, i) => i).filter((i) => !s.has(i)); };
  const cands = [];
  if (mode !== "over") cands.push(under(t));
  if (mode !== "under") cands.push(complementOf(under(T - t)));
  cands.sort((x, y) => rank(sumOf(free, x)) - rank(sumOf(free, y)));
  return cands.slice(0, 1);
}

function approxUnder(free, t) {
  const n = free.length;
  if (t <= 0) return [];
  const f = Math.ceil((t + 1) / Math.min(LIMITS.maxCells, 5_000_000));
  const ws = free.map((a) => Math.ceil(a / f));
  const B = Math.floor(t / f);
  const order = ws.map((_, i) => i);
  const r = reach(ws, B, "order", order, B, false);
  let s = B;
  while (s > 0 && !r.reachable(s)) s--;
  const inSet = new Uint8Array(n);
  for (const i of r.rebuild(s)) inSet[i] = 1;
  let total = 0;
  for (let i = 0; i < n; i++) if (inSet[i]) total += free[i];

  // greedy fill, biggest first
  const bySize = free.map((_, i) => i).sort((x, y) => free[y] - free[x]);
  for (const i of bySize) if (!inSet[i] && total + free[i] <= t) { inSet[i] = 1; total += free[i]; }

  // swap improvement: replace one picked invoice with one or two unpicked ones
  const deadline = Date.now() + 1500;
  let improved = true;
  while (improved && total < t && Date.now() < deadline) {
    improved = false;
    const outs = [], ins = [];
    for (let i = 0; i < n; i++) (inSet[i] ? ins : outs).push(i);
    outs.sort((x, y) => free[x] - free[y]);
    const outVals = outs.map((i) => free[i]);
    const gap = t - total;
    const largestAtMost = (v, skip = -1) => { // index into outs of largest value <= v
      let p = 0, q = outVals.length;
      while (p < q) { const m = (p + q) >> 1; if (outVals[m] <= v) p = m + 1; else q = m; }
      let k = p - 1;
      if (k === skip) k--;
      return k;
    };
    let bestGain = 0, bestMove = null;
    for (const i of ins) {
      const room = gap + free[i];
      const k = largestAtMost(room);
      if (k >= 0 && outVals[k] - free[i] > bestGain) { bestGain = outVals[k] - free[i]; bestMove = [i, [outs[k]]]; }
      if (outs.length >= 2 && Date.now() < deadline) {
        for (let k1 = 0; k1 < outs.length && outVals[k1] < room; k1++) {
          const k2 = largestAtMost(room - outVals[k1], k1);
          if (k2 > k1 && outVals[k1] + outVals[k2] - free[i] > bestGain) {
            bestGain = outVals[k1] + outVals[k2] - free[i];
            bestMove = [i, [outs[k1], outs[k2]]];
          }
        }
      }
      if (bestGain === gap) break;
    }
    if (bestMove) {
      inSet[bestMove[0]] = 0; total -= free[bestMove[0]];
      for (const j of bestMove[1]) { inSet[j] = 1; total += free[j]; }
      for (const j of bySize) if (!inSet[j] && total + free[j] <= t) { inSet[j] = 1; total += free[j]; }
      improved = true;
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (inSet[i]) out.push(i);
  return out;
}
