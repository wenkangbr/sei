#!/usr/bin/env node
// scripts/quality-eval/judge.mjs: label every companion line, action and
// silence in a session as ok/off with a category, using Claude Opus.
//
//   node scripts/quality-eval/judge.mjs <outDir> [--only id,id]
//   node scripts/quality-eval/judge.mjs --calibrate   (agreement on calibration.json holdout)
//
// Writes <outDir>/sessions/<id>/labels.json and transcript.txt.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { loadSession, renderTimeline } from './transcript.mjs'
import { scenarioById } from './scenarios.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const JUDGE_MODEL = 'claude-opus-5-5'
export const CATEGORIES = [
  'out_of_character', 'robotic_or_assistanty', 'wrong_or_hallucinated', 'ignored_player',
  'broken_or_failed_action', 'silence', 'repetitive', 'too_long', 'other',
]
const CHUNK = 90

function calibration() {
  return JSON.parse(fs.readFileSync(path.join(here, 'calibration.json'), 'utf8'))
}

export function judgeSystem(persona) {
  const cal = calibration()
  const ex = cal.examples.map((e) =>
    `Scenario: ${e.scenario}\n${e.context}\nLabel for ${e.id}: ${JSON.stringify({ id: e.id, label: e.label, category: e.category, severity: e.severity, reason: e.reason })}`,
  ).join('\n\n')
  return [
    'You review play sessions of Sei, an AI companion that plays Minecraft with a person. The companion is supposed to feel like a fun, smart friend who plays with you, with her own personality. People pay for this, and two paying users cancelled because it felt "too stupid" and "low quality". Your job is to find the moments that would make a player feel that way.',
    '',
    'You get the full timeline of one session. The player is a scripted test player who acts like a normal person. Lines marked [L#] are what the companion said in chat. [A#] are in-game actions she took, with results. [S#] are silences, where the player typed something and she said nothing for 20 seconds. Lines in parentheses are context: her private notes (the player cannot see these), what her sensors reported about the world, and game events. Use the sensors and results as ground truth when checking what she claims.',
    '',
    'Label each item you are asked about as ok or off.',
    'off means a real player who wants a fun, capable friend would notice it as bad: it breaks the feeling, looks dumb, is annoying, or does not work. Minor but real problems are still off; use severity for how bad.',
    'ok means it is fine, or good. Do not mark something off just because it could have been slightly better.',
    'Her persona may play up being clumsy or new at the game. That flavor in how she talks is fine. Actions that fail, requests she ignores, and claims that are false still count as off, whatever the persona says.',
    '',
    'Categories for off items:',
    '- out_of_character: does not sound like her persona (below), or acts against it, for example talking about her prompts or instructions. Read the persona first: if it says she knows she is an AI, saying so is not off.',
    '- robotic_or_assistanty: sounds like a customer service bot or an assistant ("Sure! I\'d be happy to help"), stiff, generic, or over-explains.',
    '- wrong_or_hallucinated: claims something false about the world, her inventory, her health, what she did, or the history with the player.',
    '- ignored_player: does not respond to what the player asked or said, does something else, or keeps going after being told to stop.',
    '- broken_or_failed_action: an action fails, does much less than asked, gets stuck, or is pointless. A failure caused by the player interrupting is not her fault.',
    '- silence: the player clearly expected a reply and got none. A silence after something that needs no answer (lol, ok, a narration) is ok.',
    '- repetitive: repeats herself or near-repeats an earlier line or update.',
    '- too_long: much longer than a friend would type in game chat.',
    '- other: anything else that is off.',
    '',
    'Severity for off items: 1 = small, a player might shrug; 2 = clearly noticeable and annoying; 3 = the kind of moment that makes someone think this product is bad. Use 0 for ok items.',
    'Category is "none" for ok items. The reason is one short sentence a developer can act on.',
    '',
    'Her persona, which defines in character for her:',
    '<persona>',
    persona,
    '</persona>',
    '',
    'Hand-checked examples of how to label:',
    '',
    ex,
    '',
    'Answer with only a JSON array, one object per item you were asked about, in order: {"id","label","category","severity","reason"}. No other text.',
  ].join('\n')
}

function parseLabels(text) {
  const a = text.indexOf('['), b = text.lastIndexOf(']')
  if (a < 0 || b < a) throw new Error('no JSON array in judge output')
  return JSON.parse(text.slice(a, b + 1))
}

function normLabel(l) {
  const label = l.label === 'off' ? 'off' : 'ok'
  let category = label === 'ok' ? 'none' : (CATEGORIES.includes(l.category) ? l.category : 'other')
  const severity = label === 'ok' ? 0 : Math.min(3, Math.max(1, Number(l.severity) || 1))
  return { id: String(l.id), label, category, severity, reason: String(l.reason ?? '').slice(0, 300) }
}

async function callJudge(anthropic, system, transcriptBlock, ask, usage) {
  const stream = anthropic.messages.stream({
    model: JUDGE_MODEL,
    max_tokens: 32000,
    output_config: { effort: 'medium' },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: transcriptBlock, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: ask },
      ],
    }],
  })
  const msg = await stream.finalMessage()
  const u = msg.usage || {}
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) usage[k] = (usage[k] || 0) + (u[k] || 0)
  usage.calls = (usage.calls || 0) + 1
  const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
  return parseLabels(text)
}

function personaText(meta) {
  const charFile = process.env.QE_CHARACTER || path.join(os.homedir(), 'suisei', 'eval', 'characters', 'sui.json')
  try {
    let row = JSON.parse(fs.readFileSync(charFile, 'utf8'))
    if (Array.isArray(row)) row = row[0]
    return row.persona_expanded || row.persona?.expanded || ''
  } catch { return `(persona unavailable for ${meta?.companion ?? 'companion'})` }
}

export async function judgeSession(anthropic, sessDir) {
  const sess = loadSession(sessDir)
  const sc = scenarioById(sess.meta.scenario) || { title: sess.meta.scenario, brief: '' }
  const tl = renderTimeline(sess)
  fs.writeFileSync(path.join(sessDir, 'transcript.txt'), tl + '\n')
  const usage = {}
  const system = judgeSystem(personaText(sess.meta))
  const transcriptBlock = [
    `Scenario: ${sc.title}. What the test player was told to do: ${sc.brief}`,
    `Companion: ${sess.companion}. Player: ${sess.playerName}. The companion started this session with no memory of the player.`,
    '',
    '<timeline>',
    tl,
    '</timeline>',
  ].join('\n')
  const labels = []
  for (let i = 0; i < sess.items.length; i += CHUNK) {
    const chunk = sess.items.slice(i, i + CHUNK)
    const ids = chunk.map((c) => c.id)
    const ask = `Label these ${ids.length} items: ${ids.join(', ')}.`
    let got = null
    for (let attempt = 0; attempt < 2 && !got; attempt++) {
      try { got = await callJudge(anthropic, system, transcriptBlock, ask, usage) } catch (e) { if (attempt) throw e }
    }
    const byId = new Map(got.map((l) => [String(l.id), normLabel(l)]))
    for (const id of ids) labels.push(byId.get(id) ?? { id, label: 'ok', category: 'none', severity: 0, reason: '(judge gave no label)', missing: true })
  }
  const out = { scenario: sess.meta.scenario, model: JUDGE_MODEL, usage, labels }
  fs.writeFileSync(path.join(sessDir, 'labels.json'), JSON.stringify(out, null, 2))
  return out
}

export async function judgeSessions(outDir, { anthropic, only = null } = {}) {
  const dir = path.join(outDir, 'sessions')
  for (const id of fs.readdirSync(dir)) {
    if (only && !only.includes(id)) continue
    const sessDir = path.join(dir, id)
    if (!fs.existsSync(path.join(sessDir, 'meta.json'))) continue
    console.log(`[judge] ${id}`)
    const r = await judgeSession(anthropic, sessDir)
    const off = r.labels.filter((l) => l.label === 'off').length
    console.log(`[judge] ${id}: ${off}/${r.labels.length} off`)
  }
}

// Agreement with the hand labels in calibration.json "holdout".
async function calibrate(anthropic) {
  const cal = calibration()
  if (!cal.holdout?.length) { console.log('no holdout examples'); return }
  const system = judgeSystem(personaText({}))
  const usage = {}
  let agree = 0, catAgree = 0
  for (const h of cal.holdout) {
    const block = `Scenario: ${h.scenario}\n<timeline>\n${h.context}\n</timeline>`
    const [l] = await callJudge(anthropic, system, block, `Label this 1 item: ${h.id}.`, usage)
    const n = normLabel(l || {})
    const same = n.label === h.label
    agree += same ? 1 : 0
    catAgree += same && (h.label === 'ok' || n.category === h.category) ? 1 : 0
    console.log(`${same ? 'AGREE   ' : 'DISAGREE'} ${h.id} hand=${h.label}/${h.category} judge=${n.label}/${n.category}: ${n.reason}`)
  }
  console.log(`label agreement ${agree}/${cal.holdout.length}, label+category ${catAgree}/${cal.holdout.length}`)
  console.log('usage', JSON.stringify(usage))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const keyFile = process.env.QE_KEY_FILE || path.join(os.homedir(), '.sei-dev', 'anthropic-test-key')
  const anthropic = new Anthropic({ apiKey: fs.readFileSync(keyFile, 'utf8').trim(), maxRetries: 3 })
  const args = process.argv.slice(2)
  if (args.includes('--calibrate')) await calibrate(anthropic)
  else {
    const i = args.indexOf('--only')
    await judgeSessions(path.resolve(args[0]), { anthropic, only: i >= 0 ? args[i + 1].split(',') : null })
  }
}
