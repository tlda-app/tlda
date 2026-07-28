import { Worker } from 'node:worker_threads'

export class DaemonProjectInventoryClient {
  constructor(projectsDir) {
    this._nextId = 1
    this._pending = new Map()
    this._ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve
      this._rejectReady = reject
    })
    this._worker = new Worker(
      new URL('./daemon-project-inventory.worker.mjs', import.meta.url),
      { workerData: { projectsDir } },
    )
    this._worker.on('message', message => {
      if (message.kind === 'ready') {
        this._resolveReady()
        return
      }
      const pending = this._pending.get(message.id)
      if (!pending) return
      this._pending.delete(message.id)
      if (message.error) {
        const error = new Error(message.error.message)
        error.stack = message.error.stack || error.stack
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
    })
    this._worker.on('error', error => {
      this._rejectReady(error)
      for (const pending of this._pending.values()) pending.reject(error)
      this._pending.clear()
    })
  }

  async ready() {
    await this._ready
  }

  async read() {
    await this.ready()
    return this._request('read')
  }

  async close() {
    if (!this._worker) return
    await this._request('close', {}, 'close')
    await this._worker.terminate()
    this._worker = null
  }

  _request(method, detail = {}, kind = 'request') {
    const id = this._nextId++
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      this._worker.postMessage({ id, kind, method, ...detail })
    })
  }
}
