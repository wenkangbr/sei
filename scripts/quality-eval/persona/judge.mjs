#!/usr/bin/env node
// scripts/quality-eval/persona/judge.mjs: Opus judging for the persona eval.
//
//   node scripts/quality-eval/persona/judge.mjs <outDir> [--chars dir] [--batch 15]
//
// Two passes over <outDir>/samples.jsonl:
//   1. attribution (blind): the judge gets all character cards and, per item,
//      the situation plus what the companion said and did, with every
//      character name replaced by [companion]. It names the most likely
//      character. Items are shuffled across characters and judged
//      independently (the same character can be the answer for every item).
//   2. consistency (sighted): per character, the judge gets that character's
//      persona and rates each of its items 1-5 for being in character, flags
//      off-character items with a reason, and flags generic-assistant lines.
// Writes <outDir>/judgments.jsonl (one row per sample) and judge-usage.json.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { loadCharacters } from './characters.mjs'
import { SITUATIONS } from './situations.mjs'
import { rng } from '../lib/stats.mjs'

export const JUDGE_MODEL = 'claude-opus-5-5'
const OUT = process.argv[2]
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const CHARS_DIR = arg('chars', path.join(os.homedir(), 'suisei/eval/characters'))
const BATCH = Number(arg('batch', 15))
const CONC = Number(arg('concurrency', 4))
if (!OUT) { console.error('usage: judge.mjs <outDir>'); process.exit(2) }

const chars = loadCharacters(CHARS_DIR)
// A goodbye can be spoken through quit_game's `farewell` instead of say(); it
// reaches chat the same way, so it counts as speech.
const samples = fs.readFileSync(path.join(OUT, 'samples.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((s) => !s.error)
  .map((s) => {
    const farewells = (s.actions ?? []).filter((a) => a.name === 'quit_game' && a.input?.farewell).map((a) => String(a.input.farewell))
    return farewells.length ? { ...s, says: [...(s.says ?? []), ...farewells] } : s
  })
const sitById = Object.fromEntries(SITUATIONS.map((s) => [s.id, s]))
const LETTERS = chars.map((_, i) => String.fromCharCode(65 + i))

// Every character's name (display + in-game) is masked in what the judge sees,
// so attribution has to come from voice and behavior.
const NAME_RE = new RegExp(`\\b(${[...new Set(chars.flatMap((c) => [c.name, c.botName]))].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi')
const mask = (s) => String(s ?? '').replace(NAME_RE, '[companion]')

function describeActions(actions) {
  if (!actions?.length) return 'none'
  return actions.map((a) => {
    const inp = JSON.stringify(a.input ?? {})
    return `${a.name}(${mask(inp.length > 160 ? inp.slice(0, 157) + '...' : inp)})`
  }).join(', ')
}

function itemText(s, id) {
  const sit = sitById[s.situation]
  return [
    `<item id="${id}">`,
    `situation: ${sit?.label ?? s.situation}`,
    s.playerLine ? `player said: "${mask(s.playerLine)}"` : 'player said: (nothing, this was not a reply)',
    s.says?.length ? `companion said: ${s.says.map((t) => `"${mask(t)}"`).join(' then ')}` : 'companion said: (nothing)',
    `companion's actions: ${describeActions(s.actions)}`,
    '</item>',
  ].join('\n')
}

const anthropic = new Anthropic({
  apiKey: (process.env.ANTHROPIC_API_KEY ?? fs.readFileSync(path.join(os.homedir(), '.sei-dev/anthropic-test-key'), 'utf8')).trim(),
  maxRetries: 4,
})
const usage = { attribution: {}, consistency: {} }

async function call(system, user, bucket) {
  const stream = anthropic.messages.stream({
    model: JUDGE_MODEL,
    max_tokens: 16000,
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  })
  const msg = await stream.finalMessage()
  const u = msg.usage || {}
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) usage[bucket][k] = (usage[bucket][k] || 0) + (u[k] || 0)
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  const a = text.indexOf('['), b = text.lastIndexOf(']')
  if (a < 0 || b < a) throw new Error(`no JSON array in judge output: ${text.slice(0, 200)}`)
  return JSON.parse(text.slice(a, b + 1))
}

async function pool(items, n, fn) {
  let i = 0
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k) } }))
}

// ── 1. attribution ──────────────────────────────────────────────────────────
const cards = chars.map((c, i) => `<character letter="${LETTERS[i]}">\n${mask(c.expanded)}\n</character>`).join('\n\n')
const ATTR_SYSTEM = [
  'You are judging whether AI companions in a Minecraft companion app have recognisable personalities.',
  `There are ${chars.length} characters. Each is described below by its persona (the instructions the companion plays from). Every character name has been replaced with [companion].`,
  '',
  cards,
  '',
  'You will get a list of items. Each item is one moment from a play session: the situation, what the player said, what the companion said out loud in chat, and the in-game actions it took. Names are masked.',
  'For each item, decide which character it most likely came from, judging by voice, attitude, word choice, what it chose to do, and how it fits the persona. Judge every item on its own: the items are shuffled, any character can appear any number of times, and you must not balance your answers across characters.',
  'If the item gives you nothing to go on (for example the companion said nothing and did nothing), still give your best guess and a low confidence.',
  'Answer with only a JSON array, one object per item, in order: {"id": "<item id>", "guess": "<letter>", "confidence": <0 to 1>, "why": "<at most 12 words>"}. No other text.',
].join('\n')

const attr = new Map()
{
  const r = rng(1234)
  const order = samples.map((s, i) => ({ s, i, k: r() })).sort((a, b) => a.k - b.k)
  const batches = []
  for (let i = 0; i < order.length; i += BATCH) batches.push(order.slice(i, i + BATCH))
  await pool(batches, CONC, async (batch, bi) => {
    const user = batch.map(({ i }, j) => itemText(samples[i], `a${bi}-${j}`)).join('\n\n')
    const res = await call(ATTR_SYSTEM, user, 'attribution')
    const byId = Object.fromEntries(res.map((x) => [x.id, x]))
    batch.forEach(({ i }, j) => {
      const g = byId[`a${bi}-${j}`]
      const idx = g ? LETTERS.indexOf(String(g.guess).trim().toUpperCase()) : -1
      attr.set(i, { guess: idx >= 0 ? chars[idx].key : null, confidence: g?.confidence ?? null, why: g?.why ?? null })
    })
    console.log(`attribution batch ${bi + 1}/${batches.length}`)
  })
}

// ── 2. consistency + generic ────────────────────────────────────────────────
const cons = new Map()
function consSystem(c) {
  return [
    'You are judging whether an AI companion in a Minecraft companion app stays in character. The app sells companions with distinct personalities, so a companion that sounds like every other one, or like a generic assistant, is failing even when what it says is reasonable.',
    '',
    'This is the persona the companion plays from:',
    '<persona>',
    c.expanded,
    '</persona>',
    '',
    'You will get a list of items. Each is one moment from a play session: the situation, what the player said, what the companion said out loud in chat, and the in-game actions it took.',
    'For each item give:',
    '- "score": 1 to 5 for how well the words AND actions fit this persona. 5 = unmistakably this character (voice, attitude and choices all match). 4 = in character with a clear trace of the persona. 3 = neutral: not wrong, but nothing about it is this character in particular. 2 = partly off: the register, attitude or choice cuts against the persona. 1 = clearly out of character.',
    '- "off": true when the item breaks character in a way a player who knows this character would notice (score 1 or 2, or an action the persona would never take). Otherwise false.',
    '- "generic": true when the words could have come from any friendly game companion or AI assistant: swap in a different personality and nothing would need to change, or it uses helper-bot register ("sure, I can help with that", "on it!", narrating its plan back). A short line can still be specific to the persona; judge whether it is.',
    '- "reason": one short sentence naming what fits or what breaks.',
    'Saying nothing is fine when the persona and the moment allow it; judge silence the same way.',
    'Answer with only a JSON array, one object per item, in order: {"id","score","off","generic","reason"}. No other text.',
  ].join('\n')
}
{
  const jobs = []
  for (const c of chars) {
    const mine = samples.map((s, i) => ({ s, i })).filter((x) => x.s.char === c.key)
    for (let i = 0; i < mine.length; i += BATCH) jobs.push({ c, batch: mine.slice(i, i + BATCH) })
  }
  await pool(jobs, CONC, async ({ c, batch }, bi) => {
    // Sighted pass: names stay visible; the judge knows who this is anyway.
    const user = batch.map(({ s }, j) => itemText({ ...s, says: s.says, playerLine: s.playerLine }, `c${bi}-${j}`)
      .replaceAll('[companion]', c.name)).join('\n\n')
    const res = await call(consSystem(c), user, 'consistency')
    const byId = Object.fromEntries(res.map((x) => [x.id, x]))
    batch.forEach(({ i }, j) => {
      const g = byId[`c${bi}-${j}`] ?? {}
      cons.set(i, { score: Number(g.score) || null, off: g.off === true, generic: g.generic === true, reason: g.reason ?? null })
    })
    console.log(`consistency batch ${bi + 1}/${jobs.length}`)
  })
}

const rows = samples.map((s, i) => ({
  char: s.char, situation: s.situation, rep: s.rep, says: s.says, actions: s.actions?.map((a) => a.name) ?? [],
  silent: !s.says?.length, attribution: attr.get(i) ?? null, consistency: cons.get(i) ?? null,
}))
fs.writeFileSync(path.join(OUT, 'judgments.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
fs.writeFileSync(path.join(OUT, 'judge-usage.json'), JSON.stringify({ model: JUDGE_MODEL, usage }, null, 1))
console.log(`judged ${rows.length} samples -> ${path.join(OUT, 'judgments.jsonl')}`)
