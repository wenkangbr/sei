/**
 * Session events: what actually happened in the game this session, written
 * as short factual lines for the conversation transcript (convoMemory).
 *
 * 261014 (quality pass 7b). Asked "what was i scared of earlier?", the
 * companion answered "the zombie specifically, you hid behind me like i was a
 * wall", then built "you hide behind me when scared" into her next answer.
 * The player never hid. Measured over 50 recall turns of the night_social
 * scripted convo: the player's own line ("its getting dark im kinda scared of
 * mobs") was in her prompt in 49, so nothing had been dropped. What the
 * prompt did NOT hold was anything that happened in the world: each player
 * line opens a fresh loop whose history is only its seed, so the
 * attackEntity result ("killed zombie (4 hits)") was in 5 of the 50. The only
 * trace of the fight was her own lines ("coming at it now, stay behind me"),
 * and she filled in what the player did from them. In the 68 night_social
 * runs on record, 15 of the 136 recall answers credited the player with
 * something they never did or said ("hid behind me", "you said creepers").
 *
 * So the transcript now carries the events too, as "game:" lines in time
 * order, kept apart from both speakers: what she did (a finished action and
 * its result), what hit her or the player, and her deaths. Nothing she says
 * is filtered; she just has the record to answer from. Pure; no I/O.
 */

import { classifyActionOutcome } from './actionStats.js'

/** Events kept per session (oldest dropped first). Each renders as one line. */
export const SESSION_EVENT_CAPACITY = 12
const EVENT_TEXT_MAX = 140
/** Repeated hits from the same attacker within this window are one line. */
export const HIT_COALESCE_MS = 30_000
/**
 * The same action result again within this window is one line. Busy work
 * ("dug coal_ore" a dozen times) would otherwise fill the ring and push out
 * the one event the player asks about later (the zombie she killed).
 */
export const ACTION_COALESCE_MS = 60_000

// Actions that only look, move, or get ready are not events worth recalling
// ("you used goTo"), and in a busy session they would push out the ones that
// are. The finished result of everything else is recorded.
const QUIET_ACTIONS = new Set([
  'look', 'find', 'explore', 'readSign', 'equip', 'goTo', 'follow', 'unfollow',
  'setPvp', 'openContainer', 'openFurnace', 'stop', 'visualize',
])

function clip(s, n = EVENT_TEXT_MAX) {
  let t = String(s ?? '').replace(/\s+/g, ' ').trim()
  // A result's first clause is the fact; what follows a ';' is advice for the
  // next step ("it is in your inventory, not placed yet (placeBlock ...)").
  const semi = t.indexOf(';')
  if (semi > 0) t = t.slice(0, semi).trim()
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}

function resultText(result) {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') {
    if (typeof result.text === 'string') return result.text
    if (typeof result.reason === 'string') return result.reason
  }
  return ''
}

/**
 * The event line for one finished world action, or null when it is not worth
 * keeping: a quiet action (looking, walking, equipping), a failure that
 * changed nothing, or an abort before anything was done. A partial result or
 * an abort with progress ("aborted after 1/10 oak_log") is kept: it is what
 * actually happened.
 *
 * @param {string} name   tool name
 * @param {unknown} result  the action's return value
 * @returns {string|null}
 */
export function describeActionEvent(name, result) {
  if (!name || QUIET_ACTIONS.has(name)) return null
  const text = clip(resultText(result))
  if (!text) return null
  // "no coal within 4m", "no target", "no oak_log in inventory": a failure
  // that changed nothing, whatever the classifier makes of it.
  if (/^no\b/i.test(text)) return null
  const reason = classifyActionOutcome({ result })
  const kept = reason === null || reason === 'partial' ||
    (reason === 'aborted_by_preempt' && /\b[1-9]\d*\/\d+\b/.test(text))
  if (!kept) return null
  return `you used ${name}: ${text}`
}

/**
 * Fold key for an action event line: the line with its numbers blanked, so
 * "dug coal_ore at 10,61,-4" and "dug coal_ore at 11,61,-4" fold together.
 */
export function actionEventKey(line) {
  return `act:${String(line ?? '').replace(/-?\d+(\.\d+)?/g, '#')}`
}

function mobName(label) {
  const s = String(label ?? '').replace(/_/g, ' ').trim()
  if (!s || s === 'unknown' || s === 'a mob' || s === 'something') return 'a mob'
  return /^(a|an|the)\s/i.test(s) ? s : `a ${s}`
}

/**
 * The event line for an attack the brain was told about (the onAttacked
 * route), or null for the kinds that are not a hit: a reflex warning or a
 * survival heads-up.
 *
 * @param {object} evt  { attackerKind, attackerLabel, ownerLabel, threat, engaged }
 * `again` is the line shown once the same attacker has kept at it inside the
 * fold window. It never counts: attacks reach the brain throttled (one every
 * few seconds), so a count would be lower than the hits that landed.
 *
 * @returns {{text:string, key:string, again:string}|null}
 */
export function describeAttackEvent(evt) {
  if (!evt || typeof evt !== 'object') return null
  const kind = evt.attackerKind ?? 'mob'
  const label = evt.attackerLabel ?? null
  if (kind === 'player') {
    const who = String(label ?? '').trim() || 'a player'
    return { text: `${who} hit you`, key: `hit:${who}`, again: `${who} kept hitting you` }
  }
  if (kind === 'defend') {
    const owner = String(evt.ownerLabel ?? '').trim() || 'the player'
    const mob = mobName(label)
    // A warning (it is coming at them) and a hit that landed are different
    // events: separate keys, so a hit is never folded into the warning.
    if (evt.threat === true) {
      return { text: `${mob} came at ${owner}`, key: `threat:${owner}:${mob}`, again: `${mob} kept coming at ${owner}` }
    }
    return { text: `${mob} attacked ${owner}`, key: `owner-hit:${owner}:${mob}`, again: `${mob} kept attacking ${owner}` }
  }
  if (kind === 'hostile_mob' || kind === 'mob' || kind === 'other') {
    const mob = mobName(label)
    return { text: `${mob} hit you`, key: `hit:${mob}`, again: `${mob} kept hitting you` }
  }
  return null
}

/**
 * @param {object} evt  sei:death payload ({ lastAttack? })
 * @returns {string}
 */
export function describeDeathEvent(evt) {
  // 261019 (pass 19): the game's own death message names the real cause
  // ("Sui drowned while trying to escape Drowned"), so it wins.
  if (typeof evt?.deathText === 'string' && evt.deathText) return `you died (${evt.deathText})`
  const la = evt?.lastAttack
  if (la && la.label) {
    const by = la.kind === 'player' ? String(la.label) : mobName(la.label)
    return `you died (last hit by ${by})`
  }
  return 'you died'
}

/** Item kinds named in one inventory line; the rest are counted. */
const GAIN_KINDS_MAX = 4

/**
 * 261018 (pass 16): the event line for items that came into her inventory
 * without an action of hers (the player handed them over, or she walked over
 * them), or null. In the scripted convo her greeting said "i have zero items",
 * a sword and bread arrived a moment later, and on the next reply she said
 * "kinda thriving for a thing with zero items" with both in her inventory: the
 * change was shown on one snapshot only, while her own line stayed in the
 * transcript. Written here, the arrival sits after that line in time order.
 *
 * @param {Array<{item:string, n:number}>} gains  positive counts
 * @returns {string|null}
 */
export function describeInventoryGain(gains) {
  const list = (Array.isArray(gains) ? gains : [])
    .filter((g) => g && typeof g.item === 'string' && g.item && Number.isFinite(g.n) && g.n > 0)
  if (!list.length) return null
  const named = list.slice(0, GAIN_KINDS_MAX).map((g) => `${g.n} ${g.item}`)
  const more = list.length - named.length
  if (more > 0) named.push(`${more} other kind${more === 1 ? '' : 's'} of item`)
  const joined = named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
  return `${joined} came into your inventory`
}

/**
 * 261018 (pass 16 review): one line for a run of arrivals. The snapshot
 * composer reports a gain on every tick that has one, and in normal work
 * most of them are blocks her own walking digs out (goTo and follow explain
 * no gain, see snapshot.js splitOwnInventoryChanges) and mob drops. In one
 * scripted errands session 8 of the 10 game: lines in the record were "1 dirt
 * came into your inventory" and the like, and the record keeps only
 * SESSION_EVENT_CAPACITY lines, so they pushed out the kill and the dig the
 * player asks about later. Arrivals with nothing said in between now add up
 * into one line. A line said by either side starts a new one, so an arrival
 * after her "i have zero items" still sits after that line.
 *
 * @param {{
 *   record: (text: string, opts: {key: string, windowMs: number, again: string}) => unknown,
 *   spokeBetween: (fromMs: number, toMs: number) => boolean,
 *   now?: () => number,
 *   windowMs?: number,
 * }} deps
 * @returns {(gains: Array<{item:string, n:number}>) => void}
 */
export function createInventoryGainRecorder({ record, spokeBetween, now = () => Date.now(), windowMs = ACTION_COALESCE_MS }) {
  /** @type {{ id: number, startAt: number, lastAt: number, counts: Map<string, number> } | null} */
  let run = null
  let seq = 0
  return (gains) => {
    const list = (Array.isArray(gains) ? gains : [])
      .filter((g) => g && typeof g.item === 'string' && g.item && Number.isFinite(g.n) && g.n > 0)
    if (!list.length) return
    const t = now()
    let spoke = false
    if (run) { try { spoke = !!spokeBetween(run.startAt, t) } catch { spoke = true } }
    if (!run || spoke || t - run.lastAt > windowMs) run = { id: ++seq, startAt: t, lastAt: t, counts: new Map() }
    for (const g of list) run.counts.set(g.item, (run.counts.get(g.item) ?? 0) + g.n)
    run.lastAt = t
    const text = describeInventoryGain([...run.counts].map(([item, n]) => ({ item, n })))
    // `again` is the same text: a folded run reads as its added-up counts,
    // not "..., more than once".
    if (text) record(text, { key: `inv-gain:${run.id}`, windowMs, again: text })
  }
}

/**
 * The fact line for a game's own notice (Stardew's new day, 10 PM). The
 * notice itself is written as an instruction to the model ("[A new day:
 * spring 3, sunny. Your energy and health are full. ... This is a game event,
 * not the player talking; act on it ...]"), and clipped into the transcript it
 * read as a cut-off order. The record keeps only what happened: the adapter's
 * own `fact` when it sends one, else the notice's first sentence.
 *
 * @param {{text?: string, fact?: string}} data
 * @returns {string}
 */
export function gameEventFact(data) {
  const fact = String(data?.fact ?? '').trim()
  if (fact) return fact
  let t = String(data?.text ?? '').replace(/\s+/g, ' ').trim()
  t = t.replace(/^\[\s*/, '').replace(/\s*\]$/, '')
  const end = t.search(/[.!?](\s|$)/)
  if (end > 0) t = t.slice(0, end)
  return t.trim()
}

/**
 * Ring of event lines. `key` + `windowMs` fold a repeat into the entry
 * before it instead of filling the ring; the folded entry then reads as
 * `again` ("a zombie kept hitting you"), or the text plus "more than once".
 * No count: what reaches the brain is throttled, so a count would be wrong.
 */
export function createSessionEventLog({ capacity = SESSION_EVENT_CAPACITY, now = () => Date.now() } = {}) {
  /** @type {Array<{at:number, lastAt:number, text:string, again:string|null, key:string|null, n:number}>} */
  const entries = []

  function record(text, { key = null, windowMs = 0, again = null } = {}) {
    const t = clip(text)
    if (!t) return false
    const at = now()
    if (key && windowMs > 0) {
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]
        if (e.key !== key) continue
        if (at - e.lastAt <= windowMs) {
          e.n += 1
          e.lastAt = at
          // Numbers are blanked in action keys, so keep the newest wording
          // ("got 5/5 oak_log", not the "3/5" from the first pass).
          e.text = t
          if (again) e.again = clip(again)
          return true
        }
        break
      }
    }
    entries.push({ at, lastAt: at, text: t, again: again ? clip(again) : null, key, n: 1 })
    while (entries.length > capacity) entries.shift()
    return true
  }

  /** Oldest first: [{at, text}], a folded repeat worded as one. */
  function list() {
    return entries.map((e) => ({
      at: e.at,
      text: e.n > 1 ? (e.again ?? `${e.text}, more than once`) : e.text,
    }))
  }

  return { record, list, get size() { return entries.length }, _internal: { entries } }
}
