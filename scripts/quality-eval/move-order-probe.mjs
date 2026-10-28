// scripts/quality-eval/move-order-probe.mjs: does a "come here" / "stay here"
// line change what she does, and does chat that is not an order leave her
// work alone?
//
// Quality pass 15 (261018). Pass 14 handled these lines with English regexes
// in the orchestrator (a movement order cut the running action, a stay line
// started a hold that blocked her own world actions). This probe measures the
// behavior through the REAL brain (createOrchestrator + handleDispatch, the
// real Minecraft adapter on an inert bot, as order-probe.mjs) so the same
// cases can be run against any tree with --root:
//
//   come   (a) the line lands while she gathers stone for the player, who is
//          14 blocks away. ok = a follow or goTo starts in the turn that
//          answers it.
//   stay   (b) the line lands while she follows the player, with her own goal
//          in the goal list and a next milestone in the snapshot. ok = the
//          follow ends in that turn (unfollow, stop) and no walking or
//          gathering action starts in the completion turns and the idle ticks
//          after it (--idle ticks).
//   keep   (c) the line lands while she gathers. ok = the gather keeps
//          running: no stop, no follow / goTo, no other new action.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/move-order-probe.mjs \
//     --out DIR [--root TREE] [--chars sui,lyra,marv] [--reps 2] [--idle 3]
//     [--lines come_follow,stay_here] [--concurrency 6]
//
// --root is the sei tree whose brain is measured (default: this one).
// Key: ANTHROPIC_API_KEY or ~/.sei-dev/anthropic-test-key, never printed.
// Output: DIR/runs.jsonl, DIR/summary.md, DIR/requests/ (the first run's
// requests per line).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadCharacters } from './persona/characters.mjs'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(arg('root', path.join(HERE, '../..')))
const OUT = arg('out')
if (!OUT) { console.error('--out required'); process.exit(2) }
const CHAR_KEYS = arg('chars', 'sui,lyra,marv').split(',')
const REPS = Number(arg('reps', 2))
const CONC = Number(arg('concurrency', 6))
const IDLE_TICKS = Number(arg('idle', 3))
const MODEL = arg('model', 'claude-haiku-5-5')
const ONLY = arg('lines')?.split(',')
const CHARS_DIR = arg('charsDir', path.join(os.homedir(), 'suisei/eval/characters'))
fs.mkdirSync(path.join(OUT, 'requests'), { recursive: true })

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)
const { ConfigSchema } = await imp('src/bot/config.js')
const { createMinecraftAdapter } = await imp('src/bot/adapter/minecraft/index.js')
const { createOrchestrator } = await imp('src/bot/brain/orchestrator.js')
const { createSessionState } = await imp('src/bot/brain/sessionState.js')
const { createAnthropicProvider } = await imp('src/bot/brain/llm/anthropicProvider.js')
const { loadPlayer, savePlayer, formatPlayerSeedBlock } = await imp('src/bot/brain/memory/player.js')

const KEY = (process.env.ANTHROPIC_API_KEY || fs.readFileSync(path.join(os.homedir(), '.sei-dev/anthropic-test-key'), 'utf8')).trim()
const PRICE = { in: 1, cw: 1.25, cr: 0.1, out: 5 }
const costOf = (u = {}) => ((u.input_tokens ?? 0) * PRICE.in + (u.cache_creation_input_tokens ?? 0) * PRICE.cw
  + (u.cache_read_input_tokens ?? 0) * PRICE.cr + (u.output_tokens ?? 0) * PRICE.out) / 1e6

process.env.SEI_BACKEND = 'local'
delete process.env.SEI_HAS_API_KEY
const quietLogger = {
  info: (m) => { if (process.env.MP_VERBOSE) console.error('INFO', m) }, debug() {}, trace() {},
  warn: (m) => { if (process.env.MP_VERBOSE) console.error('WARN', m) },
  error: (m) => { if (process.env.MP_VERBOSE) console.error('ERR', String(m).slice(0, 300)) },
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PLAYER = 'Alex'

const BRAIN = new Set(['say', 'remember', 'forget', 'setGoal', 'clearGoal', 'end_loop', 'stop', 'quit_game', 'end_call', 'search', 'visit'])
// Actions that take her somewhere or start work of her own.
const WANDER = new Set(['goTo', 'follow', 'gather', 'dig', 'explore', 'find', 'build', 'shelter', 'pickup', 'placeBlock', 'craft', 'smeltInput', 'openFurnace', 'depositItem', 'withdrawItem', 'sleep'])
const TOWARD_PLAYER = new Set(['follow', 'goTo'])

const FAR = { x: 99, y: 71, z: -45, dist: 14 }
const NEAR = { x: 110, y: 71, z: -38, dist: 3 }
const OWN_GOAL = 'Get 20 cobblestone for a furnace and stone tools'
const STONE_ORDER = 'can you get some stone? we need like 20 for a furnace'

const GATHER_HISTORY = [
  { player: STONE_ORDER, say: 'on it, stone incoming', act: { name: 'gather', input: { item: 'cobblestone', count: 20 } }, hold: true },
]
const GATHER_WORLD = {
  inv: [['stone_pickaxe', 1], ['cobblestone', 7], ['bread', 3]], holding: 'stone_pickaxe',
  doing: 'in_flight: gather cobblestone 7/20 (running 25s)', owner: FAR,
  blocks: ['  #1 grass_block x412 @111,70,-40', '  #2 stone x60 @118,68,-35', '  #3 oak_log x14 @118,72,-47'],
}
const FOLLOW_HISTORY = [
  { say: 'gonna grab stone for a furnace', goal: OWN_GOAL },
  { player: 'follow me', say: 'coming', act: { name: 'follow', input: { player: PLAYER } }, hold: true },
]
const FOLLOW_WORLD = {
  inv: [['stone_pickaxe', 1], ['cobblestone', 4], ['bread', 3]], holding: 'stone_pickaxe',
  doing: 'in_flight: follow Alex (running 30s)', follow: `${PLAYER} (3 blocks away)`, owner: NEAR,
  next: 'furnace: gather 8 cobblestone, then craft a furnace at a crafting table',
  blocks: ['  #1 grass_block x412 @111,70,-40', '  #2 stone x60 @118,68,-35', '  #3 oak_log x14 @118,72,-47'],
}

const LINES = {
  come_follow: { kind: 'come', text: 'follow me' },
  come_here: { kind: 'come', text: 'come here' },
  come_over: { kind: 'come', text: 'over here' },
  come_with: { kind: 'come', text: 'can you come with me' },
  come_zh: { kind: 'come', text: '跟我来' },
  stay_here: { kind: 'stay', text: 'stay here' },
  stay_stop: { kind: 'stay', text: 'stop moving' },
  stay_wait: { kind: 'stay', text: 'wait here' },
  stay_zh: { kind: 'stay', text: '别动' },
  keep_tease: { kind: 'keep', text: 'lol ur slow' },
  keep_question: { kind: 'keep', text: 'what are you mining?' },
  keep_later: { kind: 'keep', text: "come here when you're done" },
  keep_dontfollow: { kind: 'keep', text: 'dont follow me' },
}

function snapshot(w) {
  const inv = (w.inv ?? []).map(([n, c]) => `${n}×${c}`).join(', ') || '(empty)'
  const o = w.owner ?? NEAR
  return [
    'world: #1 Meadow', 'pos: 112,71,-40', 'facing: north. forward -z, back +z, left -x, right +x',
    'biome: plains  surroundings: outside  light: sky 15 block 0  time: day (2400)',
    'real time: 7:40 PM — you joined this session 12 minutes ago',
    'hp: 20/20  food: 18/20  xp: lvl 2',
    `holding: ${w.holding ?? '(empty hand)'}`,
    w.doing ?? 'idle: no action is running',
    `inventory (${(w.inv ?? []).length} of 36 slots used): ${inv}`,
    'terrain at feet: 25 grass_block', 'nearby blocks:', ...(w.blocks ?? []),
    'nearby entities:', `  #4 ${PLAYER} @${o.x},${o.y},${o.z}`, '  #5 cow @121,71,-31',
    `follow_target: ${w.follow ?? '(none)'}`,
    ...(w.next ? [`next: ${w.next}`] : []),
    `owner ${PLAYER}: @${o.x},${o.y},${o.z} (${o.dist} blocks away), hp 20/20`,
    `last_action_result: ${w.last ?? '(none)'}`,
  ].join('\n')
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
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

async function runOne({ lid, ch, rep }) {
  const line = LINES[lid]
  const stay = line.kind === 'stay'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'move-probe-'))
  const mem = (f) => path.join(dir, f)
  await savePlayer(mem('PLAYER.md'), {
    exists: true, player_uuid: 'u-alex', player_username: PLAYER, first_seen: '2026-10-01T10:00:00Z',
    last_seen: '2026-10-10T19:30:00Z', total_sessions: 3, preferred_name: PLAYER, pronouns: null,
  })
  fs.writeFileSync(mem('MEMORY.md'), `# MEMORY\n\n- [2026-10-08 19:15] ${PLAYER} likes building near water.\n`)
  const config = botConfig(ch, mem)
  const world = { ...(stay ? FOLLOW_WORLD : GATHER_WORLD) }
  const bot = {
    chat() {}, whisper() {}, username: ch.botName, players: {}, on() {}, off() {}, removeListener() {}, once() {}, emit() {},
    entity: { position: { x: 112, y: 71, z: -40 } }, health: 20, food: 20, game: { dimension: 'overworld' },
    inventory: { items: () => (world.inv ?? []).map(([name, count]) => ({ name, count })) },
  }
  const realAdapter = createMinecraftAdapter({ bot, config, visionEnabled: false })
  const actions = [] // { name, args, phase }
  let historyHeld = null // { name, aborted }
  const holds = []
  let phase = 'history'
  let holdNext = false
  const overrides = {
    createSnapshotComposer: () => ({ next: () => snapshot(world) }),
    closeAnySessions: async () => {},
    executeAction: async (name, args, opts) => {
      actions.push({ name, args, phase })
      const signal = opts?.signal
      if (phase === 'history' && holdNext) {
        holdNext = false
        const rec = { name, aborted: false }
        historyHeld = rec
        return new Promise((resolve, reject) => {
          holds.push(() => resolve(`${name}: done`))
          signal?.addEventListener?.('abort', () => {
            rec.aborted = true
            if (name === 'follow') world.follow = '(none)'
            world.doing = 'idle: no action is running'
            world.last = `${name}: aborted`
            reject(abortError())
          }, { once: true })
        })
      }
      if (phase === 'history') return `${name}: done`
      if (name === 'unfollow') {
        world.follow = '(none)'; world.doing = 'idle: no action is running'; world.last = 'unfollow: stopped following Alex'
        return 'stopped following Alex'
      }
      if (stay) {
        // After a stay line every action settles at once, so the completion
        // turns and idle ticks after it are measured too.
        world.last = `${name}: done`
        return `${name}: done`
      }
      // come / keep: a new action stays running, so the probe measures the
      // turn that answered the line.
      world.doing = `in_flight: ${name} (running 0s)`
      if (name === 'follow') world.follow = `${PLAYER} (14 blocks away)`
      return new Promise((resolve, reject) => {
        holds.push(() => resolve(`${name}: done`))
        signal?.addEventListener?.('abort', () => {
          world.doing = 'idle: no action is running'
          world.last = `${name}: aborted`
          reject(abortError())
        }, { once: true })
      })
    },
  }
  const adapter = new Proxy(realAdapter, { get: (t, k) => (k in overrides ? overrides[k] : t[k]) })

  const real = createAnthropicProvider(config)
  let stub = null
  let callsLeft = 0
  let cost = 0
  const calls = [] // { phase, text, tools }
  const provider = {
    ...real,
    get model() { return real.model },
    async call(req) {
      if (phase === 'history') {
        const r = stub ?? stubResp([tu('end_loop', {})])
        stub = null
        return r
      }
      if (callsLeft <= 0) return stubResp([tu('end_loop', {})])
      callsLeft--
      let resp
      for (let a = 0; ; a++) {
        try { resp = await real.call(req); break } catch (err) {
          if (err?.name === 'AbortError' || req?.signal?.aborted) throw err
          if (a >= 3) throw err
          await sleep(2000 * (a + 1))
        }
      }
      cost += costOf(resp.usage)
      calls.push({ phase, text: String(resp.text ?? '').trim().slice(0, 500), tools: resp.toolUses.map((t) => ({ name: t.name, input: t.input })) })
      const key = `${lid}-${calls.length}`
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
    for (let guard = 0; guard < 16; guard++) {
      await sleep(40)
      const next = queue.shift()
      if (!next) break
      if (next.event === 'sei:action_complete' || next.event === 'sei:chat_received' || next.event === 'sei:action_tick' || next.event === 'player_chat') {
        await orch.handleDispatch(next.event, next.data, new AbortController().signal)
      }
    }
    queue.length = 0
  }

  let error = null
  try {
    stub = stubResp([tu('say', { text: `hey ${PLAYER.toLowerCase()}` })])
    await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn' }, new AbortController().signal)
    await drain()
    for (const h of stay ? FOLLOW_HISTORY : GATHER_HISTORY) {
      await sleep(250)
      const uses = [tu('say', { text: h.say })]
      if (h.goal) uses.push(tu('setGoal', { text: h.goal }))
      if (h.act) { uses.push(tu(h.act.name, h.act.input)); holdNext = !!h.hold }
      stub = stubResp(uses)
      if (h.player) {
        orch.recordIncomingChat(PLAYER, h.player)
        await orch.handleDispatch('player_chat', { username: PLAYER, text: h.player, playerSpoke: true }, new AbortController().signal)
      } else {
        await orch.handleDispatch('sei:idle', { quietMs: 20000 }, new AbortController().signal)
      }
      if (!h.hold) await drain()
      else queue.length = 0
    }
    await sleep(250)
    // The line itself, and every turn it leads to (completions, a fold).
    phase = 'order'
    callsLeft = 3
    orch.recordIncomingChat(PLAYER, line.text)
    await orch.handleDispatch('player_chat', { username: PLAYER, text: line.text, playerSpoke: true }, new AbortController().signal)
    await drain()
    if (stay) {
      // What she does on her own after it: completion turns already ran in
      // the drain; now the idle ticks of the next stretch.
      phase = 'after'
      for (let i = 0; i < IDLE_TICKS; i++) {
        await sleep(1500)
        callsLeft = 3
        await orch.handleDispatch('sei:idle', { quietMs: 15000 * (i + 1) }, new AbortController().signal)
        await drain()
      }
    }
  } catch (err) { error = String(err?.stack ?? err).slice(0, 400) }
  for (const r of holds) { try { r() } catch {} }
  try { orch.dispose?.() } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}

  const orderCalls = calls.filter((c) => c.phase === 'order')
  const afterCalls = calls.filter((c) => c.phase === 'after')
  const toolNames = (cs) => cs.flatMap((c) => c.tools.map((t) => t.name))
  const orderTools = toolNames(orderCalls)
  const afterTools = toolNames(afterCalls)
  const orderActs = actions.filter((a) => a.phase === 'order').map((a) => a.name)
  const afterActs = actions.filter((a) => a.phase === 'after').map((a) => a.name)
  const says = calls.flatMap((c) => c.tools.filter((t) => t.name === 'say').map((t) => `${c.phase === 'after' ? '[later] ' : ''}${String(t.input?.text ?? '')}`))
  const row = { line: lid, kind: line.kind, text: line.text, char: ch.key, rep, model: MODEL, error, cost, calls, orderActs, afterActs, says }
  if (line.kind === 'come') {
    row.ok = orderActs.some((n) => TOWARD_PLAYER.has(n))
    row.firstCallOk = (orderCalls[0]?.tools ?? []).some((t) => TOWARD_PLAYER.has(t.name))
  } else if (line.kind === 'stay') {
    row.stopped = orderActs.includes('unfollow') || orderTools.includes('stop') || !!historyHeld?.aborted
    const orderWander = orderActs.filter((n) => WANDER.has(n))
    row.wandered = [...orderWander, ...afterActs.filter((n) => WANDER.has(n))]
    row.afterCalls = afterCalls.length
    row.ok = row.stopped && row.wandered.length === 0
  } else {
    const newActs = orderActs.filter((n) => !BRAIN.has(n))
    row.switched = orderTools.includes('stop') || newActs.some((n) => n !== 'gather') || !!historyHeld?.aborted && !newActs.includes('gather')
    row.restarted = newActs.includes('gather')
    row.ok = !row.switched
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
        out[idx] = { line: items[idx].lid, char: items[idx].ch.key, rep: items[idx].rep, error: String(err?.message ?? err) }
      }
    }
  }))
  return out
}

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '-')

function summarize(rows) {
  const ok = rows.filter((r) => !r.error)
  const lines = [`# Move-order probe`, '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), idle ticks ${IDLE_TICKS}, cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '']
  lines.push('| line | kind | ok | detail |', '|---|---|---:|---|')
  const byLine = [...new Set(ok.map((r) => r.line))]
  for (const lid of byLine) {
    const rs = ok.filter((r) => r.line === lid)
    const k = rs[0].kind
    const detail = k === 'come' ? `first call ${pct(rs.filter((r) => r.firstCallOk).length, rs.length)}`
      : k === 'stay' ? `stopped ${pct(rs.filter((r) => r.stopped).length, rs.length)}, wandered ${pct(rs.filter((r) => r.wandered.length).length, rs.length)}`
      : `switched ${pct(rs.filter((r) => r.switched).length, rs.length)}, re-issued gather ${pct(rs.filter((r) => r.restarted).length, rs.length)}`
    lines.push(`| ${JSON.stringify(rs[0].text)} | ${k} | ${pct(rs.filter((r) => r.ok).length, rs.length)} | ${detail} |`)
  }
  for (const k of ['come', 'stay', 'keep']) {
    const rs = ok.filter((r) => r.kind === k)
    if (rs.length) lines.push(`| **all ${k}** | ${k} | ${pct(rs.filter((r) => r.ok).length, rs.length)} | |`)
  }
  lines.push('', '## Runs that were not ok', '')
  for (const r of ok.filter((r) => !r.ok)) {
    lines.push(`- ${r.line}/${r.char}/${r.rep}: ${r.calls.map((c) => `${c.phase === 'after' ? '[later] ' : ''}${c.tools.map((t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 80)}")` : t.name).join(' + ') || '(text only)'}`).join(' -> ')}${r.wandered?.length ? `  WANDERED ${r.wandered.join(',')}` : ''}`)
  }
  return lines.join('\n') + '\n'
}

const chars = loadCharacters(CHARS_DIR, CHAR_KEYS)
const jobs = []
for (const lid of Object.keys(LINES)) {
  if (ONLY && !ONLY.includes(lid)) continue
  for (const ch of chars) for (let rep = 0; rep < REPS; rep++) jobs.push({ lid, ch, rep })
}
const stream = fs.createWriteStream(path.join(OUT, 'runs.jsonl'), { flags: 'a' })
const rows = await pool(jobs, CONC, async (j) => {
  const r = await runOne(j)
  stream.write(JSON.stringify(r) + '\n')
  const seq = r.calls?.map((c) => `${c.phase === 'after' ? '[later] ' : ''}${c.tools.map((t) => t.name).join('+') || 'text'}`).join(' -> ')
  console.log(`[${r.line}/${r.char}/${r.rep}] ${r.error ? 'ERROR ' + r.error : `${r.ok ? 'OK  ' : 'BAD '} ${seq} | ${r.says.join(' / ').slice(0, 140)}`}`)
  return r
})
stream.end()
await new Promise((r) => stream.on('finish', r))
fs.writeFileSync(path.join(OUT, 'summary.md'), summarize(rows))
console.log(fs.readFileSync(path.join(OUT, 'summary.md'), 'utf8').split('\n## ')[0])
process.exit(0)
