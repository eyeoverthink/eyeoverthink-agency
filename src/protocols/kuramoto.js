// Kuramoto dynamics used for real work: consensus clustering of agent answers.
// Each agent's answer is an oscillator. Coupling between i and j is signed by semantic agreement
// (w_ij = sim_ij - tau): agreeing answers attract, conflicting answers repel. After integrating,
// phase-locked groups are the opinion clusters and the order parameter R measures global coherence.
import { cosine } from '../core/util.js';

/** Order parameter R = |(1/N) Σ e^{iθ}| in [0,1] and mean phase ψ. */
export function orderParameter(phases) {
  if (!phases.length) return { r: 0, psi: 0 };
  let re = 0, im = 0;
  for (const t of phases) { re += Math.cos(t); im += Math.sin(t); }
  re /= phases.length; im /= phases.length;
  return { r: Math.hypot(re, im), psi: Math.atan2(im, re) };
}

/** One forward-Euler step of θ_i += dt·(ω_i + (K/N) Σ_j w_ij sin(θ_j − θ_i)). */
export function kuramotoStep(phases, weights, { K = 2, dt = 0.1, omega = null } = {}) {
  const n = phases.length;
  return phases.map((ti, i) => {
    let s = 0;
    for (let j = 0; j < n; j++) if (j !== i) s += weights[i][j] * Math.sin(phases[j] - ti);
    return ti + dt * ((omega ? omega[i] : 0) + (K / n) * s);
  });
}

/**
 * Consensus over answer embeddings.
 * Returns { r, clusters: [[indices]], majority: [indices], similarity } — deterministic (evenly spaced initial phases).
 */
export function kuramotoConsensus(vectors, { tau = 0.55, K = 3, steps = 400, dt = 0.05, lockTolerance = 0.35 } = {}) {
  const n = vectors.length;
  if (n === 0) return { r: 0, clusters: [], majority: [], similarity: [] };
  if (n === 1) return { r: 1, clusters: [[0]], majority: [0], similarity: [[1]] };
  const sim = vectors.map((a) => vectors.map((b) => cosine(a, b)));
  const w = sim.map((row, i) => row.map((s, j) => (i === j ? 0 : s - tau)));
  let phases = Array.from({ length: n }, (_, i) => (2 * Math.PI * i) / n);
  for (let s = 0; s < steps; s++) phases = kuramotoStep(phases, w, { K, dt });
  const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
  const clusters = [];
  for (let i = 0; i < n; i++) {
    const c = clusters.find((cl) => Math.abs(wrap(phases[i] - phases[cl[0]])) < lockTolerance);
    if (c) c.push(i); else clusters.push([i]);
  }
  clusters.sort((a, b) => b.length - a.length);
  const { r } = orderParameter(phases);
  return { r: Math.round(r * 1000) / 1000, clusters, majority: clusters[0], similarity: sim.map((row) => row.map((x) => Math.round(x * 1000) / 1000)) };
}
