/**
 * tlda-dev sandbox — a complete throwaway environment for a branch.
 *
 * Why this exists: testing a new custom shape (or any server change) needs the
 * schema loaded by a *running* server, and you must NOT do that on a live room.
 * This spins up the WHOLE stack for a branch, isolated: that branch's backend
 * (own fleet DB + projects dir, `TLDA_DEV_SERVER=1` so no supervisors/hibernate,
 * `TLDA_FLEET_SERVER=self` so its chat is its own) AND a Vite frontend pointed at
 * it. One command, nothing shared — a safe end-to-end test loop.
 *
 *   tlda-dev sandbox <branch>   start a complete isolated env for that branch
 *   tlda-dev sandbox start      same, for the current checkout
 *   tlda-dev sandbox stop       stop it (backend + viewer)
 *   tlda-dev sandbox status     is it up? + the viewer/backend URLs
 *   tlda-dev sandbox url        print the verified viewer URL without starting
 */

import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { hasTls } from '../../shared/config.mjs'
import { resolveRepoRoot, ensureWorktree, startWorktreeVite, findFreePort } from './dev-vite.mjs'

const DEV_PORT = 5280
const DATA_DIR = join(homedir(), '.config', 'tlda', 'dev-server')
const PID_FILE = join(DATA_DIR, 'server.pid')
const VITE_PID_FILE = join(DATA_DIR, 'vite.pid')
const LOG_FILE = join(DATA_DIR, 'server.log')
const PROJECTS_DIR = join(DATA_DIR, 'projects')
const FLEET_DB = join(DATA_DIR, 'fleet.db')
const MANIFEST_FILE = join(DATA_DIR, 'rig.json')

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function readPid() {
  if (!existsSync(PID_FILE)) return null
  const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10)
  return Number.isInteger(pid) && alive(pid) ? pid : null
}

function readRawPid(file) {
  if (!existsSync(file)) return null
  const pid = parseInt(readFileSync(file, 'utf8').trim(), 10)
  return Number.isInteger(pid) ? pid : null
}

async function health(port) {
  for (const scheme of ['https', 'http']) {
    try {
      const res = await fetch(`${scheme}://localhost:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      })
      if (res.ok) return scheme
    } catch { /* not up yet / wrong scheme — try the other, or caller retries */ }
  }
  return null
}

function readVitePid() {
  if (!existsSync(VITE_PID_FILE)) return null
  const pid = parseInt(readFileSync(VITE_PID_FILE, 'utf8').trim(), 10)
  return Number.isInteger(pid) && alive(pid) ? pid : null
}

async function viewerHealth(url) {
  if (!url) return false
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return res.ok || res.status === 404
  } catch {
    return false
  }
}

const VITE_URL_FILE = join(DATA_DIR, 'vite-url')

function parseArgs(args) {
  const flags = new Set()
  const values = new Map()
  const positionals = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1))
      continue
    }
    const key = arg.slice(2)
    const next = args[i + 1]
    if (next && !next.startsWith('--')) {
      values.set(key, next)
      i++
    } else {
      flags.add(key)
    }
  }
  return { flags, values, positionals }
}

function readManifest() {
  if (!existsSync(MANIFEST_FILE)) return null
  try { return JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) } catch { return null }
}

function manifestPort(manifest) {
  return Number.isInteger(manifest?.ports?.backend) ? manifest.ports.backend : DEV_PORT
}

function viewerUrlWithDoc(url, doc) {
  if (!url || !doc) return url
  const parsed = new URL(url)
  parsed.searchParams.set('doc', doc)
  return parsed.toString()
}

async function sandboxState({ port = null, doc = null } = {}) {
  const manifest = readManifest()
  const backendPort = port || manifestPort(manifest)
  const backendPid = readPid()
  const staleBackendPid = backendPid ? null : readRawPid(PID_FILE)
  const backendScheme = backendPid ? await health(backendPort) : null
  const backend = backendScheme ? `${backendScheme}://localhost:${backendPort}` : null

  const viewerPid = readVitePid()
  const staleViewerPid = viewerPid ? null : readRawPid(VITE_PID_FILE)
  const recordedViewer = existsSync(VITE_URL_FILE) ? readFileSync(VITE_URL_FILE, 'utf8').trim() : manifest?.viewer
  const viewerOk = viewerPid ? await viewerHealth(recordedViewer) : false
  const viewer = viewerOk ? viewerUrlWithDoc(recordedViewer, doc || manifest?.doc) : null

  const status = backendPid && backendScheme && viewerOk
    ? 'up'
    : backendPid && backendScheme
      ? 'backend-only'
      : backendPid
        ? 'starting-or-wedged'
        : 'down'

  return {
    status,
    viewer,
    url: viewer,
    backend,
    backendPid,
    viewerPid: viewerOk ? viewerPid : null,
    staleBackendPid,
    staleViewerPid,
    db: FLEET_DB,
    projectsDir: PROJECTS_DIR,
    manifest: MANIFEST_FILE,
    rig: manifest,
  }
}

function writeManifest(manifest, worktreeDir = null) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2))
  if (worktreeDir) {
    const dir = join(worktreeDir, '.tlda-dev')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'rig.json'), JSON.stringify(manifest, null, 2))
  }
}

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2))
}

export async function cmdDevServer(args, repoRoot) {
  // `tlda-dev sandbox <branch>` starts a complete isolated env for that branch;
  // `start`/`stop`/`status` are the management verbs (start = current checkout).
  const parsed = parseArgs(args)
  const json = parsed.flags.has('json') || parsed.flags.has('print-json')
  const first = parsed.positionals[0]
  const isVerb = ['start', 'stop', 'status', 'url'].includes(first)
  const sub = isVerb ? first : 'start'
  const branch = (!isVerb && first) ? first : null
  const portArg = parsed.values.get('port')
  const doc = parsed.values.get('doc') || null
  const port = portArg ? parseInt(portArg, 10) : manifestPort(readManifest())

  if (sub === 'status') {
    const state = await sandboxState({ port, doc })
    if (json) {
      printJson(state)
      return
    }
    if (state.status === 'up') {
      console.log(`sandbox: up — complete isolated env`)
      console.log(`  viewer:  ${state.viewer}`)
      console.log(`  backend: ${state.backend}  (own DB + projects + chat)`)
      console.log(`  DB:      ${FLEET_DB}`)
      console.log(`  manifest: ${MANIFEST_FILE}`)
    } else if (state.status === 'backend-only') {
      console.log(`sandbox: backend up, viewer down or stale`)
      console.log(`  backend: ${state.backend}  (own DB + projects + chat)`)
      console.log(`  manifest: ${MANIFEST_FILE}`)
    } else if (state.backendPid) {
      console.log(`sandbox: backend pid ${state.backendPid} alive but not answering on :${port} (starting or wedged)`)
    } else {
      console.log('sandbox: down')
      if (state.staleBackendPid || state.staleViewerPid) {
        console.log(`  stale pid files: backend ${state.staleBackendPid ?? '—'}, viewer ${state.staleViewerPid ?? '—'}`)
      }
    }
    return
  }

  if (sub === 'url') {
    const state = await sandboxState({ port, doc })
    if (json) {
      printJson(state)
      return
    }
    if (state.viewer) {
      console.log(state.viewer)
      return
    }
    console.error(`sandbox URL unavailable: ${state.status}`)
    if (state.backend) console.error(`  backend: ${state.backend}`)
    process.exit(1)
  }

  if (sub === 'stop') {
    const pid = readPid()
    const vitePid = readVitePid()
    if (!pid && !vitePid) {
      ;[PID_FILE, VITE_PID_FILE, VITE_URL_FILE, MANIFEST_FILE].forEach(f => existsSync(f) && unlinkSync(f))
      if (json) printJson({ status: 'down', stopped: false })
      else console.log('sandbox: not running')
      return
    }
    for (const p of [pid, vitePid]) { if (p) { try { process.kill(p) } catch { /* already gone */ } } }
    ;[PID_FILE, VITE_PID_FILE, VITE_URL_FILE, MANIFEST_FILE].forEach(f => existsSync(f) && unlinkSync(f))
    if (json) printJson({ status: 'down', stopped: true, backendPid: pid, viewerPid: vitePid })
    else console.log(`sandbox: stopped (backend ${pid ?? '—'}, viewer ${vitePid ?? '—'})`)
    return
  }

  // start (idempotent — one sandbox at a time; stop to switch branch)
  const existing = readPid()
  if (existing) {
    const state = await sandboxState({ port, doc })
    if (json) {
      printJson({ ...state, status: state.status === 'up' ? 'already-running' : state.status })
    } else {
      console.log(`sandbox already running (backend pid ${existing}) — \`tlda-dev sandbox stop\` first to switch branch`)
      if (state.viewer) console.log(`  viewer:  ${state.viewer}`)
      if (state.backend) console.log(`  backend: ${state.backend}`)
    }
    return
  }

  // Run THAT branch's server code (so server/shape changes are what's tested),
  // isolated from anything real.
  const worktreeDir = branch ? ensureWorktree(resolveRepoRoot(), branch) : repoRoot
  const startPort = portArg ? port : await findFreePort(DEV_PORT)

  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(PROJECTS_DIR, { recursive: true })
  const logFd = openSync(LOG_FILE, 'a')
  const serverScript = join(worktreeDir, 'server', 'unified-server.mjs')

  const child = spawn(process.execPath, ['--import', 'tsx', serverScript, '--i-am-tlda-cli'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      PORT: String(startPort),
      PROJECTS_DIR,
      TLDA_FLEET_DB: FLEET_DB,
      TLDA_DEV_SERVER: '1',     // disables fleet supervisors + hibernate loop
      TLDA_NO_AUTH: '1',        // dev convenience — no token needed
      // Self-report as the fleet store so /api/fleet-config returns THIS server,
      // not the global one (Fly) — so the sandbox's chat is its own, fully isolated.
      TLDA_FLEET_SERVER: process.env.TLDA_FLEET_SERVER || `${hasTls ? 'https' : 'http'}://localhost:${startPort}`,
    },
  })
  child.unref()
  writeFileSync(PID_FILE, String(child.pid))
  if (!json) console.log(`sandbox backend starting (pid ${child.pid}) on :${startPort}${branch ? ` [${branch}]` : ''} …`)

  // Wait for the backend to be healthy (up to ~30s)
  let backendScheme = null
  for (let i = 0; i < 60 && !backendScheme; i++) {
    await new Promise(r => setTimeout(r, 500))
    backendScheme = await health(startPort)
    if (!backendScheme && !alive(child.pid)) {
      console.error(`sandbox backend exited during startup — see ${LOG_FILE}`)
      process.exit(1)
    }
  }
  if (!backendScheme) {
    console.error(`sandbox backend didn't answer on :${port} within 30s — see ${LOG_FILE}`)
    process.exit(1)
  }

  // Spin the paired vite off the same branch, pointed at the sandbox backend
  // (VITE_SERVER_PORT) — so the whole env (frontend + backend + DB + chat) is the
  // branch's code, isolated. One command, nothing shared.
  const { scheme: viteScheme, port: vitePort, pid: vitePid } = await startWorktreeVite({
    worktreeDir,
    port: await findFreePort(5180),
    serverPort: startPort,
    hasTls,
  })
  const viewerUrl = `${viteScheme}://localhost:${vitePort}/`   // no token — sandbox is NO_AUTH
  const docUrl = viewerUrlWithDoc(viewerUrl, doc)
  writeFileSync(VITE_PID_FILE, String(vitePid))
  writeFileSync(VITE_URL_FILE, viewerUrl)
  const manifest = {
    rig: branch || 'current',
    cwd: worktreeDir,
    viewer: viewerUrl,
    url: docUrl,
    backend: `${backendScheme}://localhost:${startPort}`,
    doc,
    health: 'ok',
    playwrightReady: false,
    teacherReady: false,
    isolated: true,
    noAuth: true,
    ports: { backend: startPort, viewer: vitePort },
    pids: { backend: child.pid, viewer: vitePid },
    db: FLEET_DB,
    projectsDir: PROJECTS_DIR,
    manifest: MANIFEST_FILE,
  }
  writeManifest(manifest, worktreeDir)

  if (json) {
    printJson(manifest)
    return
  }

  console.log(`\nsandbox up — complete isolated env${branch ? ` for ${branch}` : ''}:`)
  console.log(`  viewer:  ${viewerUrl}`)
  console.log(`  backend: ${backendScheme}://localhost:${port}  (own DB + projects + chat)`)
  console.log(`  manifest: ${MANIFEST_FILE}`)
  console.log(`  stop with: tlda-dev sandbox stop`)
}
