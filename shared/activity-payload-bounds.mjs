const DEFAULT_STRING_LIMIT = 16_000
const DEFAULT_DEPTH_LIMIT = 6
const DEFAULT_ARRAY_LIMIT = 80
const DEFAULT_OBJECT_KEYS_LIMIT = 120

function truncateString(value, limit) {
  if (typeof value !== 'string' || value.length <= limit) return value
  const omitted = value.length - limit
  return `${value.slice(0, limit)}\n[truncated ${omitted} chars]`
}

export function boundActivityPayload(value, options = {}, depth = 0) {
  const stringLimit = options.stringLimit ?? DEFAULT_STRING_LIMIT
  const depthLimit = options.depthLimit ?? DEFAULT_DEPTH_LIMIT
  const arrayLimit = options.arrayLimit ?? DEFAULT_ARRAY_LIMIT
  const objectKeysLimit = options.objectKeysLimit ?? DEFAULT_OBJECT_KEYS_LIMIT

  if (value == null) return value
  if (typeof value === 'string') return truncateString(value, stringLimit)
  if (typeof value !== 'object') return value
  if (depth >= depthLimit) return '[truncated nested value]'

  if (Array.isArray(value)) {
    const out = value.slice(0, arrayLimit).map(item => boundActivityPayload(item, options, depth + 1))
    if (value.length > arrayLimit) out.push(`[truncated ${value.length - arrayLimit} array items]`)
    return out
  }

  const out = {}
  const entries = Object.entries(value)
  for (const [key, item] of entries.slice(0, objectKeysLimit)) {
    out[key] = boundActivityPayload(item, options, depth + 1)
  }
  if (entries.length > objectKeysLimit) out.__truncatedKeys = entries.length - objectKeysLimit
  return out
}

export function boundActivityMetadata({ tool, arg, input, usage, prettyResult, origTool, activityLatency }) {
  return {
    tool: tool || '',
    arg: boundActivityPayload(arg || ''),
    input: input == null ? null : boundActivityPayload(input),
    activityLatency,
    ...(usage ? { usage: boundActivityPayload(usage) } : {}),
    ...(prettyResult ? { prettyResult: boundActivityPayload(prettyResult) } : {}),
    ...(origTool ? { origTool } : {}),
  }
}
