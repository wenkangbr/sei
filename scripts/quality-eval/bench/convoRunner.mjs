// scripts/quality-eval/bench/convoRunner.mjs: play one scripted conversation
// (bench/convo.mjs) against a fresh brain-mode companion, then build its
// response units: one per player line, holding everything the companion said
// and did until the next player line.
import fs from 'node:fs'
import path from 'node:path'
import { startCompanion, companionName, PLAYER } from '../lib/companionProc.mjs'
import { cmds } from '../lib/server.mjs'
import { walkTo, distTo, connectPlayer } from '../lib/player.mjs'
import { arenaReset, playersReset } from './arena.mjs'
import { waitQuiet } from './runner.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TAIL_MS = 20000

/**
 * 261018 (pass 16): put the companion's body in its scenario state (items,
 * position, time of day) BEFORE the companion joins. The scenario's `give`
 * and `tp` need the bot online, and they used to run after the companion had
 * spawned, so her first-contact greeting was generated from the previous
 * session's spot with an empty inventory ("i just spawned on a beach and i
 * have zero items", then an iron sword and bread appeared). A stand-in client
 * logs in under her name, the commands run, and it logs out; the server saves
 * that player data, and the companion spawns into it.
 */
async function stageBody(bot, script) {
  const stand = await connectPlayer({ username: bot })
  try {
    await cmds([...playersReset([PLAYER, bot]), ...script.start({ bot, playerName: PLAYER })])
    // Let the given items reach the client, then the save on logout has them.
    await sleep(1500)
  } finally {
    const ended = new Promise((r) => { stand.once('end', r); setTimeout(r, 5000) })
    try { stand.quit() } catch {}
    await ended
  }
  await sleep(1000)
}

export async function runConvoSession(script, { rep, pbot, botRepo, outDir, ref = 'HEAD' }) {
  const bot = companionName()
  const sessDir = path.join(outDir, `${script.id}-${String(rep).padStart(2, '0')}${ref !== 'HEAD' ? `-${ref.replace(/[^\w.-]+/g, '_')}` : ''}`)
  fs.mkdirSync(sessDir, { recursive: true })
  const pPath = path.join(sessDir, 'player.events.jsonl')
  fs.writeFileSync(pPath, '')
  const rec = (ev) => fs.appendFileSync(pPath, JSON.stringify({ t: Date.now(), ...ev }) + '\n')
  await cmds([...arenaReset(), ...(script.world || [])])
  await stageBody(bot, script)
  const comp = await startCompanion({ sessDir, mode: 'brain', botRepo, tag: `qe-${script.id}` })
  const onMsg = (msg, position) => {
    if (position === 'chat') return
    const text = msg.toString()
    if (/\b(was slain|died|was shot|drowned|fell|burned|blew up|was killed)\b/.test(text)) rec({ kind: 'death', text })
  }
  pbot.on('message', onMsg)
  const t0wall = Date.now()
  try {
    await waitQuiet(comp)
    rec({ kind: 'session_start', scenario: script.id })
    for (let i = 0; i < script.lines.length; i++) {
      const ln = script.lines[i]
      if (ln.walkBefore) { rec({ kind: 'player_move', move: 'walk_away' }); await walkTo(pbot, ln.walkBefore, { timeoutMs: 15000 }) }
      if (ln.cmd) { await cmds(ln.cmd); for (const c of ln.cmd) rec({ kind: 'server_cmd', cmd: c }) }
      const tLine = Date.now()
      pbot.chat(ln.say)
      rec({ kind: 'player_say', text: ln.say, unit: `U${i + 1}`, needs: ln.needs })
      if (ln.walk) { rec({ kind: 'player_move', move: 'walk_away' }); walkTo(pbot, ln.walk, { timeoutMs: 20000 }).catch(() => {}) }
      if (ln.wait) { await sleep(ln.wait); continue }
      const max = ln.max ?? 20000, after = ln.after ?? 3000
      let replyAt = null
      while (Date.now() - tLine < max) {
        await sleep(200)
        const r = comp.log.find((e) => e.kind === 'chat_out' && e.t > tLine)
        if (r) { replyAt = r.t; break }
      }
      if (replyAt) await sleep(Math.max(0, replyAt + after - Date.now()))
    }
    await sleep(TAIL_MS)
    rec({ kind: 'world', companion_dist: Number(distTo(pbot, bot).toFixed(1)), player_hp: pbot.health })
    rec({ kind: 'session_end' })
  } finally {
    pbot.off('message', onMsg)
    try { pbot.pathfinder.setGoal(null) } catch {}
    await comp.stop().catch(() => {})
  }
  const minutes = Number(((Date.now() - t0wall) / 60000).toFixed(2))
  fs.writeFileSync(path.join(sessDir, 'meta.json'), JSON.stringify({ scenario: script.id, title: script.title, kind: 'convo', minutes, rep, ref, player: PLAYER, companion: bot, usage: { player: {} } }, null, 2))
  return sessDir
}

/**
 * Response units for a played session. Deterministic pre-labels where no
 * judgment is needed: a reply-needing line with no companion chat is off
 * (silence); an order with neither chat nor an action is off (ignored); an
 * acknowledgement with no response is ok.
 */
export function buildUnits(sessDir) {
  const read = (f) => fs.existsSync(path.join(sessDir, f)) ? fs.readFileSync(path.join(sessDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const player = read('player.events.jsonl')
  const comp = read('companion.events.jsonl')
  const says = player.filter((e) => e.kind === 'player_say')
  const end = player.find((e) => e.kind === 'session_end')?.t ?? Infinity
  const units = []
  says.forEach((p, i) => {
    const tEnd = says[i + 1]?.t ?? Math.min(end, p.t + TAIL_MS)
    const inWin = (e) => e.t > p.t && e.t <= tEnd
    const chat = comp.filter((e) => e.kind === 'chat_out' && inWin(e)).map((e) => e.text)
    const actions = comp.filter((e) => e.kind === 'action_call' && inWin(e) && !['thinking', 'say', 'remember', 'forget', 'setGoal', 'clearGoal', 'end_loop'].includes(e.name)).map((e) => e.name)
    const u = { id: p.unit || `U${i + 1}`, t: p.t, text: p.text, needs: p.needs || 'reply', chat, actions, pre: null }
    if (!chat.length && u.needs === 'reply') u.pre = { label: 'off', category: 'silence', severity: 2, reason: 'no reply to a line that needed one' }
    else if (!chat.length && !actions.length && u.needs === 'order') u.pre = { label: 'off', category: 'ignored_player', severity: 2, reason: 'order got neither a reply nor an action' }
    else if (!chat.length && !actions.length && u.needs === 'none') u.pre = { label: 'ok', category: 'none', severity: 0, reason: 'no reply needed' }
    units.push(u)
  })
  return units
}
