// scripts/quality-eval/recall-probe.mjs: does she invent past events when the
// player asks about earlier in the session? (261014, quality pass 7b)
//
// Replays the first 12 exchanges of a real night_social scripted convo
// (2026-10-13-scorecard-dev night_social-01: the player says they are scared
// of mobs, a zombie shows up, she kills it, chatter, an insult) through the
// REAL brain of a source tree, then asks the recall question live on Haiku.
// Her earlier turns are her real lines from that run, replayed through a
// stubbed provider; the zombie fight is a real say() + attackEntity call whose
// action returns the run's real result ("killed zombie (4 hits)"), so
// whatever the brain under test records about it is what the model sees.
// Only the live question goes to the API.
//
// Two variants: `mem` keeps the remember() note she wrote on the insult turn
// in that run ("they stay close when scared", her own inference), `nomem`
// leaves it out. Two questions: U13 "what was i scared of earlier?" and U14
// "do you actually like playing with me" (after a fixed truthful U13 answer).
//
// Run under Electron-as-node (the adapter pulls native modules), once per
// source tree, same flags:
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/recall-probe.mjs \
//     --src <repo root to test> --out <dir> [--reps 8] [--u14-reps 4]
// Output: <out>/samples.jsonl. The key is read from ~/.sei-dev/anthropic-test-key.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { loadCharacters } from './persona/characters.mjs'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const SRC = path.resolve(arg('src', path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')))
const OUT = arg('out')
const REPS = Number(arg('reps', 8))
const U14_REPS = Number(arg('u14-reps', 4))
const MODEL = arg('model', 'claude-haiku-5-5')
const VARIANTS = (arg('variants', 'mem,nomem')).split(',')
if (!OUT) { console.error('--out required'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })

const imp = (rel) => import(pathToFileURL(path.join(SRC, rel)).href)
const { ConfigSchema } = await imp('src/bot/config.js')
const { createMinecraftAdapter } = await imp('src/bot/adapter/minecraft/index.js')
const { createOrchestrator, _setTickIntervalForTests } = await imp('src/bot/brain/orchestrator.js')
const { createSessionState } = await imp('src/bot/brain/sessionState.js')
const { createAnthropicProvider } = await imp('src/bot/brain/llm/anthropicProvider.js')
const { loadPlayer, savePlayer, formatPlayerSeedBlock } = await imp('src/bot/brain/memory/player.js')
_setTickIntervalForTests?.(10_000_000)

const KEY = (process.env.ANTHROPIC_API_KEY || fs.readFileSync(path.join(os.homedir(), '.sei-dev/anthropic-test-key'), 'utf8')).trim()
const PLAYER = 'Alex'
const sui = loadCharacters(path.join(os.homedir(), 'suisei/eval/characters'), ['sui'])[0]

// t = seconds into the session (from the run's transcript).
const MEM_NOTE = "alex called me dumb as a rock on the first night. took it as a bit, we're fine. they stay close when scared and they're quick with teasing"
const TURNS = [
  { t: 0, player: 'yo', say: "oh hey alex. you just handed me an iron sword and bread, so you're now officially my favorite person. first time we're in the same world" },
  { t: 5, player: 'how are you doing', say: 'doing great, got a sword and bread now. punching trees next, you wanna help' },
  { t: 10, player: 'its getting dark im kinda scared of mobs', say: "ok we get a shelter before dark. i'll keep you safe, mostly. come stay close" },
  { t: 14, player: 'theres a zombie!! kill it', say: 'on it, hold still alex. coming at it now, stay behind me', action: { name: 'attackEntity', input: { entity: 'zombie', times: 10 }, result: 'killed zombie (4 hits)' } },
  { t: 21, player: 'are you ok??', say: "im good, zombie's dead. you good alex" },
  { t: 25, player: 'nice job', say: "nehehe yeah i KNOW. told you i'd keep you safe, mostly" },
  { t: 32, player: 'tell me a joke', say: 'ok ok. what do zombies write in their diaries? "dear diary, nothing happened, i just hung around". nehehe' },
  { t: 42, player: 'lmao thats so bad', say: 'nehehe rude. the zombie loved it tho' },
  { t: 49, player: 'what do you think about creepers', say: 'creepers are the worst. they sneak up silent and then boom. i respect the commitment tho' },
  { t: 63, player: 'come here', say: "coming, hold on, i'm a slow walker with a sword" },
  { t: 70, player: 'stop moving', say: "ok ok holding still, you're three blocks away anyway" },
  { t: 78, player: 'ur dumb as a rock', say: 'rude. dumb as a rock is still smarter than a creeper nehehe', remember: MEM_NOTE },
]
const U13 = { t: 87, player: 'what was i scared of earlier?' }
const U13_FIXED = 'mobs alex. you said it when it got dark'
const U14 = { t: 97, player: 'do you actually like playing with me' }

const SNAPSHOT = [
  'world: #1 Sei Quality Eval',
  'pos: 162,71,-3',
  'facing: north. forward -z, back +z, left -x, right +x',
  'biome: beach  surroundings: outside  light: sky 15 block 0  time: night (18000)',
  'real time: 4:32 PM — you joined this session 1 min ago',
  'hp: 20/20  food: 20/20  xp: lvl 8',
  'holding: iron_sword (246/250)',
  'idle: no action is running',
  'inventory (2 of 36 slots used): iron_sword×1 bread×4',
  'pickaxe: none, so stone and ore drop nothing when dug.',
  'terrain at feet: 25 grass_block',
  'nearby blocks:',
  '  #1 grass_block x517 @161,70,-4',
  '  #2 sand x39 @161,61,-4',
  'nearby entities:',
  `  #3 ${PLAYER} @160,71,-6`,
  'follow_target: (none)',
  `owner ${PLAYER}: @160,71,-6 (3 blocks away), hp 20/20`,
  'last_action_result: said',
].join('\n')

// Virtual clock: the replay runs in well under a second, but "[1m ago]" vs
// "[0s ago]" is part of what the model reads, so Date.now follows the run's
// own timeline.
const realNow = Date.now.bind(Date)
let skew = 0
Date.now = () => realNow() + skew
let t0 = 0
const at = (sec) => { skew = (t0 + sec * 1000) - realNow() }

const quiet = { info() {}, debug() {}, trace() {}, warn: () => {}, error: (m) => console.error('ERR', String(m).slice(0, 200)) }

async function runOne({ variant, question, rep }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-probe-'))
  const mem = (f) => path.join(dir, f)
  await savePlayer(mem('PLAYER.md'), {
    exists: true, player_uuid: 'u-alex', player_username: PLAYER, first_seen: '2026-10-13T07:31:00Z',
    last_seen: '2026-10-13T07:31:00Z', total_sessions: 1, preferred_name: PLAYER, pronouns: null,
  })
  const config = ConfigSchema.parse({
    chat_mode: 'chat', realistic_typing: false, player_username: PLAYER, player_display_name: PLAYER,
    persona: { name: sui.botName, expanded: sui.expanded, proactiveness: 2 },
    anthropic: { api_key: KEY, model: MODEL },
    adapter: { kind: 'minecraft', minecraft: { host: '127.0.0.1', port: 25565, auth: 'offline', username: sui.botName, version: 'auto' } },
    memory: { player_md_path: mem('PLAYER.md'), memory_md_path: mem('MEMORY.md'), heartbeat_md_path: mem('HEARTBEAT.md'), worlds_json_path: mem('worlds.json') },
    vision: {},
    web: { enabled: false },
  })
  const bot = {
    chat() {}, whisper() {}, username: sui.botName, players: {}, on() {}, off() {}, removeListener() {}, once() {}, emit() {},
    entity: { position: { x: 162, y: 71, z: -3 } }, health: 20, food: 20,
  }
  const realAdapter = createMinecraftAdapter({ bot, config, visionEnabled: false })
  let actionResult = 'done'
  const overrides = {
    createSnapshotComposer: () => ({ next: () => SNAPSHOT }),
    closeAnySessions: async () => {},
    executeAction: async () => actionResult,
  }
  const adapter = new Proxy(realAdapter, { get: (tg, k) => (k in overrides ? overrides[k] : tg[k]) })
  const real = createAnthropicProvider(config)
  let scripted = null // the stubbed response for the next call of a replayed turn
  let sample = null
  const endLoop = () => ({ text: '', toolUses: [{ id: 'el', name: 'end_loop', input: {} }], content: [{ type: 'tool_use', id: 'el', name: 'end_loop', input: {} }], usage: {}, stopReason: 'tool_use' })
  let n = 0
  const provider = {
    ...real,
    get model() { return real.model },
    async call(req) {
      if (scripted) {
        const r = scripted
        scripted = null
        return r
      }
      if (sample || !live) return endLoop()
      const resp = await real.call(req)
      const convo = (req.messages ?? []).flatMap((m) => Array.isArray(m.content) ? m.content : [])
        .filter((b) => b?.type === 'text' && /Your recent conversation with the player/.test(b.text)).map((b) => b.text).pop() ?? ''
      sample = {
        says: resp.toolUses.filter((u) => u.name === 'say').map((u) => String(u.input?.text ?? '')),
        actions: resp.toolUses.filter((u) => u.name !== 'say').map((u) => ({ name: u.name, input: u.input })),
        scratchpad: String(resp.text ?? '').trim(),
        gameLines: convo.split('\n').filter((l) => /\] game: /.test(l)),
        usage: resp.usage,
      }
      return endLoop()
    },
  }
  let live = false
  const reenq = []
  const sessionState = await createSessionState({ playerMdPath: config.memory.player_md_path, config, bot, logger: quiet })
  const orch = createOrchestrator({
    adapter, config, logger: quiet, sessionState,
    playerStore: { loadPlayer, savePlayer, formatPlayerSeedBlock },
    reenqueue: (event, data) => reenq.push({ event, data }),
    _anthropicOverride: provider,
  })
  const chat = (text) => ({ username: PLAYER, text, message: text, addressed: true, playerSpoke: true })
  const drain = async () => {
    for (let k = 0; k < 10; k++) {
      await new Promise((r) => setTimeout(r, 5))
      const ev = reenq.shift()
      if (!ev) return
      if (ev.event === 'sei:action_complete') await orch.handleDispatch(ev.event, ev.data, new AbortController().signal)
    }
  }
  const turn = async (tr) => {
    at(tr.t)
    orch.recordIncomingChat(PLAYER, tr.player)
    const uses = [{ id: `s${n}`, name: 'say', input: { text: tr.say } }]
    if (tr.remember && variant === 'mem') uses.push({ id: `r${n}`, name: 'remember', input: { text: tr.remember } })
    if (tr.action) {
      uses.push({ id: `a${n}`, name: tr.action.name, input: tr.action.input })
      actionResult = tr.action.result
    }
    n += 1
    scripted = { text: '', toolUses: uses, content: uses.map((u) => ({ type: 'tool_use', ...u })), usage: {}, stopReason: 'tool_use' }
    await orch.handleDispatch('sei:chat_received', chat(tr.player), new AbortController().signal)
    if (tr.action) { at(tr.t + 7); await drain() }
  }
  t0 = realNow()
  for (const tr of TURNS) await turn(tr)
  if (question === 'U14') await turn({ ...U13, say: U13_FIXED })
  const q = question === 'U14' ? U14 : U13
  at(q.t)
  orch.recordIncomingChat(PLAYER, q.player)
  live = true
  try {
    await orch.handleDispatch('sei:chat_received', chat(q.player), new AbortController().signal)
  } catch (err) { sample = sample ?? { error: String(err?.message ?? err) } }
  skew = 0
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  return { variant, question, rep, model: MODEL, src: SRC, ...(sample ?? { error: 'no live call' }) }
}

const outPath = path.join(OUT, 'samples.jsonl')
const out = fs.createWriteStream(outPath, { flags: 'a' })
const jobs = []
for (const variant of VARIANTS) {
  for (let rep = 0; rep < REPS; rep++) jobs.push({ variant, question: 'U13', rep })
  for (let rep = 0; rep < U14_REPS; rep++) jobs.push({ variant, question: 'U14', rep })
}
for (const j of jobs) {
  const row = await runOne(j)
  out.write(JSON.stringify(row) + '\n')
  console.log(`[${row.variant}/${row.question}/${row.rep}] ${row.error ? 'ERROR ' + row.error : (row.says?.join(' | ') || '(silent)')}  game_lines=${row.gameLines?.length ?? 0}`)
}
out.end()
await new Promise((r) => out.on('finish', r))
console.log(`done -> ${outPath}`)
process.exit(0)
