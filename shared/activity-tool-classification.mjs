export const ACTIVITY_NOISE = new Set([
  'wait_for_task', 'my_task', 'inbox', 'tasks', 'login',
  'task_check', 'task_done', 'timer',
  'chat', 'delegate', 'report', 'share', 'spawn', 'respawn', 'interrupt',
  'name_agent', 'label_agent', 'observe', 'promote', 'cleanup',
  'mcp__tlda__wait_for_task', 'mcp__tlda__my_task', 'mcp__tlda__inbox', 'mcp__tlda__tasks',
  'mcp__tlda__login', 'mcp__tlda__task_check',
  'mcp__tlda__timer',
  'mcp__tlda__chat', 'mcp__tlda__delegate', 'mcp__tlda__report',
  'mcp__tlda__share', 'mcp__tlda__spawn', 'mcp__tlda__respawn',
  'mcp__tlda__interrupt', 'mcp__tlda__name_agent', 'mcp__tlda__label_agent',
  'mcp__tlda__observe', 'mcp__tlda__promote', 'mcp__tlda__cleanup',
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
