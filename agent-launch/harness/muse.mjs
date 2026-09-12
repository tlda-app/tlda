import { resolveModelSpec } from '../models.mjs'

export const capabilities = Object.freeze({
  headlessJson: true,
  nativeResume: true,
  nativeCancellation: true,
  fleetReady: false,
  fleetBlocker: 'Muse Code 1.1.1 through OpenRouter has not successfully invoked TLDA MCP tools.',
})

function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export function resolveModelSelection(model, options = {}) {
  const spec = resolveModelSpec(model, options)
  if (spec.harness !== 'muse') {
    throw new Error(`daemon model "${model}" is configured for harness "${spec.harness}", not "muse"`)
  }
  return { model: spec.id, provider: spec.provider, alias: spec.alias, tags: spec.tags, table: 'daemon', spec }
}

export function resolveModel(model, options = {}) {
  return resolveModelSelection(model, options).model
}

export function resumeId(handle) {
  return handle?.sessionId || null
}

export function buildArgs({
  model,
  cwd,
  effort,
  prompt,
  headless = false,
  resumeId: previous = null,
  freshSessionId = null,
  harnessOptions = {},
} = {}) {
  if (!model) throw new Error('Muse model is required')
  if (!cwd) throw new Error('Muse workspace is required')
  if (headless && previous) throw new Error('Muse exec has no verified resume flag; use native resume or MSP session/resume')
  if (freshSessionId && !headless) throw new Error('Exact session IDs are supported by Muse exec and MSP, not the verified TUI flags')
  const args = headless ? ['exec', '--json'] : []
  args.push('--model', model, '--workspace', cwd)
  if (effort) args.push('--reasoning-effort', effort)
  for (const flag of [...(harnessOptions.required || []), ...(harnessOptions.preferences || [])]) {
    if (typeof flag === 'string' && flag.trim()) args.push(flag)
  }
  if (freshSessionId) args.push('--session-id', freshSessionId)
  if (previous) {
    if (prompt) throw new Error('A prompt on Muse resume has not been verified; resume without injecting a new turn')
    args.push('resume', previous)
  } else if (prompt != null) args.push(prompt)
  return args
}

export function buildCmd(options = {}) {
  if (options.fleetId || options.localAgentId) throw new Error(capabilities.fleetBlocker)
  const args = buildArgs(options)
  const assignments = Object.entries(options.harnessOptions?.env || {}).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable: ${key}`)
    if (key === 'META_API_KEY' || key === 'OPENROUTER_API_KEY') {
      throw new Error('Supply provider credentials through the process environment, not launch configuration')
    }
    return `${key}=${sq(value)}`
  })
  const command = [
    ...assignments,
    'META_API_KEY="${OPENROUTER_API_KEY:?OPENROUTER_API_KEY is required}"',
    'muse',
    ...args.map(sq),
  ].join(' ')
  return `zsh -lc ${sq(command)}`
}
