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

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function readPid() {
  if (!existsSync(PID_FILE)) return null
  const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10)
  return Number.isInteger(pid) && alive(pid) ? pid : null
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

const VITE_URL_FILE = join(DATA_DIR, 'vite-url')

export async function cmdDevServer(args, repoRoot) {
  // `tlda-dev sandbox <branch>` starts a complete isolated env for that branch;
  // `start`/`stop`/`status` are the management verbs (start = current checkout).
  const first = args[0]
  const isVerb = ['start', 'stop', 'status'].includes(first)
  const sub = isVerb ? first : 'start'
  const branch = (!isVerb && first) ? first : null
  const portArg = args.find((a, i) => args[i - 1] === '--port')
  const port = portArg ? parseInt(portArg, 10) : DEV_PORT

  if (sub === 'status') {
    const pid = readPid()
    const scheme = pid ? await health(port) : null
    const viteUrl = readVitePid() && existsSync(VITE_URL_FILE) ? readFileSync(VITE_URL_FILE, 'utf8').trim() : null
    if (pid && scheme) {
      console.log(`sandbox: up — complete isolated env`)
      if (viteUrl) console.log(`  viewer:  ${viteUrl}`)
      console.log(`  backend: ${scheme}://localhost:${port}  (own DB + projects + chat)`)
      console.log(`  DB:      ${FLEET_DB}`)
    } else if (pid) {
      console.log(`sandbox: backend pid ${pid} alive but not answering on :${port} (starting or wedged)`)
    } else {
      console.log('sandbox: down')
    }
    return
  }

  if (sub === 'stop') {
    const pid = readPid()
    const vitePid = readVitePid()
    if (!pid && !vitePid) { console.log('sandbox: not running'); [PID_FILE, VITE_PID_FILE, VITE_URL_FILE].forEach(f => existsSync(f) && unlinkSync(f)); return }
    for (const p of [pid, vitePid]) { if (p) { try { process.kill(p) } catch { /* already gone */ } } }
    ;[PID_FILE, VITE_PID_FILE, VITE_URL_FILE].forEach(f => existsSync(f) && unlinkSync(f))
    console.log(`sandbox: stopped (backend ${pid ?? '—'}, viewer ${vitePid ?? '—'})`)
    return
  }

  // start (idempotent — one sandbox at a time; stop to switch branch)
  const existing = readPid()
  if (existing) {
    console.log(`sandbox already running (backend pid ${existing}) — \`tlda-dev sandbox stop\` first to switch branch`)
    return
  }

  // Run THAT branch's server code (so server/shape changes are what's tested),
  // isolated from anything real.
  const worktreeDir = branch ? ensureWorktree(resolveRepoRoot(), branch) : repoRoot

  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(PROJECTS_DIR, { recursive: true })
  const logFd = openSync(LOG_FILE, 'a')
  const serverScript = join(worktreeDir, 'server', 'unified-server.mjs')

  const child = spawn(process.execPath, [serverScript, '--i-am-tlda-cli'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      PORT: String(port),
      PROJECTS_DIR,
      TLDA_FLEET_DB: FLEET_DB,
      TLDA_DEV_SERVER: '1',     // disables fleet supervisors + hibernate loop
      TLDA_NO_AUTH: '1',        // dev convenience — no token needed
      // Self-report as the fleet store so /api/fleet-config returns THIS server,
      // not the global one (Fly) — so the sandbox's chat is its own, fully isolated.
      TLDA_FLEET_SERVER: process.env.TLDA_FLEET_SERVER || `${hasTls ? 'https' : 'http'}://localhost:${port}`,
    },
  })
  child.unref()
  writeFileSync(PID_FILE, String(child.pid))
  console.log(`sandbox backend starting (pid ${child.pid}) on :${port}${branch ? ` [${branch}]` : ''} …`)

  // Wait for the backend to be healthy (up to ~30s)
  let backendScheme = null
  for (let i = 0; i < 60 && !backendScheme; i++) {
    await new Promise(r => setTimeout(r, 500))
    backendScheme = await health(port)
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
    serverPort: port,
    hasTls,
  })
  const viewerUrl = `${viteScheme}://localhost:${vitePort}/`   // no token — sandbox is NO_AUTH
  writeFileSync(VITE_PID_FILE, String(vitePid))
  writeFileSync(VITE_URL_FILE, viewerUrl)

  console.log(`\nsandbox up — complete isolated env${branch ? ` for ${branch}` : ''}:`)
  console.log(`  viewer:  ${viewerUrl}`)
  console.log(`  backend: ${backendScheme}://localhost:${port}  (own DB + projects + chat)`)
  console.log(`  stop with: tlda-dev sandbox stop`)
}
