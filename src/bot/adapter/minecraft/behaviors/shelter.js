// src/behaviors/shelter.js — thin shelter convenience (MCRAFT-06, D-09).
//
// NOT a new world primitive: a shelter is a COMPOSITION of the existing
// build()/dig() cuboid actions — four hollow walls + a solid roof layer, with a
// one-block-wide, two-tall doorway carved out of the front wall. Keeping it a
// composition preserves the closed-registry invariant (no new place/dig path)
// and the 256-cell guarantee (ShelterSchema caps size to 5 → ≤48 wall + 25 roof
// cells, well under the cap that buildAction's own schema enforces).
import { Vec3 } from 'vec3'
import { buildAction, enumerateBuildCells, isOccupied, bodyInCell } from './build.js'
import { digAction } from './dig.js'

const WALL_HEIGHT = 3 // wall layers (y range height); roof sits one above.

// 261012: cheap full blocks the shelter may switch to when the asked material
// runs short (the quality eval gave her 64 planks + 64 cobblestone, and a 5x5
// needs 73: the walls went up in planks and the roof was refused).
const FILLER = /^(cobblestone|cobbled_deepslate|stone|dirt|coarse_dirt|netherrack|blackstone|andesite|diorite|granite|tuff|deepslate|sandstone|red_sandstone|bricks|stone_bricks|mud_bricks|[a-z_]+_planks)$/

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 261019 (pass 19): how long a player standing where a wall goes gets to
// step away before the shelter gives up and says so.
export const BODY_WAIT_MS = 4000
const BODY_POLL_MS = 250
// Her hitbox is 0.6 wide, so within 0.2 of the middle of her block (on each
// axis) she overlaps no neighbor cell. 0.15 from the middle is inside that.
const CENTER_TOL = 0.15
const CENTER_BUDGET_MS = 1500

function invCount(bot, name) {
  try { return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0) } catch { return 0 }
}

function solidAt(bot, x, y, z) {
  const b = bot.blockAt?.(new Vec3(x, y, z))
  if (!b) return null // unloaded: unknown
  return b.boundingBox === 'block' && !/^(air|cave_air|void_air)$/.test(b.name)
}

/**
 * 261012. The layer the walls start on: the first air layer on top of solid
 * ground at the center column, searched a few blocks either way from `y0`.
 * The old base was floor(bot.y) + 1, one layer ABOVE the ground the bot
 * stands on, so every wall cell floated with nothing under or beside it and
 * all 48 cells of a 5x5 failed (quality eval build_shelter: 0 placed in every
 * direct trial). A `center` the model passes may be its feet (pos: y) or the
 * ground block under them; both land on the same layer here.
 */
export function shelterBaseY(bot, cx, y0, cz) {
  let y = y0
  for (let i = 0; i < 3 && solidAt(bot, cx, y, cz) === true; i++) y++
  for (let i = 0; i < 4 && solidAt(bot, cx, y - 1, cz) === false; i++) y--
  return y
}

/** Air cells a span still needs. */
function cellsNeeded(bot, from, to, hollow) {
  return enumerateBuildCells(from, to, hollow).reduce((n, c) => n + (isOccupied(bot, c) ? 0 : 1), 0)
}

/**
 * 261019 (pass 19). The kinds of block she can build a shelter part with, in
 * the order to use them: the asked material first, then the filler she has
 * most of. [{name, n}], only kinds she has.
 */
export function buildingKinds(bot, material) {
  const seen = new Map()
  let items = []
  try { items = bot.inventory.items() } catch {}
  for (const it of items) {
    if (it.name !== material && !FILLER.test(it.name)) continue
    seen.set(it.name, (seen.get(it.name) ?? 0) + it.count)
  }
  const kinds = [...seen].map(([name, n]) => ({ name, n }))
  kinds.sort((a, b) => (a.name === material ? -1 : b.name === material ? 1 : b.n - a.n))
  return kinds
}

/** "20 oak_planks, 6 dirt" */
function kindsText(kinds) {
  return kinds.map(k => `${k.n} ${k.name}`).join(', ')
}

/**
 * Build one part (walls or roof), switching kind when one runs out. Returns
 * the last build result and the kinds used. Stops at the first result that is
 * neither finished nor a run-out (a real failure, or an abort).
 */
async function buildPart(bot, config, span, material, hollow) {
  const used = []
  let res = null
  for (const k of buildingKinds(bot, material)) {
    if (invCount(bot, k.name) === 0) continue
    res = await buildAction({ ...span, block: k.name, hollow }, bot, config, { partial: true })
    if (!(typeof res === 'string' && /^no \S+ in inventory$/.test(res))) used.push(k.name)
    if (isAborted(res) || buildComplete(res)) break
    if (!(typeof res === 'string' && /then ran out of /.test(res))) break
  }
  return { res: res ?? `no ${material} in inventory`, used }
}

/** Players standing in the bottom ring of the walls: [{who, at}]. */
function playersInRing(bot, minX, maxX, minZ, maxZ, y) {
  const out = []
  for (const c of enumerateBuildCells({ x: minX, y, z: minZ }, { x: maxX, y, z: maxZ }, true)) {
    const who = bodyInCell(bot, c)
    if (who && who !== 'you' && isPlayerName(bot, who)) out.push({ who, at: c })
  }
  return out
}

function isPlayerName(bot, name) {
  return Object.values(bot.entities ?? {}).some(e => e?.username === name)
}

/**
 * She stands in the middle cell but her hitbox pokes into a wall cell (she
 * stood near the edge of her block), so that wall block could not go down.
 * Sneak to the middle of her block first.
 */
async function stepToMiddle(bot, cx, cz, signal) {
  const tx = cx + 0.5, tz = cz + 0.5
  const off = () => {
    const p = bot.entity?.position
    return p ? Math.hypot(p.x - tx, p.z - tz) : 0
  }
  if (off() <= CENTER_TOL || typeof bot.setControlState !== 'function') return
  try { bot.pathfinder?.stop?.() } catch {}
  const end = Date.now() + CENTER_BUDGET_MS
  try {
    bot.setControlState('sneak', true)
    while (off() > CENTER_TOL && Date.now() < end && !signal?.aborted) {
      const p = bot.entity.position
      try { await bot.lookAt?.(new Vec3(tx, p.y + 1.62, tz), true) } catch {}
      bot.setControlState('forward', true)
      await sleep(50)
    }
  } finally {
    try { bot.setControlState('forward', false) } catch {}
    try { bot.setControlState('sneak', false) } catch {}
  }
}

export async function shelterAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const size = args?.size ?? 3
  const material = args?.material ?? 'cobblestone'

  // Default center = the bot's current position.
  const p = bot.entity?.position ?? { x: 0, y: 64, z: 0 }
  const cx = args?.center ? Math.round(args.center.x) : Math.floor(p.x)
  const cz = args?.center ? Math.round(args.center.z) : Math.floor(p.z)
  const y0 = args?.center ? Math.floor(args.center.y) : Math.floor(p.y)
  const baseY = shelterBaseY(bot, cx, y0, cz)

  const half = Math.floor((size - 1) / 2)
  const minX = cx - half
  const maxX = minX + size - 1
  const minZ = cz - half
  const maxZ = minZ + size - 1
  const topY = baseY + WALL_HEIGHT - 1 // highest wall layer
  const roofY = topY + 1

  const wallFrom = { x: minX, y: baseY, z: minZ }, wallTo = { x: maxX, y: topY, z: maxZ }
  const roofFrom = { x: minX, y: roofY, z: minZ }, roofTo = { x: maxX, y: roofY, z: maxZ }
  const notes = []

  // 1. Enough blocks for the whole shelter? 261019 (pass 19): the walls used
  // to need enough of ONE kind, so 20 planks and 30 dirt came back "1 short"
  // and she retried the same call, or crafted the planks away. Now any full
  // building block she carries counts, walls and roof together, and the
  // shortfall is said before any walking or placing.
  const wallNeed = cellsNeeded(bot, wallFrom, wallTo, true)
  const roofNeed = cellsNeeded(bot, roofFrom, roofTo, false)
  const kinds = buildingKinds(bot, material)
  const have = kinds.reduce((n, k) => n + k.n, 0)
  if (have < wallNeed + roofNeed) {
    const short = wallNeed + roofNeed - have
    const smaller = size > 3
      ? `, or ask for a smaller shelter (size ${size - 1} or 3)`
      : ' (3x3 is the smallest shelter, so it will not fit in fewer blocks)'
    const what = kinds.length ? `${have} building blocks (${kindsText(kinds)})` : 'no building blocks'
    return `no shelter built: it needs ${wallNeed + roofNeed} full blocks (${wallNeed} for the walls, ${roofNeed} for the roof) and you have ${what}, ${short} short. Any mix of full blocks works (dirt, cobblestone, planks, stone). Gather at least ${short} more (or ask the player for some) before trying again${smaller}.`
  }

  // 2. Nobody in the way. A block cannot go where a body is: she stood near
  // the edge of her block, or the player stood next to her where the wall
  // goes (combat_night eval: the same 3x3 shelter failed three times with
  // the player in a wall cell).
  if (!args?.center) await stepToMiddle(bot, cx, cz, signal)
  if (signal?.aborted) return 'aborted'
  let inRing = playersInRing(bot, minX, maxX, minZ, maxZ, baseY)
  const waitEnd = Date.now() + BODY_WAIT_MS
  while (inRing.length && Date.now() < waitEnd) {
    await sleep(BODY_POLL_MS)
    if (signal?.aborted) return 'aborted'
    inRing = playersInRing(bot, minX, maxX, minZ, maxZ, baseY)
  }
  if (inRing.length) {
    const { who, at } = inRing[0]
    const where = `${at.x},${at.y},${at.z}`
    if (size === 3) {
      const h5 = 2, y5 = baseY
      const need5 = cellsNeeded(bot, { x: cx - h5, y: y5, z: cz - h5 }, { x: cx + h5, y: topY, z: cz + h5 }, true) +
        cellsNeeded(bot, { x: cx - h5, y: roofY, z: cz - h5 }, { x: cx + h5, y: roofY, z: cz + h5 }, false)
      return `no shelter built yet: ${who} is standing where a wall goes (${where}), and a block cannot go where someone stands. A 3x3 shelter only has room inside for you. Ask ${who} to step a few blocks away and build it again, or build size 5 so you both fit inside (that needs ${need5} blocks, you have ${have}).`
    }
    return `no shelter built yet: ${who} is standing where a wall goes (${where}), and a block cannot go where someone stands. Ask ${who} to step into the middle with you or a few blocks away, then build it again.`
  }

  // 3. Four hollow walls across the full height range, then a solid roof.
  const walls = await buildPart(bot, config, { from: wallFrom, to: wallTo }, material, true)
  const wallsRes = walls.res
  if (isAborted(wallsRes)) return abortedAt('walls', wallsRes)
  // 261011: a shelter with no walls is not a shelter. The result used to read
  // "built shelter 3x3x3 with a doorway (walls: no cobblestone in inventory...)"
  // and the model told the player they were safe inside.
  if (!placedSome(wallsRes)) return `no shelter built: walls: ${wallsRes}`
  if (walls.used.some(k => k !== material)) notes.push(`walls in ${walls.used.join(' and ')}`)

  const roof = await buildPart(bot, config, { from: roofFrom, to: roofTo }, material, false)
  const roofRes = roof.res
  if (isAborted(roofRes)) return abortedAt('roof', roofRes, wallsRes)
  if (roof.used.some(k => k !== material)) notes.push(`roof in ${roof.used.join(' and ')}`)

  // 4. Carve a one-block-wide, two-tall doorway out of the front (min-Z) wall,
  //    centered on the footprint, so the bot can walk in and out.
  const doorX = cx
  const doorRes = await digAction(
    { x: doorX, y: baseY, z: minZ, to: { x: doorX, y: baseY + 1, z: minZ } },
    bot,
    config,
  )
  if (doorRes === 'aborted') return 'aborted'

  const done = buildComplete(wallsRes) && buildComplete(roofRes)
  const detail = `(walls: ${wallsRes}; roof: ${roofRes}; doorway: ${doorRes}${notes.length ? `; ${notes.join('; ')}` : ''})`
  if (!done) return `shelter UNFINISHED, it has gaps and is not safe yet ${detail}`
  return `built shelter ${size}x${size}x${WALL_HEIGHT} with a doorway at ${doorX},${baseY},${minZ} ${detail}`
}

/** buildAction stopped by an abort ('aborted' or 'aborted after ...'). */
function isAborted(r) {
  return typeof r === 'string' && r.startsWith('aborted')
}

// 261012: an interrupted build used to fall through to "no shelter built:
// walls: aborted after 32 placed of 48 cells", which reads as a failure to
// build rather than a stop partway.
function abortedAt(part, res, wallsRes) {
  const done = wallsRes ? `; walls: ${wallsRes}` : ''
  return `shelter stopped partway while building the ${part}, it is not finished (${part}: ${res}${done})`
}

/** buildAction placed at least one block, or the span was already all there. */
function placedSome(r) {
  return /^built [1-9]\d* /.test(r) || buildComplete(r)
}

/** buildAction finished the whole span (every cell placed or already solid). */
function buildComplete(r) {
  return /^built \d+ placed, \d+ skipped \(already solid\), of \d+ cells$/.test(r)
}
