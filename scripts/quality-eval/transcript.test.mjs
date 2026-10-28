import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { loadSession, renderTimeline } from './transcript.mjs'
import { renderConvo } from './bench/convoJudge.mjs'
import { parseSensed, sensedFromRawLog } from './snapshot.mjs'

function session(player, comp, raw) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-transcript-'))
  fs.writeFileSync(path.join(d, 'player.events.jsonl'), player.map((e) => JSON.stringify(e)).join('\n') + '\n')
  fs.writeFileSync(path.join(d, 'companion.events.jsonl'), comp.map((e) => JSON.stringify(e)).join('\n') + '\n')
  if (raw) fs.writeFileSync(path.join(d, 'companion.raw.log'), raw)
  return d
}

const prompt = (body) => `[01:00:00.000] [haiku?] begin\n  snapshot:\n${body}\n[01:00:00.001] [haiku?] end\n`
const answer = (t) => `[01:00:0${t}.000] [haiku!] begin\n  calls: say({"text":"x"})\n[01:00:0${t}.001] [haiku!] end\n`

describe('parseSensed (261014)', () => {
  it('reads the inventory and reduces the running action to its name', () => {
    expect(parseSensed(prompt('    in_flight: gather(oak_log) started=3.0s ago — picked up 2 of the 6 oak_log asked for so far\n    inventory (1 of 36 slots used): oak_log×4')))
      .toEqual({ inventory: 'oak_log×4', doing: 'gather running' })
    expect(parseSensed(prompt('    idle: no action is running, but you are still following Alex\n    inventory (0 of 36 slots used): empty')))
      .toEqual({ inventory: 'empty', doing: 'no action running, following the player' })
    expect(parseSensed(prompt('    idle: no action is running\n    inventory (2 of 36 slots used): dirt×3 bread×1')))
      .toEqual({ inventory: 'dirt×3 bread×1', doing: 'no action running' })
    expect(parseSensed('no snapshot here')).toBeNull()
  })

  it('backfills one entry per [haiku!] block from the raw log', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-raw-'))
    const p = path.join(d, 'raw.log')
    fs.writeFileSync(p, answer(1) + prompt('    idle: no action is running\n    inventory (1 of 36 slots used): oak_log×1') + answer(2))
    expect(sensedFromRawLog(p)).toEqual([null, { inventory: 'oak_log×1', doing: 'no action running' }])
  })
})

describe('loadSession (261014)', () => {
  it('shows an action that was still running when the session started', () => {
    const d = session([
      { kind: 'session_start', t: 10_000 },
      { kind: 'player_say', t: 11_000, unit: 'U1', needs: 'reply', text: 'what are you doing' },
      { kind: 'session_end', t: 60_000 },
    ], [
      { kind: 'action_call', t: 7_000, name: 'gather', args: { name: 'oak_log', count: 6 } },
      { kind: 'action_call', t: 8_000, name: 'equip', args: { item: 'stick' } },
      { kind: 'action_result', t: 8_500, action: 'equip', result: 'equipped stick' },
      { kind: 'action_result', t: 30_000, action: 'gather', result: 'gathered 6/6 oak_log' },
    ])
    const s = loadSession(d)
    const acts = s.items.filter((i) => i.type === 'action')
    expect(acts.map((a) => a.name)).toEqual(['gather'])
    expect(acts[0].result).toBe('gathered 6/6 oak_log')
    expect(acts[0].t).toBe(10_000)
    expect(renderTimeline(s)).toContain('gather({"name":"oak_log","count":6})   (started just before the session began, still running)')
    expect(renderConvo(s, [])).toContain('(started just before the session began, still running)')
  })

  it('renders what she sensed next to a line, only when it changed', () => {
    const sensed = { inventory: 'oak_log×4', doing: 'gather running' }
    const d = session([
      { kind: 'session_start', t: 0 },
      { kind: 'session_end', t: 60_000 },
    ], [
      { kind: 'llm_turn', t: 5_000, calls: [{ name: 'say', input: { text: 'got 4' } }], sensed },
      { kind: 'llm_turn', t: 9_000, calls: [{ name: 'say', input: { text: 'still going' } }], sensed },
      { kind: 'llm_turn', t: 12_000, calls: [{ name: 'say', input: { text: 'done' } }], sensed: { inventory: 'oak_log×6', doing: 'no action running' } },
    ])
    const out = renderConvo(loadSession(d), [])
    const lines = out.split('\n')
    expect(lines.filter((l) => l.includes('as she spoke')).length).toBe(2)
    expect(lines[0]).toContain("what Sui's sensors showed her as she spoke: inventory oak_log×4; gather running")
    expect(lines[1]).toContain('Sui says: got 4')
    expect(out).toContain('inventory oak_log×6; no action running')
  })

  it('backfills sensed state from the raw log for older runs', () => {
    const raw = prompt('    in_flight: gather(oak_log) started=3.0s ago\n    inventory (1 of 36 slots used): oak_log×2') + answer(1)
    const d = session([
      { kind: 'session_start', t: 0 },
      { kind: 'session_end', t: 60_000 },
    ], [
      { kind: 'llm_turn', t: 5_000, calls: [{ name: 'say', input: { text: 'two logs' } }] },
    ], raw)
    expect(renderConvo(loadSession(d), [])).toContain('as she spoke: inventory oak_log×2; gather running')
  })
})
