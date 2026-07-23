import chokidar from 'chokidar'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

import { scanMarkdownDeps } from '../shared/markdown-deps.mjs'
import { isBuildJunkPath, isIgnoredSourceDir, isSourceFilePath, normalizeSourceManifest } from '../shared/source-manifest.mjs'

export function createSourceChangeCorrelation({ makeId = randomUUID, log = console } = {}) {
  const revisions = new Map()
  const pending = new Map()
  const blocked = new Set()
  const retries = []
  return {
    seed(project, revision) {
      const nextRevision = revision ?? null
      if (nextRevision !== revisions.get(project)) blocked.delete(project)
      revisions.set(project, nextRevision)
    },
    prepare(payload) {
      if (blocked.has(payload.project)) return null
      const requestId = makeId()
      pending.set(requestId, { project: payload.project, payload })
      return { ...payload, requestId, expectedRevision: revisions.get(payload.project) ?? null }
    },
    handle(message) {
      const request = pending.get(message.requestId)
      if (!request || request.project !== message.project) return false
      pending.delete(message.requestId)
      const project = request.project
      if (message.ok && typeof message.sourceRevision === 'string') revisions.set(project, message.sourceRevision)
      else {
        const currentRevision = message.authority?.currentRevision
        if (message.status === 'stale-base' && typeof currentRevision === 'string') {
          revisions.set(project, currentRevision)
          blocked.delete(project)
          retries.push(request.payload)
        } else if (message.status === 'stale-base') {
          blocked.add(project)
        }
        log.warn(`source change rejected for ${project}: ${message.error || message.status || 'unknown'}`)
      }
      return true
    },
    takeRetry() { return retries.shift() ?? null },
    state(project) { return { revision: revisions.get(project) ?? null, blocked: blocked.has(project) } },
  }
}

export function createSourceSync({ sourceBindingsFile, log, sendMsg, isConnected, resolveEditor, reconcileIntervalMs = 1000, watch = chokidar.watch }) {
  const sourceWatchers = new Map()
  const sourceCorrelation = createSourceChangeCorrelation({ log })

  function sendSourceChange(payload) {
    const message = sourceCorrelation.prepare(payload)
    if (!message) { log.warn(`source authority blocked for ${payload.project}; refresh/reconcile required`); return false }
    return sendMsg(message)
  }

  function handleSourceChangeResult(message) {
    const handled = sourceCorrelation.handle(message)
    if (!handled) return false
    let retry
    while ((retry = sourceCorrelation.takeRetry())) sendSourceChange(retry)
    return true
  }

  function loadSourceBindings() {
    try {
      if (!fs.existsSync(sourceBindingsFile)) return {}
      return JSON.parse(fs.readFileSync(sourceBindingsFile, 'utf8')) || {}
    } catch (e) {
      log.warn(`corrupt source-bindings file, ignoring: ${e.message}`)
      return {}
    }
  }

  // ---------- source watching ----------

  const JUNK_PATTERNS = [/^\.#/, /\.swp$/, /~$/, /\.tmp$/, /\.lock$/]

  // Bootstrap input scanner — regex-scan .tex files for \input-like commands
  // to discover dependencies before the first successful build produces a .fls.
  const DEFAULT_INPUT_COMMANDS = ['input', 'include', 'inputscratch', 'addbibresource', 'bibliography', 'usepackage', 'includegraphics']
  const GRAPHICS_EXTENSIONS = ['.pdf', '.svg', '.png', '.jpg', '.jpeg', '.eps']

  function scanTexInputs(sourceDir, mainFile, extraCommands = []) {
    const commands = [...DEFAULT_INPUT_COMMANDS, ...extraCommands]
    const pattern = new RegExp(`\\\\(${commands.join('|')})(?:\\[[^\\]]*\\])?\\{([^}]+)\\}`, 'g')
    const seen = new Set()
    const result = new Set()

    function scan(relPath) {
      if (seen.has(relPath)) return
      seen.add(relPath)
      const full = path.join(sourceDir, relPath)
      if (!fs.existsSync(full)) return
      let stat
      try { stat = fs.statSync(full) } catch { return }
      if (!stat.isFile()) return
      result.add(relPath)

      const ext = path.extname(relPath).toLowerCase()
      if (ext !== '.tex' && ext !== '.sty' && ext !== '.cls') return

      let content
      try { content = fs.readFileSync(full, 'utf8') } catch { return }
      for (const m of content.matchAll(pattern)) {
        const cmd = `\\${m[1]}`
        const raw = m[2].trim()
        if (!raw) continue
        // \usepackage and \bibliography accept comma-separated lists
        const refs = (cmd === '\\usepackage' || cmd === '\\bibliography')
          ? raw.split(',').map(s => s.trim()).filter(Boolean)
          : [raw]
        for (let ref of refs) {
          if (cmd === '\\usepackage') {
            if (!ref.endsWith('.sty')) ref += '.sty'
          } else if (cmd === '\\bibliography' || cmd === '\\addbibresource') {
            if (!ref.endsWith('.bib')) ref += '.bib'
          } else if (cmd === '\\includegraphics') {
            const ext = path.extname(ref).toLowerCase()
            const candidates = ext ? [ref] : GRAPHICS_EXTENSIONS.map(suffix => ref + suffix)
            if (ext === '.pdf') candidates.push(ref.slice(0, -ext.length) + '.svg')
            const dir = path.dirname(relPath)
            for (const candidate of candidates) {
              const resolved = path.normalize(path.join(dir, candidate))
              if (resolved.startsWith('..') || path.isAbsolute(resolved)) continue
              if (fs.existsSync(path.join(sourceDir, resolved))) result.add(resolved)
            }
            continue
          } else if (!path.extname(ref)) {
            ref += '.tex'
          }
          const dir = path.dirname(relPath)
          const resolved = path.normalize(path.join(dir, ref))
          if (resolved.startsWith('..')) continue
          scan(resolved)
          if (cmd === '\\inputscratch' && resolved.endsWith('.tex')) {
            const mdCompanion = resolved.replace(/\.tex$/, '.md')
            if (fs.existsSync(path.join(sourceDir, mdCompanion))) result.add(mdCompanion)
          }
        }
      }
    }

    scan(mainFile)
    return result
  }

  // A markdown doc is NOT a single file — it's the main .md PLUS the images it
  // references. This is the markdown analog of scanTexInputs: returns a Set of
  // sourceDir-relative paths (main + referenced images that live under sourceDir),
  // computed locally on the agent's machine via the shared scanner. Mirrors the
  // server's ref-scan in build-markdown.mjs.
  function scanMarkdownInputs(sourceDir, mainFile) {
    const result = new Set([mainFile])
    const full = path.join(sourceDir, mainFile)
    let content
    try { content = fs.readFileSync(full, 'utf8') } catch { return result }
    for (const { abs } of scanMarkdownDeps(content, path.dirname(full))) {
      if (!abs) continue
      const rel = path.relative(sourceDir, abs)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      result.add(rel)
    }
    return result
  }

  // A markdown doc bundles only its dependency graph (main + images), never the
  // rest of sourceDir — so the "any source file always passes" escape hatch must
  // not apply to it.
  function isMarkdownDoc(format, mainFile) {
    return format === 'markdown' || (mainFile?.toLowerCase().endsWith('.md') ?? false)
  }

  function isSourceFile(name, context = {}) {
    if (JUNK_PATTERNS.some(r => r.test(name))) return false
    if (name.includes('node_modules') || name.includes('.git/')) return false
    return isSourceFilePath(name, context)
  }

  function readFileForUpload(fullPath) {
    const data = fs.readFileSync(fullPath)
    // Heuristic: text-y if mostly ASCII; otherwise base64.
    const ext = path.extname(fullPath).toLowerCase()
    const TEXT_EXTS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.md', '.qmd', '.html', '.css', '.js', '.svg', '.json', '.yml', '.yaml'])
    if (TEXT_EXTS.has(ext)) return { content: data.toString('utf8') }
    return { content: data.toString('base64'), encoding: 'base64' }
  }

  function sourceRel(sourceDir, filePath) {
    if (!filePath) return null
    const abs = path.isAbsolute(String(filePath)) ? String(filePath) : path.join(sourceDir, String(filePath))
    const rel = path.relative(sourceDir, abs)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
    return rel.split(path.sep).join('/')
  }

  // Build output records authoring files as absolute paths. The daemon, on the
  // other hand, keeps its watch set and source-change payloads relative to the
  // project source root. Leaving those absolute entries untouched makes
  // sourceWatcherPaths join them onto sourceDir and the markdown part is never
  // watched. Normalize at the boundary so a project part such as
  // scratch/report.md is watched and uploaded under that same project path.
  function normalizeWatchSet(sourceDir, watchFiles) {
    const normalized = new Set()
    for (const file of watchFiles || []) {
      const rel = sourceRel(sourceDir, file)
      if (rel) normalized.add(rel)
    }
    return normalized
  }

  function closeWatcher(watcher, label) {
    if (!watcher) return
    try {
      const closed = watcher.close()
      if (closed?.catch) closed.catch(e => log.warn(`chokidar close failed for ${label}: ${e?.message || e}`))
    } catch (e) {
      // Watcher shutdown is cleanup-only; log and continue tearing down peers.
      log.warn(`chokidar close threw for ${label}: ${e?.message || e}`)
    }
  }

  function shouldIgnoreSourceWatchPath(sourceDir, filePath, stats, context = {}) {
    const rel = sourceRel(sourceDir, filePath)
    if (!rel) return false
    const parts = rel.split('/')
    if (parts.includes('node_modules') || parts.includes('.git')) return true
    if (!stats) return false
    if (stats?.isDirectory?.()) return false
    return !isSourceFile(rel, context) && !rel.includes('.tlda/scratch/')
  }

  function collectSourceManifest(sourceDir, context, watchSet = null, authorityManifest = null) {
    const rels = new Set(Array.isArray(authorityManifest) ? authorityManifest : [])
    if (watchSet) {
      for (const rel of watchSet) {
        if (typeof rel !== 'string') continue
        if (fs.existsSync(path.join(sourceDir, rel))) rels.add(rel)
      }
      return normalizeSourceManifest([...rels], context)
    }

    function walk(dir, prefix = '') {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (isIgnoredSourceDir(entry.name)) continue
          walk(full, rel)
        } else if (!isBuildJunkPath(rel) && isSourceFile(rel, context)) {
          rels.add(rel)
        }
      }
    }
    walk(sourceDir)
    return normalizeSourceManifest([...rels], context)
  }

  function sourceWatcherPaths(state) {
    const rels = new Set(state.watchSet || [])
    if (state.mainFile) rels.add(state.mainFile)
    const paths = []
    for (const rel of rels) {
      if (!rel || typeof rel !== 'string') continue
      const normalized = rel.split(/[\\/]+/).filter(Boolean).join(path.sep)
      if (!normalized) continue
      const full = path.join(state.sourceDir, normalized)
      paths.push(full)
    }
    paths.sort()
    return paths
  }

  function sourceWatcherKey(state) {
    return sourceWatcherPaths(state).join('\0')
  }

  function sourcePathFingerprint(filePath) {
    try {
      const stat = fs.statSync(filePath, { bigint: true })
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
    } catch (error) {
      if (error?.code === 'ENOENT') return 'missing'
      return `error:${error?.code || error?.message || 'unknown'}`
    }
  }

  function reconcileSourceWatcher(state) {
    if (sourceWatchers.get(state.projectName) !== state) return
    const nextPaths = sourceWatcherPaths(state)
    const next = new Map()
    for (const filePath of nextPaths) {
      const fingerprint = sourcePathFingerprint(filePath)
      next.set(filePath, fingerprint)
      const previous = state.pathFingerprints.get(filePath)
      if (previous !== undefined && previous !== fingerprint) {
        const rel = sourceRel(state.sourceDir, filePath)
        if (rel) {
          log.warn(`source reconciliation detected missed watcher edge for ${state.projectName}: ${rel}`)
          state.onFileChange(rel)
        }
      }
    }
    for (const filePath of state.pathFingerprints.keys()) {
      if (next.has(filePath)) continue
      const rel = sourceRel(state.sourceDir, filePath)
      if (rel) state.onFileChange(rel)
    }
    state.pathFingerprints = next
  }

  function startSourceWatcher(state, reason = 'start') {
    closeWatcher(state.watcher, state.projectName)
    const watchPaths = sourceWatcherPaths(state)
    state.watcherKey = watchPaths.join('\0')
    if (watchPaths.length === 0) {
      state.watcher = null
      log.warn(`source watcher disabled for ${state.projectName}: no bounded source files to watch`)
      return
    }
    const watcher = watch(watchPaths, {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: true,
      ignored: (filePath, stats) => shouldIgnoreSourceWatchPath(
        state.sourceDir,
        filePath,
        stats,
        { format: state.format, mainFile: state.mainFile },
      ),
    })
    state.watcher = watcher
    state.pathFingerprints = new Map(watchPaths.map(filePath => [filePath, sourcePathFingerprint(filePath)]))
    const handle = (filePath) => {
      if (state.watcher !== watcher) return
      state.pathFingerprints.set(filePath, sourcePathFingerprint(filePath))
      const rel = sourceRel(state.sourceDir, filePath)
      if (rel) state.onFileChange(rel)
    }
    watcher
      .on('add', handle)
      .on('change', handle)
      .on('unlink', handle)
      .on('error', e => {
        if (state.watcher !== watcher) return
        log.warn(`chokidar source watcher failed for ${state.projectName}: ${e?.message || e}`)
        state.watcher = null
        closeWatcher(watcher, state.projectName)
        setTimeout(() => {
          if (sourceWatchers.get(state.projectName) === state && !state.watcher) startSourceWatcher(state, 'retry')
        }, 1000).unref?.()
      })
    log.info(`chokidar source watcher started for ${state.projectName} (${reason}, ${watchPaths.length} paths)`)
  }

  function closeSourceState(state) {
    closeWatcher(state.watcher, state.projectName)
    state.watcher = null
    if (state.reconcileTimer) clearInterval(state.reconcileTimer)
    state.reconcileTimer = null
    if (state._symlinkWatchers) {
      for (const [target, watcher] of state._symlinkWatchers) closeWatcher(watcher, `symlink target ${target}`)
      state._symlinkWatchers.clear()
    }
  }

  function sync(projectList) {
    const activeNames = new Set()
    const bindings = loadSourceBindings()
    for (const p of projectList) {
      sourceCorrelation.seed(p.name, p.sourceRevision)
      // Per-machine binding wins over the server-provided sourceDir (the host's
      // path). No binding → fall back to the server's sourceDir (single-host case).
      const sourceDir = bindings[p.name] || p.sourceDir
      if (!sourceDir) continue
      if (!fs.existsSync(sourceDir)) continue
      activeNames.add(p.name)

      const isMarkdown = isMarkdownDoc(p.format, p.mainFile)
      const hasFlsWatchList = p.watchFiles?.length > 0
      // Bootstrap watchSet (no .fls yet) must include the main's \input deps, not
      // just the main, so the initial connect push contains dependencies before
      // the first build produces a .fls.
      const declaredWatchSet = new Set(
        isMarkdown && p.mainFile ? scanMarkdownInputs(sourceDir, p.mainFile)
        : p.mainFile ? scanTexInputs(sourceDir, p.mainFile, p.extraInputCommands || []) : []
      )
      const watchSet = hasFlsWatchList
        ? new Set([...normalizeWatchSet(sourceDir, p.watchFiles), ...declaredWatchSet])
        : declaredWatchSet

      if (sourceWatchers.has(p.name)) {
        const existing = sourceWatchers.get(p.name)
        if (existing.sourceDir !== sourceDir) {
          closeSourceState(existing)
          sourceWatchers.delete(p.name)
        } else {
          const newlyWatched = new Set([...watchSet].filter(rel => !existing.watchSet.has(rel)))
          existing.watchSet = watchSet
          existing.mainFile = p.mainFile
          existing.extraInputCommands = p.extraInputCommands || []
          existing.isMarkdown = isMarkdown
          existing.format = p.format
          existing.authorityManifest = new Set(Array.isArray(p.sourceManifest) ? p.sourceManifest : [])
          const nextWatcherKey = sourceWatcherKey(existing)
          if (!existing.watcher || existing.watcherKey !== nextWatcherKey) startSourceWatcher(existing, 'resync')
          if (newlyWatched.size > 0) {
            pushWatchedFiles(p.name, sourceDir, newlyWatched, null, p.extraInputCommands, isMarkdown, p.format)
          }
          continue
        }
      }

      const state = { sourceDir, debounce: null, pending: new Set(), watchSet, authorityManifest: new Set(Array.isArray(p.sourceManifest) ? p.sourceManifest : []), onFileChange: null, projectName: p.name, mainFile: p.mainFile, format: p.format, extraInputCommands: p.extraInputCommands || [], isMarkdown, watcher: null, watcherKey: '', pathFingerprints: new Map(), reconcileTimer: null, _symlinkWatchers: new Map() }

      const onFileChange = (filename) => {
        if (!filename) return
        if (fs.existsSync(path.join(state.sourceDir, filename))) state.authorityManifest.add(filename)
        else state.authorityManifest.delete(filename)
        if (state.isMarkdown) {
          // A markdown doc bundles exactly its dependency graph (main + referenced
          // images). Enforce the watchSet strictly — do NOT let arbitrary source
          // files in sourceDir through, or the doc eats the whole dir's churn.
          // Newly-referenced images are discovered by rescanning when the main .md
          // changes (see flushSourceChanges), not via the escape hatch below.
          if (!state.watchSet.has(filename)) return
        } else {
          const isScratch = filename.includes('.tlda/scratch/')
          if (!isScratch) {
            // Source files (.tex, .bib, .sty, etc.) always pass - even if not in the watchSet.
            // The watchSet comes from the PREVIOUS build's .fls; a newly-added \input dep
            // won't be in it yet, but we must still push it so the build can pick it up.
            // Non-source files (build artifacts, .aux, etc.) are filtered by watchSet when
            // available, or dropped entirely when the watchSet is empty (bootstrap mode).
            if (!isSourceFile(filename, { format: state.format, mainFile: state.mainFile })) {
              if (state.watchSet.size > 0) {
                if (!state.watchSet.has(filename)) return
              } else {
                return
              }
            }
          }
        }
        state.pending.add(filename)
        if (state.debounce) clearTimeout(state.debounce)
        state.debounce = setTimeout(() => flushSourceChanges(state.projectName), 200)
      }
      state.onFileChange = onFileChange

      try {
        sourceWatchers.set(p.name, state)
        startSourceWatcher(state, 'project sync')
        state.reconcileTimer = setInterval(() => reconcileSourceWatcher(state), reconcileIntervalMs)
        state.reconcileTimer.unref?.()
        log.info(`watching source ${p.name}: ${sourceDir}${bindings[p.name] ? ' (local binding)' : ''} (${watchSet.size} files${hasFlsWatchList ? '' : ', bootstrap'})`)
        pushWatchedFiles(p.name, sourceDir, watchSet, hasFlsWatchList ? null : p.mainFile, p.extraInputCommands, isMarkdown, p.format)
      } catch (e) {
        // One source watcher failing should not stop other projects from syncing.
        log.error(`source watcher failed for ${p.name}: ${e.message}`)
      }
    }
    for (const [name, state] of sourceWatchers) {
      if (!activeNames.has(name)) {
        closeSourceState(state)
        sourceWatchers.delete(name)
      }
    }
  }

  /**
   * Push source files to the server on connect.
   * When mainFile is set (no .fls yet), scan it recursively for \input-like
   * commands and push all discovered dependencies — the bootstrap path.
   * Otherwise push the .fls-derived watchSet.
   */
  function pushWatchedFiles(projectName, sourceDir, watchSet, mainFile, extraInputCommands, isMarkdown, format) {
    let uploadPaths = new Set()
    if (mainFile) {
      // Bootstrap mode: no .fls yet. Scan the main file for its deps — \input-like
      // commands for tex, referenced images for markdown — and push main + deps.
      uploadPaths = isMarkdown
        ? scanMarkdownInputs(sourceDir, mainFile)
        : scanTexInputs(sourceDir, mainFile, extraInputCommands || [])
      log.info(`bootstrap scan for ${projectName}: ${uploadPaths.size} files from ${mainFile}`)
    } else if (watchSet.size > 0) {
      uploadPaths = new Set(watchSet)
    }
    const sourceManifest = collectSourceManifest(
      sourceDir,
      { format, mainFile },
      uploadPaths,
      sourceWatchers.get(projectName)?.authorityManifest ? [...sourceWatchers.get(projectName).authorityManifest] : null,
    )
    if (sourceManifest.length === 0) return
    const files = []
    for (const rel of normalizeSourceManifest([...uploadPaths], { format, mainFile })) {
      const full = path.join(sourceDir, rel)
      try { files.push({ path: rel, ...readFileForUpload(full) }) }
      catch (e) {
        // Per-file upload failures are surfaced; readable files still push.
        log.error(`read ${full}: ${e.message}`)
      }
    }
    if (files.length === 0) return
    log.info(`connect push: ${files.length} files for ${projectName}`)
    sendSourceChange({ type: 'source-change', project: projectName, files, sourceManifest })
  }

  const _pendingSourceProjects = new Set()

  function flushSourceChanges(projectName) {
    const state = sourceWatchers.get(projectName)
    if (!state) return
    state.debounce = null

    if (!isConnected()) {
      _pendingSourceProjects.add(projectName)
      return
    }

    const filePaths = [...state.pending]
    state.pending.clear()
    _pendingSourceProjects.delete(projectName)

    const files = []
    const deleted = []
    for (const rel of filePaths) {
      const full = path.join(state.sourceDir, rel)
      if (!fs.existsSync(full)) { deleted.push(rel); continue }
      // Resolve symlinks so the server stores files at their canonical path.
      // Fixes the case where .tlda/scratch/ is a directory symlink (e.g. pointing
      // to revision/.tlda/scratch/) — without this the daemon pushes
      // .tlda/scratch/file.tex but the build expects revision/.tlda/scratch/file.tex.
      let pushPath = rel
      try {
        const realFull = fs.realpathSync(full)
        if (realFull !== full) {
          const canonical = path.relative(state.sourceDir, realFull)
          if (!canonical.startsWith('..')) {
            pushPath = canonical
            if (canonical !== rel) log.info(`resolved symlink: ${rel} → ${canonical}`)
          }
        }
      } catch {
        // Realpath is advisory; unresolved symlinks still push by original path.
      }
      try { files.push({ path: pushPath, ...readFileForUpload(full) }) }
      catch (e) {
        // Per-file upload failures are surfaced; readable files still push.
        log.error(`read ${full}: ${e.message}`)
      }
    }

    // When a .tex file changes, rescan for new \input deps not yet on the server.
    // This catches newly-added \input{} or \inputscratch{} lines before the build
    // fails with "file not found".
    const changedTexFiles = filePaths.filter(f => f.endsWith('.tex'))
    if (changedTexFiles.length > 0 && state.mainFile) {
      const alreadyPushed = new Set(filePaths)
      const deps = scanTexInputs(state.sourceDir, state.mainFile, state.extraInputCommands)
      for (const rel of deps) {
        if (alreadyPushed.has(rel) || state.watchSet.has(rel)) continue
        const full = path.join(state.sourceDir, rel)
        if (!fs.existsSync(full)) continue
        state.watchSet.add(rel)
        try {
          files.push({ path: rel, ...readFileForUpload(full) })
          log.info(`rescan discovered new dep: ${rel}`)
        } catch (e) {
          // Per-file upload failures are surfaced; readable files still push.
          log.error(`read ${full}: ${e.message}`)
        }
      }
    }

    // When the main .md of a markdown doc changes, rescan its image refs. A newly-
    // referenced image must be pushed now (the build will otherwise 404 it) and
    // added to the watchSet so later edits to it pass the strict filter.
    if (state.isMarkdown && state.mainFile && filePaths.includes(state.mainFile)) {
      const alreadyPushed = new Set(filePaths)
      const deps = scanMarkdownInputs(state.sourceDir, state.mainFile)
      for (const rel of deps) {
        if (!state.watchSet.has(rel)) {
          state.watchSet.add(rel)
        }
        if (alreadyPushed.has(rel)) continue
        const full = path.join(state.sourceDir, rel)
        if (!fs.existsSync(full)) continue
        try {
          files.push({ path: rel, ...readFileForUpload(full) })
          log.info(`md rescan discovered dep: ${rel}`)
        } catch (e) {
          // Per-file upload failures are surfaced; readable files still push.
          log.error(`read ${full}: ${e.message}`)
        }
      }
    }

    // Watch symlink targets in .tlda/scratch/ — changes to the linked file should
    // trigger a rebuild even when the target sits outside the source dir.
    for (const rel of filePaths) {
      if (!rel.includes('.tlda/scratch/')) continue
      const full = path.join(state.sourceDir, rel)
      try {
        const stat = fs.lstatSync(full)
        if (stat.isSymbolicLink()) {
          const target = fs.realpathSync(full)
          if (!state._symlinkWatchers) state._symlinkWatchers = new Map()
          if (!state._symlinkWatchers.has(target)) {
            const watcher = chokidar.watch(target, { ignoreInitial: true, persistent: true, followSymlinks: true })
              .on('change', () => state.onFileChange(rel))
              .on('unlink', () => state.onFileChange(rel))
              .on('error', e => log.warn(`chokidar symlink target watcher failed for ${target}: ${e?.message || e}`))
            state._symlinkWatchers.set(target, watcher)
            log.info(`watching symlink target: ${target} -> ${rel}`)
          }
        }
      } catch {
        // Symlink target watching is advisory; the source file itself still triggers pushes.
      }
    }

    if (files.length === 0 && deleted.length === 0) return

    const nextWatcherKey = sourceWatcherKey(state)
    if (state.watcherKey !== nextWatcherKey) startSourceWatcher(state, 'dependency rescan')

    // Edit attribution: which agent's recent Edit/Write touched a changed file.
    const editedBy = resolveEditor(filePaths.map(rel => path.join(state.sourceDir, rel)))

    sendSourceChange({
      type: 'source-change',
      project: projectName,
      files,
      sourceManifest: collectSourceManifest(
        state.sourceDir,
        { format: state.format, mainFile: state.mainFile },
        state.isMarkdown ? state.watchSet : null,
        [...state.authorityManifest],
      ),
      ...(deleted.length > 0 && { deletedFiles: deleted }),
      ...(editedBy && { editedBy }),
    })
  }

  function flushPending() {
    for (const name of _pendingSourceProjects) {
      flushSourceChanges(name)
    }
  }



  function getSourceDir(project) {
    return sourceWatchers.get(project)?.sourceDir || null
  }

  function closeAll() {
    for (const [, state] of sourceWatchers) closeSourceState(state)
    sourceWatchers.clear()
  }

  return {
    sync,
    flushPending,
    getSourceDir,
    closeAll,
    handleSourceChangeResult,
  }
}
