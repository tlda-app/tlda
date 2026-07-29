import { Worker } from 'node:worker_threads'

export class ProjectFilesStoreClient {
  constructor(projectsDir) {
    this._seq = 0
    this._pending = new Map()
    this._closed = false
    this._worker = new Worker(new URL('./project-files-store.worker.mjs', import.meta.url), {
      workerData: { projectsDir },
    })
    this._ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve
      this._rejectReady = reject
    })
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
        error.workerStack = message.error.stack
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
    })
    this._worker.on('error', error => this._fail(error))
    this._worker.on('exit', code => {
      if (!this._closed) this._fail(new Error(`project files worker exited (${code})`))
    })
  }

  _fail(error) {
    this._rejectReady(error)
    for (const pending of this._pending.values()) pending.reject(error)
    this._pending.clear()
  }

  _call(method, payload) {
    if (this._closed) return Promise.reject(new Error('project files store is closed'))
    const id = ++this._seq
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      this._worker.postMessage({ id, method, ...payload })
    })
  }

  ready() { return this._ready }
  listProjects() { return this._call('list-projects', {}) }
  readProject(project) { return this._call('read-project', { project }) }
  updateProject(project, updates) { return this._call('update-project', { project, updates }) }
  read(project) { return this._call('read', { project }) }
  replace(project, paths) { return this._call('replace', { project, paths }) }
  searchContent(query, options = {}) { return this._call('searchContent', { query, options }) }

  async close() {
    if (this._closed) return
    const id = ++this._seq
    await new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      this._worker.postMessage({ id, kind: 'close' })
    })
    this._closed = true
    await this._worker.terminate()
  }
}
