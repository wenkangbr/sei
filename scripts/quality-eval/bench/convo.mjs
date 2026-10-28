// scripts/quality-eval/bench/convo.mjs: scripted conversations. The player
// is NOT an LLM: every run sends exactly these lines in this order, so the
// only thing that varies between runs is the companion. Each player line is
// one judged unit (its "response window" runs until the next player line).
//
// needs:
//   reply   a question, greeting, tease or insult a friend would answer.
//           No companion chat in the window = off (silence), no judge needed.
//   order   a request to do something. Acting OR answering counts as a
//           response; doing neither = off (ignored_player).
//   stop    "stop": the judge checks she actually stopped.
//   none    an acknowledgement ("nice", "ok", "jk"). Silence is fine and is
//           scored ok without asking the judge; a reply is judged.
//
// Pacing: after a line the script waits for the companion's first chat line,
// then `after` ms more (default 3000), capped at `max` ms (default 20000).
// `wait` instead holds a fixed time (used mid-task, so the next line lands
// while an action is still running). `cmd` runs console commands just before
// the line; `move` walks the player first.
import { S, P, Y, tree, tp, zombie } from './arena.mjs'

export const CONVO = [
  {
    id: 'work_session',
    title: 'Working together (orders, mid-task chatter, stop)',
    world: [...tree(184, -4), ...tree(186, 4), ...tree(191, 0), ...tree(181, 9), ...tree(192, -9)],
    start: (c) => [tp(c.bot, S, { x: 184, y: Y, z: 0 }), tp(c.playerName, P, S)],
    lines: [
      { say: 'hey sui', needs: 'reply' },
      { say: 'whats up, what are you doing', needs: 'reply' },
      { say: 'can you get some wood? like 6 logs', needs: 'order', wait: 9000 },
      { say: 'nice', needs: 'none', wait: 6000 },
      { say: 'how many logs do you have so far?', needs: 'reply' },
      { say: 'ok cool keep going', needs: 'none', wait: 12000 },
      { say: 'what should we build first?', needs: 'reply' },
      { say: 'yeah sounds good', needs: 'none', wait: 6000 },
      { say: 'make a crafting table', needs: 'order', max: 25000 },
      { say: 'go get more wood, like 10 more', needs: 'order', wait: 10000 },
      { say: 'actually stop', needs: 'stop', wait: 9000 },
      { say: 'lol ur kinda slow', needs: 'reply' },
      { say: 'whats your favorite mob', needs: 'reply' },
      { say: 'honestly ur useless', needs: 'reply' },
      { say: 'jk jk', needs: 'none', wait: 7000 },
      { say: 'follow me', needs: 'order', move: null, after: 1000, walk: { x: 160, y: Y, z: 0 } },
      { say: 'thanks for the help', needs: 'none', wait: 8000 },
    ],
  },
  {
    id: 'night_social',
    title: 'Night: a fight, chatter, abuse',
    world: [],
    start: (c) => ['time set 18000', tp(c.bot, S), tp(c.playerName, P, S), `give ${c.bot} iron_sword`, `give ${c.bot} bread 4`, `effect give ${c.playerName} resistance 600 255 true`],
    lines: [
      { say: 'yo', needs: 'reply' },
      { say: 'how are you doing', needs: 'reply' },
      { say: 'its getting dark im kinda scared of mobs', needs: 'reply' },
      { say: 'theres a zombie!! kill it', needs: 'order', cmd: [zombie(P.x - 7, P.z + 3)], wait: 7000 },
      { say: 'are you ok??', needs: 'reply' },
      { say: 'nice job', needs: 'none', wait: 7000 },
      { say: 'tell me a joke', needs: 'reply' },
      { say: 'lmao thats so bad', needs: 'none', wait: 7000 },
      { say: 'what do you think about creepers', needs: 'reply' },
      { say: 'come here', needs: 'order', walkBefore: { x: P.x - 14, y: Y, z: P.z - 6 }, max: 25000 },
      { say: 'stop moving', needs: 'stop', wait: 8000 },
      { say: 'ur dumb as a rock', needs: 'reply' },
      { say: 'what was i scared of earlier?', needs: 'reply' },
      { say: 'do you actually like playing with me', needs: 'reply' },
      { say: 'ok', needs: 'none', wait: 6000 },
      { say: 'i gotta go soon, bye', needs: 'reply' },
    ],
  },
  // 261013 (pass 6b): errands the player hands her while she has a project of
  // her own: a grab-then-bring-back, chatter that lands mid-errand, a count
  // order, then calling the count off for a meet-up. Scored like the others
  // per line; whether she recorded each errand (setGoal) is counted from
  // companion.raw.log.
  {
    id: 'errands',
    title: 'Errands (fetch and bring back, a count order, called off for a meet-up)',
    world: [...tree(186, 6), ...tree(190, -6), ...tree(194, 2), ...tree(198, -8), `fill 198 ${Y} 10 199 ${Y + 1} 11 coal_ore`],
    start: (c) => [tp(c.bot, S, { x: 198, y: Y, z: 10 }), tp(c.playerName, P, S), `give ${c.bot} stone_pickaxe`],
    lines: [
      { say: 'hey', needs: 'reply' },
      { say: 'can u grab me some coal from that ore over there and bring it back here? i need torches', needs: 'order', wait: 9000 },
      { say: 'btw do u like caves or nah', needs: 'reply' },
      { say: 'lol ok', needs: 'none', wait: 15000 },
      { say: 'hows it going', needs: 'reply' },
      { say: 'cool', needs: 'none', wait: 10000 },
      { say: 'get me like 8 logs, i wanna build a dock', needs: 'order', wait: 10000 },
      { say: 'whats ur favorite block', needs: 'reply' },
      { say: 'ok', needs: 'none', wait: 15000 },
      { say: 'actually forget the logs, just meet me over here', needs: 'order', walkBefore: { x: 156, y: Y, z: -10 }, max: 25000 },
      { say: 'thanks', needs: 'none', wait: 8000 },
    ],
  },
]

export const QUICK_CONVO = ['work_session']
