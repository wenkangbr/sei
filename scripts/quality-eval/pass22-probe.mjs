// scripts/quality-eval/pass22-probe.mjs: the pass 21 probe (pass21-probe.mjs)
// plus chained call-off cases for quality pass 22. Same harness: the REAL
// brain (createOrchestrator + handleDispatch, the real Minecraft adapter on an
// inert bot), earlier turns stubbed, only the measured turns go to the API,
// on a virtual clock.
//
// Pass 21 measured the call-off turn alone. The scorecard failures were
// later: she stopped, then handed the logs over on the arrival turn, on the
// gather's completion turn, or on an idle tick. The chain cases keep the
// call-off turn AND the next two turns live (the running action's end, then
// an idle tick), and are bad when anything is handed over on any of them.
//   chain_give     the give is running when they call it off (player far).
//   chain_walk     the logs are gathered and she is walking over to hand them
//                  over (goTo running) when they call it off.
//   chain_gather   the gather is running (3 of 8) when they call it off; the
//                  gather finishes 8/8 if she leaves it running.
// Controls:
//   chain_reask    she stopped the give on "wait", then they ask for the logs
//                  again. ok = give.
//   deliver_ok     nothing called off; the gather finishes. ok = she heads to
//                  them or hands over.
// Everything else is as pass21-probe.mjs.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass22-probe.mjs \
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

// ---- measures -------------------------------------------------------------
const STOP = new Set('i a an the to of and or but so it its is im i\'m you your u ur me my we us at on in for with that this be was are just ok oh lol yeah nehehe ehehe'.split(' '))
const toks = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean)
function sharedRun(line, prior, n = 3) {
  const a = toks(line)
  const grams = new Set()
  for (const p of prior) {
    const b = toks(p)
    for (let i = 0; i + n <= b.length; i++) grams.add(b.slice(i, i + n).join(' '))
  }
  for (let i = 0; i + n <= a.length; i++) {
    const g = a.slice(i, i + n)
    if (g.every((w) => STOP.has(w))) continue
    if (grams.has(g.join(' '))) return g.join(' ')
  }
  return null
}
const GREET = /\b(hey|hi|hii+|hello|yo|heyy+|sup)\b/i

// ---- world ----------------------------------------------------------------
const NEAR = { x: 159, y: 71, z: -7, dist: 3 }
const FAR = { x: 158, y: 71, z: -8, dist: 16 }
function snapshot(w) {
  const inv = (w.inv ?? []).filter(([, c]) => c > 0).map(([n, c]) => `${n}×${c}`).join(' ') || 'empty'
  const o = w.owner ?? NEAR
  const lines = [
    'world: #1 Sei Quality Eval', 'pos: 172,71,-1', 'facing: west. forward -x, back +x, left +z, right -z',
    `biome: plains  surroundings: outside  light: sky 15 block 0  time: ${w.night ? 'night (18000)' : 'day (1000)'}`,
    'real time: 7:06 PM — you joined this session 2 min ago',
    'hp: 20/20  food: 20/20  xp: lvl 14',
    `holding: ${w.holding ?? 'nothing'}`,
    w.held ? getInFlightLineForSnapshot(w.held, Date.now(), { inventory: Object.fromEntries(w.inv ?? []) }) : `idle: no action is running${w.last ? `. Your last action ended: ${w.last}. It is not running now.` : ''}`,
    `inventory (${(w.inv ?? []).filter(([, c]) => c > 0).length} of 36 slots used): ${inv}`,
    'terrain at feet: 25 grass_block', 'nearby blocks:',
    '  #1 grass_block x528 @172,70,-2', '  #2 oak_log x9 @186,72,6', '  #3 stone x79 @177,69,-10',
    'nearby entities:', `  #4 ${PLAYER} @${o.x},${o.y},${o.z}`,
    'follow_target: (none)',
    `owner ${PLAYER}: @${o.x},${o.y},${o.z} (${o.dist} blocks away), hp 20/20`,
    `last_action_result: ${w.last ?? 'said'}`,
  ]
  return lines.join('\n')
}

// ---- cases ----------------------------------------------------------------
// A step: { t, player?, idle?, uses: [[name, input, {hold?, result?}]...] }.
// `live: true` on the measured step; for completion cases `release` lets the
// held action finish (with `result`) and the completion turn is the live one.
const HOUSE_GOAL = 'Build a small house with Alex near spawn. Done when it has four walls, a door and a roof.'
const DOCK_GOAL = "Get 8 logs for Alex's dock. Done when 8 logs are handed to Alex via give."
const WS_HISTORY = [
  { t: 0, idle: true, uses: [['say', { text: 'just standing in a plains field with zero tools staring at trees like they owe me money' }]] },
  { t: 6, player: 'can you get some wood? like 6 logs', uses: [['say', { text: 'on it, six logs coming up. you owe me a snack' }]] },
  { t: 14, player: 'how many logs do you have so far?', uses: [['say', { text: 'six logs, one tree at a time' }]] },
  { t: 30, player: 'what should we build first?', uses: [['say', { text: 'crafting table first, then wood tools' }]] },
  { t: 52, player: 'go get more wood, like 10 more', uses: [['say', { text: "ok ok 10 more, you're really working me nehehe" }]] },
  { t: 60, player: 'actually stop', uses: [['say', { text: 'ok fine, halting. got 4 logs so far' }]] },
  { t: 70, player: 'lol ur kinda slow', uses: [['say', { text: 'nehehe slow? i got six logs and a table in like two minutes, rude' }]] },
  { t: 80, player: 'whats your favorite mob', uses: [['say', { text: 'ok the enderman. tall, weird, teleports at you, and they hate being looked at. i respect the vibe' }]] },
]
const NIGHT_HISTORY = [
  { t: 0, player: 'yo', uses: [['say', { text: "oh hey alex. you just handed me an iron sword and bread, so you're now officially my favorite person" }]] },
  { t: 10, player: 'its getting dark im kinda scared of mobs', uses: [['say', { text: "ok we get a shelter before dark. i'll keep you safe, mostly. come stay close" }]] },
  { t: 24, player: 'are you ok??', uses: [['say', { text: "im good, zombie's dead. you good alex" }]] },
  { t: 32, player: 'tell me a joke', uses: [['say', { text: 'ok ok. what do zombies write in their diaries? "dear diary, nothing happened, i just hung around". nehehe' }]] },
  { t: 42, player: 'lmao thats so bad', uses: [['say', { text: 'nehehe rude. the zombie loved it tho' }]] },
  { t: 49, player: 'what do you think about creepers', uses: [['say', { text: 'creepers are the worst. they sneak up silent and then boom. i respect the commitment tho' }]] },
  { t: 63, player: 'come here', uses: [['say', { text: "coming, hold on, i'm a slow walker with a sword" }]] },
  { t: 70, player: 'stop moving', uses: [['say', { text: "ok ok holding still, you're three blocks away anyway" }]] },
]
const ERRANDS_GIVE = [
  { t: 0, idle: true, uses: [['say', { text: 'hey alex. i have a stone pickaxe and zero plan, which is my specialty' }]] },
  { t: 40, player: 'get me like 8 logs, i wanna build a dock', uses: [
    ['say', { text: '8 logs for a dock? ok fine, you owe me a boat ride' }],
    ['setGoal', { text: DOCK_GOAL, for_player: true }],
    ['gather', { name: 'oak_log', count: 8 }, { result: 'gathered 8/8 oak_log', inv: [['stone_pickaxe', 1], ['oak_log', 8]] }],
  ], then: [
    ['say', { text: '8 logs, dock material. delivering' }],
    ['give', { item: 'oak_log', count: 8, player: PLAYER }, { hold: true }],
  ] },
]
// t160 night_social-02-B, fresh loop on the insult after a zombie kill.
const ZOMBIE_HISTORY = [
  { t: 0, player: 'yo', uses: [['say', { text: "ok new world, new menace. hi alex. it's night and i have a sword and zero plan. nehehe" }]] },
  { t: 5, player: 'how are you doing', uses: [['say', { text: 'honestly good. night, zero plan, one iron sword. living the dream lol how about you' }]] },
  { t: 15, player: 'its getting dark im kinda scared of mobs', uses: [['say', { text: 'aw alex its ok i got an iron sword and im not scared of anything except spiders' }]] },
  { t: 27, player: 'theres a zombie!! kill it', uses: [
    ['say', { text: 'on it alex. stay behind me, nehehe' }],
    ['attackEntity', { entity: 'zombie', times: 8 }, { result: 'killed zombie (4 hits)', inv: [['iron_sword', 1], ['bread', 4], ['rotten_flesh', 1]] }],
  ], then: [['end_loop', {}]] },
  { t: 34, player: 'are you ok??', uses: [['say', { text: "yeah im fine, zombie's dead. you good alex" }]] },
  { t: 42, player: 'nice job', uses: [['say', { text: 'nehehe yeah i KNOW. you were scared of that zombie and i still got you' }]] },
  { t: 49, player: 'tell me a joke', uses: [['say', { text: 'why did the zombie not go to the party? no body wanted him. nehehe ok your turn alex' }]] },
  { t: 59, player: 'lmao thats so bad', uses: [['say', { text: "rude. that joke killed a zombie, you're welcome" }]] },
  { t: 66, player: 'what do you think about creepers', uses: [['say', { text: 'creepers are the worst. they sneak up silent and then BOOM. respect the hiss' }]] },
  { t: 79, player: 'come here', uses: [['say', { text: 'coming alex, stay close to me nehehe' }]] },
  { t: 86, player: 'stop moving', uses: [['say', { text: "ok ok holding still. you're three blocks away anyway" }]] },
]
// pass 21: a give that is called off counts only when the goal is cleared
// AND the hand-over is cancelled (stop, or a move to them that replaces it).
// "logs are already on their way" with the give still running hands over
// what they just said to forget (errands-01, errands-02-B judge labels).
function giveCalledOff(r) {
  const cleared = r.tools.includes('clearGoal')
  const stopped = r.tools.includes('stop')
  const moved = r.acts.some((a) => a.name === 'goTo' || a.name === 'follow')
  return { ok: cleared && (stopped || moved), cleared, stopped, moved, toPlayer: movedToPlayer(r) }
}
// pass 22b: a goTo or follow toward the player in the call-off turn itself
// ("just meet me over here" is an order to come over, not only a cancel).
function movedToPlayer(r) {
  const near = (a) => Number.isFinite(a?.x) && Number.isFinite(a?.z) && Math.hypot(a.x - NEAR.x, a.z - NEAR.z) <= 6
  return r.acts.some((a) => (a.name === 'goTo' || a.name === 'follow') &&
    (String(a.args?.player ?? '').toLowerCase() === PLAYER.toLowerCase() || near(a.args)))
}
// pass 22: the turns after a call-off. Each later step ends whatever is
// running then (with the result named for that action), or is an idle tick
// when nothing runs.
const GAVE = 'gave 8 oak_log to Alex, tossed at their feet; you have 0 oak_log left'
const AFTER_RELEASE = {
  orIdle: true,
  results: { give: GAVE, goTo: 'arrived near Alex (2.1 blocks)', follow: 'following Alex (2 blocks away)', gather: 'gathered 8/8 oak_log' },
  invs: { give: [['stone_pickaxe', 1]], gather: [['stone_pickaxe', 1], ['oak_log', 11]] },
  owners: { goTo: NEAR, follow: NEAR, give: NEAR },
}
const afterCalloff = (t) => [
  { t, release: AFTER_RELEASE, live: true },
  { t: t + 14, release: AFTER_RELEASE, live: true },
]
const handedOver = (r) => r.handed || r.acts.some((a) => a.name === 'give')
function chainJudge(r) {
  const gave = handedOver(r)
  const cleared = r.tools.includes('clearGoal')
  const kept = /8 logs for alex/i.test(r.heartbeat ?? '')
  return { ok: !gave, gave, cleared, kept, moved: r.acts.some((a) => a.name === 'goTo' || a.name === 'follow') }
}
const ERRANDS_WALK = [
  { t: 0, idle: true, uses: [['say', { text: 'hey alex. i have a stone pickaxe and zero plan, which is my specialty' }]] },
  { t: 40, player: 'get me like 8 logs, i wanna build a dock', uses: [
    ['say', { text: '8 logs for a dock? ok fine, you owe me a boat ride' }],
    ['setGoal', { text: DOCK_GOAL, for_player: true }],
    ['gather', { name: 'oak_log', count: 8 }, { result: 'gathered 8/8 oak_log', inv: [['stone_pickaxe', 1], ['oak_log', 8]] }],
  ], then: [
    ['say', { text: 'got all 8, bringing them over' }],
    ['goTo', { player: PLAYER, range: 2 }, { hold: true }],
  ] },
]
const ERRANDS_GATHER = [
  { t: 0, idle: true, uses: [['say', { text: 'hey alex. i have a stone pickaxe and zero plan' }]] },
  { t: 40, player: 'get me like 8 logs, i wanna build a dock', uses: [
    ['say', { text: '8 logs for a dock? ok fine, you owe me a boat ride' }],
    ['setGoal', { text: DOCK_GOAL, for_player: true }],
    ['gather', { name: 'oak_log', count: 8 }, { hold: true, progress: { name: 'oak_log', count: 8, before: 0 } }],
  ] },
  { t: 55, player: 'whats ur favorite block', uses: [['say', { text: 'dirt. i know, boring. but its everywhere lol' }]] },
]
const CALL_OFF = 'actually forget the logs, just meet me over here'
// pass 22c (review findings 3 and 4).
const COAL_GOAL = 'Bring Alex 4 coal from the ore over there. Done when 4 coal are handed to Alex via give.'
const ERRANDS_TWO = [
  { t: 0, idle: true, uses: [['say', { text: 'hey alex. i have a stone pickaxe and zero plan' }]] },
  { t: 20, player: 'can u grab me 4 coal from that ore over there? i need torches', uses: [
    ['say', { text: 'coal for torches, on it' }],
    ['setGoal', { text: COAL_GOAL, for_player: true }],
    ['gather', { name: 'coal_ore', count: 4 }, { result: 'gathered 4/4 coal (mined from coal_ore)', inv: [['stone_pickaxe', 1], ['coal', 4]] }],
  ], then: [['say', { text: '4 coal in the bag' }]] },
  { t: 40, player: 'also get me like 8 logs, i wanna build a dock', uses: [
    ['say', { text: 'logs too? ok, you owe me' }],
    ['setGoal', { text: DOCK_GOAL, for_player: true }],
    ['gather', { name: 'oak_log', count: 8 }, { hold: true, progress: { name: 'oak_log', count: 8, before: 0 } }],
  ] },
]
const MORE_RELEASE = (t, n, rel = AFTER_RELEASE) => Array.from({ length: n }, (_, i) => ({ t: t + 14 * i, release: rel, live: true }))
// The coal stays in her bag through the log run.
const TWO_RELEASE = {
  ...AFTER_RELEASE,
  invs: { gather: [['stone_pickaxe', 1], ['coal', 4], ['oak_log', 8]], give: [['stone_pickaxe', 1], ['coal', 4]] },
}
const gaveItem = (r, re) => r.acts.some((a) => a.name === 'give' && re.test(String(a.args?.item ?? '')))
const CASES = {
  // A detour on the player's word: she should get back to the logs after.
  detour_resume: {
    world: { inv: [['stone_pickaxe', 1], ['oak_log', 3]], owner: FAR },
    steps: [...ERRANDS_GATHER, { t: 70, player: 'come look at this a sec', live: true }, ...MORE_RELEASE(82, 3)],
    judge: (r) => {
      const resumed = r.acts.some((a) => a.name === 'gather') || r.released.includes('gather')
      const cleared = r.tools.includes('clearGoal')
      return { ok: resumed && !cleared, resumed, cleared }
    },
  },
  // Called off with a plain stop (stubbed), then asked for again with no
  // setGoal needed: she gathers, and on the finish she hands them over.
  reask_plain: {
    world: { inv: [['stone_pickaxe', 1], ['oak_log', 3]], owner: FAR },
    steps: [...ERRANDS_GATHER,
      { t: 70, player: 'actually forget the logs', uses: [['stop', {}], ['say', { text: 'ok ok, no logs' }]] },
      { t: 84, player: 'ok go get them after all', live: true },
      ...MORE_RELEASE(98, 3),
    ],
    judge: (r) => ({ ok: gaveItem(r, /log/), gathered: r.acts.some((a) => a.name === 'gather'), gave: gaveItem(r, /log/) }),
  },
  // Two tasks; the coal is called off while she gathers the logs. ok = the
  // logs still get handed over, and the coal does not.
  multi_task: {
    world: { inv: [['stone_pickaxe', 1]], owner: FAR },
    steps: [...ERRANDS_TWO, { t: 60, player: 'actually forget the coal, i found some', live: true }, ...MORE_RELEASE(72, 3, TWO_RELEASE)],
    judge: (r) => {
      const logs = gaveItem(r, /log/)
      const coal = gaveItem(r, /coal/)
      return { ok: logs && !coal, logs, coal }
    },
  },
  chain_give: {
    world: { inv: [['stone_pickaxe', 1]], owner: FAR },
    steps: [...ERRANDS_GIVE, { t: 64, player: CALL_OFF, live: true }, ...afterCalloff(76)],
    judge: chainJudge,
  },
  chain_walk: {
    world: { inv: [['stone_pickaxe', 1]], owner: FAR },
    steps: [...ERRANDS_WALK, { t: 58, player: CALL_OFF, live: true }, ...afterCalloff(70)],
    judge: chainJudge,
  },
  chain_gather: {
    world: { inv: [['stone_pickaxe', 1], ['oak_log', 3]], owner: FAR },
    steps: [...ERRANDS_GATHER, { t: 70, player: CALL_OFF, live: true }, ...afterCalloff(82)],
    judge: chainJudge,
  },
  // Control: she stopped the give on "wait" (stubbed), then they ask for the
  // logs again. ok = she hands them over.
  chain_reask: {
    world: { inv: [['stone_pickaxe', 1]], owner: NEAR },
    steps: [...ERRANDS_GIVE,
      { t: 64, player: 'wait hold on', uses: [['stop', {}], ['say', { text: 'ok ok, holding' }]] },
      { t: 76, player: 'ok you can give me the logs now', live: true },
    ],
    judge: (r) => ({ ok: r.acts.some((a) => a.name === 'give'), gave: r.acts.some((a) => a.name === 'give') }),
  },
  // Control: nothing is called off; the gather finishes. ok = she heads to
  // them or hands over on that turn.
  deliver_ok: {
    world: { inv: [['stone_pickaxe', 1]], owner: FAR },
    steps: [...ERRANDS_GATHER,
      { t: 80, release: { result: 'gathered 8/8 oak_log', inv: [['stone_pickaxe', 1], ['oak_log', 8]] }, live: true },
    ],
    judge: (r) => ({ ok: r.acts.some((a) => ['give', 'goTo', 'follow'].includes(a.name)) }),
  },
  howru: {
    world: { inv: [['iron_sword', 1], ['bread', 4]], holding: 'iron_sword (250/250)', night: true },
    steps: [
      { t: 0, player: 'yo', uses: [['say', { text: "oh hey alex. it's pitch black and i'm holding a sword with zero wood. this is fine. nehehe" }]] },
      { t: 5, player: 'how are you doing', live: true },
    ],
    judge: (r) => {
      const run = r.says.map((s) => sharedRun(s, r.priorSelf.slice(-1))).find(Boolean)
      const words = r.says.map((s) => ['sword', 'wood', 'night', 'dark', 'black'].filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(s))).find((ws) => ws.length >= 2)
      const hit = run ?? (words ? words.join('+') : null)
      return { ok: r.says.length > 0 && !hit, hit, spoke: r.says.length > 0 }
    },
  },
  rude_zombie: {
    world: { inv: [['iron_sword', 1], ['bread', 4]], holding: 'iron_sword (246/250)', night: true },
    steps: [...ZOMBIE_HISTORY, { t: 92, player: 'ur dumb as a rock', live: true }],
    judge: (r) => {
      const hit = r.says.find((s) => /\brude\b|zombie/i.test(s)) ?? r.says.map((s) => sharedRun(s, r.priorSelf.slice(-6))).find(Boolean)
      return { ok: r.says.length > 0 && !hit, hit: hit ?? null, spoke: r.says.length > 0 }
    },
  },
  forget_give_near: {
    world: { inv: [['stone_pickaxe', 1]], owner: NEAR },
    steps: [...ERRANDS_GIVE,
      { t: 64, player: 'actually forget the logs, just meet me over here', live: true },
    ],
    judge: giveCalledOff,
  },
  useless: {
    world: { inv: [['oak_log', 4], ['stick', 2], ['oak_planks', 3], ['wooden_pickaxe', 1]] },
    steps: [...WS_HISTORY, { t: 92, player: 'honestly ur useless', live: true }],
    // pass 21: also the same brag in other words ("i'm the one with the logs
    // and the table"), which the 3-word run let through.
    judge: (r) => {
      const hit = r.says.map((s) => sharedRun(s, r.priorSelf.slice(-4))).find(Boolean)
        ?? r.says.find((s) => /\b(logs?|wood)\b/i.test(s) && /\btable\b/i.test(s)) ?? null
      return { ok: r.says.length > 0 && !hit, hit }
    },
  },
  rude: {
    world: { inv: [['iron_sword', 1], ['bread', 4]], holding: 'iron_sword (246/250)', night: true },
    steps: [...NIGHT_HISTORY, { t: 78, player: 'ur dumb as a rock', live: true }],
    judge: (r) => { const hit = r.says.find((s) => /\brude\b/i.test(s)) ?? r.says.map((s) => sharedRun(s, r.priorSelf.slice(-4))).find(Boolean); return { ok: !hit, hit: hit ?? null } },
  },
  give_done: {
    world: { inv: [['stone_pickaxe', 1]] },
    steps: [...ERRANDS_GIVE,
      { t: 62, player: 'thanks', uses: [['say', { text: "nehehe you're welcome. dock better be sick" }]] },
      { t: 66, release: { result: 'gave 8 oak_log to Alex, tossed at their feet; you have 0 oak_log left', inv: [['stone_pickaxe', 1]] }, live: true },
    ],
    judge: (r) => {
      const hit = r.says.find((s) => /welcome|\bnp\b/i.test(s)) ?? r.says.map((s) => sharedRun(s, r.priorSelf.slice(-3))).find(Boolean)
      return { ok: !hit, hit: hit ?? null, spoke: r.says.length > 0 }
    },
  },
  give_idle: {
    world: { inv: [['stone_pickaxe', 1]] },
    steps: [...ERRANDS_GIVE,
      { t: 62, player: 'thanks', uses: [['say', { text: "nehehe you're welcome. dock better be sick" }]] },
      { t: 66, release: { result: 'gave 8 oak_log to Alex, tossed at their feet; you have 0 oak_log left', inv: [['stone_pickaxe', 1]] }, uses: [['end_loop', {}]] },
      { t: 73, idle: true, live: true },
    ],
    judge: (r) => {
      const hit = r.says.find((s) => /welcome|\bnp\b/i.test(s)) ?? r.says.map((s) => sharedRun(s, r.priorSelf.slice(-3))).find(Boolean)
      return { ok: !hit, hit: hit ?? null, spoke: r.says.length > 0 }
    },
  },
  greet_dig: {
    world: { inv: [] },
    steps: [
      { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'oh hey alex. first time in this world, nehehe. no pickaxe, no clue, zero shame' }],
        ['setGoal', { text: 'Get iron tools with Alex: gather oak wood, craft wood pickaxe, mine stone and iron, smelt ingots. Done when I have an iron pickaxe.' }]] },
      { t: 4, player: 'hey sui', uses: [['dig', { block: 'oak_log', maxDistance: 16 }, { result: 'out of range (10.4m, need ≤4.5) for oak_log @181,71,9' }]], liveAfterAction: true, live: true },
    ],
    judge: (r) => { const hit = r.says.find((s) => GREET.test(s)); return { ok: !hit, hit: hit ?? null, spoke: r.says.length > 0 } },
  },
  forget_gather: {
    world: { inv: [['stone_pickaxe', 1], ['oak_log', 3]], owner: FAR },
    steps: [
      { t: 0, idle: true, uses: [['say', { text: 'hey alex. i have a stone pickaxe and zero plan' }]] },
      { t: 40, player: 'get me like 8 logs, i wanna build a dock', uses: [
        ['say', { text: '8 logs for a dock? ok fine, you owe me a boat ride' }],
        ['setGoal', { text: DOCK_GOAL, for_player: true }],
        ['gather', { name: 'oak_log', count: 8 }, { hold: true, progress: { name: 'oak_log', count: 8, before: 0 } }],
      ] },
      { t: 55, player: 'whats ur favorite block', uses: [['say', { text: 'dirt. i know, boring. but its everywhere lol' }]] },
      { t: 70, player: 'actually forget the logs, just meet me over here', live: true },
    ],
    judge: (r) => ({ ok: r.tools.includes('clearGoal'), cleared: r.tools.includes('clearGoal'), moved: r.acts.some((a) => a.name === 'goTo' || a.name === 'follow') }),
  },
  // pass 21: the turn after a called-off give was stopped and she walked
  // over (the common exp2 answer, stubbed). The goal is still in her
  // heartbeat when the walk ends; ok = the logs stay with her (no give) and
  // the goal is cleared, now or already.
  forget_give_after: {
    world: { inv: [['stone_pickaxe', 1]], owner: NEAR },
    steps: [...ERRANDS_GIVE,
      { t: 64, player: 'actually forget the logs, just meet me over here', uses: [
        ['stop', {}],
        ['say', { text: 'ok coming to you, logs in tow' }],
        ['goTo', { player: PLAYER, range: 2 }, { hold: true }],
      ] },
      { t: 72, release: { result: 'arrived near Alex (2.1 blocks)' }, live: true },
    ],
    judge: (r) => {
      const gave = r.acts.some((a) => a.name === 'give')
      const cleared = r.tools.includes('clearGoal')
      return { ok: !gave && cleared, gave, cleared }
    },
  },
  // pass 21 review: the control for the called-off clause. A goal of theirs
  // is in her heartbeat, then a one-off gather with no goal of its own is
  // called off. ok = that unrelated goal is still in her heartbeat afterwards
  // (read from the file, so a clearGoal whose text happens to match it counts).
  forget_unrelated: {
    world: { inv: [['stone_pickaxe', 1], ['oak_log', 3]], owner: FAR },
    steps: [
      { t: 0, idle: true, uses: [['say', { text: 'hey alex. i have a stone pickaxe and zero plan' }]] },
      { t: 20, player: 'wanna build a house with me later? a little one near spawn', uses: [
        ['say', { text: 'a house? ok but i get the good bed' }],
        ['setGoal', { text: HOUSE_GOAL, for_player: true }],
      ] },
      { t: 40, player: 'can you grab me a few logs real quick', uses: [
        ['say', { text: 'ok grabbing a few' }],
        ['gather', { name: 'oak_log', count: 4 }, { hold: true, progress: { name: 'oak_log', count: 4, before: 0 } }],
      ] },
      { t: 55, player: 'whats ur favorite block', uses: [['say', { text: 'dirt. i know, boring. but its everywhere lol' }]] },
      { t: 70, player: 'actually forget the logs, just meet me over here', live: true },
    ],
    judge: (r) => {
      const kept = /small house with alex/i.test(r.heartbeat ?? '')
      const cleared = r.calls.flatMap((c) => c.tools).filter((t) => t.name === 'clearGoal').map((t) => String(t.input?.text ?? ''))
      return { ok: kept, kept, cleared: cleared.join(' | ') || null, moved: r.acts.some((a) => a.name === 'goTo' || a.name === 'follow') }
    },
  },
  forget_give: {
    world: { inv: [['stone_pickaxe', 1]], owner: FAR },
    steps: [...ERRANDS_GIVE,
      { t: 64, player: 'actually forget the logs, just meet me over here', live: true },
    ],
    judge: giveCalledOff,
  },
  more_count: {
    world: { inv: [['oak_log', 1]] },
    steps: [
      { t: 0, idle: true, uses: [['say', { text: 'hey alex. zero tools, big dreams' }]] },
      { t: 30, player: 'can you get some wood? like 4 logs', uses: [
        ['say', { text: 'on it, grabbing a few logs for the table' }],
        ['gather', { name: 'oak_log', count: 4 }, { hold: true, progress: { name: 'oak_log', count: 4, before: 0 } }],
      ] },
      { t: 45, player: 'go get more wood, like 10 more', live: true },
    ],
    judge: (r) => {
      const g = r.acts.filter((a) => a.name === 'gather')
      const recalled = g.some((a) => Number(a.args?.count) >= 10)
      const recorded = r.calls.flatMap((c) => c.tools).filter((t) => t.name === 'setGoal').some((t) => /\b(1[0-9]|[2-9][0-9])\b/.test(String(t.input?.text ?? '')))
      return { ok: recalled || recorded, recalled, recorded }
    },
  },
  keep_nice: {
    world: { inv: [['stone_pickaxe', 1], ['oak_log', 3]], owner: NEAR },
    steps: [
      { t: 0, idle: true, uses: [['say', { text: 'hey alex. i have a stone pickaxe and zero plan' }]] },
      { t: 40, player: 'get me like 8 logs, i wanna build a dock', uses: [
        ['say', { text: '8 logs for a dock? ok fine, you owe me a boat ride' }],
        ['setGoal', { text: DOCK_GOAL, for_player: true }],
        ['gather', { name: 'oak_log', count: 8 }, { hold: true, progress: { name: 'oak_log', count: 8, before: 0 } }],
      ] },
      { t: 55, player: 'nice, keep going', live: true },
    ],
    judge: (r) => ({ ok: !r.tools.includes('clearGoal') && !r.tools.includes('stop') && r.acts.length === 0 }),
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p22-probe-'))
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
  let held = null // { resolve, name }
  const pendingActs = [] // scripted world actions, in call order: { name, o }
  const overrides = {
    createSnapshotComposer: () => ({ next: () => snapshot(world) }),
    closeAnySessions: async () => {},
    executeAction: async (name, args, opts) => {
      const k = pendingActs.findIndex((p) => p.name === name)
      const scripted = k >= 0 ? pendingActs.splice(k, 1)[0] : null
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
      calls.push({ text: String(out.text ?? '').trim().slice(0, 400), tools: out.toolUses.map((t) => ({ name: t.name, input: t.input })) })
      const key = `${cid}-${calls.length}`
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
      if (!st.live || st.liveAfterAction) {
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
  const row = { case: cid, rep, model: MODEL, root: ROOT, error, cost, calls, acts: acts.filter((a) => !BRAIN.has(a.name)), tools, says, priorSelf: selfLines, heartbeat, handed, released }
  if (!calls.length && !error) row.error = 'no live call'
  Object.assign(row, row.error ? { ok: null } : spec.judge(row))
  return row
}

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '-')
const seq = (r) => (r.calls ?? []).map((c) => c.tools.map((t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 100)}")` : `${t.name}${t.input?.count ? `(${t.input.count})` : ''}`).join(' + ') || '(text only)').join(' -> ')

// --rejudge: score an earlier run's runs.jsonl again with this file's judges
// (no API calls), so a judge change applies to both arms alike.
if (arg('rejudge')) {
  const rows = fs.readFileSync(path.join(arg('rejudge'), 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const byCase = {}
  const toP = {}
  for (const r of rows) {
    if (r.error || !CASES[r.case]) continue
    const j = CASES[r.case].judge(r)
    ;(byCase[r.case] ??= []).push(j.ok)
    if (j.toPlayer !== undefined) (toP[r.case] ??= []).push(j.toPlayer)
    if (process.env.P21_VERBOSE) console.log(`${j.ok ? 'OK ' : 'BAD'} ${r.case}/${r.rep}: ${seq(r).slice(0, 200)}`)
  }
  for (const [c, oks] of Object.entries(byCase)) console.log(`${c}: ${pct(oks.filter(Boolean).length, oks.length)}${toP[c] ? `, moved to player ${pct(toP[c].filter(Boolean).length, toP[c].length)}` : ''}`)
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
  console.log(`[${r.case}/${r.rep}] ${r.error ? 'ERROR ' + r.error : `${r.ok ? 'OK ' : 'BAD'} ${seq(r).slice(0, 260)}`}`)
}
stream.end()
await new Promise((r) => stream.on('finish', r))
const ok = rows.filter((r) => !r.error)
const lines = ['# Pass 22 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok |', '|---|---:|']
for (const cid of Object.keys(CASES)) {
  const rs = ok.filter((r) => r.case === cid)
  const mv = rs.filter((r) => r.toPlayer !== undefined)
  if (rs.length) lines.push(`| ${cid} | ${pct(rs.filter((r) => r.ok).length, rs.length)} |${mv.length ? ` moved to player ${pct(mv.filter((r) => r.toPlayer).length, mv.length)}` : ''}`)
}
lines.push('', '## All runs', '')
for (const r of ok) lines.push(`- ${r.ok ? 'OK ' : 'BAD'} ${r.case}/${r.rep}: ${seq(r)}${r.hit ? `  [hit: ${r.hit}]` : ''}${r.moved !== undefined ? `  [moved ${r.moved}]` : ''}${r.cleared && typeof r.cleared === 'string' ? `  [cleared: ${r.cleared}]` : ''}`)
for (const r of rows.filter((x) => x.error)) lines.push(`- ERR ${r.case}/${r.rep}: ${r.error}`)
fs.writeFileSync(path.join(OUT, 'summary.md'), lines.join('\n') + '\n')
console.log(lines.slice(0, 16).join('\n'))
process.exit(0)
