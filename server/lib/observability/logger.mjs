import pino from 'pino'

const rootLogger = pino({
  level: process.env.TLDA_LOG_LEVEL || process.env.LOG_LEVEL || 'info',
  base: {
    service: 'tlda',
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
})

export function createBackendLogger(component, bindings = {}) {
  return rootLogger.child({ component, ...bindings })
}
