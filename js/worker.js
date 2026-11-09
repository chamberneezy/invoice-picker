// Runs the solver off the main thread so the page stays responsive on large reports.
import { findOptions, splitBatches } from "./solver.js";

self.onmessage = (e) => {
  const { id, kind, amounts, target, opts } = e.data;
  try {
    const result = kind === "batches" ? splitBatches(amounts, target, opts) : findOptions(amounts, target, opts);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, code: err.code || "ERROR", message: err.message });
  }
};
