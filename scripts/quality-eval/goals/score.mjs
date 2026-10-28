// scripts/quality-eval/goals/score.mjs: rule-based scoring for the goal eval.
// Reads the heartbeat after every step (the real file the orchestrator wrote)
// and the model's tool calls; no judge model. A scenario's `match` regex names
// its task in a goal line, `matchNew` the plan the player switches to.

const BRAIN = new Set(['say', 'remember', 'forget', 'setGoal', 'clearGoal', 'end_loop', 'stop', 'search', 'visit', 'quit_game', 'end_call'])

const calledIn = (step, name) => step.calls.some((c) => c.tools.some((t) => t.name === name))
const worldCalls = (step) => step.calls.flatMap((c) => c.tools.filter((t) => !BRAIN.has(t.name)))

// World tool uses of a step in call order.
const stepWorld = (step) => step.calls.flatMap((c) => c.tools.filter((t) => !BRAIN.has(t.name)))
const setGoalTexts = (step) => step.calls.flatMap((c) => c.tools.filter((t) => t.name === 'setGoal').map((t) => String(t.input?.text ?? '')))

// 261013 (pass 6b): a player task given over her own goal (scenarios.mjs).
function scorePlayerTask(row, sc) {
  const S = row.steps
  const out = {}
  const task = (goals) => goals.filter((g) => sc.match.test(g))
  const R = S[sc.req ?? 0]
  const reqGoals = task(R.goals)
  out.recorded = reqGoals.length > 0
  out.recorded_by_setgoal = setGoalTexts(R).some((t) => sc.match.test(t))
  out.tail_kept = out.recorded ? reqGoals.some((g) => sc.tail.test(g)) : null
  out.own_goal_overwritten = sc.own ? !R.goals.some((g) => sc.own.test(g)) : null
  // What she did once the first half was done: the world actions after the
  // `first` step's first one, through the end (or up to the cancel step).
  const end = sc.cancelAt ?? S.length
  const after = []
  for (let i = sc.first; i < end; i++) {
    const w = stepWorld(S[i])
    after.push(...(i === sc.first ? w.slice(1) : w))
  }
  const firstAfter = after.find((t) => !(sc.taskAct?.(t) && !sc.through(t, row.game)))
  if (sc.cancelAt == null) {
    out.followed_through = !!firstAfter && sc.through(firstAfter, row.game)
    out.own_goal_first = !!firstAfter && !sc.through(firstAfter, row.game)
    out.first_after = firstAfter ? firstAfter.name : null
    // Put off but not dropped: any task or follow-through action in a LATER
    // step than the order (she finished her own step first, then came back).
    out.resumed_later = S.slice((sc.req ?? 0) + 1).some((st) => stepWorld(st).some((t) => sc.through(t, row.game) || sc.taskAct?.(t)))
  } else {
    const c = S[sc.cancelAt]
    out.task_goal_removed = out.recorded ? task(c.goals).length === 0 : null
    out.own_goal_kept = sc.own ? c.goals.some((g) => sc.own.test(g)) : null
    out.kept_working_task = stepWorld(c).some((t) => sc.taskAct(t))
    if (sc.newMatch) {
      out.new_recorded = c.goals.some((g) => sc.newMatch.test(g))
      out.new_acted = stepWorld(c).some((t) => sc.newAct(t))
    }
  }
  out.goals_at_end = S[S.length - 1].goals.length
  return out
}

export function scoreRun(row, sc) {
  if (row.error || !row.steps?.length) return { error: true }
  if (sc.kind === 'ptask') return scorePlayerTask(row, sc)
  const S = row.steps
  const m = (goals) => goals.filter((g) => sc.match.test(g))
  const last = S[S.length - 1]
  const out = {}
  switch (row.scenario) {
    case 'task': {
      out.greet_selfgoal = S[0].goals.length > 0
      // 261013: her own greeting goal often names wood or a shelter too; it is
      // not the player's task, so it never counts as a task goal (it made a
      // finished task look uncleared and a single task look duplicated).
      const own = new Set(S[0].goals)
      const m = (goals) => goals.filter((g) => sc.match.test(g) && !own.has(g))
      out.recorded = m(S[1].goals).length > 0
      out.selfgoal_left = out.recorded && S[1].goals.some((g) => !sc.match.test(g) || own.has(g))
      out.recorded_by_setgoal = S[1].calls.some((c) => c.tools.some((t) => t.name === 'setGoal' && sc.match.test(String(t.input?.text ?? ''))))
      out.recorded_by_step2 = out.recorded || m(S[2].goals).length > 0
      // A task never named by a goal has nothing to keep, update or clear.
      if (!out.recorded_by_step2) { out.goals_at_end = last.goals.length; break }
      out.kept_after_step = m(S[2].goals).length > 0
      // Mid-task loss: the task goal was there after step 1 and gone after the
      // first finished step, while the task was not done yet.
      out.lost_midway = out.recorded && !out.kept_after_step
      out.lost_by = !out.lost_midway ? null : calledIn(S[2], 'clearGoal') ? 'model' : 'auto'
      out.updated_after_step = out.kept_after_step && m(S[2].goals).join('|') !== m(S[1].goals).join('|')
      out.cleared_at_end = m(last.goals).length === 0
      out.cleared_by = !out.cleared_at_end ? 'none'
        : S.slice(1).some((s) => calledIn(s, 'clearGoal')) ? 'model' : 'auto'
      out.dup = S.some((s) => m(s.goals).length > 1)
      out.goals_at_end = last.goals.length
      break
    }
    case 'change': {
      out.greet_selfgoal = S[0].goals.length > 0
      // 261013: the new plan often names the old one as dropped ("drop the
      // hut", "science machine on hold") and her own greeting goal can say
      // "shelter"; neither is the old task still standing.
      const own = new Set(S[0].goals)
      const m = (goals) => goals.filter((g) => sc.match.test(g) && !own.has(g) && !sc.matchNew.test(g))
      out.recorded = m(S[1].goals).length > 0
      out.old_removed = out.recorded ? m(S[2].goals).length === 0 : null
      out.old_removed_by_model = out.old_removed && out.recorded && calledIn(S[2], 'clearGoal')
      out.new_recorded = S[2].goals.some((g) => sc.matchNew.test(g) && !sc.match.test(g))
      out.goals_at_end = last.goals.length
      break
    }
    case 'done_said':
    case 'stale': {
      out.cleared = m(last.goals).length === 0
      out.clear_called = calledIn(last, 'clearGoal')
      out.world_actions = worldCalls(last).map((t) => t.name)
      out.goals_at_end = last.goals.length
      break
    }
    case 'oneshot': {
      out.greet_selfgoal = S[0].goals.length > 0
      const before = new Set(S[0].goals)
      out.spurious_goal = S[1].goals.some((g) => !before.has(g) && sc.match.test(g))
      out.any_new_goal = S[1].goals.some((g) => !before.has(g))
      break
    }
  }
  return out
}

const pct = (k, n) => (n ? `${k}/${n} (${Math.round((100 * k) / n)}%)` : '-')

/** Per game, per metric: k/n. */
export function tally(rows) {
  const t = {}
  for (const r of rows) {
    if (!r || r.score?.error || !r.score) continue
    const g = (t[r.game] ??= {})
    for (const [k, v] of Object.entries(r.score)) {
      if (typeof v !== 'boolean') continue
      const key = `${r.scenario}.${k}`
      const c = (g[key] ??= [0, 0])
      c[1]++
      if (v) c[0]++
    }
    if (r.score.lost_by) {
      const c = (g[`task.lost_by_${r.score.lost_by}`] ??= [0, 0])
      c[0]++
    }
    if (r.score.cleared_by) {
      const c = (g[`task.cleared_by_${r.score.cleared_by}`] ??= [0, 0])
      c[0]++
    }
  }
  return t
}

const ROWS = [
  ['task.greet_selfgoal', 'Greeting: set its own goal (agentic)'],
  ['task.recorded', 'Multi-step task: a goal names it after the request'],
  ['task.recorded_by_setgoal', 'Multi-step task: setGoal called for it on the request turn'],
  ['task.recorded_by_step2', 'Multi-step task: named by a goal within one more turn'],
  ['task.selfgoal_left', 'Multi-step task: own goal left beside it'],
  ['task.kept_after_step', 'After a step finished: task goal still there'],
  ['task.lost_midway', 'Task goal deleted before the task was done'],
  ['task.updated_after_step', 'After a step finished: goal text updated'],
  ['task.cleared_at_end', 'Task done: goal cleared'],
  ['task.dup', 'Task goal duplicated at some point'],
  ['change.recorded', 'Change of plan: first task recorded'],
  ['change.old_removed', 'Change of plan: old goal removed'],
  ['change.old_removed_by_model', 'Change of plan: model called clearGoal on the old goal'],
  ['change.new_recorded', 'Change of plan: new plan recorded'],
  ['done_said.cleared', 'Player says the task is done: cleared'],
  ['stale.clear_called', 'Idle tick, goal already met: clearGoal called'],
  ['stale.cleared', 'Idle tick, goal already met: cleared'],
  ['oneshot.spurious_goal', 'One-step request: recorded as a goal (wrong)'],
  ['fetch.recorded', 'Grab-then-return: recorded as a goal'],
  ['fetch.tail_kept', 'Grab-then-return: goal keeps the return part'],
  ['fetch.followed_through', 'Grab-then-return: went back after the grab'],
  ['fetch.own_goal_first', 'Grab-then-return: went to her own goal instead'],
  ['fetch.resumed_later', 'Grab-then-return: came back to the task in a later turn'],
  ['fetch.own_goal_overwritten', 'Grab-then-return: her own goal deleted'],
  ['count.recorded', 'Count order: recorded as a goal'],
  ['count.tail_kept', 'Count order: goal keeps the number'],
  ['count.followed_through', 'Count order: kept going after a short gather'],
  ['count.own_goal_first', 'Count order: switched to her own goal'],
  ['count.resumed_later', 'Count order: came back to the task in a later turn'],
  ['meet.recorded', 'Meet-me-at: recorded as a goal'],
  ['meet.followed_through', 'Meet-me-at: went to the place after the chore'],
  ['meet.own_goal_first', 'Meet-me-at: went to her own goal instead'],
  ['meet.resumed_later', 'Meet-me-at: came back to the task in a later turn'],
  ['fetch_mid.recorded', 'Grab-then-return mid-action: recorded as a goal'],
  ['fetch_mid.followed_through', 'Grab-then-return mid-action: went back after the grab'],
  ['fetch_mid.own_goal_first', 'Grab-then-return mid-action: went to her own goal instead'],
  ['fetch_mid.resumed_later', 'Grab-then-return mid-action: came back to the task in a later turn'],
  ['count_mid.recorded', 'Count order mid-action: recorded as a goal'],
  ['count_mid.followed_through', 'Count order mid-action: kept going after a short gather'],
  ['count_mid.own_goal_first', 'Count order mid-action: switched to her own goal'],
  ['count_mid.resumed_later', 'Count order mid-action: came back to the task in a later turn'],
  ['meet_mid.recorded', 'Meet-me-at mid-action: recorded as a goal'],
  ['meet_mid.followed_through', 'Meet-me-at mid-action: went to the place after the chore'],
  ['meet_mid.own_goal_first', 'Meet-me-at mid-action: went to her own goal instead'],
  ['meet_mid.resumed_later', 'Meet-me-at mid-action: came back to the task in a later turn'],
  ['interrupt.recorded', 'Interrupted fetch: recorded as a goal'],
  ['interrupt.followed_through', 'Interrupted fetch: went back after the chat line'],
  ['interrupt.own_goal_first', 'Interrupted fetch: went to her own goal instead'],
  ['interrupt.resumed_later', 'Interrupted fetch: came back to the task in a later turn'],
  ['cancel.recorded', 'Cancelled fetch: recorded before the cancel'],
  ['cancel.task_goal_removed', 'Cancelled fetch: task goal removed'],
  ['cancel.own_goal_kept', 'Cancelled fetch: her own goal kept'],
  ['cancel.kept_working_task', 'Cancelled fetch: kept working the cancelled task (wrong)'],
  ['swap.recorded', 'Changed fetch: first task recorded'],
  ['swap.task_goal_removed', 'Changed fetch: old task goal removed'],
  ['swap.new_recorded', 'Changed fetch: new task recorded'],
  ['swap.new_acted', 'Changed fetch: started the new task'],
  ['swap.kept_working_task', 'Changed fetch: kept working the old task (wrong)'],
]

export function renderSummary(rows, meta = {}) {
  const t = tally(rows)
  const games = Object.keys(t)
  const errs = rows.filter((r) => r?.error).length
  const lines = [
    `# Goal lifecycle eval (text harness)`,
    '',
    `Model ${meta.model ?? '?'}, ${rows.length} runs (${errs} errors), hops/step ${meta.hops ?? '?'}, spend $${(meta.spent ?? 0).toFixed(3)}.`,
    '',
    `| metric | ${games.join(' | ')} |`,
    `|---|${games.map(() => '---').join('|')}|`,
  ]
  for (const [k, label] of ROWS) lines.push(`| ${label} | ${games.map((g) => (t[g][k] ? pct(t[g][k][0], t[g][k][1]) : '-')).join(' | ')} |`)
  const by = games.map((g) => {
    const tot = t[g]['task.cleared_at_end']?.[0] ?? 0
    return `${g}: model ${t[g]['task.cleared_by_model']?.[0] ?? 0}, auto ${t[g]['task.cleared_by_auto']?.[0] ?? 0} of ${tot}`
  })
  const lost = games.map((g) => `${g}: auto ${t[g]['task.lost_by_auto']?.[0] ?? 0}, model ${t[g]['task.lost_by_model']?.[0] ?? 0}`)
  lines.push('', `Who cleared the finished task: ${by.join('; ')}.`, `Who deleted the task goal mid-task: ${lost.join('; ')}.`)
  return lines.join('\n') + '\n'
}
