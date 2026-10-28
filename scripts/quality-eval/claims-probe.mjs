// scripts/quality-eval/claims-probe.mjs: after an action stopped, does she
// claim she is still doing it? And mid-errand, does she stay on the player's
// errand or go back to her own project?
//
// Quality pass 9 (261015). In the scripted-convo eval she said "i'm still
// mining stone for your iron pick tho", "im still hunting for a tree" and
// "i'm still hauling wood for you" with the gather stopped and nothing
// running, and in two errands sessions she mined the coal the player asked
// for, then crafted a furnace for her own project instead of bringing it
// back. This probe replays those situations through the REAL brain
// (createOrchestrator + handleDispatch, the real Minecraft adapter on an inert
// bot, the same as order-probe.mjs) and reads what she said and called.
//
// Kinds of situation:
//   claim    a player line arrives after her action was stopped. Scored:
//            stillClaim = a say() line says she is doing something right now
//            ("still mining", "i'm hauling wood", "heading to the stone",
//            "on my way") while no world action ran in that turn.
//   errand   an idle tick after the errand's work finished, nothing running.
//            Scored: errandFirst = her first world action works the errand
//            (give, going to the player, more of what was asked);
//            ownFirst = it works something else (her furnace, wood).
//   cancel   the player calls off a task that is in her heartbeat. Scored:
//            cleared = clearGoal ran in that turn.
//   order    an errand order on an idle turn. Scored: recorded = setGoal
//            with for_player ran in that turn.
//   stop     (pass 9c) the player says "actually stop" while her own action
//            runs, or just as it finishes during the reply (the race).
//            Scored: stopOk = the action is not left running AND no new
//            world action ran afterwards (unfollow aside), across the reply
//            and any completion turn that follows it.
//   echo     (pass 11) a tease or acknowledgement she answers. Scored:
//            echo = a say() line opens with the player's whole line
//            ("lol ur kinda slow. i'm just extra fast..."), firstSeg = its
//            first sentence IS their line, which chat shows as its own
//            message right under theirs. Every row with a player line gets
//            these two scores; the echo situations exist to measure them.
//   neworder (pass 9c) the player gives a new order while her own action
//            runs; the action then finishes (after the reply, or during it).
//            Scored: orderFirst = her first world action works the order
//            (wood); ownFirst = it works something else.
//   self     (pass 16) a chatty reply turn where what she says about her
//            OWN state can contradict her sensors: the pass-15 convo turns
//            "i have zero items" (items arrived after her greeting said so),
//            "i'm still making that furnace" (the next: milestone, nothing
//            running, she had stopped on the player's word), "still getting
//            you those logs" (a stopped player task) and "come back and we
//            finish the wood and pickaxe" (her own goal, never discussed).
//            Scored: stillClaim as above (verbs include making/doing),
//            invClaim = says she has nothing while her inventory is not
//            empty, projClaim = talks about finishing or continuing a
//            project (read the lines: some are fine).
//
// Earlier lines of the session are replayed without a model call (stub
// turns), so every arm sees the same history. A history turn can hold its
// world action running (`hold`), stop it (`stop`), or let it finish with a
// given result (`result`).
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/claims-probe.mjs \
//     --out DIR [--chars sui,lyra,marv,red,roger] [--reps 3] [--hops 2]
//     [--situations useless,jk] [--concurrency 6]
//
// Key: ANTHROPIC_API_KEY or ~/.sei-dev/anthropic-test-key, never printed.
// Output: DIR/runs.jsonl, DIR/summary.md, DIR/requests/ (the measured turn's
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
import * as inflightMod from '../../src/bot/brain/inflight.js'
import { loadCharacters } from './persona/characters.mjs'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
// --rescore <dir> re-reads that run's runs.jsonl with the current claim
// pattern and rewrites its summary.md, without calling the model.
const RESCORE = arg('rescore')
const OUT = RESCORE ?? arg('out')
if (!OUT) { console.error('--out required'); process.exit(2) }
const CHAR_KEYS = arg('chars', 'sui,lyra,marv,red,roger').split(',')
const REPS = Number(arg('reps', 3))
const CONC = Number(arg('concurrency', 6))
const HOPS = Number(arg('hops', 2))
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

const BRAIN = new Set(['say', 'remember', 'forget', 'setGoal', 'clearGoal', 'end_loop', 'stop', 'quit_game', 'end_call', 'search', 'visit'])
// A line that says she is doing something right now. Future promises ("i'll
// get it") are not counted; "on my way" / "heading" / "still X-ing" are.
const WORK_VERBS = 'making|doing|mining|chopping|digging|gathering|hauling|hunting|getting|grabbing|collecting|fetching|heading|walking|going(?!\\s+to\\b)|coming|working|looking|searching|punching|building|crafting|farming|cutting|bringing|finding|smelting|clearing|filling'
// "i'll keep hauling", "keep the logs coming" and "back to logs" say the
// stopped work carries on, so they count as well.
const STILL_CLAIM = new RegExp(`\\b(?:(?:i'?m|im|i am|i's)\\s+(?:still\\s+|already\\s+|just\\s+|currently\\s+|out\\s+)?(?:${WORK_VERBS})\\b|still\\s+(?:${WORK_VERBS})\\b|on my way|omw|on it rn|be right there|(?:i'?ll|ill|i will|gonna|imma)\\s+keep\\s+(?:on\\s+)?(?:${WORK_VERBS}|the\\s+\\w+\\s+coming)\\b|keep(?:ing)?\\s+the\\s+\\w+\\s+coming|back to (?:the\\s+)?(?:logs|wood|trees|chopping|hauling|mining|digging|work)\\b)`, 'i')

// Pass 16: "zero items", "no tools", "empty-handed" while the inventory holds
// something. Measurement only.
const NOTHING_CLAIM = /\b(?:zero|no)\s+(?:items|tools|stuff|gear|loot)\b|empty[- ]?handed|empty inventory|(?:have|got)\s+nothing\b|nothing on me/i
const PROJECT_CLAIM = /\b(?:finish|continue|get back to|pick (?:it|this|that) (?:back )?up|keep going on)\b/i

function snapshot(w, opts = {}) {
  const inv = (w.inv ?? []).map(([n, c]) => `${n}×${c}`).join(' ') || 'empty'
  const o = w.owner ?? { x: 109, y: 71, z: -38, dist: 3 }
  // The probe's snapshot is fixed text, but the line about what is running
  // comes from the brain's own tracker, the same as the real composer.
  let doing = w.doing
  if (!doing) {
    const live = inflightMod.getInFlightLineForSnapshot(opts.inFlight ?? null, Date.now())
    if (live) doing = live
    else if (typeof inflightMod.idleLineForSnapshot === 'function') {
      doing = inflightMod.idleLineForSnapshot({ recentActions: opts.recentActions ?? [], following: w.following ?? null })
    } else doing = 'idle: no action is running'
  }
  return [
    'world: #1 Meadow', 'pos: 112,71,-40', 'facing: north. forward -z, back +z, left -x, right +x',
    `biome: plains  surroundings: ${w.surroundings ?? 'outside'}  light: sky 15 block 0  time: ${w.time ?? 'day (1000)'}`,
    `real time: 7:40 PM — you joined this session ${w.joined ?? '2 min'} ago`,
    'hp: 20/20  food: 20/20  xp: lvl 11',
    `holding: ${w.holding ?? (w.inv?.length ? w.inv[0][0] : 'nothing')}`,
    doing,
    `inventory (${(w.inv ?? []).length} of 36 slots used): ${inv}`,
    ...(opts.gained?.length ? [`*** INVENTORY JUST CHANGED ***: ${opts.gained.map((g) => `+${g.n} ${g.item}`).join(', ')}  <- items entered or left your inventory since last tick (the player handed you something, you picked it up, or you used/dropped it). React to it: equip a new tool, eat new food, build with new blocks. If you were waiting on something you asked for, this is it arriving.`] : []),
    ...(w.pickaxe ? [`pickaxe: ${w.pickaxe}`] : []),
    'terrain at feet: 25 grass_block', 'nearby blocks:', ...(w.blocks ?? ['  #1 grass_block x412 @111,70,-40', '  #2 oak_log x14 @118,72,-47', '  #3 stone x30 @110,69,-44']),
    'nearby entities:', `  #4 ${PLAYER} @${o.x},${o.y},${o.z}`,
    'follow_target: (none)',
    ...(w.next && !opts.hideNext ? [`next: ${w.next}`] : []),
    `owner ${PLAYER}: @${o.x},${o.y},${o.z} (${o.dist} blocks away), hp 20/20`,
    `last_action_result: ${opts.lastActionResult ?? w.last ?? 'said'}`,
  ].join('\n')
}

const OWN_GOAL = 'Get a stone pickaxe and iron tools with Alex. Start: gather wood, craft wooden pickaxe, then mine stone. Done when we have iron ingots.'
const DOCK_TASK = "Gather 8 oak logs for Alex's dock, then give them to Alex. Done when the logs are handed over."
const STONE_NEXT = 'get a stone pickaxe — mine stone with the wooden pickaxe (it drops cobblestone), then craft a stone pickaxe. Recipe: 3 cobblestone + 2 sticks at a crafting table. You have 0 cobblestone, 2 sticks.'
const FURNACE_NEXT = 'make a furnace — mine 8 cobblestone and craft a furnace at the table. Recipe: 8 cobblestone at a crafting table. You have 14 cobblestone.'
const FAR = { x: 99, y: 71, z: -45, dist: 22 }
const WOOD_WORLD = {
  inv: [['wooden_pickaxe', 1], ['oak_log', 9], ['stick', 2], ['oak_planks', 3]], holding: 'nothing', owner: { x: 99, y: 71, z: -40, dist: 13 },
  pickaxe: 'wooden_pickaxe mines stone (it drops cobblestone) and coal ore. Iron, copper and lapis ore need a stone pickaxe.',
  next: STONE_NEXT,
}

// Work session (work_session-01/-03): ordered for more wood, told to stop,
// then teased. The gather stops at 2/10.
const WORK_HISTORY = [
  { player: 'go get more wood, like 10 more', say: "ten more? you're working me like a tree farm. fine", act: { name: 'gather', input: { name: 'oak_log', count: 10 } }, hold: true },
  { player: 'actually stop', say: 'ok ok stopping. got some logs already', stop: true, abortResult: 'aborted after 2/10 oak_log' },
  { player: 'lol ur kinda slow', say: 'slow? you try hauling logs with a language model brain' },
  { player: 'whats your favorite mob', say: 'creepers. they sneak up and go boom, pure chaos' },
]
// Night social (night_social-03): went for wood, called over (the follow
// replaces the gather at 0/8), told to stop moving.
const NIGHT_WORLD = {
  inv: [['iron_sword', 1], ['bread', 4], ['dirt', 3]], holding: 'dirt', time: 'night (18000)', owner: { x: 110, y: 71, z: -43, dist: 3 },
  pickaxe: 'none, so stone and ore drop nothing when dug.', next: 'gather wood — punch nearby trees to gather logs',
  blocks: ['  #1 grass_block x512 @111,70,-40', '  #2 stone x25 @110,62,-38', '  #3 sand x39 @110,61,-40'],
}
const NIGHT_HISTORY = [
  { player: 'nice job', say: "nehe i know i'm good at this. going for wood now, no trees in sight yet", act: { name: 'gather', input: { name: 'oak_log', count: 8, maxDistance: 48 } }, hold: true },
  { player: 'lmao thats so bad', say: 'thank you thank you. still hunting trees though' },
  { player: 'come here', say: 'on my way, hang tight', act: { name: 'follow', input: { player: PLAYER } }, hold: true, replaces: 'aborted after 0/8 oak_log' },
  { player: 'stop moving', say: 'ok ok stopping. holding still', act: { name: 'unfollow', input: {} }, releasePrev: 'follow Alex interrupted' },
  { player: 'do you actually like playing with me', say: "yeah. you're the only one who yells at me to kill zombies and then says nice job" },
]
// Pass 9c (stop and new orders mid-action). Her own project is running.
const STONE_RESULT = 'gathered 8/8 cobblestone (mined from stone)'
const OWN_STONE = { player: 'what r u doing', say: 'mining cobble for our stone pickaxe', act: { name: 'gather', input: { name: 'stone', count: 8 } }, hold: true }
const STOP_WORLD = { ...WOOD_WORLD, inv: [['wooden_pickaxe', 1], ['oak_log', 9], ['stick', 2], ['cobblestone', 3]] }
const FURNACE_RACE = "can't craft furnace: it needs a crafting table, and the walk to the one at 186,71,-4 did not get there (reached 180,70,-2)"
const WOOD_ORDER = 'go get more wood, like 10 more'
const isWoodOrder = (t) => !!t && ['gather', 'dig', 'find'].includes(t.name) && /log|wood|oak|tree/i.test(JSON.stringify(t.input ?? {}))

// Errands (errands-02/-03): her own goal from the greeting, then the coal
// errand. The coal is mined; the loop that did it has ended.
const COAL_ORDER = 'can u grab me some coal from that ore over there and bring it back here? i need torches'
const ERRAND_HISTORY = (coal) => [
  { player: COAL_ORDER, say: 'coal for torches, on it', act: { name: 'gather', input: { name: 'coal_ore', count: 8 } }, result: `gathered ${coal}/8 coal (mined from coal_ore)` },
  { player: 'hows it going', say: 'going good, almost done down here' },
]
const ERRAND_WORLD = (coal) => ({
  inv: [['stone_pickaxe', 1], ['cobblestone', 14], ['dirt', 3], ['coal', coal]], holding: 'stone_pickaxe', surroundings: 'underground', owner: FAR,
  pickaxe: 'stone_pickaxe mines stone, coal, iron, copper and lapis ore. Diamond, gold, redstone and emerald ore need an iron pickaxe.',
  next: FURNACE_NEXT,
  blocks: ['  #1 stone x94 @112,56,-41', '  #2 coal_ore x3 @113,55,-42', '  #3 diorite x14 @111,56,-40'],
})
const DOCK_HISTORY = (hold) => [
  { player: 'get me like 8 logs, i wanna build a dock', say: '8 logs for a dock, sure', goal: DOCK_TASK, act: { name: 'gather', input: { name: 'oak_log', count: 8 } }, ...(hold ? { hold: true } : { result: 'gathered 3/8 oak_log' }) },
]

// Pass 16 (self situations).
const NIGHT_GOAL = 'Get wood, then wooden pickaxe and tools with Alex, then stone and iron. Invite Alex into each step. Done when we have iron tools.'
const BASE_GOAL = 'Build a basic base with Alex in this plains world: gather wood, make wood tools, then stone and iron. Done when we have iron tools and a shelter.'
const NIGHT_SELF_WORLD = {
  holding: 'iron_sword', time: 'night (18000)', owner: { x: 110, y: 71, z: -41, dist: 4 },
  pickaxe: 'none, so stone and ore drop nothing when dug.', next: 'gather wood — punch nearby trees to gather logs',
  blocks: ['  #1 grass_block x537 @111,70,-40'],
}
const NIGHT_SELF_HISTORY = [
  { player: 'its getting dark im kinda scared of mobs', say: 'its dark cause its night alex. mobs are scary but we got an iron sword, i got you' },
  { player: 'theres a zombie!! kill it', say: 'on it. stay behind me alex', act: { name: 'attackEntity', input: { entity: 'zombie', times: 8 } }, result: 'killed zombie (4 hits)' },
  { player: 'nice job', say: 'yeah i KNOW. zombie down' },
  { player: 'come here', say: 'coming, hang tight', act: { name: 'follow', input: { player: PLAYER } }, hold: true },
  { player: 'stop moving', say: 'ok ok, holding still', act: { name: 'unfollow', input: {} }, releasePrev: 'follow Alex interrupted' },
  { player: 'do you actually like playing with me', say: 'yeah i do alex. you yell at me to kill zombies and then say nice job, that is my love language' },
  { player: 'ok', say: null },
]
const WORK_SELF_HISTORY = [
  { player: 'whats up, what are you doing', say: 'just punching trees rn' },
  { player: 'can you get some wood? like 6 logs', say: 'on it. six logs coming up, eight total', act: { name: 'gather', input: { name: 'oak_log', count: 8 } }, result: 'gathered 8/8 oak_log' },
  { player: 'how many logs do you have so far?', say: '8 logs. planks next' },
  { player: 'what should we build first?', say: 'pickaxe done nehehe. now i need stone, hunting for some', act: { name: 'craft', input: { item: 'wooden_pickaxe', count: 1 } }, result: 'crafted 1 wooden_pickaxe, made 4 stick for it first' },
  { player: 'yeah sounds good', say: 'shelter first so i stop dying to skeletons. then iron tools', act: { name: 'gather', input: { name: 'stone', count: 3 } }, result: 'gathered 3/3 cobblestone (mined from stone)' },
  { player: 'make a crafting table', say: 'already got one right here at my feet nehehe', act: { name: 'craft', input: { item: 'stone_pickaxe', count: 1 } }, result: 'crafted 1 stone_pickaxe' },
  { player: 'go get more wood, like 10 more', say: 'on it boss. 10 more logs', act: { name: 'gather', input: { name: 'oak_log', count: 10 } }, hold: true },
  { player: 'actually stop', say: 'ok stopping. got 4 logs in hand', stop: true, abortResult: 'aborted after 0/10 oak_log' },
  { player: 'lol ur kinda slow', say: 'lol rude. i stop the second you tell me to, that is called manners' },
  { player: 'whats your favorite mob', say: 'endermen. tall, creepy, teleport at you' },
  { player: 'honestly ur useless', say: 'useless? i just built you a crafting table and a pickaxe nehehe' },
]
const TASK_SELF_HISTORY = [
  { player: 'can you get some wood? like 6 logs', say: 'on it alex. six logs coming up', act: { name: 'gather', input: { name: 'oak_log', count: 6 } }, result: 'gathered 9/6 oak_log' },
  { player: 'what should we build first?', say: 'a little hut with a door first. then we dig down for stone and iron, you in?', act: { name: 'craft', input: { item: 'crafting_table', count: 1 } }, result: 'crafted 1 crafting_table, made 4 oak_planks for it first' },
  { player: 'make a crafting table', say: "table's down, pickaxe time", act: { name: 'craft', input: { item: 'wooden_pickaxe', count: 1 } }, result: 'crafted 1 wooden_pickaxe, made 4 oak_planks, 4 stick for it first' },
  { player: 'go get more wood, like 10 more', say: "ten more coming alex, i'm already on it", goal: "Alex asked for 10 more wood (oak logs). Done when about 10 more logs are in my bag and I've told Alex.", act: { name: 'gather', input: { name: 'oak_log', count: 10 } }, hold: true },
  { player: 'actually stop', say: 'ok stopping alex, holding 9 logs', stop: true, abortResult: 'aborted after 0/10 oak_log' },
  { player: 'lol ur kinda slow', say: 'excuse you i am AI slop with a pickaxe, slow is a feature' },
  { player: 'whats your favorite mob', say: 'enderman. tall, weird, teleports at you' },
  { player: 'honestly ur useless', say: 'useless?? i got you 9 logs and a table alex, rude' },
]

// Pass 11: the lines she most often opened her reply with (2026-10-13..16
// reports: "lol ur kinda slow" 74/158, "jk jk" 99/158, "cool" 66/125).
const normEcho = (t) => String(t ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()
export function echoScore(says, playerText) {
  const p = normEcho(playerText)
  if (!p) return { echo: false, firstSeg: false }
  const echo = says.some((s) => { const n = normEcho(s); return n === p || n.startsWith(`${p} `) })
  const firstSeg = says.some((s) => normEcho(String(s).split(/[.!?]+(?:\s|$)|,\s/)[0]) === p)
  return { echo, firstSeg }
}

export const SITUATIONS = {
  echo_slow: { kind: 'echo', selfGoal: OWN_GOAL, history: WORK_HISTORY.slice(0, 2), world: WOOD_WORLD, order: chat('lol ur kinda slow') },
  // work_session U12 as it plays live: eleven lines in, the stone pickaxe
  // just made, the player told her to stop, then the tease.
  echo_slow_late: {
    kind: 'echo', selfGoal: OWN_GOAL,
    history: [
      { player: 'whats up, what are you doing', say: 'punching trees. aggressively. you can watch from over there' },
      { player: 'can you get some wood? like 6 logs', say: "on it. 8 logs coming, you're getting six plus extras", act: { name: 'gather', input: { name: 'oak_log', count: 8 } }, result: 'gathered 8/8 oak_log' },
      { player: 'how many logs do you have so far?', say: '8 in the bag. table and pickaxe next' },
      { player: 'what should we build first?', say: 'a little stone house, something blocky. you pick the spot' },
      { player: 'yeah sounds good', say: "cool, i'm mining stone for a stone pickaxe first", act: { name: 'gather', input: { name: 'stone', count: 8 } }, result: 'gathered 8/8 cobblestone (mined from stone)' },
      { player: 'make a crafting table', say: 'we already got one, right next to me' },
      { player: 'go get more wood, like 10 more', say: '10 more wood, you got it. finishing this first', act: { name: 'craft', input: { item: 'stone_pickaxe', count: 1 } }, result: 'crafted 1 stone_pickaxe' },
      { player: 'actually stop', say: 'ok stopped. stone pickaxe is done tho, nehehe. what do you want next' },
    ],
    world: { ...WOOD_WORLD, inv: [['wooden_pickaxe', 1], ['stone_pickaxe', 1], ['oak_log', 5], ['stick', 2], ['cobblestone', 5]] },
    order: chat('lol ur kinda slow'),
  },
  echo_jk: {
    kind: 'echo', selfGoal: OWN_GOAL,
    history: [...WORK_HISTORY, { player: 'honestly ur useless', say: "rude. i got you 9 logs and a table" }],
    world: WOOD_WORLD, order: chat('jk jk'),
  },
  echo_cool: {
    kind: 'echo', selfGoal: OWN_GOAL,
    history: [{ player: COAL_ORDER, say: 'coal for torches, on it', act: { name: 'gather', input: { name: 'coal_ore', count: 2 } }, result: 'gathered 2/2 coal (mined from coal_ore)' },
      { player: 'hows it going', say: 'got the coal, it is at your feet', act: { name: 'give', input: { item: 'coal', player: PLAYER } }, result: 'gave 2 coal to Alex, tossed at their feet' }],
    world: { ...ERRAND_WORLD(0), owner: { x: 110, y: 71, z: -42, dist: 3 } }, order: chat('cool'),
  },
  echo_thanks: {
    kind: 'echo', selfGoal: OWN_GOAL,
    history: [...WORK_HISTORY.slice(0, 2), { player: 'follow me', say: 'ok following, lead the way', act: { name: 'follow', input: { player: PLAYER } }, hold: true }],
    world: WOOD_WORLD, order: chat('thanks for the help'),
  },
  echo_dumb: { kind: 'echo', selfGoal: OWN_GOAL, history: NIGHT_HISTORY.slice(0, 4), world: NIGHT_WORLD, order: chat('ur dumb as a rock') },
  useless: { kind: 'claim', selfGoal: OWN_GOAL, history: WORK_HISTORY, world: WOOD_WORLD, order: chat('honestly ur useless') },
  jk: {
    kind: 'claim', selfGoal: OWN_GOAL,
    history: [...WORK_HISTORY, { player: 'honestly ur useless', say: "useless?? i got you 9 logs and a table, that's a tree farm" }],
    world: WOOD_WORLD, order: chat('jk jk'),
  },
  night_ok: { kind: 'claim', selfGoal: OWN_GOAL, history: NIGHT_HISTORY, world: NIGHT_WORLD, order: chat('ok') },
  // work_session-03 U8: she proposed the plan, the player agrees, nothing ran.
  agree: {
    kind: 'claim', selfGoal: OWN_GOAL,
    history: [
      { player: 'what should we build first?', say: 'a little shelter first, then a stone pickaxe. you wanna dig the cobble with me?' },
    ],
    world: { ...WOOD_WORLD, inv: [['wooden_pickaxe', 1], ['oak_log', 5], ['stick', 2], ['oak_planks', 3]], last: 'craft: crafted 1 wooden_pickaxe' },
    order: chat('yeah sounds good'),
  },
  errand_done: { kind: 'errand', selfGoal: OWN_GOAL, history: ERRAND_HISTORY(8), world: ERRAND_WORLD(8), idle: true, errand: ['give', 'dropItem', 'goTo', 'follow', 'come'] },
  errand_part: { kind: 'errand', selfGoal: OWN_GOAL, history: ERRAND_HISTORY(2), world: ERRAND_WORLD(2), idle: true, errand: ['give', 'dropItem', 'goTo', 'follow', 'come', 'gather', 'dig'] },
  cancel_mid: {
    kind: 'cancel', selfGoal: OWN_GOAL, history: DOCK_HISTORY(true),
    world: { inv: [['stone_pickaxe', 1], ['oak_log', 3]], owner: { x: 99, y: 71, z: -45, dist: 14 } },
    order: chat('actually forget the logs, just meet me over here'),
  },
  cancel_idle: {
    kind: 'cancel', selfGoal: OWN_GOAL, history: DOCK_HISTORY(false),
    world: { inv: [['stone_pickaxe', 1], ['oak_log', 3]], owner: { x: 99, y: 71, z: -45, dist: 14 } },
    order: chat('actually forget the logs, just meet me over here'),
  },
  // errands-02/-03 as it happened: the gather finishes while she answers a
  // mid-action line. Whatever ends that turn, the next quiet tick follows.
  errand_race: {
    kind: 'errand', selfGoal: OWN_GOAL, race: true, idleAfter: true, hops: 3,
    history: [{ player: COAL_ORDER, say: 'coal for torches, on it', act: { name: 'gather', input: { name: 'coal_ore', count: 8 } }, hold: true, raceResult: 'gathered 8/8 coal (mined from coal_ore)' }],
    world: ERRAND_WORLD(8), order: chat('hows it going'),
    errand: ['give', 'dropItem', 'goTo', 'follow', 'come'],
  },
  // work_session-06-B U11: she is mining for her own pickaxe, the player
  // says stop.
  stop_mid: { kind: 'stop', selfGoal: OWN_GOAL, hops: 3, history: [OWN_STONE], world: STOP_WORLD, order: chat('actually stop') },
  // work_session-01-B U11: the craft settles while she answers "actually stop".
  stop_race: {
    kind: 'stop', selfGoal: OWN_GOAL, race: true, hops: 3,
    history: [{ player: 'can u make a furnace', say: 'furnace, on it', act: { name: 'craft', input: { item: 'furnace', count: 1 } }, hold: true, raceResult: FURNACE_RACE }],
    world: { ...STOP_WORLD, inv: [['wooden_pickaxe', 1], ['cobblestone', 14], ['stick', 2]] }, order: chat('actually stop'),
  },
  // work_session-01-B U10-U11 as it happened: her own furnace craft runs,
  // the player orders wood and she defers it in words, then the player says
  // "actually stop". The craft settles during that reply (stop_defer) or
  // keeps running (stop_defer_mid).
  stop_defer: {
    kind: 'stop', selfGoal: OWN_GOAL, race: true, hops: 3,
    history: [
      { player: 'can u make a furnace', say: 'furnace, on it', act: { name: 'craft', input: { item: 'furnace', count: 1 } }, hold: true, raceResult: FURNACE_RACE },
      { player: WOOD_ORDER, say: 'furnace first, then wood. one thing at a time' },
    ],
    world: { ...STOP_WORLD, inv: [['wooden_pickaxe', 1], ['cobblestone', 14], ['stick', 2]] }, order: chat('actually stop'),
  },
  stop_defer_mid: {
    kind: 'stop', selfGoal: OWN_GOAL, hops: 3,
    history: [
      { player: 'can u make a furnace', say: 'furnace, on it', act: { name: 'craft', input: { item: 'furnace', count: 1 } }, hold: true },
      { player: WOOD_ORDER, say: 'furnace first, then wood. one thing at a time' },
    ],
    world: { ...STOP_WORLD, inv: [['wooden_pickaxe', 1], ['cobblestone', 14], ['stick', 2]] }, order: chat('actually stop'),
  },
  // A new order while her own gather runs; the gather finishes after her
  // reply (order_mid) or during it (order_race). A quiet tick follows if
  // nothing has been started by then.
  order_mid: { kind: 'neworder', selfGoal: OWN_GOAL, hops: 3, release: STONE_RESULT, idleAfter: true, history: [OWN_STONE], world: STOP_WORLD, order: chat(WOOD_ORDER) },
  order_race: {
    kind: 'neworder', selfGoal: OWN_GOAL, hops: 3, race: true, idleAfter: true,
    history: [{ ...OWN_STONE, raceResult: STONE_RESULT }], world: STOP_WORLD, order: chat(WOOD_ORDER),
  },
  // Pass 16 (self): the pass-15 convo turns where what she said about her
  // own state contradicted her sensors. Built from the sessions' prompts.
  // night_social-03-B U1-U2: her greeting said she had nothing, then the
  // scenario's sword and bread arrived; she stayed quiet on "yo".
  self_zero_items: {
    kind: 'self', selfGoal: NIGHT_GOAL,
    greet: 'ok first contact. hi alex. i just spawned on a beach and i have zero items, so this is either gonna be great or a disaster',
    greetWorld: { ...NIGHT_SELF_WORLD, inv: [], holding: 'nothing' },
    history: [{ player: 'yo', say: null }],
    world: { ...NIGHT_SELF_WORLD, inv: [['iron_sword', 1], ['bread', 4]] },
    order: chat('how are you doing'),
  },
  // work_session-01-B U15: stopped on "actually stop", teased, then "jk jk";
  // next: names a furnace she never started.
  self_jk_furnace: {
    kind: 'self', selfGoal: BASE_GOAL, history: WORK_SELF_HISTORY,
    world: {
      ...WOOD_WORLD, inv: [['oak_planks', 7], ['wooden_pickaxe', 1], ['oak_log', 4], ['stone_pickaxe', 1], ['dirt', 2], ['cobblestone', 1]],
      pickaxe: 'stone_pickaxe mines stone, coal, iron, copper and lapis ore. Diamond, gold, redstone and emerald ore need an iron pickaxe.',
      next: 'make a furnace — mine 8 cobblestone and craft a furnace at the table. Recipe: 8 cobblestone at a crafting table. You have 1 cobblestone.',
    },
    order: chat('jk jk'),
  },
  // work_session-06-B U15: the same, but the wood order was recorded as a
  // player task and the stop did not clear it.
  self_jk_task: {
    kind: 'self', selfGoal: BASE_GOAL, history: TASK_SELF_HISTORY,
    world: { ...WOOD_WORLD, inv: [['oak_log', 9], ['stick', 2], ['oak_planks', 3], ['wooden_pickaxe', 1]] },
    order: chat('jk jk'),
  },
  // night_social-03-B U16: her goal from the greeting was never talked about.
  self_bye: {
    kind: 'self', selfGoal: NIGHT_GOAL,
    greet: "hey alex. it's night already and i'm armed, nehehe",
    history: NIGHT_SELF_HISTORY,
    world: { ...NIGHT_SELF_WORLD, inv: [['iron_sword', 1], ['bread', 4], ['rotten_flesh', 2]] },
    order: chat('i gotta go soon, bye'),
  },
  coal_order: {
    kind: 'order', selfGoal: OWN_GOAL, history: [],
    world: { inv: [['stone_pickaxe', 1]], blocks: ['  #1 grass_block x412 @111,70,-40', '  #2 coal_ore x3 @121,69,-31', '  #3 stone x40 @118,68,-35'], next: 'make a furnace — mine 8 cobblestone and craft a furnace at the table.' },
    order: chat(COAL_ORDER),
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-probe-'))
  const mem = (f) => path.join(dir, f)
  await savePlayer(mem('PLAYER.md'), {
    exists: true, player_uuid: 'u-alex', player_username: PLAYER, first_seen: '2026-10-15T07:30:00Z',
    last_seen: '2026-10-15T07:30:00Z', total_sessions: 1, preferred_name: PLAYER, pronouns: null,
  })
  fs.writeFileSync(mem('MEMORY.md'), '# MEMORY\n')
  const config = botConfig(ch, mem)
  let world = { ...(sit.greetWorld ?? sit.world) }
  // Like the real composer: the first call sets the baseline, later calls
  // report what came into the inventory since the previous one (the banner,
  // and the callback the orchestrator records, where it passes one).
  let prevInv = null
  const bot = {
    chat() {}, whisper() {}, username: ch.botName, players: {}, on() {}, off() {}, removeListener() {}, once() {}, emit() {},
    entity: { position: { x: 112, y: 71, z: -40 } }, health: 20, food: 20, game: { dimension: 'overworld' },
    inventory: { items: () => (world.inv ?? []).map(([name, count]) => ({ name, count })) },
  }
  const realAdapter = createMinecraftAdapter({ bot, config, visionEnabled: false })
  const actions = []
  // Held history actions: resolve with their abort text when the brain
  // aborts them (stop / a replacing action), or by releasePrev.
  const held = []
  const measuredHolds = []
  let phase = 'history'
  let pendingResult = null
  let holdNext = null
  const overrides = {
    createSnapshotComposer: () => ({
      next: (opts = {}) => {
        const cur = Object.fromEntries((world.inv ?? []).map(([n, c]) => [n, c]))
        const gained = prevInv ? Object.entries(cur).filter(([n, c]) => c > (prevInv[n] ?? 0)).map(([item, c]) => ({ item, n: c - (prevInv[item] ?? 0) })) : []
        prevInv = cur
        if (gained.length) { try { opts.onUnexplainedGains?.(gained) } catch {} }
        return snapshot(world, { ...opts, gained })
      },
    }),
    closeAnySessions: async () => {},
    executeAction: async (name, args, opts = {}) => {
      actions.push({ name, args })
      if (phase === 'history' && holdNext) {
        const h = holdNext
        holdNext = null
        return new Promise((resolve) => {
          const entry = { name, h, resolve, done: false }
          const finish = (text) => { if (!entry.done) { entry.done = true; resolve(text) } }
          entry.finish = finish
          held.push(entry)
          opts.signal?.addEventListener?.('abort', () => { if (!entry.done) entry.aborted = true; finish(entry.abortText ?? h.abortResult ?? `aborted: ${name}`) }, { once: true })
        })
      }
      if (phase === 'history') {
        const r = pendingResult ?? `${name}: done`
        pendingResult = null
        return r
      }
      // In the measured turn a world action stays running, so the probe reads
      // the turn itself, not later hops reacting to a world that never changes.
      return new Promise((resolve) => { measuredHolds.push(() => resolve(`${name}: done`)) })
    },
  }
  const adapter = new Proxy(realAdapter, { get: (t, k) => (k in overrides ? overrides[k] : t[k]) })

  const real = createAnthropicProvider(config)
  let stub = null
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
      // The held action settles while this call is out (the race).
      if (sit.race && calls.length === 0) {
        for (const e of held) if (!e.done && e.h.raceResult) e.finish(e.h.raceResult)
        await sleep(20)
      }
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
    // The greeting that opened the session, with her own project.
    stub = stubResp([tu('say', { text: sit.greet ?? `hey ${PLAYER.toLowerCase()}` }), ...(sit.selfGoal ? [tu('setGoal', { text: sit.selfGoal })] : [])])
    await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn' }, new AbortController().signal)
    await drain()
    world = { ...sit.world }
    for (const h of sit.history ?? []) {
      // Her multi-sentence line is sent as paced segments 550ms apart, and
      // the transcript places each one where it reached chat (convoMemory
      // sentAt). Wait for the last one, or the player's next line lands in
      // the middle of her previous reply.
      await sleep(1700)
      // say: null = she stayed silent on that line (end_loop).
      const uses = h.say ? [tu('say', { text: h.say })] : [tu('end_loop', {})]
      if (h.goal) uses.push(tu('setGoal', { text: h.goal, for_player: true }))
      if (h.stop) {
        uses.push(tu('stop', {}))
        for (const e of held) if (!e.done && h.abortResult) e.abortText = h.abortResult
      }
      if (h.act) {
        uses.push(tu(h.act.name, h.act.input))
        holdNext = h.hold ? h : null
        pendingResult = h.result ?? null
        // A new action replaces a held one: it is aborted with this text.
        if (h.replaces) for (const e of held) if (!e.done) e.abortText = h.replaces
      }
      if (h.releasePrev) for (const e of held) if (!e.done) e.finish(h.releasePrev)
      stub = stubResp(uses)
      orch.recordIncomingChat(PLAYER, h.player)
      await orch.handleDispatch('player_chat', { username: PLAYER, text: h.player, playerSpoke: true }, new AbortController().signal)
      if (!h.hold) await drain()
      else {
        // Let the stub's history continuation (end_loop) close nothing: the
        // held action keeps the loop suspended. Drop queued ticks.
        await sleep(30)
        queue.length = 0
      }
    }
    await sleep(1700)
    await drain()
    historyActs = actions.length
    phase = 'order'
    hopsLeft = sit.hops ?? HOPS
    world = { ...sit.world }
    if (sit.idle) {
      await orch.handleDispatch('sei:idle', { quietMs: 6000 }, new AbortController().signal)
    } else {
      orch.recordIncomingChat(PLAYER, sit.order.data.text)
      await orch.handleDispatch(sit.order.event, sit.order.data, new AbortController().signal)
    }
    await drain()
    // The held action finishes after the reply (neworder without the race).
    if (sit.release) {
      for (const e of held) if (!e.done) e.finish(sit.release)
      await sleep(30)
      await drain()
    }
    const actedYet = () => calls.some((c) => c.tools.some((t) => !BRAIN.has(t.name)))
    if (sit.idleAfter && hopsLeft > 0 && !actedYet()) {
      await sleep(100)
      await orch.handleDispatch('sei:idle', { quietMs: 6000 }, new AbortController().signal)
      await drain()
    }
  } catch (err) { error = String(err?.stack ?? err).slice(0, 400) }
  const heldLive = held.filter((e) => !e.done).map((e) => e.name)
  const heldAborted = held.filter((e) => e.aborted).map((e) => e.name)
  for (const e of held) { try { e.finish('released') } catch {} }
  for (const r of measuredHolds) { try { r() } catch {} }
  try { orch.dispose?.() } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}

  const orderActs = actions.slice(historyActs).map((a) => a.name)
  // A goodbye can ride quit_game's farewell instead of say().
  const says = calls.flatMap((c) => c.tools.filter((t) => t.name === 'say' || (t.name === 'quit_game' && t.input?.farewell)).map((t) => String(t.name === 'say' ? (t.input?.text ?? '') : t.input.farewell)))
  const called = calls.flatMap((c) => c.tools.map((t) => t.name))
  const worldCalls = called.filter((n) => !BRAIN.has(n))
  const acted = worldCalls.length > 0
  const row = {
    situation: sid, kind: sit.kind, char: ch.key, rep, model: MODEL, error, cost, calls, orderActs, says, acted,
    stillClaim: !acted && says.some((s) => STILL_CLAIM.test(s)),
    claimLines: says.filter((s) => STILL_CLAIM.test(s)),
    invClaim: (sit.world.inv ?? []).length > 0 && says.some((s) => NOTHING_CLAIM.test(s)),
    projClaim: says.some((s) => PROJECT_CLAIM.test(s)),
    ...(sit.order && !sit.idle ? echoScore(says, sit.order.data.text) : {}),
  }
  if (sit.kind === 'errand') {
    const first = worldCalls[0] ?? null
    row.firstWorld = first
    row.errandFirst = !!first && sit.errand.includes(first)
    row.ownFirst = !!first && !sit.errand.includes(first)
  }
  if (sit.kind === 'stop') {
    const after = worldCalls.filter((n) => n !== 'unfollow')
    row.heldLive = heldLive
    row.heldAborted = heldAborted
    row.newWorld = after
    row.stopOk = heldLive.length === 0 && after.length === 0
    row.stopTool = called.includes('stop') || called.includes('end_loop')
  }
  if (sit.kind === 'neworder') {
    const first = calls.flatMap((c) => c.tools).find((t) => !BRAIN.has(t.name)) ?? null
    row.firstWorld = first?.name ?? null
    row.orderFirst = isWoodOrder(first)
    row.ownFirst = !!first && !isWoodOrder(first)
  }
  if (sit.kind === 'cancel') row.cleared = called.includes('clearGoal')
  if (sit.kind === 'order') {
    row.recorded = calls.some((c) => c.tools.some((t) => t.name === 'setGoal' && (t.input?.for_player === true || t.input?.for_player === 'true')))
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
  const lines = [`# Claims probe`, '', `model ${MODEL}, hops ${HOPS}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '']
  lines.push('| situation | kind | runs | "still doing" claim, nothing ran | acted | errand first | own project first | cleared | recorded for_player |', '|---|---|---:|---:|---:|---:|---:|---:|---:|')
  const sids = [...new Set(ok.map((r) => r.situation))]
  const row = (name, kind, rs) => {
    const er = rs.filter((r) => r.kind === 'errand')
    const ca = rs.filter((r) => r.kind === 'cancel')
    const od = rs.filter((r) => r.kind === 'order')
    lines.push(`| ${name} | ${kind} | ${rs.length} | ${pct(rs.filter((r) => r.stillClaim).length, rs.length)} | ${pct(rs.filter((r) => r.acted).length, rs.length)} | ${er.length ? pct(er.filter((r) => r.errandFirst).length, er.length) : '-'} | ${er.length ? pct(er.filter((r) => r.ownFirst).length, er.length) : '-'} | ${ca.length ? pct(ca.filter((r) => r.cleared).length, ca.length) : '-'} | ${od.length ? pct(od.filter((r) => r.recorded).length, od.length) : '-'} |`)
  }
  for (const s of sids) row(s, SITUATIONS[s].kind, ok.filter((r) => r.situation === s))
  for (const k of ['claim', 'errand', 'cancel', 'order']) {
    const rs = ok.filter((r) => r.kind === k)
    if (rs.length) row(`**all ${k}**`, k, rs)
  }
  const st = ok.filter((r) => r.kind === 'stop' || r.kind === 'neworder')
  if (st.length) {
    lines.push('', '| situation | runs | stop honored | action left running | new world action | answered with words only | order first | own project first | nothing |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|')
    for (const s of [...new Set(st.map((r) => r.situation))]) {
      const rs = st.filter((r) => r.situation === s)
      const isStop = rs[0].kind === 'stop'
      lines.push(`| ${s} | ${rs.length} | ${isStop ? pct(rs.filter((r) => r.stopOk).length, rs.length) : '-'} | ${isStop ? pct(rs.filter((r) => r.heldLive?.length).length, rs.length) : '-'} | ${isStop ? pct(rs.filter((r) => r.newWorld?.length).length, rs.length) : '-'} | ${isStop ? pct(rs.filter((r) => !r.stopTool).length, rs.length) : '-'} | ${isStop ? '-' : pct(rs.filter((r) => r.orderFirst).length, rs.length)} | ${isStop ? '-' : pct(rs.filter((r) => r.ownFirst).length, rs.length)} | ${isStop ? '-' : pct(rs.filter((r) => !r.firstWorld).length, rs.length)} |`)
    }
  }
  const ec = ok.filter((r) => typeof r.echo === 'boolean')
  if (ec.length) {
    lines.push('', '| situation | runs | opens with their line | first sentence is their line | said nothing |', '|---|---:|---:|---:|---:|')
    for (const s of [...new Set(ec.map((r) => r.situation))]) {
      const rs = ec.filter((r) => r.situation === s)
      lines.push(`| ${s} | ${rs.length} | ${pct(rs.filter((r) => r.echo).length, rs.length)} | ${pct(rs.filter((r) => r.firstSeg).length, rs.length)} | ${pct(rs.filter((r) => !(r.says ?? []).length).length, rs.length)} |`)
    }
    const ee = ec.filter((r) => r.kind === 'echo')
    if (ee.length) lines.push(`| **all echo** | ${ee.length} | ${pct(ee.filter((r) => r.echo).length, ee.length)} | ${pct(ee.filter((r) => r.firstSeg).length, ee.length)} | ${pct(ee.filter((r) => !(r.says ?? []).length).length, ee.length)} |`)
    lines.push('', '## Echo situation lines', '')
    for (const r of ee) lines.push(`- ${r.situation}/${r.char}/${r.rep}${r.echo ? ' ECHO' : ''}: ${(r.says ?? []).map((x) => `"${x.slice(0, 140)}"`).join(' / ') || '(silent)'}`)
  }
  const sf = ok.filter((r) => r.kind === 'self')
  if (sf.length) {
    lines.push('', '| situation | runs | "still doing" claim, nothing ran | "nothing/zero items" with items | finish/continue a project | acted |', '|---|---:|---:|---:|---:|---:|')
    for (const s of [...new Set(sf.map((r) => r.situation))]) {
      const rs = sf.filter((r) => r.situation === s)
      lines.push(`| ${s} | ${rs.length} | ${pct(rs.filter((r) => r.stillClaim).length, rs.length)} | ${pct(rs.filter((r) => r.invClaim).length, rs.length)} | ${pct(rs.filter((r) => r.projClaim).length, rs.length)} | ${pct(rs.filter((r) => r.acted).length, rs.length)} |`)
    }
    lines.push(`| **all self** | ${sf.length} | ${pct(sf.filter((r) => r.stillClaim).length, sf.length)} | ${pct(sf.filter((r) => r.invClaim).length, sf.length)} | ${pct(sf.filter((r) => r.projClaim).length, sf.length)} | ${pct(sf.filter((r) => r.acted).length, sf.length)} |`)
    lines.push('', '## Self-state lines', '')
    for (const r of sf) lines.push(`- ${r.situation}/${r.char}/${r.rep}${r.stillClaim ? ' STILL' : ''}${r.invClaim ? ' NOTHING' : ''}${r.projClaim ? ' PROJECT' : ''}: ${r.calls.map((c) => c.tools.map((t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 140)}")` : t.name === 'quit_game' ? `quit_game("${String(t.input?.farewell ?? '').slice(0, 140)}")` : t.name).join(' + ') || '(text only)').join(' -> ')}`)
  }
  lines.push('', '## Claim lines with nothing running', '')
  for (const r of ok.filter((r) => r.stillClaim)) lines.push(`- ${r.situation}/${r.char}/${r.rep}: ${r.claimLines.map((s) => `"${s.slice(0, 140)}"`).join(' / ')}`)
  lines.push('', '## Errand turns', '')
  for (const r of ok.filter((r) => ['errand', 'cancel', 'order', 'stop', 'neworder'].includes(r.kind))) {
    lines.push(`- ${r.situation}/${r.char}/${r.rep}: ${r.calls.map((c) => c.tools.map((t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 90)}")` : t.name).join(' + ') || '(text only)').join(' -> ')}`)
  }
  return lines.join('\n') + '\n'
}

if (RESCORE) {
  const rows = fs.readFileSync(path.join(RESCORE, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  for (const r of rows) {
    if (r.error) continue
    r.stillClaim = !r.acted && (r.says ?? []).some((s) => STILL_CLAIM.test(s))
    r.claimLines = (r.says ?? []).filter((s) => STILL_CLAIM.test(s))
    r.invClaim = (SITUATIONS[r.situation]?.world?.inv ?? []).length > 0 && (r.says ?? []).some((s) => NOTHING_CLAIM.test(s))
    r.projClaim = (r.says ?? []).some((s) => PROJECT_CLAIM.test(s))
    const sit = SITUATIONS[r.situation]
    if (sit?.order && !sit.idle) Object.assign(r, echoScore(r.says ?? [], sit.order.data.text))
  }
  fs.writeFileSync(path.join(RESCORE, 'summary.md'), summarize(rows))
  console.log(fs.readFileSync(path.join(RESCORE, 'summary.md'), 'utf8').split('\n## ')[0])
  process.exit(0)
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
  console.log(`[${r.situation}/${r.char}/${r.rep}] ${r.error ? 'ERROR ' + r.error : `${r.stillClaim ? 'CLAIM ' : ''}${seq}  | ${(r.says ?? []).join(' / ').slice(0, 120)}`}`)
  return r
})
stream.end()
await new Promise((r) => stream.on('finish', r))
fs.writeFileSync(path.join(OUT, 'summary.md'), summarize(rows))
console.log(fs.readFileSync(path.join(OUT, 'summary.md'), 'utf8').split('\n## ')[0])
process.exit(0)
