/**
 * Logger — permanent, leveled logging. Never delete log lines.
 *
 * Usage:
 *   import { log } from './logger'
 *   log.debug('fleet', 'checkSelection', { state, hasSelected })
 *   log.info('fleet', 'layout mode entered')
 *   log.warn('fleet', 'stuck brush detected', { state })
 *
 * Control via URL param or localStorage:
 *   ?log=debug            — all namespaces at debug
 *   ?log=fleet:debug      — fleet namespace at debug, others at warn
 *   ?log=fleet:debug,hud:info  — per-namespace levels
 *   localStorage.setItem('tlda-log', 'fleet:debug')
 *
 * Levels: debug < info < warn < error < off
 * Default: warn (only warnings and errors show)
 */

type Level = 'debug' | 'info' | 'warn' | 'error' | 'off'

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3, off: 4 }

let _globalLevel: Level = 'warn'
const _nsLevels: Record<string, Level> = {}

function parseConfig(config: string) {
  if (!config) return
  for (const part of config.split(',')) {
    const [nsOrLevel, level] = part.split(':')
    if (level) {
      _nsLevels[nsOrLevel] = level as Level
    } else {
      _globalLevel = nsOrLevel as Level
    }
  }
}

// Initialize from URL param or localStorage
if (typeof window !== 'undefined') {
  const urlParam = new URLSearchParams(window.location.search).get('log')
  const stored = localStorage.getItem('tlda-log')
  parseConfig(urlParam || stored || '')
}

function shouldLog(ns: string, level: Level): boolean {
  const threshold = _nsLevels[ns] || _globalLevel
  return LEVEL_ORDER[level] >= LEVEL_ORDER[threshold]
}

function makeLogger(level: Level, consoleFn: (...args: any[]) => void) {
  return (ns: string, msg: string, data?: any) => {
    if (!shouldLog(ns, level)) return
    const prefix = `[${ns}]`
    if (data !== undefined) {
      consoleFn(prefix, msg, data)
    } else {
      consoleFn(prefix, msg)
    }
  }
}

export const log = {
  debug: makeLogger('debug', console.debug),
  info: makeLogger('info', console.info),
  warn: makeLogger('warn', console.warn),
  error: makeLogger('error', console.error),

  /** Change level at runtime: log.setLevel('debug') or log.setLevel('fleet', 'debug') */
  setLevel(nsOrLevel: string, level?: Level) {
    if (level) {
      _nsLevels[nsOrLevel] = level
    } else {
      _globalLevel = nsOrLevel as Level
    }
  },
}

// Expose on window for console access: log.setLevel('debug')
if (typeof window !== 'undefined') {
  (window as any).__log = log
}
