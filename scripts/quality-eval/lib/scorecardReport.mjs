// scripts/quality-eval/lib/scorecardReport.mjs: summary.md / compare.md.
import fs from 'node:fs'
import path from 'node:path'
import { MICRO } from '../bench/micro.mjs'
import { WEIGHTS } from './scorecard.mjs'
import { COMPANION_MODEL } from '../report.mjs'

const pc = (x) => (x == null || !Number.isFinite(x) ? 'n/a' : `${Math.round(100 * x)}%`)
const ci = (c) => (c && Number.isFinite(c[0]) ? `${Math.round(100 * c[0])}-${Math.round(100 * c[1])}%` : 'n/a')
const pp = (x) => (x == null || !Number.isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${Math.round(100 * x)}`)
const ppci = (c) => `${pp(c[0])} to ${pp(c[1])}`
const f1 = (x) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(1))
const usd = (x) => `$${(x || 0).toFixed(2)}`
const mins = (s) => (s == null ? 'n/a' : `${Math.round(s / 60)} min`)
const title = (id) => MICRO.find((b) => b.id === id)?.title ?? id

function scorecardSection(L, sc, rows) {
  if (sc.index) {
    L.push(`**Quality index: ${f1(sc.index.value)}** (95% interval ${f1(sc.index.ci[0])} to ${f1(sc.index.ci[1])}; 0-100, higher is better; raw weighted mean ${f1(sc.index.raw ?? sc.index.value)}).`)
    L.push('')
    const c = sc.index.components
    L.push(`Made of: brain-mode benchmark success ${pc(c.B)} (weight ${WEIGHTS.B}), direct-mode success ${pc(c.D)} (${WEIGHTS.D}), scripted-conversation ok-rate ${pc(c.C)} (${WEIGHTS.C}), free-play ok-rate ${pc(c.F)} (${WEIGHTS.F}). Missing parts are left out and the weights renormalized, so only compare indexes built from the same parts.`)
    L.push('')
  }
  if (Object.keys(sc.micro).length) {
    L.push('## Action benchmarks')
    L.push('')
    L.push(`Fixed arena state, one order, success read from the server. Brain = the real bot hears the order and decides (${COMPANION_MODEL}). Direct = the same bot code with the actions called straight, no LLM. Brain fails where direct passes = a brain problem; both fail = a skill problem.`)
    L.push('')
    L.push('| benchmark | brain success | 95% CI | direct success | 95% CI | median s to success (brain / direct) | invalid |')
    L.push('|---|---:|---:|---:|---:|---:|---:|')
    for (const b of MICRO) {
      const m = sc.micro[b.id]
      if (!m) continue
      const br = m.brain, di = m.direct
      L.push(`| ${b.title} | ${br ? `${br.k}/${br.n} (${pc(br.rate)})` : '-'} | ${br ? ci(br.ci) : '-'} | ${di ? `${di.k}/${di.n} (${pc(di.rate)})` : '-'} | ${di ? ci(di.ci) : '-'} | ${br?.medianTimeS ?? '-'} / ${di?.medianTimeS ?? '-'} | ${(br?.invalid || 0) + (di?.invalid || 0) || ''} |`)
    }
    const pb = sc.microPooled.brain, pd = sc.microPooled.direct
    L.push(`| **mean over benchmarks** | **${pc(pb?.rate)}** (${pb?.trials ?? 0} trials) | ${pb?.ci ? ci(pb.ci) : ''} | **${pc(pd?.rate)}** (${pd?.trials ?? 0} trials) | ${pd?.ci ? ci(pd.ci) : ''} | | |`)
    L.push('')
    const fails = rows.filter((r) => r.suite === 'micro' && !r.success && !r.invalid)
    if (fails.length) {
      L.push('<details><summary>Failed trials</summary>')
      L.push('')
      for (const r of fails) L.push(`- ${r.bench} ${r.mode} #${r.rep}${r.refLabel && r.refLabel !== 'run' ? ` [${r.refLabel}]` : ''}: ${r.detail ?? `value ${r.value}`}; actions: ${(r.actions || []).join(', ') || 'none'}${r.chat?.length ? `; said: "${r.chat.slice(0, 3).join(' / ').slice(0, 160)}"` : ''}`)
      L.push('')
      L.push('</details>')
      L.push('')
    }
  }
  if (sc.convo) {
    const c = sc.convo
    L.push('## Scripted conversations')
    L.push('')
    L.push(`The player is a fixed script (same lines every run); Opus labels the companion's response to each player line. Lines that need no reply ("nice", "ok", "jk") are ok when she stays quiet; a question or order with no response is off without asking the judge.`)
    L.push('')
    L.push(`**Off-rate per player line: ${pc(c.rate)}** (${c.k} of ${c.n}; 95% CI ${ci(c.ci)}, widened by the between-session design effect ${f1(c.deff)}).`)
    L.push('')
    L.push('| line kind | lines | off | off-rate |')
    L.push('|---|---:|---:|---:|')
    for (const [k, g] of Object.entries(c.byNeeds)) L.push(`| ${k} | ${g.n} | ${g.off} | ${pc(g.off / g.n)} |`)
    L.push('')
    L.push(`Per session: ${c.perSession.map((s) => `${s.id} ${pc(s.rate)}`).join(', ')}.`)
    L.push('')
    L.push(`Off by category: ${Object.entries(c.byCat).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}.`)
    L.push('')
    const offs = []
    for (const r of rows.filter((x) => x.suite === 'convo' && x.labels)) for (const l of r.labels.labels) if (l.label === 'off') offs.push({ r, l })
    offs.sort((a, b) => b.l.severity - a.l.severity)
    if (offs.length) {
      L.push('<details><summary>Off responses</summary>')
      L.push('')
      for (const { r, l } of offs.slice(0, 40)) L.push(`- ${r.id} ${l.id} "${l.text}" -> ${l.chat?.length ? `"${l.chat.join(' / ').slice(0, 140)}"` : '(no chat)'}${l.actions?.length ? ` [${l.actions.join(', ')}]` : ''}: **${l.category}** s${l.severity}. ${l.reason}`)
      L.push('')
      L.push('</details>')
      L.push('')
    }
  }
  if (sc.freeplay) {
    const f = sc.freeplay
    L.push('## Free play (LLM player)')
    L.push('')
    L.push('The original scenarios with the Haiku-driven player, each repeated. Player randomness makes these noisy; they are context, not the headline.')
    L.push('')
    L.push('| scenario | runs | off-rate mean (range) | off per min mean (range) |')
    L.push('|---|---:|---:|---:|')
    for (const [id, s] of Object.entries(f.byScenario)) L.push(`| ${id} | ${s.reps} | ${pc(s.offRate.mean)} (${pc(s.offRate.min)}-${pc(s.offRate.max)}) | ${f1(s.offPerMin.mean)} (${f1(s.offPerMin.min)}-${f1(s.offPerMin.max)}) |`)
    L.push(`| **all** | ${f.sessions.length} | **${pc(f.offRate.mean)}** (${pc(f.offRate.min)}-${pc(f.offRate.max)}) | **${f1(f.offPerMin.mean)}** (${f1(f.offPerMin.min)}-${f1(f.offPerMin.max)}) |`)
    L.push('')
  }
}

export function compareSection(L, { labelA, labelB, A, B, cmp, separateRuns = false }) {
  L.push(`## Paired comparison: ${labelA} -> ${labelB}`)
  L.push('')
  L.push('Deltas are B minus A in percentage points with a 95% interval. **real** = the interval excludes 0; anything else is inside the noise. For success rates up is better; for off-rates down is better.')
  L.push('')
  if (cmp.index) L.push(`**Quality index: ${f1(cmp.index.a)} -> ${f1(cmp.index.b)} (${cmp.index.delta >= 0 ? '+' : ''}${f1(cmp.index.delta)}, 95% CI ${f1(cmp.index.ci[0])} to ${f1(cmp.index.ci[1])})${cmp.index.real ? ' **real**' : ' within noise'}${cmp.index.comparable ? '' : ' (not comparable: different parts)'}.**`)
  L.push('')
  L.push('| metric | A | B | delta (pp) | 95% CI | |')
  L.push('|---|---:|---:|---:|---:|---|')
  for (const [mode, d] of Object.entries(cmp.pooled || {})) L.push(`| **mean benchmark success (${mode}, ${d.benches} benchmarks)** | ${pc(d.a)} | ${pc(d.b)} | ${pp(d.delta)} | ${ppci(d.ci)} | ${d.real ? '**real**' : ''} |`)
  const vol = (id) => MICRO.find((b) => b.id === id)?.volatile
  for (const [id, m] of Object.entries(cmp.micro)) for (const [mode, d] of Object.entries(m)) L.push(`| ${title(id)} (${mode}) success${vol(id) ? ' (volatile)' : ''} | ${pc(d.a)} | ${pc(d.b)} | ${pp(d.delta)} | ${ppci(d.ci)} | ${d.real ? (vol(id) && separateRuns ? 'real? (volatile, separate runs)' : '**real**') : ''} |`)
  if (cmp.convo) L.push(`| scripted conversation off-rate | ${pc(cmp.convo.a)} | ${pc(cmp.convo.b)} | ${pp(cmp.convo.delta)} | ${ppci(cmp.convo.ci)} | ${cmp.convo.real ? '**real**' : ''} |`)
  if (cmp.freeplay) L.push(`| free-play off-rate | ${pc(cmp.freeplay.a)} | ${pc(cmp.freeplay.b)} | ${pp(cmp.freeplay.delta)} | ${ppci(cmp.freeplay.ci)} | ${cmp.freeplay.real ? '**real**' : ''} |`)
  L.push('')
  if (separateRuns) {
    L.push('These are two SEPARATE runs: conditions that drift over hours (API latency, box load) are not controlled and the intervals cover only within-run noise. Confirm a delta that matters with an interleaved `--compare <refA> <refB>`.')
    L.push('')
  }
}

function costSection(L, config, byRef) {
  const total = Object.values(byRef).reduce((a, s) => a + s.cost.total, 0)
  const comp = Object.values(byRef).reduce((a, s) => a + s.cost.companion, 0)
  const judge = Object.values(byRef).reduce((a, s) => a + s.cost.judge, 0)
  const player = Object.values(byRef).reduce((a, s) => a + s.cost.player, 0)
  const ss = config.suiteSeconds || {}
  L.push('## Cost and time')
  L.push('')
  L.push(`Companion (${COMPANION_MODEL}) ${usd(comp)}, free-play player (Haiku) ${usd(player)}, judge (Opus 5.5) ${usd(judge)}. **Total ${usd(total)}** (list prices from token usage).`)
  L.push('')
  L.push(`Wall time ${mins(config.wallSeconds)}: micro ${mins(ss.micro)}, scripted conversations ${mins(ss.convo)}, free play ${mins(ss.freeplay)}, judge tail ${mins(ss.judgeTail)}.`)
  L.push('')
}

export function writeScorecardReport(file, { config, byRef, cmp, rows }) {
  const L = []
  const refs = config.refs
  L.push(`# Companion quality scorecard: ${path.basename(path.dirname(file))}`)
  L.push('')
  L.push(`Bot code: ${refs.map((r) => `${r.label === 'run' ? '' : `${r.label} = `}${r.ref} (${r.sha.slice(0, 9)})`).join(', ')}. ${config.quick ? 'Quick subset.' : (config.cfg?.suites?.length === 3 ? 'Full scorecard.' : `Partial run (suites: ${config.cfg?.suites?.join(', ')}).`)} Companion Sui on ${COMPANION_MODEL}; judge claude-opus-5-5.`)
  L.push('')
  L.push('How to read: every rate has a 95% interval. A change between two scorecards is real only if it falls outside the interval; use `--compare <refA> <refB>` (same worlds, scripts and seeds, interleaved) for a proper paired delta.')
  L.push('')
  if (cmp) compareSection(L, { labelA: `A (${refs[0].ref})`, labelB: `B (${refs[1].ref})`, A: byRef.A, B: byRef.B, cmp })
  for (const R of refs) {
    if (refs.length > 1) { L.push(`# ${R.label}: ${R.ref}`); L.push('') }
    scorecardSection(L, byRef[R.label], rows.filter((r) => r.refLabel === R.label))
  }
  costSection(L, config, byRef)
  L.push('Files: `results.jsonl` (every trial), `scorecard.json`, `micro/<bench>/<mode>-<rep>/` (result.json + companion logs), `convo/<script>-<rep>/` (transcript.txt, labels.json), `freeplay/<scenario>-<rep>/`.')
  fs.writeFileSync(file, L.join('\n') + '\n')
}

export function writeCompareReport(file, args) {
  const L = [`# Scorecard comparison`, '']
  compareSection(L, { separateRuns: true, ...args })
  fs.writeFileSync(file, L.join('\n') + '\n')
}
