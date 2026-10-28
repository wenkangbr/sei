// shelter() convenience (MCRAFT-06) — composes build() (hollow walls + roof)
// and dig() (doorway) into a correct enclosed structure. The mocks let us
// assert the COMPOSITION shape (which cuboids, hollow vs solid, doorway carved)
// without standing up a real mineflayer world.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./build.js', async (importOriginal) => ({
  ...(await importOriginal()),
  buildAction: vi.fn(async () => 'built 16 placed, 0 skipped (already solid), of 16 cells'),
}))
vi.mock('./dig.js', () => ({
  digAction: vi.fn(async () => 'dug 2/2'),
}))

import { shelterAction, shelterBaseY } from './shelter.js'
import { buildAction } from './build.js'
import { digAction } from './dig.js'

// Flat ground: solid grass at y=63 and below, air from y=64 up. The bot
// stands ON the grass, so its feet (position.y) are at 64.
function makeBot({ groundY = 63, inv = [{ name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }], extra = {} } = {}) {
  return {
    version: '1.21.1',
    entity: { position: { x: 0.4, y: groundY + 1, z: 0.6 } },
    inventory: { items: () => inv },
    blockAt(p) {
      const key = `${p.x},${p.y},${p.z}`
      if (extra[key]) return { name: extra[key], boundingBox: 'block', position: p }
      return p.y <= groundY ? { name: 'grass_block', boundingBox: 'block', position: p } : { name: 'air', boundingBox: 'empty', position: p }
    },
  }
}

beforeEach(() => { vi.clearAllMocks() })

describe('shelterAction', () => {
  it('builds hollow walls + a roof layer and carves a doorway', async () => {
    const res = await shelterAction({ size: 5, material: 'cobblestone' }, makeBot(), {})

    // Walls: a hollow:true cuboid of the requested material.
    const wallsCall = buildAction.mock.calls.find((c) => c[0].hollow === true)
    expect(wallsCall).toBeTruthy()
    expect(wallsCall[0].block).toBe('cobblestone')

    // Roof: a single-Y solid cuboid (from.y === to.y, not hollow) above the walls.
    const roofCall = buildAction.mock.calls.find((c) => c[0].from.y === c[0].to.y && !c[0].hollow)
    expect(roofCall).toBeTruthy()
    expect(roofCall[0].from.y).toBeGreaterThan(wallsCall[0].from.y)

    // Doorway carved open: one dig cuboid, two cells tall (head + feet).
    expect(digAction).toHaveBeenCalledTimes(1)
    const doorArgs = digAction.mock.calls[0][0]
    expect(doorArgs.to).toBeTruthy()
    expect(Math.abs(doorArgs.to.y - doorArgs.y)).toBe(1)

    expect(res).toMatch(/doorway/i)
  })

  // 261012 (quality eval build_shelter, direct 0/3): the base used to be
  // floor(bot.y) + 1, one layer ABOVE the ground. Every wall cell floated
  // with nothing under or beside it, and all 48 cells of a 5x5 failed.
  it('starts the walls on the ground layer the bot is standing in', async () => {
    await shelterAction({ size: 3 }, makeBot(), {})
    const wallsCall = buildAction.mock.calls.find((c) => c[0].hollow === true)
    // Ground is y=63, the bot's feet are at 64 → the walls start at 64.
    expect(wallsCall[0].from.y).toBe(64)
    expect(wallsCall[0].to.y).toBe(66)
    const roofCall = buildAction.mock.calls.find((c) => !c[0].hollow)
    expect(roofCall[0].from.y).toBe(67)
    // The doorway is cut at ground level too, so it can be walked through.
    expect(digAction.mock.calls[0][0].y).toBe(64)
  })

  it('centers the footprint on the cell the bot stands in', async () => {
    await shelterAction({ size: 5 }, makeBot(), {})
    const w = buildAction.mock.calls.find((c) => c[0].hollow === true)[0]
    // bot x 0.4 → cell 0, z 0.6 → cell 0; a 5-wide footprint is -2..2.
    expect([w.from.x, w.to.x, w.from.z, w.to.z]).toEqual([-2, 2, -2, 2])
  })

  it('lands a model-given center on the ground whether it names the feet or the ground block', async () => {
    const bot = makeBot()
    expect(shelterBaseY(bot, 5, 64, 5)).toBe(64) // feet level (the pos: y)
    expect(shelterBaseY(bot, 5, 63, 5)).toBe(64) // the ground block itself
    expect(shelterBaseY(bot, 5, 66, 5)).toBe(64) // a couple of blocks up in the air
  })

  it('leaves the base alone when the column is not loaded', async () => {
    const bot = { blockAt: () => null }
    expect(shelterBaseY(bot, 0, 70, 0)).toBe(70)
  })

  it('switches the roof to another building block when the material runs short (261012)', async () => {
    // A 5x5 needs 48 wall cells + 25 roof cells = 73, more than 64 planks.
    // The walls use the planks; the roof uses the last 16 and then the
    // cobblestone she also carries.
    let planks = 64
    const inv = [{ name: 'oak_planks', get count() { return planks } }, { name: 'cobblestone', count: 64 }]
    buildAction
      .mockImplementationOnce(async () => { planks -= 48; return 'built 48 placed, 0 skipped (already solid), of 48 cells' })
      .mockImplementationOnce(async () => { planks = 0; return 'built 16 of ~25 needed, then ran out of oak_planks. Get more oak_planks (gather it, or ask the player for it) before finishing this build.' })
      .mockImplementationOnce(async () => 'built 9 placed, 16 skipped (already solid), of 25 cells')
    const res = await shelterAction({ size: 5, material: 'oak_planks' }, makeBot({ inv }), {})
    expect(buildAction.mock.calls.map((c) => c[0].block)).toEqual(['oak_planks', 'oak_planks', 'cobblestone'])
    expect(buildAction.mock.calls.every((c) => c[3]?.partial === true)).toBe(true)
    expect(res).toMatch(/^built shelter 5x5x3/)
    expect(res).toContain('roof in oak_planks and cobblestone')
  })

  // 261019 (pass 19, combat_night eval): 20 planks and plenty of dirt came
  // back "the walls need 21 blocks of one kind ... 1 short", and she retried
  // or crafted the planks away. Any mix of full blocks builds it now.
  it('builds the walls from two kinds when neither covers them alone', async () => {
    let planks = 20
    const inv = [{ name: 'oak_planks', get count() { return planks } }, { name: 'dirt', count: 30 }]
    buildAction
      .mockImplementationOnce(async () => { planks = 0; return 'built 20 of ~24 needed, then ran out of oak_planks. Get more oak_planks (gather it, or ask the player for it) before finishing this build.' })
      .mockImplementationOnce(async () => 'built 4 placed, 20 skipped (already solid), of 24 cells')
      .mockImplementationOnce(async () => 'built 9 placed, 0 skipped (already solid), of 9 cells')
    const res = await shelterAction({ size: 3, material: 'oak_planks' }, makeBot({ inv }), {})
    expect(buildAction.mock.calls.map((c) => [c[0].block, c[0].hollow])).toEqual([['oak_planks', true], ['dirt', true], ['dirt', false]])
    expect(res).toMatch(/^built shelter 3x3x3/)
    expect(res).toContain('walls in oak_planks and dirt')
  })

  // 261019 (pass 19): the shortfall is reported up front, for the whole
  // shelter, without walking or placing anything.
  it('reports the exact shortfall for the whole shelter when the blocks do not cover it', async () => {
    const inv = [{ name: 'oak_planks', count: 10 }, { name: 'dirt', count: 5 }, { name: 'diamond_block', count: 64 }]
    const r = await shelterAction({ size: 3, material: 'oak_planks' }, makeBot({ inv }), {})
    expect(buildAction).not.toHaveBeenCalled()
    // 3x3: 24 wall cells + 9 roof cells.
    expect(r).toMatch(/^no shelter built: it needs 33 full blocks \(24 for the walls, 9 for the roof\) and you have 15 building blocks \(10 oak_planks, 5 dirt\), 18 short\./)
    expect(r).toContain('Gather at least 18 more')
    expect(r).toContain('3x3 is the smallest shelter')
    expect(r).not.toContain('smaller span')
    expect(r).not.toContain('\u2014')
  })

  it('a bigger shelter that does not fit suggests a smaller size', async () => {
    const inv = [{ name: 'cobblestone', count: 5 }]
    const r = await shelterAction({ size: 5 }, makeBot({ inv }), {})
    expect(r).toContain('ask for a smaller shelter (size 4 or 3)')
  })

  it('defaults material to cobblestone and size to 3', async () => {
    await shelterAction({}, makeBot(), {})
    const wallsCall = buildAction.mock.calls.find((c) => c[0].hollow === true)
    expect(wallsCall[0].block).toBe('cobblestone')
    const span = Math.abs(wallsCall[0].to.x - wallsCall[0].from.x) + 1
    expect(span).toBe(3)
  })

  it('returns "aborted" without building when the signal is already aborted', async () => {
    const c = new AbortController()
    c.abort()
    const res = await shelterAction({}, makeBot(), { signal: c.signal })
    expect(res).toBe('aborted')
    expect(buildAction).not.toHaveBeenCalled()
    expect(digAction).not.toHaveBeenCalled()
  })

  it('does not claim a shelter when no wall went up (261011)', async () => {
    buildAction.mockResolvedValueOnce('no cobblestone in inventory')
    const res = await shelterAction({}, makeBot(), {})
    expect(res).toBe('no shelter built: walls: no cobblestone in inventory')
    expect(buildAction).toHaveBeenCalledTimes(1)
    expect(digAction).not.toHaveBeenCalled()
  })

  it('says UNFINISHED when the walls or roof ran out (261011)', async () => {
    buildAction
      .mockResolvedValueOnce('built 10 of ~24 needed, then ran out of cobblestone. Get more cobblestone (gather it, or ask the player for it) before finishing this build.')
      .mockResolvedValueOnce('no cobblestone in inventory')
    const res = await shelterAction({}, makeBot(), {})
    expect(res).toMatch(/^shelter UNFINISHED, it has gaps and is not safe yet/)
  })

  it('reports a finished shelter as built', async () => {
    const res = await shelterAction({}, makeBot(), {})
    expect(res).toMatch(/^built shelter 3x3x3 with a doorway/)
  })
})

describe('shelterAction — interrupted (261012)', () => {
  it('says it stopped partway instead of "no shelter built"', async () => {
    buildAction.mockResolvedValueOnce('aborted after 32 placed of 48 cells')
    const res = await shelterAction({ size: 5 }, makeBot(), {})
    expect(res).toBe('shelter stopped partway while building the walls, it is not finished (walls: aborted after 32 placed of 48 cells)')
    expect(digAction).not.toHaveBeenCalled()
  })
})

describe('shelterAction: bodies in the way (261019)', () => {
  function withPlayer(bot, pos) {
    const alex = { id: 7, type: 'player', username: 'Alex', position: { ...pos } }
    bot.entities = { 7: alex }
    return alex
  }

  it('waits for a player in a wall cell to step away, then builds', async () => {
    vi.useFakeTimers()
    try {
      const bot = makeBot()
      const alex = withPlayer(bot, { x: 1.5, y: 64, z: 0.5 })
      const p = shelterAction({ size: 3 }, bot, {})
      await vi.advanceTimersByTimeAsync(1000)
      expect(buildAction).not.toHaveBeenCalled()
      alex.position = { x: 5.5, y: 64, z: 0.5 }
      await vi.advanceTimersByTimeAsync(500)
      const res = await p
      expect(buildAction).toHaveBeenCalled()
      expect(res).toMatch(/^built shelter/)
    } finally { vi.useRealTimers() }
  })

  it('names the player and the way out when they stay in the ring', async () => {
    vi.useFakeTimers()
    try {
      const bot = makeBot()
      withPlayer(bot, { x: 1.5, y: 64, z: 0.5 })
      const p = shelterAction({ size: 3 }, bot, {})
      await vi.advanceTimersByTimeAsync(5000)
      const res = await p
      expect(buildAction).not.toHaveBeenCalled()
      expect(res).toMatch(/^no shelter built yet: Alex is standing where a wall goes \(1,64,0\)/)
      expect(res).toContain('build size 5 so you both fit inside (that needs 73 blocks, you have 128)')
      expect(res).not.toContain('\u2014')
    } finally { vi.useRealTimers() }
  })

  it('a player inside a 5x5 is not in the way', async () => {
    const bot = makeBot()
    withPlayer(bot, { x: 1.5, y: 64, z: 0.5 })
    const res = await shelterAction({ size: 5 }, bot, {})
    expect(res).toMatch(/^built shelter 5x5x3/)
  })

  it('steps to the middle of her block when she stands near its edge', async () => {
    const bot = makeBot()
    bot.entity.position = { x: 0.05, y: 64, z: 0.5 }
    let target = null
    const controls = {}
    bot.lookAt = vi.fn(async (t) => { target = t })
    bot.setControlState = vi.fn((k, v) => {
      controls[k] = v
      if (k === 'forward' && v && target) {
        const p = bot.entity.position
        const dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz)
        const step = Math.min(0.06, d)
        bot.entity.position = { ...p, x: p.x + (dx / d) * step, z: p.z + (dz / d) * step }
      }
    })
    const res = await shelterAction({ size: 3 }, bot, {})
    const p = bot.entity.position
    expect(Math.hypot(p.x - 0.5, p.z - 0.5)).toBeLessThanOrEqual(0.15)
    expect(controls.forward).toBe(false)
    expect(controls.sneak).toBe(false)
    expect(res).toMatch(/^built shelter/)
  })
})
