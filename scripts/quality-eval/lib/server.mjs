// scripts/quality-eval/lib/server.mjs: drive the local eval server from node.
// Lifecycle goes through mc-server.sh; console commands are appended to the
// console.in file the server's stdin tails, and command OUTPUT is read back
// from server.log (query()). One query runs at a time so outputs never mix.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const SERVER_SH = path.join(here, '..', 'mc-server.sh')
export const MC_DIR = process.env.QE_MC_DIR || path.join(os.homedir(), 'suisei', 'eval', 'mc-server')
export const PORT = Number(process.env.QE_MC_PORT || 25590)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function serverCtl(cmd, ...args) {
  const r = spawnSync('bash', [SERVER_SH, cmd, ...args], { encoding: 'utf8', timeout: 240000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) throw new Error(`mc-server.sh ${cmd} failed: ${(r.stderr || '').slice(-600)}`)
  return r.stdout
}

const LOG = () => path.join(MC_DIR, 'server.log')
export function consoleCmd(c) {
  fs.appendFileSync(path.join(MC_DIR, 'console.in'), c.replace(/^\//, '') + '\n')
}

let chain = Promise.resolve()
/**
 * Run one console command and return the server.log text it produced.
 * Waits until a line appears after the command (or timeoutMs).
 */
export function query(cmd, { timeoutMs = 3000, settleMs = 150, expect = null } = {}) {
  const run = async () => {
    let size = 0
    try { size = fs.statSync(LOG()).size } catch {}
    consoleCmd(cmd)
    const t0 = Date.now()
    let out = ''
    while (Date.now() - t0 < timeoutMs) {
      await sleep(60)
      let st
      try { st = fs.statSync(LOG()) } catch { continue }
      if (st.size > size) {
        if (!expect) await sleep(settleMs)
        const fd = fs.openSync(LOG(), 'r')
        const len = fs.statSync(LOG()).size - size
        const buf = Buffer.alloc(len)
        fs.readSync(fd, buf, 0, len, size)
        fs.closeSync(fd)
        out = buf.toString('utf8')
        // With an expected pattern, keep waiting past unrelated lines (a join,
        // a death message) until the command's own answer shows up.
        if (!expect || expect.test(out)) break
      }
    }
    // Keep only the command's own output lines (drop chat/join noise).
    return out.split('\n').filter((l) => /\[Server thread\/INFO\]: /.test(l) && !/<[^>]+> /.test(l) && !/joined the game|left the game|lost connection/.test(l))
      .map((l) => l.replace(/^.*\[Server thread\/INFO\]: /, '')).join('\n')
  }
  const p = chain.then(run, run)
  chain = p.catch(() => {})
  return p
}

/** Run a list of commands; fire-and-forget pacing so the log stays readable. */
export function cmds(list, gapMs = 40) {
  const run = async () => { for (const c of list) { consoleCmd(c); if (gapMs) await sleep(gapMs) } }
  const p = chain.then(run, run)
  chain = p.catch(() => {})
  // Resolves once the server has processed them (a cheap query queues behind).
  return p.then(() => query('time query gametime', { expect: /The time is/ }))
}

/** Count of an item on a player (server ground truth): /clear <p> <item> 0. */
export async function itemCount(player, item) {
  const out = await query(`clear ${player} ${item} 0`, { expect: /Found \d+ matching|No items were found|No player was found/ })
  const m = /Found (\d+) matching item/.exec(out)
  return m ? Number(m[1]) : 0
}

/** Number of entities matching a selector: execute if entity. */
export async function entityCount(selector) {
  const out = await query(`execute if entity ${selector}`, { expect: /Test (passed|failed)/ })
  const m = /Test passed[.,] [Cc]ount: (\d+)/.exec(out)
  return m ? Number(m[1]) : 0
}
