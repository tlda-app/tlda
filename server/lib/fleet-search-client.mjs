import { fork } from 'node:child_process'
import { constants as osConstants, setPriority } from 'node:os'

const METHODS = [
  'getAgentsByIds',
  'getChatContext',
  'getSearchStats',
  'resolveAgentQuery',
  'resolveAgentSelector',
  'searchAll',
]

function requestContext(args) {
  for (const arg of args || []) {
    if (arg?._requestContext) return arg._requestContext
  }
  return null
}

export class FleetSearchClient {
  constructor(dbPath) {
    this.dbPath = dbPath
    this._seq = 0
    this._pending = new Map()
    this._closed = false
    this._spawn()
    for (const method of METHODS) this[method] = (...args) => this._call(method, args)
  }

  _spawn() {
    this._ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve
      this._rejectReady = reject
    })
    this._child = fork(new URL('./fleet-search-process.mjs', import.meta.url), [], {
      env: { ...process.env, TLDA_FLEET_DB: this.dbPath },
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    try {
      setPriority(this._child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
    } catch (error) {
      this._child.kill()
      throw new Error(`could not lower fleet search process priority: ${error?.message || error}`, { cause: error })
    }
    this._child.on('message', message => {
      if (message?.kind === 'ready') return this._resolveReady()
      const waiter = this._pending.get(message?.id)
      if (!waiter) return
      this._pending.delete(message.id)
      const elapsedMs = performance.now() - waiter.queuedAt
      if (elapsedMs >= Number(process.env.TLDA_SEARCH_REQUEST_LOG_MS || 1000)) {
        console.warn(`[fleet-search-request] ${elapsedMs.toFixed(1)}ms ${JSON.stringify(waiter.context || {})}`)
      }
      if (message.error) {
        const error = new Error(message.error.message)
        error.processStack = message.error.stack
        waiter.reject(error)
      } else {
        waiter.resolve(message.result)
      }
    })
    this._child.on('error', error => this._fail(error))
    this._child.on('exit', (code, signal) => {
      if (this._closed) return
      this._fail(new Error(`fleet search process exited (${code ?? signal})`))
      this._spawn()
    })
  }

  _fail(error) {
    this._rejectReady?.(error)
    for (const waiter of this._pending.values()) waiter.reject(error)
    this._pending.clear()
  }

  _call(method, args) {
    if (this._closed) return Promise.reject(new Error('fleet search client is closed'))
    const id = ++this._seq
    return this._ready.then(() => new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, queuedAt: performance.now(), context: requestContext(args) })
      this._child.send({ id, method, args })
    }))
  }

  ready() { return this._ready }

  async close() {
    if (this._closed) return
    this._closed = true
    const id = ++this._seq
    await new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      this._child.send({ id, kind: 'close' })
    })
    this._child.kill()
  }
}
