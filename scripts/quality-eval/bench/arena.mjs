// scripts/quality-eval/bench/arena.mjs: the fixed test arena the benchmarks
// play in. A flat 64x32 grass plateau at y=70 (8 layers of stone under it,
// barrier walls around it) built by console commands next to world spawn, so
// every trial starts from exactly the same blocks, whatever the seed's
// terrain does. reset() rebuilds it in under a second without a restart.
//
// Coordinates: x 144..207, z -16..15, floor y=70, standing y=71.
// S is the companion's start, P the player's start (4 blocks west of S).
export const A = { x0: 144, x1: 207, z0: -16, z1: 15, floor: 70 }
export const Y = A.floor + 1
export const S = { x: 176, y: Y, z: 0 }
export const P = { x: 172, y: Y, z: 0 }

/**
 * A countBlocks box over the WHOLE arena (plus the barrier ring, so a block
 * set on top of the wall still counts) between two heights. Use it for "did
 * the companion place X" checks instead of a radius around S: the bot walks
 * during its opening gather and legitimately places things well away from its
 * start (261013: a crafting table at z=15 failed a ±10 box). Only safe for a
 * block the bench world does not already contain.
 */
export function arenaBox(y0, y1) {
  return { x0: A.x0 - 1, x1: A.x1 + 1, y0, y1, z0: A.z0 - 1, z1: A.z1 + 1 }
}

export const WORLD_RULES = [
  'gamerule advance_time false',
  'gamerule advance_weather false',
  'weather clear',
  // No natural mobs: every mob in a trial is one the benchmark summoned.
  'gamerule spawn_monsters false',
  'gamerule spawn_mobs false',
  'gamerule spawn_phantoms false',
  'gamerule mob_griefing false',
  'gamerule immediate_respawn true',
  'gamerule respawn_radius 0',
  `setworldspawn ${S.x} ${Y} ${S.z}`,
  'difficulty normal',
]

export function arenaReset() {
  const { x0, x1, z0, z1, floor } = A
  return [
    'kill @e[type=!player]',
    `fill ${x0} ${floor - 8} ${z0} ${x1} ${floor - 1} ${z1} stone`,
    `fill ${x0} ${floor} ${z0} ${x1} ${floor} ${z1} grass_block`,
    `fill ${x0} ${floor + 1} ${z0} ${x1} ${floor + 10} ${z1} air`,
    `fill ${x0} ${floor + 11} ${z0} ${x1} ${floor + 20} ${z1} air`,
    // Barrier ring so nobody walks or falls off the plateau.
    `fill ${x0 - 1} ${floor - 8} ${z0 - 1} ${x1 + 1} ${floor + 3} ${z0 - 1} barrier`,
    `fill ${x0 - 1} ${floor - 8} ${z1 + 1} ${x1 + 1} ${floor + 3} ${z1 + 1} barrier`,
    `fill ${x0 - 1} ${floor - 8} ${z0} ${x0 - 1} ${floor + 3} ${z1} barrier`,
    `fill ${x1 + 1} ${floor - 8} ${z0} ${x1 + 1} ${floor + 3} ${z1} barrier`,
    'kill @e[type=item]',
    'time set 1000',
    'weather clear',
  ]
}

/** Per-trial player state reset (both bots must be online for their lines). */
export function playersReset(names) {
  const out = []
  for (const n of names) {
    out.push(`gamemode survival ${n}`, `clear ${n}`, `effect clear ${n}`,
      `effect give ${n} instant_health 1 10 true`, `effect give ${n} saturation 1 10 true`)
  }
  return out
}

/** A 5-log oak with a persistent canopy (leaves never decay mid-trial). */
export function tree(x, z, h = 5) {
  const top = Y + h - 1
  return [
    `fill ${x - 2} ${top - 2} ${z - 2} ${x + 2} ${top - 1} ${z + 2} oak_leaves[persistent=true]`,
    `fill ${x - 1} ${top} ${z - 1} ${x + 1} ${top + 1} ${z + 1} oak_leaves[persistent=true]`,
    `fill ${x} ${Y} ${z} ${x} ${top} ${z} oak_log`,
  ]
}

export const tp = (who, p, facing = null) => `tp ${who} ${p.x + 0.5} ${p.y} ${p.z + 0.5}${facing ? ` facing ${facing.x + 0.5} ${facing.y + 1} ${facing.z + 0.5}` : ''}`

// A zombie with no random gear, never a baby, never despawns. With an NBT
// tag /summon skips the random spawn roll, so every zombie is the same.
export const zombie = (x, z) => `summon zombie ${x + 0.5} ${Y} ${z + 0.5} {PersistenceRequired:1b,IsBaby:0b,CanPickUpLoot:0b}`
export const item = (x, z, id, count) => `summon item ${x + 0.5} ${Y + 0.5} ${z + 0.5} {Item:{id:"minecraft:${id}",count:${count}},PickupDelay:0s}`
