// scripts/quality-eval/bench/runner.mjs: one micro-benchmark trial.
//
// The arena is rebuilt, a FRESH companion process joins (fresh memory, so a
// trial never remembers the last one), both bots are reset and placed, and
// then the order is given (brain) or the actions are called (direct). The
// benchmark's evaluate() decides success from server-side ground truth.
import fs from 'node:fs'
import path from 'node:path'
import { startCompanion, companionName, PLAYER } from '../lib/companionProc.mjs'
import { cmds, query, itemCount, entityCount } from '../lib/server.mjs'
import { walkTo, distTo, countBlocks } from '../lib/player.mjs'
import { arenaReset, playersReset } from './arena.mjs'
import { COMPANION_MODEL, costOf } from '../report.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DIRECT_GAP_MS = 800
const DIRECT_GRACE_MS = 10000

/** Wait until the companion has been quiet (no chat, no LLM turn) for quietMs. */
export async function waitQuiet(comp, { minMs = 4000, maxMs = 15000, quietMs = 3000 } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    await sleep(250)
    const lastNoisy = [...comp.log].reverse().find((e) => e.kind === 'chat_out' || e.kind === 'llm_turn')
    if (Date.now() - t0 >= minMs && (!lastNoisy || Date.now() - lastNoisy.t >= quietMs)) return
  }
}

export function llmUsage(events, fromT = 0) {
  const u = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, turns: 0 }
  for (const e of events) {
    if (e.kind !== 'llm_turn' || e.t < fromT) continue
    u.turns++
    for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) u[k] += e.usage?.[k] || 0
  }
  return u
}

export async function runMicroTrial(bench, { mode, rep, pbot, botRepo, outDir, ref = 'HEAD' }) {
  const bot = companionName()
  const trialDir = path.join(outDir, `${mode}-${String(rep).padStart(2, '0')}${ref !== 'HEAD' ? `-${ref.replace(/[^\w.-]+/g, '_')}` : ''}`)
  fs.mkdirSync(trialDir, { recursive: true })
  await cmds([...arenaReset(), ...(bench.world || [])])
  let comp
  try {
    comp = await startCompanion({ sessDir: trialDir, mode, botRepo, tag: `qe-${bench.id}` })
  } catch (e) {
    const r = { bench: bench.id, mode, rep, ref, success: false, invalid: true, detail: `boot failed: ${e.message}` }
    fs.writeFileSync(path.join(trialDir, 'result.json'), JSON.stringify(r, null, 2))
    return r
  }
  let botDied = false, playerDied = false
  const onMsg = (msg) => {
    const t = msg.toString()
    if (new RegExp(`^${bot} (was|died|drowned|fell|burned|blew|hit|suffocated|starved|walked|tried)`).test(t)) botDied = true
  }
  const onDeath = () => { playerDied = true }
  pbot.on('message', onMsg)
  pbot.on('death', onDeath)
  let cancelled = false
  let lastExecEnd = 0
  let directSettledAt = null
  const trace = []
  let heldAtOrder = null
  let traceTimer = null
  const running = new Set()
  const ctx = {
    mode, bot, playerName: PLAYER, pbot, comp,
    itemCount, entityCount,
    cancelled: () => cancelled,
    botDied: () => botDied,
    playerDied: () => playerDied,
    playerHp: () => pbot.health ?? 0,
    say: (text) => pbot.chat(text),
    distToBot: () => distTo(pbot, bot),
    walkTo: (p, o) => walkTo(pbot, p, o),
    countBlocks: (box, m) => countBlocks(pbot, box, m),
    async exec(name, args, o) {
      if (cancelled) return null
      // Back-to-back calls with zero gap race the server's inventory sync
      // (craft returns before the new item lands: "no crafting_table in
      // inventory"). The brain never acts that fast (a turn is 1s+), so
      // direct calls keep a small gap to measure the skill, not the race.
      const gap = DIRECT_GAP_MS - (Date.now() - lastExecEnd)
      if (gap > 0) await sleep(gap)
      if (cancelled) return null
      const h = comp.execStart(name, args)
      running.add(h.id)
      const tm = setTimeout(() => comp.abort(h.id), o?.timeoutMs ?? 60000)
      try { return await h.done } finally { clearTimeout(tm); running.delete(h.id); lastExecEnd = Date.now() }
    },
    execStart(name, args) { const h = comp.execStart(name, args); running.add(h.id); h.done.then(() => running.delete(h.id)); return h },
    abort: (id) => comp.abort(id),
    async pollUntil(fn, timeoutMs, { everyMs = 1000 } = {}) {
      const t0 = Date.now()
      let last = { success: false }
      while (Date.now() - t0 < timeoutMs) {
        last = await fn()
        if (last.success || last.done) return { ...last, timeMs: Date.now() - t0 }
        // Direct mode: once the action calls have returned, nothing else
        // will happen; a short grace (drops landing, smelting ticks) and stop
        // instead of sitting out the full timeout.
        if (directSettledAt && Date.now() - directSettledAt > DIRECT_GRACE_MS) {
          return { ...last, success: false, timeMs: Date.now() - t0, detail: last.detail ?? `actions returned without success (value ${last.value})` }
        }
        await sleep(everyMs)
      }
      return { ...last, success: false, timeMs: timeoutMs, detail: last.detail ?? `timeout after ${timeoutMs / 1000}s (value ${last.value})` }
    },
  }
  let result
  try {
    await cmds([...playersReset([PLAYER, bot]), ...bench.start({ bot, playerName: PLAYER })])
    if (mode === 'brain') await waitQuiet(comp)
    else await sleep(1500)
    // Commands that must land at order time (enemies, damage), not before
    // the brain-mode settle period.
    if (bench.atOrder) await cmds(bench.atOrder({ bot, playerName: PLAYER }))
    // What the companion holds at order time (server truth), for diagnosis.
    const heldOut = await query(`data get entity ${bot} SelectedItem.id`, { expect: /has the following|Found no elements|No entity/ })
    heldAtOrder = (/"?minecraft:([\w_]+)"?/.exec(heldOut) || [])[1] || 'empty'
    const tOrder = Date.now()
    // Per-second trace (player hp/food, companion distance) for diagnosing
    // fights and follows after the fact.
    traceTimer = setInterval(() => {
      try { trace.push([Math.round((Date.now() - tOrder) / 1000), Math.round(pbot.health ?? -1), Math.round(pbot.food ?? -1), Number(distTo(pbot, bot).toFixed(1))]) } catch {}
    }, 1000)
    if (mode === 'brain') pbot.chat(bench.order)
    else Promise.resolve(bench.direct(ctx)).catch(() => {}).finally(() => { directSettledAt = Date.now() })
    const r = await bench.evaluate(ctx)
    const ev = comp.log.filter((e) => e.t >= tOrder)
    const calls = ev.filter((e) => e.kind === 'action_call' && !['thinking', 'say', 'remember', 'forget', 'setGoal', 'clearGoal', 'end_loop'].includes(e.name))
    const usage = llmUsage(comp.log)
    result = {
      bench: bench.id, mode, rep, ref, success: !!r.success, invalid: !!r.invalid,
      value: r.value ?? null, detail: r.detail ?? null, timeMs: r.timeMs ?? (Date.now() - tOrder),
      bootMs: comp.bootMs,
      firstActionMs: calls[0] ? calls[0].t - tOrder : null,
      actions: calls.map((c) => c.name),
      chat: ev.filter((e) => e.kind === 'chat_out').map((e) => e.text).slice(0, 12),
      llm: usage, costUsd: costOf(COMPANION_MODEL, usage),
      heldAtOrder,
      trace, // [s since order, player hp, player food, companion distance]
    }
  } catch (e) {
    result = { bench: bench.id, mode, rep, ref, success: false, invalid: true, detail: `trial crashed: ${e?.message}` }
  } finally {
    cancelled = true
    clearInterval(traceTimer)
    for (const id of running) comp.abort(id)
    pbot.off('message', onMsg)
    pbot.off('death', onDeath)
    try { pbot.pathfinder.setGoal(null) } catch {}
    await comp.stop().catch(() => {})
  }
  fs.writeFileSync(path.join(trialDir, 'result.json'), JSON.stringify(result, null, 2))
  return result
}
