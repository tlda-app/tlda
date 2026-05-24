/**
 * Server-side logger — timestamped, leveled, namespaced.
 * Mirrors the API of src/logger.ts (browser-side) for consistency.
 *
 *   import { createLogger } from '../shared/logger.mjs'
 *   const log = createLogger('daemon')
 *   log.info('started')          // 2026-05-23T21:15:30.123Z [daemon] started
 *   log.warn('slow', { ms: 120 })// 2026-05-23T21:15:30.456Z [daemon] slow { ms: 120 }
 *   log.error('fail', err)       // 2026-05-23T21:15:30.789Z [daemon] fail Error: ...
 *
 * Levels: debug < info < warn < error
 * Default: info (debug suppressed unless TLDA_LOG=debug or TLDA_LOG=daemon:debug)
 */

const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 }

let _globalLevel = 'info'
const _nsLevels = {}

const envConfig = process.env.TLDA_LOG || ''
for (const part of envConfig.split(',').filter(Boolean)) {
  const [nsOrLevel, level] = part.split(':')
  if (level) _nsLevels[nsOrLevel] = level
  else _globalLevel = nsOrLevel
}

function shouldLog(ns, level) {
  const threshold = _nsLevels[ns] || _globalLevel
  return (LEVEL_ORDER[level] ?? 0) >= (LEVEL_ORDER[threshold] ?? 0)
}

export function createLogger(prefix) {
  const tag = `[${prefix}]`

  function emit(level, consoleFn, args) {
    if (!shouldLog(prefix, level)) return
    const ts = new Date().toISOString()
    consoleFn(ts, tag, ...args)
  }

  return {
    debug: (...args) => emit('debug', console.log, args),
    info:  (...args) => emit('info', console.log, args),
    warn:  (...args) => emit('warn', console.warn, args),
    error: (...args) => emit('error', console.error, args),
  }
}
