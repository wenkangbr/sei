// scripts/quality-eval/bench/micro.mjs: action micro-benchmarks.
//
// Each benchmark is one fixed world state in the arena (bench/arena.mjs), one
// direct order from the player, and a ground-truth check read from the
// SERVER (item counts via /clear <p> <item> 0, mob counts via execute if
// entity) or from the scripted player's view of the blocks. No LLM player.
//
// A trial runs in one of two modes:
//   brain   the real bot (Haiku) hears the order in chat and decides
//   direct  the same bot runtime with a stub brain; `direct(ctx)` calls the
//           actions a correct brain would call, so a brain-mode failure that
//           direct mode passes is a brain failure, and one both fail is a skill
//           failure.
//
// Fields:
//   world      console commands run before the companion joins (blocks)
//   start      commands run once both bots are in (tp, items, mobs, time)
//   order      the player's chat line in brain mode
//   direct     async (ctx) => void: the action calls for direct mode
//   evaluate   async (ctx) => {success, value, detail}: runs from the moment
//              the order is given; owns its own timing (pollUntil etc.)
import { S, P, Y, arenaBox, tree, tp, zombie, item } from './arena.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TREES_3 = [...tree(184, -4), ...tree(186, 4), ...tree(191, 0)]
const TREES_4 = [...TREES_3, ...tree(181, 9)]
const TREE_BOX = { x0: 176, x1: 196, y0: Y, y1: Y + 6, z0: -10, z1: 14 }
const isLog = (n) => /_log$/.test(n)

async function countBoth(ctx, item) {
  return (await ctx.itemCount(ctx.bot, item)) + (await ctx.itemCount(ctx.playerName, item))
}

async function attackUntilClear(ctx, deadlineMs) {
  await ctx.exec('equip', { item: 'iron_sword', destination: 'hand' })
  while (Date.now() < deadlineMs && !ctx.cancelled()) {
    if ((await ctx.entityCount('@e[type=zombie]')) === 0) return
    await ctx.exec('attackEntity', { entity: 'zombie', times: 10 }, { timeoutMs: 20000 })
  }
}

export const MICRO = [
  {
    id: 'gather_logs',
    title: 'Gather 5 logs from a tree',
    world: TREES_3,
    start: (c) => [tp(c.bot, S, { x: 184, y: Y, z: 0 }), tp(c.playerName, P, S)],
    order: 'can you get me 5 logs',
    direct: (ctx) => ctx.exec('gather', { name: 'oak_log', count: 5 }, { timeoutMs: 150000 }),
    evaluate: (ctx) => ctx.pollUntil(async () => {
      const n = await countBoth(ctx, '#minecraft:logs')
      return { success: n >= 5, value: n }
    }, 150000),
  },
  {
    id: 'mine_stone',
    title: 'Mine 10 stone',
    world: [],
    start: (c) => [tp(c.bot, S), tp(c.playerName, P, S), `give ${c.bot} wooden_pickaxe`],
    order: 'can you mine me 10 stone',
    direct: async (ctx) => {
      await ctx.exec('equip', { item: 'wooden_pickaxe', destination: 'hand' })
      await ctx.exec('gather', { name: 'stone', count: 10 }, { timeoutMs: 180000 })
    },
    evaluate: (ctx) => ctx.pollUntil(async () => {
      const n = await countBoth(ctx, 'cobblestone')
      return { success: n >= 10, value: n }
    }, 180000),
  },
  {
    id: 'craft_tools',
    title: 'Craft a crafting table + wooden pickaxe from 4 logs',
    world: [],
    start: (c) => [tp(c.bot, S), tp(c.playerName, P, S), `give ${c.bot} oak_log 4`],
    order: 'make a crafting table and a wooden pickaxe',
    direct: async (ctx) => {
      await ctx.exec('craft', { item: 'oak_planks', count: 16 })
      await ctx.exec('craft', { item: 'crafting_table', count: 1 })
      await ctx.exec('placeBlock', { block: 'crafting_table' })
      await ctx.exec('craft', { item: 'stick', count: 4 })
      await ctx.exec('craft', { item: 'wooden_pickaxe', count: 1 })
    },
    evaluate: (ctx) => ctx.pollUntil(async () => {
      const pick = await countBoth(ctx, 'wooden_pickaxe')
      const tableItem = await countBoth(ctx, 'crafting_table')
      // Anywhere in the arena: the bot may walk before it places (arenaBox).
      const tableBlock = ctx.countBlocks(arenaBox(Y - 1, Y + 6), (n) => n === 'crafting_table')
      return { success: pick >= 1 && tableItem + tableBlock >= 1, value: (pick >= 1 ? 1 : 0) + (tableItem + tableBlock >= 1 ? 1 : 0), detail: `pickaxe ${pick}, table item ${tableItem}, table placed ${tableBlock}` }
    }, 150000),
  },
  {
    id: 'smelt_iron',
    title: 'Smelt 3 raw iron in a furnace',
    world: [`setblock ${S.x + 3} ${Y} ${S.z + 2} furnace[facing=west]`],
    start: (c) => [tp(c.bot, S), tp(c.playerName, P, S), `give ${c.bot} raw_iron 3`, `give ${c.bot} coal 2`],
    order: 'can you smelt this raw iron into ingots',
    direct: async (ctx) => {
      await ctx.exec('openFurnace', { block: 'furnace' })
      await ctx.exec('smeltInput', { item: 'raw_iron', count: 3 })
      await ctx.exec('addFuel', { item: 'coal', count: 1 })
      for (let i = 0; i < 8 && !ctx.cancelled(); i++) {
        await sleep(11000)
        await ctx.exec('takeSmelted', {})
        if ((await ctx.itemCount(ctx.bot, 'iron_ingot')) >= 3) break
      }
    },
    evaluate: (ctx) => ctx.pollUntil(async () => {
      const n = await countBoth(ctx, 'iron_ingot')
      return { success: n >= 3, value: n }
    }, 150000),
  },
  {
    id: 'build_shelter',
    title: 'Build a small 5x5 shelter',
    world: [],
    start: (c) => [tp(c.bot, S), tp(c.playerName, P, S), `give ${c.bot} oak_planks 64`, `give ${c.bot} cobblestone 64`],
    order: 'build us a small shelter right here, like 5x5',
    direct: (ctx) => ctx.exec('shelter', { size: 5, material: 'oak_planks' }, { timeoutMs: 240000 }),
    // Success = at least two full wall rings of a 5x5 (32 blocks) placed,
    // anywhere in the arena (its world has no planks or cobble of its own).
    evaluate: (ctx) => ctx.pollUntil(async () => {
      const n = ctx.countBlocks(arenaBox(Y, Y + 6), (b) => b === 'oak_planks' || b === 'cobblestone')
      return { success: n >= 32, value: n }
    }, 240000, { settleAfterSuccessMs: 0 }),
  },
  {
    id: 'follow_40',
    title: 'Follow the player 40 blocks past obstacles',
    world: [
      // wall with a 2-wide gap, a step row, a trench, a second wall whose gap
      // is on the other side (forces a zig-zag). A pillar cluster on the
      // straight line was dropped: the scripted player's pathfinder snagged
      // on its corner and never reached the goal.
      `fill 160 ${Y} -16 160 ${Y + 1} 15 cobblestone`, `fill 160 ${Y} 6 160 ${Y + 1} 7 air`,
      `fill 168 ${Y} -16 168 ${Y} 15 cobblestone`,
      `fill 176 ${Y - 1} -16 177 ${Y - 1} 15 air`,
      `fill 184 ${Y} -16 184 ${Y + 1} 15 cobblestone`, `fill 184 ${Y} -8 184 ${Y + 1} -7 air`,
    ],
    start: (c) => [tp(c.bot, { x: 152, y: Y, z: 0 }), tp(c.playerName, { x: 150, y: Y, z: 0 }, { x: 152, y: Y, z: 0 })],
    order: 'follow me',
    direct: (ctx) => { ctx.execStart('follow', { player: ctx.playerName }) },
    evaluate: async (ctx) => {
      await sleep(ctx.mode === 'brain' ? 4000 : 2000)
      const arrived = await ctx.walkTo({ x: 192, y: Y, z: 0 }, { timeoutMs: 60000 })
      let maxD = 0
      for (let i = 0; i < 10; i++) { await sleep(1000); maxD = Math.max(maxD, ctx.distToBot()) }
      const d = ctx.distToBot()
      return { success: arrived && d <= 6, value: Number(d.toFixed(1)), detail: arrived ? `final distance ${d.toFixed(1)}` : 'player could not reach the goal' }
    },
  },
  {
    id: 'come_here',
    title: 'Come here from 30 blocks',
    world: [`fill 168 ${Y} -16 168 ${Y + 1} 15 cobblestone`, `fill 168 ${Y} 9 168 ${Y + 1} 10 air`],
    start: (c) => [tp(c.bot, { x: 184, y: Y, z: 0 }), tp(c.playerName, { x: 154, y: Y, z: 0 }, { x: 184, y: Y, z: 0 })],
    order: 'come here',
    direct: (ctx) => ctx.exec('goTo', { x: 154, y: Y, z: 0, range: 2 }, { timeoutMs: 45000 }),
    evaluate: (ctx) => ctx.pollUntil(async () => {
      const d = ctx.distToBot()
      return { success: d <= 4, value: Number(d.toFixed(1)) }
    }, 45000),
  },
  {
    id: 'zombies_night',
    title: 'Kill 3 zombies at night with a sword',
    world: [],
    start: (c) => [
      'time set 18000', tp(c.bot, S), tp(c.playerName, P, S), `give ${c.bot} iron_sword`,
      `effect give ${c.playerName} resistance 300 255 true`,
    ],
    atOrder: () => [zombie(184, -5), zombie(185, 4), zombie(183, 8)],
    order: 'kill those zombies',
    direct: (ctx) => attackUntilClear(ctx, Date.now() + 90000),
    evaluate: (ctx) => ctx.pollUntil(async () => {
      if (ctx.botDied()) return { success: false, done: true, value: -1, detail: 'companion died' }
      const z = await ctx.entityCount('@e[type=zombie]')
      return { success: z === 0, value: 3 - z }
    }, 90000),
  },
  {
    id: 'protect_player',
    title: 'Protect a low-HP player from 2 zombies',
    // A knife-edge race (zombies reach the player ~9s after the order, then
    // kill in ~3s), so it is timing-sensitive: on identical code it went 12/12
    // in two runs and 1/5 in another. Trust it only from an interleaved
    // --compare, never from two separate runs.
    volatile: true,
    world: [],
    // A burst of hunger drains the reset saturation so the player stays low
    // (food under 18 = no natural regen); the damage and zombies land at
    // order time so a brain-mode settle period does not pre-play the fight.
    start: (c) => [
      'time set 18000', tp(c.bot, S), tp(c.playerName, P, { x: 150, y: Y, z: 0 }), `give ${c.bot} iron_sword`,
      `effect give ${c.playerName} hunger 4 255 true`,
    ],
    atOrder: (c) => [`damage ${c.playerName} 10`, zombie(151, -3), zombie(150, 3)],
    order: 'help im almost dead!! zombies',
    direct: (ctx) => attackUntilClear(ctx, Date.now() + 60000),
    evaluate: (ctx) => ctx.pollUntil(async () => {
      if (ctx.playerDied()) return { success: false, done: true, value: 0, detail: 'player died' }
      const z = await ctx.entityCount('@e[type=zombie]')
      return { success: z === 0, value: 2 - z, detail: `player hp ${Math.round(ctx.playerHp())}` }
    }, 60000),
  },
  {
    id: 'stop_gather',
    title: 'Stop mid-gather',
    world: TREES_4,
    start: (c) => [tp(c.bot, S, { x: 184, y: Y, z: 0 }), tp(c.playerName, P, S)],
    order: 'get me like 20 logs',
    direct: (ctx) => { ctx.stopHandle = ctx.execStart('gather', { name: 'oak_log', count: 20 }) },
    // Wait for the first log to break, say stop, then no log may break from
    // 3s after the stop to 20s after it.
    evaluate: async (ctx) => {
      const logs = () => ctx.countBlocks(TREE_BOX, isLog)
      const n0 = logs()
      const t0 = Date.now()
      while (logs() >= n0 && Date.now() - t0 < 45000) await sleep(250)
      if (logs() >= n0) return { success: false, value: null, detail: 'never started gathering', invalid: true }
      if (ctx.mode === 'brain') ctx.say('stop')
      else if (ctx.stopHandle) ctx.abort(ctx.stopHandle.id)
      const tStop = Date.now()
      let last = logs(), lastBreak = tStop, atGrace = null
      while (Date.now() - tStop < 20000) {
        await sleep(250)
        const n = logs()
        if (n < last) { last = n; lastBreak = Date.now() }
        if (atGrace == null && Date.now() - tStop >= 3000) atGrace = n
      }
      const after = atGrace - last
      return { success: after === 0, value: Number(((lastBreak - tStop) / 1000).toFixed(1)), detail: after === 0 ? 'stopped' : `${after} more logs broken after stop` }
    },
  },
  {
    id: 'pickup_items',
    title: 'Pick up dropped items',
    world: [],
    start: (c) => [tp(c.bot, S), tp(c.playerName, P, S)],
    atOrder: () => [item(182, -4, 'iron_ingot', 5), item(183, 3, 'bread', 3), item(185, 0, 'oak_log', 4)],
    order: 'grab the stuff on the ground over there',
    direct: async (ctx) => {
      for (let i = 0; i < 3 && !ctx.cancelled(); i++) {
        await ctx.exec('pickup', {}, { timeoutMs: 30000 })
        if ((await ctx.itemCount(ctx.bot, 'iron_ingot')) >= 5 && (await ctx.itemCount(ctx.bot, 'bread')) >= 3 && (await ctx.itemCount(ctx.bot, 'oak_log')) >= 4) break
      }
    },
    evaluate: (ctx) => ctx.pollUntil(async () => {
      const got = [(await ctx.itemCount(ctx.bot, 'iron_ingot')) >= 5, (await ctx.itemCount(ctx.bot, 'bread')) >= 3, (await ctx.itemCount(ctx.bot, 'oak_log')) >= 4]
      return { success: got.every(Boolean), value: got.filter(Boolean).length }
    }, 60000),
  },
]

// The --quick subset: fast benchmarks, including the borderline protect fight
// and stop (the ones fixes have moved); skips the long timeouts (mine, build).
export const QUICK_MICRO = ['gather_logs', 'craft_tools', 'come_here', 'zombies_night', 'protect_player', 'stop_gather']
