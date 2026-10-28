// scripts/quality-eval/goals/rescore.mjs: re-score a goals-harness run with
// the current scenarios and scorer, without calling the model again, so a
// before and an after run are always judged by the same code.
//
//   node scripts/quality-eval/goals/rescore.mjs DIR [DIR ...]
//
// Rewrites DIR/summary.md (runs.jsonl is left as it is).
import fs from 'node:fs'
import path from 'node:path'
import { SCENARIOS } from './scenarios.mjs'
import { scoreRun, renderSummary } from './score.mjs'

for (const dir of process.argv.slice(2)) {
  const rows = fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  for (const row of rows) {
    const sc = SCENARIOS[row.game]?.[row.scenario]
    if (sc) row.score = scoreRun(row, sc)
  }
  const spent = rows.reduce((a, r) => Math.max(a, Number(r.spent ?? r.totalSpent ?? 0) || 0), 0)
  const head = fs.existsSync(path.join(dir, 'summary.md')) ? fs.readFileSync(path.join(dir, 'summary.md'), 'utf8') : ''
  const model = /Model (\S+),/.exec(head)?.[1]
  const hops = /hops\/step (\d+)/.exec(head)?.[1]
  const spend = Number(/spend \$([\d.]+)/.exec(head)?.[1] ?? spent)
  fs.writeFileSync(path.join(dir, 'summary.md'), renderSummary(rows, { model, hops, spent: spend }))
  console.log(`rescored ${rows.length} runs -> ${path.join(dir, 'summary.md')}`)
}
