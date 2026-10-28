#!/usr/bin/env node
// scripts/quality-eval/combat-repro.mjs: direct-mode (no LLM) attackEntity
// reproductions on the eval server, for the night-combat free-play failures
// (quality pass 18, 261019): "couldn't catch zombie", "lost sight of zombie"
// after enough hits to kill it, a few hits then a timeout on a zombie standing
// next to the player. Each trial boots a fresh companion in direct mode from
// --repo, sets up the case, calls attackEntity straight and records the result
// plus server ground truth (is the mob still alive).
//
//   node scripts/quality-eval/combat-repro.mjs --repo <bot repo> [--cases a,b] [--reps N] [--out file.jsonl]
//
// Cases:
//   beach_zombie   the combat_night free-play spot on the seed terrain (sand,
//                  water, grass slopes): a zombie summoned next to the player,
//                  she starts 5 blocks away with a stone sword
//   beach_two      the same with two zombies on the player
//
// Owns the server for its run (reset, start, stop): book it in
// ~/suisei/eval/QUEUE.md first.
import fs from 'node:fs'
import path from 'node:path'
import { serverCtl, cmds, entityCount } from './lib/server.mjs'
import { connectPlayer } from './lib/player.mjs'
import { startCompanion, companionName, PLAYER } from './lib/companionProc.mjs'
import { WORLD_RULES, playersReset } from './bench/arena.mjs'

const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const REPO = path.resolve(opt('repo', process.cwd()))
const REPS = Number(opt('reps', 3))
const OUT = opt('out', null)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[combat ${new Date().toISOString().slice(11, 19)}]`, ...a)

// The free-play start (combat_night-03-B): player and companion on the beach.
const BEACH_P = { x: 176, y: 65, z: -2 }
const BEACH_S = { x: 175, y: 64, z: 3 }

const CASES = {
  beach_zombie: { beach: true, zombies: ['~5 ~ ~3'] },
  beach_two: { beach: true, zombies: ['~-5 ~ ~4', '~4 ~ ~-5'] },
}

async function main() {
  const which = (opt('cases', null) || Object.keys(CASES).join(',')).split(',').filter(Boolean)
  const bot = companionName()
  log(`repo ${REPO}, cases ${which.join(',')}, reps ${REPS}`)
  serverCtl('reset')
  serverCtl('start')
  const rows = []
  let pbot
  try {
    pbot = await connectPlayer()
    await cmds(WORLD_RULES)
    const gone = []
    pbot.on('entityDead', (e) => { if (e?.name === 'zombie') gone.push({ t: Date.now(), id: e.id, ev: 'dead' }) })
    pbot.on('entityGone', (e) => { if (e?.name === 'zombie') gone.push({ t: Date.now(), id: e.id, ev: 'gone' }) })
    for (let rep = 1; rep <= REPS; rep++) {
      for (const id of which) {
        const c = CASES[id]
        if (!c) throw new Error(`unknown case ${id}`)
        // The beach lies inside the arena's box, so no arena rebuild here.
        await cmds(['kill @e[type=!player]', 'time set 14000', 'weather clear'])
        const sessDir = path.join('/tmp', `qe-combat-${id}-${rep}`)
        let comp
        try {
          comp = await startCompanion({ sessDir, mode: 'direct', botRepo: REPO, tag: `qe-combat-${id}` })
        } catch (e) { rows.push({ id, rep, success: false, error: `boot: ${e.message}` }); continue }
        let row
        try {
          const pAt = BEACH_P
          const sAt = BEACH_S
          await cmds([
            ...playersReset([PLAYER, bot]),
            `tp ${PLAYER} ${pAt.x + 0.5} ${pAt.y} ${pAt.z + 0.5}`,
            `tp ${bot} ${sAt.x + 0.5} ${sAt.y} ${sAt.z + 0.5}`,
            `give ${bot} stone_sword`,
            `effect give ${PLAYER} resistance 120 4 true`,
          ])
          await sleep(2500)
          gone.length = 0
          await cmds(c.zombies.map((z) => `execute at ${PLAYER} run summon zombie ${z}`))
          await sleep(1500)
          const t0 = Date.now()
          const r = await comp.exec('attackEntity', { entity: 'zombie', times: 8 }, { timeoutMs: 60000 })
          const ms = Date.now() - t0
          await sleep(800)
          const alive = await entityCount('@e[type=zombie]')
          const pr = await comp.probe()
          row = { id, rep, result: r.result ?? r.error, ms, alive, hp: pr?.hp, pos: pr?.pos, gone: gone.map((g) => `${g.ev}@${g.t - t0}`).join(' '), success: alive < c.zombies.length }
        } catch (e) {
          row = { id, rep, success: false, error: String(e?.message || e) }
        } finally {
          await comp.stop().catch(() => {})
        }
        rows.push(row)
        log(JSON.stringify(row))
        if (OUT) fs.appendFileSync(OUT, JSON.stringify({ repo: REPO, ...row }) + '\n')
      }
    }
  } finally {
    try { pbot?.quit() } catch {}
    try { serverCtl('stop') } catch {}
  }
  const by = {}
  for (const r of rows) { (by[r.id] ??= []).push(r) }
  for (const [id, rs] of Object.entries(by)) {
    log(`${id}: ${rs.filter((r) => r.success).length}/${rs.length} killed at least one`)
  }
  process.exit(0)
}

main().catch((e) => { console.error(e); try { serverCtl('stop') } catch {}; process.exit(1) })
