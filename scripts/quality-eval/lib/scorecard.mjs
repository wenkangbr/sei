// scripts/quality-eval/lib/scorecard.mjs: turn raw trial results into the
// scorecard numbers (with intervals), the quality index, and paired deltas.
import fs from 'node:fs'
import path from 'node:path'
import { wilson, newcombe, effective, mean, tInterval, rng, propDraw, normalSample, quantile, sd } from './stats.mjs'
import { costOf } from '../report.mjs'
import { JUDGE_MODEL } from '../judge.mjs'

// Index weights: mostly the deterministic parts. B = brain-mode benchmark
// success (the companion as players get it), D = direct-mode success (skills
// alone), C = scripted-conversation ok-rate, F = free-play ok-rate.
export const WEIGHTS = { B: 0.45, D: 0.20, C: 0.25, F: 0.10 }
const DRAWS = 4000

const r1 = (x) => Math.round(x * 10) / 10

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

export function computeScorecard(rows, { seed = 7 } = {}) {
  const sc = { micro: {}, convo: null, freeplay: null, index: null, cost: { companion: 0, judge: 0, player: 0 } }
  // ── micro ──
  for (const r of rows.filter((x) => x.suite === 'micro')) {
    const b = (sc.micro[r.bench] ??= {})
    const m = (b[r.mode] ??= { k: 0, n: 0, invalid: 0, times: [], values: [] })
    if (r.invalid) { m.invalid++; continue }
    m.n++
    if (r.success) { m.k++; if (r.timeMs != null) m.times.push(r.timeMs / 1000) }
    m.values.push(r.value)
    sc.cost.companion += r.costUsd || 0
  }
  for (const b of Object.values(sc.micro)) for (const m of Object.values(b)) {
    m.rate = m.n ? m.k / m.n : null
    m.ci = wilson(m.k, m.n)
    const ts = [...m.times].sort((a, c) => a - c)
    m.medianTimeS = ts.length ? r1(quantile(ts, 0.5)) : null
  }
  const pooled = (mode) => {
    const cells = Object.entries(sc.micro).map(([id, b]) => [id, b[mode]]).filter(([, m]) => m && m.n)
    if (!cells.length) return null
    return { benches: cells.length, trials: cells.reduce((a, [, m]) => a + m.n, 0), rate: mean(cells.map(([, m]) => m.k / m.n)), cells: cells.map(([id, m]) => ({ id, k: m.k, n: m.n })) }
  }
  sc.microPooled = { brain: pooled('brain'), direct: pooled('direct') }
  // Wilson on the pooled trials (benchmarks get equal reps, so the mean of
  // rates is the pooled proportion); keeps the point inside its interval.
  for (const m of Object.values(sc.microPooled)) if (m) m.ci = wilson(Math.round(m.rate * m.trials), m.trials)

  // ── scripted conversations ──
  const convo = rows.filter((x) => x.suite === 'convo' && x.labels)
  if (convo.length) {
    const ks = [], ns = [], byCat = {}, byNeeds = {}, perSession = []
    for (const s of convo) {
      // A unit the judge skipped is unscored, not ok.
      const L = s.labels.labels.filter((l) => l.by !== 'missing')
      if (!L.length) continue
      const off = L.filter((l) => l.label === 'off')
      ks.push(off.length); ns.push(L.length)
      perSession.push({ id: s.id, script: s.script, rep: s.rep, off: off.length, n: L.length, rate: off.length / L.length })
      for (const l of off) byCat[l.category] = (byCat[l.category] || 0) + 1
      for (const l of L) { const g = (byNeeds[l.needs] ??= { n: 0, off: 0 }); g.n++; if (l.label === 'off') g.off++ }
      sc.cost.judge += costOf(JUDGE_MODEL, s.labels.usage)
      sc.cost.companion += s.companionCost || 0
    }
    const k = ks.reduce((a, b) => a + b, 0), n = ns.reduce((a, b) => a + b, 0)
    const eff = effective(ks, ns)
    sc.convo = { k, n, rate: k / n, ci: wilson(eff.k, eff.n), deff: eff.deff, effK: eff.k, effN: eff.n, perSession, byCat, byNeeds }
  }

  // ── free play ──
  const fp = rows.filter((x) => x.suite === 'freeplay' && x.labels)
  if (fp.length) {
    const sessions = fp.map((s) => {
      const L = s.labels.labels
      const off = L.filter((l) => l.label === 'off').length
      sc.cost.judge += costOf(JUDGE_MODEL, s.labels.usage)
      sc.cost.companion += s.companionCost || 0
      sc.cost.player += s.playerCost || 0
      return { id: s.id, scenario: s.scenario, rep: s.rep, items: L.length, off, minutes: s.minutes, offRate: L.length ? off / L.length : 0, offPerMin: s.minutes ? off / s.minutes : 0 }
    })
    const byScenario = {}
    for (const s of sessions) (byScenario[s.scenario] ??= []).push(s)
    const scen = Object.fromEntries(Object.entries(byScenario).map(([id, ss]) => [id, {
      reps: ss.length,
      offRate: { mean: mean(ss.map((x) => x.offRate)), min: Math.min(...ss.map((x) => x.offRate)), max: Math.max(...ss.map((x) => x.offRate)) },
      offPerMin: { mean: mean(ss.map((x) => x.offPerMin)), min: Math.min(...ss.map((x) => x.offPerMin)), max: Math.max(...ss.map((x) => x.offPerMin)) },
    }]))
    const rates = sessions.map((s) => s.offRate), opm = sessions.map((s) => s.offPerMin)
    sc.freeplay = {
      sessions, byScenario: scen,
      offRate: { mean: mean(rates), min: Math.min(...rates), max: Math.max(...rates), ci: tInterval(rates), sd: sd(rates) },
      offPerMin: { mean: mean(opm), min: Math.min(...opm), max: Math.max(...opm), ci: tInterval(opm) },
    }
  }

  sc.index = indexOf(sc, seed)
  sc.cost.total = sc.cost.companion + sc.cost.judge + sc.cost.player
  return sc
}

// One simulated draw of each component; null when the scorecard lacks it.
function drawComponents(sc, r) {
  // Pooled over benchmarks (equal reps per benchmark): one Jeffreys draw on
  // all trials. Per-cell priors on 2-6 trial cells shrank the index too far.
  const pooledDraw = (m) => (m ? propDraw(r, Math.round(m.rate * m.trials), m.trials) : null)
  const B = pooledDraw(sc.microPooled.brain)
  const D = pooledDraw(sc.microPooled.direct)
  const C = sc.convo ? 1 - propDraw(r, sc.convo.effK, sc.convo.effN) : null
  let F = null
  if (sc.freeplay) {
    const xs = sc.freeplay.sessions.map((s) => s.offRate)
    const s = xs.length > 1 ? sd(xs) : 0.1
    F = 1 - Math.min(1, Math.max(0, mean(xs) + normalSample(r) * (s / Math.sqrt(xs.length))))
  }
  return { B, D, C, F }
}

function combine(comp) {
  let w = 0, v = 0
  for (const [k, x] of Object.entries(comp)) if (x != null && Number.isFinite(x)) { w += WEIGHTS[k]; v += WEIGHTS[k] * x }
  return w ? (100 * v) / w : null
}

export function pointComponents(sc) {
  return {
    B: sc.microPooled.brain?.rate ?? null,
    D: sc.microPooled.direct?.rate ?? null,
    C: sc.convo ? 1 - sc.convo.rate : null,
    F: sc.freeplay ? 1 - sc.freeplay.offRate.mean : null,
  }
}

// The index point is the MEDIAN of its simulated draws, so it always sits
// inside its interval. Jeffreys draws pull extremes in a little, so near the
// ceiling the index reads a point or two under the raw weighted mean (`raw`);
// compare indexes from equally sized runs.
function indexOf(sc, seed) {
  const comps = pointComponents(sc)
  const raw = combine(comps)
  if (raw == null) return null
  const r = rng(seed)
  const draws = []
  for (let i = 0; i < DRAWS; i++) draws.push(combine(drawComponents(sc, r)))
  draws.sort((a, b) => a - b)
  return { value: quantile(draws, 0.5), raw, ci: [quantile(draws, 0.025), quantile(draws, 0.975)], components: comps, present: Object.keys(comps).filter((k) => comps[k] != null) }
}

/** Paired comparison of two scorecards (A = baseline, B = candidate). */
export function compareScorecards(A, B, { seed = 11 } = {}) {
  const out = { micro: {}, convo: null, freeplay: null, index: null }
  for (const id of new Set([...Object.keys(A.micro), ...Object.keys(B.micro)])) {
    for (const mode of ['brain', 'direct']) {
      const a = A.micro[id]?.[mode], b = B.micro[id]?.[mode]
      if (!a?.n || !b?.n) continue
      const ci = newcombe(a.k, a.n, b.k, b.n)
      ;(out.micro[id] ??= {})[mode] = { a: a.k / a.n, b: b.k / b.n, delta: b.k / b.n - a.k / a.n, ci, real: ci[0] > 0 || ci[1] < 0 }
    }
  }
  // Mean success over the benchmarks both sides ran, per mode.
  out.pooled = {}
  for (const mode of ['brain', 'direct']) {
    const a = A.microPooled?.[mode], b = B.microPooled?.[mode]
    if (!a || !b) continue
    const ids = a.cells.map((c) => c.id).filter((id) => b.cells.some((c) => c.id === id))
    if (!ids.length) continue
    const ca = ids.map((id) => a.cells.find((c) => c.id === id)), cb = ids.map((id) => b.cells.find((c) => c.id === id))
    const ra = mean(ca.map((c) => c.k / c.n)), rb = mean(cb.map((c) => c.k / c.n))
    const na = ca.reduce((x, c) => x + c.n, 0), nb = cb.reduce((x, c) => x + c.n, 0)
    const ci = newcombe(Math.round(ra * na), na, Math.round(rb * nb), nb)
    out.pooled[mode] = { a: ra, b: rb, delta: rb - ra, ci, real: ci[0] > 0 || ci[1] < 0, benches: ids.length }
  }
  if (A.convo && B.convo) {
    const ci = newcombe(A.convo.effK, A.convo.effN, B.convo.effK, B.convo.effN)
    out.convo = { a: A.convo.rate, b: B.convo.rate, delta: B.convo.rate - A.convo.rate, ci, real: ci[0] > 0 || ci[1] < 0 }
  }
  if (A.freeplay && B.freeplay) {
    const xa = A.freeplay.sessions.map((s) => s.offRate), xb = B.freeplay.sessions.map((s) => s.offRate)
    const se = Math.sqrt((sd(xa) ** 2 || 0.01) / xa.length + (sd(xb) ** 2 || 0.01) / xb.length)
    const d = mean(xb) - mean(xa)
    const ci = [d - 2.78 * se, d + 2.78 * se] // t(4 df): few sessions, so wide on purpose
    out.freeplay = { a: mean(xa), b: mean(xb), delta: d, ci, real: ci[0] > 0 || ci[1] < 0 }
  }
  if (A.index && B.index) {
    // Same components on both sides, or the index is not comparable.
    const same = A.index.present.join() === B.index.present.join()
    const r = rng(seed)
    const ds = []
    for (let i = 0; i < DRAWS; i++) ds.push(combine(drawComponents(B, r)) - combine(drawComponents(A, r)))
    ds.sort((x, y) => x - y)
    const ci = [quantile(ds, 0.025), quantile(ds, 0.975)]
    out.index = { a: A.index.value, b: B.index.value, delta: quantile(ds, 0.5), ci, real: same && (ci[0] > 0 || ci[1] < 0), comparable: same }
  }
  return out
}

/** Load every trial/session result under an output dir (results.jsonl + labels). */
export function loadRows(outDir) {
  const p = path.join(outDir, 'results.jsonl')
  if (!fs.existsSync(p)) return []
  const rows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  for (const r of rows) {
    if ((r.suite === 'convo' || r.suite === 'freeplay') && r.dir) r.labels = readJson(path.join(r.dir, 'labels.json'))
  }
  return rows
}
