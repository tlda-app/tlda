import { createHash, randomUUID } from 'crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, isAbsolute, join } from 'path'
import { execFile as execFileCb, spawnSync } from 'child_process'
import { promisify } from 'util'
import * as Y from 'yjs'

const execFileAsync = promisify(execFileCb)

const SERVER_ORIGIN = Symbol('tlda-source-room-server')
const CLIENT_ORIGIN = Symbol('tlda-source-room-client')
const SOURCE_ROOM_DAEMON_PREFIX = 'source-room'
const MAX_RETRY_DELAY_MS = 30_000

function syncFile(path) {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const pending = `${path}.pending-${process.pid}-${randomUUID()}`
  writeFileSync(pending, content)
  syncFile(pending)
  renameSync(pending, path)
  syncFile(path)
  syncFile(dirname(path))
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

function atomicJson(path, value) {
  atomicWrite(path, JSON.stringify(value, null, 2))
}

function encodedPath(path) {
  return encodeURIComponent(path).replaceAll('%', '~')
}

function bufferFromBase64(value) {
  return Buffer.from(String(value || ''), 'base64')
}

async function sourceRoomFileText(lifecycle, { revisionId = null, filePath }) {
  const content = revisionId
    ? await lifecycle.readRevisionFile(revisionId, filePath)
    : (await lifecycle.readCurrentFile(filePath))?.content
  return content ? content.toString('utf8') : ''
}

function hasConflictMarkers(text) {
  return text.includes('<<<<<<<') || text.includes('=======') || text.includes('>>>>>>>')
}

function mergeText({ base, current, incoming, project, filePath }) {
  const dir = join(tmpdir(), `tlda-source-room-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  try {
    const paths = ['current', 'base', 'incoming'].map(name => join(dir, name))
    writeFileSync(paths[0], current)
    writeFileSync(paths[1], base)
    writeFileSync(paths[2], incoming)
    const result = spawnSync(
      'git',
      [
        'merge-file',
        '-p',
        '-L',
        `live room for ${project}:${filePath}`,
        '-L',
        'previous accepted source',
        '-L',
        `accepted server source for ${project}:${filePath}`,
        '--',
        ...paths,
      ],
      { encoding: 'utf8' },
    )
    if (result.status === 0) return { ok: true, text: result.stdout, conflicted: false }
    if (result.status === 1 && result.stdout.includes('<<<<<<<')) {
      return { ok: true, text: result.stdout, conflicted: true }
    }
    return { ok: false, error: result.stderr || `git merge-file exited ${result.status}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function replaceYText(ytext, text) {
  ytext.doc?.transact(() => {
    ytext.delete(0, ytext.length)
    ytext.insert(0, text)
  }, SERVER_ORIGIN)
}

function sendJson(ws, value) {
  if (ws.readyState !== 1) return false
  ws.send(JSON.stringify(value))
  return true
}

export function sourceRoomDaemonKey(project) {
  return `${SOURCE_ROOM_DAEMON_PREFIX}:${project}`
}

export function createSourceRoomDaemon({
  projectDir,
  readProject,
  sourceLifecycleStore,
  readClientSourceManifest,
  gitSyncManagerForProject,
  // How the room says it is holding an edit that never reached the paper, and
  // that it has stopped. Injected like everything else this file touches: the
  // room tests stand up their own project store, so importing the real
  // recorder would write these into a different store than the one under test
  // and report nothing while looking wired.
  recordHeldEdit = null,
  clearHeldEdit = null,
  pushDelayMs = 250,
  log = console,
}) {
  if (typeof gitSyncManagerForProject !== 'function') {
    throw new Error('createSourceRoomDaemon requires gitSyncManagerForProject')
  }

  const rooms = new Map()

  function roomKey(project, filePath) {
    return `${project}\0${filePath}`
  }

  function roomPaths(project, filePath) {
    const root = join(projectDir(project), '.source-room')
    const encoded = encodedPath(filePath)
    return {
      root,
      state: join(root, 'state', `${encoded}.json`),
      snapshot: join(root, 'rooms', `${encoded}.json`),
      yjs: join(root, 'yjs', `${encoded}.bin`),
      working: join(root, 'working', filePath),
    }
  }


  /**
   * Put a room's tree on the project branch, preserving anything already in it.
   *
   * **Why this is not just `standOnWorkBranch`.** Every room tree that exists
   * today is a scratch repo whose edited file was never committed to the branch,
   * so the file is UNTRACKED and `git checkout <branch>` refuses: *"the following
   * untracked working tree files would be overwritten"*. Measured on the live box
   * before shipping this: **13 of 15 existing room trees are in exactly that
   * state**, so the migration case is the one most likely to fail.
   *
   * **Nothing is deleted to get past it.** The colliding files are moved into a
   * timestamped directory beside the room, not removed -- this app does not delete
   * things, and a file that turns out to have mattered is still there. The room's
   * own file is a projection of its Yjs document, which is authoritative and is
   * rewritten immediately after hydration, so moving it costs nothing; anything
   * else that collided is a file the branch already carries.
   */
  async function standRoomOnProjectBranch(project, workingDir) {
    const gitSync = gitSyncManagerForProject(project)
    // ASYNC, because this runs inside the server. A synchronous subprocess here
    // blocks the event loop for every other request while git works, which is
    // what `lint:guards` budgets `spawnSync` in this file to stop -- and it
    // caught this before it shipped. The guard is right and the budget stays.
    const git = async (...args) => {
      try { return await execFileAsync('git', args, { cwd: workingDir, encoding: 'utf8' }) } catch (error) { return { stdout: error.stdout || '' } }
    }
    const lines = result => String(result?.stdout || '').split('\n').filter(Boolean)

    let stood = await gitSync.standOnWorkBranch(project)
    if (stood?.ok) return stood

    // WHICH FILES ARE IN THE WAY, computed rather than parsed out of git's
    // error text.
    //
    // Git refuses a checkout with two different sentences -- "untracked working
    // tree files would be overwritten" and "Your local changes to the following
    // files would be overwritten" -- and an earlier version of this matched only
    // the first. Measured on the live box: 13 room trees are untracked-only, 1
    // is modified-tracked, 2 have no project branch at all. Matching one
    // sentence left the modified one falling back into the silent drop this
    // exists to close, and `ls-files --others` would not have listed it anyway.
    //
    // So the collision set is derived: files the target commit carries that are
    // also dirty here. That covers both sentences without depending on either,
    // and it is NARROW -- only files that actually collide are touched, where
    // before every untracked file in the tree was moved on the strength of a
    // justification that covered one of them.
    const target = lines(await git('rev-parse', '--verify', '--quiet', `refs/heads/tlda/${project}`))[0]
      || lines(await git('rev-parse', '--verify', '--quiet', `refs/tlda/fetched/${project}`))[0]
    if (!target) {
      // No branch and no fetched head: adoption failed upstream and there is
      // nothing to stand on. Reported as itself rather than as a collision.
      log.warn?.(`[source-room] ${project}: NOT SYNCING — no project branch or fetched head to stand on (${stood?.status || 'unknown'})`)
      return { ok: false, status: stood?.status || 'no-project-head', reason: `${project} has no project branch to stand on` }
    }

    const carried = new Set(lines(await git('ls-tree', '-r', '--name-only', target)))
    const dirty = [...lines(await git('ls-files', '--others', '--exclude-standard')), ...lines(await git('diff', '--name-only'))]
    const colliding = [...new Set(dirty.filter(file => carried.has(file)))]

    if (colliding.length) {
      // MOVED, never deleted. This app does not delete things, and a file that
      // turns out to have mattered is still on disk. The room's own file is a
      // projection of its Yjs document, which is authoritative and is rewritten
      // on hydration, so preserving it costs nothing.
      //
      // These directories accumulate, one per collision per room, and nothing
      // sweeps them. Left deliberately: a stray directory is recoverable and a
      // swept one is not. This note is here so the next person finds a reason
      // rather than a mystery.
      const preserved = join(workingDir, '..', `working-preserved-${Date.now()}`)
      try {
        for (const file of colliding) {
          const to = join(preserved, file)
          mkdirSync(dirname(to), { recursive: true })
          renameSync(join(workingDir, file), to)
        }
        // A tracked file that was moved aside is still "modified" as far as the
        // index is concerned -- restore it from HEAD so the checkout is clean.
        await git('checkout', '--', ...colliding)
        log.info?.(`[source-room] ${project}: preserved ${colliding.length} colliding file(s) in ${preserved} to stand on the project branch`)
        stood = await gitSync.standOnWorkBranch(project)
      } catch (error) {
        return { ok: false, status: 'preserve-failed', reason: `${project} could not be moved onto its project branch: ${error.message}` }
      }
    }

    if (!stood?.ok) {
      log.warn?.(`[source-room] ${project}: NOT SYNCING — could not stand on its project branch (${stood?.status || 'unknown'}): ${stood?.reason || 'unknown'}`)
    }
    return stood
  }

  async function createRoom(project, filePath) {
    const paths = roomPaths(project, filePath)
    const projectRecord = await readProject(project)
    const gitSync = gitSyncManagerForProject(project)
    // The browser editor is another daemon, like any other. Skip, 2026-08-26:
    // *"THE FKING SPEC FOR THE BROWSER EDITOR IS IT'S A NORMAL FUCKING DAEMON
    // BACKING IT LIKE EVERYTHING ELSE"* / *"NORMAL FUCKING PROJECT BRANCH"* /
    // *"it has its own fucking tree"*.
    //
    // Its own tree is right. What was wrong is what the tree WAS: a scratch
    // repo from `git init -b main`, standing on `main`, holding only the files
    // somebody had opened -- with the project's branch sitting unused beside it.
    // Everything this route did wrong came from that. It could not be pushed
    // without reparenting HEAD by hand, the server rejected it as WrongHead,
    // and settle's staging over a partial tree recorded every absent file as a
    // DELETION, which is how one browser edit published a revision with the
    // project's other documents removed.
    //
    // So it stands on `tlda/<project>` like every other checkout, and is bound
    // like every other checkout. `standOnWorkBranch` is the same call the disk
    // route makes; it was simply never made here.
    gitSync.bindSource(project, join(paths.root, 'working'), { mainFile: projectRecord?.mainFile || null })
    await gitSync.sync(projectRecord ? [projectRecord] : [])
    const stood = await standRoomOnProjectBranch(project, join(paths.root, 'working'))
    const snapshot = readJson(paths.snapshot)
    const state = snapshot || readJson(paths.state) || {}
    const lifecycle = await sourceLifecycleStore(project)
    const currentRevision = await (await lifecycle.gitRepository()).head(project)
    if (currentRevision) await gitSync.headChanged(project, currentRevision)
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('source')
    if (typeof snapshot?.yjs === 'string') {
      Y.applyUpdate(ydoc, new Uint8Array(Buffer.from(snapshot.yjs, 'base64')), SERVER_ORIGIN)
    } else if (existsSync(paths.yjs)) {
      Y.applyUpdate(ydoc, new Uint8Array(readFileSync(paths.yjs)), SERVER_ORIGIN)
    } else {
      const text = await sourceRoomFileText(lifecycle, { filePath })
      ytext.insert(0, text)
      atomicWrite(paths.yjs, Buffer.from(Y.encodeStateAsUpdate(ydoc)))
      atomicWrite(paths.working, text)
    }
    const room = {
      project,
      filePath,
      paths,
      ydoc,
      ytext,
      clients: new Set(),
      heldRevision: state.heldRevision || currentRevision || null,
      sourceManifest: Array.isArray(state.sourceManifest) ? state.sourceManifest : null,
      submission: state.submission || null,
      queued: state.submission?.state === 'dirty',
      blocked: Boolean(state.blocked),
      timer: null,
    }
    // Reconcile a restored room against the revision that is current NOW.
    //
    // Without this a room is frozen at the moment it was first opened. Both
    // restore branches above replay a persisted Yjs snapshot and neither
    // compares it to `currentRevision` — which this function already computed,
    // two lines earlier, to hand to `headChanged`. So every revision accepted
    // after that first open is invisible to the editor, permanently.
    //
    // Measured 2026-08-25 on a live project: the server's copy of the file
    // carried four edits that a FRESHLY MOUNTED editor did not show. Not a stale
    // subscription — the initial load was already old, because the snapshot won
    // over the file. That is what "it doesn't display the code" is.
    await reconcileRoomToRevision(room, lifecycle, currentRevision)
    ydoc.on('update', (update, origin) => {
      persistRoom(room)
      broadcast(room, { type: 'update', update: Buffer.from(update).toString('base64') })
      if (origin === SERVER_ORIGIN) return
      noteLocalChange(room)
    })
    persistRoom(room)
    recoverSubmission(room)
    return room
  }

  async function getRoom(project, filePath) {
    const key = roomKey(project, filePath)
    let room = rooms.get(key)
    if (!room) {
      room = await createRoom(project, filePath)
      rooms.set(key, room)
    }
    return room
  }

  /**
   * Bring one room up to `revision`, keeping anything unsaved in it.
   *
   * Through `mergeText`, never an overwrite: a room can hold text the person
   * typed and has not saved, and replacing the buffer would take it away. A
   * three-way merge against the revision the room was holding keeps both sides
   * and marks the room blocked if they genuinely conflict.
   *
   * One function for both callers on purpose. A room goes stale by two routes —
   * it was open when a revision landed, or it was closed and reopened later —
   * and they are the same reconciliation. Writing it twice is how the two drift.
   */
  async function reconcileRoomToRevision(room, lifecycle, revision) {
    if (!revision || !room.heldRevision || room.heldRevision === revision) return { ok: true, skipped: true }
    const base = await sourceRoomFileText(lifecycle, { revisionId: room.heldRevision, filePath: room.filePath })
    const incoming = await sourceRoomFileText(lifecycle, { revisionId: revision, filePath: room.filePath })
    const merged = mergeText({ base, current: room.ytext.toString(), incoming, project: room.project, filePath: room.filePath })
    if (!merged.ok) {
      log.error?.(`[source-room] ${room.project}:${room.filePath} could not reconcile ${room.heldRevision} onto ${revision}: ${merged.error}`)
      return { ok: false, error: merged.error }
    }
    // Same rule as the accepted-update path above, and for the same reason: a
    // conflicted merge carries git's markers, and putting those in the document
    // publishes them. The room keeps what the person typed and reports that it
    // is holding.
    if (!merged.conflicted && merged.text !== room.ytext.toString()) replaceYText(room.ytext, merged.text)
    room.heldRevision = revision
    room.blocked = merged.conflicted
    if (merged.conflicted) {
      await noteRoomIsHolding(room, `the live editor and revision ${revision} both changed ${room.filePath}`)
      broadcast(room, { type: 'status', status: 'conflict', file: room.filePath, sourceRevision: revision })
    }
    return { ok: true, conflicted: merged.conflicted }
  }

  function persistRoom(room) {
    const yjs = Buffer.from(Y.encodeStateAsUpdate(room.ydoc))
    const working = room.ytext.toString()
    const state = {
      version: 2,
      heldRevision: room.heldRevision,
      sourceManifest: room.sourceManifest,
      blocked: room.blocked,
      submission: room.submission,
      yjs: yjs.toString('base64'),
      working,
      updatedAt: new Date().toISOString(),
    }
    // ORDER IS LOAD-BEARING: `working` is written LAST, after `snapshot` and
    // `yjs`. Those two are exactly what `createRoom` checks before it falls back
    // to hydrating from the lifecycle store — so writing `working` third makes it
    // impossible, through this function, for `working` to exist while both of its
    // guards are absent. That state is the destructive one: a room created there
    // hydrates empty and this line then writes the empty string over the file.
    //
    // And `working` is not a projection anyone can reorder freely. It is the git
    // working tree bound by `bindSource` above — `git init -b main` runs in it and
    // `git add -A -- .` sweeps it into the revision that is pushed to
    // `refs/tlda/source/<project>`. Emptying it here empties what gets accepted.
    //
    // So do not group the two `atomicJson` calls, and do not move the cheap write
    // first. Both read as tidying a list of flushes; both reopen the hole, and no
    // test would catch it, because the state only occurs in fixtures.
    //
    // What this ordering does NOT defend: git materialises files into the same
    // directory without any line here naming it, so a `working` that git created
    // is not covered by the argument above. That case is open and unmeasured.
    //
    // This snapshot is the canonical room record. The yjs/working/state files
    // remain readable projections for existing tools and older room records.
    atomicJson(room.paths.snapshot, state)
    atomicWrite(room.paths.yjs, yjs)
    atomicWrite(room.paths.working, working)
    atomicJson(room.paths.state, state)
  }

  function broadcast(room, message, except = null) {
    for (const client of room.clients) {
      if (client === except) continue
      sendJson(client, message)
    }
  }

  function noteLocalChange(room) {
    room.blocked = hasConflictMarkers(room.ytext.toString())
    if (room.blocked) {
      persistRoom(room)
      return
    }
    room.queued = true
    if (!room.submission) room.submission = newSubmission(room)
    if (room.submission.state === 'submitting' || room.submission.state === 'retry_wait') {
      persistRoom(room)
      return
    }
    room.submission = newSubmission(room)
    persistRoom(room)
    if (room.timer) clearTimeout(room.timer)
    room.timer = setTimeout(() => {
      room.timer = null
      void flushRoom(room)
    }, pushDelayMs)
  }

  async function sourceManifestFor(room) {
    if (Array.isArray(room.sourceManifest) && room.sourceManifest.includes(room.filePath)) return room.sourceManifest
    const current = await readClientSourceManifest(room.project).catch(() => [])
    return [...new Set([...current, room.filePath])].sort()
  }

  function contentHash(content) {
    return createHash('sha256').update(content).digest('hex')
  }

  function newSubmission(room) {
    const content = room.ytext.toString()
    return {
      requestId: randomUUID(),
      expectedRevision: room.heldRevision,
      contentHash: contentHash(content),
      content,
      sourceManifest: room.sourceManifest,
      state: 'dirty',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    }
  }

  function retryDelayMs(attempts) {
    return Math.min(MAX_RETRY_DELAY_MS, pushDelayMs * (2 ** Math.max(0, attempts - 1)))
  }

  function armSubmission(room, delayMs) {
    if (room.timer) clearTimeout(room.timer)
    room.timer = setTimeout(() => {
      room.timer = null
      void flushRoom(room)
    }, Math.max(0, delayMs))
  }

  function recoverSubmission(room) {
    const submission = room.submission
    if (!submission || submission.state === 'blocked') return
    if (submission.state === 'submitting') submission.state = 'retry_wait'
    const due = submission.nextAttemptAt ? Date.parse(submission.nextAttemptAt) : Date.now()
    persistRoom(room)
    armSubmission(room, Math.max(0, due - Date.now()))
  }

  /** Record that the room is holding an edit which has not reached authority. */
  async function noteRoomIsHolding(room, reason) {
    if (!recordHeldEdit) return
    try {
      await recordHeldEdit(room.project, {
        owner: { sourceDaemonKey: sourceRoomDaemonKey(room.project), participant: 'the live editor' },
        file: room.filePath,
        files: [room.filePath],
        reason,
      })
    } catch (error) {
      // Recording is an instrument. It must never be the thing that breaks a
      // push path, and least of all one that is already failing.
      log.error?.(`[source-room] ${room.project}:${room.filePath} could not record a held edit: ${error?.message || error}`)
    }
  }

  async function noteRoomIsClear(room) {
    if (!clearHeldEdit) return
    try {
      await clearHeldEdit(room.project, { sourceDaemonKey: sourceRoomDaemonKey(room.project) }, room.filePath)
    } catch (error) {
      log.error?.(`[source-room] ${room.project}:${room.filePath} could not clear a held edit: ${error?.message || error}`)
    }
  }

  async function flushRoom(room) {
    if (room.blocked || room.submission?.state === 'submitting') return
    room.queued = false
    if (!room.submission) room.submission = newSubmission(room)
    const submission = room.submission
    if (submission.state === 'retry_wait' && submission.nextAttemptAt && Date.parse(submission.nextAttemptAt) > Date.now()) {
      armSubmission(room, Date.parse(submission.nextAttemptAt) - Date.now())
      return
    }
    submission.state = 'submitting'
    submission.attempts += 1
    submission.nextAttemptAt = null
    persistRoom(room)
    try {
      const sourceManifest = Array.isArray(submission.sourceManifest)
        ? submission.sourceManifest
        : await sourceManifestFor(room)
      submission.sourceManifest = sourceManifest
      room.sourceManifest = sourceManifest
      persistRoom(room)
      const gitSync = gitSyncManagerForProject(room.project)
      await trackRoomFile(room.project, room.paths.working)
      gitSync.queuePaths(room.project, [room.filePath])
      submission.state = 'queued'
      persistRoom(room)
      broadcast(room, { type: 'status', status: 'queued', sourceRevision: room.heldRevision, building: true })
    } catch (error) {
      await scheduleRetry(room, error?.message || String(error))
      broadcast(room, {
        type: 'status',
        status: 'error',
        sourceRevision: room.heldRevision,
        error: error?.message || String(error),
      })
      log.error?.(`[source-room] ${room.project}:${room.filePath} push failed: ${error?.message || error}`)
    }
  }

  async function scheduleRetry(room, error) {
    const submission = room.submission
    if (!submission) return
    const delay = retryDelayMs(submission.attempts)
    submission.state = 'retry_wait'
    submission.lastError = error
    submission.nextAttemptAt = new Date(Date.now() + delay).toISOString()
    room.queued = true
    persistRoom(room)
    armSubmission(room, delay)
    await noteRoomIsHolding(room, error)
  }

  function conflictTextFor(result, filePath) {
    const classifications = result?.evidence?.classifications
    if (!Array.isArray(classifications)) return null
    const match = classifications.find(item => item?.path === filePath && item?.status === 'conflict' && item?.merged)
    return match ? bufferFromBase64(match.merged).toString('utf8') : null
  }

  function isTerminalBlockedResult(result) {
    return [
      'stale-base',
      'recovery-required',
      'invalid-request-id-reuse',
      'overleaf-conflict',
    ].includes(result?.lifecycleStatus)
  }

  async function applyAcceptedSourceMutation(message) {
    if (message?.sourceDaemonKey?.startsWith(SOURCE_ROOM_DAEMON_PREFIX)) return { ok: true, skipped: 'source-room-origin' }
    const changed = [...(message?.files || []).map(file => file?.path), ...(message?.deletedFiles || [])].filter(Boolean)
    const targetRooms = [...rooms.values()].filter(room => room.project === message.project && changed.includes(room.filePath))
    const applied = []
    const conflicted = []
    for (const room of targetRooms) {
      const lifecycle = await sourceLifecycleStore(room.project)
      const file = (message.files || []).find(candidate => candidate?.path === room.filePath)
      const base = await sourceRoomFileText(lifecycle, { revisionId: message.previousRevision, filePath: room.filePath })
      const incoming = file ? bufferFromBase64(file.content).toString('utf8') : ''
      const merged = mergeText({ base, current: room.ytext.toString(), incoming, project: room.project, filePath: room.filePath })
      if (!merged.ok) {
        log.error?.(`[source-room] ${room.project}:${room.filePath} accepted-update merge failed: ${merged.error}`)
        continue
      }
      room.heldRevision = message.sourceRevision || room.heldRevision
      room.sourceManifest = Array.isArray(message.sourceManifest) ? message.sourceManifest : room.sourceManifest
      room.blocked = merged.conflicted
      // A CONFLICTED MERGE IS NOT A DOCUMENT. `mergeText` returns
      // `conflicted: true` together with git's marker-laden stdout, and writing
      // that into `room.ytext` puts `<<<<<<<`, `=======` and
      // `>>>>>>> accepted server source for <project>:<file>` into the shared
      // Yjs document -- which is what every viewer reads and what the room
      // flushes as the published source. Measured on a real project on
      // 2026-08-26: 239 bytes of conflicted text published against 72 on disk.
      //
      // `room.blocked` was already assigned above and gates nothing, because
      // the replace had already happened by the time anyone could read it.
      //
      // So the room KEEPS ITS OWN TEXT and says it is holding, through the
      // hook that exists for exactly this. Neither side is chosen and neither
      // is lost: the room's text stays in the room, the accepted revision stays
      // accepted, and `noteRoomIsHolding` is what makes the divergence visible
      // rather than silent.
      if (!merged.conflicted) replaceYText(room.ytext, merged.text)
      persistRoom(room)
      if (merged.conflicted) {
        await noteRoomIsHolding(room, `the live editor and the accepted source both changed ${room.filePath}`)
        // MARK THE FILE IN THE EDITOR. Skip, 2026-08-26 10:58:16 EDT, asked for
        // exactly this when two people change the same lines.
        //
        // It needs saying because the room used to mark the file by ACCIDENT:
        // the conflicted merge text was written into the document, the client
        // saw `<<<<<<<` and set `heldConflictFile` itself. Keeping the markers
        // out of the document -- which is the point -- removed the only signal
        // the person had, so the room now says it rather than leaking it.
        broadcast(room, { type: 'status', status: 'conflict', file: room.filePath, sourceRevision: room.heldRevision })
        conflicted.push(room.filePath)
      } else applied.push(room.filePath)
      if (!merged.conflicted && room.ytext.toString() !== incoming) noteLocalChange(room)
    }
    return { ok: true, applied, conflicted }
  }

  async function handleSocket(project, filePath, ws) {
    const projectRecord = await readProject(project)
    if (!projectRecord) {
      sendJson(ws, { type: 'error', message: 'Project not found' })
      ws.close()
      return
    }
    const room = await getRoom(project, filePath)
    room.clients.add(ws)
    sendJson(ws, {
      type: 'sync',
      update: Buffer.from(Y.encodeStateAsUpdate(room.ydoc)).toString('base64'),
      sourceRevision: room.heldRevision,
      blocked: room.blocked,
    })
    ws.on('message', data => {
      let message
      try { message = JSON.parse(String(data)) } catch { return }
      if (message?.type === 'update' && typeof message.update === 'string') {
        Y.applyUpdate(room.ydoc, new Uint8Array(Buffer.from(message.update, 'base64')), CLIENT_ORIGIN)
      } else if (message?.type === 'flush') {
        void flushRoom(room)
      }
    })
    ws.on('close', () => {
      room.clients.delete(ws)
    })
  }

  async function headChanged(project, revision) {
    const result = await gitSyncManagerForProject(project).headChanged(project, revision)
    const open = [...rooms.values()].filter(room => room.project === project)
    const lifecycle = open.length ? await sourceLifecycleStore(project) : null
    for (const room of open) {
      // Bring the TEXT up to the revision before claiming the room holds it.
      //
      // This stamped `heldRevision` and broadcast `status: 'synced'` while never
      // touching ytext, so the room recorded that it held a revision whose
      // content it did not have — and persisted that claim. The person saw old
      // text under a status that said synced, and reopening did not help,
      // because a reopened room compares heldRevision against the current
      // revision and they already matched. The lie was load-bearing: it is what
      // made the staleness undetectable from inside.
      //
      // replaceYText fires the ydoc update handler, which persists and
      // broadcasts the new text to every connected client, so the open editor
      // updates from this one call.
      await reconcileRoomToRevision(room, lifecycle, revision)
      room.heldRevision = revision
      room.submission = null
      room.queued = false
      persistRoom(room)
      await noteRoomIsClear(room)
      broadcast(room, { type: 'status', status: 'synced', sourceRevision: revision, building: false })
    }
    return result
  }

  /**
   * Stage a file the room wrote, so the settle can see it.
   *
   * `settledCommit` stages TRACKED changes only -- `d60d18573` removed `add -A`
   * because the app does not stage files in a repository it does not own, and
   * the accepted cost is that a person's new file waits for their `git add`.
   * A room has no author to run it: its tree is a projection of a Yjs document.
   * So a project whose FIRST file came from the editor stalled at
   * `empty-checkout` forever -- nothing tracked, empty tree, refused on every
   * settle.
   *
   * `track-path` is the verb that already exists for this, and it is the same
   * one the adopt-a-root path uses. It refuses anything outside the repository
   * and is a no-op for a file already tracked, so this is safe to call on every
   * flush. Deletions still ride the settle's `add -u`; a person's checkout is
   * untouched, because nothing here runs against one.
   */
  async function trackRoomFile(project, absolutePath) {
    let answer
    try {
      answer = await gitSyncManagerForProject(project)
        .remoteOperation(project, 'track-path', { path: absolutePath })
    } catch (error) {
      throw new Error(`${project}: could not stage ${absolutePath}: ${error?.message || error}`)
    }
    // ANSWERED IS NOT STAGED. `trackPath` returns `{ inRepo: false }` WITHOUT
    // throwing when the path does not textually match git's `--show-toplevel`
    // -- a realpath difference is enough -- so a try/catch alone reports success
    // while the file sits untracked. Caught while writing this: the file stayed
    // `?? main.md` and nothing raised.
    //
    // THROWN, not logged. The bytes are already persisted to the room's tree and
    // its Yjs document, so nothing is lost by failing here, and `flushRoom`'s
    // catch schedules a retry. Warning and carrying on is what makes a caller
    // answer `queued` for a file that can never be committed -- the document
    // then never appears and the only trace is a log line nobody reads.
    if (!answer?.tracked) {
      throw new Error(`${project}: ${absolutePath} was not staged (${JSON.stringify(answer)}) — it cannot become a revision`)
    }
    return answer
  }

  async function submitFiles(project, payload = {}) {
    const projectRecord = await readProject(project)
    if (!projectRecord) return { status: 404, body: { ok: false, error: 'Project not found' } }
    const root = join(projectDir(project), '.source-room', 'working')
    const gitSync = gitSyncManagerForProject(project)
    // Same tree, same rule as createRoom: a normal checkout on the project
    // branch. This path writes whole files rather than editing one through a
    // room, and it published the same partial tree with the same deletions.
    gitSync.bindSource(project, root, { mainFile: projectRecord.mainFile || null })
    await gitSync.sync([projectRecord])
    const stood = await standRoomOnProjectBranch(project, root)
    if (!stood?.ok) return { status: 409, body: { ok: false, error: `${project} is not syncing: ${stood.reason || stood.status}` } }
    const paths = []
    for (const file of payload.files || []) {
      if (typeof file?.path !== 'string' || !file.path || isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..')) {
        throw new Error(`invalid source-room path: ${file?.path || '<missing>'}`)
      }
      const target = join(root, file.path)
      atomicWrite(target, Buffer.from(file.content || '', file.encoding === 'base64' ? 'base64' : 'utf8'))
      // The bytes are on disk either way; what this decides is whether the
      // caller is told the write is on its way to a revision. A file that could
      // not be staged is not, and saying `queued` for it is the lie that hides
      // the whole failure.
      try {
        await trackRoomFile(project, target)
      } catch (error) {
        return { status: 409, body: { ok: false, error: error?.message || String(error) } }
      }
      paths.push(file.path)
    }
    for (const filePath of payload.deletedFiles || []) {
      if (typeof filePath !== 'string' || !filePath || isAbsolute(filePath) || filePath.split(/[\\/]/).includes('..')) {
        throw new Error(`invalid source-room path: ${filePath || '<missing>'}`)
      }
      rmSync(join(root, filePath), { force: true })
      paths.push(filePath)
    }
    gitSync.queuePaths(project, paths)
    return { status: 202, body: { ok: true, status: 'queued' } }
  }

  return {
    getRoom,
    handleSocket,
    applyAcceptedSourceMutation,
    headChanged,
    submitFiles,
    flushRoom,
    closeAll() {
      for (const room of rooms.values()) {
        if (room.timer) clearTimeout(room.timer)
        room.timer = null
        for (const client of room.clients) {
          try { client.close() } catch {
            // Best-effort cleanup: closeAll is already tearing the room down.
          }
        }
        room.clients.clear()
        room.ydoc.destroy()
      }
      rooms.clear()
    },
  }
}
