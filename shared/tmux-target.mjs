export function exactTmuxTarget(session) {
  const value = String(session || '')
  return value.startsWith('=') ? value : `=${value}`
}

export function exactTmuxWindowTarget(session) {
  const value = String(session || '')
  if (value.startsWith('=')) return value.includes(':') ? value : `${value}:`
  return `=${value}:`
}

export function exactTmuxTargets(args) {
  const sessionCommands = new Set(['attach', 'attach-session', 'has-session', 'kill-session'])
  const target = sessionCommands.has(args[0]) ? exactTmuxTarget : exactTmuxWindowTarget
  return args.map((arg, index) => args[index - 1] === '-t' ? target(arg) : arg)
}
