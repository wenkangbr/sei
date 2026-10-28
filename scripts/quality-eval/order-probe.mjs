// scripts/quality-eval/order-probe.mjs: does an order turn start the real
// action, or only talk about it?
//
// Quality pass 8 (261015). In the scripted-convo eval she answered orders with
// "i'll go find some" / "logs for the dock coming up" and a setGoal call, and
// no action ever ran; and she said "catch, 8 coal" with only a goTo. This
// probe puts each character through a few order situations through the REAL
// brain (createOrchestrator + handleDispatch, the real Minecraft adapter on an
// inert bot, the same as goals/run.mjs) and reads what actually ran:
//
//   acted        a world action was dispatched while the brain handled the
//                order (the order's own dispatch plus its drained
//                continuations, capped at --hops model calls)
//   first        the FIRST model call of that turn already called one
//   goalOnly     the first call recorded a goal (setGoal) but called no world
//                action
//   announce     a say() line of that turn reads like she is doing something
//                ("i'll", "on it", "coming up", "grabbing" ...) and nothing ran
//   dropped      (delivery situations) dropItem ran
//   claim        (delivery situations) a say() line hands the item over
//                ("here", "catch", "all yours" ...) and no dropItem ran
//
// Earlier lines of the session are replayed without a model call: the
// player's line is recorded and her line (plus an optional setGoal) is
// returned by a stub turn, so every arm sees the same history.
// `hold: true` on a history turn keeps that turn's world action running, so
// the order lands MID-ACTION (handleActionTick), the way orders given while
// she follows the player arrive.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/order-probe.mjs \
//     --out DIR [--chars sui,lyra,marv,red,roger] [--reps 3] [--hops 3]
//     [--situations wood20,dock8] [--concurrency 6]
//
// Key: ANTHROPIC_API_KEY or ~/.sei-dev/anthropic-test-key, never printed.
// Output: DIR/runs.jsonl, DIR/summary.md, DIR/requests/ (the order turn's
// requests of the first run per situation).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigSchema } from '../../src/bot/config.js'
import { createMinecraftAdapter } from '../../src/bot/adapter/minecraft/index.js'
import { createOrchestrator } from '../../src/bot/brain/orchestrator.js'
import { createSessionState } from '../../src/bot/brain/sessionState.js'
import { createAnthropicProvider } from '../../src/bot/brain/llm/anthropicProvider.js'
import { loadPlayer, savePlayer, formatPlayerSeedBlock } from '../../src/bot/brain/memory/player.js'
import { loadCharacters } from './persona/characters.mjs'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const OUT = arg('out')
if (!OUT) { console.error('--out required'); process.exit(2) }
const CHAR_KEYS = arg('chars', 'sui,lyra,marv,red,roger').split(',')
const REPS = Number(arg('reps', 3))
const CONC = Number(arg('concurrency', 6))
const HOPS = Number(arg('hops', 3))
const MODEL = arg('model', 'claude-haiku-5-5')
const ONLY = arg('situations')?.split(',')
const CHARS_DIR = arg('charsDir', path.join(os.homedir(), 'suisei/eval/characters'))
fs.mkdirSync(path.join(OUT, 'requests'), { recursive: true })

const KEY = (process.env.ANTHROPIC_API_KEY || fs.readFileSync(path.join(os.homedir(), '.sei-dev/anthropic-test-key'), 'utf8')).trim()
const PRICE = { in: 0.1, cw: 0.125, cr: 0.01, out: 0.5 }
const costOf = (u = {}) => ((u.input_tokens ?? 0) * PRICE.in + (u.cache_creation_input_tokens ?? 0) * PRICE.cw
  + (u.cache_read_input_tokens ?? 0) * PRICE.cr + (u.output_tokens ?? 0) * PRICE.out) / 1e6

process.env.SEI_BACKEND = 'local'
delete process.env.SEI_HAS_API_KEY
const quietLogger = {
  info() {}, debug() {}, trace() {},
  warn: (m) => { if (process.env.OP_VERBOSE) console.error('WARN', m) },
  error: (m) => { if (process.env.OP_VERBOSE) console.error('ERR', String(m).slice(0, 300)) },
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PLAYER = 'Alex'
const chat = (text) => ({ event: 'player_chat', data: { username: PLAYER, text, playerSpoke: true } })

// Brain tools never touch the world; everything else is a world action.
const BRAIN = new Set(['say', 'remember', 'forget', 'setGoal', 'clearGoal', 'end_loop', 'stop', 'quit_game', 'end_call', 'search', 'visit'])
const INTENT = /\b(i'?ll|ill|i will|gonna|going (?:to|for|after)|off to|time to|on it|coming up|on my way|omw|grabbing|heading|chopping|getting|fetching|bringing|walking|finding|digging|mining|hunting|let me|lemme|be right back|brb)\b/i
const HANDOVER = /\b(here(?:'s| you go| ya|,|\.|!|$)|catch|take (?:it|them|these)|all yours|yours now|dropped|tossed|handed)\b/i

function snapshot(w) {
  const inv = (w.inv ?? []).map(([n, c]) => `${n}×${c}`).join(', ') || '(empty)'
  const o = w.owner ?? { x: 109, y: 71, z: -38, dist: 3 }
  return [
    'world: #1 Meadow', 'pos: 112,71,-40', 'facing: north. forward -z, back +z, left -x, right +x',
    `biome: plains  surroundings: outside  light: sky 15 block 0  time: ${w.time ?? 'day (2400)'}`,
    `real time: 7:40 PM — you joined this session ${w.joined ?? '12 minutes ago'}`,
    'hp: 20/20  food: 18/20  xp: lvl 2',
    `holding: ${w.holding ?? (w.inv?.length ? w.inv[0][0] : '(empty hand)')}`,
    w.doing ?? 'idle: no action is running',
    `inventory (${(w.inv ?? []).length} of 36 slots used): ${inv}`,
    'terrain at feet: 25 grass_block', 'nearby blocks:', ...(w.blocks ?? ['  #1 grass_block x412 @111,70,-40', '  #2 oak_log x14 @118,72,-47', '  #3 water x30 @104,70,-52']),
    'nearby entities:', `  #4 ${PLAYER} @${o.x},${o.y},${o.z}`, '  #5 cow @121,71,-31',
    `follow_target: ${w.follow ?? '(none)'}`,
    ...(w.next ? [`next: ${w.next}`] : []),
    `owner ${PLAYER}: @${o.x},${o.y},${o.z} (${o.dist} blocks away), hp 20/20`,
    `last_action_result: ${w.last ?? '(none)'}`,
  ].join('\n')
}

const WOOD_WORLD = { inv: [['cobblestone', 23], ['stone_pickaxe', 1], ['bread', 3], ['torch', 6]] }
const COAL_BLOCKS = ['  #1 grass_block x412 @111,70,-40', '  #2 oak_log x6 @124,72,-49', '  #3 coal_ore x3 @121,69,-31', '  #4 stone x40 @118,68,-35']
const FAR = { x: 99, y: 71, z: -45, dist: 14 }
const COAL_TASK = 'Mine 8 coal for Alex and bring it back to Alex so they can make torches. Done when Alex has the coal.'

// Each situation: `history` turns replayed before the order (player line,
// her stubbed say, optional setGoal / world action), `world` at the order,
// the order itself, and what counts as acting on it.
export const SITUATIONS = {
  // The persona eval's order situation.
  wood20: {
    world: WOOD_WORLD,
    order: chat('go get some wood, we need like 20 logs for the house'),
  },
  // errands-04 U7 (pass 7a compare): she answered with say + setGoal only.
  dock8: {
    history: [
      { player: 'can u grab me some coal from that ore over there and bring it back here? i need torches', say: 'coal for torches, on it' },
      { say: 'here. 8 coal. go make your torches' },
      { player: 'hows it going', say: 'kinda bored tbh, nothing to punch' },
    ],
    world: { inv: [['stone_pickaxe', 1], ['oak_log', 2]], blocks: ['  #1 grass_block x412 @111,70,-40', '  #2 oak_log x6 @124,72,-49', '  #3 water x30 @104,70,-52'], last: 'dropItem: dropped 8 coal' },
    order: chat('get me like 8 logs, i wanna build a dock'),
  },
  coal: {
    world: { inv: [['stone_pickaxe', 1]], blocks: COAL_BLOCKS },
    order: chat('can u grab me some coal from that ore over there and bring it back here? i need torches'),
  },
  // work_session-02 U8: she proposed the plan, the player agrees.
  agree: {
    history: [
      { player: 'what should we build first?', say: 'first we get a pickaxe so we can dig stone, then iron tools. you good with that?' },
    ],
    world: {
      inv: [['wooden_pickaxe', 1], ['oak_log', 5], ['oak_planks', 3]], holding: 'wooden_pickaxe',
      blocks: ['  #1 grass_block x412 @111,70,-40', '  #2 crafting_table x1 @113,71,-41', '  #3 stone x40 @110,69,-44', '  #4 oak_log x9 @118,72,-47'],
      last: 'craft: crafted 1 wooden_pickaxe',
    },
    order: chat('yeah sounds good'),
  },
  // errands-01 U9: she promised the logs earlier; the player says "ok".
  ok_promise: {
    history: [
      { player: 'get me like 8 logs, i wanna build a dock', say: '8 logs for a dock? sure, i will hunt some trees in a sec' },
      { player: 'whats ur favorite block', say: "cobblestone. it's ugly and it's everywhere so i respect it" },
    ],
    world: { inv: [['stone_pickaxe', 1]], blocks: ['  #1 grass_block x412 @111,70,-40', '  #2 oak_log x6 @124,72,-49', '  #3 water x30 @104,70,-52'] },
    order: chat('ok'),
  },
  // An order while she follows the player (the follow stays in flight).
  follow_wood: {
    history: [
      { player: 'follow me', say: 'ok coming', act: { name: 'follow', input: { player: PLAYER } }, hold: true },
    ],
    world: { inv: [['stone_pickaxe', 1]], doing: 'in_flight: follow Alex (running 20s)', follow: `${PLAYER} (3 blocks away)` },
    order: chat('ok stop following, go chop some wood, like 10 logs'),
  },
  // First spawn, before the player has said anything (convo eval openings).
  // Here acting is NOT the goal: a world action started on the greeting turn
  // means she walked off before the player spoke (night_social-B: off
  // gathering when the zombie reached the player). Scored separately.
  greet_day: {
    greeting: true,
    world: { inv: [], time: 'day (1000)', joined: 'just now', last: '(none)' },
  },
  greet_night: {
    greeting: true,
    world: { inv: [['iron_sword', 1], ['bread', 4]], holding: 'iron_sword', time: 'night (14000)', joined: 'just now', last: '(none)', blocks: ['  #1 grass_block x412 @111,70,-40', '  #2 oak_log x6 @130,72,-60'] },
  },
  // Delivery: she has the coal and stands next to the player.
  deliver_near: {
    history: [
      { player: 'can u grab me some coal from that ore over there and bring it back here? i need torches', say: 'coal for torches, on it', goal: COAL_TASK },
      { say: 'got 8 coal. heading back to you now' },
    ],
    world: { inv: [['stone_pickaxe', 1], ['coal', 8]], last: 'goTo: reached' },
    order: chat('cool'),
    delivery: true,
  },
  // Delivery: she has the coal, the player is 14 blocks away.
  deliver_far: {
    history: [
      { player: 'can u grab me some coal from that ore over there and bring it back here? i need torches', say: 'coal for torches, on it', goal: COAL_TASK },
    ],
    world: { inv: [['stone_pickaxe', 1], ['coal', 8]], owner: FAR, last: 'gather: gathered 8/8 coal (mined from coal_ore)' },
    order: chat('nice, u got it? bring it over'),
    delivery: true,
  },
}

function botConfig(ch, mem) {
  return ConfigSchema.parse({
    chat_mode: 'chat', realistic_typing: false, player_username: PLAYER, player_display_name: PLAYER,
    persona: { name: ch.botName, expanded: ch.expanded, proactiveness: 2, ...(ch.punctuation ? { punctuation: ch.punctuation } : {}) },
    anthropic: { api_key: KEY, model: MODEL },
    adapter: { kind: 'minecraft', minecraft: { host: '127.0.0.1', port: 25565, auth: 'offline', username: ch.botName, version: 'auto' } },
    memory: { player_md_path: mem('PLAYER.md'), memory_md_path: mem('MEMORY.md'), heartbeat_md_path: mem('HEARTBEAT.md'), worlds_json_path: mem('worlds.json') },
    vision: { mode: 'off' },
  })
}

const captured = new Set()
let uid = 0
const tu = (name, input) => ({ type: 'tool_use', id: `stub${++uid}`, name, input })
const stubResp = (uses) => ({ text: '', toolUses: uses.map(({ id, name, input }) => ({ id, name, input })), content: uses, usage: {}, stopReason: 'tool_use' })

async function runOne({ sid, ch, rep }) {
  const sit = SITUATIONS[sid]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-probe-'))
  const mem = (f) => path.join(dir, f)
  await savePlayer(mem('PLAYER.md'), {
    exists: true, player_uuid: 'u-alex', player_username: PLAYER, first_seen: '2026-10-01T10:00:00Z',
    last_seen: '2026-10-10T19:30:00Z', total_sessions: 3, preferred_name: PLAYER, pronouns: null,
  })
  // A greeting opens the first session together, like the convo eval.
  fs.writeFileSync(mem('MEMORY.md'), sit.greeting ? '# MEMORY\n' : `# MEMORY\n\n- [2026-10-08 19:15] ${PLAYER} likes building near water.\n`)
  const config = botConfig(ch, mem)
  let world = { ...sit.world }
  const bot = {
    chat() {}, whisper() {}, username: ch.botName, players: {}, on() {}, off() {}, removeListener() {}, once() {}, emit() {},
    entity: { position: { x: 112, y: 71, z: -40 } }, health: 20, food: 20, game: { dimension: 'overworld' },
    inventory: { items: () => (world.inv ?? []).map(([name, count]) => ({ name, count })) },
  }
  const realAdapter = createMinecraftAdapter({ bot, config, visionEnabled: false })
  const actions = []
  let releaseHeld = null
  const orderHolds = []
  const overrides = {
    createSnapshotComposer: () => ({ next: () => snapshot(world) }),
    closeAnySessions: async () => {},
    executeAction: async (name, args) => {
      actions.push({ name, args })
      if (phase === 'history' && holdNext) {
        holdNext = false
        return new Promise((resolve) => { releaseHeld = () => resolve(`${name}: done`) })
      }
      // In the order phase a world action stays running, so the probe
      // measures the order turn itself (and any continuation inside it),
      // not later hops reacting to a world that never changes.
      if (phase === 'order') return new Promise((resolve) => { orderHolds.push(() => resolve(`${name}: done`)) })
      return `${name}: done`
    },
  }
  const adapter = new Proxy(realAdapter, { get: (t, k) => (k in overrides ? overrides[k] : t[k]) })

  const real = createAnthropicProvider(config)
  let phase = 'history'
  let stub = null // the stub response for the next history call
  let holdNext = false
  let hopsLeft = 0
  let cost = 0
  const calls = []
  const provider = {
    ...real,
    get model() { return real.model },
    async call(req) {
      if (phase === 'history') {
        const r = stub ?? stubResp([tu('end_loop', {})])
        stub = null
        return r
      }
      if (hopsLeft <= 0) return stubResp([tu('end_loop', {})])
      hopsLeft--
      let resp
      for (let a = 0; ; a++) {
        try { resp = await real.call(req); break } catch (err) {
          if (a >= 3) throw err
          await sleep(2000 * (a + 1))
        }
      }
      cost += costOf(resp.usage)
      calls.push({ text: String(resp.text ?? '').trim().slice(0, 500), tools: resp.toolUses.map((t) => ({ name: t.name, input: t.input })) })
      const key = `${sid}-${calls.length}`
      if (!captured.has(key)) {
        captured.add(key)
        fs.writeFileSync(path.join(OUT, 'requests', `${key}.json`), JSON.stringify({ systemBlocks: req.systemBlocks, messages: req.messages, tools: (req.tools ?? []).map((t) => t.name) }, null, 1))
      }
      return resp
    },
  }

  const queue = []
  const botShim = {
    username: ch.botName, players: { [PLAYER]: { username: PLAYER, uuid: 'uuid-alex' } }, uuidToUsername: { 'uuid-alex': PLAYER },
    on() {}, off() {}, once() {}, removeListener() {},
  }
  const sessionState = await createSessionState({ playerMdPath: config.memory.player_md_path, config, bot: botShim, logger: quietLogger })
  const orch = createOrchestrator({
    adapter, config, logger: quietLogger, sessionState,
    playerStore: { loadPlayer, savePlayer, formatPlayerSeedBlock },
    reenqueue: (event, data) => queue.push({ event, data }),
    _anthropicOverride: provider,
  })
  const drain = async () => {
    for (let guard = 0; guard < 12; guard++) {
      await sleep(30)
      const next = queue.shift()
      if (!next) break
      if (next.event === 'sei:action_complete' || next.event === 'sei:chat_received' || next.event === 'sei:action_tick') {
        await orch.handleDispatch(next.event, next.data, new AbortController().signal)
      }
    }
    queue.length = 0
  }

  let error = null
  let historyActs = 0
  try {
    if (sit.greeting) {
      // The greeting turn itself is what is measured.
      phase = 'order'
      hopsLeft = HOPS
      await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn' }, new AbortController().signal)
      await drain()
      throw Object.assign(new Error('greeting done'), { greetingDone: true })
    }
    // The greeting that opened the session.
    stub = stubResp([tu('say', { text: `hey ${PLAYER.toLowerCase()}` })])
    await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn' }, new AbortController().signal)
    await drain()
    for (const h of sit.history ?? []) {
      await sleep(250)
      const uses = [tu('say', { text: h.say })]
      if (h.goal) uses.push(tu('setGoal', { text: h.goal, for_player: true }))
      if (h.act) { uses.push(tu(h.act.name, h.act.input)); holdNext = !!h.hold }
      stub = stubResp(uses)
      if (h.player) {
        orch.recordIncomingChat(PLAYER, h.player)
        await orch.handleDispatch('player_chat', { username: PLAYER, text: h.player, playerSpoke: true }, new AbortController().signal)
      }
      else await orch.handleDispatch('sei:idle', { quietMs: 20000 }, new AbortController().signal)
      if (!h.hold) await drain()
      else queue.length = 0
    }
    historyActs = actions.length
    await sleep(250)
    phase = 'order'
    hopsLeft = HOPS
    world = { ...sit.world }
    orch.recordIncomingChat(PLAYER, sit.order.data.text)
    await orch.handleDispatch(sit.order.event, sit.order.data, new AbortController().signal)
    await drain()
  } catch (err) { if (!err?.greetingDone) error = String(err?.stack ?? err).slice(0, 400) }
  try { releaseHeld?.() } catch {}
  for (const r of orderHolds) { try { r() } catch {} }
  try { orch.dispose?.() } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}

  const orderActs = actions.slice(historyActs).map((a) => a.name)
  const says = calls.flatMap((c) => c.tools.filter((t) => t.name === 'say').map((t) => String(t.input?.text ?? '')))
  const called = calls.flatMap((c) => c.tools.map((t) => t.name))
  const first = calls[0]?.tools ?? []
  const firstWorld = first.some((t) => !BRAIN.has(t.name))
  const acted = called.some((n) => !BRAIN.has(n))
  const dropped = called.includes('dropItem') || called.includes('give')
  const row = {
    situation: sid, char: ch.key, rep, model: MODEL, error, cost, calls, orderActs, says,
    ...(sit.greeting ? { greeting: true } : {}),
    acted, first: firstWorld, hops: calls.length,
    goalOnly: first.some((t) => t.name === 'setGoal') && !firstWorld,
    announce: !acted && says.some((s) => INTENT.test(s)),
    ...(sit.delivery ? {
      dropped,
      claim: !dropped && says.some((s) => HANDOVER.test(s)),
      clearedNoDrop: !dropped && called.includes('clearGoal'),
    } : {}),
    sayCalls: says.length,
  }
  return row
}

async function pool(items, n, fn) {
  let i = 0
  const out = []
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++
      try { out[idx] = await fn(items[idx]) } catch (err) {
        out[idx] = { situation: items[idx].sid, char: items[idx].ch.key, rep: items[idx].rep, error: String(err?.message ?? err) }
      }
    }
  }))
  return out
}

function pct(n, d) { return d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '-' }

function summarize(rows) {
  const ok = rows.filter((r) => !r.error)
  const lines = [`# Order probe`, '', `model ${MODEL}, hops ${HOPS}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '']
  lines.push('| situation | acted | first call acted | goal only | announce, nothing ran | dropped | handover claim, no drop | goal cleared, no drop | mean say() per turn | mean calls |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
  const sids = [...new Set(ok.map((r) => r.situation))]
  const row = (name, rs) => {
    const del = rs.filter((r) => 'dropped' in r)
    lines.push(`| ${name} | ${pct(rs.filter((r) => r.acted).length, rs.length)} | ${pct(rs.filter((r) => r.first).length, rs.length)} | ${pct(rs.filter((r) => r.goalOnly).length, rs.length)} | ${pct(rs.filter((r) => r.announce).length, rs.length)} | ${del.length ? pct(del.filter((r) => r.dropped).length, del.length) : '-'} | ${del.length ? pct(del.filter((r) => r.claim).length, del.length) : '-'} | ${del.length ? pct(del.filter((r) => r.clearedNoDrop).length, del.length) : '-'} | ${(rs.reduce((s, r) => s + r.sayCalls, 0) / Math.max(1, rs.length)).toFixed(2)} | ${(rs.reduce((s, r) => s + (r.hops ?? 0), 0) / Math.max(1, rs.length)).toFixed(2)} |`)
  }
  for (const s of sids) row(s, ok.filter((r) => r.situation === s))
  const orders = ok.filter((r) => !('dropped' in r) && !r.greeting)
  row('**all orders**', orders)
  row('**all deliveries**', ok.filter((r) => 'dropped' in r))
  const greets = ok.filter((r) => r.greeting)
  if (greets.length) row('**all greetings** (acted = left before the player spoke; lower is better)', greets)
  lines.push('', '## Turns that did not act', '')
  for (const r of ok.filter((r) => !r.greeting && (!r.acted || r.claim))) {
    lines.push(`- ${r.situation}/${r.char}/${r.rep}: ${r.calls.map((c) => c.tools.map((t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 90)}")` : t.name).join(' + ') || '(text only)').join(' -> ')}`)
  }
  return lines.join('\n') + '\n'
}

const chars = loadCharacters(CHARS_DIR, CHAR_KEYS)
const jobs = []
for (const sid of Object.keys(SITUATIONS)) {
  if (ONLY && !ONLY.includes(sid)) continue
  for (const ch of chars) for (let rep = 0; rep < REPS; rep++) jobs.push({ sid, ch, rep })
}
const outFile = path.join(OUT, 'runs.jsonl')
const stream = fs.createWriteStream(outFile, { flags: 'a' })
const rows = await pool(jobs, CONC, async (j) => {
  const r = await runOne(j)
  stream.write(JSON.stringify(r) + '\n')
  const seq = r.calls?.map((c) => c.tools.map((t) => t.name).join('+') || 'text').join(' -> ')
  console.log(`[${r.situation}/${r.char}/${r.rep}] ${r.error ? 'ERROR ' + r.error : `${r.acted ? 'ACT ' : 'none'} ${seq}${r.claim ? '  CLAIM' : ''}  | ${r.says.join(' / ').slice(0, 120)}`}`)
  return r
})
stream.end()
await new Promise((r) => stream.on('finish', r))
fs.writeFileSync(path.join(OUT, 'summary.md'), summarize(rows))
console.log(fs.readFileSync(path.join(OUT, 'summary.md'), 'utf8').split('\n## ')[0])
process.exit(0)
