// scripts/quality-eval/transcript.mjs: merge one session's companion and
// player event logs into a single timeline, and pull out the items the judge
// labels:
//   L<n>  a line the companion said (one say() call)
//   A<n>  an in-game action the companion took, with its result
//   S<n>  a silence: the player typed something and no companion chat
//         appeared within 20s (actionStats.UNANSWERED_MS)
import fs from 'node:fs'
import path from 'node:path'
import { snapshotsFromRawLog, sensedFromRawLog } from './snapshot.mjs'

export const SILENCE_MS = 20000
// Calls the player cannot see (memory and planning tools). Shown to the judge
// as context only; say() becomes an L item, everything else an A item.
const PRIVATE_CALLS = new Set(['remember', 'forget', 'setGoal', 'clearGoal', 'end_loop'])
// onAction also fires for these bookkeeping pseudo-actions; not in-game actions.
const NOT_ACTIONS = new Set(['thinking', 'say', ...PRIVATE_CALLS])

function readJsonl(p) {
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

const clip = (s, n = 300) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '...' : s }

export function loadSession(sessDir) {
  const meta = fs.existsSync(path.join(sessDir, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(sessDir, 'meta.json'), 'utf8')) : {}
  const comp = readJsonl(path.join(sessDir, 'companion.events.jsonl'))
  const player = readJsonl(path.join(sessDir, 'player.events.jsonl'))
  const start = player.find((e) => e.kind === 'session_start')?.t ?? comp[0]?.t ?? 0
  // Older runs captured no snapshot events; rebuild them from the raw log.
  if (!comp.some((e) => e.kind === 'snapshot')) {
    comp.push(...snapshotsFromRawLog(path.join(sessDir, 'companion.raw.log'), start))
    comp.sort((a, b) => a.t - b.t)
  }
  // 261014: older runs have no per-turn `sensed`; rebuild it from the raw log
  // when its [haiku!] blocks line up one to one with the llm_turn events.
  const turns = comp.filter((e) => e.kind === 'llm_turn')
  if (turns.length && !turns.some((e) => e.sensed)) {
    const back = sensedFromRawLog(path.join(sessDir, 'companion.raw.log'))
    if (back.length === turns.length) turns.forEach((e, i) => { if (back[i]) e.sensed = back[i] })
  }
  const end = player.find((e) => e.kind === 'session_end')?.t ?? Infinity
  const companion = meta.companion || 'Sui'
  const playerName = meta.player || 'Alex'

  const timeline = []
  const items = []
  let nL = 0, nA = 0, nS = 0
  const push = (e) => timeline.push(e)

  // Companion side.
  const openActions = []   // FIFO of A items awaiting a result
  // 261014: an action started before session_start (her first-contact turn
  // starts a gather while the script is still setting up) was dropped, and the
  // judge then read "on it" and the logs that came in as made up. One still
  // running at the start is shown at the start.
  const preStart = []
  const showPreStart = (it) => {
    it.t = start
    it.preStart = true
    items.push(it)
    push({ t: start, kind: 'action', id: it.id, item: it })
  }
  let lastSensedKey = null
  let lastStats = null
  let prevCounters = null
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, turns: 0, web_search_requests: 0 }
  for (const e of comp) {
    if (e.kind === 'llm_turn') {
      const u = e.usage || {}
      for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) usage[k] += u[k] || 0
      usage.web_search_requests += u.server_tool_use?.web_search_requests || 0
      usage.turns++
      if (e.t < start || e.t > end) continue
      // What her prompt showed on the turn she spoke, when it changed since
      // the last line.
      if (e.sensed && (e.calls || []).some((c) => c.name === 'say')) {
        const key = `${e.sensed.inventory}|${e.sensed.doing}`
        if (key !== lastSensedKey) {
          lastSensedKey = key
          push({ t: e.t - 1, kind: 'sensed', text: `inventory ${e.sensed.inventory}; ${e.sensed.doing}` })
        }
      }
      for (const c of e.calls || []) {
        if (c.name === 'say') {
          const text = typeof c.input === 'object' ? c.input?.text : c.input
          const it = { id: `L${++nL}`, type: 'line', t: e.t, text: String(text ?? '') }
          items.push(it)
          push({ t: e.t, kind: 'line', id: it.id, text: it.text })
        } else if (PRIVATE_CALLS.has(c.name)) {
          push({ t: e.t, kind: 'private', text: `${c.name}(${clip(JSON.stringify(c.input), 160)})` })
        }
      }
    } else if (e.kind === 'action_call' && e.name && !NOT_ACTIONS.has(e.name)) {
      if (e.t > end) continue
      const it = { id: `A${++nA}`, type: 'action', t: e.t, name: e.name, args: e.args, result: null, t_result: null }
      if (e.t < start) { preStart.push(it); continue }
      items.push(it)
      openActions.push(it)
      push({ t: e.t, kind: 'action', id: it.id, item: it })
    } else if (e.kind === 'action_result') {
      const p = preStart.findIndex((a) => a.name === e.action)
      if (p >= 0) {
        const it = preStart.splice(p, 1)[0]
        if (e.t < start) continue
        showPreStart(it)
        openActions.push(it)
      }
      const i = openActions.findIndex((a) => a.name === e.action)
      if (i >= 0) {
        const it = openActions.splice(i, 1)[0]
        // The eval's own stop aborts whatever is running; not the bot's fault.
        it.result = e.t > end ? `${e.result} (cut off by the end of the session)` : e.result
        it.t_result = e.t
        push({ t: e.t, kind: 'result', id: it.id, text: `${it.id} ${e.action} -> ${clip(e.result, 240)}` })
      }
    } else if (e.kind === 'chat_out') {
      if (e.t < start || e.t > end + 5000) continue
      push({ t: e.t, kind: 'chat_out', text: e.text })
    } else if (e.kind === 'snapshot') {
      if (e.t < start || e.t > end) continue
      push({ t: e.t, kind: 'snapshot', text: `hp ${e.hp}; holding ${e.holding || 'nothing'}; inventory ${e.inventory || 'empty'}; ${e.time}; near: ${(e.blocks || []).slice(0, 8).join(', ')}; entities: ${(e.entities || []).join(', ') || 'none'}` })
    } else if (e.kind === 'action_stats') {
      lastStats = e.stats
      const c = e.stats?.counters
      if (c && prevCounters && e.t >= start && e.t <= end + 5000) {
        if (c.stuck > prevCounters.stuck) push({ t: e.t, kind: 'event', text: `${companion} got STUCK (${c.stuck - prevCounters.stuck}x since last check)` })
        if (c.deaths > prevCounters.deaths) push({ t: e.t, kind: 'event', text: `${companion} DIED` })
      }
      if (c) prevCounters = c
    } else if (e.kind === 'llm_error') {
      if (e.t < start || e.t > end) continue
      if (!/preempt/.test(e.error)) push({ t: e.t, kind: 'event', text: `companion LLM error: ${clip(e.error, 160)}` })
    } else if (e.kind === 'lifecycle' && e.data?.type === 'error') {
      push({ t: e.t, kind: 'event', text: `companion crashed: ${e.data.error} ${clip(e.data.message, 160)}` })
    }
  }
  for (const it of preStart) { showPreStart(it); openActions.push(it) }
  for (const it of openActions) it.result = '(still running or no result when the session ended)'

  // Player side.
  const playerSays = []
  for (const e of player) {
    if (e.t < start || e.t > end) continue
    if (e.kind === 'player_say') { playerSays.push(e); push({ t: e.t, kind: 'player', text: e.text }) }
    else if (e.kind === 'death') push({ t: e.t, kind: 'event', text: `game: ${e.text}` })
    else if (e.kind === 'player_death') push({ t: e.t, kind: 'event', text: `${playerName} died` })
    else if (e.kind === 'player_move') push({ t: e.t, kind: 'event', text: `${playerName} moves: ${e.move}` })
    else if (e.kind === 'player_hit') push({ t: e.t, kind: 'event', text: `${playerName} hits ${companion}` })
    else if (e.kind === 'server_cmd') push({ t: e.t, kind: 'event', text: `world: ${e.cmd.replace(/^execute at \S+ run /, '').replace(/ ~.*$/, '')} spawned near ${playerName}` })
    else if (e.kind === 'world') push({ t: e.t, kind: 'world', text: `${companion} is ${e.companion_dist ?? '?'} blocks from ${playerName}, holding ${e.companion_held || 'nothing'}; ${playerName} hp ${Math.round(e.player_hp ?? 0)}/20; hostile mobs near ${playerName}: ${(e.mobs_near_player || []).join(', ') || 'none'}` })
  }

  // Silences.
  const outs = comp.filter((e) => e.kind === 'chat_out').map((e) => e.t)
  for (const p of playerSays) {
    if (p.t + SILENCE_MS > end) continue
    const replied = outs.some((t) => t > p.t && t <= p.t + SILENCE_MS)
    if (!replied) {
      const it = { id: `S${++nS}`, type: 'silence', t: p.t + SILENCE_MS, text: p.text }
      items.push(it)
      push({ t: it.t, kind: 'silence', id: it.id, text: `no reply from ${companion} for 20s after "${clip(p.text, 120)}"` })
    }
  }

  // Match chat fragments to say() lines: a say() with no chat in the next
  // 30s never reached the player; chat with no say() came from elsewhere.
  const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const lines = items.filter((i) => i.type === 'line')
  for (const e of timeline) {
    if (e.kind !== 'chat_out') continue
    const n = norm(e.text)
    const owner = lines.find((l) => e.t >= l.t - 1000 && e.t <= l.t + 30000 && n && norm(l.text).includes(n))
    if (owner) { owner.delivered = true; e.folded = true }
  }
  for (const l of lines) if (!l.delivered && l.t < end - 15000) l.undelivered = true
  // Companion chat that did not come from a say() call (stop acks, system
  // lines) is still something the player read: judge it as a line too.
  for (const e of timeline) {
    if (e.kind !== 'chat_out' || e.folded || e.t > end) continue
    const it = { id: `L${++nL}`, type: 'line', t: e.t, text: e.text, auto: true, delivered: true }
    items.push(it)
    e.kind = 'line'; e.id = it.id
  }

  timeline.sort((a, b) => a.t - b.t)
  items.sort((a, b) => a.t - b.t)
  // Number items in time order so ids read naturally (L1 is the first line).
  const remap = new Map()
  const seq = { line: 0, action: 0, silence: 0 }
  const prefix = { line: 'L', action: 'A', silence: 'S' }
  for (const it of items) { const nid = `${prefix[it.type]}${++seq[it.type]}`; remap.set(it.id, nid); it.id = nid }
  for (const e of timeline) {
    if (e.id && remap.has(e.id)) {
      const old = e.id
      e.id = remap.get(old)
      if (e.kind === 'result') e.text = e.text.replace(old, e.id)
    }
  }
  return { meta, start, end, companion, playerName, timeline, items, lastStats, usage }
}

const fmtT = (t, start) => {
  const s = Math.max(0, Math.round((t - start) / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

// One line per timeline entry, as the judge reads it. Chat fragments that
// repeat a say() line are folded away (realistic typing splits lines).
export function renderTimeline(sess) {
  const { timeline, start, companion, playerName } = sess
  const out = []
  for (const e of timeline) {
    const ts = fmtT(e.t, start)
    switch (e.kind) {
      case 'player': out.push(`${ts} ${playerName}: ${e.text}`); break
      case 'line': {
        const it = sess.items.find((i) => i.id === e.id)
        out.push(`${ts} [${e.id}] ${companion} says: ${e.text}${it?.undelivered ? '   (this line never appeared in chat)' : ''}${it?.auto ? '   (sent by the bot code, not her say tool)' : ''}`)
        break
      }
      case 'chat_out': if (!e.folded) out.push(`${ts} ${companion} chat (not from say): ${e.text}`); break
      case 'action': out.push(`${ts} [${e.id}] ${companion} action: ${e.item.name}(${clip(JSON.stringify(e.item.args ?? {}), 160)})${e.item.preStart ? '   (started just before the session began, still running)' : ''}`); break
      case 'result': out.push(`${ts}   result of ${e.text}`); break
      case 'silence': out.push(`${ts} [${e.id}] SILENCE: ${e.text}`); break
      case 'private': out.push(`${ts}   (${companion} private note, player cannot see: ${e.text})`); break
      case 'snapshot': out.push(`${ts}   (${companion}'s sensors: ${e.text})`); break
      case 'sensed': out.push(`${ts}   (what ${companion}'s sensors showed her as she spoke: ${e.text})`); break
      case 'world': out.push(`${ts}   (world: ${e.text})`); break
      case 'event': out.push(`${ts}   (event: ${e.text})`); break
      default: break
    }
  }
  return out.join('\n')
}

export function itemContext(sess, item, before = 5) {
  const lines = renderTimeline(sess).split('\n')
  const i = lines.findIndex((l) => l.includes(`[${item.id}]`))
  if (i < 0) return ''
  return lines.slice(Math.max(0, i - before), i + 1).filter((l) => !/\((world|.*sensors):/.test(l)).join('\n')
}
