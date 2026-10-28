// src/behaviors/place.js — place a block against a reference face (D-22)
import { Vec3 } from 'vec3'
import { resolveBlock, isStaleHandle } from '../observers/targeting.js'
import { reason } from '../../../brain/errStrings.js'
import { liveCount, hasLiveInventory, waitInventoryQuiet } from '../observers/liveInventory.js'
import { recordOwnStation } from '../observers/ownStations.js'

export const DEFAULT_TIMEOUT_MS = 4000

const AIR = new Set(['air', 'cave_air', 'void_air'])

// 6 neighbour offsets in placement priority: floor first, then horizontals,
// then ceiling. First non-air neighbour of the target cell is the face we
// place against. (Same order build.js uses — inlined here to avoid a circular
// import, since build.js already imports placeBlockAction.)
const FACE_PRIORITY = [
  { off: [0, -1, 0], face: [0, 1, 0] },
  { off: [0, 0, -1], face: [0, 0, 1] },
  { off: [0, 0, 1], face: [0, 0, -1] },
  { off: [1, 0, 0], face: [-1, 0, 0] },
  { off: [-1, 0, 0], face: [1, 0, 0] },
  { off: [0, 1, 0], face: [0, -1, 0] },
]

function isAir(name) { return AIR.has(name) }

// For an (assumed empty) cell, find an adjacent solid block to place against.
function refFaceForCell(bot, c) {
  for (const { off, face } of FACE_PRIORITY) {
    const refBlk = bot.blockAt(new Vec3(c.x + off[0], c.y + off[1], c.z + off[2]))
    if (refBlk && !isAir(refBlk.name)) return { refBlk, face: new Vec3(face[0], face[1], face[2]) }
  }
  return null
}

// 260618: auto-pick an open cell beside the bot that a block can actually be
// placed in (empty, with a solid neighbour to place against). This is what
// "place a crafting_table" usually means, and it works underground / on uneven
// ground where the model's chosen reference face is buried in stone — the exact
// failure that made placeBlock time out five times in a row before the model
// stumbled onto build(). Feet ring first, then head ring.
function autoPlacementNearBot(bot) {
  const p = bot.entity?.position
  if (!p) return null
  const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z)
  const ring = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
  for (const dy of [0, 1]) {
    for (const [dx, , dz] of ring) {
      const c = { x: fx + dx, y: fy + dy, z: fz + dz }
      const cell = bot.blockAt(new Vec3(c.x, c.y, c.z))
      if (cell && !isAir(cell.name)) continue // cell occupied — can't place here
      const rf = refFaceForCell(bot, c)
      if (rf) return rf
    }
  }
  return null
}

// 261012 (quality pass 5): placeBlock resolving is not proof the block is
// there. The eval had "placed crafting_table on barrier" with the table still
// in her bag, and she walked off to use a table that did not exist. After the
// server has had its say, the target cell must hold a block and the item must
// have left the bag (or the block must be the item itself).
const EMPTY_AFTER_PLACE = new Set([...AIR, 'water', 'lava'])
const PLACE_SETTLE = { quietMs: 250, minMs: 300, maxMs: 1200 }

async function verifyPlaced(bot, dest, itemName, before, oldName, refLoc, signal) {
  if (!dest || !hasLiveInventory(bot) || typeof bot.blockAt !== 'function') return `placed ${itemName} on ${refLoc}`
  if (await waitInventoryQuiet(bot, { ...PLACE_SETTLE, signal }) === 'aborted') return 'aborted'
  let blk = null
  try { blk = bot.blockAt(dest) } catch { blk = null }
  const after = liveCount(bot, itemName)
  const empty = !blk || EMPTY_AFTER_PLACE.has(blk.name)
  // 261013: a block named unlike its item (torch -> wall_torch, oak_sign ->
  // oak_wall_sign) that replaced what was there is placed, even when the
  // count did not drop (creative, or a slot update still on its way).
  if (empty || (blk.name !== itemName && after >= before && blk.name === oldName)) {
    const there = empty ? 'the spot is still empty' : `the spot holds ${blk.name}`
    return `placing ${itemName} on ${refLoc} did not go through: ${there} and the ${itemName} is still in your inventory`
  }
  return `placed ${itemName} on ${refLoc}`
}

function tryPlace(bot, refBlock, faceVector, itemName, timeoutMs, signal) {
  const rp = refBlock.position
  const refLoc = rp ? `${refBlock.name ?? 'block'} @${rp.x},${rp.y},${rp.z}` : (refBlock.name ?? 'block')
  const dest = rp && faceVector ? new Vec3(rp.x + faceVector.x, rp.y + faceVector.y, rp.z + faceVector.z) : null
  const before = liveCount(bot, itemName)
  let oldName = null
  try { oldName = dest && typeof bot.blockAt === 'function' ? (bot.blockAt(dest)?.name ?? null) : null } catch { oldName = null }
  const op = bot.placeBlock(refBlock, faceVector)
    .then(() => verifyPlaced(bot, dest, itemName, before, oldName, refLoc, signal))
    .then((r) => {
      // 261017 (pass 14b): a station she put down is hers for the progression spine.
      if (dest && typeof r === 'string' && r.startsWith('placed ')) recordOwnStation(bot, itemName, dest)
      return r
    })
    .catch((err) => {
      const r = reason(err)
      return r ? `cannot place ${itemName} on ${refLoc}: ${r}` : `cannot place ${itemName} on ${refLoc}`
    })
  const tmo = new Promise((r) => setTimeout(() => r(`timeout placing ${itemName} on ${refLoc}`), timeoutMs))
  const abrt = new Promise((r) => {
    if (!signal) return
    signal.addEventListener('abort', () => r('aborted'), { once: true })
  })
  return Promise.race([op, tmo, abrt])
}

const placed = (r) => r === 'aborted' || (typeof r === 'string' && r.startsWith('placed '))

export async function placeBlockAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const itemName = args.block
  let invItem = bot.inventory.items().find((i) => i.name === itemName)
  if (!invItem && hasLiveInventory(bot)) {
    // 261012: an item crafted or picked up a moment ago may still be landing.
    if (await waitInventoryQuiet(bot, { quietMs: 250, maxMs: 1000, signal }) === 'aborted') return 'aborted'
    invItem = bot.inventory.items().find((i) => i.name === itemName)
  }
  if (!invItem) return `no ${itemName} in inventory`

  try {
    await bot.equip(invItem, 'hand')
  } catch (err) {
    const r = reason(err)
    return r ? `cannot hold ${itemName} to place: ${r}` : `cannot hold ${itemName} to place`
  }

  const timeoutMs = args.timeout_ms ?? config?.place_timeout_ms ?? DEFAULT_TIMEOUT_MS
  // build (and any caller naming an exact face) owns its geometry: one strict
  // attempt against the cell it chose, no near-bot fallback.
  const hasExplicitFace = !!args.faceVector
  const referenceBlock = await resolveBlock(args.against ?? {}, bot)

  if (hasExplicitFace) {
    if (!referenceBlock) return isStaleHandle(args.against ?? {}) ? 'stale reference block' : 'no reference block'
    const fv = args.faceVector
    return tryPlace(bot, referenceBlock, new Vec3(fv.x, fv.y, fv.z), itemName, timeoutMs, signal)
  }

  // Model path ("place X near me"): try the chosen reference first (default to
  // the top face), then fall back to any open cell beside the bot.
  if (referenceBlock) {
    const r = await tryPlace(bot, referenceBlock, new Vec3(0, 1, 0), itemName, timeoutMs, signal)
    if (placed(r)) return r
  }
  if (signal?.aborted) return 'aborted'
  const auto = autoPlacementNearBot(bot)
  if (auto) {
    const r = await tryPlace(bot, auto.refBlk, auto.face, itemName, timeoutMs, signal)
    if (placed(r)) return r
  }
  return `couldn't place ${itemName} — no open spot in reach. Step somewhere more open, or use build({from:{x,y:<your y>,z}, to:{x,y,z}, block:"${itemName}"}) on a spot beside you.`
}
