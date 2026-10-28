// scripts/quality-eval/lib/stats.mjs: the interval math behind the scorecard.
//
//   wilson(k, n)                  95% Wilson score interval for a proportion
//   newcombe(k1, n1, k2, n2)      95% interval for p2 - p1 (Newcombe hybrid score)
//   designEffect(rates, ns)       variance inflation when units cluster in sessions
//   rng(seed), betaSample, normalSample   seeded draws for the index simulation
//
// Why these: per-benchmark success is binomial with small n (3 to 10), where a
// normal interval collapses at 0/n and n/n; Wilson does not. Scripted
// conversation lines cluster inside sessions (one bad session drags many
// lines), so their interval is widened by the observed design effect instead
// of pretending every line is independent.
const Z = 1.959964

export function wilson(k, n, z = Z) {
  if (!n) return [0, 1]
  const p = k / n
  const d = 1 + (z * z) / n
  const c = (p + (z * z) / (2 * n)) / d
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return [Math.max(0, c - h), Math.min(1, c + h)]
}

/** 95% CI for p2 - p1 (method 10 in Newcombe 1998). Works with fractional k/n. */
export function newcombe(k1, n1, k2, n2) {
  const p1 = n1 ? k1 / n1 : 0, p2 = n2 ? k2 / n2 : 0
  const [l1, u1] = wilson(k1, n1), [l2, u2] = wilson(k2, n2)
  const d = p2 - p1
  const lo = d - Math.sqrt((p2 - l2) ** 2 + (u1 - p1) ** 2)
  const hi = d + Math.sqrt((u2 - p2) ** 2 + (p1 - l1) ** 2)
  return [Math.max(-1, lo), Math.min(1, hi)]
}

/**
 * Design effect for a pooled proportion whose units come in sessions:
 * observed between-session variance of the rates over the binomial variance
 * it would have if units were independent. Floored at 1.
 */
export function designEffect(ks, ns) {
  const m = ns.length
  const N = ns.reduce((a, b) => a + b, 0)
  if (m < 2 || !N) return 1
  const p = ks.reduce((a, b) => a + b, 0) / N
  if (p <= 0 || p >= 1) return 1
  const nbar = N / m
  let s = 0
  for (let i = 0; i < m; i++) s += ns[i] * (ks[i] / ns[i] - p) ** 2
  const between = s / (m - 1) / nbar      // variance of a session rate at n = nbar
  const binom = (p * (1 - p)) / nbar
  return Math.max(1, between / binom)
}

/** Effective (k, n) for a clustered proportion: shrink n by the design effect. */
export function effective(ks, ns) {
  const deff = designEffect(ks, ns)
  const k = ks.reduce((a, b) => a + b, 0), n = ns.reduce((a, b) => a + b, 0)
  return { k: k / deff, n: n / deff, deff }
}

export function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN }
export function sd(xs) {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}

// t quantiles (two-sided 95%) for small samples.
const T95 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145]
export function tInterval(xs) {
  const n = xs.length, m = mean(xs)
  if (n < 2) return [NaN, NaN]
  const t = T95[n - 1] ?? 1.96
  const h = (t * sd(xs)) / Math.sqrt(n)
  return [m - h, m + h]
}

// ── seeded sampling ─────────────────────────────────────────────────────
export function rng(seed = 1) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function normalSample(r) {
  let u = 0, v = 0
  while (u === 0) u = r()
  while (v === 0) v = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function gammaSample(r, shape) {
  if (shape < 1) return gammaSample(r, shape + 1) * Math.pow(r(), 1 / shape)
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x, v
    do { x = normalSample(r); v = 1 + c * x } while (v <= 0)
    v = v * v * v
    const u = r()
    if (u < 1 - 0.0331 * x ** 4) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

export function betaSample(r, a, b) {
  const x = gammaSample(r, a), y = gammaSample(r, b)
  return x / (x + y)
}

/** Jeffreys-posterior draw of a proportion from (possibly fractional) k of n. */
export function propDraw(r, k, n) {
  return betaSample(r, k + 0.5, n - k + 0.5)
}

export function quantile(sorted, q) {
  if (!sorted.length) return NaN
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i), hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}
