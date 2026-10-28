#!/usr/bin/env node
// scripts/quality-eval/persona/report.mjs: numbers for the persona eval.
//
//   node scripts/quality-eval/persona/report.mjs <runDir>                 -> <runDir>/report.md
//   node scripts/quality-eval/persona/report.mjs <beforeDir> <afterDir>   -> <afterDir>/compare.md
//
// A run directory that has not been judged yet (samples.jsonl only) still gets
// the speech-only sections: signature-tic frequency and phrase repetition.
//
// Rates carry 95% Wilson intervals (stats.mjs); before/after differences carry
// Newcombe intervals. Reps inside one (character, situation) cell are
// independent model samples of a fixed prompt, so items are treated as
// independent draws within fixed strata, for which the plain binomial interval
// is the conservative one.
import fs from 'node:fs'
import path from 'node:path'
import { wilson, newcombe, mean, sd } from '../lib/stats.mjs'
import { loadCharacters } from './characters.mjs'
import { SITUATIONS } from './situations.mjs'
import os from 'node:os'

const PRICES = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50, cw: 0.125, cr: 0.01 },
  'claude-opus-5-5': { in: 4, out: 20, cw: 5, cr: 0.20 },
}
export function costOf(model, u = {}) {
  const p = PRICES[model]
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out +
    (u.cache_creation_input_tokens || 0) * p.cw + (u.cache_read_input_tokens || 0) * p.cr) / 1e6
}

const pct = (x) => `${(100 * x).toFixed(0)}%`
const ci = ([a, b]) => `[${pct(a)}, ${pct(b)}]`
const rate = (k, n) => `${pct(n ? k / n : 0)} ${ci(wilson(k, n))} (${k}/${n})`
const usd = (x) => `$${x.toFixed(2)}`

const readJsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))

export function load(dir) {
  const samples = readJsonl(path.join(dir, 'samples.jsonl'))
  const judged = fs.existsSync(path.join(dir, 'judgments.jsonl'))
  const rows = judged ? readJsonl(path.join(dir, 'judgments.jsonl')) : []
  const ju = judged ? JSON.parse(fs.readFileSync(path.join(dir, 'judge-usage.json'), 'utf8')) : null
  const genCost = samples.reduce((a, s) => a + (s.usage ? costOf(s.model ?? 'claude-haiku-5-5', s.usage) : 0), 0)
  const judgeCost = ju ? costOf(ju.model, ju.usage.attribution) + costOf(ju.model, ju.usage.consistency) : 0
  return { rows, samples, judged, genCost, judgeCost, errors: samples.filter((s) => s.error).length }
}

// ── speech-only metrics: signature tics and repeated phrases ─────────────────

// What one sample said out loud, the same way judge.mjs reads it: say() lines
// plus a quit_game farewell. '' when the companion stayed silent.
export function speechOf(s) {
  const farewells = (s.actions ?? []).filter((a) => a.name === 'quit_game' && a.input?.farewell).map((a) => String(a.input.farewell))
  return [...(s.says ?? []), ...farewells].join(' / ').trim()
}

function spokenLines(samples, key) {
  return samples.filter((s) => !s.error && s.char === key).map((s) => ({ ...s, line: speechOf(s) })).filter((s) => s.line)
}

/** Per character: how many spoken items contain each of its signature tics. */
export function ticStats(samples, ch) {
  const lines = spokenLines(samples, ch.key)
  return {
    n: lines.length,
    tics: ch.tics.map((t) => ({ name: t.name, k: lines.filter((l) => t.re.test(l.line)).length })),
  }
}

const STOP = new Set(('a an the and or but so to of in on at for with by from up down out over into about as is are was were be been am ' +
  "i im i'm me my you you're your it it's its this that these those we us our they them he him she her there here " +
  "do did does done not no yes ok okay just too very really then than what who how why when where which " +
  "can can't will i'll would could should have has had get got go going let let's oh um uh like if all").split(/\s+/))
const tokens = (line) => line.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean)

// Every 2 to 4 word phrase in a line that carries at least one content word.
function phrasesOf(line) {
  const t = tokens(line), out = new Set()
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= t.length; i++) {
      const g = t.slice(i, i + n)
      if (g.some((w) => !STOP.has(w))) out.add(g.join(' '))
    }
  }
  return out
}

/**
 * Phrase repetition for one character. A phrase "recurs" when the character
 * says it in at least `minSits` different situations: that is a stock line it
 * reaches for whatever is happening, which is what reads as a parody over a
 * long session (a phrase repeated inside one situation is usually just the
 * situation's own content, like "the villager"). Also the cross-rep rate:
 * share of (situation) cells where two or more reps open with the same three
 * words.
 */
export function repetition(samples, ch, minSits = 3) {
  const lines = spokenLines(samples, ch.key)
  const sitsOf = new Map(), linesOf = new Map()
  const perLine = lines.map((l) => phrasesOf(l.line))
  perLine.forEach((ps, i) => {
    for (const p of ps) {
      if (!sitsOf.has(p)) { sitsOf.set(p, new Set()); linesOf.set(p, 0) }
      sitsOf.get(p).add(lines[i].situation)
      linesOf.set(p, linesOf.get(p) + 1)
    }
  })
  const recurring = new Set([...sitsOf].filter(([, s]) => s.size >= minSits).map(([p]) => p))
  const k = perLine.filter((ps) => [...ps].some((p) => recurring.has(p))).length
  // Top phrases, longest first among ties, dropping a phrase that only ever
  // appears inside a longer listed one.
  const ranked = [...recurring].map((p) => ({ p, sits: sitsOf.get(p).size, lines: linesOf.get(p) }))
    .sort((a, b) => b.lines - a.lines || b.p.split(' ').length - a.p.split(' ').length)
  const top = []
  for (const r of ranked) {
    if (top.some((t) => t.p.includes(r.p) && t.lines >= r.lines)) continue
    top.push(r)
    if (top.length >= 4) break
  }
  const cells = new Map()
  for (const l of lines) {
    const open = tokens(l.line).slice(0, 3).join(' ')
    if (!cells.has(l.situation)) cells.set(l.situation, [])
    cells.get(l.situation).push(open)
  }
  const cellsN = [...cells.values()].filter((v) => v.length >= 2).length
  const sameOpen = [...cells.values()].filter((v) => v.length >= 2 && new Set(v).size < v.length).length
  return { n: lines.length, k, top, cellsN, sameOpen }
}

function ticSection(samples, chars) {
  const L = ['Signature tics (share of spoken items containing the tic; healthy is now and then, roughly 15-30%):', '',
    '| char | tic | rate [95% CI] |', '|---|---|---|']
  for (const c of chars) {
    const t = ticStats(samples, c)
    for (const x of t.tics) L.push(`| ${c.key} | ${x.name} | ${rate(x.k, t.n)} |`)
  }
  L.push('', `Phrase repetition (a phrase recurs when the character says it in 3 or more different situations; same opening = cells where 2+ reps open with the same three words):`, '',
    '| char | items with a recurring phrase | same opening across reps | top recurring phrases (lines/situations) |', '|---|---|---|---|')
  for (const c of chars) {
    const r = repetition(samples, c)
    L.push(`| ${c.key} | ${rate(r.k, r.n)} | ${rate(r.sameOpen, r.cellsN)} | ${r.top.map((t) => `"${t.p}" ${t.lines}/${t.sits}`).join(', ') || '-'} |`)
  }
  return L.join('\n')
}

function ticCompare(A, B, chars, diff) {
  const L = ['Signature tics (share of spoken items):', '', '| char | tic | before | after | change [95% CI] |', '|---|---|---|---|---|']
  for (const c of chars) {
    const x = ticStats(A, c), y = ticStats(B, c)
    x.tics.forEach((t, i) => {
      const u = y.tics[i]
      L.push(`| ${c.key} | ${t.name} | ${rate(t.k, x.n)} | ${rate(u.k, y.n)} | ${diff(t.k, x.n, u.k, y.n)} |`)
    })
  }
  L.push('', 'Items with a phrase recurring across 3+ situations:', '', '| char | before | after | change [95% CI] | after: top phrases (lines/situations) |', '|---|---|---|---|---|')
  for (const c of chars) {
    const x = repetition(A, c), y = repetition(B, c)
    L.push(`| ${c.key} | ${rate(x.k, x.n)} | ${rate(y.k, y.n)} | ${diff(x.k, x.n, y.k, y.n)} | ${y.top.map((t) => `"${t.p}" ${t.lines}/${t.sits}`).join(', ') || '-'} |`)
  }
  return L.join('\n')
}

export function metrics(rows) {
  const n = rows.length
  const correct = rows.filter((r) => r.attribution?.guess === r.char).length
  const spoken = rows.filter((r) => !r.silent)
  const spokenCorrect = spoken.filter((r) => r.attribution?.guess === r.char).length
  const judged = rows.filter((r) => r.consistency?.score)
  const off = judged.filter((r) => r.consistency.off).length
  const generic = spoken.filter((r) => r.consistency?.generic).length
  const scores = judged.map((r) => r.consistency.score)
  return {
    n, correct, spokenN: spoken.length, spokenCorrect, judgedN: judged.length, off, generic, scores,
    silent: rows.filter((r) => r.silent).length,
  }
}

function scoreLine(scores) {
  const m = mean(scores), s = sd(scores), h = 1.96 * s / Math.sqrt(scores.length)
  return `${m.toFixed(2)} [${(m - h).toFixed(2)}, ${(m + h).toFixed(2)}]`
}

function confusion(rows, chars) {
  const keys = chars.map((c) => c.key)
  const L = ['| true \\ guessed | ' + keys.join(' | ') + ' | none | accuracy |', '|' + '---|'.repeat(keys.length + 3)]
  for (const t of keys) {
    const mine = rows.filter((r) => r.char === t)
    const cells = keys.map((g) => mine.filter((r) => r.attribution?.guess === g).length)
    const none = mine.filter((r) => !r.attribution?.guess).length
    const k = mine.filter((r) => r.attribution?.guess === t).length
    L.push(`| **${t}** | ${cells.join(' | ')} | ${none} | ${rate(k, mine.length)} |`)
  }
  return L.join('\n')
}

export function single(dir, charsDir) {
  const chars = loadCharacters(charsDir)
  const { rows, samples, judged, genCost, judgeCost, errors } = load(dir)
  if (!judged) {
    const text = `Not judged yet (no judgments.jsonl); speech-only sections. Generation errors: ${errors}.\n\n${ticSection(samples, chars)}\n\nCost: generation ${usd(genCost)}.`
    return { text, M: null, cost: genCost }
  }
  const M = metrics(rows)
  const chance = 1 / chars.length
  const L = []
  L.push(`Samples: ${M.n} (${chars.length} characters x ${SITUATIONS.length} situations x reps), generation errors: ${errors}. Chance for attribution: ${pct(chance)}.`)
  L.push('')
  L.push('| metric | value [95% CI] |', '|---|---|')
  L.push(`| Attribution accuracy (blind, all items) | ${rate(M.correct, M.n)} |`)
  L.push(`| Attribution accuracy (items with speech) | ${rate(M.spokenCorrect, M.spokenN)} |`)
  L.push(`| In-character rate (not flagged off) | ${rate(M.judgedN - M.off, M.judgedN)} |`)
  L.push(`| Off-character rate | ${rate(M.off, M.judgedN)} |`)
  L.push(`| Consistency score, mean 1-5 | ${scoreLine(M.scores)} |`)
  L.push(`| Generic-assistant rate (items with speech) | ${rate(M.generic, M.spokenN)} |`)
  L.push(`| Silent (no say) | ${rate(M.silent, M.n)} |`)
  L.push('')
  L.push('Confusion matrix (rows = true character, columns = judge guess):', '', confusion(rows, chars), '')
  L.push('Per character:', '', '| char | attribution | in-character | mean score | generic | silent |', '|---|---|---|---|---|---|')
  for (const c of chars) {
    const m = metrics(rows.filter((r) => r.char === c.key))
    L.push(`| ${c.key} | ${rate(m.correct, m.n)} | ${rate(m.judgedN - m.off, m.judgedN)} | ${scoreLine(m.scores)} | ${rate(m.generic, m.spokenN)} | ${rate(m.silent, m.n)} |`)
  }
  L.push('', 'Per situation (all characters pooled):', '', '| situation | attribution | in-character | mean score | generic |', '|---|---|---|---|---|')
  for (const s of SITUATIONS) {
    const m = metrics(rows.filter((r) => r.situation === s.id))
    if (!m.n) continue
    L.push(`| ${s.id} | ${rate(m.correct, m.n)} | ${rate(m.judgedN - m.off, m.judgedN)} | ${scoreLine(m.scores)} | ${rate(m.generic, m.spokenN)} |`)
  }
  // What they DID: how often each character took initiative tools.
  L.push('', 'Actions per character (share of items with at least one call):', '', '| char | any action | setGoal | follow/come | attack | remember |', '|---|---|---|---|---|---|')
  for (const c of chars) {
    const mine = rows.filter((r) => r.char === c.key)
    const has = (f) => mine.filter((r) => r.actions.some(f)).length
    L.push(`| ${c.key} | ${rate(has(() => true), mine.length)} | ${rate(has((a) => a === 'setGoal'), mine.length)} | ${rate(has((a) => a === 'follow' || a === 'come'), mine.length)} | ${rate(has((a) => /attack/i.test(a)), mine.length)} | ${rate(has((a) => a === 'remember'), mine.length)} |`)
  }
  L.push('', ticSection(samples, chars))
  L.push('', `Cost: generation ${usd(genCost)} (Haiku 5.5), judging ${usd(judgeCost)} (Opus 5.5), total ${usd(genCost + judgeCost)}.`)
  return { text: L.join('\n'), M, cost: genCost + judgeCost }
}

export function compare(beforeDir, afterDir, charsDir) {
  const chars = loadCharacters(charsDir)
  const A = load(beforeDir), B = load(afterDir)
  const diff = (k1, n1, k2, n2) => {
    const [lo, hi] = newcombe(k1, n1, k2, n2)
    const d = (n2 ? k2 / n2 : 0) - (n1 ? k1 / n1 : 0)
    return `${d >= 0 ? '+' : ''}${(100 * d).toFixed(0)} pts [${(100 * lo).toFixed(0)}, ${(100 * hi).toFixed(0)}]`
  }
  const tics = ticCompare(A.samples, B.samples, chars, diff)
  if (!A.judged || !B.judged) return `Speech-only comparison (one side is not judged yet).\n\n${tics}`
  const a = metrics(A.rows), b = metrics(B.rows)
  const sdiff = (x, y) => {
    const d = mean(y) - mean(x)
    const h = 1.96 * Math.sqrt(sd(x) ** 2 / x.length + sd(y) ** 2 / y.length)
    return `${d >= 0 ? '+' : ''}${d.toFixed(2)} [${(d - h).toFixed(2)}, ${(d + h).toFixed(2)}]`
  }
  const L = ['| metric | before | after | change [95% CI] |', '|---|---|---|---|']
  L.push(`| Attribution accuracy | ${rate(a.correct, a.n)} | ${rate(b.correct, b.n)} | ${diff(a.correct, a.n, b.correct, b.n)} |`)
  L.push(`| Attribution (speech only) | ${rate(a.spokenCorrect, a.spokenN)} | ${rate(b.spokenCorrect, b.spokenN)} | ${diff(a.spokenCorrect, a.spokenN, b.spokenCorrect, b.spokenN)} |`)
  L.push(`| In-character rate | ${rate(a.judgedN - a.off, a.judgedN)} | ${rate(b.judgedN - b.off, b.judgedN)} | ${diff(a.judgedN - a.off, a.judgedN, b.judgedN - b.off, b.judgedN)} |`)
  L.push(`| Consistency score | ${scoreLine(a.scores)} | ${scoreLine(b.scores)} | ${sdiff(a.scores, b.scores)} |`)
  L.push(`| Generic-assistant rate | ${rate(a.generic, a.spokenN)} | ${rate(b.generic, b.spokenN)} | ${diff(a.generic, a.spokenN, b.generic, b.spokenN)} |`)
  L.push(`| Silent | ${rate(a.silent, a.n)} | ${rate(b.silent, b.n)} | ${diff(a.silent, a.n, b.silent, b.n)} |`)
  L.push('', 'Per character attribution / in-character:', '', '| char | attribution before | after | in-character before | after |', '|---|---|---|---|---|')
  for (const c of chars) {
    const x = metrics(A.rows.filter((r) => r.char === c.key)), y = metrics(B.rows.filter((r) => r.char === c.key))
    L.push(`| ${c.key} | ${rate(x.correct, x.n)} | ${rate(y.correct, y.n)} | ${rate(x.judgedN - x.off, x.judgedN)} | ${rate(y.judgedN - y.off, y.judgedN)} |`)
  }
  L.push('', 'After-run confusion matrix:', '', confusion(B.rows, chars))
  L.push('', tics)
  return L.join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const charsDir = path.join(os.homedir(), 'suisei/eval/characters')
  const [x, y] = process.argv.slice(2)
  if (y) {
    const t = compare(x, y, charsDir)
    fs.writeFileSync(path.join(y, 'compare.md'), t + '\n')
    console.log(t)
  } else {
    const { text } = single(x, charsDir)
    fs.writeFileSync(path.join(x, 'report.md'), text + '\n')
    console.log(text)
  }
}
