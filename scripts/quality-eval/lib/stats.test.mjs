import { describe, it, expect } from 'vitest'
import { wilson, newcombe, designEffect, effective, rng, propDraw, tInterval, quantile } from './stats.mjs'
import { computeScorecard, compareScorecards } from './scorecard.mjs'

describe('wilson', () => {
  it('matches known values', () => {
    const [lo, hi] = wilson(3, 5)
    expect(lo).toBeCloseTo(0.2307, 3)
    expect(hi).toBeCloseTo(0.8824, 3)
  })
  it('does not collapse at 0/n or n/n', () => {
    expect(wilson(0, 5)[1]).toBeGreaterThan(0.4)
    expect(wilson(5, 5)[0]).toBeLessThan(0.6)
  })
})

describe('newcombe', () => {
  it('contains the point difference and 0 for equal small samples', () => {
    const [lo, hi] = newcombe(3, 5, 3, 5)
    expect(lo).toBeLessThan(0)
    expect(hi).toBeGreaterThan(0)
  })
  it('flags a large real difference (Newcombe 1998 example 56/70 vs 48/80)', () => {
    // p1 = 56/70, p2 = 48/80: p2 - p1 = -0.2, published CI -0.3339 to -0.0524
    const [lo, hi] = newcombe(56, 70, 48, 80)
    expect(lo).toBeCloseTo(-0.3339, 3)
    expect(hi).toBeCloseTo(-0.0524, 3)
  })
})

describe('designEffect', () => {
  it('is 1 when sessions agree and grows when they disagree', () => {
    expect(designEffect([5, 5, 5], [20, 20, 20])).toBe(1)
    expect(designEffect([1, 10, 19], [20, 20, 20])).toBeGreaterThan(5)
    const e = effective([1, 10, 19], [20, 20, 20])
    expect(e.n).toBeLessThan(60)
    expect(e.k / e.n).toBeCloseTo(0.5, 6)
  })
})

describe('sampling helpers', () => {
  it('rng is deterministic and propDraw centers on the rate', () => {
    const a = rng(3), b = rng(3)
    expect(a()).toBe(b())
    const r = rng(1)
    let s = 0
    for (let i = 0; i < 4000; i++) s += propDraw(r, 30, 100)
    expect(s / 4000).toBeCloseTo(0.3, 1)
  })
  it('tInterval and quantile', () => {
    const [lo, hi] = tInterval([1, 2, 3])
    expect(lo).toBeLessThan(2)
    expect(hi).toBeGreaterThan(2)
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
  })
})

describe('scorecard', () => {
  const micro = (bench, mode, succ) => succ.map((s, i) => ({ suite: 'micro', bench, mode, rep: i + 1, success: !!s, invalid: false, timeMs: 1000 }))
  it('computes per-benchmark rates, an index with an interval, and paired deltas', () => {
    const A = computeScorecard([...micro('gather_logs', 'brain', [1, 0, 1, 0, 1]), ...micro('gather_logs', 'direct', [1, 1, 1])])
    const B = computeScorecard([...micro('gather_logs', 'brain', [1, 1, 1, 1, 1]), ...micro('gather_logs', 'direct', [1, 1, 1])])
    expect(A.micro.gather_logs.brain.rate).toBeCloseTo(0.6)
    expect(A.index.ci[0]).toBeLessThan(A.index.value)
    expect(A.index.ci[1]).toBeGreaterThan(A.index.value)
    const same = compareScorecards(A, A)
    expect(same.index.ci[0]).toBeLessThan(0)
    expect(same.index.ci[1]).toBeGreaterThan(0)
    expect(same.index.real).toBe(false)
    const d = compareScorecards(A, B)
    expect(d.micro.gather_logs.brain.delta).toBeCloseTo(0.4)
    expect(d.micro.gather_logs.brain.real).toBe(false) // 3/5 vs 5/5 is inside the noise
  })
  it('ignores invalid trials in the denominator', () => {
    const s = computeScorecard([{ suite: 'micro', bench: 'stop_gather', mode: 'brain', success: false, invalid: true }, { suite: 'micro', bench: 'stop_gather', mode: 'brain', success: true, invalid: false }])
    expect(s.micro.stop_gather.brain.n).toBe(1)
    expect(s.micro.stop_gather.brain.invalid).toBe(1)
  })
})
