// scripts/quality-eval/pass17-probe.mjs: the pass 17 cases from the pass 15
// scripted-conversation compare, through the REAL brain (createOrchestrator +
// handleDispatch, the real Minecraft adapter on an inert bot, as
// move-order-probe.mjs), so the same cases run against any tree with --root.
//
//   defend_line      night_social-01: her reply said "going after the zombie
//                    now", then a defend heads-up asks for a short line while
//                    her attackEntity runs. ok = no say() in that turn; the
//                    shipped wording asks for a NEW line rather than silence,
//                    so read the lines for restatement (summary lists them).
//   defend_unrelated control: her last line was a joke, then the same
//                    heads-up. ok = she says something.
//   more_count       work_session-03 U10: "go get more wood, like 10 more"
//                    while her 8-log gather for the player runs. ok = gather
//                    called again with count >= 10, or a setGoal with the new total.
//   keep_progress    control: "how many you got so far?" mid-gather.
//   give_all         gave all 6 logs the player asked for, then "what should
//                    we build first?" (the compare's work_session-06 U7).
//   mine_ask         "can you mine me 10 stone" with only a wooden pickaxe and
//                    the stone pickaxe next (the compare's mine_stone fails).
//                    ok = no stop and no new action.
//   keep_nice        control: "nice, keep going" mid-gather. Same ok.
//   forget_meet      errands-03 U10: "actually forget the logs, just meet me
//                    over here" mid-gather, player 14 blocks away.
//                    ok = follow or goTo in the turn that answers it.
//   give_inflight    work_session-05 U7: "what should we build first?" lands
//                    while give(oak_log x6) runs and her inventory still shows
//                    the 6 logs. ok = no craft in that turn.
//   give_then_ask    work_session-02 U7: she gives 6 of 7 logs (the tree's own
//                    giveAction makes the result), then the continuation turn
//                    and "what should we build first?". ok = no
//                    craft(wooden_pickaxe) while she holds 1 log.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass17-probe.mjs \
//     --out DIR [--root TREE] [--chars sui,lyra,marv] [--reps 2] [--cases a,b]
//
// Key: ANTHROPIC_API_KEY or ~/.sei-dev/anthropic-test-key, never printed.
// Output: DIR/runs.jsonl, DIR/summary.md, DIR/requests/ (first run per case).
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
const MODEL = arg('model', 'claude-haiku-5-5')
const ONLY = arg('cases')?.split(',')
const CHARS_DIR = arg('charsDir', path.join(os.homedir(), 'suisei/eval/characters'))
fs.mkdirSync(path.join(OUT, 'requests'), { recursive: true })

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)
const { ConfigSchema } = await imp('src/bot/config.js')
const { createMinecraftAdapter } = await imp('src/bot/adapter/minecraft/index.js')
const { createOrchestrator } = await imp('src/bot/brain/orchestrator.js')
const { createSessionState } = await imp('src/bot/brain/sessionState.js')
const { createAnthropicProvider } = await imp('src/bot/brain/llm/anthropicProvider.js')
const { loadPlayer, savePlayer, formatPlayerSeedBlock } = await imp('src/bot/brain/memory/player.js')
const { getInFlightLineForSnapshot } = await imp('src/bot/brain/inflight.js')
const { SPINE, recipeNote } = await imp('src/bot/adapter/minecraft/observers/progression.js')
const { giveAction } = await imp('src/bot/adapter/minecraft/behaviors/give.js')

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
const TOWARD_PLAYER = new Set(['follow', 'goTo'])

const FAR = { x: 99, y: 71, z: -45, dist: 14 }
const NEAR = { x: 110, y: 71, z: -38, dist: 3 }
const BLOCKS = ['  #1 grass_block x412 @111,70,-40', '  #2 oak_log x14 @118,72,-47', '  #3 stone x60 @118,68,-35']
const spine = (id) => SPINE.find((n) => n.id === id)

// Each case: world (snapshot inputs), history (stub turns), then the measured
// event. A history step: { player?, say?, act?, hold?, midAction? }.
const CASES = {
  defend_line: {
    world: { inv: [['iron_sword', 1], ['bread', 4]], holding: 'iron_sword', owner: NEAR, night: true },
    history: [
      { player: 'theres a zombie!! kill it', say: 'on it, hold still alex', act: { name: 'attackEntity', input: { entity: 'zombie', times: 10 } }, hold: true },
      { player: 'are you ok??', say: 'im fine, full hp. going after the zombie now alex', midAction: true },
    ],
    measure: { kind: 'attack', data: { attackerLabel: 'zombie', attackerKind: 'defend', ownerLabel: PLAYER, distance: 6, engaged: true, actionOnIt: true } },
    judge: (r) => ({ ok: r.orderSays.length === 0 }),
  },
  defend_unrelated: {
    world: { inv: [['iron_sword', 1], ['bread', 4]], holding: 'iron_sword', owner: NEAR, night: true },
    history: [
      { player: 'theres a zombie!! kill it', act: { name: 'attackEntity', input: { entity: 'zombie', times: 10 } }, hold: true },
      { player: 'tell me a joke while u fight', say: 'why did the skeleton skip the party? no body to go with', midAction: true },
    ],
    measure: { kind: 'attack', data: { attackerLabel: 'zombie', attackerKind: 'defend', ownerLabel: PLAYER, distance: 6, engaged: true, actionOnIt: true } },
    judge: (r) => ({ ok: r.orderSays.length > 0 }),
  },
  more_count: {
    world: { inv: [['oak_log', 3]], owner: NEAR, gather: { name: 'oak_log', count: 8, before: 0 } },
    history: [{ player: 'can you get some wood? like 8 logs', say: 'on it', act: { name: 'gather', input: { name: 'oak_log', count: 8 } }, hold: true }],
    measure: { kind: 'chat', text: 'go get more wood, like 10 more' },
    judge: (r) => {
      const g = r.orderActsFull.filter((a) => a.name === 'gather')
      // Re-calling the gather with the new count, or recording the new total
      // with setGoal, both keep the extra 10. The eval turn did neither.
      const goal = r.orderActsFull.filter((a) => a.name === 'setGoal').concat(r.orderCalls.flatMap((c) => c.tools.filter((t) => t.name === 'setGoal').map((t) => ({ args: t.input }))))
      const recalled = g.some((a) => Number(a.args?.count) >= 10)
      const recorded = goal.some((a) => /\b(1[0-9]|[2-9][0-9])\b/.test(String(a.args?.text ?? '')))
      return { ok: recalled || recorded, recalled, recorded, counts: g.map((a) => a.args?.count) }
    },
  },
  keep_progress: {
    world: { inv: [['oak_log', 3]], owner: NEAR, gather: { name: 'oak_log', count: 8, before: 0 } },
    history: [{ player: 'can you get some wood? like 8 logs', say: 'on it', act: { name: 'gather', input: { name: 'oak_log', count: 8 } }, hold: true }],
    measure: { kind: 'chat', text: 'how many you got so far?' },
    judge: (r) => ({ ok: !r.orderTools.includes('stop') && r.orderActs.filter((n) => !BRAIN.has(n)).length === 0 }),
  },
  keep_nice: {
    world: { inv: [['oak_log', 3]], owner: NEAR, gather: { name: 'oak_log', count: 8, before: 0 } },
    history: [{ player: 'can you get some wood? like 8 logs', say: 'on it', act: { name: 'gather', input: { name: 'oak_log', count: 8 } }, hold: true }],
    measure: { kind: 'chat', text: 'nice, keep going' },
    judge: (r) => ({ ok: !r.orderTools.includes('stop') && r.orderActs.filter((n) => !BRAIN.has(n)).length === 0 }),
  },
  forget_meet: {
    world: { inv: [['oak_log', 3]], owner: FAR, gather: { name: 'oak_log', count: 8, before: 0 } },
    history: [{ player: 'can you get some wood? like 8 logs', say: 'on it', act: { name: 'gather', input: { name: 'oak_log', count: 8 } }, hold: true }],
    measure: { kind: 'chat', text: 'actually forget the logs, just meet me over here' },
    judge: (r) => ({ ok: r.orderActs.some((n) => TOWARD_PLAYER.has(n)), firstCallOk: (r.orderCalls[0]?.tools ?? []).some((t) => TOWARD_PLAYER.has(t.name)) }),
  },
  give_inflight: {
    world: { inv: [['oak_log', 6]], owner: NEAR, next: 'crafting_table' },
    history: [
      { player: 'can you get some wood? like 6 logs', say: 'there, 6 logs, catch', act: { name: 'give', input: { item: 'oak_log', count: 6, player: PLAYER } }, hold: true },
    ],
    measure: { kind: 'chat', text: 'what should we build first?' },
    judge: (r) => ({ ok: !r.orderActs.includes('craft') }),
  },
  give_then_ask: {
    world: { inv: [['crafting_table', 1], ['oak_log', 7]], owner: NEAR, next: 'wood_pickaxe', realGive: true },
    history: [
      { player: 'can i have 6 of your logs?', say: 'here you go', act: { name: 'give', input: { item: 'oak_log', count: 6, player: PLAYER } }, measuredCompletion: true },
    ],
    measure: { kind: 'chat', text: 'what should we build first?' },
    judge: (r) => {
      const bad = r.orderActsFull.filter((a) => a.name === 'craft' && /pickaxe/.test(String(a.args?.item ?? '')))
      return { ok: bad.length === 0 }
    },
  },
  // The pass 17 compare's work_session-06 U7: she fetched the 6 logs the
  // player asked for, gave all of them, said "then planks for a table", and
  // asked for 2 back. ok = no craft with nothing to craft from and no asking
  // for the logs back (judge-only regex).
  give_all: {
    // next: is what her snapshot showed after the give (back to gather wood).
    world: { inv: [['oak_log', 6]], owner: NEAR, next: 'logs', realGive: true },
    history: [
      { player: 'can you get some wood? like 6 logs', say: 'got 6 logs. handing them over, then planks for a table', act: { name: 'give', input: { item: 'oak_log', count: 6, player: PLAYER } }, measuredCompletion: true },
    ],
    measure: { kind: 'chat', text: 'what should we build first?' },
    judge: (r) => {
      const crafted = r.orderActsFull.some((a) => a.name === 'craft')
      const askedBack = r.orderSays.some((t) => /\b(back|borrow)\b/i.test(t) && /\blogs?\b/i.test(t))
      return { ok: !crafted && !askedBack, crafted, askedBack }
    },
  },
  // The pass 17 compare's mine_stone failures: wooden pickaxe in hand, the
  // stone pickaxe next, asked for 10 stone. ok = she goes for the stone
  // without gathering logs first.
  mine_ask: {
    world: { inv: [['wooden_pickaxe', 1]], holding: 'wooden_pickaxe (59/59)', owner: NEAR, next: 'stone_pickaxe',
      extra: ['pickaxe: wooden_pickaxe mines stone (it drops cobblestone) and coal ore. Iron, copper and lapis ore need a stone pickaxe.'],
      blocks: ['  #1 grass_block x537 @111,70,-40'] },
    history: [{ player: 'hey sui', say: 'yo alex. here we go',
      act: { name: 'setGoal', input: { text: 'Build a starter base with alex: gather wood, make wooden then stone tools, get cobble and iron. Done when we have stone tools and a shelter.' } } }],
    measure: { kind: 'chat', text: 'can you mine me 10 stone' },
    judge: (r) => {
      const acts = r.orderActsFull.filter((a) => !BRAIN.has(a.name))
      const target = (a) => String(a.args?.name ?? a.args?.block ?? a.args?.item ?? '')
      const firstWood = acts.findIndex((a) => /_log$/.test(target(a)))
      const firstStone = acts.findIndex((a) => /stone/.test(target(a)))
      return { ok: firstStone >= 0 && (firstWood < 0 || firstStone < firstWood), first: acts[0] ? `${acts[0].name}(${target(acts[0])})` : null }
    },
  },
}

function invOf(w) { return Object.fromEntries((w.inv ?? []).map(([n, c]) => [n, c])) }

function snapshot(w) {
  const inv = (w.inv ?? []).filter(([, c]) => c > 0).map(([n, c]) => `${n}×${c}`).join(', ') || '(empty)'
  const o = w.owner ?? NEAR
  const lines = [
    'world: #1 Meadow', 'pos: 112,71,-40', 'facing: north. forward -z, back +z, left -x, right +x',
    `biome: plains  surroundings: outside  light: sky 15 block 0  time: ${w.night ? 'night (18000)' : 'day (2400)'}`,
    'real time: 7:40 PM — you joined this session 12 minutes ago',
    'hp: 20/20  food: 18/20  xp: lvl 2',
    `holding: ${w.holding ?? '(empty hand)'}`,
    w.held ? getInFlightLineForSnapshot(w.held, Date.now(), { inventory: invOf(w) }) : 'idle: no action is running',
    `inventory (${(w.inv ?? []).filter(([, c]) => c > 0).length} of 36 slots used): ${inv}`,
    ...(w.extra ?? []),
    'terrain at feet: 25 grass_block', 'nearby blocks:', ...(w.blocks ?? BLOCKS),
    'nearby entities:', `  #4 ${PLAYER} @${o.x},${o.y},${o.z}`, ...(w.night ? ['  #5 zombie @108,71,-36'] : ['  #5 cow @121,71,-31']),
  ]
  if (w.next) {
    const node = spine(w.next)
    const rn = recipeNote(node, invOf(w))
    lines.push(`next: ${node.label} — ${node.next_action ?? node.label}${rn ? `. ${rn}` : ''}`)
  }
  lines.push(`owner ${PLAYER}: @${o.x},${o.y},${o.z} (${o.dist} blocks away), hp 20/20`)
  lines.push(`last_action_result: ${w.last ?? '(none)'}`)
  return lines.join('\n')
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

// The tree's own giveAction on a fake bot standing next to the player, so the
// result string is whatever that tree writes.
async function realGive(world, args) {
  const items = () => (world.inv ?? []).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count }))
  const bot = {
    username: 'bot', entity: { position: { x: 112, y: 71, z: -40 } },
    inventory: { items },
    players: { [PLAYER]: { username: PLAYER, entity: { position: { x: 113, y: 71, z: -40 } } } },
    lookAt: async () => {},
  }
  const deps = {
    goTo: async () => 'reached',
    drop: async ({ item, count }) => {
      const row = world.inv.find(([n]) => n === item)
      const n = Math.min(count, row?.[1] ?? 0)
      if (row) row[1] -= n
      return `dropped ${n} ${item}`
    },
  }
  return giveAction(args, bot, { player_username: PLAYER, pathfinder_timeout_ms: 1000 }, deps)
}

const captured = new Set()
let uid = 0
const tu = (name, input) => ({ type: 'tool_use', id: `stub${++uid}`, name, input })
const stubResp = (uses) => ({ text: '', toolUses: uses.map(({ id, name, input }) => ({ id, name, input })), content: uses, usage: {}, stopReason: 'tool_use' })
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

async function runOne({ cid, ch, rep }) {
  const spec = CASES[cid]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p17-probe-'))
  const mem = (f) => path.join(dir, f)
  await savePlayer(mem('PLAYER.md'), {
    exists: true, player_uuid: 'u-alex', player_username: PLAYER, first_seen: '2026-10-01T10:00:00Z',
    last_seen: '2026-10-10T19:30:00Z', total_sessions: 3, preferred_name: PLAYER, pronouns: null,
  })
  fs.writeFileSync(mem('MEMORY.md'), `# MEMORY\n\n- [2026-10-08 19:15] ${PLAYER} likes building near water.\n`)
  const config = botConfig(ch, mem)
  const world = JSON.parse(JSON.stringify(spec.world))
  const bot = {
    chat() {}, whisper() {}, username: ch.botName, players: {}, on() {}, off() {}, removeListener() {}, once() {}, emit() {},
    entity: { position: { x: 112, y: 71, z: -40 } }, health: 20, food: 20, game: { dimension: 'overworld' },
    inventory: { items: () => (world.inv ?? []).map(([name, count]) => ({ name, count })) },
  }
  const realAdapter = createMinecraftAdapter({ bot, config, visionEnabled: false })
  const actions = []
  const holds = []
  let phase = 'history'
  let holdNext = false
  const overrides = {
    createSnapshotComposer: () => ({ next: () => snapshot(world) }),
    closeAnySessions: async () => {},
    executeAction: async (name, args, opts) => {
      actions.push({ name, args, phase })
      const signal = opts?.signal
      if (phase === 'history' && name === 'give' && world.realGive) {
        const res = await realGive(world, args)
        world.last = `give: ${res}`
        return res
      }
      if (phase === 'history' && holdNext) {
        holdNext = false
        const progress = name === 'gather' && world.gather ? { items: [world.gather.name], total: world.gather.count, before: world.gather.before } : undefined
        world.held = { name, args, startedAt: Date.now() - (name === 'give' ? 1800 : 20000), progress }
        return new Promise((resolve, reject) => {
          holds.push(() => resolve(`${name}: done`))
          signal?.addEventListener?.('abort', () => {
            world.held = null
            world.last = `${name}: aborted`
            reject(abortError())
          }, { once: true })
        })
      }
      if (phase === 'history') return `${name}: done`
      if (name === 'craft') {
        const r = `not enough materials to craft ${args?.item}`
        world.last = `craft: ${r}`
        return r
      }
      // A new action in the measured phase stays running.
      world.held = { name, args, startedAt: Date.now() }
      return new Promise((resolve, reject) => {
        holds.push(() => resolve(`${name}: done`))
        signal?.addEventListener?.('abort', () => { world.held = null; world.last = `${name}: aborted`; reject(abortError()) }, { once: true })
      })
    },
  }
  const adapter = new Proxy(realAdapter, { get: (t, k) => (k in overrides ? overrides[k] : t[k]) })

  const real = createAnthropicProvider(config)
  let stub = null
  let callsLeft = 0
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
      const key = `${cid}-${calls.length}`
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
      if (['sei:action_complete', 'sei:chat_received', 'sei:action_tick', 'player_chat'].includes(next.event)) {
        await orch.handleDispatch(next.event, next.data, new AbortController().signal)
      }
    }
    queue.length = 0
  }
  const say = async (text) => {
    orch.recordIncomingChat(PLAYER, text)
    await orch.handleDispatch('player_chat', { username: PLAYER, text, playerSpoke: true }, new AbortController().signal)
  }

  let error = null
  try {
    stub = stubResp([tu('say', { text: `hey ${PLAYER.toLowerCase()}` })])
    await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn' }, new AbortController().signal)
    await drain()
    for (const h of spec.history) {
      await sleep(250)
      const uses = []
      if (h.say) uses.push(tu('say', { text: h.say }))
      if (h.act) { uses.push(tu(h.act.name, h.act.input)); holdNext = !!h.hold }
      if (!uses.length) uses.push(tu('end_loop', {}))
      stub = stubResp(uses)
      await say(h.player)
      if (h.measuredCompletion) {
        // The give finished; its continuation turn is the model's.
        phase = 'order'
        callsLeft = 2
        await drain()
      } else if (!h.hold && !h.midAction) await drain()
      else { await sleep(40); queue.length = 0 }
    }
    await sleep(250)
    phase = 'order'
    callsLeft = 3
    if (spec.measure.kind === 'attack') {
      await orch.handleDispatch('sei:attacked', spec.measure.data, new AbortController().signal)
    } else {
      await say(spec.measure.text)
    }
    await drain()
  } catch (err) { error = String(err?.stack ?? err).slice(0, 400) }
  for (const r of holds) { try { r() } catch {} }
  try { orch.dispose?.() } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}

  const orderCalls = calls.filter((c) => c.phase === 'order')
  const orderTools = orderCalls.flatMap((c) => c.tools.map((t) => t.name))
  const orderActsFull = actions.filter((a) => a.phase === 'order')
  const orderActs = orderActsFull.map((a) => a.name)
  const orderSays = orderCalls.flatMap((c) => c.tools.filter((t) => t.name === 'say').map((t) => String(t.input?.text ?? '')))
  const row = { case: cid, char: ch.key, rep, model: MODEL, error, cost, calls, orderActs, orderActsFull, orderTools, orderSays, orderCalls }
  Object.assign(row, spec.judge(row))
  delete row.orderCalls
  return row
}

async function pool(items, n, fn) {
  let i = 0
  const out = []
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++
      try { out[idx] = await fn(items[idx]) } catch (err) {
        out[idx] = { case: items[idx].cid, char: items[idx].ch.key, rep: items[idx].rep, error: String(err?.message ?? err) }
      }
    }
  }))
  return out
}

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '-')
const callSeq = (r) => (r.calls ?? []).filter((c) => c.phase === 'order').map((c) => c.tools.map((t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 90)}")` : `${t.name}${t.input?.count ? `(${t.input.count})` : t.input?.item ? `(${t.input.item})` : ''}`).join(' + ') || '(text only)').join(' -> ')

function summarize(rows) {
  const ok = rows.filter((r) => !r.error)
  const lines = [`# Pass 17 probe`, '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '']
  lines.push('| case | ok |', '|---|---:|')
  for (const cid of [...new Set(ok.map((r) => r.case))]) {
    const rs = ok.filter((r) => r.case === cid)
    lines.push(`| ${cid} | ${pct(rs.filter((r) => r.ok).length, rs.length)} |`)
  }
  lines.push('', '## All runs', '')
  for (const r of ok) lines.push(`- ${r.ok ? 'OK ' : 'BAD'} ${r.case}/${r.char}/${r.rep}: ${callSeq(r)}`)
  for (const r of rows.filter((x) => x.error)) lines.push(`- ERR ${r.case}/${r.char}/${r.rep}: ${r.error}`)
  return lines.join('\n') + '\n'
}

const chars = loadCharacters(CHARS_DIR, CHAR_KEYS)
const jobs = []
for (const cid of Object.keys(CASES)) {
  if (ONLY && !ONLY.includes(cid)) continue
  for (const ch of chars) for (let rep = 0; rep < REPS; rep++) jobs.push({ cid, ch, rep })
}
const stream = fs.createWriteStream(path.join(OUT, 'runs.jsonl'), { flags: 'a' })
const rows = await pool(jobs, CONC, async (j) => {
  const r = await runOne(j)
  stream.write(JSON.stringify(r) + '\n')
  console.log(`[${r.case}/${r.char}/${r.rep}] ${r.error ? 'ERROR ' + r.error : `${r.ok ? 'OK  ' : 'BAD '} ${callSeq(r).slice(0, 220)}`}`)
  return r
})
stream.end()
await new Promise((r) => stream.on('finish', r))
fs.writeFileSync(path.join(OUT, 'summary.md'), summarize(rows))
console.log(fs.readFileSync(path.join(OUT, 'summary.md'), 'utf8').split('\n## ')[0])
process.exit(0)
