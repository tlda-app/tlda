import chokidar from 'chokidar'
import fs from 'fs'
import path from 'path'

function closeWatcher(watcher, label, log) {
  if (!watcher) return
  try {
    const closed = watcher.close()
    if (closed?.catch) closed.catch(e => log.warn(`chokidar close failed for ${label}: ${e?.message || e}`))
  } catch (e) {
    // Watcher shutdown is cleanup-only; log and continue tearing down peers.
    log.warn(`chokidar close threw for ${label}: ${e?.message || e}`)
  }
}

function backingKey(project, backingName) {
  return `${project}\0${backingName}`
}

export function createBackingFiles({ getSourceDir, log, sendMsg }) {
  const backingWatchers = new Map()

  function resolveBackingFile(project, backingName) {
    if (!project) throw new Error('missing project')
    if (!backingName || path.isAbsolute(backingName) || backingName.includes('\0')) {
      throw new Error(`invalid backingName for ${project}`)
    }
    const sourceDir = getSourceDir(project)
    if (!sourceDir) throw new Error(`project ${project} is not watched on this daemon`)
    const full = path.resolve(sourceDir, backingName)
    const root = path.resolve(sourceDir)
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error(`backingName escapes project: ${backingName}`)
    }
    return full
  }

  function sendBackingStatus({ project, backingName, docNames, status, content, message }) {
    sendMsg({
      type: 'backing-file-status',
      project,
      backingName,
      docNames,
      status,
      ...(content !== undefined && { content }),
      ...(message && { message }),
    })
  }

  function sync(files) {
    const incoming = new Map()
    for (const f of files || []) {
      if (!f?.project || !f?.backingName) continue
      incoming.set(backingKey(f.project, f.backingName), f)
    }

    teardown()

    for (const [, file] of incoming) {
      const { project, backingName } = file
      const docNames = Array.isArray(file.docNames) ? file.docNames : []
      let fp
      try {
        fp = resolveBackingFile(project, backingName)
      } catch (e) {
        log.warn(`resolve backing file ${project}:${backingName}: ${e.message}`)
        sendBackingStatus({ project, backingName, docNames, status: 'owner-missing', message: e.message })
        continue
      }
      const key = backingKey(project, backingName)
      if (!fs.existsSync(fp)) {
        backingWatchers.set(key, { watcher: null, project, backingName, docNames, lastWriteAt: 0 })
        sendBackingStatus({ project, backingName, docNames, status: 'deleted' })
        log.warn(`backing file missing: ${project}:${backingName}`)
        continue
      }
      try {
        let debounce = null
        const handle = () => {
          const entry = backingWatchers.get(key)
          if (!entry) return
          if (Date.now() - entry.lastWriteAt < 2000) return
          if (debounce) clearTimeout(debounce)
          debounce = setTimeout(() => {
            try {
              const content = fs.readFileSync(fp, 'utf8')
              log.info(`backing file changed: ${project}:${backingName} (${content.length} bytes)`)
              sendBackingStatus({ project, backingName, docNames, status: 'synced', content })
            } catch (e) {
              const status = e?.code === 'ENOENT' ? 'deleted' : 'failed'
              log.warn(`read backing file ${project}:${backingName}: ${e.message}`)
              sendBackingStatus({ project, backingName, docNames, status, message: e.message })
            }
          }, 200)
        }
        const watcher = chokidar.watch(fp, {
          ignoreInitial: true,
          persistent: true,
          followSymlinks: true,
        })
          .on('add', handle)
          .on('change', handle)
          .on('unlink', handle)
          .on('error', e => {
            log.warn(`chokidar backing watcher failed for ${project}:${backingName}: ${e?.message || e}`)
            sendBackingStatus({ project, backingName, docNames, status: 'failed', message: e?.message || String(e) })
          })
        backingWatchers.set(key, { watcher, project, backingName, docNames, lastWriteAt: 0 })
        log.info(`chokidar backing watcher started for ${project}:${backingName}`)
      } catch (e) {
        log.warn(`watch backing file ${project}:${backingName}: ${e.message}`)
        sendBackingStatus({ project, backingName, docNames, status: 'failed', message: e.message })
      }
    }
    if (incoming.size > 0) log.info(`backing watchers: ${backingWatchers.size} active`)
  }

  async function write({ project, backingName, content, restore }) {
    const fp = resolveBackingFile(project, backingName)
    if (!restore && !fs.existsSync(fp)) {
      const err = new Error(`backing file deleted externally: ${project}:${backingName}`)
      err.status = 'deleted'
      throw err
    }
    const entry = backingWatchers.get(backingKey(project, backingName))
    if (entry) entry.lastWriteAt = Date.now()
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    fs.writeFileSync(fp, content ?? '', 'utf8')
    if (entry && !entry.watcher) {
      sync([...backingWatchers.values()].map(w => ({
        project: w.project,
        backingName: w.backingName,
        docNames: w.docNames,
      })))
    }
    return { ok: true, status: 'synced' }
  }

  function teardown() {
    for (const [, entry] of backingWatchers) closeWatcher(entry.watcher, `${entry.project}:${entry.backingName}`, log)
    backingWatchers.clear()
  }

  return {
    sync,
    teardown,
    write,
  }
}
