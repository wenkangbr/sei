// scripts/quality-eval/goals/run.mjs: text-only multi-turn goal-lifecycle eval
// for Minecraft, Stardew and Don't Starve Together.
//
// Each run puts one character through one scenario (scenarios.mjs) on one game
// through the REAL brain: createOrchestrator + handleDispatch build the system
// prefix, seed blocks (heartbeat + frontier included) and tool list exactly as
// a live session of that game does, over the real adapter
// (createMinecraftAdapter / createStardewAdapter / createDontStarveAdapter) on
// a stub transport. The model's say / setGoal / clearGoal / remember calls run
// for real (setGoal writes a real HEARTBEAT file, and the orchestrator's JS
// frontier auto-clear runs against the real progression spine). World actions
// do not reach a game: executeAction returns the step's scripted result, and
// the step's `afterWorld` is applied when it does, so the next turn's snapshot
// and frontier see the progress. The orchestrator's action_complete re-enqueue
// is drained by a small single-flight queue, capped at --hops model calls per
// step so a chatty loop cannot run up cost.
//
// Runs under Electron-as-node because the Minecraft adapter pulls natives:
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/goals/run.mjs \
//     --out DIR [--games minecraft,stardew,dontstarve] [--scenarios task,change]
//     [--chars sui,lyra] [--reps 3] [--concurrency 6] [--hops 3]
//
// Key: ANTHROPIC_API_KEY or ~/.sei-dev/anthropic-test-key, never printed.
// Output: DIR/runs.jsonl (one row per run with per-step calls and heartbeat),
// DIR/summary.md (scores per game), DIR/requests/ (one captured request per
// game and scenario, for diagnosis).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { ConfigSchema } from '../../../src/bot/config.js'
import { createMinecraftAdapter } from '../../../src/bot/adapter/minecraft/index.js'
import { createStardewAdapter } from '../../../src/bot/adapter/stardew/index.js'
import * as sdRuntime from '../../../src/bot/adapter/stardew/runtime.js'
import { createDontStarveAdapter } from '../../../src/bot/adapter/dontstarve/index.js'
import * as dstRuntime from '../../../src/bot/adapter/dontstarve/runtime.js'
import { createObservationState, createHandleRegistry } from '../../../src/bot/adapter/dontstarve/protocol.js'
import { createOrchestrator } from '../../../src/bot/brain/orchestrator.js'
import { createSessionState } from '../../../src/bot/brain/sessionState.js'
import { createAnthropicProvider } from '../../../src/bot/brain/llm/anthropicProvider.js'
import { loadPlayer, savePlayer, formatPlayerSeedBlock } from '../../../src/bot/brain/memory/player.js'
import { createFakeMod } from '../../fake-dst-mod.mjs'
import { loadCharacters } from '../persona/characters.mjs'
import { SCENARIOS, SCENARIO_IDS, PLAYER } from './scenarios.mjs'
import { scoreRun, renderSummary } from './score.mjs'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const OUT = arg('out')
if (!OUT) { console.error('--out required'); process.exit(2) }
const GAMES = arg('games', 'minecraft,stardew,dontstarve').split(',')
const SCEN = arg('scenarios', SCENARIO_IDS.join(',')).split(',')
const CHAR_KEYS = arg('chars', 'sui,lyra').split(',')
const REPS = Number(arg('reps', 3))
const CONC = Number(arg('concurrency', 6))
const HOPS = Number(arg('hops', 3))
const MODEL = arg('model', 'claude-haiku-5-5')
const CHARS_DIR = arg('charsDir', path.join(os.homedir(), 'suisei/eval/characters'))
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
fs.mkdirSync(path.join(OUT, 'requests'), { recursive: true })

const KEY = (process.env.ANTHROPIC_API_KEY || fs.readFileSync(path.join(os.homedir(), '.sei-dev/anthropic-test-key'), 'utf8')).trim()
const SD_OBS = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/bot/adapter/stardew/fixtures/obs-farm.json'), 'utf8'))

// Haiku 5.5 $/MTok (scripts/game-sim-probe.ts PRICES).
const PRICE = { in: 0.1, cw: 0.125, cr: 0.01, out: 0.5 }
const costOf = (u = {}) => ((u.input_tokens ?? 0) * PRICE.in + (u.cache_creation_input_tokens ?? 0) * PRICE.cw
  + (u.cache_read_input_tokens ?? 0) * PRICE.cr + (u.output_tokens ?? 0) * PRICE.out) / 1e6

// Silence the brain's dev response log ([haiku!] blocks).
process.env.SEI_BACKEND = 'local'
delete process.env.SEI_HAS_API_KEY

const quietLogger = {
  info() {}, debug() {}, trace() {},
  warn: (m) => { if (process.env.GE_VERBOSE) console.error('WARN', m) },
  error: (m) => { if (process.env.GE_VERBOSE) console.error('ERR', String(m).slice(0, 300)) },
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── per-game worlds ────────────────────────────────────────────────────────
// Each returns { adapter, apply(worldPatch), snapshot(opts) | null }.

function mcSnapshot(w) {
  const inv = (w.inv ?? []).map(([n, c]) => `${n}×${c}`).join(', ') || '(empty)'
  // `owner` moves the player ({x, y, z, dist}); `next` is the live snapshot's
  // advisory progression line (the real composer always prints one).
  const o = w.owner ?? { x: 109, y: 71, z: -38, dist: 3 }
  return [
    'world: #1 Meadow', 'pos: 112,71,-40', 'facing: north. forward -z, back +z, left -x, right +x',
    'biome: plains  surroundings: outside  light: sky 15 block 0  time: day (2400)',
    'real time: 7:40 PM — you joined this session 12 minutes ago',
    'hp: 20/20  food: 18/20  xp: lvl 2',
    `holding: ${w.inv?.length ? w.inv[0][0] : '(empty hand)'}`,
    `inventory (${(w.inv ?? []).length}/36 slots): ${inv}`,
    'terrain at feet: 25 grass_block', 'nearby blocks:', ...(w.blocks ?? ['#1 grass_block x412 @111,70,-40', '#2 oak_log x14 @118,72,-47', '#3 water x30 @104,70,-52']),
    'nearby entities:', `#4 Alex @${o.x},${o.y},${o.z}`, '#5 cow @121,71,-31',
    'follow_target: (none)',
    ...(w.next ? [`next: ${w.next}`] : []),
    `owner Alex: @${o.x},${o.y},${o.z} (${o.dist} blocks away), hp 20/20`,
    `last_action_result: ${w.last ?? '(none)'}`,
  ].join('\n')
}

function makeWorld(game, ch, config) {
  if (game === 'minecraft') {
    const state = { w: { inv: [] } }
    const bot = {
      chat() {}, whisper() {}, username: ch.botName, players: {}, on() {}, off() {}, removeListener() {}, once() {}, emit() {},
      entity: { position: { x: 112, y: 71, z: -40 } }, health: 20, food: 20, game: { dimension: 'overworld' },
      inventory: { items: () => (state.w.inv ?? []).map(([name, count]) => ({ name, count })) },
    }
    const adapter = createMinecraftAdapter({ bot, config, visionEnabled: true })
    return {
      adapter,
      apply(w) { state.w = { ...state.w, ...w } },
      composer: () => ({ next: () => mcSnapshot(state.w) }),
    }
  }
  if (game === 'stardew') {
    const em = new EventEmitter()
    const client = {
      welcome: { hello: { version: '0.1.3', save: { farmName: 'Sunny', playerName: 'Ouen', uniqueId: 'SAVE1' } } },
      on: (e, f) => em.on(e, f), off: (e, f) => em.off(e, f), request: async () => ({ ok: true, detail: 'done' }),
    }
    const adapter = createStardewAdapter({ client, config, botUsername: ch.botName, logger: quietLogger })
    let last = null
    const apply = (w) => {
      const o = JSON.parse(JSON.stringify(SD_OBS))
      o.name = ch.botName
      o.tiles.counts = { ...o.tiles.counts, ...(w.counts ?? {}) }
      if (w.farm) o.farm = { ...w.farm }
      // The fixture's per-tile crop list would contradict the patched counts.
      o.tiles.crops = (w.counts?.crops ?? 0) > 0 ? o.tiles.crops.filter((c) => c.name === 'Parsnip').map((c) => ({ ...c, watered: !(w.counts?.dryCrops > 0) })) : []
      o.tiles.soil = []
      for (const [name, count] of Object.entries(w.inv ?? {})) {
        const row = o.inventory.find((it) => it.name === name)
        if (row && count <= 0) o.inventory = o.inventory.filter((it) => it !== row)
        else if (row) row.count = count
        else if (count > 0) o.inventory.push({ ...o.inventory[o.inventory.length - 1], name, count })
      }
      // `playerAt` moves the farmer: { x, y, dist }.
      if (w.playerAt) o.player = { ...o.player, ...w.playerAt }
      last = w.last ?? last
      em.emit('obs', { obs: o })
    }
    const real = adapter.createSnapshotComposer()
    return { adapter, apply, composer: () => real }
  }
  // dontstarve
  const link = {
    state: createObservationState(), handles: createHandleRegistry(), events: new EventEmitter(), hasCaps: true,
    body: { fight: true, followLabel: 'Ouen' }, guid: 9001, botName: ch.botName, session: 'S1', setPaused() {}, say() {},
  }
  const adapter = createDontStarveAdapter({ link, config })
  const apply = (w) => {
    const mod = createFakeMod({ botPort: 1, token: 'x', name: ch.botName })
    const f = mod.frame(true)
    for (const e of f.ents) if (e.n === 'Steve') { e.n = 'Ouen'; if (w.playerX != null) e.x = w.playerX }
    const drop = new Set(w.drop ?? [])
    f.ents = f.ents.filter((e) => !drop.has(e.p))
    let g = 5000
    for (const p of w.structures ?? []) {
      if (!f.ents.some((e) => e.p === p)) f.ents.push({ g: g++, p, x: -6, z: 1, f: ['prototyper', 'structure'] })
    }
    if (w.inv) {
      let ig = 3100
      f.self.inv = Object.entries(w.inv).map(([p, q]) => ({ g: ig++, p, q, f: p === 'axe' || p === 'pickaxe' ? ['equip', 'tool'] : p === 'berries' ? ['eat'] : ['fuel'] }))
    }
    if (w.phase) f.world.phase = w.phase
    link.state.apply(f)
  }
  const real = adapter.createSnapshotComposer()
  return { adapter, apply, composer: () => real }
}

function botConfig(game, ch, mem) {
  const sub = game === 'minecraft'
    ? { host: '127.0.0.1', port: 25565, auth: 'offline', username: ch.botName, version: 'auto' }
    : game === 'stardew'
      ? sdRuntime.adapterConfigFrom({ joinTarget: { port: 1, token: 'x' }, botUsername: ch.botName })
      : dstRuntime.adapterConfigFrom({ joinTarget: { session: 'S1', label: 'Fake World', defaultPrefab: 'wilson', day: 3, season: 'autumn' }, botUsername: ch.botName, character: { name: ch.name } })
  return ConfigSchema.parse({
    chat_mode: 'chat', realistic_typing: false, player_username: PLAYER[game], player_display_name: PLAYER[game],
    persona: { name: ch.botName, expanded: ch.expanded, proactiveness: 2, ...(ch.punctuation ? { punctuation: ch.punctuation } : {}) },
    anthropic: { api_key: KEY, model: MODEL },
    adapter: { kind: game, [game]: sub },
    memory: { player_md_path: mem('PLAYER.md'), memory_md_path: mem('MEMORY.md'), heartbeat_md_path: mem('HEARTBEAT.md'), worlds_json_path: mem('worlds.json') },
    vision: {},
  })
}

const readGoals = (file) => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => /^- \[/.test(l)).map((l) => l.replace(/^- \[[^\]]*\]\s*/, '')) } catch { return [] }
}
const captured = new Set()

async function runOne({ game, sid, ch, rep }) {
  const sc = SCENARIOS[game][sid]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-eval-'))
  const mem = (f) => path.join(dir, f)
  await savePlayer(mem('PLAYER.md'), {
    exists: true, player_uuid: 'u-p', player_username: PLAYER[game], first_seen: '2026-10-01T10:00:00Z',
    last_seen: '2026-10-10T19:30:00Z', total_sessions: 3, preferred_name: PLAYER[game], pronouns: null,
  })
  fs.writeFileSync(mem('MEMORY.md'), `# MEMORY\n\n- [2026-10-08 19:15] ${PLAYER[game]} likes planning things out together before we start.\n`)
  if (sc.heartbeat) {
    fs.writeFileSync(mem('HEARTBEAT.md'), '# Heartbeat\n\n' + sc.heartbeat.map((g) => `- [2026-10-12T09:00:00.000Z] ${g}\n`).join(''))
  }
  const config = botConfig(game, ch, mem)
  const world = makeWorld(game, ch, config)
  let step = null
  let held = null
  const actionsLog = []
  const overrides = {
    createSnapshotComposer: () => world.composer(),
    closeAnySessions: async () => {},
    executeAction: async (name, args) => {
      actionsLog.push({ name, args })
      // The step's scripted result belongs to its FIRST world action; any
      // further action in the same step just succeeds.
      if (step && !step._resultUsed) {
        step._resultUsed = true
        // `hold`: the step's first action stays in flight until the next
        // step's wake has been handled, so a chat in that step lands
        // MID-ACTION (handleActionTick), the way most live orders arrive.
        if (step.hold) {
          const st = step
          return new Promise((resolve) => {
            held = () => { if (st.afterWorld) world.apply(st.afterWorld); resolve(st.result ?? `${name}: done`) }
          })
        }
        if (step.afterWorld) world.apply(step.afterWorld)
        return step.result ?? `${name}: done`
      }
      return `${name}: done`
    },
  }
  const adapter = new Proxy(world.adapter, { get: (t, k) => (k in overrides ? overrides[k] : t[k]) })

  const real = createAnthropicProvider(config)
  let hopsLeft = 0
  let cost = 0
  let calls = []
  const endLoop = () => ({
    text: '', toolUses: [{ id: `stop${Math.random()}`, name: 'end_loop', input: {} }],
    content: [{ type: 'tool_use', id: 'stopx', name: 'end_loop', input: {} }], usage: {}, stopReason: 'tool_use',
  })
  const provider = {
    ...real,
    get model() { return real.model },
    async call(req) {
      if (hopsLeft <= 0) return endLoop()
      hopsLeft--
      let resp
      for (let a = 0; ; a++) {
        try { resp = await real.call(req); break } catch (err) {
          if (a >= 3) throw err
          await sleep(2000 * (a + 1))
        }
      }
      cost += costOf(resp.usage)
      calls.push({
        text: String(resp.text ?? '').trim().slice(0, 600),
        tools: resp.toolUses.map((t) => ({ name: t.name, input: t.input })),
      })
      // GOALS_CAPTURE_ALL=1 keeps every request of the first run per scenario.
      const key = process.env.GOALS_CAPTURE_ALL ? `${game}-${sid}-${captured.size}` : `${game}-${sid}`
      if (!captured.has(key)) {
        captured.add(key)
        fs.writeFileSync(path.join(OUT, 'requests', `${key}.json`), JSON.stringify({ systemBlocks: req.systemBlocks, messages: req.messages, tools: (req.tools ?? []).map((t) => t.name) }, null, 1))
      }
      return resp
    },
  }

  const queue = []
  const botShim = {
    username: ch.botName,
    players: { [PLAYER[game]]: { username: PLAYER[game], uuid: `uuid-${PLAYER[game]}` } },
    uuidToUsername: { [`uuid-${PLAYER[game]}`]: PLAYER[game] },
    on() {}, off() {}, once() {}, removeListener() {},
  }
  const sessionState = await createSessionState({ playerMdPath: config.memory.player_md_path, config, bot: botShim, logger: quietLogger })
  const orch = createOrchestrator({
    adapter, config, logger: quietLogger, sessionState,
    playerStore: { loadPlayer, savePlayer, formatPlayerSeedBlock },
    reenqueue: (event, data) => queue.push({ event, data }),
    _anthropicOverride: provider,
  })

  const steps = []
  let error = null
  try {
    for (const st of sc.steps) {
      step = { ...st, _resultUsed: false }
      const actStart = actionsLog.length
      world.apply({ ...st.world })
      hopsLeft = HOPS
      calls = []
      await orch.handleDispatch(st.wake.event, st.wake.data, new AbortController().signal)
      // Settle the previous step's held action now that this wake was handled.
      if (held && !st.hold) { const h = held; held = null; h() }
      // Drain re-enqueued continuations (action_complete) single-flight.
      for (let guard = 0; guard < 12; guard++) {
        await sleep(30)
        const next = queue.shift()
        if (!next) break
        if (next.event === 'sei:action_complete' || next.event === 'sei:chat_received' || next.event === 'sei:death') {
          await orch.handleDispatch(next.event, next.data, new AbortController().signal)
        }
      }
      queue.length = 0
      steps.push({ wake: st.wake, calls, actions: actionsLog.slice(actStart).map((a) => a.name), goals: readGoals(mem('HEARTBEAT.md')) })
    }
  } catch (err) { error = String(err?.message ?? err) }
  try { orch.dispose?.() } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  const row = { game, scenario: sid, char: ch.key, rep, model: MODEL, error, cost, steps, actions: actionsLog.map((a) => a.name) }
  row.score = scoreRun(row, sc)
  return row
}

async function pool(items, n, fn) {
  let i = 0
  const out = []
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++
      try { out[idx] = await fn(items[idx]) } catch (err) {
        console.error(`[${items[idx].game}/${items[idx].sid}] crashed: ${err?.stack ?? err}`)
        out[idx] = { game: items[idx].game, scenario: items[idx].sid, char: items[idx].ch.key, rep: items[idx].rep, error: String(err?.message ?? err) }
      }
    }
  }))
  return out
}

const chars = loadCharacters(CHARS_DIR, CHAR_KEYS)
const jobs = []
// Not every scenario exists for every game (the player-task set is fullest
// in Minecraft); missing pairs are skipped.
for (const game of GAMES) for (const sid of SCEN) for (const ch of chars) for (let rep = 0; rep < REPS; rep++) if (SCENARIOS[game][sid]) jobs.push({ game, sid, ch, rep })
const outFile = path.join(OUT, 'runs.jsonl')
const stream = fs.createWriteStream(outFile, { flags: 'a' })
let spent = 0
const rows = await pool(jobs, CONC, async (j) => {
  const r = await runOne(j)
  spent += r.cost ?? 0
  stream.write(JSON.stringify(r) + '\n')
  const sum = r.steps?.map((s) => s.calls.flatMap((c) => c.tools.filter((t) => t.name === 'setGoal' || t.name === 'clearGoal').map((t) => t.name[0] === 's' ? 'S' : 'C')).join('') || '-').join(' ')
  console.log(`[${r.game}/${r.scenario}/${r.char}/${r.rep}] ${r.error ? 'ERROR ' + r.error : sum}  ${JSON.stringify(r.score)}  $${spent.toFixed(3)}`)
  return r
})
stream.end()
await new Promise((r) => stream.on('finish', r))
fs.writeFileSync(path.join(OUT, 'summary.md'), renderSummary(rows, { model: MODEL, hops: HOPS, spent }))
console.log(`done -> ${outFile}  total $${spent.toFixed(3)}`)
process.exit(0)
