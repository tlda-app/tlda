/**
 * Calls that do not appear in the activity feed.
 *
 * Skip, 2026-08-25: "the point is i want visibility into what agents are doing.
 * no big if a little excess becomes visible we will trim."
 *
 * So this is not a list of tools someone found uninteresting. There are exactly
 * two reasons to be on it, and a tool that fits neither belongs in the feed:
 *
 * 1. **It reads state.** Checking your inbox, your tasks, or who is awake is
 *    not something an agent DID -- it is how it decided what to do next.
 * 2. **Its effect is already in chat.** A sent message shows up as the message;
 *    a timer shows up as its own card. Rendering the call as well says the same
 *    thing twice in the same panel.
 *
 * Everything else an agent does to the fleet -- delegating, spawning, reporting,
 * naming, labelling, interrupting -- is an action with a consequence, and it was
 * invisible. That is what this list had grown into: it was written when tlda
 * calls were chatter, and by now they are much of what an agent does.
 */
export const ACTIVITY_NOISE = new Set([
  // Reads: state an agent consulted, not work it performed.
  'wait_for_task', 'my_task', 'inbox', 'tasks', 'login', 'task_check', 'observe',
  'mcp__tlda__wait_for_task', 'mcp__tlda__my_task', 'mcp__tlda__inbox',
  'mcp__tlda__tasks', 'mcp__tlda__login', 'mcp__tlda__task_check',
  'mcp__tlda__observe',
  // Already visible: the message IS the message, the timer draws its own card.
  'chat', 'timer',
  'mcp__tlda__chat', 'mcp__tlda__timer',
  // Harness plumbing: loading a tool's schema is not an act.
  'ToolSearch',
])

export const PRETTY_PRINT_TOOLS = new Set([
  'mcp__tlda__inbox',
  'mcp__tlda__search',
  'mcp__tlda__thread',
  'tlda/inbox',
  'tlda__inbox',
  'tlda__search',
  'tlda__thread',
  'inbox',
  'search',
  'thread',
  'ScheduleWakeup',
  'mcp__tlda__screenshot',
  'tlda__screenshot',
  'screenshot',
  'mcp__tlda__propose_edit',
  'tlda__propose_edit',
  'propose_edit',
  'region_transfer',
])

export function toolBaseName(name) {
  return String(name || '').split('__').pop()
}

export function humanToolName(name) {
  return String(name || '').replace(/^mcp__/, '').replace(/__/g, '/')
}

export function isPrettyPrintTool(name) {
  return PRETTY_PRINT_TOOLS.has(name) || PRETTY_PRINT_TOOLS.has(toolBaseName(name))
}

/**
 * Tools whose card is BUILT OUT OF the result, so the result has to survive the
 * trip to the browser.
 *
 * This is a narrower fact than PRETTY_PRINT_TOOLS above, and the two are not
 * interchangeable. Most pretty-print cards re-read what they show at render
 * time -- Skip, 2026-09-12: "search and thread don't need pretty bodies because
 * they pull data from the actual database in the rendering code." A region
 * transfer cannot: its arguments carry line numbers rather than text, so the
 * diff the card is made of exists nowhere but the result string.
 *
 * Adding a tool here changes what appears in everyone's chat, which is Skip's
 * decision and not a tidying one. It is not the place to put a tool because its
 * result "would be nice to have".
 */
export const RESULT_BEARING_CARDS = new Set([
  'region_transfer',
])

export function cardIsBuiltFromResult(name) {
  const human = humanToolName(name)
  return RESULT_BEARING_CARDS.has(human.split('/').pop())
}
