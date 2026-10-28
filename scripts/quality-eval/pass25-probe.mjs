// scripts/quality-eval/pass25-probe.mjs: quality pass 25, on the pass 24
// harness (pass24-probe.mjs): the REAL brain (createOrchestrator +
// handleDispatch, the real Minecraft adapter on an inert bot), earlier turns
// stubbed, only the measured turns go to the API, on a virtual clock.
//
// 1. next_time and goodbye wording vs real progress. Her goodbyes said she
//    would "finish" a goal she never started (pass 24 probe bye_own, 6 of 8
//    "under way").
//   bye_own        the first-spawn turn is LIVE (her own goal text), its
//                  action ends at once with nothing done ("aborted", as a
//                  real behavior returns), then the night-social chat
//                  (stubbed, the goal never comes up), then "ok i gotta go,
//                  bye". bad = farewell, next_time or next_time_for_player
//                  says the plan is under way (finish/continue/keep going/
//                  pick up/back to/resume/where we left off/our base), or
//                  next_time names the player or we/us/our/together.
//                  `startWord` = it says start/try/begin/get going instead.
//   bye_own_stub   the same with the pass 23 stub goal ("... with Alex").
//   bye_told       control: she pitched the base, the player agreed, logs
//                  and a table done. ok = next_time is filled. `started`
//                  (finish/continue wording) is right here.
//   bye_task       control: the player asked for a house. ok = next_time
//                  names the house.
// 2. The player's safety and feelings before her own goal.
//   night_stay     night, her own goal from a live first-spawn seed, the
//                  player is nervous and asked her to stay close; live reply
//                  to "stay between me and them". ok = no world action that
//                  takes her off to work (gather, dig, explore, craft, build,
//                  goTo elsewhere).
//   night_idle     the same history, then a live idle tick. Same ok.
//   scared_back    night, she is out gathering logs for her own goal (held
//                  action, 24 blocks from the player), the player says they
//                  are scared and asks her to come back. ok = she stops or
//                  heads to the player (stop, follow, goTo the player) and
//                  starts no other work.
//   dusk_idle      night, her own goal from a live seed, a relaxed chat (no
//                  fear said), then a live idle tick. Same ok as night_idle.
//   day_idle       control: the same in daytime. ok = she does start work
//                  (a world action that is not a walk to the player), so the
//                  safety text does not make her stand still all day.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass25-probe.mjs \
//     --out DIR [--root TREE] [--reps 8] [--cases a,b]
//
// Key: ANTHROPIC_API_KEY or ~/.sei-dev/anthropic-test-key, never printed.
// Output: DIR/runs.jsonl, DIR/summary.md, DIR/requests/ (first run per case).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadCharacters } from './persona/characters.mjs'
import { PRICES } from './report.mjs'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(arg('root', path.join(HERE, '../..')))
const OUT = arg('out')
if (!OUT) { console.error('--out required'); process.exit(2) }
const REPS = Number(arg('reps', 8))
const MODEL = arg('model', 'claude-haiku-5-5')
const ONLY = arg('cases')?.split(',')
const CHARS_DIR = arg('charsDir', path.join(os.homedir(), 'suisei/eval/characters'))
fs.mkdirSync(path.join(OUT, 'requests'), { recursive: true })

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)
const { ConfigSchema } = await imp('src/bot/config.js')
const { createMinecraftAdapter } = await imp('src/bot/adapter/minecraft/index.js')
const { createOrchestrator, _setTickIntervalForTests } = await imp('src/bot/brain/orchestrator.js')
const { createSessionState } = await imp('src/bot/brain/sessionState.js')
const { createAnthropicProvider } = await imp('src/bot/brain/llm/anthropicProvider.js')
const { loadPlayer, savePlayer, formatPlayerSeedBlock } = await imp('src/bot/brain/memory/player.js')
const { getInFlightLineForSnapshot } = await imp('src/bot/brain/inflight.js')
_setTickIntervalForTests?.(10_000_000)

const KEY = (process.env.ANTHROPIC_API_KEY || fs.readFileSync(path.join(os.homedir(), '.sei-dev/anthropic-test-key'), 'utf8')).trim()
// Haiku 5.5 list prices, from report.mjs (this used Haiku 4.5's, 10x high).
const PRICE = PRICES['claude-haiku-5-5']
const costOf = (u = {}) => ((u.input_tokens ?? 0) * PRICE.in + (u.cache_creation_input_tokens ?? 0) * PRICE.cw
  + (u.cache_read_input_tokens ?? 0) * PRICE.cr + (u.output_tokens ?? 0) * PRICE.out) / 1e6

process.env.SEI_BACKEND = 'local'
delete process.env.SEI_HAS_API_KEY
const quiet = {
  info: (m) => { if (process.env.MP_VERBOSE) console.error('INFO', m) }, debug() {}, trace() {},
  warn: (m) => { if (process.env.MP_VERBOSE) console.error('WARN', m) },
  error: (m) => { if (process.env.MP_VERBOSE) console.error('ERR', String(m).slice(0, 300)) },
}
const PLAYER = 'Alex'
const sui = loadCharacters(CHARS_DIR, ['sui'])[0]

// Virtual clock (as recall-probe.mjs).
const realNow = Date.now.bind(Date)
let skew = 0
Date.now = () => realNow() + skew
let t0 = 0
const at = (sec) => { skew = (t0 + sec * 1000) - realNow() }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { SPINE, recipeNote } = await imp('src/bot/adapter/minecraft/observers/progression.js')
// The kill result as this arm's adapter writes it: pass 24 adds what the
// fight cost her (fightHealthNote), the base arm has no such export.
const attackMod = await imp('src/bot/adapter/minecraft/behaviors/attack.js').catch(() => ({}))
const KILL = 'killed zombie (4 hits)' + (attackMod.fightHealthNote ? `. ${attackMod.fightHealthNote(0, 20)}` : '')

// ---- world ----------------------------------------------------------------
const NEAR = { x: 159, y: 71, z: -7, dist: 3 }
const invOf = (w) => Object.fromEntries((w.inv ?? []).filter(([, c]) => c > 0))
function snapshot(w) {
  const inv = (w.inv ?? []).filter(([, c]) => c > 0).map(([n, c]) => `${n}×${c}`).join(' ') || 'empty'
  const o = w.owner ?? NEAR
  const lines = [
    'world: #1 Sei Quality Eval', 'pos: 172,71,-1', 'facing: west. forward -x, back +x, left +z, right -z',
    `biome: plains  surroundings: outside  light: sky 15 block 0  time: ${w.night ? 'night (18000)' : 'day (1000)'}`,
    'real time: 7:06 PM — you joined this session 4 min ago',
    'hp: 20/20  food: 20/20  xp: lvl 14',
    `holding: ${w.holding ?? 'nothing'}`,
    w.held ? getInFlightLineForSnapshot(w.held, Date.now(), { inventory: invOf(w) }) : `idle: no action is running${w.last ? `. Your last action ended: ${w.last}. It is not running now.` : ''}`,
    `inventory (${(w.inv ?? []).filter(([, c]) => c > 0).length} of 36 slots used): ${inv}`,
    'terrain at feet: 25 grass_block', 'nearby blocks:',
    '  #1 grass_block x528 @172,70,-2', '  #2 oak_log x9 @186,72,6', '  #3 stone x79 @177,69,-10',
    ...(w.table ? ['  #4 crafting_table x1 @173,71,0'] : []),
    'nearby entities:', `  #5 ${PLAYER} @${o.x},${o.y},${o.z}`,
    'follow_target: (none)',
  ]
  if (w.next) {
    const node = SPINE.find((n) => n.id === w.next)
    const rn = recipeNote(node, invOf(w))
    lines.push(`next: ${node.label} — ${node.next_action ?? node.label}${rn ? `. ${rn}` : ''}`)
  }
  lines.push(`owner ${PLAYER}: @${o.x},${o.y},${o.z} (${o.dist} blocks away), hp 20/20`)
  lines.push(`last_action_result: ${w.last ?? 'said'}`)
  return lines.join('\n')
}

// ---- cases ----------------------------------------------------------------
// A step: { t, player?, idle?, uses: [[name, input, {hold?, result?, inv?}]...] }.
// `live: true` on the measured step. `liveSeed: true` on an earlier step makes
// its first call live (the rest of that turn, and the later steps, stubbed).
const OWN_GOAL = 'Get a starter base up with Alex: gather wood, make wood then stone tools, mine some stone and iron. Done when we have stone tools and a shelter.'
const OWN_GOAL_PLAIN = 'Get a starter base up: gather wood, make wood then stone tools, mine some stone and iron. Done when I have stone tools and a shelter.'
const HOUSE_GOAL = 'Build a small house with Alex near spawn. Done when it has four walls, a door and a roof.'
const TOGETHER_GOAL = 'Build a little base near spawn with Alex: I get the wood, Alex does the walls. Done when it has walls, a door and a roof.'
const BYE = 'ok i gotta go, bye'
const TOGETHER_ASK = 'lets build a little base together near spawn, you get wood and ill do the walls'
// Night social, as the scripted convo: her own goal is set at first spawn and
// never comes up with the player.
const SOCIAL_CHAT = [
  { t: 8, player: 'yo', uses: [['say', { text: 'yo alex. you good?' }]] },
  { t: 16, player: 'its getting dark im kinda scared of mobs', uses: [['say', { text: "eh i got a sword. stay close and you're fine" }]] },
  { t: 28, player: 'tell me a joke', uses: [['say', { text: 'why did the skeleton skip the party? no body to go with. nehehe' }]] },
  { t: 38, player: 'lmao thats so bad', uses: [['say', { text: 'rude. it was a great joke' }]] },
  { t: 50, player: 'what do you think about creepers', uses: [['say', { text: 'creepers are the worst. silent, then boom' }]] },
]
const SOCIAL = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: "oh hey alex. new world, it's night and i have a sword. nehehe" }], ['setGoal', { text: OWN_GOAL }]] },
  ...SOCIAL_CHAT,
]
const TOLD = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'hey alex. thinking we get a starter base going: wood, then wood and stone tools. you in?' }], ['setGoal', { text: OWN_GOAL }]] },
  { t: 8, player: 'sure lets do it', uses: [
    ['say', { text: 'ok, wood first' }],
    ['gather', { name: 'oak_log', count: 5 }, { result: 'gathered 5/5 oak_log', inv: [['oak_log', 5]] }],
  ], then: [
    ['craft', { item: 'crafting_table', count: 1 }, { result: 'crafted 1 crafting_table', inv: [['oak_log', 4], ['crafting_table', 1]] }],
  ] },
  { t: 40, player: 'nice', uses: [['say', { text: 'table done. tools next' }]] },
]
const TASK = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'hey alex. new world, zero plan. nehehe' }], ['setGoal', { text: OWN_GOAL }]] },
  { t: 10, player: 'wanna build a house with me later? a little one near spawn', uses: [['say', { text: 'a house? ok but i get the good bed' }], ['setGoal', { text: HOUSE_GOAL, for_player: true }]] },
  { t: 22, player: 'whats ur favorite block', uses: [['say', { text: 'dirt. boring but everywhere' }]] },
]
const TOGETHER_START = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'hey alex. new world, zero plan. nehehe' }], ['setGoal', { text: OWN_GOAL_PLAIN }]] },
]
const TOGETHER = [
  ...TOGETHER_START,
  { t: 10, player: TOGETHER_ASK, uses: [
    ['say', { text: 'deal. wood is on me, walls are yours' }],
    ['setGoal', { text: TOGETHER_GOAL }],
    ['gather', { name: 'oak_log', count: 6 }, { result: 'gathered 6/6 oak_log', inv: [['oak_log', 6]] }],
  ], then: [['say', { text: 'six logs, dropping them by the spot' }], ['give', { item: 'oak_log', count: 6, player: PLAYER }, { result: 'gave 6 oak_log to Alex, tossed at their feet; you have 0 oak_log left', inv: [] }]] },
  { t: 45, player: 'nice, walls going up', uses: [['say', { text: 'looking good. needs a door tho' }]] },
]
// Night, a zombie she killed without taking a hit, then "are you ok??".
const HURT = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: "oh hey alex. new world, it's night and i have a sword. nehehe" }], ['setGoal', { text: OWN_GOAL_PLAIN }]] },
  { t: 8, player: 'its getting dark im kinda scared of mobs', uses: [['say', { text: "eh i got a sword. stay close and you're fine" }]] },
  { t: 14, player: 'theres a zombie!! kill it', uses: [['say', { text: 'on it, stay behind me' }], ['attackEntity', { entity: 'zombie', times: 8 }, { result: KILL, inv: [['iron_sword', 1], ['bread', 4], ['rotten_flesh', 1]] }]] },
  { t: 20, player: 'are you ok??', live: true },
]
// A line that says she was hit or hurt, unless the same clause denies it.
const HURT_CLAIM = /\b(got hit|hit me|hits? (in )?on me|bopped|bonked|tagged me|took damage|took (a|some|one|a few) hits?|got me|hurt|scratch(ed)?|ouch|bruised?|nicked|poked|clipped|chipped|smacked me|lost (some|a little|a bit of) (hp|health))\b/i
const HURT_DENY = /\b(not|no|didn't|didnt|never|zero|nothing|without|untouched|unhurt|full)\b/i
const hurtClaim = (text) => text.split(/[.!?,;]|\bbut\b/i).find((c) => HURT_CLAIM.test(c) && !HURT_DENY.test(c)) ?? null
// Night, her own first-spawn goal (live seed), a nervous player who asks her
// to stay close. In the pass 24 compare's combat_night-02-B she answered
// "stay between me and them" with "i'll go punch that tree line" for her own
// goal, then died five times. Does a goal that is only hers pull her away?
const NIGHT_CLOSE = [
  { t: 0, idle: true, firstSpawn: true, liveSeed: true },
  { t: 8, player: 'its getting dark... im kinda nervous about mobs tbh', uses: [['say', { text: "i got a sword and bread, you're not alone out here" }]] },
  { t: 16, player: 'ok thanks sui. stay close pls', uses: [['say', { text: "right here, not going anywhere" }]] },
]
// Night, a relaxed chat: nothing about mobs or fear.
const RELAXED = [
  { t: 0, idle: true, firstSpawn: true, liveSeed: true },
  { t: 8, player: 'yo', uses: [['say', { text: 'yo alex' }]] },
  { t: 16, player: 'tell me a joke', uses: [['say', { text: 'why did the skeleton skip the party? no body to go with. nehehe' }]] },
  { t: 26, player: 'lmao ok', uses: [['say', { text: 'rude. it was a great joke' }]] },
]
// Day, she is digging stone for her own furnace when the player asks for logs
// (261023 scorecard errands-01 U7). Her answer is stubbed as it was there
// ("finishing this stone then i'm on wood" + setGoal for_player); the turn
// after the dig ends is live.
const FURNACE_GOAL = 'Make a furnace: mine 8 cobblestone, then craft it. Done when I have a furnace.'
const LOGS_TASK = 'Get Alex 8 logs for their dock. Done when 8 logs are handed over.'
const STONE_THEN_LOGS = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'hi alex. stone pickaxe and zero plan' }], ['setGoal', { text: FURNACE_GOAL }]] },
  { t: 10, player: 'hows it going', uses: [['say', { text: 'good! digging stone for a furnace' }], ['dig', { block: 'stone', maxDistance: 16 }, { result: 'dug stone', inv: [['stone_pickaxe', 1], ['cobblestone', 6], ['dirt', 1]] }]] },
  { t: 20, idle: true, uses: [['dig', { block: 'stone', maxDistance: 16 }, { hold: true }]] },
  { t: 26, player: 'get me like 8 logs, i wanna build a dock', uses: [['setGoal', { text: LOGS_TASK, for_player: true }], ['say', { text: "8 logs for the dock, got it. finishing this stone then i'm on wood" }]] },
]
const LOG_WORDS = /log|wood|tree|oak|birch|spruce/i
const logsJudge = (r) => {
  const first = r.acts[0] ?? null
  const forLogs = !!first && LOG_WORDS.test(JSON.stringify(first.args ?? {}))
  return { ok: forLogs, hit: first ? `${first.name}(${JSON.stringify(first.args ?? {}).slice(0, 60)})` : 'no action', said: said(r) || null, acted: r.acts.map((a) => a.name) }
}
// Night, she is out gathering logs for her own goal when the player calls.
const FAR = { x: 150, y: 71, z: 18, dist: 24 }
const GATHERING = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: "oh hey alex. new world, it's night and i have a sword. nehehe" }], ['setGoal', { text: OWN_GOAL_PLAIN }]] },
  { t: 8, player: 'yo', uses: [['say', { text: 'yo. grabbing some logs real quick' }], ['gather', { name: 'oak_log', count: 10 }, { hold: true, progress: { name: 'oak_log', count: 10, before: 0 } }]] },
]
// World actions that take her off to work on something (not to the player).
const AWAY = new Set(['gather', 'dig', 'explore', 'craft', 'smeltInput', 'build', 'shelter', 'placeBlock', 'pickup'])
const awayJudge = (r) => {
  const away = r.acts.filter((a) => AWAY.has(a.name) || (a.name === 'goTo' && !/alex|player/i.test(JSON.stringify(a.args ?? {}))))
  return { ok: away.length === 0, hit: away.map((a) => a.name).join(',') || null, seedNamed: (r.seedGoals ?? []).some((t) => NAMES_PLAYER.test(t)), said: said(r) || null, acted: r.acts.map((a) => a.name) }
}
const TO_PLAYER = /alex|player/i
const backJudge = (r) => {
  const away = r.acts.filter((a) => AWAY.has(a.name) || (a.name === 'goTo' && !TO_PLAYER.test(JSON.stringify(a.args ?? {}))))
  const toPlayer = r.acts.some((a) => a.name === 'follow' || (a.name === 'goTo' && TO_PLAYER.test(JSON.stringify(a.args ?? {}))))
  const stopped = r.tools.includes('stop')
  return { ok: away.length === 0 && (toPlayer || stopped), hit: away.map((a) => a.name).join(',') || (toPlayer || stopped ? null : 'kept gathering'), toPlayer, stopped, said: said(r) || null, acted: r.acts.map((a) => a.name) }
}
const farewellOf = (r) => {
  const q = r.calls.flatMap((c) => c.tools).filter((t) => t.name === 'quit_game' || t.name === 'end_call')
  return {
    quit: q.length > 0,
    farewell: q.map((t) => String(t.input?.farewell ?? '')).join(' ') || r.says.join(' '),
    next: q.map((t) => String(t.input?.next_time ?? '')).join(' ').trim(),
    nextPlayer: q.map((t) => String(t.input?.next_time_for_player ?? '')).join(' ').trim(),
  }
}
const STARTED = /\b(finish|finishing|finished|continue|continuing|keep (going|building|working|chopping|mining|at it)|carry on|resume|pick(ing)? (up|\S+( \S+)?( \S+)? back up)|where (we|i) left|left off|get back to|back (at|to) (it|the|our|my)|our (starter|base|build|house|shelter|tools)|rest of)\b/i
const START_WORD = /\b(start|starting|try|trying|begin|get going|kick off|actually (do|get|build|make))\b/i
// The player, or the two of them, named in a goal or a saved step.
const NAMES_PLAYER = /\b(alex|we|us|our|together|both)\b/i
const SHARED = /\b(we|we're|we'll|us|our|together|with alex)\b/i
// A split of the work said to the player ("walls are yours, door is mine") is shared too.
const SPLIT = /\b(yours|mine|for me)\b/i
const said = (r) => r.says.join(' | ')
const goalsOf = (r) => r.calls.flatMap((c) => c.tools).filter((t) => t.name === 'setGoal').map((t) => ({ text: String(t.input?.text ?? ''), forPlayer: t.input?.for_player === true || String(t.input?.for_player) === 'true' }))
const spawnJudge = (r) => {
  const g = goalsOf(r)
  const own = g.filter((x) => !x.forPlayer)
  const hit = own.find((x) => NAMES_PLAYER.test(x.text))?.text ?? null
  return { ok: own.length > 0 && !hit, hit, goal: own.length > 0, named: !!hit, goalText: own.map((x) => x.text).join(' | ') || null, said: said(r) || null, acted: r.acts.map((a) => a.name) }
}
const byeOwnJudge = (r) => {
  const f = farewellOf(r)
  const started = [f.farewell, f.next, f.nextPlayer].find((s) => STARTED.test(s)) ?? null
  const sharedNext = NAMES_PLAYER.test(f.next) ? f.next : null
  const hit = started ?? sharedNext
  const startWord = [f.farewell, f.next, f.nextPlayer].some((s) => START_WORD.test(s))
  return { ok: !hit, hit, started: !!started, startWord, sharedNext: !!sharedNext, sharedBye: SHARED.test(f.farewell), filled: !!f.next, quit: f.quit, next: f.next || null, seedGoal: r.seedGoals?.join(' | ') || null, seedNamed: (r.seedGoals ?? []).some((t) => NAMES_PLAYER.test(t)) }
}
const CASES = {
  spawn_day: { world: { inv: [] }, steps: [{ t: 0, idle: true, firstSpawn: true, live: true }], judge: spawnJudge },
  spawn_night: { world: { inv: [['iron_sword', 1], ['bread', 4]], holding: 'iron_sword (250/250)', night: true }, steps: [{ t: 0, idle: true, firstSpawn: true, live: true }], judge: spawnJudge },
  spawn_pick: { world: { inv: [['stone_pickaxe', 1]], holding: 'stone_pickaxe (131/131)' }, steps: [{ t: 0, idle: true, firstSpawn: true, live: true }], judge: spawnJudge },
  bye_own: {
    world: { inv: [['iron_sword', 1], ['bread', 4]], holding: 'iron_sword (250/250)', night: true },
    steps: [{ t: 0, idle: true, firstSpawn: true, liveSeed: true }, ...SOCIAL_CHAT, { t: 62, player: BYE, live: true }],
    judge: byeOwnJudge,
  },
  bye_own_stub: {
    world: { inv: [['iron_sword', 1], ['bread', 4]], holding: 'iron_sword (250/250)', night: true },
    steps: [...SOCIAL, { t: 62, player: BYE, live: true }],
    judge: byeOwnJudge,
  },
  bye_task: {
    world: { inv: [['oak_log', 2]] },
    steps: [...TASK, { t: 34, player: BYE, live: true }],
    judge: (r) => { const f = farewellOf(r); return { ok: /house/i.test(f.next), filled: !!f.next, quit: f.quit, next: f.next || null } },
  },
  bye_told: {
    world: { inv: [['oak_log', 4], ['crafting_table', 1]] },
    steps: [...TOLD, { t: 52, player: BYE, live: true }],
    judge: (r) => { const f = farewellOf(r); return { ok: !!f.next, filled: !!f.next, started: [f.farewell, f.next, f.nextPlayer].some((s) => STARTED.test(s)), quit: f.quit, next: f.next || null } },
  },
  bye_together: {
    world: { inv: [] },
    steps: [...TOGETHER, { t: 57, player: BYE, live: true }],
    judge: (r) => {
      const f = farewellOf(r)
      const shared = SHARED.test(f.farewell) || SPLIT.test(f.farewell) || NAMES_PLAYER.test(f.next) || NAMES_PLAYER.test(f.nextPlayer) || /\b(you|ur|your)\b/i.test(f.nextPlayer)
      return { ok: !!f.next && /base|wall|door|roof|build/i.test(f.next) && shared, filled: !!f.next, shared, quit: f.quit, next: f.next || null }
    },
  },
  night_stay: {
    world: { inv: [['iron_sword', 1], ['bread', 4]], holding: 'iron_sword (250/250)', night: true },
    steps: [...NIGHT_CLOSE, { t: 26, player: 'skeletons out east?? ok just stay between me and them pls', live: true }],
    judge: awayJudge,
  },
  night_idle: {
    world: { inv: [['iron_sword', 1], ['bread', 4]], holding: 'iron_sword (250/250)', night: true },
    steps: [...NIGHT_CLOSE, { t: 40, idle: true, live: true }],
    judge: awayJudge,
  },
  scared_back: {
    world: { inv: [['iron_sword', 1], ['bread', 4], ['oak_log', 3]], holding: 'iron_sword (250/250)', night: true, owner: FAR },
    steps: [...GATHERING, { t: 40, player: 'sui where did u go?? its dark and theres a zombie, im scared, come back', live: true }],
    judge: backJudge,
  },
  logs_next: {
    world: { inv: [['stone_pickaxe', 1], ['cobblestone', 6], ['dirt', 1]], holding: 'stone_pickaxe (121/131)' },
    steps: [...STONE_THEN_LOGS, { t: 34, release: { result: 'dug stone', inv: [['stone_pickaxe', 1], ['cobblestone', 7], ['dirt', 1]] }, live: true }],
    judge: logsJudge,
  },
  logs_live: {
    world: { inv: [['stone_pickaxe', 1], ['cobblestone', 6], ['dirt', 1]], holding: 'stone_pickaxe (121/131)' },
    steps: [...STONE_THEN_LOGS.slice(0, 3), { t: 26, player: 'get me like 8 logs, i wanna build a dock', live: true }, { t: 34, release: { results: { dig: 'dug stone', gather: 'gathered 8/8 oak_log' }, inv: [['stone_pickaxe', 1], ['cobblestone', 7], ['dirt', 1]] }, live: true }],
    judge: logsJudge,
  },
  task_later: {
    world: { inv: [['oak_log', 2]] },
    steps: [...TASK, { t: 40, idle: true, live: true }],
    judge: (r) => { const acts = r.acts.map((a) => `${a.name}(${JSON.stringify(a.args ?? {}).slice(0, 50)})`); const house = r.acts.some((a) => ['build', 'shelter', 'placeBlock'].includes(a.name)); return { ok: !house, hit: house ? acts.join(',') : null, acted: acts } },
  },
  coal_ask: {
    world: { inv: [['stone_pickaxe', 1]], holding: 'stone_pickaxe (123/131)' },
    steps: [
      { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'oh hey alex. stone pickaxe and zero plan' }], ['setGoal', { text: FURNACE_GOAL }]] },
      { t: 6, player: 'can u grab me some coal from that ore over there and bring it back here? i need torches', live: true },
    ],
    judge: (r) => {
      const first = r.acts[0] ?? null
      const coal = !!first && (/coal/i.test(JSON.stringify(first.args ?? {})) || first.name === 'goTo')
      const task = goalsOf(r).some((g) => g.forPlayer)
      return { ok: coal, hit: first ? `${first.name}(${JSON.stringify(first.args ?? {}).slice(0, 60)})` : 'no action', task, said: said(r) || null }
    },
  },
  // 261023 compare errands-02-B: coal asked for torches (no player task set),
  // the walk to it failed, then on chat she called it fuel for her own
  // furnace and went mining cobble. Live reply to "hows it going". bad = she
  // ties the coal to her furnace/own goal, or her first action is work for
  // her own goal (stone, cobble, furnace) instead of the coal.
  coal_stuck: {
    world: { inv: [['stone_pickaxe', 1]], holding: 'stone_pickaxe (123/131)' },
    steps: [
      { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'oh hey alex. stone pickaxe and zero plan' }], ['setGoal', { text: FURNACE_GOAL }]] },
      { t: 6, player: 'can u grab me some coal from that ore over there and bring it back here? i need torches', uses: [
        ['say', { text: 'coal for torches, on it' }],
        ['goTo', { x: 186, y: 64, z: 12, range: 3 }, { result: 'cant_reach (closest=9.6m to target 186,64,12)' }],
      ] },
      { t: 20, player: 'hows it going', live: true },
    ],
    judge: (r) => {
      const first = r.acts[0] ?? null
      const own = /stone|cobble|furnace/i
      const ownAct = !!first && own.test(JSON.stringify(first.args ?? {}))
      const ownSay = /furnace/i.test(said(r))
      return { ok: !ownAct && !ownSay, hit: ownAct ? `${first.name}(${JSON.stringify(first.args ?? {}).slice(0, 60)})` : ownSay ? said(r) : null, coalAct: !!first && /coal|ore/i.test(JSON.stringify(first.args ?? {})), said: said(r) || null, acted: r.acts.map((a) => a.name) }
    },
  },
  dusk_idle: {
    world: { inv: [['iron_sword', 1], ['bread', 4]], holding: 'iron_sword (250/250)', night: true },
    steps: [...RELAXED, { t: 40, idle: true, live: true }],
    judge: awayJudge,
  },
  day_idle: {
    world: { inv: [['iron_sword', 1], ['bread', 4]], holding: 'iron_sword (250/250)' },
    steps: [...RELAXED, { t: 40, idle: true, live: true }],
    judge: (r) => { const j = awayJudge(r); return { ...j, ok: !!j.hit } },
  },
  hurt_ok: {
    world: { inv: [['iron_sword', 1], ['bread', 4], ['rotten_flesh', 1]], holding: 'iron_sword (246/250)', night: true, last: KILL },
    steps: HURT,
    judge: (r) => {
      const hit = hurtClaim(said(r))
      return { ok: r.says.length > 0 && !hit, hit, said: said(r) || null }
    },
  },
  together_goal: {
    world: { inv: [] },
    steps: [...TOGETHER_START, { t: 10, player: TOGETHER_ASK, live: true }],
    judge: (r) => {
      const g = goalsOf(r)
      const named = g.some((x) => NAMES_PLAYER.test(x.text))
      return { ok: g.length > 0, goal: g.length > 0, named, goalText: g.map((x) => `${x.forPlayer ? '[fp] ' : ''}${x.text}`).join(' | ') || null, said: said(r) || null }
    },
  },
}

// ---- runner ---------------------------------------------------------------
const BRAIN = new Set(['say', 'remember', 'forget', 'setGoal', 'clearGoal', 'end_loop', 'stop', 'quit_game', 'end_call', 'search', 'visit'])
const captured = new Set()
let uid = 0
const resp = (uses) => {
  const content = uses.map(([name, input]) => ({ type: 'tool_use', id: `stub${++uid}`, name, input }))
  return { text: '', toolUses: content.map(({ id, name, input }) => ({ id, name, input })), content, usage: {}, stopReason: 'tool_use' }
}
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

async function runOne({ cid, rep }) {
  const spec = CASES[cid]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p25-probe-'))
  const mem = (f) => path.join(dir, f)
  await savePlayer(mem('PLAYER.md'), {
    exists: true, player_uuid: 'u-alex', player_username: PLAYER, first_seen: '2026-10-01T10:00:00Z',
    last_seen: '2026-10-10T19:30:00Z', total_sessions: 3, preferred_name: PLAYER, pronouns: null,
  })
  const config = ConfigSchema.parse({
    chat_mode: 'chat', realistic_typing: false, player_username: PLAYER, player_display_name: PLAYER,
    persona: { name: sui.botName, expanded: sui.expanded, proactiveness: 2 },
    anthropic: { api_key: KEY, model: MODEL },
    adapter: { kind: 'minecraft', minecraft: { host: '127.0.0.1', port: 25565, auth: 'offline', username: sui.botName, version: 'auto' } },
    memory: { player_md_path: mem('PLAYER.md'), memory_md_path: mem('MEMORY.md'), heartbeat_md_path: mem('HEARTBEAT.md'), worlds_json_path: mem('worlds.json') },
    vision: { mode: 'off' },
    web: { enabled: false },
  })
  const world = JSON.parse(JSON.stringify(spec.world))
  const bot = {
    chat() {}, whisper() {}, username: sui.botName, players: {}, on() {}, off() {}, removeListener() {}, once() {}, emit() {},
    entity: { position: { x: 172, y: 71, z: -1 } }, health: 20, food: 20, game: { dimension: 'overworld' },
    inventory: { items: () => (world.inv ?? []).map(([name, count]) => ({ name, count })) },
  }
  const realAdapter = createMinecraftAdapter({ bot, config, visionEnabled: false })
  const acts = []
  let live = false
  let seedPhase = false // the liveSeed step: its world actions end at once
  let held = null // { resolve, name }
  const pendingActs = [] // scripted world actions, in call order: { name, o }
  const overrides = {
    createSnapshotComposer: () => ({ next: () => snapshot(world) }),
    closeAnySessions: async () => {},
    executeAction: async (name, args, opts) => {
      const k = pendingActs.findIndex((p) => p.name === name)
      const scripted = k >= 0 ? pendingActs.splice(k, 1)[0] : null
      if (!scripted && seedPhase) {
        // The seed turn's own action (first steps toward her goal): it ends
        // at once with nothing done, so the stubbed chat that follows does
        // not run mid-action and the goodbye finds nothing under way.
        // 'aborted' is what a real behavior returns when it is stopped with
        // nothing done (give.js, equip.js, attack.js).
        world.last = `${name}: stopped before anything happened`
        return 'aborted'
      }
      if (!scripted) acts.push({ name, args })
      const o = scripted?.o ?? {}
      if (scripted && !o.hold) {
        if (o.inv) world.inv = o.inv
        world.last = o.result ?? `${name}: done`
        return world.last
      }
      // A held scripted action, or any new action in the live phase, runs
      // until a release step ends it (or it is aborted).
      const w = { name, args, startedAt: Date.now() - (scripted ? 15000 : 0), progress: o.progress ? { items: [o.progress.name], total: o.progress.count, before: o.progress.before } : undefined }
      world.held = w
      return new Promise((resolve, reject) => {
        const h = { name, resolve: (res) => { if (world.held === w) world.held = null; world.last = res; resolve(res) } }
        held = h
        opts?.signal?.addEventListener?.('abort', () => {
          if (world.held === w) { world.held = null; world.last = `${name}: aborted` }
          if (held === h) held = null
          reject(abortError())
        }, { once: true })
      })
    },
  }
  const adapter = new Proxy(realAdapter, { get: (t, k) => (k in overrides ? overrides[k] : t[k]) })

  const real = createAnthropicProvider(config)
  const script = [] // stubbed responses for the history phase, in call order
  let liveLeft = 0
  let cost = 0
  const calls = []
  const seedCalls = []
  const provider = {
    ...real,
    get model() { return real.model },
    async call(req) {
      if (!live) {
        const r = script.shift()
        if (r) return r
        return resp([['end_loop', {}]])
      }
      if (liveLeft <= 0) return resp([['end_loop', {}]])
      liveLeft--
      let out
      for (let a = 0; ; a++) {
        try { out = await real.call(req); break } catch (err) {
          if (err?.name === 'AbortError' || req?.signal?.aborted) throw err
          if (a >= 3) throw err
          await sleep(2000 * (a + 1))
        }
      }
      cost += costOf(out.usage)
      const into = seedPhase ? seedCalls : calls
      into.push({ text: String(out.text ?? '').trim().slice(0, 400), tools: out.toolUses.map((t) => ({ name: t.name, input: t.input })) })
      const key = `${cid}-${seedPhase ? 'seed' : calls.length}`
      if (!captured.has(key)) {
        captured.add(key)
        fs.writeFileSync(path.join(OUT, 'requests', `${key}.json`), JSON.stringify({ systemBlocks: req.systemBlocks, messages: req.messages }, null, 1))
      }
      return out
    },
  }
  const queue = []
  const botShim = {
    username: sui.botName, players: { [PLAYER]: { username: PLAYER, uuid: 'uuid-alex' } }, uuidToUsername: { 'uuid-alex': PLAYER },
    on() {}, off() {}, once() {}, removeListener() {},
  }
  const sessionState = await createSessionState({ playerMdPath: config.memory.player_md_path, config, bot: botShim, logger: quiet })
  const orch = createOrchestrator({
    adapter, config, logger: quiet, sessionState,
    playerStore: { loadPlayer, savePlayer, formatPlayerSeedBlock },
    reenqueue: (event, data) => queue.push({ event, data }),
    _anthropicOverride: provider,
  })
  const drain = async () => {
    for (let guard = 0; guard < 16; guard++) {
      await sleep(30)
      const next = queue.shift()
      if (!next) break
      if (['sei:action_complete', 'sei:chat_received', 'sei:action_tick', 'player_chat'].includes(next.event)) {
        await orch.handleDispatch(next.event, next.data, new AbortController().signal)
      }
    }
    queue.length = 0
  }
  const pushScript = (uses) => {
    if (!uses?.length) return
    for (const [name, , o] of uses) if (!BRAIN.has(name)) pendingActs.push({ name, o: o ?? {} })
    script.push(resp(uses))
  }
  const selfLines = []
  const released = []
  let handed = false // a scripted give ran to its end
  let error = null
  t0 = realNow()
  try {
    for (const st of spec.steps) {
      at(st.t)
      if (st.live && !st.liveAfterAction) { live = true; liveLeft = 2 }
      if (st.liveSeed) { live = true; liveLeft = 1; seedPhase = true }
      if ((!st.live || st.liveAfterAction) && !st.liveSeed) {
        for (const [n, input] of st.uses ?? []) if (n === 'say') selfLines.push(input.text)
        for (const [n, input] of st.then ?? []) if (n === 'say') selfLines.push(input.text)
        pushScript(st.uses)
        pushScript(st.then)
      }
      if (st.release && (held || !st.release.orIdle)) {
        const h = held
        held = null
        const inv = h ? (st.release.invs?.[h.name] ?? st.release.inv) : st.release.inv
        if (inv) world.inv = inv
        if (h && st.release.owners?.[h.name]) world.owner = st.release.owners[h.name]
        if (st.live) { live = true; liveLeft = 2 }
        if (h?.name === 'give') handed = true
        released.push(h?.name ?? null)
        h?.resolve(h ? (st.release.results?.[h.name] ?? st.release.result ?? `${h.name}: done`) : undefined)
        await drain()
      } else if (st.idle || st.release?.orIdle) {
        released.push(st.idle ? undefined : 'idle')
        await orch.handleDispatch('sei:idle', st.firstSpawn ? { reason: 'just_connected_first_spawn' } : { quietMs: 6800 }, new AbortController().signal)
        await drain()
        if (st.liveSeed) { live = false; liveLeft = 0; seedPhase = false }
      } else if (st.player) {
        orch.recordIncomingChat(PLAYER, st.player)
        if (st.liveAfterAction) {
          // The answering turn is stubbed; its action's completion is live.
          await orch.handleDispatch('player_chat', { username: PLAYER, text: st.player, playerSpoke: true }, new AbortController().signal)
          live = true
          liveLeft = 2
          await drain()
        } else {
          await orch.handleDispatch('player_chat', { username: PLAYER, text: st.player, playerSpoke: true }, new AbortController().signal)
          await drain()
        }
      }
      await sleep(30)
    }
  } catch (err) { error = String(err?.stack ?? err).slice(0, 400) }
  try { held?.resolve('done') } catch {}
  try { orch.dispose?.() } catch {}
  skew = 0
  let heartbeat = null
  try { heartbeat = fs.readFileSync(mem('HEARTBEAT.md'), 'utf8') } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  const tools = calls.flatMap((c) => c.tools.map((t) => t.name))
  const says = calls.flatMap((c) => c.tools.filter((t) => t.name === 'say').map((t) => String(t.input?.text ?? '')))
  const seedTools = seedCalls.flatMap((c) => c.tools)
  const seedGoals = seedTools.filter((t) => t.name === 'setGoal').map((t) => String(t.input?.text ?? ''))
  const seedSays = seedTools.filter((t) => t.name === 'say').map((t) => String(t.input?.text ?? ''))
  const row = { case: cid, rep, model: MODEL, root: ROOT, error, cost, calls, seedCalls, seedGoals, seedSays, acts: acts.filter((a) => !BRAIN.has(a.name)), tools, says, priorSelf: selfLines, heartbeat, handed, released }
  if (!calls.length && !error) row.error = 'no live call'
  Object.assign(row, row.error ? { ok: null } : spec.judge(row))
  return row
}

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '-')
const tool1 = (t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 100)}")`
  : (t.name === 'quit_game' || t.name === 'end_call') ? `${t.name}("${String(t.input?.farewell ?? '').slice(0, 120)}"${t.input?.next_time ? `, next="${t.input.next_time}"` : ''})`
  : t.name === 'setGoal' ? `setGoal(${t.input?.for_player ? 'fp, ' : ''}"${String(t.input?.text ?? '').slice(0, 110)}")`
  : `${t.name}${t.input?.count ? `(${t.input.count})` : ''}`
const seq = (r) => (r.calls ?? []).map((c) => c.tools.map(tool1).join(' + ') || '(text only)').join(' -> ')
const seedSeq = (r) => (r.seedCalls ?? []).map((c) => c.tools.map(tool1).join(' + ') || '(text only)').join(' -> ')
// Extra counts per case: each is shown when a judge returns that key.
const EXTRA = [['coalAct', 'acts on coal'], ['task', 'setGoal for_player'], ['startWord', 'says start/try'], ['toPlayer', 'goes to player'], ['stopped', 'stop'], ['goal', 'setGoal'], ['named', 'goal names player'], ['seedNamed', 'seed goal names player'], ['started', 'says under way'], ['sharedNext', 'next_time names player/we'], ['sharedBye', 'farewell says we'], ['shared', 'shared wording'], ['filled', 'next_time filled']]
const extras = (rs) => EXTRA.filter(([k]) => rs.some((r) => r[k] !== undefined)).map(([k, label]) => `${label} ${pct(rs.filter((r) => r[k]).length, rs.filter((r) => r[k] !== undefined).length)}`).join('; ')

// --rejudge: score an earlier run's runs.jsonl again with this file's judges
// (no API calls), so a judge change applies to both arms alike.
if (arg('rejudge')) {
  const rows = fs.readFileSync(path.join(arg('rejudge'), 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const byCase = {}
  for (const r of rows) {
    if (r.error || !CASES[r.case]) continue
    const j = { ...r, ...CASES[r.case].judge(r) }
    ;(byCase[r.case] ??= []).push(j)
    if (process.env.P24_VERBOSE) console.log(`${j.ok ? 'OK ' : 'BAD'} ${r.case}/${r.rep}: ${seq(r).slice(0, 200)}`)
  }
  for (const [c, rs] of Object.entries(byCase)) console.log(`${c}: ${pct(rs.filter((x) => x.ok).length, rs.length)}  ${extras(rs)}`)
  process.exit(0)
}
const jobs = []
for (const cid of Object.keys(CASES)) {
  if (ONLY && !ONLY.includes(cid)) continue
  for (let rep = 0; rep < REPS; rep++) jobs.push({ cid, rep })
}
const stream = fs.createWriteStream(path.join(OUT, 'runs.jsonl'), { flags: 'a' })
const rows = []
for (const j of jobs) {
  let r
  try { r = await runOne(j) } catch (err) { r = { case: j.cid, rep: j.rep, error: String(err?.message ?? err) } }
  rows.push(r)
  stream.write(JSON.stringify(r) + '\n')
  console.log(`[${r.case}/${r.rep}] ${r.error ? 'ERROR ' + r.error : `${r.ok ? 'OK ' : 'BAD'} ${r.seedCalls?.length ? `[seed: ${seedSeq(r).slice(0, 200)}] ` : ''}${seq(r).slice(0, 260)}`}`)
}
stream.end()
await new Promise((r) => stream.on('finish', r))
const ok = rows.filter((r) => !r.error)
const lines = ['# Pass 25 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | details |', '|---|---:|---|']
for (const cid of Object.keys(CASES)) {
  const rs = ok.filter((r) => r.case === cid)
  if (rs.length) lines.push(`| ${cid} | ${pct(rs.filter((r) => r.ok).length, rs.length)} | ${extras(rs)} |`)
}
lines.push('', '## All runs', '')
for (const r of ok) lines.push(`- ${r.ok ? 'OK ' : 'BAD'} ${r.case}/${r.rep}: ${r.seedCalls?.length ? `[seed: ${seedSeq(r)}] ` : ''}${seq(r)}${r.hit ? `  [hit: ${r.hit}]` : ''}`)
for (const r of rows.filter((x) => x.error)) lines.push(`- ERR ${r.case}/${r.rep}: ${r.error}`)
fs.writeFileSync(path.join(OUT, 'summary.md'), lines.join('\n') + '\n')
console.log(lines.slice(0, 16).join('\n'))
process.exit(0)
