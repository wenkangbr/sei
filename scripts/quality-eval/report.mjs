#!/usr/bin/env node
// scripts/quality-eval/report.mjs: turn judged sessions into summary.md and
// summary.json.
//
//   node scripts/quality-eval/report.mjs <outDir>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSession, itemContext } from './transcript.mjs'
import { CATEGORIES, JUDGE_MODEL } from './judge.mjs'

// USD per million tokens. Haiku 5.5 and Opus 5.5 list prices (mirrors
// sei-proxy src/anthropic/pricing.ts; Haiku <=100k-token prompt tier).
export const PRICES = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50, cw: 0.125, cr: 0.01 },
  'claude-opus-5-5': { in: 4, out: 20, cw: 5, cr: 0.20 },
  // OpenAI list prices (developers.openai.com/api/docs/pricing, read
  // 261017); cached input is billed as cache_read. No write premium.
  'gpt-6-luna': { in: 0.10, out: 0.50, cw: 0.10, cr: 0.01 },
  'gpt-5.6-luna': { in: 0.20, out: 1.20, cw: 0.20, cr: 0.02 },
  'gpt-6-sol': { in: 2.00, out: 10.00, cw: 2.00, cr: 0.20 },
  'gpt-6.1-sol': { in: 2.00, out: 10.00, cw: 2.00, cr: 0.10 },
}

/**
 * The companion's model for cost and labels: QE_LLM_MODEL when the run uses
 * another provider (companion.mjs QE_LLM_*), else Haiku 5.5.
 */
export const COMPANION_MODEL = (process.env.QE_LLM_PROVIDER && process.env.QE_LLM_MODEL) || 'claude-haiku-5-5'

const WEB_SEARCH_USD = 0.01  // per Anthropic server web_search request

export function costOf(model, u = {}) {
  const p = PRICES[model]
  if (!p) return NaN // an unpriced model must not read as free
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out +
    (u.cache_creation_input_tokens || 0) * p.cw + (u.cache_read_input_tokens || 0) * p.cr) / 1e6
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a')
const usd = (x) => `$${x.toFixed(2)}`
const fmtT = (t, start) => { const s = Math.max(0, Math.round((t - start) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

export async function writeReport(outDir) {
  const sessRoot = path.join(outDir, 'sessions')
  const ids = fs.existsSync(sessRoot) ? fs.readdirSync(sessRoot).sort() : []
  const rows = []
  const all = []        // {sess, item, label}
  const actionAgg = {}  // name -> {n, ok, fail, reasons}
  const counters = { stuck: 0, deaths: 0, player_msgs: 0, unanswered: 0, replied: 0, reply_ms_total: 0, llm_turns: 0, silent_turns: 0 }
  const cost = { companion: 0, player: 0, judge: 0, web: 0 }
  let minutes = 0
  let judgedMinutes = 0

  for (const id of ids) {
    const dir = path.join(sessRoot, id)
    if (!fs.existsSync(path.join(dir, 'meta.json'))) { rows.push({ id, error: fs.existsSync(path.join(dir, 'error.txt')) ? fs.readFileSync(path.join(dir, 'error.txt'), 'utf8').split('\n')[0] : 'no session' }); continue }
    const sess = loadSession(dir)
    const labelsFile = path.join(dir, 'labels.json')
    const judged = fs.existsSync(labelsFile) ? JSON.parse(fs.readFileSync(labelsFile, 'utf8')) : null
    const byId = new Map((judged?.labels ?? []).map((l) => [l.id, l]))
    const row = { id, title: sess.meta.title, minutes: sess.meta.minutes, items: sess.items.length, off: 0, byType: {}, byCat: {} }
    for (const it of sess.items) {
      const l = byId.get(it.id)
      if (!l) continue
      all.push({ sess, item: it, label: l })
      const bt = (row.byType[it.type] ??= { n: 0, off: 0 })
      bt.n++
      if (l.label === 'off') { row.off++; bt.off++; row.byCat[l.category] = (row.byCat[l.category] || 0) + 1 }
    }
    row.judged = !!judged
    minutes += Number(sess.meta.minutes || 0)
    if (judged) judgedMinutes += Number(sess.meta.minutes || 0)
    const st = sess.lastStats
    if (st) {
      for (const [name, a] of Object.entries(st.actions || {})) {
        const g = (actionAgg[name] ??= { n: 0, ok: 0, fail: 0, reasons: {} })
        g.n += a.n; g.ok += a.ok; g.fail += a.fail
        for (const [r, c] of Object.entries(a.reasons || {})) g.reasons[r] = (g.reasons[r] || 0) + c
      }
      for (const k of Object.keys(counters)) counters[k] += st.counters?.[k] || 0
      row.stats = st.counters
    }
    cost.companion += costOf(COMPANION_MODEL, sess.usage)
    cost.web += (sess.usage.web_search_requests || 0) * WEB_SEARCH_USD
    cost.player += costOf('claude-haiku-5-5', sess.meta.usage?.player)
    if (judged) cost.judge += costOf(JUDGE_MODEL, judged.usage)
    row.cost = costOf(COMPANION_MODEL, sess.usage) + costOf('claude-haiku-5-5', sess.meta.usage?.player) + (judged ? costOf(JUDGE_MODEL, judged.usage) : 0)
    rows.push(row)
  }

  const total = all.length
  const totalOff = all.filter((x) => x.label.label === 'off').length
  const catCounts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]))
  const typeCounts = {}
  for (const x of all) {
    const tc = (typeCounts[x.item.type] ??= { n: 0, off: 0 })
    tc.n++
    if (x.label.label === 'off') { catCounts[x.label.category]++; tc.off++ }
  }
  const worst = all.filter((x) => x.label.label === 'off')
    .sort((a, b) => b.label.severity - a.label.severity || a.item.t - b.item.t)
  // Spread the top 10 across sessions: at most 3 per session.
  const top = []
  const perSess = {}
  for (const w of worst) {
    const k = w.sess.meta.scenario
    if ((perSess[k] || 0) >= 3) continue
    // One entry per moment: skip items within 30s of one already picked.
    if (top.some((x) => x.sess === w.sess && Math.abs(x.item.t - w.item.t) < 30000)) continue
    perSess[k] = (perSess[k] || 0) + 1
    top.push(w)
    if (top.length >= 10) break
  }
  const totalCost = cost.companion + cost.player + cost.judge + cost.web

  const L = []
  L.push(`# Companion quality: Minecraft, ${path.basename(outDir)}`)
  L.push('')
  L.push(`Companion: Sui on claude-haiku-5-5 (real bot code, BYOK test key). Judge: ${JUDGE_MODEL}. ${rows.filter((r) => !r.error).length} sessions, ${minutes} min of play.`)
  L.push('')
  // Off items per minute of play: the off-rate is a share of what she DID, so
  // a quieter, slower companion can lower it without being better company.
  const offPerMin = judgedMinutes ? totalOff / judgedMinutes : null
  L.push(`**Off-rate: ${pct(totalOff, total)}** (${totalOff} of ${total} judged items: companion lines, actions, and silences). **Off per minute: ${offPerMin == null ? '-' : offPerMin.toFixed(2)}** (${totalOff} over ${judgedMinutes} judged min; items per minute ${judgedMinutes ? (total / judgedMinutes).toFixed(2) : '-'}).`)
  L.push('')
  L.push('| item type | items | off | off-rate |')
  L.push('|---|---:|---:|---:|')
  for (const [t, c] of Object.entries(typeCounts)) L.push(`| ${t} | ${c.n} | ${c.off} | ${pct(c.off, c.n)} |`)
  L.push('')
  L.push('## By scenario')
  L.push('')
  L.push('| scenario | items | off | off-rate | off/min | top category | cost |')
  L.push('|---|---:|---:|---:|---:|---|---:|')
  for (const r of rows) {
    if (r.error) { L.push(`| ${r.id} | - | - | failed: ${r.error.slice(0, 80)} | | | |`); continue }
    const topCat = Object.entries(r.byCat).sort((a, b) => b[1] - a[1])[0]
    L.push(`| ${r.title} | ${r.items} | ${r.off} | ${r.judged ? pct(r.off, r.items) : 'not judged'} | ${r.judged && r.minutes ? (r.off / r.minutes).toFixed(2) : '-'} | ${topCat ? `${topCat[0]} (${topCat[1]})` : '-'} | ${usd(r.cost)} |`)
  }
  L.push('')
  L.push('## Off items by category')
  L.push('')
  L.push('| category | off items | share of all items |')
  L.push('|---|---:|---:|')
  for (const [c, n] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) if (n) L.push(`| ${c} | ${n} | ${pct(n, total)} |`)
  L.push('')
  L.push('## 10 worst moments')
  L.push('')
  top.forEach((w, i) => {
    L.push(`${i + 1}. **${w.sess.meta.title} ${fmtT(w.item.t, w.sess.start)} [${w.item.id}] ${w.label.category}, severity ${w.label.severity}.** ${w.label.reason}`)
    L.push('')
    L.push('   ```')
    for (const ln of itemContext(w.sess, w.item, 5).split('\n')) L.push('   ' + ln)
    L.push('   ```')
    L.push('')
  })
  L.push('## Action success (actionStats)')
  L.push('')
  L.push('| action | calls | ok | fail | success | fail reasons |')
  L.push('|---|---:|---:|---:|---:|---|')
  const aggAll = { n: 0, ok: 0, fail: 0 }
  for (const [name, a] of Object.entries(actionAgg).sort((x, y) => y[1].n - x[1].n)) {
    aggAll.n += a.n; aggAll.ok += a.ok; aggAll.fail += a.fail
    const rs = Object.entries(a.reasons).sort((x, y) => y[1] - x[1]).map(([r, c]) => `${r} ${c}`).join(', ')
    L.push(`| ${name} | ${a.n} | ${a.ok} | ${a.fail} | ${pct(a.ok, a.ok + a.fail)} | ${rs} |`)
  }
  L.push(`| **all** | ${aggAll.n} | ${aggAll.ok} | ${aggAll.fail} | ${pct(aggAll.ok, aggAll.ok + aggAll.fail)} | |`)
  L.push('')
  L.push(`Bot counters: ${counters.llm_turns} LLM turns (${counters.silent_turns} silent), ${counters.player_msgs} player messages, ${counters.replied} replied (avg ${counters.replied ? (counters.reply_ms_total / counters.replied / 1000).toFixed(1) : '-'}s), ${counters.unanswered} unanswered past 20s, ${counters.stuck} stuck events, ${counters.deaths} companion deaths.`)
  L.push('')
  L.push('## Cost')
  L.push('')
  L.push(`Companion (Haiku) ${usd(cost.companion)}, player bot (Haiku) ${usd(cost.player)}, judge (Opus) ${usd(cost.judge)}, web search ${usd(cost.web)}. **Total ${usd(totalCost)}.** Estimated from token usage at list prices.`)
  L.push('')
  L.push('Per-session files: `sessions/<id>/transcript.txt` (what the judge read), `labels.json`, `companion.events.jsonl`, `player.events.jsonl`, `companion.raw.log`.')
  fs.writeFileSync(path.join(outDir, 'summary.md'), L.join('\n') + '\n')
  const summary = { date: path.basename(outDir), off_rate: total ? totalOff / total : null, off_per_min: offPerMin, judged_minutes: judgedMinutes, items: total, off: totalOff, by_type: typeCounts, by_category: catCounts, sessions: rows.map(({ byType, ...r }) => r), actions: actionAgg, counters, cost: { ...cost, total: totalCost } }
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
  return summary
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await writeReport(path.resolve(process.argv[2]))
  console.log(`off-rate ${s.off_rate == null ? 'n/a' : (100 * s.off_rate).toFixed(1) + '%'}, off/min ${s.off_per_min == null ? 'n/a' : s.off_per_min.toFixed(2)}, cost $${s.cost.total.toFixed(2)}`)
}
