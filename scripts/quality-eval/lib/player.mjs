// scripts/quality-eval/lib/player.mjs: the scripted test player (a plain
// mineflayer bot, no LLM) used by the benchmarks and scripted conversations.
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { PLAYER } from './companionProc.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, '..', '..', '..', 'package.json'))
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
export { goals, Vec3 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function connectPlayer({ port = Number(process.env.QE_MC_PORT || 25590), username = PLAYER } = {}) {
  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({ host: '127.0.0.1', port, username, auth: 'offline' })
    bot.loadPlugin(pathfinder)
    const to = setTimeout(() => reject(new Error('player spawn timeout')), 60000)
    bot.once('spawn', () => {
      clearTimeout(to)
      const mv = new Movements(bot)
      mv.canDig = false
      mv.allow1by1towers = false
      mv.allowParkour = false
      bot.pathfinder.setMovements(mv)
      resolve(bot)
    })
    bot.once('error', (e) => { clearTimeout(to); reject(e) })
    bot.once('kicked', (r) => { clearTimeout(to); reject(new Error('kicked: ' + JSON.stringify(r))) })
  })
}

export function entityOf(bot, username) {
  return Object.values(bot.entities).find((e) => e.type === 'player' && e.username === username) ?? null
}

export function distTo(bot, username) {
  const e = entityOf(bot, username)
  return e ? e.position.distanceTo(bot.entity.position) : Infinity
}

/** Walk to a block position; resolves true when within range, false on timeout. */
export async function walkTo(bot, p, { range = 1, timeoutMs = 40000 } = {}) {
  bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, range))
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await sleep(250)
    if (bot.entity.position.distanceTo(new Vec3(p.x + 0.5, p.y, p.z + 0.5)) <= range + 1) { bot.pathfinder.setGoal(null); return true }
  }
  bot.pathfinder.setGoal(null)
  return false
}

/** Count blocks in a box whose name matches. Uses the player's chunk view. */
export function countBlocks(bot, box, match) {
  let n = 0
  for (let x = box.x0; x <= box.x1; x++) for (let y = box.y0; y <= box.y1; y++) for (let z = box.z0; z <= box.z1; z++) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (b && match(b.name)) n++
  }
  return n
}
