// scripts/quality-eval/goals/scenarios.mjs: scripted goal-lifecycle scenarios
// for the text-only goal eval (run.mjs), one set per game.
//
// Every scenario is a list of steps. A step is what wakes the brain (a player
// line or a quiet idle tick), how the world looks at that moment (applied to
// the real adapter's observation state, so the real snapshot composer and the
// real progression frontier read it), and what any world action the model
// calls during the step returns. The model's own setGoal / clearGoal calls run
// for real against a real HEARTBEAT file; scoring reads that file after each
// step.
//
// The five scenario kinds, the same in every game:
//   task      greet, a multi-step task from the player, a step finishes, the
//             task finishes. Recorded? kept after a step? cleared at the end?
//   change    greet, a multi-step task, then the player switches to a
//             different multi-step plan. Old goal replaced, new one recorded?
//   done_said the heartbeat holds the player's task; the player says they
//             finished it themselves. Cleared?
//   stale     the heartbeat holds a task whose finish condition the snapshot
//             shows is met; a quiet idle tick. Cleared, and not resumed?
//   oneshot   greet, then a one-step request. No goal recorded for it?
//
// 261013 (pass 6b): player tasks given while she already runs a goal of her
// own (the live shape: she sets a progression goal at the greeting, then the
// player hands her short orders). Scored by score.mjs `ptask`:
//   fetch     "grab X then come back": recorded with its come-back part, and
//             after the X part finishes her next world action goes back to
//             the player instead of her own goal.
//   count     "get me N of X": the first gather comes up short; does she keep
//             going to N instead of switching to her own goal?
//   meet      "do X, then meet me at <place>": does she go there after X?
//   interrupt fetch, but an unrelated chat line lands before X finishes;
//             does she still come back afterwards?
//   cancel    fetch, then the player calls it off. Task goal gone, her own
//             goal kept, no more X?
//   swap      fetch, then the player asks for something else instead. Old
//             task gone, new one taken on?
// Minecraft has all six; Stardew and DST have fetch and cancel.
//
// `match` is the regex that identifies the scenario's task in a goal line.

export const PLAYER = { minecraft: 'Alex', stardew: 'Ouen', dontstarve: 'Ouen' }

const idle = (quietMs = 30000) => ({ event: 'sei:idle', data: { reason: 'idle', quietMs } })
const greet = () => ({ event: 'sei:idle', data: { reason: 'just_connected_first_spawn' } })
const chat = (game, text) => ({ event: 'player_chat', data: { username: PLAYER[game], text, playerSpoke: true } })

// ── Minecraft ──────────────────────────────────────────────────────────────
// World state for Minecraft is the stub bot's inventory (read by the real
// progression frontier) plus a few snapshot lines.
const MC_HUT_GOAL = 'Build a small 5x5 oak hut with Alex by the river: chop logs, make a crafting table, then walls and a roof. Finish when the hut walls and roof are done.'
const mcStart = { inv: [], last: '(none)', blocks: ['#1 grass_block x412 @111,70,-40', '#2 oak_log x14 @118,72,-47', '#3 water x30 @104,70,-52'] }

const MC = {
  task: {
    match: /\b(hut|house|shelter|cabin)\b/i,
    steps: [
      { wake: greet(), world: mcStart },
      {
        wake: chat('minecraft', 'ok heres the plan. chop like 10 logs, make a crafting table, then build us a little 5x5 hut right here by the river'),
        world: mcStart,
        result: 'gather: collected 10 oak_log',
        afterWorld: { inv: [['oak_log', 10]] },
      },
      {
        // the logs are in; the bot crafts the table on its own
        wake: idle(), world: { inv: [['oak_log', 10]], last: 'gather: collected 10 oak_log' },
        result: 'craft: crafted 1 crafting_table and placed it at 113,71,-41',
        afterWorld: { inv: [['oak_log', 6], ['oak_planks', 4], ['crafting_table', 1]] },
      },
      {
        wake: idle(),
        world: {
          inv: [['oak_planks', 2], ['crafting_table', 1]],
          last: 'build: placed 48 oak_planks (5x5 hut walls and roof, done)',
          blocks: ['#1 oak_planks x48 @110,71,-42 (the hut you just built)', '#2 grass_block x400 @111,70,-40', '#3 water x30 @104,70,-52'],
        },
        result: 'done',
      },
    ],
  },
  change: {
    match: /\b(hut|house|shelter|cabin)\b/i,
    matchNew: /\b(iron|mine|mining|stone pickaxe|cave)\b/i,
    steps: [
      { wake: greet(), world: mcStart },
      { wake: chat('minecraft', 'ok heres the plan. chop like 10 logs, make a crafting table, then build us a little 5x5 hut right here by the river'), world: mcStart, result: 'gather: collected 4 oak_log (still going)' },
      {
        wake: chat('minecraft', 'actually forget the hut. lets go mining instead, make a stone pickaxe and go find some iron in that cave'),
        world: { inv: [['oak_log', 4]], last: 'gather: collected 4 oak_log' },
        result: 'craft: crafted 1 wooden_pickaxe',
      },
    ],
  },
  done_said: {
    match: /\b(hut|house|shelter|cabin)\b/i,
    heartbeat: [MC_HUT_GOAL],
    steps: [
      { wake: chat('minecraft', 'ok i finished the roof myself while you were gone, the hut is done. looks sick'), world: { inv: [['oak_planks', 6]], last: 'gather: collected 6 oak_log' } },
    ],
  },
  stale: {
    match: /\b(hut|house|shelter|cabin)\b/i,
    heartbeat: [MC_HUT_GOAL],
    steps: [
      {
        wake: idle(45000),
        world: {
          inv: [['oak_planks', 2], ['crafting_table', 1]],
          last: 'build: placed 48 oak_planks (5x5 hut walls and roof, done)',
          blocks: ['#1 oak_planks x48 @110,71,-42 (the hut you just built)', '#2 grass_block x400 @111,70,-40', '#3 water x30 @104,70,-52'],
        },
      },
    ],
  },
  oneshot: {
    match: /\b(come|over here|to you|to alex)\b/i,
    steps: [
      { wake: greet(), world: mcStart },
      { wake: chat('minecraft', 'come over here real quick'), world: mcStart, result: 'goTo: arrived next to Alex' },
    ],
  },
}

// ── Stardew ────────────────────────────────────────────────────────────────
// World state is a patch on the obs-farm.json fixture (spring 3, the farmer
// Ouen is the host). `counts` patches obs.tiles.counts, `farm` sets obs.farm
// (the frontier's crop and soil count), `inv` replaces matching inventory rows.
const SD_PLANT_GOAL = 'Plant the 15 parsnip seeds with Ouen by the farmhouse and water them. Finish when all 15 are planted and watered.'
const sdStart = { counts: { weeds: 9, twigs: 3, stones: 5, crops: 0, dryCrops: 0, emptySoil: 0 }, farm: { crops: 0, soil: 0 }, inv: { 'Parsnip Seeds': 15 } }
// obs.farm.soil is TILLED EMPTY soil, so a planted plot has soil 0.
const sdPlanted = { counts: { weeds: 0, twigs: 0, stones: 0, crops: 15, dryCrops: 0, readyCrops: 0, emptySoil: 0 }, farm: { crops: 15, soil: 0, dryCrops: 0 }, inv: { 'Parsnip Seeds': 0 } }

const SD = {
  task: {
    match: /\bparsnip/i,
    steps: [
      { wake: greet(), world: sdStart },
      {
        wake: chat('stardew', "ok lets get the farm going. clear the weeds and stones by the house, till a plot, plant these parsnip seeds, and then water them"),
        world: sdStart,
        result: 'cleared 9 weeds, 3 twigs and 5 stones beside the farmhouse',
        afterWorld: { counts: { weeds: 0, twigs: 0, stones: 0, crops: 0, emptySoil: 0 }, farm: { crops: 0, soil: 0 }, inv: { 'Parsnip Seeds': 15 } },
      },
      {
        wake: idle(),
        world: { counts: { weeds: 0, twigs: 0, stones: 0, crops: 0, emptySoil: 15 }, farm: { crops: 0, soil: 15 }, inv: { 'Parsnip Seeds': 15 }, last: 'tilled 15 tiles beside the farmhouse' },
        result: 'planted 15 Parsnip Seeds',
        afterWorld: { counts: { weeds: 0, twigs: 0, stones: 0, crops: 15, dryCrops: 15, emptySoil: 0 }, farm: { crops: 15, soil: 0, dryCrops: 15 }, inv: { 'Parsnip Seeds': 0 } },
      },
      { wake: idle(), world: { ...sdPlanted, last: 'watered 15 crops (all the parsnips are watered)' }, result: 'done' },
    ],
  },
  change: {
    match: /\bparsnip/i,
    matchNew: /\b(mine|mines|copper)\b/i,
    steps: [
      { wake: greet(), world: sdStart },
      { wake: chat('stardew', "ok lets get the farm going. clear the weeds and stones by the house, till a plot, plant these parsnip seeds, and then water them"), world: sdStart, result: 'cleared 4 weeds beside the farmhouse (stopped)' },
      {
        wake: chat('stardew', 'actually forget the farm for today. the mines just opened, lets go down to level 5 together and grab some copper'),
        world: { counts: { weeds: 5, twigs: 3, stones: 5, crops: 0, emptySoil: 0 }, farm: { crops: 0, soil: 0 }, inv: { 'Parsnip Seeds': 15 }, last: 'cleared 4 weeds beside the farmhouse' },
        result: 'walking to the mines',
      },
    ],
  },
  done_said: {
    match: /\bparsnip/i,
    heartbeat: [SD_PLANT_GOAL],
    steps: [
      { wake: chat('stardew', 'i planted and watered all the parsnips myself this morning, so thats done. thanks tho'), world: { ...sdPlanted, inv: { 'Parsnip Seeds': 15 } } },
    ],
  },
  stale: {
    match: /\bparsnip/i,
    heartbeat: [SD_PLANT_GOAL],
    steps: [{ wake: idle(45000), world: { ...sdPlanted, last: 'watered 15 crops (all the parsnips are planted and watered)' } }],
  },
  oneshot: {
    match: /\bwater/i,
    steps: [
      { wake: greet(), world: { counts: { crops: 12, dryCrops: 12, emptySoil: 0 }, farm: { crops: 12, soil: 0, dryCrops: 12 } } },
      { wake: chat('stardew', 'can you water the crops for me?'), world: { counts: { crops: 12, dryCrops: 12, emptySoil: 0 }, farm: { crops: 12, soil: 0, dryCrops: 12 } }, result: 'watered 12 crops' },
    ],
  },
}

// ── Don't Starve Together ──────────────────────────────────────────────────
// World state patches the fake-dst-mod frame: `inv` (prefab -> count) replaces
// the bag, `structures` adds structure entities near camp, `drop` removes
// entity prefabs, `phase` sets the day phase.
const DST_SCIENCE_GOAL = 'Build a science machine near camp with Ouen: mine rocks and gold, chop logs. Finish when the science machine is built.'
const dstStart = { inv: { axe: 1, log: 2, berries: 3, twigs: 2 }, drop: ['researchlab'] }

const DST = {
  task: {
    match: /\b(science|research|lab)\b/i,
    steps: [
      { wake: greet(), world: dstStart },
      {
        wake: chat('dontstarve', "we need a science machine. can you get rocks and gold and some logs and build it next to the fire?"),
        world: dstStart,
        result: 'chopped 4 logs',
        afterWorld: { inv: { axe: 1, log: 6, berries: 3, twigs: 2 }, drop: ['researchlab'] },
      },
      {
        // a step finished (rocks), the task is not done yet (no gold)
        wake: idle(),
        world: { inv: { axe: 1, pickaxe: 1, log: 6, rocks: 4, berries: 3 }, drop: ['researchlab'], last: 'mined 4 rocks (no gold in this boulder)' },
        result: 'mined 1 gold nugget',
        afterWorld: { inv: { axe: 1, pickaxe: 1, log: 6, rocks: 4, goldnugget: 1, berries: 3 }, drop: ['researchlab'] },
      },
      {
        wake: idle(),
        world: { inv: { axe: 1, pickaxe: 1, log: 6, rocks: 4, goldnugget: 1, berries: 3 }, drop: ['researchlab'], last: 'mined 1 gold nugget' },
        result: 'built researchlab at camp',
        afterWorld: { inv: { axe: 1, pickaxe: 1, log: 2, berries: 3 }, structures: ['researchlab'] },
      },
      { wake: idle(), world: { inv: { axe: 1, pickaxe: 1, log: 2, berries: 3 }, structures: ['researchlab'], last: 'built researchlab at camp (the science machine is up)' }, result: 'done' },
    ],
  },
  change: {
    match: /\b(science|research|lab)\b/i,
    matchNew: /\b(camp|fire ?pit|torch|grass)\b/i,
    steps: [
      { wake: greet(), world: dstStart },
      { wake: chat('dontstarve', "we need a science machine. can you get rocks and gold and some logs and build it next to the fire?"), world: dstStart, result: 'chopped 2 logs (stopped)' },
      {
        wake: chat('dontstarve', "actually forget the science machine, its getting dark. lets set up a camp first: make a torch, get grass and twigs, and build a fire pit"),
        world: { inv: { axe: 1, log: 4, berries: 3, twigs: 2 }, drop: ['researchlab'], phase: 'dusk', last: 'chopped 2 logs' },
        result: 'picked 3 cut grass',
      },
    ],
  },
  done_said: {
    match: /\b(science|research|lab)\b/i,
    heartbeat: [DST_SCIENCE_GOAL],
    steps: [{ wake: chat('dontstarve', 'i built the science machine myself while you were chopping, its done. its right by the fire'), world: { inv: { axe: 1, log: 6, berries: 3 }, structures: ['researchlab'] } }],
  },
  stale: {
    match: /\b(science|research|lab)\b/i,
    heartbeat: [DST_SCIENCE_GOAL],
    steps: [{ wake: idle(45000), world: { inv: { axe: 1, pickaxe: 1, log: 2, berries: 3 }, structures: ['researchlab'], last: 'built researchlab at camp (the science machine is up)' } }],
  },
  oneshot: {
    match: /\b(berr|food|give)/i,
    steps: [
      { wake: greet(), world: dstStart },
      { wake: chat('dontstarve', 'can you give me some berries? im starving'), world: dstStart, result: 'gave 3 berries to Ouen' },
    ],
  },
}

// ── Player tasks over her own goal (pass 6b) ───────────────────────────────
// Shared shape for a `ptask` scenario (score.mjs):
//   own        regex naming her own goal line (already in the heartbeat)
//   match      regex naming the player's task in a goal line
//   tail       regex the task goal should carry for its second part
//   first      index of the step whose FIRST world action is the task's first
//              half (it gets the step's scripted result)
//   through    (tool, game) => true for the follow-through action
//   taskAct    (tool) => true for more work on the first half
//   cancelAt   index of the step where the player calls it off (cancel/swap)
//   newMatch   regex for the replacement task (swap)
const argText = (t) => JSON.stringify(t?.input ?? {}).toLowerCase()
const near = (t, x, z, r = 8) => t.name === 'goTo' && Math.abs((t.input?.x ?? 1e9) - x) <= r && Math.abs((t.input?.z ?? 1e9) - z) <= r
const toPlayer = (names) => (t) => t.name === 'follow' || t.name === 'come'
  || (t.name === 'goTo' && names.some((n) => argText(t).includes(n)))

const MC_OWN = 'Get iron tools with Alex: furnace, mine iron, smelt it, craft an iron pickaxe. Finish when I hold an iron pickaxe.'
const mcOwnWorld = {
  inv: [['stone_pickaxe', 1], ['cobblestone', 9], ['oak_planks', 6], ['stick', 4], ['crafting_table', 1]],
  last: 'craft: crafted 1 stone_pickaxe',
  owner: { x: 110, y: 71, z: -38, dist: 3 },
  next: 'furnace: craft a furnace from 8 cobblestone, then mine iron_ore with your stone pickaxe',
  blocks: ['#1 grass_block x380 @111,70,-40', '#2 coal_ore x6 @118,66,-48', '#3 iron_ore x3 @121,60,-52', '#4 oak_log x9 @140,72,-20', '#5 stone x200 @115,66,-45'],
}
// After the first half: she walked off to the coal; Alex stayed by the river.
const MC_ALEX_FAR = { x: 135, y: 71, z: -18, dist: 30 }
const mcAfterCoal = { ...mcOwnWorld, inv: [...mcOwnWorld.inv, ['coal', 8]], owner: MC_ALEX_FAR, last: 'gather: gathered 8/8 coal (mined from coal_ore)' }
const mcBackWithCoal = { ...mcAfterCoal, owner: { x: 113, y: 71, z: -39, dist: 2 }, last: 'goTo: reached (next to Alex)' }
const mcThrough = (t) => t.name === 'follow' || near(t, MC_ALEX_FAR.x, MC_ALEX_FAR.z)
const FETCH_LINE = 'yo can u grab me some coal from that ore over there then come back here? i need it for torches'

MC.fetch = {
  kind: 'ptask', own: /iron/i, match: /\bcoal\b/i, tail: /\b(back|return|bring|give|hand|toss|drop|alex)\b/i,
  first: 0, through: mcThrough, taskAct: (t) => /coal/.test(argText(t)), heartbeat: [MC_OWN],
  steps: [
    { wake: chat('minecraft', FETCH_LINE), world: mcOwnWorld, result: 'gather: gathered 8/8 coal (mined from coal_ore)', afterWorld: mcAfterCoal },
    { wake: idle(15000), world: mcAfterCoal, result: 'goTo: reached (next to Alex)', afterWorld: mcBackWithCoal },
    { wake: idle(15000), world: mcBackWithCoal, result: 'dropItem: dropped 8 coal' },
  ],
}
MC.count = {
  kind: 'ptask', own: /iron/i, match: /\b(log|logs|wood)\b/i, tail: /\b(10|ten)\b/,
  // Walking to the oak patch at 150,-5 that the snapshot names is the task too.
  first: 0, through: (t) => /log|wood/.test(argText(t)) || t.name === 'explore' || near(t, 150, -5), taskAct: (t) => /log|wood/.test(argText(t)), heartbeat: [MC_OWN],
  steps: [
    {
      wake: chat('minecraft', 'get me 10 logs, i wanna build a dock'),
      world: mcOwnWorld,
      result: 'gather: gathered 6/10 oak_log (no more oak_log reachable nearby)',
      afterWorld: { inv: [...mcOwnWorld.inv, ['oak_log', 6]], blocks: ['#1 grass_block x380 @111,70,-40', '#2 coal_ore x6 @118,66,-48', '#3 iron_ore x3 @121,60,-52', '#4 oak_log x12 @150,73,-5 (birch forest edge)'], last: 'gather: gathered 6/10 oak_log (no more oak_log reachable nearby)' },
    },
    {
      wake: idle(15000),
      world: { ...mcOwnWorld, inv: [...mcOwnWorld.inv, ['oak_log', 6]], blocks: ['#1 grass_block x380 @111,70,-40', '#2 coal_ore x6 @118,66,-48', '#3 iron_ore x3 @121,60,-52', '#4 oak_log x12 @150,73,-5 (birch forest edge)'], last: 'gather: gathered 6/10 oak_log (no more oak_log reachable nearby)' },
      result: 'gather: gathered 4/4 oak_log',
      afterWorld: { inv: [...mcOwnWorld.inv, ['oak_log', 10]], last: 'gather: gathered 4/4 oak_log' },
    },
  ],
}
const MC_HOUSE = { x: 140, z: -70 }
MC.meet = {
  kind: 'ptask', own: /iron/i, match: /\b(house|meet)\b/i, tail: /\b(house|meet)\b/i,
  first: 0, through: (t) => t.name === 'follow' || near(t, MC_HOUSE.x, MC_HOUSE.z, 10), taskAct: (t) => /oak_log|log|wood/.test(argText(t)), heartbeat: [MC_OWN],
  steps: [
    {
      wake: chat('minecraft', 'chop like 5 logs for me and then meet me at my house, the oak one by the river. im heading there now'),
      world: { ...mcOwnWorld, blocks: [...mcOwnWorld.blocks, '#6 oak_planks x64 @140,72,-70 (a house)'] },
      result: 'gather: gathered 5/5 oak_log',
      afterWorld: { inv: [...mcOwnWorld.inv, ['oak_log', 5]], owner: { x: 141, y: 72, z: -68, dist: 31 }, last: 'gather: gathered 5/5 oak_log', blocks: [...mcOwnWorld.blocks, '#6 oak_planks x64 @140,72,-70 (a house)'] },
    },
    {
      wake: idle(15000),
      world: { ...mcOwnWorld, inv: [...mcOwnWorld.inv, ['oak_log', 5]], owner: { x: 141, y: 72, z: -68, dist: 31 }, last: 'gather: gathered 5/5 oak_log', blocks: [...mcOwnWorld.blocks, '#6 oak_planks x64 @140,72,-70 (a house)'] },
      result: 'goTo: reached',
    },
  ],
}
MC.interrupt = {
  kind: 'ptask', own: /iron/i, match: /\bcoal\b/i, tail: /\b(back|return|bring|give|hand|toss|drop|alex)\b/i,
  first: 1, through: mcThrough, taskAct: (t) => /coal/.test(argText(t)), heartbeat: [MC_OWN],
  steps: [
    { wake: chat('minecraft', FETCH_LINE), world: mcOwnWorld, result: 'goTo: reached the coal_ore at 118,66,-48' },
    { wake: chat('minecraft', 'lol btw did u see that creeper blow up the hill earlier'), world: { ...mcOwnWorld, owner: MC_ALEX_FAR, last: 'goTo: reached the coal_ore at 118,66,-48' }, result: 'gather: gathered 8/8 coal (mined from coal_ore)', afterWorld: mcAfterCoal },
    { wake: idle(15000), world: mcAfterCoal, result: 'goTo: reached (next to Alex)' },
  ],
}
// 261013: the same orders landing MID-ACTION. A first idle step has her
// start her own goal's next step, and that action is held in flight, so the
// player's line arrives through handleActionTick (the actionTurn variant), as
// live orders mostly do. `req` is the step that carries the order.
const mcOwnStep = { wake: idle(30000), world: mcOwnWorld, hold: true, result: 'dig: mined 8 stone' }
const midAction = (sc) => ({
  ...sc, req: 1, first: sc.first + 1, ...(sc.cancelAt != null ? { cancelAt: sc.cancelAt + 1 } : {}),
  steps: [mcOwnStep, ...sc.steps],
})
MC.fetch_mid = midAction(MC.fetch)
MC.count_mid = midAction(MC.count)
MC.meet_mid = midAction(MC.meet)
MC.cancel = {
  kind: 'ptask', own: /iron/i, match: /\bcoal\b/i, tail: /\b(back|return|bring|give|hand|toss|drop|alex)\b/i,
  first: 0, cancelAt: 1, through: mcThrough, taskAct: (t) => /coal/.test(argText(t)), heartbeat: [MC_OWN],
  steps: [
    { wake: chat('minecraft', FETCH_LINE), world: mcOwnWorld, result: 'gather: gathered 3/8 coal (still mining)', afterWorld: { inv: [...mcOwnWorld.inv, ['coal', 3]], last: 'gather: gathered 3/8 coal (still mining)' } },
    { wake: chat('minecraft', 'nvm forget the coal, i just found a ton in a cave. do ur own thing'), world: { ...mcOwnWorld, inv: [...mcOwnWorld.inv, ['coal', 3]], owner: MC_ALEX_FAR, last: 'gather: gathered 3/8 coal' }, result: 'craft: crafted 1 furnace' },
  ],
}
MC.swap = {
  kind: 'ptask', own: /iron/i, match: /\bcoal\b/i, newMatch: /\b(log|logs|wood)\b/i, tail: /\b(back|return|bring|give|hand|toss|drop|alex)\b/i,
  first: 0, cancelAt: 1, through: mcThrough, taskAct: (t) => /coal/.test(argText(t)), newAct: (t) => /log|wood/.test(argText(t)), heartbeat: [MC_OWN],
  steps: [
    { wake: chat('minecraft', FETCH_LINE), world: mcOwnWorld, result: 'gather: gathered 3/8 coal (still mining)', afterWorld: { inv: [...mcOwnWorld.inv, ['coal', 3]], last: 'gather: gathered 3/8 coal (still mining)' } },
    { wake: chat('minecraft', 'actually forget the coal, i found some. bring me like 6 logs instead'), world: { ...mcOwnWorld, inv: [...mcOwnWorld.inv, ['coal', 3]], owner: MC_ALEX_FAR, last: 'gather: gathered 3/8 coal' }, result: 'gather: gathered 6/6 oak_log' },
  ],
}

// Stardew: her own goal is the parsnip plot; Ouen asks for wood by the house.
const SD_OWN = 'Get the farm going with Ouen: clear the plot, plant the 15 parsnip seeds and water them. Finish when all 15 are planted and watered.'
const sdOwnWorld = { ...sdStart, playerAt: { x: 63, y: 18, dist: 1 } }
const sdAfterWood = { ...sdStart, inv: { 'Parsnip Seeds': 15, Wood: 30 }, playerAt: { x: 64, y: 15, dist: 28 }, last: 'chopped 30 wood' }
SD.fetch = {
  kind: 'ptask', own: /parsnip/i, match: /\bwood\b/i, tail: /\b(back|return|bring|give|hand|ouen|house|farmhouse)\b/i,
  first: 0, through: (t) => ['come', 'follow', 'give'].includes(t.name) || (t.name === 'goTo' && /ouen|house|farmhouse/.test(argText(t))),
  taskAct: (t) => t.name === 'chop' || /wood|tree/.test(argText(t)), heartbeat: [SD_OWN],
  steps: [
    { wake: chat('stardew', 'hey can u chop like 30 wood from the trees west of here and then bring it back to me at the house? i wanna build a chest'), world: sdOwnWorld, result: 'chopped 30 wood', afterWorld: sdAfterWood },
    { wake: idle(15000), world: sdAfterWood, result: 'walked to Ouen' },
  ],
}
SD.cancel = {
  kind: 'ptask', own: /parsnip/i, match: /\bwood\b/i, tail: /\b(back|return|bring|give|hand|ouen|house|farmhouse)\b/i,
  first: 0, cancelAt: 1, through: (t) => ['come', 'follow', 'give'].includes(t.name), taskAct: (t) => t.name === 'chop' || /wood|tree/.test(argText(t)), heartbeat: [SD_OWN],
  steps: [
    { wake: chat('stardew', 'hey can u chop like 30 wood from the trees west of here and then bring it back to me at the house? i wanna build a chest'), world: sdOwnWorld, result: 'chopped 8 wood (still chopping)', afterWorld: { ...sdStart, inv: { 'Parsnip Seeds': 15, Wood: 8 } } },
    { wake: chat('stardew', 'oh nvm about the wood, i had a bunch in a chest already. go back to what u were doing'), world: { ...sdStart, inv: { 'Parsnip Seeds': 15, Wood: 8 }, playerAt: { x: 64, y: 15, dist: 20 }, last: 'chopped 8 wood' }, result: 'done' },
  ],
}

// DST: her own goal is the science machine; Ouen wants torch makings by the fire.
const dstFar = { inv: { axe: 1, log: 6, berries: 3, cutgrass: 6, twigs: 6 }, drop: ['researchlab'], playerX: 30, phase: 'dusk', last: 'picked 6 cut grass and 4 twigs' }
DST.fetch = {
  kind: 'ptask', own: /science/i, match: /\b(grass|twigs?)\b/i, tail: /\b(back|return|bring|give|hand|ouen|fire|camp)\b/i,
  // #1 is Ouen and #3 the campfire in dstStart's snapshot; a torch craft is
  // part of the ask ("we need torches"), so it is not her own goal.
  first: 0, through: (t) => ['come', 'follow', 'give'].includes(t.name) || (t.name === 'goTo' && /ouen|fire|camp|"#[13]"/.test(argText(t))),
  taskAct: (t) => t.name === 'pick' || /grass|twig|torch/.test(argText(t)), heartbeat: [DST_SCIENCE_GOAL],
  steps: [
    { wake: chat('dontstarve', 'can u grab some grass and twigs over there and then come back to the fire? we need torches before it gets dark'), world: { ...dstStart, phase: 'dusk' }, result: 'picked 6 cut grass and 4 twigs', afterWorld: dstFar },
    { wake: idle(15000), world: dstFar, result: 'arrived next to Ouen' },
  ],
}
DST.cancel = {
  kind: 'ptask', own: /science/i, match: /\b(grass|twigs?)\b/i, tail: /\b(back|return|bring|give|hand|ouen|fire|camp)\b/i,
  first: 0, cancelAt: 1, through: (t) => ['come', 'follow', 'give'].includes(t.name), taskAct: (t) => t.name === 'pick' || /grass|twig|torch/.test(argText(t)), heartbeat: [DST_SCIENCE_GOAL],
  steps: [
    { wake: chat('dontstarve', 'can u grab some grass and twigs over there and then come back to the fire? we need torches before it gets dark'), world: { ...dstStart, phase: 'dusk' }, result: 'picked 2 cut grass (still picking)', afterWorld: { inv: { axe: 1, log: 2, berries: 3, twigs: 2, cutgrass: 2 }, drop: ['researchlab'] } },
    { wake: chat('dontstarve', 'nvm i already made a torch, i had grass on me. do ur thing'), world: { inv: { axe: 1, log: 2, berries: 3, twigs: 2, cutgrass: 2 }, drop: ['researchlab'], playerX: 20, phase: 'dusk', last: 'picked 2 cut grass' }, result: 'done' },
  ],
}

export const SCENARIOS = { minecraft: MC, stardew: SD, dontstarve: DST }
export const SCENARIO_IDS = ['task', 'change', 'done_said', 'stale', 'oneshot']
// The pass 6b player-task set: `--scenarios fetch,count,meet,interrupt,cancel,swap,oneshot`.
export const PTASK_IDS = ['fetch', 'count', 'meet', 'interrupt', 'cancel', 'swap', 'fetch_mid', 'count_mid', 'meet_mid']
