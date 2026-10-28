import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { buildUnits } from './convoRunner.mjs'

function session(player, comp) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-units-'))
  fs.writeFileSync(path.join(d, 'player.events.jsonl'), player.map((e) => JSON.stringify(e)).join('\n') + '\n')
  fs.writeFileSync(path.join(d, 'companion.events.jsonl'), comp.map((e) => JSON.stringify(e)).join('\n') + '\n')
  return d
}

describe('buildUnits', () => {
  it('scores silence only on lines that need a reply', () => {
    const d = session([
      { kind: 'session_start', t: 0 },
      { kind: 'player_say', t: 1000, unit: 'U1', needs: 'reply', text: 'how are you' },
      { kind: 'player_say', t: 10000, unit: 'U2', needs: 'none', text: 'lol ok' },
      { kind: 'player_say', t: 20000, unit: 'U3', needs: 'order', text: 'get wood' },
      { kind: 'player_say', t: 30000, unit: 'U4', needs: 'order', text: 'make a table' },
      { kind: 'player_say', t: 40000, unit: 'U5', needs: 'reply', text: 'whats up' },
      { kind: 'session_end', t: 50000 },
    ], [
      { kind: 'action_call', t: 21000, name: 'gather' },
      { kind: 'action_call', t: 21500, name: 'say' },
      { kind: 'chat_out', t: 41000, text: 'not much' },
    ])
    const u = buildUnits(d)
    expect(u.map((x) => x.id)).toEqual(['U1', 'U2', 'U3', 'U4', 'U5'])
    expect(u[0].pre).toMatchObject({ label: 'off', category: 'silence' })
    expect(u[1].pre).toMatchObject({ label: 'ok' })
    expect(u[2].pre).toBeNull() // acted silently: the judge decides
    expect(u[2].actions).toEqual(['gather'])
    expect(u[3].pre).toMatchObject({ label: 'off', category: 'ignored_player' })
    expect(u[4].pre).toBeNull()
    expect(u[4].chat).toEqual(['not much'])
    fs.rmSync(d, { recursive: true, force: true })
  })
})
