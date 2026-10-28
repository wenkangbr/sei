// scripts/quality-eval/bench/convoJudge.mjs: Opus labels each response unit
// of a scripted conversation (one per player line) ok/off with the same
// categories as the free-play judge. Units buildUnits() already decided
// (silence on a question, an ignored order, a quiet "ok") skip the judge.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSession } from '../transcript.mjs'
import { JUDGE_MODEL, CATEGORIES } from '../judge.mjs'
import { buildUnits } from './convoRunner.mjs'

const fmtT = (t, start) => { const s = Math.max(0, Math.round((t - start) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
const clip = (s, n = 240) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '...' : s }

function persona() {
  const f = process.env.QE_CHARACTER || path.join(os.homedir(), 'suisei', 'eval', 'characters', 'sui.json')
  try { let r = JSON.parse(fs.readFileSync(f, 'utf8')); if (Array.isArray(r)) r = r[0]; return r.persona_expanded || r.persona?.expanded || '' } catch { return '' }
}

const NEEDS_TEXT = {
  reply: 'needs a reply (question, greeting, tease or insult)',
  order: 'an order: doing it, or saying why not, is a response',
  stop: 'a stop: she must actually stop what she is doing; a short ack is good',
  none: 'an acknowledgement: no reply needed; judge only what she did say',
}

export function renderConvo(sess, units) {
  const byT = new Map(units.map((u) => [u.t, u]))
  const out = []
  for (const e of sess.timeline) {
    const ts = fmtT(e.t, sess.start)
    switch (e.kind) {
      case 'player': {
        const u = byT.get(e.t)
        out.push(`${ts} [${u?.id ?? '?'}] ${sess.playerName}: ${e.text}   (${NEEDS_TEXT[u?.needs] ?? ''})`)
        break
      }
      case 'line': out.push(`${ts} ${sess.companion} says: ${e.text}`); break
      case 'chat_out': if (!e.folded) out.push(`${ts} ${sess.companion} says: ${e.text}`); break
      case 'action': out.push(`${ts} ${sess.companion} action: ${e.item.name}(${clip(JSON.stringify(e.item.args ?? {}), 140)})${e.item.preStart ? '   (started just before the session began, still running)' : ''}`); break
      case 'result': out.push(`${ts}   result: ${clip(e.text.replace(/^A\d+ /, ''))}`); break
      case 'private': out.push(`${ts}   (${sess.companion} private note, player cannot see: ${e.text})`); break
      case 'snapshot': out.push(`${ts}   (${sess.companion}'s sensors: ${e.text})`); break
      case 'sensed': out.push(`${ts}   (what ${sess.companion}'s sensors showed her as she spoke: ${e.text})`); break
      case 'event': out.push(`${ts}   (event: ${e.text})`); break
      default: break
    }
  }
  return out.join('\n')
}

function system() {
  return [
    'You review a scripted play session of Sei, an AI companion that plays Minecraft with a person. She should feel like a fun, smart friend with her own personality. Two paying users cancelled because it felt "too stupid" and "low quality"; find the moments that would make a player feel that way.',
    '',
    'The player is a fixed script: the same lines every run, sent on a timer, so do not blame her for the player changing topic. Each player line is marked [U#] with what kind of line it is. For each [U#] you label her RESPONSE: everything she said and did after that line and before the next [U#] line. Lines in parentheses are context: her private notes (the player cannot see them), what her sensors reported (ground truth for checking her claims), and game events.',
    '',
    'off means a real player who wants a fun, capable friend would notice it as bad. ok means fine or good. Do not mark off for something that could merely have been slightly better.',
    'Her persona may play up being clumsy or new at the game; that flavor is fine. Failed actions, ignored requests and false claims still count as off.',
    'An acknowledgement line (no reply needed) is ok when she stays quiet or answers briefly; it is off only if what she says is itself bad.',
    'For a stop line, off if she keeps doing the task (a new dig/gather/attack after the stop, or claims of continuing).',
    'For an order, off if she does something else, the action clearly fails or does much less than asked, or she claims success the results contradict. A refusal in character with a reason can be ok.',
    'If several things are wrong in one response, pick the category of the worst one.',
    '',
    'Categories for off: ' + CATEGORIES.join(', ') + '.',
    '- out_of_character: not her persona\'s voice, or talks about prompts/instructions.',
    '- robotic_or_assistanty: customer-service tone, stiff, generic, over-explains.',
    '- wrong_or_hallucinated: false claims about the world, inventory, health, what she did, or the conversation so far.',
    '- ignored_player: does not respond to what was asked, does something else, keeps going after stop.',
    '- broken_or_failed_action: the action fails, gets stuck, or is pointless.',
    '- silence: the line needed a reply and got none.',
    '- repetitive: repeats an earlier line or update.',
    '- too_long: much longer than a friend types in game chat.',
    '- other: anything else.',
    'Severity: 1 small, 2 clearly annoying, 3 makes the product look bad. 0 for ok. Category "none" for ok. Reason: one short sentence a developer can act on.',
    '',
    'Her persona:',
    '<persona>', persona(), '</persona>',
    '',
    'Answer with only a JSON array, one object per [U#] you are asked about, in order: {"id","label","category","severity","reason"}. No other text.',
  ].join('\n')
}

function parse(text) {
  const a = text.indexOf('['), b = text.lastIndexOf(']')
  if (a < 0 || b < a) throw new Error('no JSON array in judge output')
  return JSON.parse(text.slice(a, b + 1))
}

function norm(l) {
  const label = l.label === 'off' ? 'off' : 'ok'
  return {
    label,
    category: label === 'ok' ? 'none' : (CATEGORIES.includes(l.category) ? l.category : 'other'),
    severity: label === 'ok' ? 0 : Math.min(3, Math.max(1, Number(l.severity) || 1)),
    reason: String(l.reason ?? '').slice(0, 300),
  }
}

export async function judgeConvoSession(anthropic, sessDir) {
  const sess = loadSession(sessDir)
  const units = buildUnits(sessDir)
  const tl = renderConvo(sess, units)
  fs.writeFileSync(path.join(sessDir, 'transcript.txt'), tl + '\n')
  const ask = units.filter((u) => !u.pre).map((u) => u.id)
  const usage = {}
  let got = []
  if (ask.length) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const msg = await anthropic.messages.stream({
          model: JUDGE_MODEL,
          max_tokens: 32000,
          output_config: { effort: 'medium' },
          system: [{ type: 'text', text: system(), cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: `Companion: ${sess.companion}. Player: ${sess.playerName}. She starts with no memory of the player.\n\n<timeline>\n${tl}\n</timeline>\n\nLabel these ${ask.length} responses: ${ask.join(', ')}.` }],
        }).finalMessage()
        const u = msg.usage || {}
        for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) usage[k] = (usage[k] || 0) + (u[k] || 0)
        got = parse(msg.content.filter((c) => c.type === 'text').map((c) => c.text).join(''))
        break
      } catch (e) { if (attempt) throw e }
    }
  }
  const byId = new Map(got.map((l) => [String(l.id), norm(l)]))
  const labels = units.map((u) => ({
    id: u.id, text: u.text, needs: u.needs, chat: u.chat, actions: u.actions,
    ...(u.pre ? { ...u.pre, by: 'rule' } : (byId.get(u.id) ? { ...byId.get(u.id), by: 'judge' } : { label: 'ok', category: 'none', severity: 0, reason: '(judge gave no label)', by: 'missing' })),
  }))
  const out = { model: JUDGE_MODEL, usage, labels }
  fs.writeFileSync(path.join(sessDir, 'labels.json'), JSON.stringify(out, null, 2))
  return out
}
